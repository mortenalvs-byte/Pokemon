# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once a versioned release lands.

---

## [Unreleased]

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
