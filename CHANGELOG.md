# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once a versioned release lands.

---

## [Unreleased]

### Added
- **PR 2 — Vite + TypeScript app shell + Vitest.** The first code lands. Vite (vanilla-ts) is the build tool, TypeScript runs in strict mode with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` enabled. A simple hash-based router wires up eight stub views (Dashboard, Browse, Collection, Binders, Lots, Wishlist, Backup, Settings). The topbar and left sidebar match the layout described in `UI_DESIGN_SPEC.md`. CSS variables define the design tokens. Vitest runs in `jsdom` with a smoke test, a router test, and an app-shell test. No database, no API sync, no backup yet — those start in PR 3.
  - Added: `package.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `index.html`, `src/main.ts`, `src/app.ts`, `src/router.ts`, `src/styles.css`, `src/views/{dashboard,browse,collection,binders,lots,wishlist,backup,settings}.ts`, `tests/{setup,smoke,router,app}.test.ts`, `.gitignore`.
  - Updated: `README.md` "Getting started" section now documents the live `npm` commands.

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
