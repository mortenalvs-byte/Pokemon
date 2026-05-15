# Pokemon TCG Tracker

A private, local-first browser app for tracking an English Pokemon TCG collection — physical binders, raw and graded cards, bulk lots, wishlists and missing cards — with safe local backup and restore.

**Status:** App shell. Vite + TypeScript + Vitest are set up; the layout, navigation, and view stubs are in place. Database, sync, and feature work begin in PR 3.

## What this is

This is a personal collection tool, not a marketplace, not a sales platform, not a tax/accounting product. Every piece of data lives in your browser's IndexedDB. The card database is downloaded once from [pokemontcg.io](https://pokemontcg.io) and updated on demand. Your collection — holdings, binders, lots, wishlist, manual prices, notes, tags — is permanent user data and is never overwritten by API sync.

## Core features (MVP)

- Sync the card and set database from pokemontcg.io
- Browse and search cards (table-first, paginated, lazy-loaded images)
- Track holdings with condition (raw NM/LP/MP/HP/DMG or graded PSA/BGS/CGC/TAG/ACE/OTHER), finish, edition, quantity, manual value, tags, notes
- First-class binder / perme management with page/slot tracking, status badges, and completion percentage
- Build binders from a set with one click (Standard or Master Set mode)
- Track bulk lots with three cost-allocation methods (equal, weighted by market price, manual)
- Wishlist and missing-card lists per binder and per set
- Dashboard with database health, sync status, backup reminders, and "action needed" warnings
- Full JSON backup and restore with preview
- CSV export for collection, missing cards, duplicates, wishlist, binder checklists

## Out of scope (will not be built unless explicitly approved)

Tax/accounting features, Skatteetaten reports, business accounting, sales automation, eBay/Cardmarket sales integration, cloud sync, login/accounts, backend server, React/Vue/Svelte, Tailwind/shadcn, image upload/storage in MVP, Japanese cards in MVP, sealed products in MVP, AI pricing in MVP.

## Core principle

> The database is more important than the dashboard.

The app must be safe, searchable, easy to use, hard to corrupt, easy to back up, and useful for a real binder collection. Visual polish comes after the data is locked down.

## User data is sacred

User-owned data — holdings, binders, binderSlots, lots, lotItems, wishlist, notes, manual prices, condition, graded info, tags, auditLog, settings — is permanent and must never be overwritten by API sync. The card database (sets, cards, API price cache) is replaceable. Soft delete is used for all user-owned records; permanent delete is not allowed in MVP.

## Getting started

```bash
# Clone and install
git clone https://github.com/mortenalvs-byte/Pokemon.git
cd Pokemon
npm install

# Run the app locally with hot reload (defaults to http://localhost:5173)
npm run dev

# Type-check, test, and build
npm run typecheck    # tsc --noEmit (strict mode)
npm test             # run Vitest once
npm run test:watch   # watch mode
npm run test:ui      # interactive Vitest UI in the browser
npm run build        # tsc + Vite production build into dist/
npm run preview      # serve the production build locally
```

Node.js **>= 20.19.0** and npm **>= 10** are required (enforced via `engines` in `package.json`).

The app shell is in place but no database, sync, or features yet. Each navigation entry currently shows a placeholder explaining which PR will fill it in.

## Project documents

- [KRAVSPEC.md](KRAVSPEC.md) — full requirements, MVP scope, out-of-scope
- [TECH_STACK.md](TECH_STACK.md) — locked technical choices and dev/test workflow
- [DATA_MODEL.md](DATA_MODEL.md) — IndexedDB stores, TypeScript types, soft delete, audit log
- [BACKUP_FORMAT.md](BACKUP_FORMAT.md) — JSON backup file format, restore behavior, CSV rules
- [DASHBOARD_SPEC.md](DASHBOARD_SPEC.md) — dashboard sections, warnings, MVP exclusions
- [UI_DESIGN_SPEC.md](UI_DESIGN_SPEC.md) — design principles and page-by-page UI specification
- [PR_RULES.md](PR_RULES.md) — branching, PR scope, checklists, forbidden changes
- [USER_FLOWS.md](USER_FLOWS.md) — 14 end-to-end user flows
- [MVP_ACCEPTANCE.md](MVP_ACCEPTANCE.md) — what "v1 done" means
- [CHANGELOG.md](CHANGELOG.md) — release log
- [docs/DESKTOP_APP.md](docs/DESKTOP_APP.md) — Tauri v2 desktop shell: prerequisites, `desktop:dev` / `desktop:build` / `desktop:check`, Windows notes

## Technical stack

TypeScript (strict), Vite (vanilla-ts template), Dexie over IndexedDB, Vitest, plain CSS with CSS variables, npm. No frontend framework. No backend. See [TECH_STACK.md](TECH_STACK.md) for rationale.
