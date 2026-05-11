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

  // banned_strings_dist: always re-run after build so dev/QA strings can't sneak into prod bundle
  // (mirrors tests/qa-route-prod-gating.test.ts; the assertion is part of the regular test suite,
  // but we surface it as a separate verification entry for the verdict schema).
  steps.push({ name: 'banned_strings_dist', script: undefined, scanDist: true });

  // backup_tests: full backup-restore family when diff touches src/db/** or BACKUP_FORMAT.md
  const touchesBackup = changedFiles.some(f =>
    f.startsWith('src/db/') || f === 'BACKUP_FORMAT.md');
  if (touchesBackup) {
    steps.push({ name: 'backup_tests', script: undefined, vitestFilter: 'backup-|restore-' });
  }

  // binder_tests: when diff touches binder views/services or src/db/**
  const touchesBinder = changedFiles.some(f =>
    f.startsWith('src/views/binder') ||
    f.startsWith('src/services/binder') ||
    f.startsWith('src/db/'));
  if (touchesBinder) {
    steps.push({ name: 'binder_tests', script: undefined, vitestFilter: 'binder-' });
  }

  const touchesTauri = changedFiles.some(f =>
    f.startsWith('src-tauri/') ||
    f === 'src-tauri/tauri.conf.json' ||
    f.startsWith('scripts/desktop')
  );
  if (touchesTauri) {
    steps.push({ name: 'desktop:build', script: 'desktop:build' });
  }

  return steps;
}

async function runOne(step, cwd) {
  const started = Date.now();
  const timeout = PER_STEP_TIMEOUT_MS[step.name] ?? 120000;

  // banned_strings_dist runs as an in-process scan, not a spawn — fast and side-effect-free.
  if (step.scanDist) {
    const result = await scanDistForBannedStrings(cwd);
    return {
      name: step.name,
      command: 'in-process: scan dist/ for banned dev/QA strings',
      status: result.bannedFound > 0 ? 'FAIL' : (result.distExists ? 'PASS' : 'SKIP'),
      summary: result.distExists
        ? (result.bannedFound > 0 ? `${result.bannedFound} banned string(s) in dist/: ${result.hits.slice(0, 3).join(', ')}` : '0 banned strings in dist/')
        : 'dist/ does not exist (build did not produce output, or hasn\'t run yet)',
      duration_ms: Date.now() - started,
      exit_code: result.bannedFound > 0 ? 1 : 0,
    };
  }

  let cmd, args;
  if (step.audit) {
    cmd = 'npm';
    args = ['audit', '--json'];
  } else if (step.vitestFilter) {
    // Run a subset of tests by file-name substring (vitest 4.x positional filter).
    cmd = 'npx';
    args = ['vitest', 'run', step.vitestFilter];
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

// ---- banned_strings_dist scan ----
// Mirrors tests/qa-route-prod-gating.test.ts: dist/ must contain zero references to
// dev-only globals or QA harness identifiers. Catches dev/QA leakage into the prod
// bundle independent of whether tests/qa-route-prod-gating.test.ts ran.
const BANNED_DIST_STRINGS = [
  'devAuto',          // pokemon.devAuto* dev-only API surface
  '__pokemonQA',      // QA harness global
  'POKEMON_DEV',      // dev-only feature flag
  'process.env.NODE_ENV === \'development\'',
  'console.audit',    // dev-only audit hook
];

async function scanDistForBannedStrings(cwd) {
  const distDir = path.join(cwd, 'dist');
  let distExists = false;
  try {
    await stat(distDir);
    distExists = true;
  } catch { /* dist not built */ }
  if (!distExists) return { distExists: false, bannedFound: 0, hits: [] };

  // Walk dist/ recursively, scan each text-like file.
  const { readdir, readFile: rf } = await import('node:fs/promises');
  const hits = [];
  async function walk(dir) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(p); continue; }
      if (!/\.(html|js|mjs|cjs|css|json|map|txt)$/i.test(e.name)) continue;
      try {
        const content = await rf(p, 'utf8');
        for (const banned of BANNED_DIST_STRINGS) {
          if (content.includes(banned)) hits.push(`${path.relative(cwd, p)}::${banned}`);
        }
      } catch { /* binary or unreadable; skip */ }
    }
  }
  await walk(distDir);
  return { distExists: true, bannedFound: hits.length, hits };
}
