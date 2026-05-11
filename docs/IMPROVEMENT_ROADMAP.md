# Pokemon TCG Tracker — System Audit & Improvement Roadmap

**Date:** 2026-05-11
**Author:** AI-supervised audit (4 parallel read-only Explore agents + synthesis)
**Status:** Draft for operator review. After merge, this document is consumed by `scripts/ai-supervisor/discover-tasks.mjs` as the canonical task source (alongside [docs/PR30_CLEANUP_ROADMAP.md](PR30_CLEANUP_ROADMAP.md)).

---

## 1. Executive summary

### What the audit covered
- Read every binder, lot, and holdings file (data model + service layer + UI flow + tests).
- Cross-referenced current code against [MVP_ACCEPTANCE.md](../MVP_ACCEPTANCE.md), [KRAVSPEC.md](../KRAVSPEC.md), [DATA_MODEL.md](../DATA_MODEL.md), [BACKUP_FORMAT.md](../BACKUP_FORMAT.md), [PR_RULES.md](../PR_RULES.md).
- Mapped 11 new operator-stated requirements (large-collection personal use, set-scoped binders, per-card open-slot dropdown, bulk lot purchase with checkbox add).

### What's solid
- **Sacred data layer**: 11 IndexedDB stores initialized correctly, schema v2 pinned, soft-delete + restore on every user store, audit-log append-only, backup-roundtrip test green ([tests/backup-roundtrip.test.ts](../tests/backup-roundtrip.test.ts)), API sync isolated from user stores ([src/db/sync.ts:11](../src/db/sync.ts)).
- **Lot allocation engine**: pure, deterministic, three modes (equal / weighted / manual), idempotent re-runs, full audit logging ([src/services/lot-service.ts:78](../src/services/lot-service.ts)). PR 18 added partial materialization via per-row checkboxes + "select all on page".
- **Binder assignment foundation**: single-writer service ([src/services/binder-assignment-service.ts:165](../src/services/binder-assignment-service.ts)), per-slot validation (cardId match, finish match, "one holding → one slot" invariant), deterministic auto-assign, PR 24 audit pinned by 16 tests.
- **Dashboard**: action-needed engine ([src/domain/dashboard-actions.ts](../src/domain/dashboard-actions.ts)), last-sync indicator, totals across all user stores.
- **CSV exports**: five formats (collection / binder-checklist / missing-cards / duplicates / wishlist) via RFC 4180 + UTF-8 BOM + formula-injection guard ([src/utils/csv.ts:1](../src/utils/csv.ts)).
- **Global search**: Ctrl/Cmd+K overlay with up-to-100 hits + quick actions ([src/components/global-search.ts](../src/components/global-search.ts)).
- **AI Supervisor**: live as of [Pokemon#37](https://github.com/mortenalvs-byte/Pokemon/pull/37); 19 scope-guard gates, 4-pass OpenAI review approved, in-session loop ready.

### What's missing (the killer gaps)

**Critical (directly contradicts operator requirements):**

1. **Binders are NOT set-scoped at the data layer.** `sourceSetId` is optional + unenforced ([src/domain/types.ts:166](../src/domain/types.ts)); a binder can mix cards from different sets today. The operator's requirement "hver perm hører kun til hvert identiske sett" is a structural change.
2. **No per-card "where can I put this in MY set's binder?" dropdown.** `slotsForCardId` ([src/services/binder-slot-service.ts:51](../src/services/binder-slot-service.ts)) returns ALL binders, not filtered by set or open-status. Card-detail's "Binder-lokasjoner" table lists every mention; it doesn't say "an open slot for this card exists in your Base Set binder."
3. **No bulk paste/CSV import into a lot.** New lot items today require a one-at-a-time dialog ([src/views/lot-detail.ts:661](../src/views/lot-detail.ts)). A 200-card lot = 200 dialogs.
4. **No search/filter inside lot-detail.** Pagination at 50/page is the only access pattern. A 500-card lot requires 10 page-turns to find an item.
5. **No lot → holding → binder chained UX.** PR 22 added wishlist-receive-after-materialize; nothing equivalent for "after I materialize a lot, suggest binder slots."

**Important (large-collection scaling):**

6. **No list virtualization.** Browse + collection paginate but render every visible row to DOM. For 5000+ owned cards, page-turning is the only flow.
7. **Bulk-mode is page-bound.** Browse-bulk-mode (PR 19) prunes selection on every page change; cross-page batch selection is impossible.
8. **No user-visible activity log.** `auditLog` table is fed correctly but never exposed in UI. The operator has no "what changed yesterday?" view.

**Polish (lower priority):**

9. **No keyboard power-shortcuts** beyond global search.
10. **No skip-to-content link**, no audited focus-trap pattern in dialogs.
11. **No auto-sync or backup-cadence settings**; both are manual-only today.

---

## 2. Operator requirements (2026-05-11)

The operator's message defines the audit scope for this document. Each requirement is mapped to a status and proposed work below.

| # | Requirement (verbatim or paraphrased) | Status | Closes via |
|---|---|---|---|
| 1 | System-kompatibilitet — alt må fungere sammen | ◐ Partial; cross-feature chains incomplete | PR D1, D2, D3 |
| 2 | Verifikasjon på tvers | ✓ Tests + scope-guard + verdict cross-checks | (existing) |
| 3 | Brukervennlighet for personlig bruk | ◐ Single-user OK; scaling + flow gaps | All of C / D / E sections |
| 4 | Bulk-handling av mye kort med orden | ◐ Bulk-mode in browse (PR 19); not in collection/binders | PR B3, B4 |
| 5 | Permer 1:1 sett-scoped | ✗ Data model allows mixed-set binders today | PR A1, A4 |
| 6 | Legge inn / ta ut av perm enkelt | ◐ Single-slot works; no multi-select assign | PR B3 |
| 7 | Lot-kjøp i stor bulk | ◐ Lot data model OK; UI requires per-item dialog | PR B1 |
| 8 | Bulk-add via avhuking ved inntak fra lot | ✓ PR 18 — checkbox + select-all | (existing) |
| 9 | Per-kort dropdown: ledige plasser i perm for det settet | ✗ Service + UI both missing | PR A2, A3 |
| 10 | Hver perm = ett identisk sett (invariant) | ✗ Not enforced; sourceSetId is nullable + advisory | PR A1, A2 |
| 11 | Holde orden i stor samling | ◐ Pagination + filters work; no virtualization, no activity log | PR C1, C2, E1 |

---

## 3. Audit findings by area

### 3.A Binders — set-scoping is structurally incomplete

**Current state ([src/domain/types.ts:166](../src/domain/types.ts), [src/services/binder-assignment-service.ts:165](../src/services/binder-assignment-service.ts)):**

- `BinderRecord.sourceSetId` is `string | null`. Indexed but not unique. Two manually-created binders can both reference Base Set; one binder can reference no set at all.
- `BinderSlotRecord` has `targetCardId` (the planned card) and `holdingId` (the assigned copy). No `targetSetId`.
- `assignHoldingToSlot` validates: cardId match, finish match for reverse-holo, "one holding → one slot" globally. Does NOT validate: "the holding's card belongs to the binder's `sourceSetId`."
- `findAssignableHoldingsForSlot` ([line 102](../src/services/binder-assignment-service.ts)) filters by target cardId + finish; no set-level scope.
- Card detail's "Binder-lokasjoner" ([src/views/card-detail.ts:519](../src/views/card-detail.ts)) calls `slotsForCardId` which scans all binders. Result: visible to user but unfiltered.

**Tests as evidence ([tests/binder-*.test.ts]):**
- 26 tests in `binder-assignment-service.test.ts` cover per-slot logic; **none assert** "card-from-set-A blocked when assigning to set-B binder."
- 6 tests in `binder-detail-view.test.ts` cover render + single-slot assign flow.
- No test enforces "a binder's slots all share one setId."

**Gap class:** Data-model invariant + service-layer gate + UX dropdown all missing.

### 3.B Lots — bulk add + filter missing

**Current state ([src/views/lot-detail.ts](../src/views/lot-detail.ts), [src/services/lot-service.ts:78](../src/services/lot-service.ts)):**

- `applyAllocation` + `materializeHoldings` are atomic + idempotent + audited. Strong foundation.
- PR 18 added partial materialization: checkboxes on unmaterialized items, select-all-on-page, "Legg valgte i samling" button.
- **Bulk-add INTO a lot is missing**: `lot-item-form` is per-card. Adding 200 cards = 200 dialogs.
- **Lot-detail has no search/filter**: pagination at 50/page is the only access pattern. A 500-card lot requires the user to know which page the item lives on.
- **Lot → binder chain is missing**: PR 22 added wishlist-receive-prompt after materialize; no equivalent "suggest a binder slot for the newly-materialized holdings."

**Tests as evidence:** `lot-detail-view.test.ts` covers the 51-item pagination case; `lot-service.test.ts` covers partial materialization with itemIds.

### 3.C List performance + bulk operations

**Current state:**

- Browse view ([src/views/browse.ts:108](../src/views/browse.ts)): pagination 50/100, filters (set/rarity/owned/wishlist), 4 sort options. Renders ALL visible rows to DOM — no virtual scrolling.
- Collection view ([src/views/collection.ts:100](../src/views/collection.ts)): pagination 25/50/100, filters (condition-type/raw-condition/set/status), sort options.
- Browse-bulk-mode (PR 19): checkboxes per row, select-all-visible, bulk +1 raw. **Selection pruned on every page change** ([browse.ts:539](../src/views/browse.ts)) — cross-page selection impossible.
- Collection, binders, master-gap: **no bulk-mode** at all.
- Dashboard performance @20k cards: `cards.count()` not `.list()` ([src/services/dashboard-service.ts:6](../src/services/dashboard-service.ts)), but **no perf test** asserts dashboard renders under N ms with 20k cards / 5k holdings.

### 3.D Cross-feature chains

**Current state:**

- Lot materialize → wishlist receive: ✓ Implemented (PR 22, [src/views/lot-detail.ts:798](../src/views/lot-detail.ts)).
- Lot materialize → binder assign: ✗ Not implemented.
- Browse bulk-add → binder slot: ✗ Not implemented (bulk add lands in collection only).
- Wishlist receive → binder slot: ✗ Not implemented.

The operator's "personal-use, large collection" flow benefits enormously from chained operations — you receive a 200-card lot, materialize, and immediately get prompted "23 of these have an open slot in your Base Set or Jungle binder; click to assign all."

### 3.E Feedback + observability

**Current state:**

- `aria-live="polite"` regions in browse, collection, settings, dashboard, lot-detail show transient feedback (2.5s timeout).
- `window.alert()` modals in lot-detail and master-gap (not persistent).
- `auditLog` table is populated correctly for every user-data change ([src/db/audit.ts](../src/db/audit.ts), [src/repositories/*.ts](../src/repositories/)), but **never exposed in UI**.
- Sync failures appear in last-sync-status card + dashboard action-strip; no historical view.
- No persistent error log. No retry UI beyond manual settings → sync.

### 3.F Accessibility

**Current state:**

- 274 `aria-*` and `role=` attributes across `src/views/**`.
- Browse rows have `tabIndex="0"` + `role="button"` + Enter/Space handlers ([browse.ts:996](../src/views/browse.ts)).
- Global search bound to Ctrl/Cmd+K.
- **No skip-to-content link** found.
- **No explicit focus-trap pattern in dialogs** (relies on default dialog component behavior).
- **No power-shortcuts** beyond global search.
- UI_DESIGN_SPEC §25 compliance not cross-referenced.

### 3.G Personal preferences / settings

**Current state ([src/views/settings.ts:88](../src/views/settings.ts), [src/views/settings.ts:291](../src/views/settings.ts) PR 27):**

- ✓ Currency, raw condition default, binder slots-per-page.
- ✓ Personal: app name, default start route, dashboard focus mode, master-gap density + filters, command-center sizing, show-hints toggles.
- ✗ Auto-sync schedule.
- ✗ Backup auto-export cadence (PR 13 added auto-backup but no schedule setting).
- ✗ UI theme / language (light/dark toggle; nb-NO / en-US strings).

---

## 4. Prioritized PR roadmap

The PRs below are ordered by **operator-value × independence**. Each PR is single-purpose ([PR_RULES.md §2](../PR_RULES.md)), small enough to review in <60 min, and ships only the listed scope.

### Section A — Binder set-scoping (CRITICAL: directly closes operator requirements #5, #9, #10)

| PR | Title | Scope | Sacred-path? | Test gates |
|---|---|---|---|---|
| **A1** | Schema v3: `binders.setId` required + migration | Add NOT-NULL `setId` to `binders`; migration backfills from `sourceSetId` or majority-card-set heuristic; schemaVersion v2→v3; BACKUP_FORMAT bump | **YES** — schema.ts, BACKUP_FORMAT.md. Requires approval record. | New migration test; backup-roundtrip stays green |
| **A2** | Assignment-service set-guard | `assignHoldingToSlot` rejects when holding's card.setId ≠ binder.setId; `findAssignableHoldingsForSlot` filters by setId; same for autoAssign + direct-add | NO (service-layer only) | New tests assert cross-set assignment rejected |
| **A3** | Per-card open-slot dropdown | New `findOpenSlotsForCardInSetBinder(cardId)` service; new dropdown component in card-detail showing "Open slots in your <SetName> binder: 3, 7, 23 — click to assign" | NO | New view test |
| **A4** | Require setId in manual-binder form | Manual `binder-form` requires set picker; from-set wizard already sets it; remove the nullable path | NO | Form test asserts setId required |

### Section B — Bulk handling (operator requirements #4, #6, #7)

| PR | Title | Scope | Notes |
|---|---|---|---|
| **B1** | Lot bulk-import (paste / CSV) | New "Importer mange" dialog in lot-detail; accepts CSV or pasted lines `cardId,quantity,finish?,edition?,condition?`; resolves cards via name+set lookup; reports unresolved | Reuses existing card-search; new csv-parsing utility (no new dep) |
| **B2** | Lot-detail search/filter bar | Filter input in lot-detail page header; substring match on card name + cardId; integrates with pagination | UI-only |
| **B3** | Binder-detail multi-select assign | Checkbox per slot + "Tilordne valgte" button → bulk modal that, for each selected slot, lets user pick a holding (with A3's lookup) | Depends on A3 |
| **B4** | Cross-page bulk selection | Persistent selection state in browse + collection across pagination; "X items selected on N pages" indicator; clears on filter change | Affects existing PR 19 bulk-mode |

### Section C — Scaling (operator requirement #11)

| PR | Title | Scope | Notes |
|---|---|---|---|
| **C1** | Browse virtualization | Replace browse-table rendering with windowing (~30 visible rows; recycle DOM); maintains keyboard + bulk-select | Hand-rolled; no new dep |
| **C2** | Collection virtualization | Same pattern as C1, for collection view | After C1 lands |
| **C3** | Dashboard perf test @20k cards | New test fixtures with 20k cards + 5k holdings + 200 binders; asserts dashboard render < 500ms | Test-only PR |

### Section D — Cross-feature chains (operator requirement #1)

| PR | Title | Scope | Notes |
|---|---|---|---|
| **D1** | Lot → binder assign prompt | After `materializeHoldings`, if any materialized holding has an open set-binder slot, show "Tilordne til perm: X kort har ledig plass i Y permer — klikk for å tilordne alle" (mirrors PR 22 wishlist-receive UI pattern) | Depends on A3 |
| **D2** | Wishlist-receive → binder prompt | Extend PR 22's wishlist-receive prompt to offer binder assignment | Depends on A3 + D1 |
| **D3** | Browse bulk-add → binder | When bulk-adding raw copies in browse, offer "and put in <SetName>-perm" toggle | Depends on A3 + B3 |

### Section E — Observability + automation (operator requirement #11)

| PR | Title | Scope | Notes |
|---|---|---|---|
| **E1** | Activity-log view | New route `/activity` showing recent `auditLog` entries with filter (action / date / store) | DB-read-only |
| **E2** | Error-history panel | Persist last 100 user-visible errors in IndexedDB (new `errorLog` store); surface in settings or dashboard | Schema bump v3→v4 — bundle with A1 if possible to minimize migration count |
| **E3** | Auto-sync schedule | Settings toggle: "Sync every N hours when app open"; background timer | UI + service-worker integration |
| **E4** | Backup auto-export cadence | Settings: "Export backup to ~/Downloads every N days"; uses File System Access API on desktop | UI-only on web; Tauri integration on desktop |

### Section F — Accessibility polish (operator requirement #3, partial)

| PR | Title | Scope | Notes |
|---|---|---|---|
| **F1** | Keyboard power-shortcuts | Bind: `g d` dashboard, `g b` browse, `g c` collection, `g p` binders, `g l` lots, `g w` wishlist, `/` global search, `?` shortcut overlay | UI-only |
| **F2** | Skip-to-content link | Visually-hidden link at top of app-shell; first focusable element | UI-only |
| **F3** | Dialog focus-trap audit | Verify every modal traps Tab+Shift-Tab, restores focus to opener on close | Audit + targeted fixes |
| **F4** | UI_DESIGN_SPEC §25 compliance audit | Cross-reference each rule; emit a `docs/A11Y_COMPLIANCE_2026-05.md` checklist | Doc-only first, then targeted PRs |

### Section G — Existing cleanup roadmap (still pending)

These are from [PR30_CLEANUP_ROADMAP.md](PR30_CLEANUP_ROADMAP.md) and should be folded into the queue **after** the operator-critical Section A items land. They were the supervisor's original auto-discovery target.

| PR | Title | Source |
|---|---|---|
| **PR 35** | CSS modular cleanup (carve `src/styles.css` into per-feature files) | PR30_CLEANUP_ROADMAP §35 |
| **PR 37** | A11y polish (conditional — likely subsumed by F1–F4) | PR30_CLEANUP_ROADMAP §37 |
| **PR 38** | Performance + CSP hardening | PR30_CLEANUP_ROADMAP §38 |

---

## 5. Suggested execution order

```
Phase 1 — Operator-critical UX (closes requirements #5, #9, #10, #6)
  PR A1 → PR A2 → PR A3 → PR A4
  Then: PR B3 (binder multi-select; depends on A3)
  Then: PR D1 (lot→binder prompt; depends on A3)

Phase 2 — Bulk + lot ergonomics (closes #4, #7)
  PR B1 (lot bulk-import) → PR B2 (lot filter)
  Then: PR B4 (cross-page bulk-select)
  Then: PR D2, D3 (extended chains)

Phase 3 — Scaling (closes #11 part 1)
  PR C1 (browse virt) → PR C2 (collection virt) → PR C3 (perf test)

Phase 4 — Existing roadmap cleanup
  PR 35 (CSS) → PR 38 (perf + CSP) → PR 37 (a11y if still needed after F1-F4)

Phase 5 — Observability + automation (closes #11 part 2)
  PR E1 (activity log) → PR E2 (error history) → PR E3 (auto-sync) → PR E4 (backup cadence)

Phase 6 — Accessibility polish (closes #3)
  PR F1 (shortcuts) → PR F2 (skip-link) → PR F3 (focus-trap) → PR F4 (a11y audit doc)
```

**Total: 24 PRs.** At roughly 1–4 hours wall-clock per PR with the AI Supervisor, this is a multi-day to ~2-week autonomous run depending on operator review pace and OpenAI rate limits.

---

## 6. Notes for the AI Supervisor

### Approval records required (sacred-path PRs)

- **PR A1** (schema v3 + migration + BACKUP_FORMAT bump): requires explicit approval record under `.local/ai-supervisor/approvals/`. Sacred paths touched: `src/db/schema.ts`, `BACKUP_FORMAT.md`, `src/db/restore.ts` (validator update for new field), `src/db/backup.ts` (writer includes new field), `src/db/init.ts` (migration registration).
- **PR E2** (errorLog store): another schema bump (v3→v4). If A1 and E2 land close together, consider combining them into one schema bump to minimize migration count — though that violates PR_RULES §2 (one purpose per PR), so prefer separate PRs unless operator overrides.

### Test gates per PR

Each PR's CI gate must include the **full backup-roundtrip test family** when touching `src/db/**`:
- `tests/backup-roundtrip.test.ts`
- `tests/restore.test.ts`
- `tests/restore-deep-validation.test.ts`
- `tests/pr30-backup-deep-validation.test.ts`
- `tests/backup-*.test.ts`

PRs touching binder code must run the binder test family:
- `tests/binder-assignment-service.test.ts`
- `tests/binder-detail-view.test.ts`
- `tests/binder-detail-action-audit.test.ts`
- `tests/binder-*.test.ts`

The supervisor's `run-checks.mjs` already handles these conditional gates.

### Behaviour-drift checks

Section A PRs explicitly **change** binder behaviour (mixed-set binders become invalid). The `behaviour_drift_check.passed` field in the verdict must be set to `true` with notes like "intentional: requirement #5 enforces set-scoped binders." Section B/C/D/E PRs are additive (new flows; existing flows preserved) — `behaviour_drift_check.passed = true` with empty notes.

### Branch naming convention

Each PR uses the convention `feat/<section><number>-<slug>`:
- `feat/A1-binder-setid-schema-v3`
- `feat/B1-lot-bulk-import`
- `feat/C1-browse-virtualization`
- …

This mirrors [PR_RULES.md §11](../PR_RULES.md) branch naming.

### Queue seed (for `.local/ai-supervisor/queue.json`)

After this document merges to main, copy the following into `.local/ai-supervisor/queue.json` to bootstrap the supervisor's autonomous run. The supervisor's `discover-tasks.mjs` will also auto-pick up this file as a roadmap source on subsequent iterations.

```json
{
  "schema_version": "ai_supervisor_queue_v1",
  "tasks": [
    {
      "id": "task-20260511-A1",
      "title": "PR A1 — Schema v3: binders.setId required + migration",
      "description": "Add required setId field to binders store; migrate v2→v3 by backfilling from sourceSetId or majority-card-set heuristic; bump schemaVersion; update BACKUP_FORMAT.md to v3; preserve all existing binder data; backup-roundtrip stays green.",
      "roadmap_pr_ref": "AUDIT_2026-05-11 §A1",
      "branch_hint": "feat/A1-binder-setid-schema-v3",
      "allowedFiles": [
        "src/db/schema.ts",
        "src/db/migrations.ts",
        "src/db/init.ts",
        "src/db/backup.ts",
        "src/db/restore.ts",
        "src/repositories/binders-repo.ts",
        "src/domain/types.ts",
        "BACKUP_FORMAT.md",
        "CHANGELOG.md",
        "tests/migrations.test.ts",
        "tests/backup-roundtrip.test.ts"
      ],
      "mustNotChange": [
        "schemaVersion semantic for other stores",
        "existing audit-log shape",
        "soft-delete semantics"
      ],
      "acceptance": [
        "schemaVersion bumped v2→v3",
        "All existing binders have setId populated after migration",
        "backup-roundtrip test passes",
        "BACKUP_FORMAT.md describes new field",
        "Migration test asserts v2→v3 path"
      ],
      "approval_id": null,
      "added_at": "2026-05-11T00:00:00.000Z"
    }
  ],
  "quarantine_fingerprints": []
}
```

After PR A1 lands, append PR A2's task, etc. Or let `discover-tasks.mjs` pull entries from this document automatically (the discovery pass scans roadmap docs for `PR <id>` patterns).

---

## 7. Out of scope (explicit non-goals)

Per [KRAVSPEC.md §3](../KRAVSPEC.md), this roadmap explicitly does NOT propose:

- Image upload/storage for cards (out-of-scope per KRAVSPEC)
- Japanese cards (English-only per KRAVSPEC §8)
- Sealed products
- AI-driven pricing or valuation
- Tax/accounting/profit-loss tracking
- Sales-channel integration (eBay/Cardmarket APIs)
- Cloud sync, multi-device sync, user accounts, backend
- Mobile-native app (Tauri desktop is the only non-web surface; PWA already covers mobile-web)

If the operator wants any of these, they require a separate KRAVSPEC update (out-of-scope amendment) before the supervisor can queue them.

---

## 8. Revision history

| Date | Author | Change |
|---|---|---|
| 2026-05-11 | AI-supervised audit + operator | Initial draft post-PR1 |
