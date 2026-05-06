# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once a versioned release lands.

---

## [Unreleased]

### Added
- **PR 5 — pokemontcg.io API sync + Settings view + topbar sync chip.** First time the app talks to the network. Sync is fetch-all-first-then-write-once: a failed sync leaves the cache, user-owned stores, and `lastSyncAt` untouched. The MVP roundtrip contract (`tests/backup-roundtrip.test.ts`) stays green.
  - `src/api/sanitize.ts` — `sanitizeErrorMessage(error, apiKey)` and `redactApiKey(text, apiKey)`. Used at every boundary that turns an error into UI / audit / appMeta text.
  - `src/api/types.ts` — wire DTOs (`PokemonTcgSetDto`, `PokemonTcgCardDto`, `PokemonTcgPaginatedResponse`) and pure mappers (`mapApiSet`, `mapApiCard`) that normalize optional/null API fields into our strict `SetRecord` / `CardRecord` shape.
  - `src/api/retry.ts` — `fetchWithRetry()` and `parseRetryAfterMs()`. Retries 429 (respecting `Retry-After` delta-seconds; HTTP-date form falls back to policy backoff), 5xx, and network errors with exponential backoff (1 s → 2 s → 4 s → 8 s, capped at 30 s). 4xx other than 429 fail immediately. `sleep` and `fetch` are injectable; tests pass a fake sleep so retries never wait wall-clock seconds. The retry loop applies its own ceiling so a server-supplied `Retry-After: 999999` still sleeps ≤ 30 s.
  - `src/api/pokemon-tcg-api.ts` — `createApiClient({ apiKey, fetchImpl, sleep, baseUrl, pageSize, retry })`. Methods: `fetchAllSets`, `fetchAllCardsForSet`, `testConnection`. The API key only goes in the `X-Api-Key` header; the client refuses to put it in the URL. Errors thrown out of the client are sanitized — even an accidental `fetch` implementation that echoes the header into its message cannot leak the key.
  - `src/db/sync.ts` — `syncCardDatabase({ db, apiKey?, fetchImpl?, sleep?, apiClient?, onProgress? })`. Fetches every set + every card into memory first. **Only after every fetch succeeded** does it open one Dexie `rw` transaction over `[sets, cards, appMeta, auditLog]` to clear-and-replace the cache, set `appMeta.lastSyncAt`, set `appMeta.lastSyncStatus = 'ok'`, clear `appMeta.lastSyncError`, and append exactly one `sync_run` audit row. On failure (during fetch or commit) it opens a separate small `rw` transaction over `[appMeta, auditLog]` only — sets `lastSyncStatus = 'failed'`, writes a sanitized `lastSyncError`, and appends one `sync_failed` audit. Cache, user-owned stores, and `lastSyncAt` are untouched on failure. The orchestrator never reads or writes `settings`, `holdings`, `binders`, `binderSlots`, `lots`, `lotItems`, or `wishlist`.
  - `src/views/settings.ts` — replaces the placeholder. Sections: **API** (password input + Save + Test connection + last-status feedback), **Sync** (last sync, status, last error, sets / cards counts, `Synk nå` with progress + result panel), **Defaults** (preferred currency, default raw condition, default binder slots-per-page), **Storage** (persistent storage status + schema version). The view owns reading and saving the API key via `settingsRepo`; the sync orchestrator never touches `settings`. After a successful sync the view dispatches `window.dispatchEvent(new CustomEvent('pokemon:sync-completed'))` so any listener (currently the topbar) can refresh — no global state framework. All dynamic content is rendered via `textContent` / `createElement`.
  - `src/app.ts` — topbar status region now renders a sync chip read from `appMeta.lastSyncAt` / `lastSyncStatus`. It listens for `pokemon:sync-completed` and re-reads. The view runner already supports interactive `(container) => void` mounts from PR 4; Settings now uses that signature.
  - `src/styles.css` — Settings-view classes mirroring the Backup-view panel/button/feedback look.
  - `src/domain/types.ts` — adds two reserved `appMeta` keys (`lastSyncStatus`, `lastSyncError`) and a `SyncStatus = 'ok' | 'failed'` type.
  - **Tests (139 / 139, 19 files):**
    - `tests/api-retry.test.ts` — 2xx fast path, 429 + `Retry-After` (seconds), 5xx exponential backoff, network-error retry, max-attempts exhaustion, no retry on other 4xx, fake sleep keeps tests sub-second, `Retry-After` clamp inside the loop.
    - `tests/api-client.test.ts` — pagination, DTO → record mapping, API key sent only in `X-Api-Key` (never in URL), header omitted when no key, sanitized errors, `testConnection()` returns `false` on error without leaking the key.
    - `tests/sync.test.ts` — happy path populates cache, success writes `lastSyncAt`/`lastSyncStatus=ok`/one `sync_run` audit, failure leaves cache + every user-owned store + `lastSyncAt` unchanged and writes one `sync_failed` audit + sanitized `lastSyncError`, progress callback fires for both sets and cards phases, sanitized error messages never contain the API key value.
    - `tests/settings-view.test.ts` — view mounts the four panels, API-key input is `type=password`, Save commits to the settings repo and surfaces a feedback message, `<script>` injected into `lastSyncError` is rendered as text (no script element appears), Save defaults persists currency / condition / slots-per-page, hydration restores existing settings on mount.
  - `tests/backup-roundtrip.test.ts` remains green: PR_RULES §10's mandatory contract holds across the new sync code path.

### Added
- **PR 4 — Backup, restore, validation, round-trip tests, minimal Backup view.** The data-layer contract that all later PRs must keep green: `export → wipe → restore` produces an equivalent database. PR 4 adds:
  - `src/db/backup.ts` — `readBackupSnapshot()` (pure read; supports `includeApiKey: false` default), `serializeBackupToJson()` (UTF-8, two-space indent, no BOM), `buildBackupFileName()` (`pokemon-tracker-backup-v1-YYYYMMDD-HHMMSS.json`), and `exportToBackupFile()` which captures the snapshot first, then records `appMeta.lastBackupAt`, `appMeta.lastBackupHoldingCount`, and a `backup_exported` audit entry on the live DB.
  - `src/db/auto-backup.ts` — `tryPreRestoreAutoBackup()`: best-effort, never-throwing snapshot-and-serialize used as the safety net before a destructive restore. Returns `{ ok: true, filename, json }` or `{ ok: false, error }`. Filename prefix is `pre-restore-backup-` so it's distinguishable from real exports.
  - `src/db/restore.ts` — `parseBackupJson()`, `validateBackup()` (returns `{ ok: true, backup, warnings } | { ok: false, errors, warnings }`), `replaceRestore()`, and the typed `PreRestoreBackupFailedError`. Replace-restore runs every clear + bulkPut inside one Dexie transaction, preserves an existing `pokemonTcgApiKey` if the backup omits one, updates `appMeta` (`schemaVersion`, `lastBackupAt = backup.exportedAt`, `lastMigrationAt = now`), and appends a `backup_restored` audit row inside the transaction. A mid-transaction failure rolls back; the database is unchanged.
  - `src/utils/download.ts` — `downloadTextFile()`. Browser-only. Pure data-layer code never calls it.
  - `src/views/backup.ts` — replaces the placeholder. Status panel (last backup, holdings count at last backup, persistent storage status, `backup_old` / `storage_not_persistent` chips), Export button (calls `exportToBackupFile` → `downloadTextFile`), Restore flow (file picker → parse → validate → preview counts and warnings → `window.confirm()` → `tryPreRestoreAutoBackup` → `replaceRestore`). Merge-restore button is rendered but disabled with the documented "planned for a later release" tooltip. All dynamic content is rendered via `textContent`/`createElement` (verified by the view test that plants raw `<script>` text in `lastBackupAt` and asserts no script element appears in the DOM).
  - `src/app.ts` — view runner now uses a small `(container) => void` mount API so views with listeners (currently just Backup) can attach handlers cleanly. Existing string-render views are unaffected — they're wrapped in one-line adapters.
  - `src/styles.css` — minimal Backup-view styling (panels, primary/danger button variants, status grid, preview list).
  - **Tests:** `tests/backup-export.test.ts`, `tests/backup-validate.test.ts`, `tests/backup-restore.test.ts`, `tests/backup-roundtrip.test.ts`, `tests/backup-view.test.ts`. 108 tests across 15 files; the round-trip test seeds cards, holdings, binders, slots, lots, lot items, wishlist, and settings, exports, validates, restores into a separate fresh DB, and asserts equivalent counts plus per-record equality for binders / slots / lots / lot items / wishlist / holdings, and that re-exporting the restored DB validates without warnings.
  - `PR_RULES.md` patched: §10 cross-reference fixed (was §12 → now §13), section reframed as "(historical)" since PR 3 has merged. The closing paragraph now states explicitly that **from PR 4 onward, `export → wipe → restore` round-trip is mandatory for every data-layer PR** and that a failing round-trip blocks merge.
  - **Patch:** `readBackupSnapshot()` now wraps every `.toArray()` inside one Dexie read transaction over all 11 stores, matching `BACKUP_FORMAT.md §7`. A concurrent write that lands between two store reads can no longer produce an inconsistent snapshot. `recordExportSideEffects()` likewise wraps the two `appMeta.put` calls and the `backup_exported` audit insert in one rw-transaction so an export cannot leave `appMeta` updated without a matching audit row, or vice versa. Behaviour is otherwise unchanged: API-key exclusion default, snapshot-before-side-effects ordering, and download separation all hold.

### Added
- **PR 3 — Dexie IndexedDB schema, migrations, repositories, soft delete, audit log.** The data layer lands. No UI feature work, no API sync, no backup yet.
  - Dependencies: `dexie` and dev-only `fake-indexeddb` (used by the test setup so Dexie can run in Node without a browser).
  - `src/domain/types.ts` exports every enum and record shape from `DATA_MODEL.md`, plus `BackupFile`, reserved appMeta keys, and reserved settings keys.
  - `src/domain/validators.ts` exports `ValidationError` and validators for holdings, binders, binder slots, lots, lot items, and wishlist (rules from `DATA_MODEL.md §10`).
  - `src/utils/{ids,dates,money}.ts` host the small primitives (`crypto.randomUUID()` wrapper, ISO 8601 helpers, currency-code list and guard).
  - `src/db/schema.ts` declares the Dexie version chain at `schemaVersion = 1` with all 11 stores and the indexes named in `DATA_MODEL.md` (compound `[binderId+pageNumber+slotNumber]`, multi-entry `*tags`, plus `deletedAt` on every soft-deletable store).
  - `src/db/database.ts` defines `PokemonTrackerDB` (typed Dexie subclass), a singleton `getDb()`, and a `createDatabase(name?)` factory used by tests.
  - `src/db/audit.ts` exposes `appendAudit()` — the only writer to the append-only `auditLog` store.
  - `src/db/soft-delete.ts` exposes generic `softDeleteRecord`, `restoreRecord`, `listLive`, `listDeleted` helpers; soft-delete and restore audit themselves.
  - `src/db/persistence.ts` wraps `navigator.storage.persist()` as a best-effort, never-throwing call.
  - `src/db/init.ts` exports `initializeDataLayer()` which opens the database, writes `schemaVersion`, `appVersion`, `lastMigrationAt` and `persistentStorageGranted` once, and appends a single `schema_migration` audit entry per migration run.
  - `src/repositories/*` ships ten typed repositories: `setsRepo`, `cardsRepo`, `holdingsRepo`, `lotsRepo`, `lotItemsRepo`, `bindersRepo`, `binderSlotsRepo`, `wishlistRepo`, `settingsRepo`, `appMetaRepo`. User-owned repos expose `softDelete`/`restore`/`listLive` and intentionally do not expose permanent delete. The settings repo redacts the API-key value from audit messages.
  - `src/main.ts` calls `initializeDataLayer()` after the app shell mounts, with a `.catch()` so a failed init never crashes the shell.
  - Tests: `tests/{schema,migrations,audit,soft-delete,validators,repositories,db-init}.test.ts` (plus the existing PR 2 suites). 71 tests across 10 files. Each Dexie test uses a freshly named database via `tests/helpers/fresh-db.ts`.
  - Patched `PR_RULES.md §5` to clarify that typed repositories land alongside the schema in PR 3 because PR 4's backup/restore relies on typed store access.
  - **Patch:** `PR_RULES.md` gains a narrow §10 "PR 3 backup-rule exception" so PR 3 can land before PR 4's backup/restore exists. The §4 backup-rule clause and the §8 / §12 round-trip checks are explicitly N/A for PR 3 only; PR 4 onward must keep the export → wipe → restore round-trip green.
  - **Patch:** `settingsRepo.delete(key)` and `appMetaRepo.delete(key)` removed from the public interfaces and implementations. Settings is sacred user data; clearing the API key (or any other setting) requires a narrow named method or PR 4's restore logic — not a generic delete. Two new tests pin that no `delete` is exposed.

### Added
- **PR 2 — Vite + TypeScript app shell + Vitest.** The first code lands. Vite (vanilla-ts) is the build tool, TypeScript runs in strict mode with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` enabled. A simple hash-based router wires up eight stub views (Dashboard, Browse, Collection, Binders, Lots, Wishlist, Backup, Settings). The topbar and left sidebar match the layout described in `UI_DESIGN_SPEC.md`. CSS variables define the design tokens. Vitest runs in `jsdom` with a smoke test, a router test, and an app-shell test. No database, no API sync, no backup yet — those start in PR 3.
  - Added: `package.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `index.html`, `src/main.ts`, `src/app.ts`, `src/router.ts`, `src/styles.css`, `src/views/{dashboard,browse,collection,binders,lots,wishlist,backup,settings}.ts`, `tests/{setup,smoke,router,app}.test.ts`, `.gitignore`.
  - Updated: `README.md` "Getting started" section now documents the live `npm` commands.
  - **Patch:** `TECH_STACK.md` "Initial scaffold" rewritten to match the actual PR 2 / PR 3 split — Dexie and `fake-indexeddb` install in PR 3, not PR 2. Added `engines` (`node >=20.19.0`, `npm >=10`) to `package.json` so a fresh clone fails fast on too-old toolchains; README updated to match.

- **PR 1 — Project foundation documents.** Locks the full requirements, technical stack, data model, backup format, dashboard spec, UI design spec, PR workflow, end-to-end user flows, and MVP acceptance criteria for the Pokemon TCG Tracker. No application code is added in this PR.
  - `README.md` — project overview, status, planned developer workflow.
  - `KRAVSPEC.md` — authoritative requirements, MVP scope, hard out-of-scope, user-data sanctity rules, binder/permer model, lot/bulk model, offline-first, backup MVP, audit log, CSV rules.
  - `TECH_STACK.md` — TypeScript strict, Vite vanilla-ts, Dexie, Vitest, npm, plain CSS; npm scripts and dev/test workflow; explicit exclusions.
  - `DATA_MODEL.md` — 11 IndexedDB stores, full TypeScript record types, soft delete, audit log, indexing, validators, schema versioning and migration principles.
  - `BACKUP_FORMAT.md` — `pokemon-tracker-backup-v1.json` structure, validation, replace-restore with auto pre-restore backup, schemaVersion handling, CSV format rules.
  - `DASHBOARD_SPEC.md` — seven dashboard sections, action-needed warnings, MVP exclusions.
  - `UI_DESIGN_SPEC.md` — design principles and per-page UI specification for Dashboard, Browse, Collection, Card detail, Binders, Lots, Wishlist, Backup, Settings; status badges, confirmation dialogs, search/sort defaults, accessibility minimum.
  - `PR_RULES.md` — branch and PR rules, scope control, user-data protection, backup safety, data-layer-before-UI rule, required PR checklist, forbidden changes, merge rule, and a one-time **bootstrap exception** for PR 1 (typecheck/test/build/app-startup are N/A until PR 2 lands the Vite + TypeScript shell).
  - `USER_FLOWS.md` — 14 end-to-end user flows.
  - `MVP_ACCEPTANCE.md` — concrete checklist for "v1 done".
  - `CHANGELOG.md` — this file.

### Notes
- No application source code yet. PR 2 will add the Vite + TypeScript app shell, npm scripts, and the Vitest test infrastructure.
- The branch for PR 1 is `docs/project-foundation-v1`.
