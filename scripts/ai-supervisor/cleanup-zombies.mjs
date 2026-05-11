// Zombie supervisor-process cleanup. Mitigates Claude Code's
// subprocess-orphaning bug (anthropic/claude-code#32183).
//
// At supervisor startup, list node.exe (or `node` on Unix) processes
// whose command line contains `scripts/ai-supervisor/` AND whose PID
// is NOT the current process AND NOT the holder of state.lock.
// Skips operator's other node processes by command-line filter.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * List potential zombie supervisor processes.
 * @param {object} [opts]
 * @param {number[]} [opts.knownLivePids] — PIDs that should NOT be reaped (e.g. current process, state.lock holder)
 * @returns {Promise<Array<{pid: number, cmdline: string}>>}
 */
export async function listZombieSupervisors(opts = {}) {
  const knownLive = new Set(opts.knownLivePids ?? [process.pid]);
  knownLive.add(process.pid);

  if (process.platform === 'win32') {
    return listWindowsZombies(knownLive);
  }
  return listUnixZombies(knownLive);
}

async function listWindowsZombies(knownLive) {
  // wmic gives full command lines; tasklist alone doesn't.
  // Format: CSV via /FO CSV /NH
  try {
    const { stdout } = await exec('wmic', ['process', 'where', 'name="node.exe"', 'get', 'ProcessId,CommandLine', '/format:csv'], { maxBuffer: 5_000_000 });
    const zombies = [];
    for (const line of stdout.split('\n')) {
      const cols = line.split(',');
      if (cols.length < 3) continue;
      const cmdline = cols.slice(1, -1).join(',').trim();
      const pid = parseInt(cols[cols.length - 1], 10);
      if (!Number.isFinite(pid)) continue;
      if (knownLive.has(pid)) continue;
      if (!cmdline.includes('scripts/ai-supervisor') && !cmdline.includes('scripts\\ai-supervisor')) continue;
      zombies.push({ pid, cmdline });
    }
    return zombies;
  } catch (err) {
    // wmic may be deprecated on newer Windows; fall back to PowerShell
    try {
      const { stdout } = await exec('powershell', ['-NoProfile', '-Command',
        'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | Select-Object ProcessId,CommandLine | ConvertTo-Json'
      ], { maxBuffer: 5_000_000 });
      const arr = JSON.parse(stdout || '[]');
      const list = Array.isArray(arr) ? arr : [arr];
      const zombies = [];
      for (const p of list) {
        const pid = p.ProcessId;
        const cmdline = p.CommandLine ?? '';
        if (!Number.isFinite(pid)) continue;
        if (knownLive.has(pid)) continue;
        if (!cmdline.includes('scripts/ai-supervisor') && !cmdline.includes('scripts\\ai-supervisor')) continue;
        zombies.push({ pid, cmdline });
      }
      return zombies;
    } catch {
      return [];
    }
  }
}

async function listUnixZombies(knownLive) {
  try {
    const { stdout } = await exec('ps', ['-eo', 'pid,command'], { maxBuffer: 5_000_000 });
    const zombies = [];
    for (const line of stdout.split('\n').slice(1)) {
      const m = line.match(/^\s*(\d+)\s+(.*)$/);
      if (!m) continue;
      const pid = parseInt(m[1], 10);
      const cmdline = m[2];
      if (knownLive.has(pid)) continue;
      if (!cmdline.includes('scripts/ai-supervisor')) continue;
      zombies.push({ pid, cmdline });
    }
    return zombies;
  } catch {
    return [];
  }
}

/**
 * Attempt to reap zombies via process.kill(pid, 'SIGTERM').
 * Returns { reaped: number, failed: number }.
 */
export async function reapZombies(zombies) {
  let reaped = 0;
  let failed = 0;
  for (const { pid } of zombies) {
    try {
      process.kill(pid, 'SIGTERM');
      reaped++;
    } catch {
      failed++;
    }
  }
  return { reaped, failed };
}
