# MVP_ACCEPTANCE — Pokemon TCG Tracker

The MVP is **accepted** when every item in this list is true at the same time on a real install. None of these items can be skipped or hand-waved.

---

## Application

- [ ] The app starts locally (`npm run dev`) with no console errors and no blank screen.
- [ ] `npm run typecheck` is green in strict mode.
- [ ] `npm test` is green for: schema migrations, backup round-trip, bulk allocation, pricing priority, soft-delete restore.
- [ ] `npm run build` produces a static `dist/` without errors.

## Database

- [ ] IndexedDB initializes through Dexie on first run.
- [ ] `appMeta.schemaVersion` exists and matches the running app.
- [ ] `navigator.storage.persist()` is requested early; the result is stored in `appMeta.persistentStorageGranted`.
- [ ] All 11 stores exist: `sets`, `cards`, `holdings`, `lots`, `lotItems`, `binders`, `binderSlots`, `wishlist`, `auditLog`, `settings`, `appMeta`.
- [ ] Schema migration tests cover at least one upgrade path.

## Card data

- [ ] The user can sync sets and cards from pokemontcg.io.
- [ ] After the first successful sync, the app works **offline** with cached data.
- [ ] An API failure does not delete cached cards or sets.
- [ ] An API failure does not change `appMeta.lastSyncAt`.
- [ ] The dashboard shows the last successful sync date.

## User-data sanctity

- [ ] API sync never modifies any of: `holdings`, `lots`, `lotItems`, `binders`, `binderSlots`, `wishlist`, `auditLog`, `settings`.
- [ ] User data survives a browser reload.
- [ ] No `localStorage` is used for collection data.
- [ ] All user-owned records support soft delete via `deletedAt`.
- [ ] Soft-deleted records can be restored.
- [ ] The `auditLog` records at minimum: holding created/updated/deleted, binder created, slot assigned, lot created, manual value changed, backup exported, backup restored, schema migration, sync run.

## Holdings

- [ ] The user can add raw and graded holdings, with finish, edition, language, quantity, optional purchase price, optional manual value, tags, note.
- [ ] The user can edit a holding.
- [ ] The user can soft-delete a holding (with confirmation) and restore it.
- [ ] Validation enforces: raw → `rawCondition` required; graded → `gradingCompany` + `grade` required; `grade ∈ [1.0, 10.0]`; `quantity ≥ 1`; manual value not negative.
- [ ] Manual value always wins over API value.
- [ ] Each holding stores `valueSource`, `valueNote`, `valueUpdatedAt`.

## Binders / permer

- [ ] The user can create a binder manually.
- [ ] The user can create a binder from a set, with completion mode `standard` or `master`, slots per page 9 or 18, and toggles for reverse holo / secret rares.
- [ ] The user can place a holding into a slot.
- [ ] The user can mark a slot as `wanted | owned | missing | ordered | duplicate | upgrade_needed | empty`.
- [ ] Binder completion percentage is computed from `binderSlots` (not from holdings alone), and a slot only counts as complete when `status === 'owned'`, `holdingId !== null`, and the referenced holding is not soft-deleted.

## Wishlist, missing, duplicates

- [ ] The user can add a wishlist item with priority and target condition.
- [ ] The user can change a wishlist item's status.
- [ ] The user can export a missing-cards list (CSV) per binder.
- [ ] The user can see and act on duplicates.

## Lots / bulk

- [ ] The user can create a lot with name, purchase date, total cost, currency, allocation method, notes.
- [ ] The user can add cards to a lot.
- [ ] The user can allocate a lot's cost using `equal`, `weighted_by_market_price`, or `manual`.
- [ ] Allocation creates holdings linked to the lot via `lotId`.
- [ ] If the sum of allocated costs does not match the lot's total, the UI shows a warning.

## Backup / restore

- [ ] The user can export a full JSON backup. The API key is excluded by default.
- [ ] The user can restore a JSON backup. A preview panel shows counts and `schemaVersion` before any write.
- [ ] Replace-restore attempts a pre-restore auto-backup first; if it fails, the user must confirm explicitly.
- [ ] Restore rejects an unsupported future `schemaVersion` with a clear message.
- [ ] An invalid backup file is rejected without altering the database.
- [ ] A round-trip test (export → wipe → restore) results in an identical database.

## CSV export

- [ ] The user can export `collection.csv`, `binder-checklist.csv`, `missing-cards.csv`, `duplicates.csv`, `wishlist.csv`.
- [ ] CSV files use UTF-8, `,` delimiter, ISO 8601 dates, and currency columns include a currency-code column.
- [ ] CSV files open in Excel without errors.

## Dashboard

- [ ] The dashboard shows: Database Health, Sync, Backup, Collection, Binders, Lots, Wishlist / Action Needed.
- [ ] The dashboard shows the **action needed** chips when the conditions in [DASHBOARD_SPEC §4](DASHBOARD_SPEC.md#4-warnings-action-needed) are met.
- [ ] The dashboard renders quickly on a database with 20 000+ cards and 5 000+ holdings.
- [ ] The dashboard does not include charts, tax/profit graphs, sales analytics, or AI valuation.

## UI

- [ ] The desktop layout has a left sidebar (Dashboard / Browse / Collection / Binders / Lots / Wishlist / Backup / Settings) and a topbar with sync / backup status and quick actions.
- [ ] Every page has a useful empty state.
- [ ] Every async operation shows a loading state.
- [ ] Errors explain (1) what failed, (2) whether user data is safe, (3) what to do next.
- [ ] Status badges include text — colour alone is never the indicator.
- [ ] All destructive actions (soft delete, restore backup, reset database, clear binder, remove lot, change allocation method after holdings exist) require confirmation.
- [ ] Search is case-insensitive and trims whitespace.
- [ ] Tab order, focus visibility, and form labels meet the accessibility minimum in [UI_DESIGN_SPEC §25](UI_DESIGN_SPEC.md#25-accessibility--minimum-bar).

## Out of scope (must NOT ship in MVP)

- Tax / accounting features.
- Skatteetaten reports.
- Sales automation.
- eBay / Cardmarket integration.
- Cloud sync, login, accounts, backend.
- React / Vue / Svelte.
- Tailwind / shadcn.
- User-uploaded images stored in IndexedDB.
- Japanese cards.
- Sealed products.
- AI pricing.

If any of the above ship in v1, the MVP is **not** accepted.

---

## How acceptance is verified

For each item, the verifier:

1. Performs the action in a real browser instance against a Vite production build (`npm run build && npm run preview`).
2. Confirms `npm run typecheck`, `npm test`, and `npm run build` are green on `main`.
3. Reads the [`auditLog`](DATA_MODEL.md) of the test database and confirms the expected entries appeared.
4. Performs the backup round-trip described above and verifies the resulting database against a known fixture.
5. Forces an API failure (e.g. block the domain in the browser) and confirms the app continues to work and reports cleanly.

Acceptance is recorded as a tag on `main` named `mvp` and noted in [CHANGELOG.md](CHANGELOG.md).
