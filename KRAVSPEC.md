# KRAVSPEC — Pokemon TCG Tracker

Authoritative requirements for the project. All other documents elaborate on, but do not override, the rules in this file.

---

## 1. Project scope

A private, local-first browser app for tracking an English Pokemon TCG collection. Tools support both personal collecting and an informal reseller workflow (bulk lots, cost allocation, wishlist), but **the app is not a sales platform, accounting system, or business reporting tool**.

The app must be safe, searchable, easy to use, hard to corrupt, easy to back up, and useful for a real binder collection.

---

## 2. MVP scope

The first version (v1) covers all of the following, delivered as a sequence of focused PRs:

1. Sync sets and cards from pokemontcg.io and cache them in IndexedDB
2. Browse and search the cached cards (table-first, paginated, lazy-loaded images)
3. Add, edit, and soft-delete holdings with condition (raw or graded), finish, edition, quantity, manual value, tags, notes
4. Create binders (manually or from a set template) with 9- or 18-slot pages, page/slot tracking, status badges, and completion percentage
5. Maintain a wishlist with priority and target condition
6. Track bulk lots with three cost-allocation methods: equal, weighted by market price, manual
7. Show duplicates and missing-card lists per binder and per set
8. Dashboard with database health, sync status, backup reminders, and "action needed" warnings
9. Full JSON backup and restore with preview
10. CSV export for collection, missing cards, duplicates, wishlist, binder checklists
11. Audit log for important user-data events
12. Soft delete with restore for all user-owned records

The MVP is "done" when [MVP_ACCEPTANCE.md](MVP_ACCEPTANCE.md) is fully met.

---

## 3. Hard out-of-scope

The following are explicitly out of scope for the MVP and may not be added without prior written approval:

- Tax / accounting features
- Skatteetaten reports
- Business accounting logic
- Sales automation
- eBay / Cardmarket sales integration
- Cloud sync
- Login / accounts
- Backend server
- React, Vue, Svelte, Solid, or any other UI framework
- Tailwind, shadcn, or any other CSS framework
- Image upload / image storage in IndexedDB
- Japanese cards in MVP
- Sealed products in MVP
- AI pricing in MVP

This "hard out-of-scope" list applies to **application features delivered to end users** — not to local development/review tooling that runs on the developer's machine and never ships in the production bundle. See [PR_RULES.md §7 "Local development tooling exception"](PR_RULES.md#local-development-tooling-exception-2026-05-11) and [docs/governance/AI_SUPERVISOR_APPROVAL.md](docs/governance/AI_SUPERVISOR_APPROVAL.md) for the carve-out.

---

## 4. User data protection (sacred data)

The app must never delete, overwrite, or silently modify user-owned data.

**Permanent user data (must never be overwritten by API sync):**
- holdings
- binders
- binderSlots
- lots
- lotItems
- wishlist
- notes
- manual prices
- condition
- graded info
- tags
- auditLog
- settings

**Replaceable cache data:**
- sets
- cards
- API price cache

### Required behaviour
- Before any destructive operation: show confirmation, explain what will change, and create or offer a backup first when possible.
- All user-owned records use soft delete: `deletedAt: string | null`. Permanent delete is not allowed in MVP without explicit approval.
- API sync that fails or returns partial results must not delete or alter any cached cards/sets, and must never touch user-owned data.

---

## 5. Collection requirements

### Card identification
- Primary card identifier is the API's `card.id` (never name alone).
- Holdings reference cards by `cardId`. Variant fields on a holding: `finish`, `edition`, `language`.
- `finish`: `normal | holo | reverse_holo | non_holo | stamped | unknown`
- `edition`: `unlimited | first_edition | shadowless | unknown`
- The same card can have multiple holdings (e.g. raw NM, raw LP, PSA 9, reverse holo). They are shown as separate lines, not merged.
- Variant choice at add-time supports an `unknown` fallback. The app must not force perfect data on day one.
- Misprints / error cards are not separate global cards in MVP; they are captured by `holding.note` plus an optional `holding.specialVariant = true`.

### Condition and grading
- Raw conditions: `NM | LP | MP | HP | DMG | UNKNOWN`.
- Grading companies: `PSA | BGS | CGC | TAG | ACE | OTHER`.
- Grade is a number from 1.0 to 10.0.
- Graded holdings may store: gradingCompany, grade, certNumber, certUrl, gradedDate, note.
- Subgrades are not MVP. Photos are not MVP.

### Manual values and pricing
- The app must support manual estimated values per holding. **Manual value always wins over API value.**
- Every value must store its source: `valueSource: manual | tcgplayer | cardmarket | estimated | unknown`, plus `valueNote` and `valueUpdatedAt`.
- Display currency: NOK by default. Storage currency is whatever the user enters. Supported currencies: NOK, USD, EUR, PHP.
- Value priority for display: `manualEstimatedValue > tcgplayer.market > cardmarket.trend > unknown`.
- Graded card values are manual in MVP.

---

## 6. Binder / perme requirements

Binders are first-class data, not notes.

### Each binder must support
- name, description, binder type
- total pages
- slots per page: 9 or 18
- completion mode: `standard | master` (`grand_master` is documented as later scope)
- a list of slots with: page number, slot number, target card, optional assigned holding, status, note

### Binder slot statuses
`empty | wanted | owned | missing | ordered | duplicate | upgrade_needed`

### Binder completion logic
- Completion is calculated from `binderSlots`, not from holdings alone.
- A slot counts as **complete** only when:
  - `status === 'owned'`
  - `holdingId` is set
  - the referenced holding is not soft-deleted (`deletedAt === null`)
- Duplicates do not auto-complete binder slots; they must be explicitly assigned.
- Completion percentage = (completed slots) / (slots with `targetCardId !== null`).

### Set completion modes
- **Standard set:** one of each numbered card.
- **Master set:** one normal/holo + one reverse holo where applicable + secret rares.
- **Grand master set:** master + promos + stamped variants + special releases. Documented as later scope; the data model must support it.

### Create binder from set
The "create binder from a set" flow must support: set selection, completion mode (standard / master), slots per page (9 / 18), include reverse holo (yes/no), include secret rares (yes/no), preview of generated slot count, then create.

---

## 7. Lots / bulk requirements

Lots represent purchases of multiple cards. **There is no tax logic — cost allocation is for private overview only.**

### Allocation modes
- `equal` — total cost / number of cards
- `weighted_by_market_price` — cost distributed proportionally to market value
- `manual` — user sets price per card

**Default mode:** `weighted_by_market_price`.

### Behaviour
- A lot has a name, purchase date, total cost, currency, allocation method, notes.
- Adding cards to a lot creates `lotItems` and, when allocated, `holdings` with `lotId` set.
- The sum of allocated costs across the lot's holdings should approximately equal the lot's total cost. The UI must warn if it does not balance.
- Sale-from-specific-lot is not MVP.

---

## 8. Wishlist, missing, and duplicates

The app must surface "what to buy", "what to upgrade", and "what to trade" without external tools.

### Wishlist
- Per item: card, set, number, finish, priority, target condition, target price, status, note.
- Status: `wanted | ordered | received | cancelled`.
- Priority: `low | medium | high | grail`.
- Actions: move to collection, mark ordered, remove from wishlist.

### Missing cards
- Generated from binder slots where `status !== 'owned'` (or the assigned holding is soft-deleted).
- Exportable as CSV per binder, per set, and globally.

### Duplicates
- A duplicate is a holding that exceeds what is needed to fill the user's binder slots for that card+finish.
- The duplicate view groups by card+condition+location and shows total estimated value.

---

## 9. Offline-first

- After the first successful card sync, the app must work fully offline with cached data.
- API failures must not block app startup, must not delete cached data, and must not touch user-owned data.
- Last successful sync must always be visible.
- The app must never show a blank white screen on error. Error panels explain what failed, whether user data is safe, and what the user can do next.

---

## 10. Performance

- The app must handle 20,000+ cards and 5,000+ holdings without freezing the UI.
- Large lists use pagination or virtual rendering. Default page size 50; allowed sizes: 25, 50, 100.
- Card images are lazy-loaded. Failures fall back to placeholders.
- Searches are case-insensitive with whitespace trimming.

---

## 11. Storage and persistence

- Database: IndexedDB via Dexie.
- The app must call `navigator.storage.persist()` early to reduce the chance the browser evicts the database. Persistent storage is an additional safeguard, **not** a substitute for backup.
- localStorage may not be used for collection data. It may only hold settings small enough to lose without harm.
- The API key, if used, lives only in the IndexedDB `settings` store. It must never be in localStorage, never hardcoded, never committed, never logged, and never included in default JSON backups.

---

## 12. Backup and restore (MVP requirement)

- Backup is part of MVP. It is not a future feature.
- Format: `pokemon-tracker-backup-v1.json`. Schema documented in [BACKUP_FORMAT.md](BACKUP_FORMAT.md).
- Restore must show a preview (counts per table, exported-at, schemaVersion) before any write.
- Restore must reject backups with an unsupported future `schemaVersion` unless migration support exists.
- Full replace-restore must attempt to export the current database first (auto-backup). If pre-restore backup fails, the user must explicitly confirm before restore continues.
- Merge-restore is later scope.
- An invalid backup must be rejected safely without altering the database.

The dashboard must warn the user when:
- no backup has ever been created,
- the last backup is older than 7 days,
- the schema was upgraded since the last backup,
- more than 50 new holdings have been added since the last backup.

---

## 13. Audit log

Important user-data actions are recorded in an `auditLog` store. Logged actions include at minimum:
`holding_created`, `holding_updated`, `holding_soft_deleted`, `binder_created`, `card_moved_to_binder_slot`, `lot_created`, `backup_exported`, `backup_restored`, `manual_value_changed`, `schema_migration`, `sync_run`.

Each entry stores `{ id, action, entityType, entityId, message, createdAt }`.

---

## 14. CSV export

CSV export is part of MVP. Files: `collection.csv`, `binder-checklist.csv`, `missing-cards.csv`, `duplicates.csv`, `wishlist.csv`.

Format rules:
- Delimiter: `,`
- Encoding: UTF-8 (BOM optional for Excel compatibility)
- Dates: ISO 8601 (`YYYY-MM-DD` or full timestamp)
- Currency columns must always include the ISO currency code (NOK, USD, EUR, PHP)

Collectr / Dragon Shield / Excel imports are later scope.

---

## 15. UI requirements (high level)

The UI prioritizes data clarity over visual effects. Full per-page specification lives in [UI_DESIGN_SPEC.md](UI_DESIGN_SPEC.md). Summary:

- Desktop-first, mobile-readable.
- Search-first as the primary entry mode.
- Top navigation: Dashboard, Browse, Collection, Binders, Lots, Wishlist, Backup, Settings.
- Topbar: app name, database status, last sync, last backup, Sync button, Backup button.
- Status badges: `owned, missing, wanted, ordered, duplicate, upgrade_needed, raw, graded, backup_old, sync_failed, storage_not_persistent` — always with text, not colour alone.
- Confirmation dialogs are required for: soft delete, restore backup, reset database, clear binder, remove lot, change allocation method after holdings exist.
- Empty states explain what the user should do next; loading states show progress; error states explain whether data is safe.

---

## 16. Settings

Settings store: `pokemonTcgApiKey`, `preferredCurrency`, `defaultCondition`, `defaultBinderSlotsPerPage`, plus future UI preferences.

System metadata (separate `appMeta` store): `schemaVersion`, `appVersion`, `lastSyncAt`, `lastBackupAt`, `lastBackupHoldingCount`, `persistentStorageGranted`, `lastMigrationAt`.

---

## 17. Source of truth

When this document, [TECH_STACK.md](TECH_STACK.md), [DATA_MODEL.md](DATA_MODEL.md), [BACKUP_FORMAT.md](BACKUP_FORMAT.md), [DASHBOARD_SPEC.md](DASHBOARD_SPEC.md), [UI_DESIGN_SPEC.md](UI_DESIGN_SPEC.md), [PR_RULES.md](PR_RULES.md), [USER_FLOWS.md](USER_FLOWS.md), or [MVP_ACCEPTANCE.md](MVP_ACCEPTANCE.md) appear to disagree, this `KRAVSPEC.md` is authoritative. Conflicts must be resolved in a docs-only PR before any implementation PR depending on them is merged.
