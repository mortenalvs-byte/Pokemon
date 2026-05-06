# USER_FLOWS — Pokemon TCG Tracker

End-to-end user flows that the MVP must support. Each flow is described as the user sees it, with the data effects called out so that engineers know what each step touches.

The flows are numbered. They are not necessarily run in this order.

---

## Flow 1 — First startup

**Goal:** Get a brand-new install into a usable state without losing any future data.

1. The user opens the app for the first time.
2. The app calls `navigator.storage.persist()`. The browser's permission UI may appear. Result is stored in `appMeta.persistentStorageGranted`.
3. The app initializes the IndexedDB database with the current schema. `appMeta.schemaVersion` is written. An audit entry `schema_migration` is appended.
4. The dashboard renders an empty state for every section, with two warning chips: **"Storage not persistent"** if the request was denied, and **"No backup yet"**.
5. A first-run notice in the Sync section invites the user to either provide a pokemontcg.io API key (Settings → API) or proceed without one (lower rate limit).

**Data effects:** `appMeta` is populated. No user data is created.

---

## Flow 2 — First API sync

**Goal:** Download the card and set database from pokemontcg.io and store it locally.

1. From the dashboard or Browse view, the user clicks **Sync now**.
2. The app reads `settings.pokemonTcgApiKey` (may be empty).
3. The app calls pokemontcg.io: first all sets (paginated), then cards (paginated, page-by-page).
4. A loading panel reports progress: "Syncing cards… Fetched X / Y. Do not close this tab until sync is complete."
5. On success: `sets` and `cards` are populated; `appMeta.lastSyncAt` is updated; an audit entry `sync_run` is appended.
6. On HTTP 429: the app waits per `Retry-After` and retries with backoff. A user-visible chip says **"Rate-limited (retry in Xs)"**.
7. On other failures: cached data is left untouched, `lastSyncAt` is **not** updated, and an audit entry `sync_failed` is appended. The error panel explains "Your collection data is safe."

**Data effects:** `sets`, `cards`, `appMeta`, `auditLog`. No user-owned store is touched.

---

## Flow 3 — Add a card to collection

**Goal:** Record a card the user owns.

1. The user searches for the card in Browse, or opens its detail view.
2. The user clicks **Add to collection**.
3. The Add Holding form opens, prefilled with the card. Defaults: condition `defaultCondition`, currency `preferredCurrency`, finish `unknown`, edition `unknown`, quantity `1`.
4. The user fills in the fields. Validation enforces [DATA_MODEL §10](DATA_MODEL.md#10-defaults-and-validators).
5. The user clicks **Save**.
6. A new `HoldingRecord` is created with a fresh UUID. An audit entry `holding_created` is appended.

**Data effects:** `holdings`, `auditLog`.

---

## Flow 4 — Edit holding condition / value

**Goal:** Update an existing holding's grade, value, or notes.

1. From Collection or Card Detail, the user opens an existing holding.
2. The user changes one or more fields (e.g. raise grade, set manual value, add a tag).
3. The user clicks **Save**. Validation runs; on errors, the form blocks save.
4. The `HoldingRecord` is updated. `updatedAt` is bumped. An audit entry `holding_updated` (and, when applicable, `manual_value_changed`) is appended.

**Data effects:** `holdings`, `auditLog`.

---

## Flow 5 — Create a binder

**Goal:** Create a binder either manually or from a set template.

### 5a — Manual

1. From Binders, the user clicks **Create binder**.
2. The user enters: name, description, binder type, total pages, slots per page (9 or 18), completion mode (`standard` or `master`).
3. On Save, a new `BinderRecord` is created and the corresponding empty `binderSlots` are generated for every page × slot. All slots default to `status='empty'`, `targetCardId=null`, `holdingId=null`.

### 5b — From a set (template)

1. From Binders → **Create binder from set**, the user picks a set.
2. The user picks completion mode (`standard` / `master`), slots per page (9 / 18), and toggles for "include reverse holo" and "include secret rares".
3. The app shows a preview: binder name, target card count, page count, slots per page, completion mode.
4. On confirm, a new `BinderRecord` is created with `sourceSetId` set, and `binderSlots` are generated with `targetCardId` set per the chosen rules.

**Data effects (both paths):** `binders`, `binderSlots`, `auditLog` (`binder_created`).

---

## Flow 6 — Place a card in a binder slot

**Goal:** Mark that a specific holding fills a specific binder slot.

1. From Binder Detail (page/slot view or checklist view), the user clicks an empty or `wanted` slot.
2. A picker offers holdings whose `cardId` matches the slot's `targetCardId` (and whose `deletedAt` is null), with finish/edition shown so the user can pick the right copy.
3. The user picks a holding (or chooses **None** to set the slot status without assigning).
4. The slot's `holdingId` is updated; `status` becomes `owned`; `updatedAt` is bumped. Audit entry `binder_slot_assigned`.

**Edge case:** If the user assigns a holding that already fills another slot, the picker warns and asks for confirmation.

**Data effects:** `binderSlots`, `auditLog`.

---

## Flow 7 — Create a wishlist item

**Goal:** Record that the user wants a specific card.

1. From Browse or Card Detail, the user clicks **Add to wishlist**.
2. A small form asks for: priority (`low` / `medium` / `high` / `grail`), target condition (raw condition or null), target price + currency, finish, note.
3. On Save, a new `WishlistRecord` is created with `status='wanted'`. Audit entry `wishlist_item_created`.

**Data effects:** `wishlist`, `auditLog`.

---

## Flow 8 — Create a lot / bulk purchase

**Goal:** Record that the user bought a batch of cards together.

1. From Lots → **Create lot**, the user enters: name, purchase date, total cost, currency, allocation method (default `weighted_by_market_price`), notes.
2. The lot is created with no items. Audit entry `lot_created`.
3. The user adds cards to the lot one by one or in bulk: each addition creates a `lotItemRecord` with the chosen card, finish, edition, condition, and quantity.

**Data effects:** `lots`, `lotItems`, `auditLog`.

---

## Flow 9 — Allocate lot cost

**Goal:** Distribute the lot's total cost across its items and create the corresponding holdings.

1. From the Lot Detail view, the user clicks **Allocate costs**.
2. The app computes per-item allocated cost based on `lots.allocationMethod`:
   - `equal` — `totalCost / sum(lotItems.quantity)` per unit.
   - `weighted_by_market_price` — proportional to each item's `marketEstimate`. Items with no estimate fall back to `equal` for the residual.
   - `manual` — uses each item's `manualPriceOverride`. Sum of overrides must match `totalCost` ± a small tolerance, or the UI blocks allocation.
3. The preview shows the distribution. The user confirms.
4. For each lot item, a `HoldingRecord` is created with `lotId` set and `purchasePrice = allocatedCost / quantity`. The lot item's `holdingId` is set. Audit entry `lot_allocated`.
5. If sum of `holdings.purchasePrice` does not match `lot.totalCost`, a warning chip appears on the Lot Detail view ("Allocation does not balance").

**Data effects:** `holdings`, `lotItems`, `auditLog`.

---

## Flow 10 — Export backup

**Goal:** Save a JSON snapshot of the entire database to a local file.

1. From the Backup view (or topbar), the user clicks **Export full backup**.
2. The app reads every store and builds a `BackupFile` according to [BACKUP_FORMAT §2](BACKUP_FORMAT.md#2-required-structure). The API key is excluded by default.
3. The browser downloads the file (`pokemon-tracker-backup-v1-<timestamp>.json`).
4. `appMeta.lastBackupAt` and `appMeta.lastBackupHoldingCount` are updated. Audit entry `backup_exported`.

**Data effects:** `appMeta`, `auditLog`. No user data altered.

---

## Flow 11 — Restore backup

**Goal:** Replace the local database with the contents of a backup file.

1. From the Backup view, the user clicks **Restore from file** and chooses a `.json`.
2. The app validates the file (see [BACKUP_FORMAT §4](BACKUP_FORMAT.md#4-validation-rules-run-before-any-read-of-dataholdings-etc)).
3. A preview panel shows file name, exported-at, schema version, counts, warnings.
4. Three options: **Cancel**, **Replace**, **Merge** (disabled in MVP).
5. On **Replace**:
   - The app first attempts to export the current database to `pre-restore-backup-<timestamp>.json`. If that fails, the user must explicitly confirm to continue.
   - In a single Dexie transaction, all stores are cleared and repopulated from the backup. The `pokemonTcgApiKey` setting is preserved (not overwritten by the backup) unless the user opted in.
   - `appMeta` is updated. Audit entry `backup_restored`.
6. On any error before commit, Dexie rolls back; the database is unchanged; the error explains why.

**Data effects:** Every store. The pre-restore auto-backup is the safety net.

---

## Flow 12 — Recover from API error

**Goal:** Continue using the app when the network or pokemontcg.io is unavailable.

1. The user clicks **Sync now**, but the request fails (network down, 5xx, DNS, etc.).
2. The error panel shows: "Could not sync cards. Your collection data is safe. Last successful sync: <date>. You can continue using cached data."
3. The dashboard chip **Sync failed** appears next to the Sync section.
4. All other features (Browse against cached cards, Collection, Binders, Lots, Wishlist, Backup, Settings) continue to function unchanged.

**Data effects:** `auditLog` only (`sync_failed`).

---

## Flow 13 — Find missing cards

**Goal:** Generate a list of cards the user still needs in a binder, a set, or globally.

1. From Binder Detail, the user clicks **Export missing list**. The CSV contains every slot where `status !== 'owned'` (or the assigned holding is soft-deleted).
2. From Browse, the user toggles **Filter: missing only**. The browse table now shows only cards that appear as a missing slot in any binder.
3. The Wishlist also surfaces wishlist items as a "what to buy" list, separate from the binder-driven missing list.

**Data effects:** None (read-only operation).

---

## Flow 14 — Find duplicates

**Goal:** See which cards the user owns more copies of than the binder slots demand.

1. From the Collection view, the user toggles **Filter: duplicates**, or visits a dedicated **Duplicates** view (linked from the dashboard's Wishlist / Action Needed section).
2. The view groups by `cardId` + `finish` + `condition`, showing total quantity owned vs total binder demand for that card+finish, and binder location of the "primary" copy.
3. The user can mark a duplicate **for_sale** or **for_trade** by setting the `status` field on the holding.

**Data effects:** Read-only by default. Status changes update `holdings` and append `holding_updated` audit entries.
