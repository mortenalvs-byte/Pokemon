// PR 28 review patch — desktop persistence diagnostic.
//
// Background: a manual L3 run on 2026-05-09 showed that the Tauri
// dev WebView2 reads `db.holdings.count() === 0` after a restart
// even though the underlying LevelDB files (5.45 MB at
// `%LOCALAPPDATA%\com.morten.pokemontracker\EBWebView\Default\IndexedDB\http_localhost_5173.indexeddb.leveldb`)
// stay on disk and `Persistent storage: innvilget` is reported in
// the UI. This module exists to gather hard numbers that say what
// is actually happening across launch A → B → C, without driving
// the experiment from a CI / remote shell.
//
// Locked rules:
//   - No Tauri capabilities added (no fs / shell / clipboard).
//   - No schema migration changes — diagnostic only.
//   - No DB writes outside the explicit "Write persistence sentinel"
//     button: `localStorage.setItem` for the JS sentinel and one
//     `appMeta.put` for the Dexie sentinel.
//   - All writes go through existing public APIs.
//   - Production builds tree-shake this module out: it's only
//     imported by `src/views/qa.ts`, which itself is only mounted
//     when `import.meta.env.DEV === true`.

import { Dexie } from 'dexie';

import type { PokemonTrackerDB } from '../db/database';

export const PERSISTENCE_SENTINEL_LOCAL_STORAGE_KEY =
  'pokemon.desktopPersistenceSentinel';
export const PERSISTENCE_SENTINEL_APP_META_KEY =
  'desktopPersistenceSentinel';
export const PERSISTENCE_BOOT_COUNTER_LOCAL_STORAGE_KEY =
  'pokemon.desktopPersistenceBootCounter';

// ---------------------------------------------------------------------
// Public types — also consumed by the QA report.

export interface PersistenceSentinelPayload {
  readonly bootCounter: number;
  readonly timestamp: string;
  readonly origin: string;
  readonly runtime: 'browser' | 'tauri' | 'unknown';
  readonly note?: string;
}

export interface PersistenceDiagnostic {
  readonly capturedAt: string;
  readonly runtime: 'browser' | 'tauri' | 'unknown';
  readonly location: {
    readonly href: string;
    readonly origin: string;
  };
  readonly userAgent: string;
  readonly storage: {
    readonly persisted: boolean | null;
    readonly estimate: {
      readonly quota: number | null;
      readonly usage: number | null;
    } | null;
  };
  readonly indexedDbDatabases:
    | ReadonlyArray<{ readonly name: string; readonly version: number | null }>
    | null;
  readonly dexie: {
    readonly name: string;
    readonly verno: number;
    readonly tables: ReadonlyArray<{
      readonly name: string;
      readonly schema: string;
    }>;
  };
  readonly storeCounts: Record<string, number>;
  readonly firstHoldingIds: ReadonlyArray<string>;
  readonly firstAppMetaKeys: ReadonlyArray<string>;
  readonly localStorageSentinel: PersistenceSentinelPayload | null;
  readonly appMetaSentinel: PersistenceSentinelPayload | null;
  readonly notes: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------
// Helpers

function detectRuntime(): 'browser' | 'tauri' | 'unknown' {
  if (typeof window === 'undefined') return 'unknown';
  return '__TAURI_INTERNALS__' in window ? 'tauri' : 'browser';
}

function readLocalStorageJson<T>(key: string): T | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeLocalStorageJson(key: string, value: unknown): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(key, JSON.stringify(value));
}

function bumpBootCounter(): number {
  if (typeof localStorage === 'undefined') return 1;
  const raw = localStorage.getItem(PERSISTENCE_BOOT_COUNTER_LOCAL_STORAGE_KEY);
  const previous = raw === null ? 0 : Number.parseInt(raw, 10);
  const next = Number.isFinite(previous) && previous >= 0 ? previous + 1 : 1;
  localStorage.setItem(
    PERSISTENCE_BOOT_COUNTER_LOCAL_STORAGE_KEY,
    String(next),
  );
  return next;
}

function tableSchemaString(table: { schema?: { primKey?: { src?: string }; indexes?: ReadonlyArray<{ src?: string }> } }): string {
  // Dexie's Table.schema is a TableSchema with a primKey and indexes —
  // the .src field is the original index spec string. We concatenate
  // them in the canonical Dexie order so the diagnostic captures the
  // exact contract Dexie has loaded.
  const schema = table.schema;
  if (schema === undefined) return '';
  const parts: string[] = [];
  if (schema.primKey?.src !== undefined) parts.push(schema.primKey.src);
  if (schema.indexes !== undefined) {
    for (const index of schema.indexes) {
      if (index.src !== undefined) parts.push(index.src);
    }
  }
  return parts.join(', ');
}

// ---------------------------------------------------------------------
// Sentinel writer — explicit user action only.

/**
 * Write a fresh sentinel to both `localStorage` and `appMeta`. Bumps
 * the boot counter once. Returns the payload that was written so the
 * caller can render it.
 */
export async function writePersistenceSentinel(
  db: PokemonTrackerDB,
  options?: { readonly note?: string },
): Promise<PersistenceSentinelPayload> {
  const bootCounter = bumpBootCounter();
  const payload: PersistenceSentinelPayload = {
    bootCounter,
    timestamp: new Date().toISOString(),
    origin:
      typeof window === 'undefined' ? 'unknown' : window.location.origin,
    runtime: detectRuntime(),
    ...(options?.note !== undefined ? { note: options.note } : {}),
  };
  writeLocalStorageJson(PERSISTENCE_SENTINEL_LOCAL_STORAGE_KEY, payload);
  await db.appMeta.put({
    key: PERSISTENCE_SENTINEL_APP_META_KEY,
    value: payload,
    updatedAt: payload.timestamp,
  });
  return payload;
}

// ---------------------------------------------------------------------
// Diagnostic builder — read-only.

/**
 * Open the Dexie DB explicitly (so we get a clear failure point on
 * open errors), then walk every store and collect the data the
 * persistence audit needs. Never mutates state.
 */
export async function buildPersistenceDiagnostic(
  db: PokemonTrackerDB,
): Promise<PersistenceDiagnostic> {
  const notes: string[] = [];
  const capturedAt = new Date().toISOString();
  const runtime = detectRuntime();

  // Force Dexie open so subsequent reads use the same instance and
  // schema we report on. Failures are captured to `notes` so the
  // diagnostic is still useful even when open fails.
  try {
    await db.open();
  } catch (caught) {
    notes.push(
      `db.open() failed: ${
        caught instanceof Error ? caught.message : 'unknown error'
      }`,
    );
  }

  const location =
    typeof window === 'undefined'
      ? { href: 'unknown', origin: 'unknown' }
      : { href: window.location.href, origin: window.location.origin };

  const userAgent =
    typeof navigator === 'undefined' ? 'unknown' : navigator.userAgent;

  // Storage permission + estimate. Both are async and may throw on
  // older WebView2 builds — we soak failures into `notes`.
  let persisted: boolean | null = null;
  let estimate: { quota: number | null; usage: number | null } | null = null;
  if (
    typeof navigator !== 'undefined' &&
    'storage' in navigator &&
    navigator.storage !== null &&
    navigator.storage !== undefined
  ) {
    try {
      persisted = await navigator.storage.persisted();
    } catch (caught) {
      notes.push(
        `navigator.storage.persisted() failed: ${
          caught instanceof Error ? caught.message : 'unknown'
        }`,
      );
    }
    try {
      const raw = await navigator.storage.estimate();
      estimate = {
        quota: typeof raw.quota === 'number' ? raw.quota : null,
        usage: typeof raw.usage === 'number' ? raw.usage : null,
      };
    } catch (caught) {
      notes.push(
        `navigator.storage.estimate() failed: ${
          caught instanceof Error ? caught.message : 'unknown'
        }`,
      );
    }
  } else {
    notes.push('navigator.storage not available');
  }

  // `indexedDB.databases()` lists every database the origin owns. Not
  // available in older Chromium / Firefox. Failures are non-fatal.
  let indexedDbDatabases:
    | ReadonlyArray<{ name: string; version: number | null }>
    | null = null;
  if (
    typeof indexedDB !== 'undefined' &&
    typeof (indexedDB as unknown as { databases?: () => Promise<unknown> })
      .databases === 'function'
  ) {
    try {
      const list = await (
        indexedDB as unknown as {
          databases: () => Promise<
            Array<{ name?: string; version?: number }>
          >;
        }
      ).databases();
      indexedDbDatabases = list.map((entry) => ({
        name: typeof entry.name === 'string' ? entry.name : '<unnamed>',
        version: typeof entry.version === 'number' ? entry.version : null,
      }));
    } catch (caught) {
      notes.push(
        `indexedDB.databases() failed: ${
          caught instanceof Error ? caught.message : 'unknown'
        }`,
      );
    }
  } else {
    notes.push('indexedDB.databases() not available');
  }

  // Dexie metadata. `db.tables` is the live list of opened tables.
  const tables = db.tables.map((table) => ({
    name: table.name,
    schema: tableSchemaString(
      table as unknown as Parameters<typeof tableSchemaString>[0],
    ),
  }));

  // Store counts. Each await is independent so a single-store failure
  // doesn't blank the whole diagnostic.
  const storeCounts: Record<string, number> = {};
  const stores: ReadonlyArray<{ name: string; table: { count(): Promise<number> } }> = [
    { name: 'cards', table: db.cards },
    { name: 'sets', table: db.sets },
    { name: 'holdings', table: db.holdings },
    { name: 'binders', table: db.binders },
    { name: 'binderSlots', table: db.binderSlots },
    { name: 'lots', table: db.lots },
    { name: 'lotItems', table: db.lotItems },
    { name: 'wishlist', table: db.wishlist },
    { name: 'auditLog', table: db.auditLog },
    { name: 'settings', table: db.settings },
    { name: 'appMeta', table: db.appMeta },
  ];
  for (const { name, table } of stores) {
    try {
      storeCounts[name] = await table.count();
    } catch (caught) {
      storeCounts[name] = -1;
      notes.push(
        `${name}.count() failed: ${
          caught instanceof Error ? caught.message : 'unknown'
        }`,
      );
    }
  }

  // First five holding IDs (alphabetical via primKey scan). Helps
  // spot whether the seed's `qa1-1` style ids survive across restart.
  let firstHoldingIds: ReadonlyArray<string> = [];
  try {
    const sample = await db.holdings.orderBy(':id').limit(5).primaryKeys();
    firstHoldingIds = sample.map((id) => String(id));
  } catch (caught) {
    notes.push(
      `holdings.primaryKeys() failed: ${
        caught instanceof Error ? caught.message : 'unknown'
      }`,
    );
  }

  let firstAppMetaKeys: ReadonlyArray<string> = [];
  try {
    const sample = await db.appMeta.orderBy(':id').limit(5).primaryKeys();
    firstAppMetaKeys = sample.map((id) => String(id));
  } catch (caught) {
    notes.push(
      `appMeta.primaryKeys() failed: ${
        caught instanceof Error ? caught.message : 'unknown'
      }`,
    );
  }

  // Sentinel readbacks.
  const localStorageSentinel = readLocalStorageJson<PersistenceSentinelPayload>(
    PERSISTENCE_SENTINEL_LOCAL_STORAGE_KEY,
  );
  let appMetaSentinel: PersistenceSentinelPayload | null = null;
  try {
    const row = await db.appMeta.get(PERSISTENCE_SENTINEL_APP_META_KEY);
    if (row !== undefined && typeof row.value === 'object' && row.value !== null) {
      appMetaSentinel = row.value as PersistenceSentinelPayload;
    }
  } catch (caught) {
    notes.push(
      `appMeta.get(sentinel) failed: ${
        caught instanceof Error ? caught.message : 'unknown'
      }`,
    );
  }

  return {
    capturedAt,
    runtime,
    location,
    userAgent,
    storage: { persisted, estimate },
    indexedDbDatabases,
    dexie: {
      name: db.name,
      verno: db.verno,
      tables,
    },
    storeCounts,
    firstHoldingIds,
    firstAppMetaKeys,
    localStorageSentinel,
    appMetaSentinel,
    notes,
  };
}

// ---------------------------------------------------------------------
// Pure verdict helper. Used by both the QA report and unit tests.

export type PersistenceDiagnosticVerdict =
  | 'pass'
  | 'fail_seeded_holdings_zero_with_sentinel'
  | 'fail_db_open'
  | 'inconclusive_no_sentinel'
  | 'inconclusive_no_seed_expected';

/**
 * Decide whether this diagnostic represents a persistence PASS.
 *
 * Rules:
 *   - If `notes` contains a `db.open()` failure → `fail_db_open`.
 *   - If neither sentinel exists → `inconclusive_no_sentinel`. The
 *     caller hasn't yet written one, so persistence cannot be judged.
 *   - If `expectSeededDesktopData === false` → `inconclusive_no_seed_expected`.
 *     We're auditing a fresh install or a measure-only run where 0
 *     holdings is expected.
 *   - If the localStorage sentinel exists but the holdings count is
 *     zero AND we expect seeded data → `fail_seeded_holdings_zero_with_sentinel`.
 *     This is the exact bug the manual run on 2026-05-09 hit.
 *   - Otherwise → `pass`.
 */
export function evaluatePersistenceDiagnostic(
  diagnostic: PersistenceDiagnostic,
  options: { readonly expectSeededDesktopData: boolean } = {
    expectSeededDesktopData: false,
  },
): PersistenceDiagnosticVerdict {
  if (diagnostic.notes.some((n) => n.startsWith('db.open() failed'))) {
    return 'fail_db_open';
  }
  if (
    diagnostic.localStorageSentinel === null &&
    diagnostic.appMetaSentinel === null
  ) {
    return 'inconclusive_no_sentinel';
  }
  if (!options.expectSeededDesktopData) {
    return 'inconclusive_no_seed_expected';
  }
  const holdings = diagnostic.storeCounts['holdings'] ?? 0;
  if (
    holdings === 0 &&
    diagnostic.localStorageSentinel !== null
  ) {
    return 'fail_seeded_holdings_zero_with_sentinel';
  }
  return 'pass';
}

/**
 * Convenience JSON renderer matching the QA report style. Exported so
 * the QA view can offer a "Download persistence diagnostic JSON"
 * button without re-implementing the indentation.
 */
export function renderPersistenceDiagnosticJson(
  diagnostic: PersistenceDiagnostic,
): string {
  return JSON.stringify(diagnostic, null, 2);
}

// Re-export Dexie just for the test harness; the code here only uses
// the type. Real callers always pass a fully-constructed
// PokemonTrackerDB.
export type { Dexie };
