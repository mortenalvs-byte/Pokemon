// Cross-platform npm-script runner with per-step timeouts and Windows shell:true workaround.
// Sequential execution: typecheck → test → build → audit → conditional gates.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import crypto from 'node:crypto';

const PER_STEP_TIMEOUT_MS = {
  typecheck:   120000,   //  120s
  test:        240000,   //  240s
  build:       180000,   //  180s
  audit:        60000,   //   60s
  'qa:browser': 240000,  //  240s
  'desktop:build': 600000, // 600s
};

const VERIFY_BUDGET_MS_DEFAULT = parseInt(process.env.AI_SUPERVISOR_VERIFY_BUDGET_MS ?? '400000', 10);

const CACHE_DIR_DEFAULT = path.join(process.cwd(), '.local', 'ai-supervisor', 'verification-cache');

/**
 * Run npm scripts sequentially with caching.
 * @param {object} input
 * @param {string} input.headSha
 * @param {string} input.dirtyDiffHash — sha of unstaged+staged diff
 * @param {string|null} input.taskId
 * @param {string[]} input.changedFiles — used to decide conditional gates
 * @param {string} [input.cwd]
 * @returns {Promise<{commands: object[], overallStatus: 'PASS'|'FAIL'|'PARTIAL', cached: boolean, durationMs: number}>}
 */
export async function runChecks(input) {
  const cwd = input.cwd ?? process.cwd();
  const cacheKey = computeCacheKey(input.headSha, input.dirtyDiffHash, input.taskId);

  // Check cache
  const cached = await readCache(cacheKey);
  if (cached) return { ...cached, cached: true };

  // Compose step list based on diff
  const steps = composeSteps(input.changedFiles ?? []);

  const overallStarted = Date.now();
  const budgetMs = VERIFY_BUDGET_MS_DEFAULT;
  const commands = [];
  let overallStatus = 'PASS';

  for (const step of steps) {
    if (Date.now() - overallStarted > budgetMs) {
      // Out of total budget; mark remaining as SKIP
      commands.push({
        name: step.name,
        command: step.script,
        status: 'SKIP',
        summary: `Skipped (total verify budget ${budgetMs}ms exceeded before step ran)`,
        duration_ms: 0,
      });
      overallStatus = 'PARTIAL';
      continue;
    }

    const result = await runOne(step, cwd);
    commands.push(result);
    if (result.status === 'FAIL') overallStatus = overallStatus === 'PARTIAL' ? 'PARTIAL' : 'FAIL';
  }

  const summary = {
    commands,
    overallStatus,
    cached: false,
    durationMs: Date.now() - overallStarted,
  };

  await writeCache(cacheKey, summary);
  return summary;
}

function composeSteps(changedFiles) {
  const steps = [
    { name: 'typecheck', script: 'typecheck' },
    { name: 'test',      script: 'test' },
    { name: 'build',     script: 'build' },
    { name: 'audit',     script: undefined, audit: true },
  ];

  // Conditional gates
  const touchesBrowsable = changedFiles.some(f =>
    f.startsWith('src/views/') ||
    f.startsWith('src/components/') ||
    f.startsWith('src/services/') ||
    f.startsWith('src/db/') ||
    f.startsWith('src/domain/') ||
    f.startsWith('tests/qa') ||
    f === 'BACKUP_FORMAT.md');

  if (touchesBrowsable) {
    steps.push({ name: 'qa:browser', script: 'qa:browser' });
  }

  const touchesTauri = changedFiles.some(f =>
    f.startsWith('src-tauri/') ||
    f === 'src-tauri/tauri.conf.json' ||
    f.startsWith('scripts/desktop') ||
    f === 'package.json' && false /* desktop build is heavy; only on Tauri-specific changes */
  );
  if (touchesTauri) {
    steps.push({ name: 'desktop:build', script: 'desktop:build' });
  }

  return steps;
}

async function runOne(step, cwd) {
  const started = Date.now();
  const timeout = PER_STEP_TIMEOUT_MS[step.name] ?? 120000;

  let cmd, args;
  if (step.audit) {
    cmd = 'npm';
    args = ['audit', '--json'];
  } else {
    cmd = 'npm';
    args = ['run', step.script];
  }

  const isWindows = process.platform === 'win32';
  // shell: true on Windows is the workaround for Node 20.12.2+ spawn EINVAL regression
  // (github.com/nodejs/node#52681). On Unix, shell: false is safer.
  const child = spawn(cmd, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: isWindows,
    env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', d => stdout += d.toString());
  child.stderr.on('data', d => stderr += d.toString());

  return new Promise(resolve => {
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000);
    }, timeout);

    child.on('close', exitCode => {
      clearTimeout(timer);
      const duration_ms = Date.now() - started;

      let status;
      let summary;

      if (killed) {
        status = 'FAIL';
        summary = `timeout after ${timeout}ms`;
      } else if (exitCode === 0) {
        status = 'PASS';
        summary = parseSummary(step.name, stdout, stderr);
      } else {
        status = 'FAIL';
        summary = parseSummary(step.name, stdout, stderr) || `exited with code ${exitCode}`;
      }

      resolve({
        name: step.name,
        command: `${cmd} ${args.join(' ')}`,
        status,
        summary,
        duration_ms,
        exit_code: exitCode,
      });
    });
  });
}

function parseSummary(stepName, stdout, stderr) {
  const combined = `${stdout}\n${stderr}`;
  if (stepName === 'test') {
    // vitest summary line "Tests  1296 passed (1296)"
    const m = combined.match(/Tests\s+(\d+) passed.*?\((\d+)\)/);
    if (m) return `${m[1]} tests passed`;
    const fail = combined.match(/Tests\s+(\d+) failed/);
    if (fail) return `${fail[1]} tests failed`;
  }
  if (stepName === 'build') {
    const m = combined.match(/built in (\d+\w+)/);
    if (m) return `built in ${m[1]}`;
  }
  if (stepName === 'audit') {
    const m = combined.match(/found (\d+) vulnerabilities/);
    if (m) return `${m[1]} vulnerabilities`;
    if (combined.includes('"vulnerabilities":')) return 'audit ran';
  }
  // Default: last 200 chars of output
  return combined.trim().slice(-200).replace(/\s+/g, ' ');
}

// ---- Cache ----

function computeCacheKey(headSha, dirtyDiffHash, taskId) {
  const h = crypto.createHash('sha256');
  h.update(String(headSha ?? ''));
  h.update('\0');
  h.update(String(dirtyDiffHash ?? ''));
  h.update('\0');
  h.update(String(taskId ?? ''));
  return h.digest('hex');
}

async function readCache(cacheKey) {
  const cacheFile = path.join(CACHE_DIR_DEFAULT, `${cacheKey}.json`);
  try {
    const stats = await stat(cacheFile);
    const ageMs = Date.now() - stats.mtimeMs;
    if (ageMs > 10 * 60 * 1000) return null; // 10-min TTL
    const raw = await readFile(cacheFile, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeCache(cacheKey, summary) {
  await mkdir(CACHE_DIR_DEFAULT, { recursive: true });
  const cacheFile = path.join(CACHE_DIR_DEFAULT, `${cacheKey}.json`);
  try {
    await writeFile(cacheFile, JSON.stringify(summary, null, 2), 'utf8');
  } catch { /* non-fatal */ }
}
