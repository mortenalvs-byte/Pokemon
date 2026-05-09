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
// production bundle for every dev-only identifier here. PR 31 adds
// `runDevAutoTriggersAfterInit` to that list.

const CONSOLE_HISTORY_KEY = 'pokemon.consoleAuditHistory';
const CONSOLE_HISTORY_LIMIT = 200;
const ROUTE_WALK_KEY = 'pokemon.routeWalkHistory';
const ROUTE_WALK_DELAY_MS = 1500;
const ROUTE_WALK_INITIAL_DELAY_MS = 5000;
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
      const raw = localStorage.getItem(CONSOLE_HISTORY_KEY);
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
      localStorage.setItem(CONSOLE_HISTORY_KEY, JSON.stringify(arr));
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
  const existing = localStorage.getItem(ROUTE_WALK_KEY);
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
          localStorage.setItem(ROUTE_WALK_KEY, JSON.stringify(walk));
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
    typeof localStorage.getItem('pokemon.devAutoFixtureImport') !== 'string'
  ) {
    return;
  }
  const fixturePath = localStorage.getItem('pokemon.devAutoFixtureImport');
  try {
    localStorage.removeItem('pokemon.devAutoFixtureImport');
  } catch {
    // best-effort
  }
  // eslint-disable-next-line no-console -- dev-only diagnostic
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
        'pokemon.devAutoFixtureImportResult',
        JSON.stringify(payload),
      );
    } catch {
      // best-effort
    }
    // eslint-disable-next-line no-console -- dev-only diagnostic
    console.log('[dev-auto-fixture] done', payload);
    // The fixture import bypasses `handleSyncNow`, so the
    // dashboard / topbar listeners that fire on
    // `SYNC_STATUS_CHANGED_EVENT` need a manual nudge to refresh
    // their cached snapshot.
    const { SYNC_STATUS_CHANGED_EVENT } = await import('../views/settings');
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
        'pokemon.devAutoFixtureImportResult',
        JSON.stringify(failure),
      );
    } catch {
      // best-effort
    }
    // eslint-disable-next-line no-console -- dev-only diagnostic
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
    localStorage.getItem('pokemon.devAutoImageAudit') !== '1'
  ) {
    return;
  }
  try {
    localStorage.removeItem('pokemon.devAutoImageAudit');
  } catch {
    // best-effort
  }
  // eslint-disable-next-line no-console -- dev-only diagnostic
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
        'pokemon.devAutoImageAuditResult',
        JSON.stringify(payload),
      );
    } catch {
      // best-effort
    }
    // eslint-disable-next-line no-console -- dev-only diagnostic
    console.log('[dev-auto-image-audit] done', payload);
  } catch (caught) {
    // eslint-disable-next-line no-console -- dev-only diagnostic
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
    localStorage.getItem('pokemon.devAutoPublicSync') !== '1'
  ) {
    return;
  }
  // Clear the flag immediately so a second boot doesn't re-run
  // the sync before the operator inspects the result.
  try {
    localStorage.removeItem('pokemon.devAutoPublicSync');
  } catch {
    // best-effort
  }
  // eslint-disable-next-line no-console -- dev-only diagnostic
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
      'pokemon.devAutoPublicSyncResult',
      JSON.stringify(summary),
    );
  } catch {
    // best-effort
  }
  // eslint-disable-next-line no-console -- dev-only diagnostic
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
    localStorage.getItem('pokemon.devAutoMaxStress') !== '1'
  ) {
    return;
  }
  try {
    localStorage.removeItem('pokemon.devAutoMaxStress');
  } catch {
    // best-effort
  }
  // eslint-disable-next-line no-console -- dev-only diagnostic
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
      'pokemon.devAutoMaxStressResult',
      JSON.stringify(stressPayload),
    );
  } catch {
    // best-effort
  }
  // eslint-disable-next-line no-console -- dev-only diagnostic
  console.log('[dev-auto-stress] done', stressPayload);
}
