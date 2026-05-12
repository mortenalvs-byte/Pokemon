# Pokemon TCG Tracker — Phase 2 Improvement Plan

**Generated:** 2026-05-12
**Companion to:** [`IMPROVEMENT_ROADMAP.md`](IMPROVEMENT_ROADMAP.md) (Phase 1 — already executed) and [`PR30_CLEANUP_ROADMAP.md`](PR30_CLEANUP_ROADMAP.md) (PR 31–38, of which 31–36 are merged; 37 a11y + 38 perf/CSP remain).

This doc plans the *next* phase: end-to-end cleanup, sync-with-release safety, functional E2E verification, and a sustainable auto-loop strategy. **It is plan-only — no code or test changes ship in this PR.**

## Audit baseline (2026-05-12)

Hard data collected from `git ls-files src tests` on `origin/main`:

| Metric | Value |
|---|---|
| `src/` .ts/.tsx files | **116** |
| `tests/` .test.ts files | **140** |
| Total source bytes | **2.51 MB** |
| TODO/FIXME/HACK markers in src+tests | **0** |
| Stale fixtures (`tests/fixtures/**`) | **0** (directory absent) |
| Dead files (no import found, dynamic or static) | **1** — [`src/utils/money.ts`](../src/utils/money.ts) (19 lines, exports `SUPPORTED_CURRENCIES` referenced only in docs/CHANGELOG) |
| Views with ≥1 test file referencing them | **13/13** user views (3 internal modules from PR 34 decomp covered transitively) |
| Unit-test count on PR 38a branch (current tip) | **1397 / 121 files** |
| `qa:browser` count | **92 / 11 files** (~240s wall-clock, see PR 38a diagnostic) |

**Translation:** the repo is in remarkably good cleanup shape after Phase 1 (PR 31–36 + A1/A2/A3 + B1 + C1 + PR 38a). The remaining surface area is small and concentrated.

## Phase-2 sub-plans

Four independent tracks, each runnable as a focused PR with its own `allowedFiles` / `mustNotChange`. Risk-ordered low → medium so the loop can pick them up safely.

### Plan A — Dead-code cleanup (low risk, ~30 min)

**One-line goal:** remove `src/utils/money.ts` and any other unreachable files surfaced by the import-graph walk.

**Why:** the file is referenced only in docs/comments; no `.ts` file actually imports `SUPPORTED_CURRENCIES`. Currency code-paths use the `CurrencyCode` literal union in [`src/domain/types.ts`](../src/domain/types.ts) directly. The file is leftover from an earlier design pass.

**`allowedFiles`:**
- `src/utils/money.ts` (delete)
- `docs/PR30_FULL_TECHNICAL_AUDIT.md` (drop stale reference)
- `TECH_STACK.md` (drop stale reference)
- `CHANGELOG.md`

**`mustNotChange`:**
- `src/domain/types.ts` `CurrencyCode` definition
- any test
- any user-facing UI

**Acceptance:**
- `npm run typecheck && npm test && npm run build` green
- `grep -r "from.*utils/money" src tests` returns 0 hits (already true)
- `git diff --stat` shows 1 file deleted + 3 docs lines updated

**Why this is safe:** zero imports = zero runtime behavior change. The 1 file × 19 lines reduces source footprint by 0.007% — operationally negligible but tidies the audit surface.

### Plan B — Sync-with-release orphan-card safety net (medium risk, ~2 h)

**One-line goal:** when an upstream card disappears after a sync, ensure existing holdings/wishlist/binder-slots referencing the now-orphan `cardId` keep functioning (no crash, no data loss) — and surface the situation to the user via the existing audit log + UI badges.

**Why:** [`src/db/sync.ts`](../src/db/sync.ts) does `cards.clear()` + `bulkPut(newCards)` in one transaction. If the Pokemon TCG API drops a card between syncs (rare but documented to happen for retired/invalid entries), the local `cards` store loses it. User-owned stores (`holdings`, `lots`, `lotItems`, `binders`, `binderSlots`, `wishlist`) are correctly untouched, but they still carry the orphan `cardId`.

Today's behavior:
- `cardsRepo.get(holding.cardId)` returns `undefined`
- Browse row falls back to `row.card.setId` text; the row still renders
- Card-detail view crashes? Needs verification.
- Auto-assignment still works because `assignHoldingToSlot` doesn't re-validate via cards
- Backup roundtrip: orphan holdings restore correctly

**Proposed mitigation:**

1. **Detection on sync completion** — after `bulkPut(newCards)`, diff the new set of `cardId`s against the live (non-deleted) holdings/wishlist/lotItems/binderSlots. Any orphan reference → append one `sync_orphans_detected` audit row with the count + first 10 IDs. Single best-effort write inside the same transaction.
2. **`appMeta.lastSyncOrphans`** — store the orphan count + sample for UI display in the Dashboard sync status panel.
3. **Defensive null-card rendering** — audit every view that does `cardsRepo.get(holding.cardId)` and ensure the `undefined` branch renders an "Ukjent kort (synket bort)" placeholder, not a crash.
4. **Operator action surface** — Dashboard adds a "N orphan kort etter siste synk" chip when `appMeta.lastSyncOrphans.count > 0`, linking to a hidden `#orphans` view that lists every reference. Operator can: keep (do nothing), move to lot, or soft-delete.

**`allowedFiles`:**
- `src/db/sync.ts`
- `src/domain/types.ts` (add `lastSyncOrphans` to `AppMetaRecord`)
- `src/views/dashboard.ts` (orphan chip)
- `src/views/card-detail.ts` (orphan render)
- `src/views/browse.ts` (orphan-row render)
- `src/views/holdings-…` or `src/views/wishlist.ts` etc — all consumers of `cardsRepo.get`
- new `src/views/orphans.ts` (list + actions)
- new `tests/sync-orphan-detection.test.ts`
- new `tests/orphans-view.test.ts`
- `CHANGELOG.md`

**`mustNotChange`:**
- `schemaVersion` (the `lastSyncOrphans` field is additive on `appMetaRecord`, schemaVersion stays at 2 since appMeta is a free-form key-value store)
- `BACKUP_FORMAT.md` (the new appMeta key is backwards-compatible per existing rules)
- `auditLog` append-only contract
- User-owned store contents (sync still never reads/writes them)
- Existing 1397 tests

**Acceptance:**
- New test: seed 5 holdings, sync with 2 of their cardIds dropped → assert orphan count = 2, audit row appended, appMeta updated, no user-data store changed
- New test: orphan-card path in `card-detail` renders fallback instead of crashing
- Dashboard test asserts orphan chip appears + links correctly
- All 1397 existing tests still pass
- `npm run build` size delta < +3 KB gzip

**Risk:** MEDIUM — touches sync, several views, and adds a new view. Backwards-compatible by design (additive appMeta key); legacy data without `lastSyncOrphans` falls through cleanly.

### Plan C — Functional E2E coverage for under-tested views (low-medium risk, ~3 h)

**One-line goal:** boost test count for the 6 views with only 1–2 test references to a coverage level matching `binder-detail` (7 tests) and `settings` (7 tests).

**Current baseline (test files referencing each view):**

| View | Tests | Notes |
|---|---|---|
| `binder-detail` | 7 | strong (PR 24 + PR 29 + audit pin) |
| `settings` | 7 | strong |
| `browse` | 6 | strong (incl. PR 19 bulk-mode + PR C1 virtualization) |
| `card-detail` | 6 | strong |
| `dashboard` | 5 | OK |
| `master-gap` | 4 | OK (PR 28 + PR 25/26) |
| `binders` | 2 | thin — only "Ny perm" + listing |
| `lots` | 2 | thin |
| `collection` | 1 | very thin |
| `lot-detail` | 1 | very thin (only B1 bulk-import) |
| `wishlist` | 1 | very thin |
| `backup` | 1 | very thin |

**Proposed: pick one view per PR.** Each PR adds 4–6 targeted button/flow tests covering the most operator-visible interactions:

- **PR C2 — Collection view tests** (`collection.ts`): filter chips, edit-holding modal, delete-holding flow, page summary, empty-state action.
- **PR C3 — Lot-detail view tests** (`lot-detail.ts`): allocated-cost banner, soft-delete + restore, materialize-to-holdings flow, summary chip math.
- **PR C4 — Wishlist view tests** (`wishlist.ts`): add-wanted → mark-ordered → mark-received transitions, status filter chips, cross-view USER_DATA refresh.
- **PR C5 — Backup view tests** (`backup.ts`): export → wipe → restore roundtrip (already exists via `tests/backup-roundtrip.test.ts`?), API-key preservation chip, malformed-file warning UX.
- **PR C6 — Binders + Lots list view tests** (`binders.ts`, `lots.ts`): empty-state actions, row click → detail navigation, filter chips, "Ny X" button enable/disable.

Each PR independent, single-purpose, ≤200 lines of test code, no production code changes. Risk LOW since the production code is mature and the views already render correctly — we're documenting + locking behavior.

**`allowedFiles` per PR:** the test file + (if a render bug surfaces) the view file. **`mustNotChange`:** any other view, the data layer, schema.

**Acceptance per PR:** new test count +4-6, all pre-existing tests pass.

### Plan D — Auto-loop hygiene + cap unblock (low risk, requires operator action)

**Three concrete items, each unblocking the supervisor:**

1. **Merge `docs/roadmap-pr-status-sync` first** (commit `96cea32` on remote). This stops the supervisor's `discover-tasks.mjs` from re-proposing PRs 31–36 every iteration. Without this merge, every Stop-hook fire wastes an OpenAI call on a stale PR 35 prompt that the loop cannot act on (the work is already merged on main).

2. **Raise `qa:browser` per-step cap to 360s** (in `scripts/ai-supervisor/run-checks.mjs` or its config) so verification doesn't flap on the 240s boundary. Per PR 38a's 7-run diagnostic, current cap is at the median of natural runtime variance. Requires quorum approval per scope-guard #13.

3. **Update `discover-tasks.mjs` to recognize bundled PR merges** (parse `(#NNN)` in commit subjects + cross-reference roadmap by content, not just `PR N:` prefix). This is the long-term fix for the staleness loop. Requires quorum approval.

The first item is operator-trivial (merge a docs-only PR with 1 file changed). The second + third are supervisor self-modifications and need the 4-eyes approval ritual.

**Acceptance:** after item 1, the supervisor's next discovery returns only PR 37 + PR 38 (matching the post-#39 reality). After items 2+3, the loop can run for hours without timing out at the boundary.

## Suggested sequencing

| PR | Branch | Plan | Risk | Effort | Depends on |
|---|---|---|---|---|---|
| Phase2-plan (this doc) | `docs/phase2-cleanup-plan` | — | none | done | — |
| D1 | `docs/roadmap-pr-status-sync` (already pushed at `96cea32`) | D.1 | none | done | operator merge |
| A1 | `chore/remove-dead-money-util` | A | LOW | 30 min | D1 (avoids re-discovery loop) |
| C2 | `feat/C2-collection-view-tests` | C | LOW | 1 h | A1 |
| C3 | `feat/C3-lot-detail-view-tests` | C | LOW | 1 h | independent |
| C4 | `feat/C4-wishlist-view-tests` | C | LOW | 1 h | independent |
| B1 | `feat/sync-orphan-card-safety` | B | MEDIUM | 2-3 h | A1 (clean baseline) |
| C5 | `feat/C5-backup-view-tests` | C | LOW | 1 h | independent |
| C6 | `feat/C6-binders-lots-list-tests` | C | LOW | 1 h | independent |
| D2 | supervisor quorum approval | D.2 | LOW | operator | — |
| D3 | supervisor quorum approval | D.3 | LOW | operator | D2 |

Total estimated effort if all green: ~10–12 h of supervised work over multiple sessions. Each PR is independently mergeable.

## Out of scope (intentionally deferred)

- **PR 37 — accessibility polish.** Conditional on concrete a11y findings per [`PR30_CLEANUP_ROADMAP.md`](PR30_CLEANUP_ROADMAP.md). No findings surfaced in this audit; not picked up.
- **PR 38b — Tauri CSP tightening.** Sibling to PR 38a (perf). HARD-FORBIDDEN without approval record per scope-guard #4. Operator can land a docs-only approval and a small PR; not in Phase 2 sequencing.
- **Real-browser E2E (Playwright/Cypress).** Would add a new production-grade dep + ~100MB tooling install. Operator decision; outside automated cleanup scope.
- **Vite-level perf** beyond PR 38a. Browse virtualization (PR C1) is the operator-visible win; further bundling tweaks are minor.
- **`tests/qa-seed.test.ts` speed-up.** Would need rewriting `seedStressData` to use Dexie `bulkAdd` inside one transaction. Not in Phase-2 critical path — handled by Plan D items 2+3 (cap raise) rather than rewriting the slow code.

## What gets us to MVP_ACCEPTANCE 100%

Per [`MVP_ACCEPTANCE.md`](../MVP_ACCEPTANCE.md), the remaining unchecked items at this audit point are mostly the items above + features not in Phase 2 scope (e.g. CSV export polish, dashboard last-sync chip integration with orphans). Plan B (sync orphan safety) and Plan C (E2E button coverage) together close most of the operator-visible quality gates that remain.

Phase 3 (post-Phase-2) would pick up:
- Visual-regression spot checks across every route
- CI pipeline integration if/when the project gets remote CI (currently human-merged per [`PR_RULES.md`](../PR_RULES.md) §1)
- Telemetry / observability for the supervisor itself

But neither is needed to call the app shippable for Morten's personal collection-tracking use.
