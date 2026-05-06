# UI_DESIGN_SPEC — Pokemon TCG Tracker

The UI prioritizes **data clarity** over visual effects. This document covers global design principles, layout, and the page-by-page specification for every MVP view.

---

## 1. Design goals

- Fast search.
- Clear tables.
- Readable card and binder status.
- Simple dashboard cards.
- Obvious warnings.
- Backup and restore are easy to find.
- Low visual noise.

## 2. Style

- Desktop-first. Mobile must remain readable but is not the optimization target.
- Clean and practical. Compact but readable. Table-heavy.
- Minimal animation. No decorative effects that slow the user down.

## 3. Colour usage

- Neutral background, strong contrast.
- **Warning colour** for backup / storage / API problems.
- **Success colour** for database / sync / backup OK.
- **Status badges** for `owned`, `missing`, `wanted`, `ordered`, `duplicate`, `upgrade_needed`, etc. (full list in §16).
- Colours are defined as CSS variables (`--color-bg`, `--color-fg`, `--color-warning`, `--color-success`, `--color-accent`, `--color-border`, …). Theming beyond two or three semantic variables is **not** MVP.

## 4. Layout

- Left **sidebar** navigation on desktop. Top navigation collapses sidebar on narrow viewports.
- **Topbar** with: app name, database status, last sync, last backup, **Sync** button, **Backup** button.
- Main content area for the current view.
- Dashboard cards in a simple grid. Large lists rendered as paginated tables.
- Card images small in tables; larger only in the card-detail view.
- No marketing-style hero sections. No decorative animations in MVP.

### Sidebar

```
Dashboard
Browse
Collection
Binders
Lots
Wishlist
Backup
Settings
```

### Topbar

```
[App name]   [DB: OK]   [Sync: 2026-05-06 14:30]   [Backup: 2 days ago]   [Sync] [Backup]
```

If a value is bad (no backup, sync failed, storage not persistent) the value renders as a warning chip rather than plain text.

## 5. Typography

- System font stack (`system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`).
- Tables use a compact line-height and a body size (≥ 14 px) that stays readable at desktop zoom.
- Section headings are clearly distinguished from body copy.
- Important collection data is never set in tiny type.

## 6. Buttons

- **Primary actions:** Add, Save, Export backup, Sync.
- **Destructive actions:** visually separated from primaries (e.g. red border, subdued background) and require a confirmation dialog (see §17).
- **Backup / export actions** must always be easy to find — they live both in the topbar and in the Backup view.
- Buttons have readable text labels. Icon-only buttons are allowed only with an `aria-label` and a visible tooltip.

## 7. What the UI must NOT include in MVP

- Heavy animations.
- Large hero banners.
- Complex chart layouts.
- Card-image grid as the **only** browse mode (a grid view may exist but the default is table-first).
- Theme system beyond a small set of CSS variables.

---

## 8. Empty states

Every page must have an empty state that explains what the user should do next.

| Page | Empty state copy | Primary action |
|---|---|---|
| Browse (no sync yet) | "No cards synced yet. Run first sync to download Pokemon TCG card data." | **Start first sync** |
| Collection | "No holdings yet." | **Add your first card** |
| Binders | "No binders yet." | **Create your first binder** |
| Lots | "No lots yet." | **Create your first lot** |
| Wishlist | "No wishlist items." | **Add cards you are looking for** |
| Backup | "No backup yet." | **Export your first backup** |

Empty states are not decorative pages. They include the action that will move the user out of the empty state.

## 9. Loading states

Every async operation shows visible progress.

- **First sync:** progress like *"Syncing cards… Fetched 4,500 / 18,000 cards. Do not close this tab until sync is complete."*
- **Card search:** spinner + "Searching…" until results appear.
- **Backup export:** "Preparing backup… Holding count: X."
- **Restore validation:** "Validating backup file…"
- **Binder template generation:** "Building binder slots…"
- **Lot allocation:** "Allocating cost across N cards…"

Long operations must be cancellable when cancelling cannot corrupt data.

## 10. Error states

Error messages must answer three questions:

1. **What failed?**
2. **Is my data safe?**
3. **What can I do next?**

Example:

> Could not sync cards.
> Your collection data is safe.
> Last successful sync: 2026-05-06.
> You can continue using cached data.

The app never shows a blank white screen on error. If the database is unreadable, the app shows an error panel with the option to download a copy of the underlying IndexedDB if the platform allows.

---

## 11. Browse view

**Purpose:** Search and inspect every cached Pokemon card, then add the chosen card to collection, wishlist, or a binder.

**Required:**
- Search by name.
- Search by card number.
- Filter by set.
- Filter by rarity.
- Filter by owned / not owned.
- Filter by missing / wishlist.
- Sort by set number, name, rarity, value.
- Pagination.
- Thumbnail image per row.
- **Default mode is a table.** A grid view may be offered as a toggle but never replaces the table.

**Quick actions per row:**
- Add to collection
- Add to wishlist
- View details

## 12. Collection view

**Purpose:** Show everything the user owns, with condition, value, binder location, lot source, and notes.

**Columns:**
Image · Name · Set · Number · Finish · Edition · Condition / Grade · Quantity · Binder · Page / Slot · Lot · Manual value · Tags · Updated · Actions

**Filters:**
Raw / graded · Condition · Set · Binder · Missing binder slot · Duplicate · High value · To grade · For sale/trade · Missing value · Missing condition

**Actions:**
- Edit holding
- Move to binder (opens binder slot picker)
- Duplicate holding
- Soft delete
- Restore (when the row is soft-deleted)

## 13. Card detail view

**Required:**
- Large image
- Card name, set, number, rarity
- Available finishes (when known)
- API price data (when present in the cached card record)
- All user holdings for this card — shown as separate rows (raw NM, raw LP, PSA 9, reverse holo, duplicate, …)
- Binder locations
- Wishlist status
- **Add holding** button

The same card can have several holdings. The card detail view never merges them.

## 14. Add / Edit holding form

**Fields:**
Card · Quantity · Condition type (raw / graded) · Raw condition · Grading company · Grade · Cert number · Finish · Edition · Purchase price · Purchase currency · Manual estimated value · Value currency · Value source · Lot · Binder slot · Tags · Note

**Validation rules:**
- If `conditionType === 'raw'`, `rawCondition` is required.
- If `conditionType === 'graded'`, `gradingCompany` and `grade` are required.
- `grade ∈ [1.0, 10.0]`.
- `quantity ≥ 1`.
- Manual value cannot be negative.

Field-level errors render inline near the field. The Save button is disabled while the form has errors.

## 15. Binder views

### 15.1 Binder list

**Columns:**
Binder name · Completion % · Owned / target cards · Missing count · Slots per page · Completion mode · Updated · Actions

### 15.2 Binder detail (two views)

#### Page / slot view
Renders the active binder one page at a time, with the slot grid (9 or 18 cells). Each cell shows: page number, slot number, target card, assigned holding, status badge, condition, small image.

#### Table / checklist view
A flat sortable table: card name, set number, finish, target status, owned status, page, slot, condition, note.

**Actions:**
- Assign holding to slot
- Mark wanted
- Mark ordered
- Mark missing
- Mark upgrade_needed
- Clear slot
- Move slot
- Export missing list (CSV)

**Rule:** completion is calculated from `binderSlots`, not from holdings alone. See [KRAVSPEC §6 binder completion logic](KRAVSPEC.md#binder-completion-logic).

### 15.3 Create binder from set — flow

1. Select set.
2. Select completion mode: **standard** or **master**.
3. Select slots per page: 9 or 18.
4. Include reverse holo where applicable: yes / no.
5. Include secret rares: yes / no.
6. **Preview** generated slot count.
7. **Create binder.**

The preview lists: binder name, number of target cards, number of pages, slots per page, completion mode.

## 16. Lots view

### Lot list

**Columns:**
Lot name · Purchase date · Total cost · Currency · # cards · Allocation method · Allocated amount · Unallocated amount · Actions

### Lot detail

For each card in the lot: card, market estimate, allocated cost, manual override, holding created (yes / no).

**Actions:**
- Add cards to lot
- Allocate costs
- Create holdings
- Edit allocation
- Export lot

**Rule:** sum of allocated costs ≈ lot total cost. The UI shows a warning chip when the totals do not balance.

## 17. Wishlist view

**Columns:**
Card · Set · Number · Finish · Priority · Target condition · Target price · Status · Note · Actions

**Status values:** `wanted | ordered | received | cancelled`
**Priority values:** `low | medium | high | grail`

**Actions:**
- Move to collection
- Mark ordered
- Remove from wishlist

## 18. Backup / Restore view

**Backup section shows:**
Database status · Last backup date · Backup warnings · **Export full backup** · **Restore from file** · Plain-language explanation of what a backup contains.

**Restore preview shows:**
Backup file name · Exported at · Schema version · Cards count · Holdings count · Binders count · Lots count · Wishlist count · Audit log count · Any cross-reference warnings.

**Replace warning copy (always shown before a replace restore):**

> Full restore will replace the current local database.
> The app will attempt to export a backup of the current database first.

## 19. Settings view

Sections, in order:

- **API**
  - Pokemon TCG API key (input, **Test** button, last status)
- **Storage**
  - Persistent storage granted (yes / no)
  - **Request persistent storage** button
  - Database size (when the browser exposes it)
  - Schema version
- **Defaults**
  - Default condition
  - Default binder slots per page
- **Currency**
  - Preferred currency (NOK / USD / EUR / PHP)
- **Danger Zone**
  - **Reset local database** (requires explicit confirmation; auto-backup first)
  - **Import full backup** (alias of Backup → Restore)
- **About**
  - App version
  - Schema version
  - Link to repo

The Danger Zone is visually separated and always at the bottom of the page.

---

## 20. Status badges (consistent vocabulary)

Used everywhere a record carries one of these states:

`owned · missing · wanted · ordered · duplicate · upgrade_needed · raw · graded · backup_old · sync_failed · storage_not_persistent`

Badges always include **text** — colour alone is never the indicator. Each badge has a tooltip explaining what it means.

---

## 21. Confirmation dialogs

Required for:
- Soft delete a holding
- Restore a backup
- Reset local database
- Clear a binder
- Remove a lot
- Change allocation method **after** holdings have already been created from the lot

Each dialog states, in plain text:
- What will happen
- What data is affected (counts where useful)
- Whether it can be restored
- Whether a backup will be created first

---

## 22. Search behaviour

- Search matches against: card name, set name, card number, tags, and notes (where relevant).
- Searches are **case-insensitive**.
- Whitespace is trimmed.
- Fuzzy / approximate search is **not** MVP.

## 23. Sort defaults

| View | Default sort |
|---|---|
| Browse | set release date desc, then card number asc |
| Collection | `updatedAt` desc |
| Binder detail | `pageNumber` asc, then `slotNumber` asc |
| Wishlist | `priority` desc, then `createdAt` desc |
| Lots | `purchaseDate` desc |

## 24. Action-needed rules (dashboard warnings)

(Also listed in [DASHBOARD_SPEC.md §4](DASHBOARD_SPEC.md). Re-listed here so UI engineers do not have to cross-reference.)

- No backup ever made.
- Last backup older than 7 days.
- Storage persistence not granted.
- Last API sync failed.
- Holdings missing condition.
- Holdings missing manual value.
- Holdings not assigned to any binder.
- Binder slots missing cards.
- Lots with unallocated cost.

---

## 25. Accessibility — minimum bar

- Every button has a readable text label or `aria-label`.
- The UI never relies on colour alone to convey status — text and badge labels do that.
- Status badges include text.
- Keyboard focus is always visible.
- Table text is readable at the default browser zoom.
- Forms have visible labels (no placeholder-only labelling).
- Tab order follows the visible reading order.

Full WCAG conformance is not an MVP target, but these basics are mandatory.
