# DASHBOARD_SPEC — Pokemon TCG Tracker

The dashboard is a thin, fast, database-driven control panel. **It is not a marketing surface.** Visual polish, charts, and trend graphs are out of scope for MVP.

---

## 1. Purpose

The dashboard answers, at a glance:

1. Is the database healthy?
2. Is the card data fresh?
3. Is my collection backed up?
4. What is my collection summary?
5. What is the state of my binders?
6. What is the state of my lots?
7. What needs my attention?

Every number on the dashboard is computed from IndexedDB. No external calls happen on the dashboard view.

---

## 2. Performance contract

- The dashboard must render in under 200 ms on a database with 20 000 cards and 5 000 holdings on a typical desktop machine.
- All counts and aggregates are computed inside Dexie transactions or from cached aggregates in `appMeta` — never by loading every record into memory.
- The dashboard uses no animations beyond a simple fade-in on first paint.

---

## 3. The seven sections

Each section is a card in a simple grid. The order below is the order they appear top-to-bottom on desktop.

### Section 1 — Database Health

| Field | Source |
|---|---|
| Database status | `OK` / `Initializing` / `Error` |
| Schema version | `appMeta.schemaVersion` |
| Storage persistence | `appMeta.persistentStorageGranted` (yes / no, with action button when no) |
| Cards in cache | `cards.count()` |
| Holdings in collection | `holdings.where('deletedAt').equals(null).count()` |

If schema version mismatches the running app, this section is the **only** thing rendered until the user runs the migration prompt.

### Section 2 — Sync

| Field | Source |
|---|---|
| Last successful sync | `appMeta.lastSyncAt` (or "Never") |
| Sets cached | `sets.count()` |
| Cards cached | `cards.count()` |
| API status | last sync result: `OK` / `Failed: <short reason>` / `Rate-limited (retry after Xs)` |

Action button: **Sync now**. If a sync is running, the button is disabled and a progress bar appears.

### Section 3 — Backup

| Field | Source |
|---|---|
| Last backup | `appMeta.lastBackupAt` (or "Never") |
| Holdings at last backup | `appMeta.lastBackupHoldingCount` |
| Backup warnings | see §4 |

Action buttons: **Export full backup**, **Restore from file**.

### Section 4 — Collection

| Field | Source |
|---|---|
| Total holdings | sum of `holdings.quantity` where not deleted |
| Unique cards owned | distinct `cardId` count where holdings exist and not deleted |
| Raw cards | holdings where `conditionType === 'raw'` |
| Graded cards | holdings where `conditionType === 'graded'` |
| Holdings missing condition | raw holdings with `rawCondition === 'UNKNOWN'` or null |
| Holdings missing manual value | holdings where `valueSource === 'unknown'` and `estimatedValue === null` |

### Section 5 — Binders

| Field | Source |
|---|---|
| Total binders | not deleted |
| Active binder completion | `binders.where(...)` returns the most recently updated; completion % uses [`KRAVSPEC §6 binder completion logic`](KRAVSPEC.md#binder-completion-logic) |
| Missing cards in active binder | slots where `status !== 'owned'` or assigned holding is soft-deleted |
| Cards not assigned to any binder | holdings without a `binderSlots.holdingId` reference |

### Section 6 — Lots / Bulk

| Field | Source |
|---|---|
| Lots | not deleted |
| Total lot purchase value | sum of `lots.totalCost`, grouped by currency |
| Unallocated lot items | `lotItems` where `holdingId === null` and not deleted |

### Section 7 — Wishlist / Action Needed

| Field | Source |
|---|---|
| Wishlist count | `wishlist.where('status').equals('wanted')` |
| Ordered cards | `wishlist.where('status').equals('ordered')` |
| Duplicates | aggregated from `holdings` exceeding the binder demand for the same card+finish |
| Upgrade-needed | holdings where any `binderSlots.status === 'upgrade_needed'` references them |

---

## 4. Warnings ("action needed")

Every dashboard render evaluates the rules below and renders a stack of warning chips at the top of the dashboard, above the seven sections. Each chip has a short title, a one-line explanation, and (where relevant) a primary action button.

| Trigger | Chip title | Severity |
|---|---|---|
| `appMeta.lastBackupAt` is null or older than 7 days | **Backup overdue** | warning |
| `appMeta.persistentStorageGranted === false` | **Storage not persistent** | warning |
| Last sync failed | **Sync failed** | warning |
| `appMeta.schemaVersion` was upgraded since last backup | **Schema upgraded since last backup** | warning |
| > 50 holdings added since `lastBackupAt` | **Many new holdings since last backup** | warning |
| Holdings with `valueSource === 'unknown'` exist | **Holdings missing value** | info |
| Holdings with `rawCondition === 'UNKNOWN'` exist | **Holdings missing condition** | info |
| Lot items not yet allocated to holdings | **Unallocated lot cost** | info |
| Binder has slots in `wanted` / `missing` / `upgrade_needed` | **Binder incomplete** | info |

Severity drives only colour and ordering (warnings before info), not behaviour.

---

## 5. Status badges used on the dashboard

The dashboard reuses the project-wide status badges (defined in [UI_DESIGN_SPEC.md](UI_DESIGN_SPEC.md)). The dashboard-specific extras:

- `backup_old` — shown when `lastBackupAt` is older than 7 days.
- `sync_failed` — shown next to the sync section when the last sync failed.
- `storage_not_persistent` — shown when `persistentStorageGranted === false`.

All badges include text, never colour alone.

---

## 6. What the dashboard must NOT show in MVP

These items are explicitly out of scope for the dashboard MVP:

- Advanced charts of any kind (no candlesticks, no sparkline trends, no ratio donuts).
- Tax / profit graphs.
- Price-history graphs.
- Sales analytics (revenue, fees, channel breakdowns).
- Market-timing suggestions ("good time to sell").
- AI-generated valuations or recommendations.
- Banner ads, marketing copy, hero images, or cosmetic illustrations.
- Per-card "watched" alerts.

If any of the above are useful later, they belong in a separate, opt-in view, not on the dashboard.

---

## 7. Keyboard and accessibility on the dashboard

- All action buttons are reachable by Tab in document order.
- Focus is visible.
- Warning chips are keyboard-activatable when their primary action is non-trivial.
- Labels do not rely on colour alone — every status carries text.
