// PR 32 — central registry of every localStorage key the app
// reads or writes.
//
// Every dev-only diagnostic / auto-trigger / persistence module
// imports from here so the string keys have one source of truth.
// The actual values are **byte-identical to PR 31** — backwards
// compatible with any external tooling (Tauri-side reader,
// `.local/read-webview-localstorage.mjs`, manual operator
// inspection in DevTools) that reads localStorage by string.
//
// **All 13 keys here are dev-only by design.** They are imported
// transitively only from modules that are themselves dev-only:
//   - `src/qa/dev-runtime.ts` (PR 31 — owns the four
//     `pokemon.devAuto*` boot triggers + the console + route-walk
//     audit + the boot-time persistence audit)
//   - `src/qa/desktop-persistence-diagnostic.ts` (only mounted by
//     the dev-only `#qa` view)
//
// Both of those modules are reached only via dynamic
// `import('./qa/dev-runtime')` or `import('./views/qa')` inside
// `if (import.meta.env.DEV)` branches in `src/main.ts` and
// `src/app.ts`. Vite's dead-code elimination drops the entire
// chain (this file included) from the production bundle.
//
// `tests/qa-route-prod-gating.test.ts` re-pins the production
// gating: every literal value here must NOT appear in
// `dist/assets/index-*.js`. The gating test imports the values
// from this registry so the ban list automatically extends
// whenever a new key is added.

// -- Production-runtime app boot diagnostic (dev-only, gated) --------

/**
 * `pokemon.persistenceDiagBootHistory` — last 5 boot-time
 * persistence diagnostics. Captures store counts, sentinel state,
 * and runtime info on every dev/desktop boot. Read by
 * `runBootTimePersistenceAudit()` in `src/qa/dev-runtime.ts`.
 */
export const PERSISTENCE_DIAG_BOOT_HISTORY_KEY =
  'pokemon.persistenceDiagBootHistory';

// -- Console + auto route walk audit (dev-only, gated) ---------------

/**
 * `pokemon.consoleAuditHistory` — last 200 captured
 * `console.error` / `console.warn` / `window.error` /
 * `unhandledrejection` events. Owned by
 * `installConsoleAudit()` in `src/qa/dev-runtime.ts`.
 */
export const CONSOLE_AUDIT_HISTORY_KEY = 'pokemon.consoleAuditHistory';

/**
 * `pokemon.routeWalkHistory` — record of the auto route walk that
 * runs once per cold boot. Owned by `kickOffAutoRouteWalk()` in
 * `src/qa/dev-runtime.ts`.
 */
export const ROUTE_WALK_HISTORY_KEY = 'pokemon.routeWalkHistory';

// -- Auto-trigger flags + their result keys (dev-only, gated) --------
//
// Each pair is one boot-trigger:
//   FLAG  set by the operator / Node-side helper before reload
//   RESULT  written by the trigger after it runs

export const DEV_AUTO_FIXTURE_IMPORT_KEY = 'pokemon.devAutoFixtureImport';
export const DEV_AUTO_FIXTURE_IMPORT_RESULT_KEY =
  'pokemon.devAutoFixtureImportResult';

export const DEV_AUTO_IMAGE_AUDIT_KEY = 'pokemon.devAutoImageAudit';
export const DEV_AUTO_IMAGE_AUDIT_RESULT_KEY =
  'pokemon.devAutoImageAuditResult';

export const DEV_AUTO_PUBLIC_SYNC_KEY = 'pokemon.devAutoPublicSync';
export const DEV_AUTO_PUBLIC_SYNC_RESULT_KEY =
  'pokemon.devAutoPublicSyncResult';

export const DEV_AUTO_MAX_STRESS_KEY = 'pokemon.devAutoMaxStress';
export const DEV_AUTO_MAX_STRESS_RESULT_KEY =
  'pokemon.devAutoMaxStressResult';

// -- Desktop persistence diagnostic (dev-only, gated by #qa view) ----

/**
 * `pokemon.desktopPersistenceSentinel` — written by the QA view
 * "Write persistence sentinel" button. Read on subsequent cold
 * boots to confirm the same WebView2 storage profile survived.
 * Lives alongside an `appMeta` Dexie sentinel
 * (`desktopPersistenceSentinel`) that is intentionally NOT a
 * `pokemon.*`-prefixed localStorage key — it is a Dexie key.
 */
export const DESKTOP_PERSISTENCE_SENTINEL_KEY =
  'pokemon.desktopPersistenceSentinel';

/**
 * `pokemon.desktopPersistenceBootCounter` — monotonically increments
 * on every cold boot of the desktop binary. Used to label the
 * sentinel and the boot-history entries.
 */
export const DESKTOP_PERSISTENCE_BOOT_COUNTER_KEY =
  'pokemon.desktopPersistenceBootCounter';

/**
 * Frozen list of every dev-only localStorage key the app owns.
 * Exposed for `tests/qa-route-prod-gating.test.ts` so the ban
 * list automatically extends whenever a new key is added to the
 * registry. Production builds must contain ZERO of these.
 */
export const ALL_DEV_ONLY_STORAGE_KEYS = [
  PERSISTENCE_DIAG_BOOT_HISTORY_KEY,
  CONSOLE_AUDIT_HISTORY_KEY,
  ROUTE_WALK_HISTORY_KEY,
  DEV_AUTO_FIXTURE_IMPORT_KEY,
  DEV_AUTO_FIXTURE_IMPORT_RESULT_KEY,
  DEV_AUTO_IMAGE_AUDIT_KEY,
  DEV_AUTO_IMAGE_AUDIT_RESULT_KEY,
  DEV_AUTO_PUBLIC_SYNC_KEY,
  DEV_AUTO_PUBLIC_SYNC_RESULT_KEY,
  DEV_AUTO_MAX_STRESS_KEY,
  DEV_AUTO_MAX_STRESS_RESULT_KEY,
  DESKTOP_PERSISTENCE_SENTINEL_KEY,
  DESKTOP_PERSISTENCE_BOOT_COUNTER_KEY,
] as const;
