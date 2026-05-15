// PR 31 — dev-only runtime separation.
//
// All four `pokemon.devAuto*` boot triggers, the `console.error` /
// `console.warn` audit, and the auto route-walk previously lived
// inline in `src/main.ts`. They are dev-only by contract and must
// be tree-shaken from production builds. PR 31 lifts them into
// this dedicated module so:
//
//   - `src/main.ts` goes back to its actual job (mount the shell,
//     start the data layer).
//   - QA tooling has a single file to point at.
//   - Production tree-shaking is preserved: `src/main.ts` only
//     imports this file via `import('./qa/dev-runtime')` inside
//     `if (import.meta.env.DEV) { … }` branches, and Vite's dead
//     code elimination drops both the dynamic-import call and the
//     entire chunk (plus its transitive imports — `qa-max-stress`,
//     `qa-runner`, `image-audit`, `local-sync-fixture`,
//     `desktop-persistence-diagnostic`) from the production bundle.
//
// Hard rule preserved during the lift:
//   - Every `pokemon.*` localStorage key string is unchanged.
//   - Every console-log prefix (`[dev-auto-fixture]` etc.) is
//     unchanged.
//   - Every dispatched event (`SYNC_STATUS_CHANGED_EVENT`) is
//     unchanged.
//   - The order in which the four `pokemon.devAuto*` triggers run
//     is unchanged (fixture → image-audit → public-sync → max-stress).
//
// Production-gating ban list in
// `tests/qa-route-prod-gating.test.ts` continues to grep the
// production bundle for every dev-only identifier here. PR 31 added
// `runDevAutoTriggersAfterInit` to that list. PR 32 added
// `runBootTimePersistenceAudit` (lifted from `src/app.ts`).
//
// PR 32 — every `pokemon.*` localStorage key string lives in
// `src/domain/storage-keys.ts`. This file imports them so the
// strings have one source of truth; the import chain stays
// dev-only (main.ts dynamic-imports this module under
// `if (import.meta.env.DEV)`), so storage-keys.ts and its values
// continue to be tree-shaken from production.

import {
  CONSOLE_AUDIT_HISTORY_KEY,
  DEV_AUTO_FIXTURE_IMPORT_KEY,
  DEV_AUTO_FIXTURE_IMPORT_RESULT_KEY,
  DEV_AUTO_IMAGE_AUDIT_KEY,
  DEV_AUTO_IMAGE_AUDIT_RESULT_KEY,
  DEV_AUTO_MAX_STRESS_KEY,
  DEV_AUTO_MAX_STRESS_RESULT_KEY,
  DEV_AUTO_PUBLIC_SYNC_KEY,
  DEV_AUTO_PUBLIC_SYNC_RESULT_KEY,
  PERSISTENCE_DIAG_BOOT_HISTORY_KEY,
  ROUTE_WALK_HISTORY_KEY,
} from '../domain/storage-keys';
import { SYNC_STATUS_CHANGED_EVENT } from '../domain/events';

const CONSOLE_HISTORY_LIMIT = 200;
const ROUTE_WALK_DELAY_MS = 1500;
const ROUTE_WALK_INITIAL_DELAY_MS = 5000;
const BOOT_AUDIT_HISTORY_LIMIT = 5;
const AUDIT_ROUTES: ReadonlyArray<string> = [
  'dashboard',
  'browse',
  'collection',
  'binders',
  'lots',
  'wishlist',
  'backup',
  'settings',
  'master-gap',
  'qa',
];

// ---------------------------------------------------------------------
// Console audit + auto route walk (called once, synchronously, from
// `src/main.ts` before `mountApp`).
//
// `installConsoleAudit` hooks the four error channels (console.error,
// console.warn, window.onerror, unhandledrejection) and persists each
// event to `localStorage[pokemon.consoleAuditHistory]`. Each entry is
// `{ ts, route, level, message }`. Capped at 200 entries so a noisy
// run can't overflow.
//
// `kickOffAutoRouteWalk` runs ~5 s after boot (so the data layer has
// settled), then walks every documented route with a short delay
// between hash changes. The audit is read after the walk by the
// Node-side reader in `.local/read-webview-localstorage.mjs`, which
// also dumps `pokemon.consoleAuditHistory`.
//
// Both are no-ops in production builds because `src/main.ts` only
// calls them inside `if (import.meta.env.DEV)`.

export function installConsoleAudit(): void {
  if (typeof window === 'undefined') return;
  const origError = console.error;
  const origWarn = console.warn;
  const stringify = (args: unknown[]): string => {
    return args
      .map((a) => {
        if (a instanceof Error) return `${a.name}: ${a.message}`;
        if (typeof a === 'string') return a;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(' ');
  };
  const push = (level: string, message: string): void => {
    try {
      const raw = localStorage.getItem(CONSOLE_AUDIT_HISTORY_KEY);
      const arr: Array<{
        ts: string;
        route: string;
        level: string;
        message: string;
      }> = raw === null ? [] : (JSON.parse(raw) as never);
      arr.push({
        ts: new Date().toISOString(),
        route: window.location.hash.slice(1) || '<empty>',
        level,
        message,
      });
      while (arr.length > CONSOLE_HISTORY_LIMIT) arr.shift();
      localStorage.setItem(CONSOLE_AUDIT_HISTORY_KEY, JSON.stringify(arr));
    } catch {
      // best-effort
    }
  };
  console.error = (...args: unknown[]): void => {
    push('error', stringify(args));
    origError.apply(console, args);
  };
  console.warn = (...args: unknown[]): void => {
    push('warn', stringify(args));
    origWarn.apply(console, args);
  };
  window.addEventListener('error', (event) => {
    push(
      'window.error',
      `${event.message} (${event.filename}:${event.lineno}:${event.colno})`,
    );
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const msg =
      reason instanceof Error
        ? `${reason.name}: ${reason.message}`
        : String(reason);
    push('unhandledrejection', msg);
  });
  kickOffAutoRouteWalk();
}

function kickOffAutoRouteWalk(): void {
  if (typeof window === 'undefined') return;
  // Skip the walk on subsequent refreshes — each tauri-dev cold boot
  // gets exactly one walk, so the localStorage history stays diffable.
  // The Node reader resets the flag between runs.
  const existing = localStorage.getItem(ROUTE_WALK_HISTORY_KEY);
  if (existing !== null) {
    // Already walked — boot-audit history captures what we need.
    return;
  }
  const walk: Array<{ ts: string; route: string }> = [];
  const startHash = window.location.hash;
  setTimeout(() => {
    let i = 0;
    const step = (): void => {
      if (i >= AUDIT_ROUTES.length) {
        // Restore original hash and persist the walk record.
        window.location.hash = startHash || 'dashboard';
        try {
          localStorage.setItem(ROUTE_WALK_HISTORY_KEY, JSON.stringify(walk));
        } catch {
          // best-effort
        }
        return;
      }
      const route = AUDIT_ROUTES[i]!;
      window.location.hash = route;
      walk.push({ ts: new Date().toISOString(), route });
      i += 1;
      setTimeout(step, ROUTE_WALK_DELAY_MS);
    };
    step();
  }, ROUTE_WALK_INITIAL_DELAY_MS);
}

// ---------------------------------------------------------------------
// Four dev-only boot triggers, run once after `initializeDataLayer()`
// resolves.
//
// Each trigger inspects a `pokemon.devAuto*` localStorage flag, clears
// it (so a second boot does not re-fire before the operator inspects
// the result), then runs the corresponding action and writes the
// result back to a `pokemon.devAuto*Result` key for the Node-side
// helper to read.
//
// The four blocks are intentionally independent: a failure in one
// (caught locally) does not abort the others. Order matches the
// pre-PR-31 main.ts: fixture → image-audit → public-sync → max-stress.

export async function runDevAutoTriggersAfterInit(): Promise<void> {
  await runDevAutoFixtureImport();
  await runDevAutoImageAudit();
  await runDevAutoPublicSync();
  await runDevAutoMaxStress();
}

async function runDevAutoFixtureImport(): Promise<void> {
  // PR 28 review patch — dev-only opt-in auto local-fixture import.
  // When `localStorage[pokemon.devAutoFixtureImport]` holds a path
  // (relative URL served by Vite, e.g. `/local-fixture.json`), we
  // fetch + parse + import it through the same atomic-rewrite path
  // a real sync uses. Result is persisted to
  // `pokemon.devAutoFixtureImportResult` so a Node-side reader can
  // pick up the counts without UI driving. Tree-shaken from
  // production via the surrounding `import.meta.env.DEV` guard in
  // `src/main.ts`.
  if (
    typeof localStorage === 'undefined' ||
    typeof localStorage.getItem(DEV_AUTO_FIXTURE_IMPORT_KEY) !== 'string'
  ) {
    return;
  }
  const fixturePath = localStorage.getItem(DEV_AUTO_FIXTURE_IMPORT_KEY);
  try {
    localStorage.removeItem(DEV_AUTO_FIXTURE_IMPORT_KEY);
  } catch {
    // best-effort
  }
  // dev-only diagnostic — intentional console use
  console.log('[dev-auto-fixture] importing fixture from', fixturePath);
  const fxStart = Date.now();
  try {
    const response = await fetch(String(fixturePath));
    if (!response.ok) {
      throw new Error(`fetch ${fixturePath} → HTTP ${response.status}`);
    }
    const json = (await response.json()) as unknown;
    const { parseLocalSyncFixture, importLocalSyncFixture } = await import(
      './local-sync-fixture'
    );
    const { getDb } = await import('../db/database');
    const source = parseLocalSyncFixture(json, String(fixturePath));
    const result = await importLocalSyncFixture(getDb(), source);
    const payload = {
      ts: new Date().toISOString(),
      durationMs: Date.now() - fxStart,
      path: String(fixturePath),
      result,
    };
    try {
      localStorage.setItem(
        DEV_AUTO_FIXTURE_IMPORT_RESULT_KEY,
        JSON.stringify(payload),
      );
    } catch {
      // best-effort
    }
    // dev-only diagnostic — intentional console use
    console.log('[dev-auto-fixture] done', payload);
    // The fixture import bypasses `handleSyncNow`, so the
    // dashboard / topbar listeners that fire on
    // `SYNC_STATUS_CHANGED_EVENT` need a manual nudge to refresh
    // their cached snapshot. PR 32: imported statically from the
    // event registry rather than dynamic-importing `views/settings`.
    window.dispatchEvent(new CustomEvent(SYNC_STATUS_CHANGED_EVENT));
  } catch (caught) {
    const failure = {
      ts: new Date().toISOString(),
      durationMs: Date.now() - fxStart,
      path: String(fixturePath),
      ok: false,
      error: caught instanceof Error ? caught.message : String(caught),
    };
    try {
      localStorage.setItem(
        DEV_AUTO_FIXTURE_IMPORT_RESULT_KEY,
        JSON.stringify(failure),
      );
    } catch {
      // best-effort
    }
    // dev-only diagnostic — intentional console use
    console.error('[dev-auto-fixture] failed', failure);
  }
}

async function runDevAutoImageAudit(): Promise<void> {
  // PR 28 review patch — dev-only opt-in auto image audit. Walks
  // the cards store + collects any captured runtime image-load
  // failures and persists the coverage report to
  // `pokemon.devAutoImageAuditResult`.
  if (
    typeof localStorage === 'undefined' ||
    localStorage.getItem(DEV_AUTO_IMAGE_AUDIT_KEY) !== '1'
  ) {
    return;
  }
  try {
    localStorage.removeItem(DEV_AUTO_IMAGE_AUDIT_KEY);
  } catch {
    // best-effort
  }
  // dev-only diagnostic — intentional console use
  console.log('[dev-auto-image-audit] running …');
  const iaStart = Date.now();
  try {
    const { auditCardImageCoverage, installImageAudit } = await import(
      './image-audit'
    );
    installImageAudit();
    const { getDb } = await import('../db/database');
    const audit = await auditCardImageCoverage(getDb());
    const payload = {
      ts: new Date().toISOString(),
      durationMs: Date.now() - iaStart,
      audit,
    };
    try {
      localStorage.setItem(
        DEV_AUTO_IMAGE_AUDIT_RESULT_KEY,
        JSON.stringify(payload),
      );
    } catch {
      // best-effort
    }
    // dev-only diagnostic — intentional console use
    console.log('[dev-auto-image-audit] done', payload);
  } catch (caught) {
    // dev-only diagnostic — intentional console use
    console.error('[dev-auto-image-audit] failed', caught);
  }
}

async function runDevAutoPublicSync(): Promise<void> {
  // PR 28 review patch — dev-only opt-in auto public sync. Reading
  // the flag in `localStorage[pokemon.devAutoPublicSync]` lets the
  // Node-side helper trigger a real pokemontcg.io sync (no key,
  // public-tier rate limits) without driving the UI. Result is
  // persisted to `pokemon.devAutoPublicSyncResult` so the same
  // helper can read it back and the QA report can pick up the
  // count.
  if (
    typeof localStorage === 'undefined' ||
    localStorage.getItem(DEV_AUTO_PUBLIC_SYNC_KEY) !== '1'
  ) {
    return;
  }
  // Clear the flag immediately so a second boot doesn't re-run
  // the sync before the operator inspects the result.
  try {
    localStorage.removeItem(DEV_AUTO_PUBLIC_SYNC_KEY);
  } catch {
    // best-effort
  }
  // dev-only diagnostic — intentional console use
  console.log('[dev-auto-sync] starting public-tier sync …');
  const startedAt = Date.now();
  const { syncCardDatabase } = await import('../db/sync');
  const { getDb } = await import('../db/database');
  const result = await syncCardDatabase({
    db: getDb(),
    apiKey: null,
    onProgress: () => {
      // intentionally ignored — the boot-audit captures the
      // post-run cache snapshot, that's enough.
    },
  });
  const summary = {
    ts: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    result,
  };
  try {
    localStorage.setItem(
      DEV_AUTO_PUBLIC_SYNC_RESULT_KEY,
      JSON.stringify(summary),
    );
  } catch {
    // best-effort
  }
  // dev-only diagnostic — intentional console use
  console.log('[dev-auto-sync] done', summary);
}

async function runDevAutoMaxStress(): Promise<void> {
  // PR 28 review patch — dev-only opt-in auto max-stress. Same
  // pattern as auto-sync: a `localStorage` flag triggers
  // `seedMaxStressData` on the next boot, the result is persisted
  // back to `pokemon.devAutoMaxStressResult` so the Node helper
  // can read it without any UI driving.
  if (
    typeof localStorage === 'undefined' ||
    localStorage.getItem(DEV_AUTO_MAX_STRESS_KEY) !== '1'
  ) {
    return;
  }
  try {
    localStorage.removeItem(DEV_AUTO_MAX_STRESS_KEY);
  } catch {
    // best-effort
  }
  // dev-only diagnostic — intentional console use
  console.log('[dev-auto-stress] starting max-stress …');
  const stressStart = Date.now();
  const { seedMaxStressData } = await import('./qa-max-stress');
  const { buildQaDeps } = await import('./qa-runner');
  const { getDb } = await import('../db/database');
  const stressSummary = await seedMaxStressData(buildQaDeps(getDb()));
  const stressPayload = {
    ts: new Date().toISOString(),
    durationMs: Date.now() - stressStart,
    summary: stressSummary,
  };
  try {
    localStorage.setItem(
      DEV_AUTO_MAX_STRESS_RESULT_KEY,
      JSON.stringify(stressPayload),
    );
  } catch {
    // best-effort
  }
  // dev-only diagnostic — intentional console use
  console.log('[dev-auto-stress] done', stressPayload);
}

// ---------------------------------------------------------------------
// Boot-time persistence audit (PR 32 — lifted from `src/app.ts`).
//
// Runs once on every app boot in dev/preview builds, captures a
// full `PersistenceDiagnostic`, and appends it to a localStorage
// history. Lets us observe Launch A → B → C across cold restarts
// WITHOUT any UI navigation — the data is dumped to localStorage
// which survives the same way `pokemon.desktopPersistenceSentinel`
// does. Tree-shaken from production builds via `src/app.ts`'s
// `if (import.meta.env.DEV)` dynamic-import gate.

export async function runBootTimePersistenceAudit(): Promise<void> {
  try {
    const { buildPersistenceDiagnostic } = await import(
      './desktop-persistence-diagnostic'
    );
    const { getDb } = await import('../db/database');
    const diagnostic = await buildPersistenceDiagnostic(getDb());
    const history = readBootAuditHistory();
    history.push({
      capturedAt: diagnostic.capturedAt,
      origin: diagnostic.location.origin,
      runtime: diagnostic.runtime,
      dexie: diagnostic.dexie,
      storeCounts: diagnostic.storeCounts,
      firstHoldingIds: diagnostic.firstHoldingIds,
      firstAppMetaKeys: diagnostic.firstAppMetaKeys,
      storage: diagnostic.storage,
      indexedDbDatabases: diagnostic.indexedDbDatabases,
      localStorageSentinel: diagnostic.localStorageSentinel,
      appMetaSentinel: diagnostic.appMetaSentinel,
      notes: diagnostic.notes,
    });
    while (history.length > BOOT_AUDIT_HISTORY_LIMIT) history.shift();
    writeBootAuditHistory(history);
    // dev-only diagnostic — intentional console use
    console.log('[boot-audit]', diagnostic);
  } catch (caught) {
    // dev-only diagnostic — intentional console use
    console.error('[boot-audit] failed', caught);
  }
}

function readBootAuditHistory(): unknown[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(PERSISTENCE_DIAG_BOOT_HISTORY_KEY);
    if (raw === null) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

function writeBootAuditHistory(history: unknown[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(
      PERSISTENCE_DIAG_BOOT_HISTORY_KEY,
      JSON.stringify(history),
    );
  } catch {
    // best-effort; storage may be full
  }
}
