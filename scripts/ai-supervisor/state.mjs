// Atomic state.json load/save with concurrency lock + .bak rotation + migration.
//
// State file: .local/ai-supervisor/state.json
// Lock file:  .local/ai-supervisor/state.lock (JSON: {pid, start_time, hostname})
// Backups:    .local/ai-supervisor/state.json.bak.<YYYYMMDD-HHMMSS>
//
// Atomicity on Windows NTFS: tmp+rename can fail with EPERM (antivirus, indexer);
// retries with exponential backoff. Same parent dir guaranteed.

import { readFile, writeFile, rename, mkdir, stat, unlink, readdir } from 'node:fs/promises';
import { open } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const LOCAL_DIR_DEFAULT = path.join(process.cwd(), '.local', 'ai-supervisor');
const STATE_FILENAME = 'state.json';
const LOCK_FILENAME = 'state.lock';
const QUEUE_FILENAME = 'queue.json';

const CURRENT_SCHEMA_VERSION = 1;

const EMPTY_STATE = () => ({
  schema_version: CURRENT_SCHEMA_VERSION,
  system_prompt_sha: '',
  runInProgress: false,
  code_pins_verified_at: null,
  tasks: {},
  cost: { daily: {}, tasks: {} },
  pending_pushes: [],
  quarantine_fingerprints: [],
});

const EMPTY_QUEUE = () => ({
  schema_version: 'ai_supervisor_queue_v1',
  tasks: [],
});

// Migration map: keyed by target schema_version. Each entry receives the
// pre-migration state and returns the migrated state.
const MIGRATIONS = {
  // 1: initial schema. No migration from 0; future entries here.
};

function makeStatePaths(localDir = LOCAL_DIR_DEFAULT) {
  return {
    dir: localDir,
    statePath: path.join(localDir, STATE_FILENAME),
    lockPath:  path.join(localDir, LOCK_FILENAME),
    queuePath: path.join(localDir, QUEUE_FILENAME),
    tmpPath:   path.join(localDir, `${STATE_FILENAME}.tmp.${process.pid}`),
  };
}

// ---- Atomic write with EPERM retry (Windows NTFS) ----

const RENAME_RETRY_DELAYS_MS = [50, 100, 200, 400, 800, 1600]; // 6 attempts total
const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function atomicWrite(targetPath, content, tmpPath) {
  await writeFile(tmpPath, content, 'utf8');

  let lastErr;
  for (let attempt = 0; attempt < RENAME_RETRY_DELAYS_MS.length; attempt++) {
    try {
      await rename(tmpPath, targetPath);
      return;
    } catch (err) {
      lastErr = err;
      if (!RENAME_RETRY_CODES.has(err.code)) throw err;
      await sleep(RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
  throw new Error(`atomicWrite: rename ${tmpPath} → ${targetPath} failed after ${RENAME_RETRY_DELAYS_MS.length} retries: ${lastErr?.code} ${lastErr?.message}`);
}

// ---- Concurrency lock ----

const LOCK_ALREADY_HELD = Symbol('lock-already-held');

/**
 * Try to acquire .local/ai-supervisor/state.lock. Atomic create via O_EXCL ('wx').
 * On collision, checks if existing PID is alive; reaps stale lock; otherwise returns LOCK_ALREADY_HELD.
 *
 * @returns {Promise<{ok: true, lockPath: string} | {ok: false, reason: 'held-by-active-pid', existing: object}>}
 */
export async function acquireLock(localDir = LOCAL_DIR_DEFAULT) {
  const { lockPath } = makeStatePaths(localDir);
  await mkdir(path.dirname(lockPath), { recursive: true });

  const content = JSON.stringify({
    pid: process.pid,
    start_time: Date.now(),
    hostname: os.hostname(),
    acquired_at: new Date().toISOString(),
  }) + '\n';

  for (let attempt = 0; attempt < 2; attempt++) {
    let fh;
    try {
      fh = await open(lockPath, 'wx');
      await fh.write(content);
      await fh.close();
      return { ok: true, lockPath };
    } catch (err) {
      if (fh) { try { await fh.close(); } catch {} }
      if (err.code !== 'EEXIST') throw err;

      // Lock exists — read content, check PID liveness
      let existing;
      try {
        existing = JSON.parse(await readFile(lockPath, 'utf8'));
      } catch {
        // Corrupt lock: treat as stale
        try { await unlink(lockPath); } catch {}
        continue;
      }
      if (await isPidAlive(existing.pid)) {
        return { ok: false, reason: 'held-by-active-pid', existing };
      }
      // Stale lock — reap and retry
      try { await unlink(lockPath); } catch {}
    }
  }
  return { ok: false, reason: 'unable-to-acquire-after-reap' };
}

async function isPidAlive(pid) {
  if (typeof pid !== 'number' || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0); // POSIX signal 0 = check existence without sending
    return true;
  } catch (err) {
    if (err.code === 'EPERM') return true; // exists but we can't signal it
    return false; // ESRCH = no such process
  }
}

export async function releaseLock(localDir = LOCAL_DIR_DEFAULT) {
  const { lockPath } = makeStatePaths(localDir);
  try {
    // Only delete if WE hold it (PID match)
    const existing = JSON.parse(await readFile(lockPath, 'utf8'));
    if (existing.pid === process.pid) {
      await unlink(lockPath);
    }
  } catch {
    // Already gone or unreadable; nothing to do
  }
}

// ---- State load/save with migration ----

/**
 * Load state.json with migration if needed.
 * Falls back to empty state on first-run (file missing).
 * If file is corrupt AND .bak files exist, attempts the most-recent .bak.
 * Refuses to load if state.schema_version > CURRENT_SCHEMA_VERSION (too new).
 */
export async function loadState(localDir = LOCAL_DIR_DEFAULT) {
  const { statePath, dir } = makeStatePaths(localDir);
  await mkdir(dir, { recursive: true });

  let raw;
  try {
    raw = await readFile(statePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      return EMPTY_STATE();
    }
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (jsonErr) {
    // Try .bak files (newest first)
    const baks = (await listBaks(localDir)).sort().reverse();
    for (const bak of baks) {
      try {
        const bakRaw = await readFile(path.join(dir, bak), 'utf8');
        parsed = JSON.parse(bakRaw);
        // Restore: rewrite state.json from this bak
        await atomicWrite(statePath, bakRaw, path.join(dir, `${STATE_FILENAME}.tmp.${process.pid}`));
        break;
      } catch { /* try next */ }
    }
    if (!parsed) {
      throw new Error(`state.json is corrupt and no .bak could be recovered: ${jsonErr.message}`);
    }
  }

  if (typeof parsed.schema_version !== 'number') {
    throw new Error(`state.json missing schema_version (or wrong type): ${parsed.schema_version}`);
  }
  if (parsed.schema_version > CURRENT_SCHEMA_VERSION) {
    throw new Error(`state.json schema_version=${parsed.schema_version} is newer than code-known version ${CURRENT_SCHEMA_VERSION}. Upgrade supervisor or run --reset.`);
  }

  // Apply migrations in order
  let current = parsed;
  for (let v = current.schema_version + 1; v <= CURRENT_SCHEMA_VERSION; v++) {
    const migrate = MIGRATIONS[v];
    if (!migrate) {
      throw new Error(`Missing migration for state.json v${v}`);
    }
    current = migrate(current);
    current.schema_version = v;
  }

  return current;
}

/**
 * Save state.json atomically. Writes a .bak first, then tmp+rename.
 */
export async function saveState(state, localDir = LOCAL_DIR_DEFAULT) {
  const { statePath, tmpPath, dir } = makeStatePaths(localDir);
  await mkdir(dir, { recursive: true });

  // Write .bak (best-effort; if state.json doesn't exist yet, skip).
  try {
    const existingRaw = await readFile(statePath, 'utf8');
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const bakPath = path.join(dir, `${STATE_FILENAME}.bak.${ts}`);
    await writeFile(bakPath, existingRaw, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  await atomicWrite(statePath, JSON.stringify(state, null, 2) + '\n', tmpPath);

  // Prune old .bak (GFS-style: keep 14 daily, 12 weekly, 12 monthly)
  await pruneBaks(localDir);
}

async function listBaks(localDir) {
  try {
    const entries = await readdir(localDir);
    return entries.filter(e => e.startsWith(`${STATE_FILENAME}.bak.`));
  } catch {
    return [];
  }
}

async function pruneBaks(localDir) {
  const baks = await listBaks(localDir);
  if (baks.length <= 14) return; // nothing to prune yet

  // Sort by name (timestamp-based, so chronological)
  baks.sort();
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;

  const toKeep = new Set();
  const buckets = { daily: new Map(), weekly: new Map(), monthly: new Map() };

  for (const name of baks) {
    const match = name.match(/state\.json\.bak\.(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
    if (!match) { toKeep.add(name); continue; } // keep unparseable

    const [_, date, hh, mm, ss] = match;
    const ts = Date.parse(`${date}T${hh}:${mm}:${ss}Z`);
    const ageMs = now - ts;

    if (ageMs < 14 * dayMs) {
      // Daily window: keep one per day
      if (!buckets.daily.has(date)) buckets.daily.set(date, name);
    } else if (ageMs < 90 * dayMs) {
      // Weekly window: keep one per ISO week
      const week = isoWeekKey(ts);
      if (!buckets.weekly.has(week)) buckets.weekly.set(week, name);
    } else if (ageMs < 365 * dayMs) {
      // Monthly window: keep one per month
      const month = date.slice(0, 7);
      if (!buckets.monthly.has(month)) buckets.monthly.set(month, name);
    }
    // else: drop (older than 1 year)
  }

  for (const m of [buckets.daily, buckets.weekly, buckets.monthly]) {
    for (const name of m.values()) toKeep.add(name);
  }

  for (const name of baks) {
    if (!toKeep.has(name)) {
      try { await unlink(path.join(localDir, name)); } catch {}
    }
  }
}

function isoWeekKey(timestampMs) {
  const d = new Date(timestampMs);
  const dayNum = (d.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const weekNum = 1 + Math.round(((d - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

// ---- Queue load/save ----

export async function loadQueue(localDir = LOCAL_DIR_DEFAULT) {
  const { queuePath } = makeStatePaths(localDir);
  try {
    const raw = await readFile(queuePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed;
  } catch (err) {
    if (err.code === 'ENOENT') return EMPTY_QUEUE();
    throw err;
  }
}

export async function saveQueue(queue, localDir = LOCAL_DIR_DEFAULT) {
  const { queuePath, dir } = makeStatePaths(localDir);
  await mkdir(dir, { recursive: true });
  const tmpPath = path.join(dir, `${QUEUE_FILENAME}.tmp.${process.pid}`);
  await atomicWrite(queuePath, JSON.stringify(queue, null, 2) + '\n', tmpPath);
}

// ---- State mutators (pure-ish — they read current state, return new state) ----

export function incrementRepairCount(state, taskId, errorSignature) {
  const tasks = { ...state.tasks };
  const t = tasks[taskId] ?? { status: 'in_progress', repairCount: 0, consecutiveBlocks: 0, errorSignatures: [], iterations: [] };
  tasks[taskId] = {
    ...t,
    repairCount: t.repairCount + 1,
    consecutiveBlocks: t.consecutiveBlocks + 1,
    errorSignatures: [...(t.errorSignatures ?? []), errorSignature].slice(-10),
  };
  return { ...state, tasks };
}

export function resetRepairCount(state, taskId) {
  const tasks = { ...state.tasks };
  const t = tasks[taskId];
  if (t) {
    tasks[taskId] = { ...t, repairCount: 0, consecutiveBlocks: 0, errorSignatures: [] };
  }
  return { ...state, tasks };
}

export function recordIteration(state, taskId, hash, verdict) {
  const tasks = { ...state.tasks };
  const t = tasks[taskId] ?? { status: 'in_progress', repairCount: 0, consecutiveBlocks: 0, errorSignatures: [], iterations: [] };
  tasks[taskId] = {
    ...t,
    iterations: [...(t.iterations ?? []), { hash, verdict, at: new Date().toISOString() }].slice(-20),
  };
  return { ...state, tasks };
}

export function addCostUsd(state, taskId, costSplits) {
  const today = new Date().toISOString().slice(0, 10);
  const daily = { ...(state.cost?.daily ?? {}) };
  const cur = daily[today] ?? { actual_input_cost_usd: 0, cached_input_cost_usd: 0, output_cost_usd: 0, total_usd: 0 };
  daily[today] = {
    actual_input_cost_usd: cur.actual_input_cost_usd + (costSplits.actual_input_usd ?? 0),
    cached_input_cost_usd: cur.cached_input_cost_usd + (costSplits.cached_input_usd ?? 0),
    output_cost_usd:       cur.output_cost_usd + (costSplits.output_usd ?? 0),
    total_usd:             cur.total_usd + (costSplits.total_usd ?? 0),
  };
  const tasksMap = { ...(state.cost?.tasks ?? {}) };
  if (taskId) {
    const t = tasksMap[taskId] ?? { total_usd: 0 };
    tasksMap[taskId] = { total_usd: t.total_usd + (costSplits.total_usd ?? 0) };
  }
  return { ...state, cost: { daily, tasks: tasksMap } };
}

export function recordQuarantineFingerprint(state, fingerprint) {
  const fps = [...(state.quarantine_fingerprints ?? []), {
    ...fingerprint,
    quarantined_at: new Date().toISOString(),
  }];
  return { ...state, quarantine_fingerprints: fps };
}

export function appendPendingPush(state, branch) {
  const existing = state.pending_pushes ?? [];
  if (existing.includes(branch)) return state;
  return { ...state, pending_pushes: [...existing, branch] };
}

export function computeHash(parts) {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(String(p ?? ''));
  return h.digest('hex');
}

// Expose paths for callers that need them
export { makeStatePaths, CURRENT_SCHEMA_VERSION, LOCK_ALREADY_HELD };
