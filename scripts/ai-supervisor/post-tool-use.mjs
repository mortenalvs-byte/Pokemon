#!/usr/bin/env node
// PostToolUse hook: continuous testing after Claude's Edit/Write/MultiEdit.
// Runs `vitest related <file>` in the background; writes test failures to a
// log the Stop hook reviewer sees in the packet. Non-blocking.

import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';

const REPO_ROOT = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const LOG_PATH = path.join(REPO_ROOT, '.local', 'ai-supervisor', 'recent-test-failures.ndjson');

const SOURCE_PATTERN = /^src\/.*\.ts$/;
const TEST_PATTERN = /^tests\/.*\.test\.ts$/;

async function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) raw += chunk;
  if (!raw.trim()) { process.exit(0); return; }

  let input;
  try { input = JSON.parse(raw); } catch { process.exit(0); return; }

  const filePath = input?.tool_input?.file_path;
  if (!filePath) { process.exit(0); return; }

  const rel = path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');
  if (!SOURCE_PATTERN.test(rel) && !TEST_PATTERN.test(rel)) {
    process.exit(0);
    return;
  }

  // Spawn vitest and AWAIT its close (with a hard timeout). The previous
  // fire-and-forget approach used `detached + unref + process.exit(0)`, but
  // that kills the parent before the `close` handler can run — failure logs
  // never got written. PostToolUse hooks are allowed up to 30s; we cap at
  // 25s so we never overrun the hook timeout.
  const isWindows = process.platform === 'win32';
  const child = spawn('npm', ['exec', '--', 'vitest', 'related', rel, '--run', '--reporter=json'], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: isWindows,
    env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
  });

  let stdout = '';
  child.stdout.on('data', d => stdout += d.toString());

  const result = await new Promise(resolve => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 1000);
      resolve({ code: -1, timedOut: true });
    }, 25000);
    child.on('close', code => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, timedOut: false });
    });
  });

  if (result.code !== 0) {
    try {
      await mkdir(path.dirname(LOG_PATH), { recursive: true });
      const entry = {
        at: new Date().toISOString(),
        file: rel,
        exit_code: result.code,
        timed_out: result.timedOut,
        output_tail: stdout.slice(-2000),
      };
      await appendFile(LOG_PATH, JSON.stringify(entry) + '\n', 'utf8');
    } catch { /* best-effort */ }
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
