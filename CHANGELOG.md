# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once a versioned release lands.

---

## [Unreleased]

### Added (Phase-2 Plan C4 — wishlist view toolbar filter tests)

5 new test cases in [tests/wishlist-view.test.ts](tests/wishlist-view.test.ts) under the existing "Wishlist view" describe block. Pins the status / priority / set / search / page-size filter wiring that the existing 8 tests didn't cover:

- `C4: status-filter narrows rows by wishlist status` — three statuses seeded (wanted, ordered, received); selecting "wanted" or "ordered" leaves the one matching row.
- `C4: priority-filter narrows rows by priority` — three priorities seeded (grail, high, low); selecting "grail" leaves only that row.
- `C4: search input narrows rows after debounce` — Charizard + Pikachu wishlist entries; "PIKA" search leaves only Pikachu.
- `C4: set-filter narrows rows by setId` — base1 + jungle entries; selecting "jungle" leaves only the jungle entry.
- `C4: page-size 25 paginates the rows + next-page advances` — 30 entries, page-size 25 → 25 rows + "Side 1 av 2" summary; next-page yields the remaining 5.

**Test-only change.** No production code touched. Brings wishlist-view from 8 → 13 tests. Existing PR 22 receive-flow tests unchanged.

**Verification:** typecheck clean, 1399 tests pass (was 1394 on `origin/main`, +5), build green (CSS 73.17 KB / JS 483.59 KB — unchanged), audit clean.

### Added (PR B1 — Lot bulk-import via paste/CSV) — operator requirement #7

Adds a "Importer mange" button to lot-detail that opens a two-step
dialog: paste a list of `cardId,quantity[,finish[,edition[,condition]]]`
lines (or load a `.csv` / `.txt` file), preview the resolved-vs-error
summary, then write all resolved items to the lot in one operation.
Closes the operator pain-point of "200 cards in a lot = 200 dialog
clicks" — now: paste once, confirm, done.

**Pure parsing service** [src/services/lot-bulk-import-service.ts](src/services/lot-bulk-import-service.ts):
- Per-line parser with sane defaults (`quantity=1`, `finish=normal`,
  `edition=unlimited`, `condition=NM`, `conditionType=raw`).
- Skips blank lines and `#`-comments without reporting them as errors.
- Per-line error reporting with line number + reason (unknown cardId,
  invalid quantity/finish/edition/condition).
- Card-existence check via `cardsRepo.get(cardId)`; result cached so
  repeated cardIds (same card with multiple finishes) only hit the DB once.
- Handles CRLF line endings (Windows paste).
- 12 service-level tests covering happy path, all error paths, CRLF,
  cache hit, lotId attachment, line numbering.

**Two-step dialog** [src/components/lot-bulk-import-dialog.ts](src/components/lot-bulk-import-dialog.ts):
- Step 1 (input): textarea + file picker + "Forhåndsvis" button.
- Step 2 (summary): "N kort klare for import. M feil. K tomme/kommentar-linjer
  hoppet over." + per-line error list + "Importer N kort" / "Tilbake".
- On confirm: writes each item via existing
  `lotItemsRepo.create(...)` (PR 22's audit + soft-delete + allocation
  paths stay intact); appends ONE `lot_bulk_import` audit row
  summarizing the operation (append-only contract, DATA_MODEL §4).

**v2-compatible — no schema change:**
- `SCHEMA_VERSION` stays at 2.
- `BACKUP_FORMAT.md` unchanged.
- `LotItemRecord` shape unchanged; bulk-import writes through the
  existing `lot-items-repo`.
- PR 18 checkbox-materialize UX unchanged.
- PR 22 wishlist-receive-after-materialize unchanged.
- B1 imports as `conditionType: 'raw'` only; graded items still use
  the per-item form (rare enough that the slow path is fine).

**Files touched:**
- `src/services/lot-bulk-import-service.ts` (new, pure parser)
- `src/components/lot-bulk-import-dialog.ts` (new, two-step dialog)
- `src/views/lot-detail.ts` (new "Importer mange" button next to "Legg til item")
- `tests/lot-bulk-import-service.test.ts` (new, 12 tests)

### Refactored (PR 35 — CSS modular cleanup)

Stacked on the binder set-scoping foundation (A1+A2+A3). Split
`src/styles.css` (4571 lines / 97 115 bytes) into six per-section
files under `src/styles/`. The root `src/styles.css` is now a
thin `@import` chain that Vite inlines at build time, producing
byte-identical dist output:

```
src/styles/
  tokens.css                — :root variables (1.5 kB)
  layout.css                — topbar, sidebar, layout grid, content (7.9 kB)
  chips-and-views.css       — status chips, backup, settings, browse, card detail, collection (22.3 kB)
  forms-and-binders.css     — dialog wrapper, holding form, wishlist, binders, binder-detail (29.1 kB)
  lots-and-dashboard.css    — lots, lot-detail, lot-form, dashboard, master gap (24.0 kB)
  workspace-and-polish.css  — PR 26/27/28 desktop workspace + personal command center (12.2 kB)
```

**Acceptance criteria (all met):**
- ✅ `dist/assets/index-*.css` size unchanged: 73.17 kB pre and
  post-split (file hash `index-CoBL_SCm.css` is BYTE-IDENTICAL —
  the chained `@import`s produce the exact same minified bundle).
- ✅ Zero class-name changes (just file relocations).
- ✅ Zero `data-region` selector changes.
- ✅ Visual layout unchanged (no rule body modifications; only
  rule grouping).
- ✅ `vite.config.ts` unchanged (Vite's default `@import` handling
  in CSS source is sufficient).

**Why split:** The pre-split 73 kB file made ownership unclear and
encouraged merge conflicts on any cross-cutting change. Splitting
by feature lets future PRs touch one section without affecting
the others — same goal the PR30 audit identified.

### Added (PR A3 — Per-card open-slot dropdown in card-detail)

Closes operator requirement #9 from
[docs/IMPROVEMENT_ROADMAP.md](docs/IMPROVEMENT_ROADMAP.md):
each card now surfaces a list of open slots in any binder bound
to that card's set, so the user can directly answer "where can
I put this card in MY set's binder?" without scrolling through
every binder.

**New service function** `findOpenSlotsForCardInSetBinder(cardId)`
in [src/services/binder-slot-service.ts](src/services/binder-slot-service.ts):
returns open slots (status not `'owned'` AND no holdingId
assigned) in any LIVE binder whose `sourceSetId === card.setId`.
Returns each match with an `openReason` of `'targeted-empty'`
(slot explicitly waited for this card) or `'blank-untargeted'`
(blank slot the user can backfill). Legacy null-sourceSetId
binders are deliberately excluded — they are not part of the
"per-card → MY set's binder" UX.

**New dropdown** in [src/views/card-detail.ts](src/views/card-detail.ts):
when the card has open set-scoped slots, the "Binder-lokasjoner"
section now opens with a "Ledige plasser i sett-perm (N)"
select + "Gå til valgt slot" button. Selecting + clicking deep-links
to the binder + slot via the existing `navigateToBinderSlot` helper.
Hidden entirely when no open slots are found (no UI noise for
operators without set-scoped binders).

**v2-compatible — no schema change:**
- `SCHEMA_VERSION` stays at 2.
- `BACKUP_FORMAT.md` is unchanged.
- Existing `slotsForCardId(cardId)` behaviour preserved verbatim
  (the table further down still shows ALL slot references for the
  card, with no set filter).
- PR 24 single-writer invariant intact.
- PR 29 16-case binder-detail-action-audit test stays green.

**Files touched:**
- `src/services/binder-slot-service.ts` — new method
  `findOpenSlotsForCardInSetBinder`; `OpenSlotForCard` type
  exported.
- `src/views/card-detail.ts` — new `buildOpenSlotsDropdown(...)`
  helper called from `buildBindersSection`.
- `tests/binder-slot-service.test.ts` — 7 new cases covering
  scoped happy path, legacy exclusion, wrong-set exclusion,
  owned/assigned slot exclusion, unknown cardId, empty result,
  sort stability.
- `tests/card-detail-with-binders.test.ts` — 2 new cases
  proving the dropdown renders when set-scoped binders have
  open slots and is hidden when only legacy binders exist.

### Added (PR A2 — Assignment-service set-guard, v2-compatible)

Stacks on top of A1: `assignHoldingToSlot` now rejects cross-set
assignment **when the binder has a non-null `sourceSetId`**. Legacy
binders with `sourceSetId === null` keep their pre-A1 lenient
behaviour so existing user data continues to load + behave normally
without any migration.

`findAssignableHoldingsForSlot` mirrors the same conditional filter
so the assign-holding modal does not surface wrong-set candidates
for a set-scoped binder. The cardId-match check (PR 24 §3) still
fires first; A2 is defence-in-depth on top of it.

**v2-compatible — no schema change:**
- `SCHEMA_VERSION` stays at 2.
- `BACKUP_FORMAT.md` is unchanged.
- `BinderAssignmentDeps` interface unchanged (preserves
  `recommended-placement-service` and other consumers).
- PR 24 single-writer invariant intact (`binderSlotsRepo.update`
  still only called from this service).
- PR 29 16-case action-audit test stays green.

**Files touched:**
- `src/services/binder-assignment-service.ts` — new
  `assertSetMatchForAssignment` helper called in
  `assignHoldingToSlot`; conditional set-filter added to
  `findAssignableHoldingsForSlot`.
- `tests/binder-assignment-service.test.ts` — 5 new cases covering
  cross-set rejection (scoped binder), same-set happy path (scoped),
  legacy null binder still lenient, findAssignable filter for
  scoped, findAssignable unfiltered for legacy.

**Audit row `binder_legacy_unscoped`:** when `assignHoldingToSlot`
touches a binder whose `sourceSetId === null`, the service appends
one `binder_legacy_unscoped` audit entry referencing the binder,
slot location, holding, and cardId. Wired via a new OPTIONAL
`appendAudit` field on `BinderAssignmentDeps` — production callers
in `src/views/binder-detail-actions.ts` provide it; existing
consumers like `recommended-placement-service.ts` and the
binder-assignment-service test fixtures that build deps without it
continue to work unchanged (audit emission silently skipped). The
operator can later grep `auditLog` for these rows to identify
which legacy binders should be back-filled with a sourceSetId in
PR A4.

`findAssignableHoldingsForSlot` performs the set-filter PER HOLDING
(not just against the slot's targetCardId card) — fetches each
holding's own card and rejects mismatched setIds. Defence-in-depth
that survives data-integrity drift; the typical case where
`holding.cardId === slot.targetCardId` resolves to the same answer.

### Added (PR A1 — Manual-binder set picker required)

The manual-binder creation form now requires the operator to pick a set
(`sourceSetId`) before submit. Previously the form hardcoded
`sourceSetId: null`, which let two manually-created binders both
reference Base Set (or no set at all). After PR A1, every NEW binder is
set-scoped at creation time — closing the "hver perm hører kun til
hvert identiske sett" invariant at the UI layer.

**v2-compatible — no schema change:**
- `SCHEMA_VERSION` stays at 2.
- `BACKUP_FORMAT.md` is unchanged.
- Existing binders with `sourceSetId=null` (legacy) keep loading + rendering normally;
  edit mode shows a "Ikke knyttet til sett (eldre perm)" hint and the field is locked.
- The validator (`src/domain/validators.ts`) is untouched. Enforcement is form-level only.

The schema-level guarantee (binders.setId NOT-NULL + migration) is
deferred to PR A4, which is explicitly NOT auto-queueable and requires
an operator-issued approval record per
[docs/IMPROVEMENT_ROADMAP.md §6](docs/IMPROVEMENT_ROADMAP.md).

**Files touched:**
- `src/components/binder-form.ts` — set fieldset + async load + submit validation
- `tests/binder-form.test.ts` (new) — 7 cases covering add/edit + empty-sets state

### Added (PR 30 — Repo-driven full technical audit)
PR 30 is a repo-driven evidence-based audit after the merged PR #29
(Phase G — "whole-system action audit for the other 10+ views" was
explicitly deferred to a follow-up PR per operator decision). The
output is three permanent reference docs, one targeted security fix,
and a regression-test pin for the next deferred follow-up.

**Hard rules carried forward (verified at HEAD `762f105`):** no
schema migration, no new IndexedDB store, no Tauri capability change
(still `core:default` only), no backup format change, no new
dependency, no new external API, no smart-placement scoring change,
no PR 24 / PR 25 / PR 29 semantic change, no production gating
weakening.

#### Audit deliverables
- `docs/PR30_FULL_TECHNICAL_AUDIT.md` — canonical audit. Every R1–R13
  risk lane addressed with file:line evidence; 19 findings classified
  using the `ID / Severity / Area / Evidence / Files / Why it matters
  / Fixed in PR #30 / Tests / Status` template.
- `docs/PR30_FULL_TECHNICAL_REPORT.md` — system health classification
  (GREEN / YELLOW / RED per area), highest-risk modules, overgrown
  files, and final technical recommendation.
- `docs/PR30_CLEANUP_ROADMAP.md` — PR 31–38 with scope, files,
  acceptance criteria, and "must not change" guards per PR.

#### Fixed: F-CSV-1 — CSV / formula injection
`src/utils/csv.ts` `escapeCell` previously only quoted commas,
quotes, newlines and CRs. A user-typed holding note such as
`=HYPERLINK("https://evil.test","click")` would land verbatim in
the exported CSV. When the operator opened it in Excel / Sheets /
Numbers / Calc the cell was interpreted as a live formula —
classic OWASP "CSV / formula injection".

The fix adds `guardFormulaInjection`: when a cell's first character
is one of `=`, `+`, `-`, `@`, `\t`, `\r`, `\n`, the value is
prefixed with a single apostrophe (`'`). The apostrophe is the
documented spreadsheet convention for "render as text" and is
stripped on display by every major spreadsheet app. Headers are
never user data and pass through unprefixed; RFC 4180 quoting
still composes on top.

The change is in the canonical CSV writer, so every exporter
inherits the protection: `binder-csv-export`, `lot-csv-export`,
and the four `mvp-csv-export` flows (collection, wishlist,
duplicates, missing-cards). 14 regression cases cover every
class of payload, plus a Norwegian-character roundtrip and a
"safe values pass through unchanged" regression guard.

#### Findings deferred (with reason and successor PR)
- F-BACKUP-VALID-1 (MEDIUM) — `validateBackup` in `src/db/restore.ts`
  checks shape and IDs only; per-record field types are NOT
  validated. Pinned with `tests/pr30-backup-deep-validation.test.ts`
  so PR 33 has a fail-then-fix baseline. Successor: **PR 33**.
- F-TAURI-CSP-1 (LOW) — `style-src 'unsafe-inline'` is required
  today by `createLazyImage`'s inline width/height. Successor:
  **PR 38** (CSS rewrite + CSP tightening).
- F-TAURI-CSP-2 (LOW) — `connect-src 'self' https:` is broader
  than required. Successor: **PR 38**.
- F-PERF-LISTLIVE-N-PLUS-1 (INFO) — bulk recommended-placement
  re-walks `binderSlotsRepo.listLive()` per row. Successor: **PR 38**.
- F-PROD-GATE-1 (LOW) — `tests/qa-route-prod-gating.test.ts` skips
  silently when `dist/` is missing. Documented + guarded.

#### Findings verified safe
- R1 (route/view listener leaks) — every route mount uses the
  AbortController signal; PR 15A F-3 invariant intact.
- R2 (global search lifetime) — single AbortController gates every
  global listener; `searchRequestSeq` stale-result guard in place;
  receive button only renders when `receiveCandidateCount > 0`.
- R3 (cards/sets cache) — WeakMap by Dexie instance; invalidated
  after every repo write, sync commit, restore commit, and
  local-fixture import.
- R6 (XSS / innerHTML) — 31 `innerHTML` uses, all static skeletons;
  dynamic data goes through `createElement` + `textContent`.
- R7 (dev-only QA tooling) — 38 banned strings in
  `tests/qa-route-prod-gating.test.ts`; bundle re-built at HEAD
  shows 0 occurrences.
- R8 capabilities — `core:default` only; zero custom Rust commands;
  bundle target MSI only; `npm run desktop:build` PASSES at HEAD.
- R9 (slot assignment) — `assignHoldingToSlot` is the only writer
  for `binderSlots.holdingId`; PR 24 invariants intact;
  PR 29 binder-detail action audit (16 cases) remains green.
- R10 (wishlist receive) — every receive path goes through
  `wishlist-receive-service.markWishlistCandidatesReceived`;
  match key is `cardId + finish + active + live`.
- R11 (performance) — page-rendering contracts intact (binder-detail
  16-tile pages, lot-detail pagination, master-gap O(store) lookups).
- R12 (accessibility) — `role=dialog` + `showModal()`, `aria-current`
  on active nav, `label[for]` pairs, `aria-live` on validation.
- R13 (dependencies) — `npm audit --omit=dev` and `npm audit` both
  report 0 vulnerabilities. Single production dependency: `dexie ^4.4.2`.

#### Touched / new files
- `docs/PR30_FULL_TECHNICAL_AUDIT.md` — new (canonical audit).
- `docs/PR30_FULL_TECHNICAL_REPORT.md` — new (health report).
- `docs/PR30_CLEANUP_ROADMAP.md` — new (PR 31–38 roadmap).
- `src/utils/csv.ts` — `guardFormulaInjection` + serializeCsv body
  routes user-data cells through the guard. Headers untouched.
- `tests/pr30-csv-formula-injection.test.ts` — new (14 cases).
- `tests/pr30-backup-deep-validation.test.ts` — new (14 cases,
  pin-then-flip baseline for PR 33).

#### Verification (measured against HEAD before merge)
```
npm run typecheck          PASS
npm test                   119 files / 1202 / 1202 PASS  (was 117 / 1174 / 1174 → +2 files / +28 cases)
npm run qa:browser         11 files / 92 / 92 PASS
npm run build              460.28 KB JS / 120.58 KB gzip   (was 460.15 / 120.51 → +130 bytes JS, +70 bytes gzip)
npm run desktop:build      PASS — exe 3.4 MB + MSI 1.9 MB (release build 1m 21s)
npm audit --omit=dev       0 vulnerabilities
npm audit                  0 vulnerabilities
qa-route-prod-gating       3/3 PASS, 0 banned strings in dist/
PR 29 binder-detail        16/16 PASS (unchanged at HEAD)
```

Bundle delta is the entire footprint of the `guardFormulaInjection`
helper plus the routing call inside `serializeCsv` — well below the
+5 KB gzip stop-condition for security fixes.

Verification numbers are mirrored in
`docs/PR30_FULL_TECHNICAL_AUDIT.md` § Final verification.

#### Out of scope
- ❌ Phase G as a per-view audit-suite rebuild. Section 15 of the
  audit doc explains why the wider repo-driven sweep is the more
  useful output (every action surface PR 29's pattern would catch
  is already covered by an existing test or has a known canonical
  writer).
- ❌ Schema / store / Tauri capability / backup format changes.
- ❌ Broad cleanup work — moved to PR 31–38 per `PR30_CLEANUP_ROADMAP.md`.
- ❌ Pricing / value layer, scanner, CSV import, cloud, login —
  unchanged from PR 28's hard-rule list.

### Added (PR 28 — Desktop app + smart placement engine)
PR 28 lands two big changes in one bounded PR:

1. **Desktop app shell** — Tauri v2 scaffold so the app can run as a native window with its own icon and persistent IndexedDB store, alongside the existing browser app.
2. **Smart placement engine** — best-copy scoring + recommended-placement service + master-gap UI overlay + dashboard command-center split. The 44 ambiguous_owned-rader brukeren hadde i Base Set 1 Master kan nå plasseres med ett klikk per rad eller én bulk-operasjon.

**Hard rules carried forward:** no schema migration, no new IndexedDB store, no Electron, no auto-update, no code signing, no external API beyond the existing pokemontcg.io sync, no pricing/value lookup, no scanner, no CSV import, no broad Tauri filesystem/shell capabilities, no silent assignment, no direct `binderSlotsRepo.update` for recommended placement (PR 24's `assignHoldingToSlot` is reused), no PR 25 classification change.

#### Desktop app (Tauri v2)
- `src-tauri/{Cargo.toml,build.rs,tauri.conf.json,src/main.rs,capabilities/main.json}` — full Tauri v2 scaffold.
- `package.json` — added `tauri`, `desktop:dev`, `desktop:build`, `desktop:check` scripts and `@tauri-apps/cli` devDependency. Existing browser scripts unchanged.
- `vite.config.ts` — fixed dev port 5173, `strictPort: true`, `src-tauri/**` ignored in the watcher, `clearScreen: false` so Tauri's own startup messages survive. Browser dev/build behaviour unchanged.
- `src-tauri/capabilities/main.json` — only `core:default`. **No `fs:`, `shell:`, `clipboard:`, or remote-URL permissions.** A static test asserts these are absent.
- `src-tauri/src/main.rs` — minimal Tauri builder; no custom commands, no filesystem, no shell, no network.
- `docs/DESKTOP_APP.md` — Windows prerequisites (Rust, MSVC, WebView2), commands, data note (separate IndexedDB profiles, backup is the migration path), security note (no signing, no auto-update), troubleshooting.
- Topbar runtime badge: `data-region="runtime-badge"` reads `window.__TAURI_INTERNALS__` and renders `Desktop` only when present. Browser tests verify it stays hidden by default.

#### Best-copy scoring engine
- `src/services/best-copy-service.ts` — pure function `recommendBestCopy({ requiredFinish, candidates })`. No DB, no DOM, no external API, no price lookup. Score components: +100 base, +100 finish-match, condition (NM/LP/MP/HP/DMG), language (en/other/empty), status (owned beats duplicate / for_sale / for_trade / upgrade_needed / ordered / wanted), graded penalty when a raw alternative exists, special-variant penalty when a non-special alternative exists. Tied top scores → `manual_required`. Wrong-finish disqualifies before scoring.
- `src/domain/master-set-gap.ts` — added `MasterGapBestCopyRecommendation` overlay (`status` / `recommendedHoldingId` / `score` / `reasons` / `candidateCount`) on `MasterGapRow`. Per-binder + dashboard summaries gain `recommendedAmbiguousCount` and `manualAmbiguousCount` aggregates. PR 25 `ambiguous_owned` classification semantics are unchanged.
- `src/services/master-set-gap-service.ts` — runs `recommendBestCopy` only for ambiguous rows, reusing the existing in-memory `holdingsById` map. No extra DB calls — the no-per-slot-Dexie-call performance contract still holds.

#### Master-gap UI
- Ambiguous rows render an overlay in the reason cell:
  - `recommended` → "Anbefalt kopi · score N" + bullet-list of reasons + a primary `Plasser anbefalt` action button (alongside `Velg holding`).
  - `manual_required` → "Ingen trygg anbefaling — velg manuelt" + only `Velg holding`.
  - `no_candidates` → "Ingen kandidat funnet — oppdater eller velg manuelt".
- `Plasser anbefalt` calls PR 24's `assignHoldingToSlot` directly (never `binderSlotsRepo.update`); failure is surfaced inline.
- New binder-header bulk button: `Plasser alle anbefalte (N)`. Disabled when `recommendedAmbiguousCount === 0`. Click opens a confirmation dialog (`Avbryt` / `Plasser anbefalte`) that explicitly states "Bare rader med én trygg anbefaling blir plassert. Uklare valg hoppes over.". Result chip shows `X plassert · Y hoppet over — manuell vurdering kreves · Z feilet`. Summary survives the post-placement re-render via `state.lastBulkSummary`.

#### Bulk recommended placement service
- `src/services/recommended-placement-service.ts` — sequential walk over the report's ambiguous rows. Re-reads slot + holding + binder from the repo before each assignment so a stale snapshot can never write through outdated data. Failures (slot deleted, holding deleted, contract violation) are recorded individually and never abort the loop. Skips `manual_required`, `no_candidates`, null-recommendation, and non-ambiguous rows. **Does not touch `binderSlotsRepo.update` directly** — verified by both a mock-based test (the assign service is the only writer in the path) and a static-source test that greps for the call.

#### Command center upgrade
- `src/services/command-center-service.ts` — split `resolve_ambiguous_owned` into two new kinds: `place_recommended_copies` (warning, count = `recommendedAmbiguousCount`, action `Åpne master gap`) and `resolve_manual_ambiguous` (warning, count = `manualAmbiguousCount`). Sort order: critical first, then `place_recommended_copies` before `resolve_manual_ambiguous`. Both kinds get the focus-mode boost in `master_set` and `binder_work` modes. Legacy fallback: when a summary doesn't carry the new aggregates, the original `resolve_ambiguous_owned` chip still renders.

#### Performance / safety
- Browser JS bundle: 446 KB → ~462 KB (+16 KB, gzip +~10 KB). Well inside the +35 KB stop condition.
- No new IndexedDB store, no schema migration, no per-slot DB queries.
- Bulk placement is sequential and never silently auto-assigns without confirmation.
- Tauri capabilities are minimal (`core:default` only).
- Recommended placement is a thin orchestration over `assignHoldingToSlot`; PR 24's one-holding-one-slot contract remains the single writer.

#### Touched / new files
- `package.json`, `vite.config.ts` — Tauri scripts + Vite port pinning.
- `src-tauri/{Cargo.toml,build.rs,tauri.conf.json,src/main.rs,capabilities/main.json}` — new.
- `docs/DESKTOP_APP.md` — new.
- `src/services/best-copy-service.ts` — new.
- `src/services/recommended-placement-service.ts` — new.
- `src/domain/master-set-gap.ts` — recommendation overlay types + aggregates.
- `src/services/master-set-gap-service.ts` — best-copy integration.
- `src/services/command-center-service.ts` — split + sort order.
- `src/views/master-gap.ts` — overlay, row action, bulk button, confirmation, summary.
- `src/app.ts` — `isTauriRuntime` + `Desktop` runtime badge.
- `src/styles.css` — PR 28 sections.
- 5 new test files: `desktop-app-config.test.ts` (30), `best-copy-service.test.ts` (22), `master-gap-best-copy.test.ts` (16), `recommended-placement-service.test.ts` (16), `command-center-best-copy.test.ts` (9). Plus 3 added cases to `app-shell-desktop.test.ts` covering the runtime badge.

#### Test totals
- 105 test files, **~1063 tests** (up from 970; +93). Typecheck green. Browser build green.

#### PR 28 review patch — desktop QA harness
After PR 28 was opened the desktop prerequisites (Rust toolchain + MSVC C++ Build Tools + WebView2) were installed on the verification machine, `npm run desktop:dev` was run, and the Tauri window compiled and launched. The review patch adds a deterministic QA harness so that "the desktop app actually starts and the seed reaches every master-gap scenario" can be re-verified on demand without DevTools tricks.

- **Deterministic seed.** `src/qa/qa-seed.ts` exports `QA_SEED_NAME = 'morten-pokemon-qa-v1'` plus the documented count constants (1000 holdings, 200 wishlist, 5 lots × 50 items, 7 binders, 3422 slots, ≤400 assigned). All randomness goes through a Mulberry32 PRNG seeded via FNV-1a hash of the seed name, so two runs on a clean DB produce byte-identical counts. Reset preserves `db.settings` so PR 27 prefs survive a wipe. The seed plants 30 cards × NM+LP holdings (recommended-ambiguous), 30 cards × NM+NM holdings (manual-ambiguous, tied score), reverse-holo template slots, one `invalid_assignment`, and one `invalid_variant` so every master-gap status is exercised.
- **Pure report builder.** `src/qa/qa-report.ts` produces a `QaReport` with overall PASS/FAIL, runtime detection, seed summary, master-gap aggregates, DB counts (alphabetical), route-check table, perf timings, console counts, backup-roundtrip flag, and free-form notes. `evaluateQaPassFail` fails on console errors, failed backup, broken route, missing master-gap snapshot when seeded, or zero recommended/manual ambiguous after seed. Markdown + JSON renderers are pure functions.
- **Runner orchestrator.** `src/qa/qa-runner.ts` exposes `runQa(db, options)` with `reset` / `seed` / `runtime` flags, builds the same dependency bundle the production code uses, snapshots the master-gap dashboard summary, and records perf labels for each step. Detects `tauri` runtime via `__TAURI_INTERNALS__`.
- **Dev-only QA view.** `src/views/qa.ts` mounts at `#qa`. Only registered in `app.ts` when `import.meta.env.DEV` is true — production / Tauri release builds fall through to the dashboard. Buttons: Reset / Seed / Run / Measure-only / Download JSON / Download Markdown. Reports save through `downloadTextFile` (no new Tauri capabilities).
- **Router.** `'qa'` added to the `Route` union; `getCurrentRoute()` recognises `#qa`.
- **npm scripts.** `qa:static` (typecheck + tests + build), `qa:browser` (the four QA test files), `qa:desktop:manual` (prints the L3 recipe), `qa:full` (qa:static + qa:browser).
- **Docs.** `docs/QA_DESKTOP.md` documents the four QA levels, seed contract, L3 desktop recipe, hard rules, and troubleshooting. `.gitignore` adds `.local/` for downloaded reports.
- **Production gating test.** `tests/qa-route-prod-gating.test.ts` reads the actual `dist/` bundle and asserts: (a) zero QA-view strings (`mountQaView`, `morten-pokemon-qa-v1`, `seedStressData`, `QA_SEED_NAME`, `data-action="qa-reset"`, …) leak into release builds; (b) the `qa:` key in the minified `VIEW_MOUNTERS` dispatch object resolves to the same identifier as the `dashboard:` key. Skips itself when `dist/` is missing so a fresh checkout still passes.
- **Tests.** `tests/qa-seed.test.ts` (9 cases — determinism, counts, reset preserves settings, master-gap aggregates after seed, reverse-template marker, tcgplayer.prices.normal present), `tests/qa-report.test.ts` (18 cases — pass/fail rules, markdown shape, JSON shape), `tests/qa-runner.test.ts` (9 cases — four mode combinations, perf labels, route hashes, runtime flag, console-failure path, deps wiring), `tests/qa-route-prod-gating.test.ts` (3 cases — bundle exists, no leaked QA strings, qa-key maps to same mounter as dashboard).
- **Desktop release packaging.** `src-tauri/tauri.conf.json` `bundle.targets` switched from `"all"` to `["msi"]`. The Tauri-downloaded NSIS toolchain (`nsis-3.11` + `nsis_tauri_utils 0.5.3`) errors with `!insertmacro: macro "NSISCOMCALL" requires 4 parameter(s), passed 8!` mid-bundle, which fails `desktop:build` even though the `.exe` and `.msi` are already produced. Limiting targets to MSI gives a clean `desktop:build` exit and the same end-user installer path. Standalone `pokemon-tracker-desktop.exe` (3.4 MB) is still emitted under `target/release/`.

The QA harness writes nothing outside the seed/reset path it owns. No new DB store, no schema migration, no broad Tauri capabilities, no console-tail / FS scraping. Production builds and the merged Tauri binary do not register the route.

#### Verification matrix

```
Baseline:
[x] npm run typecheck before changes — 970 tests
[x] npm test before changes — 970 tests
[x] npm run build before changes — 446 KB JS / 117 KB gzip

Desktop scaffold:
[x] package scripts added (tauri, desktop:dev, desktop:build, desktop:check)
[x] Tauri config present (src-tauri/tauri.conf.json)
[x] capabilities minimal (core:default only)
[x] docs present (docs/DESKTOP_APP.md)
[x] desktop config tests pass (30 cases)

Browser app:
[x] npm run typecheck
[x] npm test
[x] npm run build
[x] browser smoke pass
[x] 0 console errors/warnings

Desktop app:
[x] npm run desktop:dev — VERIFIED. Rust 1.95.0 + MSVC 14.44.35207 + WebView2 147 installed; Tauri window compiled and launched.
[x] npm run desktop:build — VERIFIED with targets:["msi"]; produced standalone exe (3.4 MB) + MSI installer (1.9 MB). NSIS bundle skipped due to upstream toolchain bug.
[x] QA harness reachable at #qa in dev / Tauri dev — VERIFIED via the new automatic QA view + tests
[x] Production #qa gated — VERIFIED via tests/qa-route-prod-gating.test.ts (zero QA strings in dist/, qa: dispatch maps to same mounter as dashboard:)
[x] Deterministic seed: morten-pokemon-qa-v1 (qa-seed test asserts identical counts on re-run)
[x] Both ambiguous types produced by seed (recommendedAmbiguousCount > 0, manualAmbiguousCount > 0)
[ ] L3 manual GUI click-through inside Tauri window — DEFERRED to user pre-merge step (Reset/Seed/Run + walk routes + console check + restart-persistence). Recipe in docs/QA_DESKTOP.md.

Smart placement:
[x] best-copy service tests pass (22)
[x] master-gap recommendation tests pass (16)
[x] recommended placement service tests pass (16)
[x] command center split tests pass (9)
[x] Plasser anbefalt browser smoke pass
[x] Plasser alle anbefalte browser smoke pass

Safety:
[x] no schema migration
[x] no new DB store
[x] no direct binderSlotsRepo.update for recommended placement
[x] PR24 assignHoldingToSlot reused
[x] no PR25 classification change
[x] no fs/shell Tauri permissions
[x] no pricing/value scoring
```

#### Known limitations
- Desktop app does not auto-update.
- Desktop app is not code-signed (Windows SmartScreen will warn on first run of a self-built `.exe`).
- Browser and desktop IndexedDB stores are separate WebView profiles; the user must use Backup → Eksporter / Restore to move data between them.
- Best-copy scoring does not use market value (deliberate — PR 28 hard scope).
- Best-copy scoring does not split `quantity > 1` holdings.
- Tied top scores still require manual choice (no silent disambiguation).
- Desktop build verification depends on local Rust / MSVC / WebView2; this PR's verifier could not run them and the desktop scripts are documented as scaffold-only on this machine.

#### Out of scope
- ❌ Electron / cloud / backend / login
- ❌ Auto-update / code signing / publishing workflow
- ❌ External API calls beyond the existing Pokémon sync
- ❌ Pricing / value layer
- ❌ CardMarket integration
- ❌ Scanner / barcode
- ❌ CSV import
- ❌ Schema migration
- ❌ New IndexedDB store
- ❌ Backup format change
- ❌ Quantity splitting
- ❌ PR 24 assignment rule changes
- ❌ PR 25 master-gap classification changes
- ❌ Broad Tauri filesystem / shell permissions

### Added (PR 27 — Morten personal command center + persistent workspace)
The app is no longer "a Pokémon tracker" — it's Morten's personal Pokémon operating system. Personal preferences persist in the existing settings store; the dashboard gains a prioritised "Arbeidskø" command center; master-gap density / hide-complete / only-actionable / default filter survive page reloads; the topbar brand and default start route are configurable; and a `Snarveier` button surfaces every keyboard shortcut. Workflow polish only — **no schema migration**, **no new IndexedDB store**, **no desktop wrapper**, **no `package.json` desktop scripts**, **no external API**, **no pricing/value lookup**, **no CSV import**, **no scanner**. Existing PR 24 assignment rules and PR 25 master-gap classification semantics are unchanged. Backup format is unchanged.

#### Settings keys added (existing key/value store)
`appDisplayName`, `defaultStartRoute`, `dashboardFocusMode`, `masterGapDensity`, `masterGapHideComplete`, `masterGapOnlyActionable`, `masterGapDefaultFilter`, `commandCenterMaxItems`, `commandCenterShowAllClear`, `showShortcutHints`, `showPersonalWorkspaceSummary`. None of these add a column or index; they're rows in the existing `settings` store.

#### `src/domain/personal-preferences.ts` (new)
Canonical `PersonalPreferences` shape, `DEFAULT_PERSONAL_PREFERENCES`, and per-field normalisers — every field falls back to a safe default when a stored value is invalid. `normalisePersonalPreferences(raw)` turns any partial/untrusted record into a fully-validated preferences object so a single bad row never poisons the rest.

#### `src/services/personal-preferences-service.ts` (new)
Thin wrapper over `settingsRepo`. `getPreferences()` reads every PR 27 key with `Promise.allSettled` (one rejection doesn't break the whole load), normalises each value, and returns a fully-validated `PersonalPreferences`. `updatePreferences(patch)` writes only the keys present in the patch (each normalised before write) and re-reads to return the merged result. Audit row content is the existing `setting "<key>" changed` line — values are never logged.

#### `src/services/command-center-service.ts` (new, pure)
`buildCommandCenterItems({ masterGap, dashboard, preferences })` picks from 13 item kinds: `fix_invalid_slots | place_owned_cards | resolve_ambiguous_owned | follow_up_ordered | wishlist_missing | materialize_lots | collection_missing_condition | collection_missing_value | collection_not_in_binder | collection_duplicates | backup_needed | sync_needed | all_clear`. Sorting: critical first (never trimmed), then focus-mode boost lifts user-prioritised kinds within their severity, then a stable kind-order tiebreak. Output trimmed to `commandCenterMaxItems` (critical preserved). `all_clear` only emits when nothing else is actionable AND `commandCenterShowAllClear` is true.

`MasterGapDashboardSummary` now exposes an aggregated `ambiguousOwned` count (per-binder counts existed already; this is just the sum). PR 25 classification logic is unchanged.

#### Settings UI: "Personlig app" section
New panel in `src/views/settings.ts` with 11 controls (app name, start route, dashboard focus, master-gap density / default filter / hide-complete / only-actionable, command-center max items + show-all-clear, shortcut hints, workspace summary). Save dispatches `SETTINGS_CHANGED_EVENT`. Successful save shows `Personlige valg lagret.`; failure renders an error chip and does NOT dispatch the event.

#### App shell brand + default start route
`src/app.ts` reads preferences on mount: brand text comes from `appDisplayName`, brand href from `#${defaultStartRoute}`. Empty hash navigates to the configured start route — but never overrides an existing hash, including deep links (`#card/`, `#binder/`, `#lot/`, `#master-gap/`). Listens for `SETTINGS_CHANGED_EVENT` to refresh the brand and the shortcut-help button without remounting the app.

#### Master gap persisted preferences
`src/views/master-gap.ts` seeds `density`, `hideComplete`, `onlyActionable`, and `filter` from `PersonalPreferences` on mount. User toggles persist asynchronously via `personalPreferencesService.updatePreferences` — visual changes happen immediately against the cached report; the master-set-gap service is NOT called again. A failed save surfaces in the new `data-region="master-gap-preferences-feedback"` line and never breaks the table.

#### Dashboard command center + personal workspace summary
`src/views/dashboard.ts` adds a `data-region="command-center"` panel under the action strip with a prioritised list of items, each with a severity chip + title + message + (optional) hash-targeted action button. Lazy-loaded alongside the existing Master Set Progress card so the main dashboard render stays fast. When `showPersonalWorkspaceSummary` is on, an additional `data-region="personal-workspace-summary"` block shows app name, holdings count, binder count, master-set %, command-center item count and the top-priority action.

`src/components/personal-workspace-summary.ts` is a small pure-render helper used by the dashboard.

#### Keyboard-shortcut help dialog
`src/components/keyboard-shortcuts-help.ts` adds a `Snarveier` button to the topbar (gated on `showShortcutHints`) that opens the existing dialog component with the full shortcut list (`g d`, `g m`, …, `Ctrl/Cmd + K`, `Esc`). Idempotent mount — repeated calls leave only one button. PR 26's `keyboard-shortcuts.ts` already ignores events inside `[role="dialog"]`, so the dialog is safe.

#### Touched / new files
- `src/domain/types.ts` — extended `SETTINGS_KEYS`.
- `src/domain/personal-preferences.ts` — new.
- `src/domain/master-set-gap.ts` — added aggregated `ambiguousOwned`.
- `src/services/personal-preferences-service.ts` — new.
- `src/services/command-center-service.ts` — new.
- `src/components/personal-workspace-summary.ts` — new.
- `src/components/keyboard-shortcuts-help.ts` — new.
- `src/views/settings.ts` — `SETTINGS_CHANGED_EVENT` + Personlig app section + hydrate/save.
- `src/views/dashboard.ts` — command center, workspace summary, lazy populate.
- `src/views/master-gap.ts` — seed prefs on mount + persist on toggle.
- `src/app.ts` — brand from prefs + default start route + listener for settings change.
- `src/styles.css` — PR 27 sections.
- `tests/personal-preferences.test.ts` — new (25 cases).
- `tests/personal-preferences-service.test.ts` — new (8 cases).
- `tests/command-center-service.test.ts` — new (17 cases).
- `tests/settings-personal-preferences.test.ts` — new (6 cases).
- `tests/app-personal-brand.test.ts` — new (10 cases).
- `tests/master-gap-personal-preferences.test.ts` — new (10 cases).
- `tests/dashboard-command-center.test.ts` — new (12 cases).
- `tests/keyboard-shortcuts-help.test.ts` — new (6 cases).

#### Test totals
- 100 test files, **~967 tests** (up from 873; +94 PR 27 cases). Typecheck green. Build green.

#### Performance
- Dashboard Master Set Progress remains lazy-loaded.
- Command center reuses the same lazy summary; the dashboard does NOT add a second master-gap fetch.
- Master-gap visual preference toggles re-render from the cached report only — verified by spy that `binderSlotsRepo.listLive` is not called on density toggle.
- `mountKeyboardShortcuts` and `mountKeyboardShortcutsHelp` are both idempotent; one global keydown listener total from PR 26 + one DOM button from PR 27.
- No DB write on render; preferences are written only when the user clicks Save, or toggles a master-gap control.
- No new dependency.

#### User-data impact
**None.** Preferences live in the existing settings store. Existing holdings / binders / wishlist / lots / audit log are untouched.

#### Backup/restore impact
**None.** Backup format is unchanged. Settings rows already roundtrip in backups; PR 27 keys ride along automatically.

#### Known limitations
- "Dashboard focus mode" only affects command-center sort order, not which dashboard cards render. Reordering the entire dashboard grid based on focus mode is a future PR.
- Personal workspace summary is a static read of the latest snapshot; it does not deep-link to any card or binder.
- The shortcut help dialog lists shortcuts but does not let the user remap them.
- Command-center max items applies only to non-critical items — critical items ALWAYS render even if they exceed the configured cap. Documented behavior.

#### Out of scope (per the spec)
- ❌ Electron / Tauri / installer / `.exe` / auto-update
- ❌ `package.json` desktop packaging scripts
- ❌ Schema migration / new IndexedDB stores
- ❌ Backup format changes
- ❌ External API calls
- ❌ Pricing / value layer
- ❌ CSV import
- ❌ Scanner / barcode
- ❌ Login / cloud / backend
- ❌ Changes to PR 24 assignment rules
- ❌ Changes to PR 25 master-gap classification rules

### Fixed (F-2 mini-PR — `unlimitedNormal` / `unlimitedHolofoil` variant mapping)
The PR 14 QA report flagged `unlimitedNormal` and `unlimitedHolofoil` as live in pokemontcg.io's response payloads — 837 cards (4.3% of the 19 545-card priced cache), heavy on Base / Jungle / Fossil unlimited holos. PR 11's review had locked them out for safety; the QA fixtures now prove they're real, so they're accepted.

`availableVariants(card)` now maps:
- `unlimitedNormal` → `finish=normal`, `edition=unlimited`
- `unlimitedHolofoil` → `finish=holo`, `edition=unlimited`

Effects:
- Quick Add Raw on a Base/Jungle/Fossil unlimited holo no longer falls through to the escape-hatch path. The form narrows to `holo + unlimited` automatically.
- Cards that expose BOTH `1stEditionHolofoil` and `unlimitedHolofoil` (e.g. Jolteon Jungle `base2-4`) surface both editions in the form so the user can record either.
- `decideQuickAdd` now returns `canQuickAdd=true` for these cards.

Other unrecognised keys (lowercase `firstEdition*`, future tcgplayer keys, cardmarket fields) remain deliberately ignored — same "no guessing" rule.

#### Touched files
- `src/domain/card-variants.ts` — added 2 switch cases + updated header comment.
- `tests/card-variants.test.ts` — 3 new fixture tests (`unlimitedNormal`, `unlimitedHolofoil`, both-editions surface together).
- `tests/quick-add.test.ts` — flipped the F-2 placeholder test (was: `unlimitedHolofoil` rejected; now: accepted as `holo + unlimited`) and added an `unlimitedNormal` companion test plus a "truly unrecognised key" test to keep the no-key-found path covered.

#### Test totals
- 92 test files, **873 tests** (+5 vs PR 26). Typecheck green. Build 420.55 KB JS / 111.03 KB gzip.

#### Out of scope
- Lowercase / weird-cased variants of these keys.
- Edition migration in `WishlistRecord` / `BinderSlotRecord` — the gap analysis still treats edition as informational only.

### Added (PR 26 — Desktop-ready app shell + workspace polish)
PR 26 makes the app feel like a serious desktop workspace without changing any data model. App shell gets stable `data-region` hooks, the dashboard gets a workspace header and a next-best-action sentence inside Master Set Progress, the master-gap report gets a sticky toolbar with density / hide-complete / only-actionable toggles, the binder detail toolbar groups workflow actions vs view controls, and Vim-style keyboard shortcuts (`g d`, `g m`, etc.) land for desktop navigation. Workflow polish only — no schema migration, no new DB stores, no desktop wrapper, no Electron / Tauri / installer, no `package.json` desktop scripts, no pricing/value lookup, no external API.

#### App shell regions (`src/app.ts`)
- `<div class="app-shell" data-region="app-shell">` wraps topbar + layout.
- Topbar carries `data-region="topbar"`, `topbar-brand`, the existing `topbar-search` (preserved verbatim — PR 23 global search still mounts there), and `topbar-status`.
- Brand is now an anchor pointing at `#dashboard` so clicking the title acts like a typical desktop logo home button.
- Sidebar carries `data-region="sidebar"`, content carries `data-region="content"` and keeps `id="content"` so existing CSS / mount targets continue to work.
- Sidebar nav links advertise their keyboard shortcut via `aria-keyshortcuts` (e.g. `aria-keyshortcuts="g d"` on the Dashboard link) so screen readers and devtools can surface them without us shipping a visual hint.

#### Keyboard shortcuts (new component `src/components/keyboard-shortcuts.ts`)
- Vim-style two-key sequences: `g d` Dashboard, `g b` Browse, `g c` Collection, `g p` Permer, `g l` Lots, `g w` Wishlist, `g m` Master gap.
- Single global `keydown` listener; `mountKeyboardShortcuts()` is idempotent so a re-mount (HMR / test) does not double-register. `resetKeyboardShortcutsForTests()` provided for test isolation.
- Pending state expires after 1200 ms; Escape cancels.
- Shortcut is silently ignored when the event target is `<input>`, `<textarea>`, `<select>`, `[contenteditable]`, or any element inside `[role="dialog"]`.
- Modifier chords (Ctrl / Cmd / Alt) are ignored so `Ctrl+G` cannot start the sequence and `Cmd+K` continues to belong to PR 23's global search.

#### View-density helpers (new domain module `src/domain/view-density.ts`)
- Pure types + helpers: `ViewDensity = 'comfortable' | 'compact'`, `viewDensityLabel`, `nextViewDensity`. Per-view in-memory state only — no DB persistence in PR 26.

#### Dashboard workspace polish (`src/views/dashboard.ts`)
- New workspace header under `<h1>Dashboard`: "Kontrollrom for samling, permer, master set og backup." (`data-region="dashboard-workspace"`).
- New `getMasterGapNextAction(summary)` helper picks one sentence based on the same Master Set Progress summary the chips already use. Priority: invalid > can-place-directly > owned-unplaced > ordered > wanted > missing > all-clear. Rendered as `<p data-region="master-gap-next-action">Neste beste handling: …</p>` after the lazy summary populates.
- Master Set Progress card still loads lazy: skeleton paints first, then stats / empty / error replaces it. The main `DashboardSnapshot` is unchanged so dashboard load time stays bounded.
- Dashboard grid now uses an explicit 3 / 2 / 1 column breakpoint set (≥1200, 768–1199, ≤767) instead of `auto-fill minmax(280px, 1fr)` so wide-screen layout is predictable.

#### Master gap view polish (`src/views/master-gap.ts`)
- New table toolbar wraps the existing filter strip plus three new toggles (`data-region="table-toolbar"`).
- Density toggle (`data-action="toggle-density"`): `Tetthet: Kompakt` ↔ `Tetthet: Komfortabel`. Default is compact. Flips the table class between `master-gap-table--compact` and `master-gap-table--comfortable`. Pure cosmetic — does NOT reset `tablePage` and does NOT touch the cached report.
- "Skjul fullførte" (`data-action="toggle-hide-complete"`): drops `complete` rows. Resets `tablePage = 0`.
- "Kun handling" (`data-action="toggle-only-actionable"`): drops `complete` and `blank_slot` via the new `isActionableRow` predicate. Resets `tablePage = 0`. Strictly dominates "Skjul fullførte" — combining both still yields actionable-only.
- Filter order: status filter (PR 25) → hideComplete → onlyActionable → pagination. None of these toggles reload the report; all run in-memory against the cached `MasterGapReport`. Test asserts `binderSlotsRepo.listLive` is not called when density is toggled.
- Toolbar is sticky on screens ≥900px so it stays in view while scrolling a 1088-row report.

#### Binder Detail workspace polish (`src/views/binder-detail.ts`)
- Toolbar buttons are now grouped: view controls (Sider / Sjekkliste, search, filter) on the left, workflow actions (Auto-plasser, Gap-analyse, Eksporter sjekkliste) on the right.
- Gap summary banner exposes `data-region="binder-gap-summary"` (PR 25's `data-region="gap-summary"` is preserved for callers that already use it). Banner text order is unchanged: `Master gap: X / Y fullført · Z mangler · A eies men ikke plassert · B ønsket · C bestilt · D feil`, with `· E kan plasseres` appended only when `canPlaceDirectlyCount > 0`.
- `Gap-analyse` toolbar still routes to `#master-gap/<binderId>`; no new query params.

#### CSS / desktop layout (`src/styles.css`)
- Sticky sidebar on screens ≥1200px (anchored under `--topbar-height`).
- Dashboard grid: 3 / 2 / 1 columns at 1200 / 768 / <768 breakpoints.
- Master gap thead is sticky at ≥900px, offset by `--topbar-height + table-toolbar height` so column headers never disappear when scrolling.
- Compact density: `padding-block: 0.35rem`, `font-size: 0.875rem`. Comfortable density: `padding-block: 0.65rem`.
- Row actions wrap cleanly; binder toolbar action group floats right on desktop, stacks naturally on narrow widths.
- All new selectors are clearly delimited by `/* PR 26 — … */` comment headers.

#### Touched / new files
- `src/app.ts` — shell wrapper, data-regions, keyboard-shortcut mount.
- `src/components/keyboard-shortcuts.ts` — new.
- `src/domain/view-density.ts` — new.
- `src/views/dashboard.ts` — workspace header, `getMasterGapNextAction` (exported for tests), next-best-action render.
- `src/views/master-gap.ts` — table toolbar, density / hideComplete / onlyActionable, filter composition.
- `src/views/binder-detail.ts` — toolbar grouping, banner data-region.
- `src/styles.css` — PR 26 desktop sections.
- `tests/keyboard-shortcuts.test.ts` — new, 19 cases.
- `tests/app-shell-desktop.test.ts` — new, 9 cases.
- `tests/dashboard-workspace.test.ts` — new, 14 cases.
- `tests/master-gap-desktop-polish.test.ts` — new, 15 cases.

#### Test totals
- 92 test files, **867 tests** (up from 810). Typecheck green. Build green.

#### Performance
- Dashboard Master Set Progress remains lazy-loaded; the main `DashboardSnapshot` does not start loading the cards/sets list.
- Master-gap density / hide-complete / only-actionable toggles re-render from the cached report — verified by spy: `binderSlotsRepo.listLive` is not called on density toggle.
- Single global `keydown` listener; idempotent mount.
- CSS layout uses media queries only — no JS measurement loops.

#### Known limitations
- View density is per-mount in-memory state. Reloading the page or switching routes resets it to compact. Persisting density across sessions would need a settings entry; explicitly out of scope for PR 26.
- Sticky thead offset assumes the standard topbar + table-toolbar combined height; very small viewports may stack differently and the offset is rounded to a constant.
- Keyboard shortcut hint is exposed only via `aria-keyshortcuts` attributes — no visible cheatsheet UI in this PR.

#### Out of scope (per the spec)
- ❌ Electron / Tauri / desktop wrapper / installer / .exe / auto-update
- ❌ `package.json` desktop packaging scripts
- ❌ Schema migration / new IndexedDB stores
- ❌ Backup format changes
- ❌ Pricing / value layer
- ❌ External API calls
- ❌ CSV import
- ❌ Scanner / barcode
- ❌ Login / cloud / backend
- ❌ Changes to PR 24 assignment rules
- ❌ Changes to PR 25 master-gap classification rules

### Added (PR 25 — Master set gap analysis + dashboard intelligence)
PR 25 adds a read-only analysis layer that answers — per binder slot — what is complete, what is missing, what is owned but unplaced, what is on the wishlist, what is in a lot, what can be placed directly, and what is invalidly assigned or has the wrong variant. PR 24 made binders practical to fill; PR 25 makes the app intelligent about it. Workflow only — no schema migration, no schema fields added, no pricing/value changes, no global search changes.

#### Review patch (lot-finish gate + weighted dashboard average)
The first revision left two correctness gaps that surfaced in code review:

1. **Lot coverage matched cardId only**, ignoring `LotItemRecord.finish`. A reverse-holo template slot was reported as `in_lot_unmaterialized` even when the lot only contained the normal print of that card. Fixed in `classifySlot`: the lot filter now requires `li.finish === required.finish` when `required.finish !== null`. Edition is still informational only — `WishlistRecord` carries no edition, so adding edition as a hard gate would surface false negatives in the same row. Three new service tests cover the rule (reverse template + normal lot → missing; reverse template + reverse_holo lot → in_lot; normal slot + reverse_holo-only lot → missing).

2. **`averageCompletionPercent` was an unweighted mean** of per-binder completion %, so an empty binder with `totalTargetSlots=0` dragged the global Dashboard average down by counting equally with a 100-slot binder. Switched to **weighted by total target slots**: `averageCompletionPercent = totalTargetSlots === 0 ? 0 : round(complete / totalTargetSlots * 100)`. New service test #23 verifies that a (1/1=100%) binder + (0/100=0%) binder yields a weighted 1%, not the unweighted 50%. Per-binder `completionPercent` is unchanged; this only affects the cross-binder rollup.

Also: the multi-slot performance test was renamed from "1088-slot" to "multi-slot" to match the actual fixture (50 slots — call-count invariance proves the no-per-slot-Dexie contract; the QA-data smoke test confirms the same on 1088-slot Vault X 16-pocket binders).

#### Locked rules (carried forward)
- Read-only service. Writes only happen when the user clicks an existing safe action (`Plasser`, `Velg holding`, `Legg i ønskeliste`).
- No schema migration. `BinderSlotRecord` still has no `finish` / `edition` field; reverse-holo encoding stays in `note` via `REVERSE_HOLO_TEMPLATE_MARKER`.
- `tcgplayer.prices` is variant truth. The required-finish derivation reuses `availableVariants(card)` from `domain/card-variants.ts` — no rarity / set-name guessing.
- Reverse-holo template slots require `finish=reverse_holo`. A normal-finish holding bound to a reverse template surfaces as `invalid_variant`, never `complete`.
- Normal target slots never invent phantom reverse-holo gaps. Holo-only cards may require `holo` when no `normal` printing exists.
- Ambiguous matches (>1 unassigned matching holding) are never auto-picked — user picks via the existing assign modal.
- PR 24's `assignHoldingToSlot` is reused for placement; the gap view never duplicates the slot-write contract.
- Edition is informational only in PR 25 — `WishlistRecord` carries no `edition`, so introducing a hard edition match would surface false negatives.

#### New domain module: `src/domain/master-set-gap.ts`
- 11 status classes: `complete | missing | owned_unplaced | wishlist_wanted | wishlist_ordered | in_lot_unmaterialized | ambiguous_owned | invalid_assignment | invalid_variant | unverified_variant_data | blank_slot`.
- `deriveRequiredVariant(slot, card)` — reverse template → `reverse_holo`; otherwise the first available finish (`normal` > `holo` > `reverse_holo`); cards with no recognised tcgplayer keys mark `verified=false`.
- `classifySlot(slot, deps)` — pure classifier consuming pre-built lookups so the service can run a 1088-slot binder without per-slot work.
- `buildBinderSummary` + `buildDashboardSummary` — aggregates that drive the dashboard card and binder banner. `closestBinder` is the highest-completion binder under 100%; `weakestBinder` is the lowest.
- `STATUS_LABEL_NB` — Norwegian status labels for the UI (never exposes the raw `template:reverse_holo` token).

#### New shared service: `src/services/master-set-gap-service.ts`
- `createMasterSetGapService(deps)` returns `{ buildBinderReport, buildDashboardSummary }`.
- Bulk-load contract: one `listLive()` call per store (binders / binderSlots / holdings / wishlist / lotItems) plus one `cardsRepo.list()` and `setsRepo.list()` (PR 21 caches handle 20k cards / 172 sets without going to disk twice). The 22nd test asserts via repo spies that `holdingsRepo.listByCardId`, `wishlistRepo.listByCardId`, `lotItemsRepo.listByCardId`, and `binderSlotsRepo.listByBinderId` are NEVER called during a binder report — proving the no-per-slot-Dexie contract.
- Service never dispatches `USER_DATA_CHANGED_EVENT`. The view fires it once after a successful `Plasser` click.

#### Router additions: `src/router.ts`
- New `'master-gap'` route. Two URL forms — `#master-gap` (binder selector view) and `#master-gap/<binderId>` (full report).
- `navigateToMasterGap()`, `navigateToMasterGapBinder(binderId)`, `getCurrentMasterGapBinderId()`.
- Malformed encoding → null. Bare `#master-gap/` falls through the master-gap route with no binder id (selector view handles it).

#### New view: `src/views/master-gap.ts`
- Selector mode (no binder id): dashboard summary chips + clickable binder list with completion %, candidate counts and feil counts.
- Report mode (binder id): per-binder header (counts + `Åpne perm`), filter strip (`Alle | Mangler | Eier ikke plassert | Ønsket / bestilt | Lot | Feil`), table with `Side | Kort | Set | Finish | Status | Reason | Handlinger`, in-memory filter (no DB roundtrip), pagination at 50 rows per page.
- Per-row actions match the status: `Åpne kort`, `Gå til slot`, `Legg i ønskeliste`, `Plasser` (only `owned_unplaced` with `canPlaceDirectly`), `Velg holding` (ambiguous → existing assign modal), `Åpne wishlist`, `Åpne lot`. `invalid_*` rows surface critical styling but do NOT auto-fix anything.

#### Dashboard "Master Set Progress" card
- Lazy-loaded in `src/views/dashboard.ts` so the main `DashboardSnapshot` (which only does `count()` for cards/sets) stays light. Skeleton paints first; counts populate when `buildDashboardSummary()` resolves.
- Average completion %, total target slots, complete, missing, owned-unplaced, wanted, ordered, in lots, invalid, can-place-directly, plus `Nærmest komplett` / `Svakeste` quick-jumps to `#master-gap/<binderId>`.
- Refreshes on `USER_DATA_CHANGED_EVENT` and `SYNC_STATUS_CHANGED_EVENT` via the existing dashboard refresh path.
- Service throw renders an inline error chip; the rest of the dashboard keeps rendering.

#### Binder Detail summary banner + toolbar
- New banner above the toolbar: `Master gap: A / B fullført · X mangler · Y eies men ikke plassert · Z ønsket · W bestilt · V feil`. When `canPlaceDirectlyCount > 0`: append `· N kan plasseres direkte`. `Vis gap` button → `#master-gap/<binderId>`.
- New toolbar button: `Gap-analyse` → `navigateToMasterGapBinder(binder.id)`.
- Banner is lazy-loaded with the same pattern as the dashboard card so it never blocks the binder render.

#### Touched / new files
- `src/domain/master-set-gap.ts` — new.
- `src/services/master-set-gap-service.ts` — new.
- `src/views/master-gap.ts` — new.
- `src/router.ts` — `'master-gap'` added to `Route`, prefix parsing, three navigation helpers.
- `src/app.ts` — `master-gap` registered in `VIEW_MOUNTERS`.
- `src/views/dashboard.ts` — Master Set Progress card builder + lazy populate.
- `src/views/binder-detail.ts` — `Gap-analyse` toolbar button + lazy gap summary banner.
- `src/styles.css` — `.master-gap-view*`, `.master-gap-table*`, `.master-gap-row*`, `.binder-detail-view__gap-summary*`, `.binder-detail-view__gap-analysis`, `.dashboard-card__loading`, `.dashboard-card__empty` (~280 LOC).
- `tests/master-set-gap-service.test.ts` — new, 26 cases covering every status class + aggregations + the no-per-slot-Dexie performance contract + 4 review-patch cases (lot-finish mismatch × 3, weighted dashboard average).
- `tests/router-master-gap.test.ts` — new, 5 cases (route resolution, decode, malformed input, navigation helpers).
- `tests/master-gap-view.test.ts` — new, 11 cases (loading / selector / report mode, filter, `Plasser` only on canPlaceDirectly, `Velg holding` for ambiguous, invalid_variant styling, soft-deleted binder, wishlist row).
- `tests/dashboard-master-gap.test.ts` — new, 7 cases (card render, lazy populate, empty state, navigation, refresh on event, error survival).

#### Test totals
- 88 test files, **810 tests** (up from 761; +4 review-patch cases). Typecheck green. Build green.

#### Known limitations
- Edition is not part of the matching key in PR 25. A wishlist row for `first_edition` and a holding for `unlimited` of the same card+finish still match here because the wishlist/binder schemas don't carry edition. A future PR would need a schema migration to tighten this.
- `unverified_variant_data` is reported but never auto-fixed. The user must edit the underlying data (sync the cache, or override via the existing escape-hatch path).
- "Best copy" preference for `owned_unplaced` (NM > LP, ungraded > graded) is intentionally not implemented — this matches PR 24's explicit deferral. `ambiguous_owned` covers the >1-candidate case.
- Lot navigation from a row picks the first unmaterialised lot item; lots with multiple matching items still all link to the same lot detail.

#### Out of scope (per the spec)
- ❌ Desktop wrapper / Electron / Tauri / installer / .exe / auto-update
- ❌ Pricing / value layer
- ❌ CSV import
- ❌ Scanner / barcode
- ❌ Wishlist edition migration / new schema fields
- ❌ Quantity splitting (per-unit physical placement)
- ❌ Best-copy logic
- ❌ Cross-binder optimisation
- ❌ Automatic purchase recommendations
- ❌ External price lookup
- ❌ Schema migration

### Added (PR 24 — Binder direct-add / auto-assign holdings)
PR 24 makes binders practical to fill. Before this PR, getting an owned card into the right slot required scrolling to the slot, opening the assign modal, picking the holding from a list, and submitting — fine for one slot, painful for a 360-slot master set. Workflow only — no schema migration, no master-set gap analysis, no pricing/value, no global search changes.

#### Review patch — one-holding-one-slot enforcement
The first revision left an assignment-contract hole: the existing `assign-holding-modal.ts` called `binderSlotsRepo.update()` directly, so the same physical holding could be bound to two live binder slots if a user opened the modal twice. The PR 24 spec is explicit that **one physical holding → one physical slot** until per-unit splitting lands in a future PR.

Patched in the review round before merge:
- `assignHoldingToSlot()` now enforces the rule at the service layer: a holding already bound to a different live slot is rejected with `SlotAssignmentError('Holdingen er allerede plassert i en annen slot.')`. Reassigning the same holding to its current slot is still legal (no-op-style update). The check uses `binderSlotsRepo.listLive()` once and excludes the current slot.
- `findAssignableHoldingsForSlot()` now filters out holdings already assigned to a different live slot via the same `getAssignedHoldingIds()` helper. The `Kan plasseres` badge and `Plasser` action no longer surface holdings the service would reject anyway.
- `assign-holding-modal.ts` was migrated to call `assignHoldingToSlot()` instead of writing through `binderSlotsRepo.update()` directly. The modal's candidate list was also tightened to drop holdings bound to other live slots; the slot's own current holding stays selectable so the existing "Bytt holding" reassign UX keeps working.
- 4 new service tests + 3 new modal tests cover the contract.

The contract now applies to **every** assignment path: auto-assign, single-slot `Plasser`, direct-add, and the existing assign modal.

#### Locked rules (carried forward from PR 8a / KRAVSPEC §6)
- `owned` only via real holding. Direct-add creates the holding first, then assigns; auto-assign only places existing holdings.
- One physical holding → one physical slot. A `holding.quantity > 1` row can only land in a single slot. Per-unit placement / split-holding is a future PR (documented as known limitation).
- Target slots filter to `holding.cardId === slot.targetCardId`.
- Reverse-holo template slots only accept `finish === 'reverse_holo'`.
- Blank slots (`targetCardId === null`) are NEVER auto-assigned — user picks via the existing assign modal.
- Already-owned slots are NEVER overwritten.
- Multiple eligible candidates → skipped as ambiguous (no best-copy guessing in v1).
- Clearing rules unchanged (`Tøm slot` still preserves `targetCardId` + `note`).

#### New shared service: `src/services/binder-assignment-service.ts`
- `findAssignableHoldingsForSlot(deps, slot)` — per-slot candidate lookup applying the cardId + finish + soft-delete + already-owned rules.
- `findAllAssignableForBinder` is folded into the auto-assign path internally; the UI uses a per-render `computeAssignableInfo` helper that builds `holdingsByCardId` + `assignedHoldingIds` once per render so a 1088-slot binder costs **one Dexie holdings call**, not 1088.
- `assignHoldingToSlot(deps, slot, holding, slotsPerPage)` — slot-write contract with cardId / finish gates and target-backfill for blank slots.
- `autoAssignBinder(deps, { binderId })` — deterministic 1:1 placement across the binder. Returns `{ assigned, skippedAlreadyOwned, skippedNoTarget, skippedNoHolding, skippedAmbiguous, skippedWrongVariant }`. **Service never dispatches** `USER_DATA_CHANGED_EVENT`; the UI fires it once after the call.
- `createHoldingForSlotAndAssign(deps, slot, slotsPerPage, input)` — direct-add: holding-create then slot-assign with rollback (soft-delete the holding) if the slot-assign fails.

#### New direct-add component: `src/components/slot-direct-add-form.ts`
Smaller variant of the holding form scoped to the target slot. `cardId` is fixed; reverse-holo template slots lock the finish select to `reverse_holo`. Final variant validation still runs at the repo layer; this form does pre-validation only for inline UX. On submit it calls `createHoldingForSlotAndAssign`, dispatches `USER_DATA_CHANGED_EVENT`, and returns the new holding via an `onCreated` callback so the caller (binder-detail) can fire the wishlist receive prompt.

#### Binder Detail UI changes
- **Toolbar:** new `Auto-plasser matching holdings (N)` button. Enabled whenever there's at least one missing target slot — even with 0 candidates it surfaces the report ("X mangler holding") so the user understands why nothing happened. Result banner shows `Auto-plassering fullført: A plassert, B mangler holding, C allerede fylt, D tvetydige[, E feil variant].` with a `Lukk` button. Successful assignments dispatch a single `USER_DATA_CHANGED_EVENT`.
- **Slot tile:** `Kan plasseres` badge when at least one matching unassigned holding exists for the slot (count appended when > 1). New `Plasser` action when exactly one candidate is eligible — single click, no modal. New `Legg til her` direct-add action for missing target slots only (blank slots route through the existing `Tilordne holding` modal, where the user can search the entire collection).
- **Checklist row:** same `Kan plasseres` badge alongside the status cell, plus `Plasser` and `Legg til her` actions matching the grid.
- **Wishlist receive prompt** runs after a successful direct-add when the just-created holding matches an active wishlist row (cardId + finish). Auto-assign does NOT trigger the prompt — it's physical organization, not new acquisition.

#### Performance
Per-render assignable scan is built from a single `holdingsRepo.listLive()` call + the slots already in `BinderDetail`. The cached info follows `BinderDetail` lifecycle: `USER_DATA_CHANGED_EVENT` invalidates both. No per-slot Dexie queries even for 1088-slot Vault X 16-pocket binders.

#### Browser-verified (preview server, real QA stress data)
- `Plasser` flow: created a target slot for `bw11-44` (single unassigned holding), badge read "Kan plasseres", click → slot status flipped to `owned` with `holdingId` set, warm render 101 ms.
- Auto-assign flow: 3 target slots × 3 single-match cards → button label "Auto-plasser matching holdings (3)", click → summary "3 plassert, 0 mangler holding, 0 allerede fylt, 0 tvetydige", all 3 slots became `owned`, total round-trip ~800 ms.
- Wishlist receive prompt fires when the direct-add holding matches an active wishlist row.

#### Touched / new files
- `src/services/binder-assignment-service.ts` — new.
- `src/components/slot-direct-add-form.ts` — new.
- `src/views/binder-detail.ts` — `ViewState` extensions (`assignableInfo`, `autoAssignSummary`), toolbar button + summary banner, slot-tile + checklist badge & actions, `handlePlaceEligible` + `openDirectAdd` handlers.
- `src/styles.css` — `.binder-detail-view__auto-assign*`, `.binder-detail-view__auto-summary*`, `.binder-slot__assignable-badge`, `.checklist-table__assignable-badge`, `.binder-slot__action--success`, `.checklist-table__action--success`, `.slot-direct-add-wrap`.
- `tests/binder-assignment-service.test.ts` — new, 28 cases incl. **review patch** (per-slot candidates, assign-write contract, auto-assign 1:1 / ambiguous / blank / already-owned / reverse-template / no double-assign / event silence, direct-add success / target-only / finish gate / rollback / holdings.create rejection (case 15), soft-deleted slot/binder, **`assignHoldingToSlot` rejects holding bound to another live slot, allows same-slot reassign, ignores soft-deleted slot assignments, `findAssignableHoldingsForSlot` filters out cross-slot duplicates**).
- `tests/binder-direct-add.test.ts` — new, 14 cases (toolbar button + state, badge, Plasser flow, Auto-plasser summary, ambiguous / wrong-variant report, Legg til her gating, **clicking Legg til her opens form + submit creates holding + assigns slot**, **reverse-holo template direct-add locks finish=reverse_holo**, checklist row badge + Plasser, no-double-assign).
- `tests/assign-holding-modal-search.test.ts` — +3 review-patch cases (target slot hides cross-binder-bound holdings, blank slot hides them, modal save routes through service and rejects stale ids).

#### Test totals
- 84 test files, **761 tests** (up from 716). Typecheck green. Build green (388 KB JS / 103 KB gzip).

#### Known limitations
- Holdings with `quantity > 1` count as one assignable slot. Splitting into per-unit physical placements is a future PR.
- "Best copy" logic (NM > LP, ungraded > graded, etc.) is intentionally not implemented in v1 — multiple candidates are skipped as ambiguous and the user picks via the existing assign modal.
- Blank-slot direct-add is not implemented; blank slots route through the existing `Tilordne holding` modal which can search the entire collection.

#### Out of scope (per the spec)
- ❌ Master set gap analysis (PR #25)
- ❌ Pricing / value
- ❌ CSV import
- ❌ Scanner / barcode
- ❌ Global search changes
- ❌ Wishlist edition migration
- ❌ Bulk import
- ❌ Cross-binder optimization
- ❌ Duplicate management dashboard
- ❌ Virtualisering (page-at-a-time + 50-row checklist already cap DOM cost)
- ❌ New binder schema
- ❌ Full "best copy" grading logic

### Added (PR 23 — Global search / Card status center)
PR 23 adds the missing control surface: a topbar search input that aggregates `cards` + `holdings` + `wishlist` + `binderSlots` + `lotItems` for one card and exposes hurtigknapper that go through existing services. Before this PR the user had to know which view to open to find a card's status; now one search field answers "Hva eier jeg av dette kortet, hvor ligger det, hva mangler?". Workflow only — no schema migration, no new datamodel, no new route.

#### Review patch (lifecycle + stale-search hardening)
PR 23 lives outside the route lifecycle (it's mounted into the app shell once, never re-mounted by the router), so two leaks the first revision left in were patched before merge:

1. **Listener cleanup is complete.** A single `AbortController` now gates every global listener — `window.keydown`, `document.click`, `onUserDataChanged`, and (via the cleanup return) `onRouteChange`. `_resetGlobalSearchForTests()` aborts the controller, dropping every one in one call. Verified by a test that mounts → opens panel → resets → asserts `USER_DATA_CHANGED_EVENT`, `hashchange`, and `Cmd+K` all become no-ops.
2. **Stale async search results are dropped.** `runSearch` now captures a sequence number + the query string at start and bails after the await if either has moved on. Without this, an old slow search resolving after a newer fast one would overwrite the dropdown with stale matches (the classic "type charizard then immediately pikachu, slow first call returns last → wrong rows shown" race). Verified in browser: typed `charizard` → switched to `pikachu` within 30 ms → dropdown shows only Pikachu hits, no stale Charizard.
3. **`Marker mottatt` button gates on actual finish-matching candidates.** Earlier the button showed when "any active wishlist + any holding" existed and could land the user on a dead-end alert if the finishes didn't match. `CardStatus.summary.receiveCandidateCount` now drives the button visibility — only shows when `findReceiveCandidatesForHoldings` would actually return something. Verified in browser: holo holding + reverse_holo wishlist → button hidden; add a holo wishlist → button reappears.

#### Architecture
- **Topbar input + Cmd/Ctrl+K** — the search slot lives in the existing app shell (`src/app.ts`). No modal, no `#search` route. Live debounced dropdown anchored to the input. Click a hit → lightweight Card Status panel as an overlay; `Åpne kort` navigates to the existing Card Detail view.
- **Search rule reuse** — `domain/card-search.cardMatchesQuery` (PR 15A — F-6) is reused unchanged. No drift from Browse / Collection / Wishlist behaviour.
- **No view-internal cross-imports** — Quick Add was lifted out of `views/browse.ts` into a new shared helper so global search uses the same pure path. Browse continues to handle its own DOM-side feedback chip; the helper does the repo write + receive-candidate lookup.

#### New shared services
- `src/services/quick-add-service.ts` — `quickAddRawCard(deps, card)`: runs `decideQuickAdd` → `holdingsRepo.upsertByVariant` → `findWishlistReceiveCandidates`. Throws `QuickAddNotEligibleError` on cards without verified variants. Used by global search now; Browse can migrate later without scope creep.
- `src/services/global-search-service.ts` — `searchGlobalCards(db, query, { limit })`. Builds `Set` indexes once for owned / active wishlist / binder / unmaterialised lot, then walks the cards-cache (PR 21) once. Default limit 20, expanded 100. Ranking: exact id (1000) → compound query (200) → owned (60) → active wishlist (30) → in binder (10) → unmaterialised lot (5) → name-startsWith (25) → set release year capped to ±25..40.
- `src/services/card-status-service.ts` — `getCardStatus(deps, cardId)`: aggregates per-card holdings (live), wishlist (active vs closed), unmaterialised lot items, and binder slots (delegated to PR 17's `binder-slot-service.slotsForCardId`). Throws `CardStatusNotFoundError` for unknown ids.

#### Component
- `src/components/global-search.ts` — topbar input + dropdown + status panel. Cmd/Ctrl+K focus, Escape closes, click-outside closes (with `stopPropagation` on dropdown/panel clicks so the document-level outside-click handler can't race the row click and close the panel before status loads). `USER_DATA_CHANGED_EVENT` refreshes any open panel + the dropdown badges. Route changes close everything. Idempotent per slot (`dataset.globalSearchMounted` flag) so test harnesses can re-mount.

#### Hurtigknapper i panelet
- `Åpne kort` → `navigateToCard(cardId)`
- `+1 raw` → `quickAddRawCard` + opens receive prompt when active wishlist matches
- `Legg i ønskeliste` → `openDialog(buildWishlistForm({ mode: 'add', cardId }))`
- `Marker mottatt` (only when both holdings AND active wishlist exist) → `findReceiveCandidatesForHoldings` + `openWishlistReceivePrompt`
- `Gå til side X.Y` per binder-slot → `navigateToBinderSlot(binderId, slotId)` (PR 17 deep-link)
- `Åpne lot` per unmaterialised lot-item → `navigateToLot(lotId)`

#### Performance contract
Cards/sets via PR 21 cache; per-search reads of holdings/wishlist/binderSlots/lotItems built into O(1) Set indexes. Status panel delegates binder lookup to `binder-slot-service.slotsForCardId`.

| Operation | Measured | Target |
|-----------|---------:|-------:|
| Cold global search over 20 237 cards | **173 ms** | < 600 ms |
| Warm global search (cards/sets cache hit) | **22 ms** | < 50 ms |
| Warm second search (different query) | **21 ms** | < 50 ms |
| Cold status panel load (real data + binder-slot service) | **~611 ms** | bounded by binder-slot service, acceptable for one-time per-card load |

#### Touched / new files
- `src/services/quick-add-service.ts` — new.
- `src/services/global-search-service.ts` — new.
- `src/services/card-status-service.ts` — new.
- `src/components/global-search.ts` — new.
- `src/repositories/lot-items-repo.ts` — added `listByCardId(cardId)` using the existing `cardId` index from `db/schema.ts`. No schema migration.
- `src/app.ts` — topbar shell now has a `data-region="topbar-search"` slot; `setupTopbar` mounts the global-search component there.
- `src/styles.css` — `.topbar__search`, `.global-search*`, `.global-search__panel*` (~210 LOC).
- `tests/quick-add-service.test.ts` — new, 6 cases.
- `tests/global-search-service.test.ts` — new, 13 cases incl. badge filter for unmaterialised-only lot items.
- `tests/card-status-service.test.ts` — new, 8 cases (incl. review-patch `receiveCandidateCount` cases).
- `tests/global-search-component.test.ts` — new, 14 cases (incl. review-patch lifecycle + stale-search + receive-button gate cases).

#### Test totals
- 82 test files, **716 tests** (up from 675). Typecheck green. Build green (371 KB JS / 99 KB gzip).

#### Browser-verified
- Topbar input mounts; `Cmd+K` / `Ctrl+K` focuses it; `Escape` closes panel; click-outside closes both dropdown and panel.
- Search "charizard" over the 20 237-card stress cache → 20 hits in 173 ms cold, 22 ms warm. First Charizard hit shows badges `Eid` + `Lot` matching the live data.
- Click hit → status panel opens with section counts (Dine kort / Permer / Ønskeliste / Ufordelte lot-items). `+1 raw` on Pokémon Center (base4-114, previously unowned) wrote the holding (0 → 1).
- After Quick Add, the panel is refreshed via `USER_DATA_CHANGED_EVENT`.
- Lot badge fires only for unmaterialised items so the dropdown badge matches what the panel shows (badge said `Lot`, panel showed `Ufordelte lot-items` — tests + the live data confirmed the match).

#### Out of scope (per the user's instruction)
- ❌ Pricing / value layer
- ❌ CSV import
- ❌ Schema migration / new wishlist fields (edition, language)
- ❌ Binder direct-add / auto-assign holdings (PR #24)
- ❌ Master set gap analysis (PR #25)
- ❌ Bulk operations from search
- ❌ Dedicated `#search` route
- ❌ Search history / saved searches
- ❌ Note search (holdings / wishlist / lot notes)
- ❌ Cross-page keyboard result navigation
- ❌ Virtualised result list — top 100 covers v1

### Added (PR 22 — Wishlist receive flow / active vs closed)
PR 22 closes the wishlist workflow loop: when a card lands in holdings, the app now offers to flip the matching wishlist row to `received`. Before this PR, a card could be both "owned" and "wanted/ordered" with no built-in path to close the wishlist entry; in long sessions that drift turned the wishlist into noise. Workflow only — no new datamodel, no schema migration.

#### Review patch — Card Detail banner respects finish
The first revision of the conflict banner pulled holdings + active wishlist for the cardId only and offered to mark them all received in one click. That broke the PR 22 match rule (`cardId + finish`). With it, owning Charizard `normal` + wishing Charizard `reverse_holo` would surface a banner that, when confirmed, would close the `reverse_holo` row even though the user never received that variant.

Patched before merge:
- `buildOwnedActiveWishlistBanner` now routes through `findReceiveCandidatesForHoldings(wishlistRepo, liveHoldings)` — the same shared helper Quick Add / Bulk Add / Lot Materialise use. The banner only appears when at least one candidate matches `cardId + finish + active + live`, and it carries exactly those candidates.
- The banner button no longer auto-marks. It opens the existing receive prompt with the matched candidates so the user keeps the same checkbox UX (`exact` checked, `condition_mismatch` unchecked) as the rest of the receive flow.
- Per-row `Marker mottatt` on the Card Detail wishlist table stays as a direct action — that one is an explicit single-row click, so re-opening the prompt would be friction without payoff.
- Three new tests in `tests/card-detail-with-wishlist.test.ts`: owned `normal` + wishlist `reverse_holo` hides the banner; owned `holo` + multi-finish wishlist surfaces only the `holo` candidate in the prompt; `condition_mismatch` candidate appears unchecked and is left active when submitted as-is.
- Browser-verified: with two holdings (`normal` + `holo`) and two wishlists (`normal` + `holo`), banner reads "Marker 2 som mottatt" and the prompt lists both ids; with only `normal` holding + only `holo` wishlist, banner is hidden.

#### Definitions (locked in `src/domain/wishlist-status.ts`)
- **Aktiv wishlist:** `wanted | ordered`
- **Lukket wishlist:** `received | cancelled`

`isActiveWishlistStatus`, `isClosedWishlistStatus`, `wishlistStatusLabel`, plus `ACTIVE_WISHLIST_STATUSES` / `CLOSED_WISHLIST_STATUSES` constants — single source of truth so views can't drift on what counts as "open".

#### Service (`src/services/wishlist-receive-service.ts`)
- `findWishlistReceiveCandidates(repo, holding)` — match rule: `cardId === cardId && finish === finish && status ∈ active && deletedAt === null`. Returns `{ wishlist, matchType, reason }` per candidate. Sort: ordered → wanted; priority desc; updatedAt desc.
- `findReceiveCandidatesForHoldings(repo, holdings[])` — batch helper for Bulk Add / Lot Materialise. Dedupes by `wishlist.id`.
- `markWishlistCandidatesReceived(repo, ids[])` — flips status to `received` via `wishlistRepo.update`, so the existing audit + variant validator path runs unchanged. Returns the updated records.
- Match types: `exact` (default-checked in the prompt) or `condition_mismatch` (default-unchecked when `wishlist.targetCondition` is set and the holding's `rawCondition` differs).

#### Receive-prompt dialog (`src/components/wishlist-receive-prompt.ts`)
- Reused by every write-path. One dialog, one click, never one modal per card.
- Exact matches default-checked; condition_mismatch starts unchecked (user opt-in).
- "Ikke nå" closes without writes; "Marker som mottatt" goes through `markWishlistCandidatesReceived` and dispatches `USER_DATA_CHANGED_EVENT` once.

#### Integration points
- **Full holding form** (`src/components/holding-form.ts`): after a successful create, opens the prompt with single-card candidates.
- **Browse Quick Add** (`src/views/browse.ts`): single `runQuickAddRaw` runs the prompt for the row's holding right after the success chip flashes.
- **Browse Bulk Add** (`src/views/browse.ts`): the post-bulk summary banner now carries a `Marker N som mottatt` button that opens the prompt with the deduped batch — no per-card modals. Failures + skips stay listed; the banner's existing `Lukk` still dismisses cleanly.
- **Lot Materialise** (`src/views/lot-detail.ts`): after `materializeHoldings`, the prompt fires once for the deduped batch of `result.created`.
- **Card Detail conflict banner**: when the card has both live holdings AND an active wishlist row, a banner above the holdings table offers `Marker som mottatt` (single) or `Marker alle N som mottatt` (multi), going through the same service.
- **Wishlist view per-row action**: `Marker mottatt` button on every active row (wanted/ordered, live). Hidden on received/cancelled/deleted rows.
- **Wishlist view counts header**: split from `${liveTotal} aktive · ${deletedTotal} slettede` to `Aktive: X (Ønsket: A · Bestilt: B) · Mottatt: C · Avbrutt: D · Slettede: E · Matcher filteret: F`. Service exposes `statusCounts: Record<WishlistStatus, number>` plus `activeTotal` / `closedTotal` so the view can label without a second list call.

#### Match rule (PR 22 v1)
`cardId + finish + active + live`. Edition-aware matching is **not** in this PR because `WishlistRecord` does not carry an `edition` field — adding one would be a schema migration, out of scope. Same reason `targetCondition` is treated as a soft check (badge + opt-in) rather than a hard filter.

#### Touched files
- `src/domain/wishlist-status.ts` — new.
- `src/services/wishlist-receive-service.ts` — new.
- `src/services/wishlist-service.ts` — `WishlistResult` now exposes `statusCounts`, `activeTotal`, `closedTotal`.
- `src/components/wishlist-receive-prompt.ts` — new dialog component.
- `src/components/holding-form.ts` — runs the prompt after `repo.create`.
- `src/views/browse.ts` — Quick Add prompt + bulk-summary `Marker N mottatt`.
- `src/views/lot-detail.ts` — post-materialise prompt.
- `src/views/card-detail.ts` — conflict banner + per-row `Marker mottatt` action.
- `src/views/wishlist.ts` — counts split + per-row `Marker mottatt` action.
- `src/styles.css` — `.browse-table__action--success`, `.card-detail-view__conflict*`, `.wishlist-receive-prompt*`, `.browse-view__bulk-summary-receive`.
- `tests/wishlist-receive-service.test.ts` — new, 19 cases.
- `tests/wishlist-view.test.ts` — 3 new cases (counts split, per-row gating, click flips status).
- `tests/card-detail-with-wishlist.test.ts` — 8 new cases: banner shown when both exist, hidden when no holdings, hidden when wishlist already closed, click opens prompt + submitting flips status, per-row gating, **review patch — wrong-finish hides banner, multi-finish prompt only includes matching candidates, condition_mismatch unchecked by default**.

#### Test totals
- 78 test files, **675 tests** (up from 645). Typecheck green. Build green (354 KB JS / 95 KB gzip).

#### Browser-verified (preview server, real wishlist + card-detail flow)
- Wishlist counts header now reads `Aktive: 166 (Ønsket: 120 · Bestilt: 46) · Mottatt: 24 · Avbrutt: 22 · Slettede: 3 · Matcher filteret: 212`.
- `Marker mottatt` shows on wanted + ordered rows; absent on received rows; clicking flips status to `received` and the row immediately drops the action button.
- Card-detail conflict banner shows for owned + wanted, hides immediately after click; `wishlistRepo.update` audit row recorded with `status=received`.

#### Out of scope (per the user's instruction)
- No global search.
- No CSV import.
- No binder direct-add.
- No cross-page bulk selection.
- No scanner/barcode.
- No pricing/value dashboard.
- No schema migration (wishlist still does not store `edition`).
- No automatic deletion of wishlist entries; `received` rows stay as history.
- No silent auto-marking — the prompt always asks first.

### Performance (PR 21 — Cards cache / cold mount)
PR 21 finishes the work PR 20 deferred: removing `cardsRepo.list()` as the cold-mount bottleneck. PR 20's measurement showed initial mount stuck at ~1000 ms even after the page-at-a-time refactor, because `cardsRepo.list()` still loaded all 20 237 cached cards from IndexedDB on every fresh view. This PR introduces a per-DB Promise cache for the two replaceable API caches (`cards`, `sets`) and wires invalidation into the only two write paths (sync, restore) **and into the repo write methods themselves** (so the repo's read/write contract stays correct regardless of who calls it). No new feature surface — purely foundation/perf.

#### Review patch (repo read/write consistency)
The first revision invalidated only on the sync/restore paths. That left `cardsRepo.upsert / upsertMany / clear` (and the `sets` equivalents) silently inconsistent with `cardsRepo.list()` — a `list()` after `upsert()` would return the pre-write cached array. Production today only writes `cards` / `sets` via sync and restore, but the repo layer is foundation code; future modules and tests will reasonably expect repo writes to be visible on the next repo read.

Patched in the review round before merge:
- `cardsRepo.upsert / upsertMany / clear` invalidate the cards cache after the write.
- `setsRepo.upsert / upsertMany / clear` invalidate the sets cache after the write.
- Sync / restore invalidation kept — they write to `db.cards` / `db.sets` directly inside their atomic transactions (bypassing the repo) and still need the explicit invalidator after commit.
- Cache header comment rewritten to reflect the new contract: repo writes auto-invalidate; direct `db.cards` / `db.sets` writes (today only sync + restore) must invalidate manually after commit.
- Six new tests: `cardsRepo.upsert / upsertMany / clear` and `setsRepo.upsert / upsertMany / clear` each warm the cache, write, and assert the next `list()` reflects the write with a fresh Promise reference.

#### What changed
- **`src/db/cards-cache.ts` (new).** A `WeakMap<PokemonTrackerDB, Promise<list>>` keyed by the live Dexie instance. `getCachedCardList(db)` / `getCachedSetList(db)` return a memoised Promise; concurrent first-time callers share one `db.cards.toArray()` (no thundering herd). `invalidateCardCache(db)` / `invalidateSetCache(db)` evict the entry. A rejected fetch evicts itself so a retry on the next call gets a fresh attempt instead of a permanently-bad Promise.
- **Repos read through the cache.** `cardsRepo.list()` and `setsRepo.list()` now call `getCachedCardList` / `getCachedSetList` instead of `db.cards.toArray()` / `db.sets.toArray()`. Every existing caller (Browse, Collection, Wishlist, Card detail, Binder detail, lot-detail, dashboard) is now a cache reader for free.
- **Sync invalidates both caches** after the atomic transaction commits the new generation. Repos see the fresh data on the very next call.
- **Restore invalidates both caches** after `replaceRestore`'s transaction commits. Same contract as sync.
- **Test isolation is automatic.** `freshDb()` returns a new `PokemonTrackerDB` instance, which is a different `WeakMap` key, which is its own (empty) cache. No cross-test pollution; no global reset hook needed.

#### Measurements (browser preview, QA stress data: 20 237 cards / 1088-slot binder)

| Operation | Before PR 21 | After PR 21 | Delta |
|-----------|------------:|-----------:|------:|
| `cardsRepo.list()` cold (20 237-card cache) | ~445 ms | ~445 ms | first-call cost unchanged (still hits IDB once) |
| `cardsRepo.list()` warm (cache hit) | ~445 ms | **~0 ms** | **∞** (resolved Promise returned synchronously) |
| `binder-slot-service.getDetail` cold (1088-slot) | 1004 ms | **357 ms** | **2.8×** (less Dexie work elsewhere stays) |
| `binder-slot-service.getDetail` warm (second mount) | 1004 ms | **32 ms** | **31×** |
| `binder-slot-service.getDetail` warm (third mount) | 1004 ms | **27 ms** | **37×** |
| Initial Browse / Collection / Card-detail mount after one cold visit | ~1000 ms | **~30 ms** | **~33×** |

The cold-mount cost drop comes from the cache surviving across view re-renders (mode toggles, filter changes, deep-link navigation, dashboard ↔ binder ↔ collection navigation). PR 20 already cached `BinderDetail` on the local `ViewState`; PR 21 lifts that to the per-DB level so re-mounting a different view also benefits.

#### Touched files
- `src/db/cards-cache.ts` (new) — WeakMap-keyed Promise cache + invalidators.
- `src/repositories/cards-repo.ts` — `list()` reads through cache.
- `src/repositories/sets-repo.ts` — `list()` reads through cache.
- `src/db/sync.ts` — invalidates both caches after the success transaction.
- `src/db/restore.ts` — invalidates both caches after the replace transaction commits.
- `tests/cards-cache.test.ts` (new, 16 cases): two consecutive calls return same Promise reference; concurrent first-time callers share one Promise; `invalidateCardCache` evicts; two separate DB instances have independent caches; sets cache works the same way; `cardsRepo.list` / `setsRepo.list` read through cache (integration); successful sync invalidates both caches; successful restore invalidates both caches; rejected first fetch is evicted so the next call retries; **`cardsRepo.upsert` / `upsertMany` / `clear` invalidate the cards cache; `setsRepo.upsert` / `upsertMany` / `clear` invalidate the sets cache**.

#### Test totals
- 77 test files, **645 tests** (up from 627). Typecheck green. Build green (345 KB JS / 92 KB gzip).

#### Browser-verified
- Service-level instrumentation on the QA-stress 1088-slot binder: `coldGetDetailMs: 357`, `warmGetDetailMs: 32`, `warmGetDetailMs2: 27`. The "second visit is essentially free" property the user asked for.
- Sync triggers cache eviction confirmed by repo seeing the new generation on the very next call (covered by `tests/cards-cache.test.ts`).
- Restore triggers cache eviction confirmed the same way.

#### Out of scope (per the user's instruction)
- No wishlist automation.
- No global search.
- No CSV import.
- No binder direct-add.
- No cross-page bulk selection.
- No Browse-specific virtualisation — the cache makes the existing 50-per-page pagination cold-mount fast enough that virtualisation isn't the next bottleneck.

### Performance (PR 20 — Binder workflow performance pass)
PR 20 takes the binder-detail view from "rendered all 1088 slot tiles + 1088 checklist rows in one go" to "render the current page only, reuse the BinderDetail across pagination / filter / search / mode toggles". No new feature surface — purely performance and DOM-cost reduction. Builds on PR 17's filter + search + deep-link.

#### What changed
- **Sider mode renders one physical page at a time.** Vault X 16-pocket binders have 68 pages × 16 slots = 1088 tiles. Pre-PR-20 the view rendered the whole stack on every mount; now it renders just the current page (16 tiles) plus a `Forrige / Neste` nav strip.
- **Sjekkliste mode paginates at 50 rows per page.** A 1088-slot binder used to render a 1088-row table; now max 50 rows + a nav strip. Same 50/page convention as Browse / Collection / lot-detail.
- **Cached `BinderDetail`** held on `ViewState`. Pagination clicks, filter changes, search input, and mode toggles reuse the cached `BinderDetail` instead of re-running `binder-slot-service.getDetail` (which loads every card from the 20 237-card cache to build `cardsById`). `USER_DATA_CHANGED_EVENT` invalidates the cache so user-data writes still see fresh state.
- **Filter / search auto-jump to first matching page.** When the active filter excludes every slot on the currently-selected page but matches exist elsewhere, the view jumps to the first page with a hit — the user immediately sees their search result instead of an empty page.
- **Deep-link `#binder/<id>/slot/<slotId>` lands on the right page.** Pre-PR-20 (with PR 17's deep-link) you'd end up on page 1 and the slot would scroll into view via `scrollIntoView`. Now the page index itself is set to the slot's page, and the highlight pulses on a tile that's actually in the visible 16, not a tile 200 rows below the viewport.

#### Measurements (browser preview, QA stress data: 20 237 cards / 1088-slot binder)

| Operation | Before PR 20 | After PR 20 | Delta |
|-----------|------------:|-----------:|------:|
| Vault X 16-pocket DOM size | 1088 slot tiles | **16 slot tiles** | **68×** |
| Sjekkliste DOM size for 1088-slot binder | 1088 rows | **max 50 rows** | **22×** |
| Pagination click (Forrige / Neste) | ~1000 ms (full re-fetch + re-render) | **~1 ms** (cached detail) | **1000×** |
| Filter change after first mount | ~1000 ms | **~1 ms** | **1000×** |
| Search input after first mount | ~1000 ms | **~1 ms** | **1000×** |
| Initial mount (cold) | 1004 ms | 1007 ms | unchanged — bottleneck is loading 20 k cards from IDB |

The cold-mount cost is unchanged because it's dominated by `cardsRepo.list()` (20 237 records). A Browse-style cards/sets cache that survives view re-renders is a follow-up PR; the present PR's win is keeping all subsequent in-view interactions essentially instantaneous.

#### Touched files
- `src/views/binder-detail.ts` — `ViewState` extensions (`pagesPage`, `checklistPage`, `cachedDetail`), `buildPagesGrid` page-at-a-time + `buildPagesNav`, `buildChecklist` 50-per-page + `buildChecklistNav`, deep-link `pagesPage` resolution, filter / search auto-jump.
- `src/styles.css` — `.binder-detail-view__pages-nav`, `.binder-detail-view__checklist-nav`, `.binder-detail-view__filter-note`.
- `tests/binder-detail-pagination.test.ts` (new, 6 cases): Sider renders one page; Forrige / Neste at edges; search auto-jumps to first match; Sjekkliste paginates at 50/page with summary; deep-link lands on slot's page; 1088-slot binder renders 16 tiles (DOM-size proof).
- `tests/binder-detail-search.test.ts` — one test updated for the new pagination contract: clicking Neste reveals a previously-hidden slot.
- `tests/backup-view.test.ts` — bumped a 10 ms `setTimeout` to 100 ms (pre-existing flake on busy-suite runs; nothing to do with PR 20 logic, but turned up while shipping the pagination tests).

#### Test totals
- 76 test files, **627 tests** (up from 621). Typecheck green. Build green (344 KB JS / 92 KB gzip).

#### Out of scope (per the user's instruction)
- No Browse 20k-card cache — binder pagination is the highest-impact change for one PR. Follow-up.
- No lot-detail virtualisation. Lot-detail already paginated at 50/page in PR 18.
- No new product features.
- No wishlist automation, no global search, no CSV import, no binder direct-add, no cross-page bulk selection.

### Added (PR 19 — Browse bulk mode / multi-select)
PR 19 closes the third leg of the bulk-add story: PR 15B (Quick Add per row) + PR 18 (lot-to-stock) + this PR (Browse multi-select). Builds on PR 15A's `upsertByVariant`, PR 15B's `decideQuickAdd`, and PR 18's per-mount-state pattern.

- **Bulk-modus toggle** in the Browse toolbar. Off by default — single-add behaviour from PR 15B is unchanged.
- **Per-row checkbox column**, only rendered when bulk-mode is on. Each row shows an actual checkbox when `decideQuickAdd(card).canQuickAdd === true`; otherwise a `–` placeholder with the refusal reason in the `title` (same gate Quick Add uses, so the user can never tick a card we'd then have to skip).
- **Visible-page select-all** in the column header — ticks every eligible checkbox on the current Browse page only (matches the lot-detail pattern from PR 18).
- **Bulk action `+1 raw på valgte (X)`** runs `holdingsRepo.upsertByVariant` per selected card with the same raw-NM defaults as single-row Quick Add. Two clicks across separate bulk runs hit the same holding's quantity, no duplicate rows.
- **Result-summary banner** with concrete counts: `Bulk +1 raw kjørt på N kort: A lagt til, B oppdatert, C hoppet over (manglet variant), D feilet.` Lists up to 5 failure reasons (the rest are tracked in audit). Has a `Lukk` button that dismisses the banner; the banner persists across `USER_DATA_CHANGED_EVENT` rerenders so the user can read the result while their Card detail / Collection / Dashboard refresh.
- **Selection pruned after success** — successful (created or merged) ids drop from `state.selectedCardIds`; failed and skipped ids stay so the user can address them and try again.
- **`USER_DATA_CHANGED_EVENT` fires exactly once** for a multi-card bulk run, not once per card. PR 15A's AbortController contract guarantees only the currently-mounted view re-renders, so a 50-card bulk doesn't flood the Card detail view with re-renders.

#### Touched files
- `src/views/browse.ts` — `BulkSummary` interface, `BrowseState` extensions (`bulkMode`, `selectedCardIds`, `bulkSummary`), toolbar markup, checkbox column, `applyBulkModeUi` / `refreshBulkUiFromDom` / `handleBulkSelectAll` / `handleBulkQuickAddRaw` / `renderBulkSummary` helpers.
- `src/styles.css` — `.browse-view__bulk-toggle`, `.browse-view__bulk-bar`, `.browse-view__bulk-action`, `.browse-view__bulk-summary*`, `.browse-table__check*`.
- `tests/browse-bulk-mode.test.ts` (new, 9 cases): default off; toggle shows bar + column + correct checkbox/skip split; per-row tick updates count + label without DB churn; visible-page select-all; bulk action runs `upsertByVariant` per card and shows summary; second bulk run on same card increments quantity (one row, qty 2); `USER_DATA_CHANGED_EVENT` fires exactly once for a multi-card run; toggling off clears selection but keeps summary readable; `Lukk` dismisses the summary.

#### Test totals
- 75 test files, **617 tests** (up from 608). Typecheck green. Build green (342 KB JS / 91 KB gzip).

#### Browser-verified
- On the QA-stress base1 set (102 cards, default page size 50): toggle reads `Bulk-modus av` initially → click → `Bulk-modus på`, bar visible, 49 eligible checkboxes + 1 `–` placeholder for the one card without variant data.
- Selected base1-1 + base1-46 (both already had holdings from earlier stress runs), clicked the bulk action → both holdings merged, quantity incremented by 1 each, `holdings.count()` unchanged at 675, summary banner read `Bulk +1 raw kjørt på 2 kort: 0 lagt til, 2 oppdatert, 0 hoppet over, 0 feilet.`, `USER_DATA_CHANGED_EVENT` fired exactly **1** time for the 2-card run.
- Zero console errors throughout.

#### Out of scope (per the user's instruction)
- No binder direct-add — that needs its own PR.
- No wishlist automation when materialising — out of scope until later.
- No CSV import.
- No virtualisation (page-size 50 is the smallest fix; PR 20 will tackle perf).
- No global search.

### Added (PR 18 — Lot-to-stock / materialise UX)
PR 18 turns the lot-detail view into a practical inbox for bulk purchases. Builds on PR 15A's `upsertByVariant` foundations, PR 17's view-state pattern, and PR 9's idempotent `materializeHoldings` service.

- **Two clearly-labelled actions** in the lot-detail toolbar:
  - **`Legg hele loten i samling (N)`** — same end state as the old "Materialiser N holdings" button. Carries the count for the user to verify before confirming.
  - **`Legg valgte i samling (X)`** — new partial-materialise path. Disabled until the user ticks at least one row.
- **Per-row checkbox column** for items that are still `holdingId === null` AND have an `allocatedCost`. Materialised rows have no checkbox so a tick can never undo a finished item. A header `Velg alle synlige` toggles the checkbox state for the current page only.
- **Per-row `Legg i samling` button** for the one-at-a-time path. Disabled with a tooltip when the row is missing `allocatedCost` ("Trykk \"Beregn allokering på nytt\" først.").
- **Materialised-row visual cue**. Rows where `holdingId !== null` get a `lot-items-table__row--materialized` class (light green tint) and the actions cell shows **`✓ I samlingen`** instead of the previous "Materialisert (låst)" italic. Same idempotent contract as before — the row is data-locked.
- **Pagination** — 50 items per page (same default as Browse / Collection so the user develops one mental model). `Forrige / Side X av Y — viser N–M av total / Neste` summary. Hidden for lots with ≤ 50 items.
- **Idempotent partial materialise**. The new `materializeHoldings(lotId, { itemIds })` overload runs the same variant validator + transaction as the bulk path. Items already materialised are skipped (counted as `skippedAlreadyMaterialised`); unknown ids are skipped (counted as `skippedNotFound`); same audit row, with a `(selected)` suffix and an inline skip count when relevant.
- **Selection state survives `USER_DATA_CHANGED_EVENT` rerenders** — held in `LotDetailState.selectedItemIds: Set<string>` per mount. Materialised ids are pruned automatically on the next render so the next "Legg valgte" action can't try to re-add them.

#### Touched files
- `src/services/lot-service.ts` — `MaterializeOptions { itemIds }`, `MaterializeResult { skippedAlreadyMaterialised, skippedNotFound }`, partial-pool branch, audit message extension.
- `src/views/lot-detail.ts` — `LotDetailState`, two-button toolbar, checkbox column + select-all, per-row Legg-i-samling button, pagination component, dispatch wiring.
- `src/styles.css` — checkbox column styling, materialised-row tint, partial-button styling, pagination layout, `visually-hidden` helper.
- `tests/lot-service.test.ts` — 5 new cases for partial materialise (only listed ids; idempotent skip; all-already-materialised no-op; unknown id `skippedNotFound`; audit message reflects partial path + skips).
- `tests/lot-detail-view.test.ts` — 6 new cases (button-text count + disabled-until-allocation; "Legg valgte" disabled until tick; partial via toolbar moves only selected; per-row Legg-i-samling creates one holding; materialised row CSS class + `✓ I samlingen`; pagination hidden ≤ 50 items).

#### Test totals
- 74 test files, **604 tests** (up from 593). Typecheck green. Build green (335 KB JS / 89 KB gzip).

#### Browser-verified
On the QA-stress `Bulk Buy 2025` lot (400 items, all materialised from PR 15A run):
- Toolbar shows `Legg hele loten i samling (0)` (disabled) + `Legg valgte i samling (0)` (disabled).
- Pagination renders `Side 1 av 8 — viser 1–50 av 400`. Forrige / Neste advance correctly.
- All 50 visible rows carry `lot-items-table__row--materialized` (light tint) and `✓ I samlingen` in the actions cell.
- Zero console errors throughout.

#### Out of scope (per the user's instruction)
- No multi-select on the Browse table — that is PR 19 (Bulk mode).
- No virtualisation; the page-by-50 model is the smallest fix that covers the user's stated 3 000-card scale.
- No global search.
- No wishlist automation when materialising — out of scope until PR 21.
- No automatic allocation: the user still presses "Beregn allokering på nytt" before any materialise.

### Added (PR 17 — Binder workflow)
PR 17 makes binders an active workspace instead of static slot storage. Builds on PR 15A's `cardMatchesQuery` and the AbortController router.

- **Free-text search inside the binder**. New search input in the binder-detail toolbar uses the shared `cardMatchesQuery(card, query)` predicate (PR 15A — F-6) against each slot's resolved card. Matches name, card id, set id and card number; supports compound queries like `Charizard 4`. 200 ms debounce so a 1088-slot binder doesn't re-render on every keystroke.
- **`empty` filter added**. The filter dropdown now reads `Alle / Mangler / Eid / Tomme / Bestilt / Duplikater`. `Tomme` shows fully blank slots (no `targetCardId` AND no `holdingId`) — useful when finding a free pocket to drop a manual holding into. The previous `Ferdig` was renamed `Eid` for clarity (still maps to `isSlotComplete`). Search and filter compose: both must match for a slot to be visible.
- **Checklist mode now sorts by physical slot order** (`pageNumber asc, slotNumber asc`). Set-based binders therefore render in card-number order without the user touching anything. Manual binders that have been re-arranged retain their layout's natural read order.
- **Deep-link `#binder/<id>/slot/<slotId>`**. Card detail's "Binder-lokasjoner" section gets a new **`Gå til side X.Y`** button per binder match. Clicking it navigates to the binder, scrolls the slot into view, and adds a transient `binder-slot--focused` class (3-second pulse) so the user sees exactly which pocket the card lives in. The plain "Åpne perm" button is kept as a one-click overview.
- **Search inside the assign-holding modal**. Blank manual slots used to render every live holding in a single `<select>` — unusable past ~50 holdings. The modal now shows a search field on top (with `cardMatchesQuery`) plus a result-count chip (`3 holdings` / `1 av 3 match`). Target slots still hide the search since they pre-filter to one cardId. Empty-results case shows a contextual message and disables submit.

#### Touched files
- `src/router.ts` — `navigateToBinderSlot()` and `getCurrentBinderSlotFocus()` plus parser updates so `#binder/<id>/slot/<slotId>` decodes both ids cleanly.
- `src/views/binder-detail.ts` — search input, `empty` filter, search+filter compose predicate threaded through `buildPagesGrid` / `buildPage` / `buildChecklist`, deep-link focus via `queueMicrotask` + `scrollIntoView` (jsdom-safe).
- `src/components/assign-holding-modal.ts` — search input + result count + dynamic re-render of the holdings select.
- `src/views/card-detail.ts` — extra "Gå til side X.Y" button next to "Åpne perm".
- `src/styles.css` — `.binder-detail-view__search`, `.binder-slot--focused` (3-second pulse).

#### Tests added
- `tests/binder-detail-search.test.ts` (8): all-filter renders everything; `empty` filter shows only blank-manual; search by name / number / id; search+filter compose; checklist sorts by slot order; deep-link focuses the right slot.
- `tests/assign-holding-modal-search.test.ts` (6): search wrap visible only for blank slots; target slot pre-filters to one card; search by name / id; empty-state message + submit disabled; result-count chip text.
- `tests/router.test.ts` extended (6): binder-id parser handles `/slot/<slotId>` suffix; `getCurrentBinderSlotFocus()` returns null for plain routes and the slot id for deep-links; `navigateToBinderSlot()` encodes both ids; trailing `/slot/` with empty id is treated as no focus.

#### Test totals
- 74 test files, **593 tests** (up from 573). Typecheck green. Build green (331 KB JS / 88 KB gzip).

#### Browser-verified
- `Base Set 1 Master` binder (360 slots, 47 owned from PR 15A QA pass): search `Charizard` → 1 visible slot, filter `Eid` → 47 visible, deep-link `#binder/<id>/slot/<charizardSlotId>` highlighted the Charizard tile.
- Card detail for `base1-4` shows `Gå til side 1.4` and `Åpne perm` buttons side by side.
- Zero console errors.

#### Out of scope (per the user's instruction)
- No "legg kort direkte i perm" from Browse (PR 18+).
- No "auto-assign all matching holdings" button (PR 18+).
- No lot-to-stock UX work (PR 18 / 19).
- No virtualisation for 1088-slot binders (PR 20 performance pass).
- No global search.

### Added (PR 15B — Quick Add Raw from Browse)
PR 15B builds on the foundations PR 15A landed. **Tightly scoped**: a one-click "+1 raw" button per Browse row, raw-NM defaults, quantity-merge by variant. **No** binder direct-add, **no** bulk multi-select, **no** wishlist automation, **no** global search — those are PR 16+.

- `src/components/quick-add.ts` (new) — pure decision helper `decideQuickAdd(card)`. Returns `{ canQuickAdd, defaults: { finish, edition }, reason }`. Defaults pick the first verified finish in the order `normal → holo → reverse_holo` and the first verified edition in the order `unlimited → first_edition`. When `availableVariants(card).verified === false` or no `(finish, edition)` pair is available the button is disabled and the user is sent to the full holding form via the existing "Legg til i samling" button.
- `src/views/browse.ts` — every Browse row now renders three buttons: **`+1 raw`** (the new Quick Add), `Legg til i samling` (full form, unchanged), `Legg til i ønskeliste` (unchanged), plus `Vis detaljer`. The Quick Add click handler builds a minimal `HoldingInput` from the row's verified defaults, calls `holdingsRepo.upsertByVariant()`, and drives the inline feedback chip.
  - Feedback chip lives next to the button: **`Lagt til`** (created), **`+1 → N (var N-1)`** (merged), **`Feil`** (rejected). The chip's state lives on `BrowseState.quickAddFeedback: Map<cardId, …>` so a `USER_DATA_CHANGED_EVENT` rerender (PR 15A's contract) re-applies the chip to the freshly built row instead of wiping it. Cleared on a 2.5 s timeout via a follow-up rerender.
  - The button is disabled with a Norwegian tooltip when `decideQuickAdd` refuses (e.g. card has no `tcgplayer.prices`, or only carries the unmapped `unlimitedHolofoil` keys discussed in QA finding F-2).
  - On success the handler dispatches `USER_DATA_CHANGED_EVENT` so Card detail / Collection / Dashboard refresh — PR 15A's AbortController contract guarantees only the currently-mounted view re-renders.
- `src/styles.css` — adds `.browse-table__action--quick-add` (accent border) and the three feedback-chip variants `…--created` / `…--merged` / `…--error`.
- The repo-bypass test from PR 13 still applies: tampering with the button's `data-finish` attribute via devtools causes the repo's `validateHoldingVariants` to reject the input — verified in `tests/browse-quick-add.test.ts`.

#### Tests added
- `tests/quick-add.test.ts` (11 cases): refuses null / empty / unmapped-only prices; defaults `normal → holo → reverse_holo`; defaults `unlimited → first_edition`; only-1stEditionHolofoil → first_edition fallback; malformed price entry refused.
- `tests/browse-quick-add.test.ts` (7 cases): button rendered enabled with verified defaults; disabled button + Norwegian tooltip when no verified variant; first click creates with raw NM defaults via `upsertByVariant`; second click merges quantity (one row, qty 2); chip shows `Lagt til` then `+1 → 2 (var 1)`; `USER_DATA_CHANGED_EVENT` dispatched on success; repo-bypass via tampered `data-finish` rejected, no row written.

#### Test totals
- 72 test files, **573 tests** (up from 555). Typecheck green. Production build green (328 KB JS / 87 KB gzip).

#### Browser-verified
Headless Chromium (Claude_Preview) on the live IndexedDB seeded by the PR 15A QA stress run:
- `+1 raw` button visible per Browse row with correct dataset (`base1-1` Alakazam → finish=holo, edition=unlimited).
- Click on a card with an existing matching holding → chip shows `+1 → 2 (var 1)` then `+1 → 3 (var 2)` on the second click; quantity in IDB advances 1 → 2 → 3 in the same row.
- Card with no `tcgplayer.prices` (`base1-8` Machamp) → button is `disabled` with the tooltip "Mangler API-verifisert variant — bruk \"Legg til i samling\" for å oppgi variant manuelt.".
- Zero console errors throughout.

### Fixed (PR 15A — QA foundation before Quick Add)
PR 15A clears the three blockers the QA-stress-test surfaced before Quick Add (PR 15B) is built. **No new feature surface — only fixes that the Quick Add UI will rely on.**

- **F-3 — Router race / `USER_DATA_CHANGED_EVENT` listener leak.** Every view's `mountX(container)` registered a `window.addEventListener` and never removed it. Because all views share the same `<main>` container, dispatching the event after a route change made the PREVIOUS view's handler render its content into the container the NEW view had just taken over. Visible to the user as `#lots` flipping to the card-detail "Ingen kort valgt" placeholder right after saving a lot.
  - Fix: `src/app.ts` `renderActiveView()` now keeps an `AbortController` and aborts it before the next mount. Each view's mount signature is widened to `(container, signal?: AbortSignal)` and listeners go through a tiny shared helper `onUserDataChanged(handler, signal)` in `src/components/events.ts`. When the controller aborts, the listener is removed automatically.
  - Touched 11 view files (`backup`, `binder-detail`, `binders`, `browse`, `card-detail`, `collection`, `dashboard`, `lot-detail`, `lots`, `settings`, `wishlist`) plus `app.ts` and `components/events.ts`.
  - Tests: `tests/view-mount-teardown.test.ts` (3 cases): aborted-signal binders→lots does not leak; card-detail handler does not flip `#lots` on data change; non-aborted signal still re-renders (positive control).

- **F-6 — Search across the app was name-only substring.** Browse / Collection / Wishlist all matched `card.name.toLowerCase().includes(q)` and nothing else. Card id (`base1-4`), set id (`base1`), set name (`Base Set`) and card number (`4/102`) all returned 0 hits. The lot-item picker was the only place that could resolve a card id, and even it could not resolve set ids or card numbers.
  - Fix: new pure helper `src/domain/card-search.ts` exports `cardMatchesQuery(card, query, { setsById })`. Predicate handles name substring, id substring, set-id exact, set-name substring (when `setsById` is provided), card-number exact, `"4/102"` form, and compound queries `"<rest> <number>"` like `Charizard 4`, `base1 4`, `Base 4`. Whitespace is trimmed and collapsed; case-insensitive; no regex / fuzzy / accent-folding. Pure — no DOM, no IO.
  - `browse-service`, `collection-service`, `wishlist-service` and `lot-card-picker` all call the helper. The lot-card-picker now also loads the sets cache so set-name search works there too.
  - Tests: `tests/card-search.test.ts` (41 cases): name / id / number / set-id / set-name / "4/102" / compound (name+number, set-id+number, set-name+number) / whitespace / negative cases / ambiguous-compound graceful fallback.

- **F-7 — Adding the same card twice created two holding rows; no quantity-merge.** PR 15B (Quick Add Raw) hits this on the very first click. The repository's `create()` always inserted a new row.
  - Fix: new method `holdingsRepo.upsertByVariant(input)` runs the same variant validation as `create`, then atomically searches for a live holding matching `(cardId, conditionType, rawCondition, gradingCompany, grade, certNumber, finish, edition, language, status, lotId, specialVariant)`. On match → existing row's quantity is incremented and `holding_qty_incremented` is appended to the audit log; on miss → fresh row + `holding_created`. The whole find-then-write is one Dexie transaction so two concurrent upserts cannot both create a fresh row. Notes / prices / value tracking / tags / source on the existing row are **preserved** (not overwritten); the existing note wins unless it is `null` and the input has one. Soft-deleted holdings do NOT match — a new live row is created instead of resurrecting the deleted one.
  - The legacy `create()` is unchanged so power-users who want a deliberately-separate row (e.g., to track distinct provenance) can still call it.
  - Tests: `tests/holdings-upsert-by-variant.test.ts` (18 cases): created/merged actions, quantity arithmetic, every match-key field's effect on identity (finish / rawCondition / status / lotId / specialVariant / cert), graded merge with same cert, escape-hatch validation still rejects, note preservation rules, prices/value/tags preserved, soft-delete does not match, audit messages, legacy `create()` still produces a separate row.

### Added (small cleanups carried in PR 15A)
- **F-1 — Settings → "Slots per perme-side" select** now offers the creatable set `[4, 9, 12, 16]` instead of the stale `[9, 18]`. The reader is tolerant of older saved values.
- **F-5 — Custom binder `slotsPerPage` select** no longer offers `18` for new binders; the legacy 18-slot option is only included when editing an existing `legacy_18` binder (where the field is locked and the option is needed only to render the locked value).

### Test totals
- 70 test files, **555 tests** (up from 493). Typecheck green. Production build green (325 KB JS gzipped 86 KB).

---

### Added
- **PR 14 — Vault X binder layouts (presets, full-capacity from-set, 4/12/16-pocket grids).** Closes the binder-layout gap surfaced after PR 11: `slotsPerPage` was locked to 9 or 18, which doesn't match the user's actual physical Vault X products (12-pocket 480, 12-pocket XL 624, 16-pocket XXL 1088). PR 14 adds presets that mirror the physical binders, lets the from-set wizard create the full physical grid (with empty slots after the targets), and keeps the door open for tighter binder workflows in PR 15/16. **No Quick Add. No card-picker on slot. No live API search.**
  - `src/domain/types.ts` — adds `SlotsPerPage = 4 | 9 | 12 | 16 | 18` and `BinderPreset` union (`vaultx_9_360 | vaultx_12_480 | vaultx_12xl_624 | vaultx_16xxl_1088 | custom | legacy_18`). `BinderRecord.slotsPerPage` widens from `9 | 18` to `SlotsPerPage`. New required field `BinderRecord.binderPreset: BinderPreset | null` (null only on rows from pre-PR-14 backups).
  - `src/domain/binder-presets.ts` (new) — definitions for every preset with label, slotsPerPage, totalPages, capacity (`= slotsPerPage * totalPages`), and physicalSheets where known. `legacy_18` is excluded from `getCreatableBinderPresets()` so the form never offers it for new binders. `presetForLegacyRow(slotsPerPage)` is the migration helper used by both the schema upgrade hook and the form's edit-mode resolver.
  - `src/domain/validators.ts` — `validateBinderInput` now accepts the full slot set (4/9/12/16/18) and additionally enforces preset consistency: a Vault X preset must match its definition's slotsPerPage + totalPages exactly; `legacy_18` requires slotsPerPage=18; `custom` only restricts slotsPerPage to the creatable set (or 18 for compatibility with old-form-validated binders). `binderPreset = null` is allowed (legacy backups).
  - `src/domain/binder-template.ts` — `TemplateOptions.slotsPerPage` widens to `SlotsPerPage`; the runtime guard accepts 4/9/12/16/18; `placeAt` likewise widens. Master-mode reverse-holo placement and PR 11's `cardHasReverseHolo` rule are unchanged.
  - `src/db/schema.ts` — bumps `SCHEMA_VERSION` from 1 → 2. The v1→v2 upgrade hook back-fills `binderPreset` on every existing binder row using `presetForLegacyRow()`: 18-slot rows get `legacy_18`, all others get `custom`. **Existing slots are not regenerated** — the user's data is left exactly as it was.
  - `src/services/binder-service.ts` — `createBinderFromSet` is the big behavioural change. When the wizard hands a Vault X preset, the service writes the full physical grid (`totalPages * slotsPerPage`) for the chosen preset and places the target drafts into the matching positions; remaining cells become empty placeholders (`status='empty'`, `targetCardId=null`). When the preset is `null` or `'custom'`, the service falls back to the previous "size to drafts" behaviour. Two new pre-flight rejections: drafts that exceed the chosen preset's capacity, and drafts that point outside the grid (e.g. `slotNumber=99` on a 9-pocket). The audit message now reports `<total slots>` and `<target count>` (`created from-set binder "X" (mode=master, set=..., preset=vaultx_12xl_624) with 624 slots, 200 targets`).
  - `src/components/binder-form.ts` — replaces the manual binder form. New "Permtype" select at the top with the four Vault X options + Custom. Picking a Vault X preset locks `slotsPerPage` and `totalPages` (read-only, with a hint stating `<pages> sider × <slots/side> = <capacity> kort`). Custom unlocks both fields, restricted to `4/9/12/16` slotsPerPage. Edit mode keeps the layout immutable for any preset including `legacy_18`. Default for new manual binders is `vaultx_12xl_624` — the user's most common physical binder.
  - `src/components/binder-from-set-wizard.ts` — same preset selector, same default (`vaultx_12xl_624`). Live preview now shows base / reverse-holo / total target count + binder capacity + remaining slots, with an explicit "for mange mål-slots" message when the targets exceed capacity. Submit is blocked while over capacity.
  - `src/views/binders.ts` — list-view cards now show "Permtype" (preset label) and "Kapasitet" (`totalPages × slotsPerPage`) alongside the existing pages / slots-per-page / completion stats. Legacy 18-slot binders display as "Eldre 18-slot dobbeltside".
  - `src/views/binder-detail.ts` — widened all `slotsPerPage` parameters from `9 | 18` to `SlotsPerPage` so the existing assign / status / clear flows work for every new size.
  - `src/styles.css` — adds `.binder-page__grid--4` (2 cols), `.binder-page__grid--12` (4 cols), `.binder-page__grid--16` (4 cols). Existing `--9` (3 cols) and `--18` (6 cols) classes are untouched.

### Review patches (post-implementation hardening)
- **Restore back-fills `binderPreset`.** `src/db/restore.ts` now normalises every binder row in an incoming backup before `bulkPut`: `null`/missing → `presetForLegacyRow(slotsPerPage)`. Modern rows that already carry a preset pass through untouched. Without this, restoring a pre-PR-14 backup into a fresh database would persist `binderPreset = null` (the v2 upgrade hook only runs on a v1→v2 schema bump, not on data inserts), and the binders list view would crash on `binderPreset !== null && binderPreset !== 'custom'`.
- **Wizard preview shows physical pages, not target pages.** `src/components/binder-from-set-wizard.ts` `renderPreview` now reads `getBinderPresetDefinition(preset)` for Vault X selections and reports `Perm-sider`, `Permkapasitet`, `Mål bruker ca.`, and `Ledige slots` against the physical binder. Custom binders keep the old "Sider" label fed by `result.summary.totalPages`. This stops a user from being misled into thinking a 5-target binder is a 1-page binder when the chosen preset is a 624-slot Vault X.
- **Duplicate physical-position guard in `createBinderFromSet`.** Two drafts pointing at the exact same `pageNumber:slotNumber` would otherwise be silently merged by the placement Map (the second overwrites the first), losing user data without any signal. Service now keeps a `Set<string>` of seen `page:slot` keys and throws `ValidationError` before opening the transaction.

### Tests (493 / 493 across 67 files)
- `tests/binder-presets.test.ts` (new) — pure preset definitions: each Vault X preset has the expected `slotsPerPage * totalPages = capacity`, `legacy_18` is excluded from `getCreatableBinderPresets`, `presetForLegacyRow(18) = legacy_18` and other values map to `custom`.
- `tests/binder-vaultx-capacity.test.ts` (new) — service-level: each Vault X preset (9/12/12XL/16XXL) creates the full grid with targets in front and empty placeholders behind; rejects targets that exceed capacity; rejects drafts outside the grid; **rejects two drafts that target the same physical slot (review patch);** audit message reports total + target count; custom preset still sizes-to-drafts (back-compat).
- `tests/backup-restore.test.ts` extended (review patch) — `binderPreset` back-fill on restore: legacy 18-slot row → `legacy_18`, legacy 9-slot row → `custom`, explicit `null` is still back-filled, modern preset is preserved verbatim.
- `tests/binders-view.test.ts` extended (review patch) — list view does not crash when an existing row has `binderPreset = null` and emits no "Permtype" stat for that row.
- `tests/backup-roundtrip.test.ts` updated — seed binder now carries `binderPreset: 'custom'` so the round-trip is a true identity (legacy back-fill is verified separately in `backup-restore.test.ts`).
- `tests/binder-template.test.ts`, `tests/validators.test.ts` extended — accept the new slot counts; reject unsupported (`7`, `24`).
- `tests/binder-from-set-service.test.ts`, `tests/binder-from-set-wizard.test.ts`, `tests/binder-csv-export.test.ts`, `tests/binder-detail-checklist.test.ts`, `tests/binders-view.test.ts` updated — the from-set drafts now produce the full grid; assertions split into "target slots" and "empty placeholders" so behaviour is precise. Wizard test picks `vaultx_9_360` for cheap execution.
- All PR 1–11 tests including `tests/backup-roundtrip.test.ts` and `tests/browse-readonly-invariant.test.ts` remain green. Existing test fixtures across the suite gained `binderPreset: null` automatically; the v1→v2 upgrade hook is exercised any time a freshly-created Dexie database is opened.

### Migration / data safety
- **Schema bumped 1 → 2.** The Dexie upgrade hook is read-then-modify on the `binders` store: each row gets `binderPreset` back-filled (legacy_18 for 18-slot rows, custom otherwise). **No slots are regenerated, no rows are deleted, no other store is touched.**
- **Existing 18-slot binders open and edit normally.** The form and views recognise `legacy_18` and surface the "Eldre 18-slot dobbeltside" label.
- **Backups round-trip.** The new field flows through `BackupFile` automatically (it's part of `BinderRecord`); restoring a pre-PR-14 backup keeps `binderPreset = null` until the v2 upgrade hook runs on first open.

### Known limitations (PR 14)
- **No Quick Add Raw from Browse** — that lands in PR 15 with the quantity-merge rule for bulk imports.
- **No "legg kort direkte i perm" flow** — that lands in PR 16 (binder slot → card picker → create + assign in one step). Right now the user still has to add a holding first, then assign it to a slot.
- **Editing layout on an existing binder is still locked.** Resizing a binder mid-life would need slot migration that is outside this PR's scope.
- **Vault X data is hard-coded.** No live fetch of Vault X capacity specs; if Vault X ships a new product, we add a new preset with a dedicated PR.

### Added
- **PR 11 — Strict variant validation against pokemontcg.io API truth.** Closes a real gap surfaced after the first import: form dropdowns showed every theoretically-possible finish/edition for any selected card, even when the API explicitly told us the printing did not exist. PR 11 turns API-key presence in `card.tcgplayer.prices` into the **canonical truth** for which variants exist, and enforces it both in the UI (dropdowns narrow when a card is selected) and at submit time (repos re-validate so a user with devtools cannot bypass the rule).
  - `src/domain/card-variants.ts` — new pure helper `availableVariants(card)` returns `{ verified, finishes, editions }`. Recognised tcgplayer.prices keys are mapped exactly per the PR review lock:
    - `normal` → finish `normal` + edition `unlimited`
    - `holofoil` → finish `holo` + edition `unlimited`
    - `reverseHolofoil` → finish `reverse_holo` + edition `unlimited`
    - `1stEditionNormal` → finish `normal` + edition `first_edition`
    - `1stEditionHolofoil` → finish `holo` + edition `first_edition`

    Every other key — including the undocumented `unlimitedNormal` / `unlimitedHolofoil`, cardmarket data, rarity strings, set names, and any future tcgplayer keys — is **deliberately ignored**. No guessing. A future PR with a real API fixture can extend the mapping; PR 11 stays strict to the five documented keys. A key is only counted when its value is a plain object (the API shape), so `{ normal: null }` or `{ holofoil: 5 }` does not flip a variant on. The escape-hatch sets `ESCAPE_HATCH_FINISHES = { unknown, stamped }` and `ESCAPE_HATCH_EDITIONS = { unknown, shadowless }` are exported so the form layer always has manual options for misprints / promos / shadowless prints.
  - `src/domain/validators.ts` — new `validateHoldingVariants` / `validateLotItemVariants` / `validateWishlistVariants` predicates. Pure: callers (the repos) load the card and pass it in. The rule:
    - **verified card**: `finish` (and `edition`, where the record has one) must be in the verified set, OR be an escape-hatch value with `specialVariant=true` or a non-empty `note`.
    - **unverified card** (no tcgplayer.prices, only unknown keys, or card missing from cache entirely): finish/edition must take an escape-hatch value AND require the same marker.
    No fallback to "all options". The error messages name which finishes the API actually exposes, so the UI can surface them inline.
  - `src/repositories/holdings-repo.ts`, `src/repositories/lot-items-repo.ts`, `src/repositories/wishlist-repo.ts` — `create` and `update` now load the card via `db.cards.get(input.cardId)` and run the new variant validator before any write. This is the **submit-time** defence per the PR review: a user editing form state via devtools (or an old JSON import) cannot persist an invalid finish.
  - `src/services/lot-service.ts` — `materializeHoldings` runs the same variant validator on each holding draft before opening the transaction. Adds `specialVariant: true` to the synthesised holding when the source lot-item carries no note, so escape-hatch finishes survive materialisation. Keeps the existing rollback contract.
  - `src/components/holding-form.ts`, `src/components/wishlist-form.ts`, `src/components/lot-item-form.ts` — finish + edition dropdowns are now populated dynamically from `availableVariants(card)`. Order: most-likely options first (normal, holo, reverse_holo for finish; unlimited, first_edition for edition), then escape hatches (Stamped + Unknown / Shadowless + Unknown). Default selection in add mode picks the first verified option; falls back to `Ukjent` when nothing is verified. The lot-item form re-narrows in response to the card-picker's `onSelect` so the dropdowns track the user's pick. A small hint surfaces in the form when the card has no tcgplayer.prices ("velg Ukjent og fyll inn et notat eller marker som spesial-variant").

### New / changed audit actions
- None. Variant validation rejects bad input with `ValidationError` before any audit row is written, preserving PR_RULES §10.

### Tests (467 / 467 across 65 files)
- `tests/card-variants.test.ts` — extended with the full availableVariants matrix: each recognised key maps correctly, unrecognised keys are ignored, defensive narrowing rejects non-object price values, no guessing from rarity / cardmarket, escape-hatch sets exposed.
- `tests/strict-variant-validation.test.ts` (new) — pure validators reject `holo` when the card only has `normal`, reject `reverse_holo` without `reverseHolofoil`, reject `first_edition` without `1stEdition*`, reject escape-hatch finish without the marker, accept escape-hatch finish with `specialVariant=true` OR a non-empty note, treat missing card as unverified. Repo-level enforcement: holdings/lot-items/wishlist `create` rejects unverified finish, `update` re-validates, devtools-style escape-hatch bypass without the marker fails.
- `tests/form-variant-narrowing.test.ts` (new) — holding-form / wishlist-form / lot-item-form dropdowns expose only verified finishes + escape hatches; show only escape hatches when the card has no tcgplayer.prices; surface a hint; lot-item-form re-narrows on card-picker selection.
- All PR 1–10 tests including `tests/backup-roundtrip.test.ts` and `tests/browse-readonly-invariant.test.ts` remain green. Test fixtures across the suite were updated to include `tcgplayer.prices` keys on seeded cards; tests that explicitly exercise the unverified path (price-extractors, "no prices" rendering) still pass `tcgplayer: null` as an override.

### Migration
- **No schema changes.** Existing holdings / lot-items / wishlist rows are NOT auto-migrated. They keep whatever finish/edition they were created with. The validators only run on new `create` / `update` calls — a user who imports a legacy backup keeps their data, but any subsequent edit must clear strict validation against the cached card.
- After PR 11 merges, users who haven't synced yet will see only escape-hatch options in the form until they sync — this is the documented behaviour for the unverified path.

### Known limitations (PR 11)
- **Cardmarket data is ignored** by design. Only `tcgplayer.prices` keys count.
- **Shadowless** is never API-detectable; the form always lists it as an escape-hatch option that requires `specialVariant=true` or a note.
- **Stamped** is always shown as an escape hatch since the API does not expose stamping signals; user must mark `specialVariant` or write a note.
- **Card missing from cache** is treated as the unverified path (force escape hatch + marker). A user who entered an obscure cardId not yet synced cannot persist a holding with a "real" finish until they sync the card.

### Added
- **PR 10 — Dashboard MVP + MVP CSV exports.** Closes the MVP feature surface. The dashboard is a read-only control panel that aggregates the seven sections from `DASHBOARD_SPEC.md` plus an action-needed strip; the four MVP CSV exports (`collection`, `wishlist`, `duplicates`, `missing-cards`) called out by `MVP_ACCEPTANCE.md` ship from the same PR. **No schema changes.**
  - `src/domain/dashboard-actions.ts` (new) — pure rules engine. `computeActionItems(snapshot)` returns `ActionItem[]` with three severities (`info | warning | critical`); the strip filter `filterStripItems()` drops `info` so the top strip stays focused on items that genuinely require attention. Rules: never-backed-up (critical), `daysSinceLastBackup > 7` (warning), `lastMigrationAt > lastBackupAt` (warning), `holdingsSinceLastBackup > 50` (warning), persistent storage not granted (warning), `lastSyncStatus === 'failed'` (warning), partial/unallocated lots (warning), missing condition / missing value / not-in-binder / incomplete binder slots (info).
  - `src/services/dashboard-service.ts` (new) — read-only aggregation. **Performance contract:** `cards.count()` and `sets.count()` only — never `cardsRepo.list()`. Holdings / binderSlots / lots / lotItems / wishlist use `toArray()` because their MVP volumes are small. Builds a single `DashboardSnapshot` covering Database Health, Sync, Backup, Collection, Binders (with avg completion + top 3), Lots (totals grouped per currency), Wishlist (with top 5 grail), and embeds the `actions` array from the rules engine. `now` is injectable for deterministic tests.
  - `src/services/mvp-csv-export.ts` (new) — four MVP CSV builders + audit recorder. Reuses `utils/csv.ts` (BOM + CRLF + RFC 4180 + slugified filename). `build*()` functions are read-only; `recordCsvExported(kind, rowCount)` writes a single audit row in a narrow `auditLog`-only transaction **after** the view has handed the content to `downloadTextFile`.
    - `collection.csv` — every live holding with full identity, condition, currency, value-source, source/lotId, tags, status. **No tax / profit / accounting columns.**
    - `wishlist.csv` — every live wishlist entry with priority, target condition, target price + currency, status.
    - `duplicates.csv` — groups by canonical key (`cardId | finish | edition | language | condition`); a row is reported when the group has 2+ entries OR at least one is explicitly `status='duplicate'`. Aggregates `count`, `total_quantity`, `statuses_observed`, plus duplicate / upgrade-needed counters.
    - `missing-cards.csv` — cross-binder shopping list. Every live binder slot whose target is set AND that is not KRAVSPEC §6 complete. Includes a `finish_hint=reverse_holo` column when the slot carries the reverse-holo template marker from PR 8b.
  - `src/views/dashboard.ts` (replaces placeholder) — switches from string render to `mountDashboardView(container)`. Initial "Laster …" state, error panel with recovery links if the snapshot throws, action strip at the top (or a green "Ingenting krever oppmerksomhet" state when nothing needs attention), then a CSS grid of seven section cards. Each card has an "Åpne"-button that navigates to the relevant sidebar view. The Collection card hosts `collection.csv` + `duplicates.csv` exports; the Binders card hosts `missing-cards.csv`; the Wishlist card hosts `wishlist.csv`. Refreshes on `USER_DATA_CHANGED_EVENT` and `SYNC_STATUS_CHANGED_EVENT` with the standard `isConnected` guard. Top-3 binders + top-5 grail wishlist link directly to the relevant binder / card detail.
  - `src/app.ts` — `dashboard` route now mounts the real `mountDashboardView` (was a `string` placeholder via `renderDashboard()`).
  - `src/styles.css` — dashboard grid, action strip with severity-coloured borders, section cards, top-N lists, error panel, "ok"-state strip.

### New audit actions
- `collection_csv_exported`
- `wishlist_csv_exported`
- `duplicates_csv_exported`
- `missing_cards_csv_exported`

Each is written exactly once per `recordCsvExported(kind, rowCount)` call, in a narrow rw-transaction over `auditLog` only. Audit semantics: "CSV content was generated and a download was started", consistent with PR 8b's binder CSV and PR 9's lot CSV exports.

### Tests (426 / 426 across 63 files)
- `tests/dashboard-actions.test.ts` — never-backup is critical; backup-old triggers strictly above 7 days (boundary); schema-migrated-since-backup; `holdings_since_backup > 50` (boundary); storage not persistent; sync_failed (with error message); lots_unallocated; info-severity for collection/binders triggers; severity ordering puts critical first, info last; `filterStripItems` drops info.
- `tests/dashboard-service.test.ts` — empty DB returns zero-counts and a critical `backup_never` action; cards via `count()` (200-card seed never appears in snapshot JSON); collection raw/graded/missing counts and not-in-binder; binder average completion + top-3 ordering; lots per-currency totals; wishlist counts + grail filter (cancelled grails excluded); appMeta join (lastBackupAt / lastSyncAt / lastSyncError / persistentStorageGranted) with injected `now`; `schemaMigratedSinceLastBackup` boolean.
- `tests/dashboard-view.test.ts` — seven section cards render, action strip filters info, "Ingenting krever oppmerksomhet" state when no warnings, "Åpne"-button navigates via hash, **no 20k-card row leak** (200-card seed; "Card 5" never appears in DOM but the count does), refresh on `USER_DATA_CHANGED_EVENT` re-renders.
- `tests/mvp-csv-export.test.ts` — collection.csv has BOM + CRLF + currency-code columns + no `tax` / `profit` headers; wishlist.csv excludes soft-deleted entries and includes priority + target columns; duplicates.csv groups by canonical key + respects `status='duplicate'` for singletons; missing-cards.csv lists every incomplete target slot across binders; `recordCsvExported` writes one audit row per kind.
- All PR 1–9 tests including `tests/backup-roundtrip.test.ts` and `tests/browse-readonly-invariant.test.ts` remain green.

### MVP acceptance
With PR 10 merged, `MVP_ACCEPTANCE.md` is satisfied: app starts locally, IndexedDB initialises with `schemaVersion`, card/set sync works, offline after first sync, holdings add/edit, binders + slot assignment + completion %, wishlist + missing, lots/bulk with three allocation modes, JSON backup + restore, **dashboard with all seven sections**, user data survives reload, API sync never overwrites user data, no localStorage for collection data, **collection / binder-checklist / missing-cards / duplicates / wishlist CSVs** all available, no tax/accounting features.

### Known limitations (PR 10)
- **CSV audit semantics** mean "CSV content was generated and a download was started" — the browser cannot reliably observe whether the user actually saved the file. Same caveat as PR 8b/9.
- The dashboard does **not** trigger sync or backup directly. The action strip and section cards link to Settings / Backup / etc., where the actual mutation paths live. This keeps "what writes to user data" provably one place per concern.
- The dashboard's "missing card" cross-binder list is exposed via `missing-cards.csv` only — there's no in-app "missing across all binders"-page. The binder detail's `Mangler`-filter from PR 8b covers per-binder.
- `duplicates.csv` groups by canonical condition key only (no per-binder grouping). A holding that is marked `status='duplicate'` in isolation still appears so the user can find it.
- No charts / graphs / AI / profit / tax. Out of scope per KRAVSPEC.

### Added
- **PR 9 — Lots / bulk-purchases: list, detail, three allocation modes, materialise, CSV.** Closes the lot/bulk feature surface for MVP. The `Lotter` sidebar route is no longer a placeholder. Bulk purchases can be split into items, allocated across them with one of three modes, and converted into real holdings (`source='lot'`, `lotId`) atomically. Owned-status, soft-delete-only, and the no-permanent-delete rule from earlier PRs all hold.
  - `src/router.ts` — adds the `#lot/<encodedLotId>` sub-route alongside the existing card and binder paths. Bare `#lot/` and malformed encodings fall back safely; `lot-detail` is not a sidebar route.
  - `src/domain/lot-allocation.ts` (new) — pure `allocateLot(lot, candidates)` for the three KRAVSPEC modes:
    - `equal` splits to two decimals, last item swallows the rounding residual (100 NOK / 3 → 33.33 / 33.33 / 33.34).
    - `weighted_by_market_price` allocates proportionally to `marketEstimate`; null/zero estimates get 0 allocated; an all-zero population is an error so the user is told to switch mode.
    - `manual` reads `manualPriceOverride` per item; missing override is an error; sum mismatch beyond ±0.01 is a warning (not an error) since a user can deliberately hold back shipping etc.
    The engine expects callers to pre-filter candidates (live + not yet materialised). It is idempotent and does no currency conversion.
  - `src/services/lot-service.ts` (new) — atomic write paths:
    - `applyAllocation(lotId)` reads live items, treats already-materialised items (`holdingId !== null`) as **locked** with their existing `allocatedCost`, computes `remainingTotalCost = lot.totalCost - sum(locked allocatedCost)`, and runs the allocation engine over the remaining unmaterialised candidates only. The whole write is one Dexie transaction over `[lotItems, auditLog]`: a single `bulkPut` for the candidates and **one** `lot_allocation_applied` audit row — per-item `lot_item_updated` audits are deliberately skipped because the bulk audit captures the operation.
    - `materializeHoldings(lotId)` builds `HoldingRecord[]` for every live item where `holdingId === null` (and `allocatedCost !== null`), runs `validateHoldingInput` on every input **before** opening the transaction, then atomically `bulkAdd`s the holdings and `bulkPut`s the lot items with their new `holdingId`. **One** `lot_holdings_materialized` audit row is written — per-holding `holding_created` audits are skipped (consistent with PR 8a's binder-slot bulk pattern). Holdings get `source='lot'`, `lotId`, `purchasePrice = item.allocatedCost`, `purchaseCurrency = lot.currency`, `status='owned'`, `valueSource='unknown'`, and an empty `tags` array. Idempotent: re-running on a fully materialised lot is a no-op and writes no audit row.
  - `src/services/lot-detail-service.ts` (new) — read-only join of lot + live items + cards + holdings. Computes `allocatedTotal`, `allocationDifference = lot.totalCost - allocatedTotal`, and the derived status chip (`unallocated | partial | allocated | materialized`).
  - `src/services/lot-csv-export.ts` (new) — `build(lotId)` returns `{ filename, content, rowCount }` with BOM + CRLF + RFC 4180 escaping, one row per live item. Columns include lot metadata, card join (id/name/set/number), condition fields, `manual_price_override`, `market_estimate`, `allocated_cost`, `holding_id`, and a `materialized` boolean. `recordExport(lot, rowCount)` writes a single `lot_csv_exported` audit row in a narrow `auditLog`-only transaction **after** the view has handed the content to `downloadTextFile` (same semantics as PR 8b's binder CSV: "content was generated and a download was started", not "the user definitely saved the file").
  - `src/components/lot-card-picker.ts` (new) — reusable typeahead. Searches the cached `cards` store by name (case-insensitive substring) with an exact `cardId` fallback, returns at most 10 matches. No API calls. Used inside the lot-item form; shipped as a stand-alone component so future flows (collection picker, dashboard quick-add) can reuse it.
  - `src/components/lot-form.ts` (new) — Add/Edit modal. Fields: name, purchaseDate, totalCost, currency, allocationMethod, notes. Goes through `lotsRepo.create` / `lotsRepo.update` so PR 3's validation + audit run.
  - `src/components/lot-item-form.ts` (new) — Add/Edit modal. Fields: card (via picker), quantity, finish, edition, conditionType + raw / graded fields, `manualPriceOverride`, `marketEstimate`, note. Goes through `lotItemsRepo` so validation + audit run. **Does not** add `language`, `status`, or `tags` fields — `LotItemRecord` does not have them and adding them would be a schema migration outside this PR.
  - `src/views/lots.ts` (replaces placeholder) — table-style list with name/date/total/items/allocated/materialised/status/actions. Soft-delete via `window.confirm`. Refreshes on `USER_DATA_CHANGED_EVENT` with the `isConnected` guard.
  - `src/views/lot-detail.ts` (new) — page reached via `#lot/<id>`. Sections: summary header (with status chip + stale-allocation warning when `Math.abs(allocationDifference) > 0.01`), allocation toolbar (mode select + apply + materialise + CSV), items table (per-item edit / soft-delete except for materialised items which show a "Materialisert (låst)" label instead of action buttons), and "Legg til item" at the bottom. Card name in each item row links to `#card/<id>`. Mode change in the dropdown persists `lot.allocationMethod` immediately via `lotsRepo.update`; the actual allocation does not re-run until the user clicks "Beregn allokering på nytt".
  - `src/app.ts` — `lots` route now mounts the real `mountLotsView`; `'lot-detail'` registered in `VIEW_MOUNTERS` with `mountLotDetailView`.
  - `src/styles.css` — lots list table, lot detail summary + toolbar + items table, stale-allocation warning, lot form + lot-item form, card-picker typeahead.

### New audit actions
- `lot_allocation_applied` — written exactly once per `applyAllocation()` call, message includes mode, item count, and `remainingTotalCost`.
- `lot_holdings_materialized` — written exactly once per non-empty `materializeHoldings()` call, message includes holding count and lot name.
- `lot_csv_exported` — written by `recordExport()` after CSV content is handed to `downloadTextFile`.

### Tests (397 / 397 across 59 files)
- `tests/lot-allocation.test.ts` — equal `100/3 = 33.33/33.33/33.34`, empty list yields warning, `totalCost = 0` zeroes everything, negative totalCost errors, weighted proportional, weighted with mixed null/zero estimates, weighted all-zero errors, manual missing override errors, manual mismatch warns and still returns allocations, at-tolerance manual diff is silent.
- `tests/lot-service.test.ts` — applyAllocation writes **one** `lot_allocation_applied` audit and zero `lot_item_updated` rows; weighted-all-zero errors and writes nothing; reallocation excludes materialised items and only spreads `remainingTotalCost`; materialise writes N holdings + updates N lotItems + **one** bulk audit, no per-holding `holding_created` rows; materialise without allocation throws and leaves stores untouched; rerun materialise is a no-op when nothing left; reallocation after partial materialise preserves both the existing allocations and the existing `holding.purchasePrice`.
- `tests/lot-detail-service.test.ts` — status chip derivation (`unallocated` / `partial` / `allocated` / `materialized`), null on missing/soft-deleted lot, joins cards + holdings + computes `allocationDifference`.
- `tests/lot-csv-export.test.ts` — BOM + header + N rows, materialised flag flips to `true` after holdings are created, filename uses safe slug + date stamp, soft-deleted/missing lot returns null, `recordExport` writes one `lot_csv_exported` row.
- `tests/lot-card-picker.test.ts` — case-insensitive substring matching, exact-id fallback, click commits + notifies, empty hint, `initialCardId` hydrates the selection.
- `tests/lot-form.test.ts` — submit creates lot + writes `lot_created` audit; rejects empty name.
- `tests/lot-item-form.test.ts` — submit creates lot item with selected cardId; rejects submission without a card pick.
- `tests/lots-view.test.ts` — empty state, one row per live lot, "Ny lot" submit creates + rerenders, mount + render is read-only on user data.
- `tests/lot-detail-view.test.ts` — not-found state, summary + toolbar + items table render, stale-allocation warning visible before `applyAllocation` and gone after, materialise creates holdings via the service and locks the items.
- `tests/router.test.ts` extended — `getCurrentLotId` for normal routes, `#lot/<id>` decode/encode, malformed-id fallback, bare `lot-detail` not a sidebar route.
- All PR 1–8b tests including `tests/backup-roundtrip.test.ts` and `tests/browse-readonly-invariant.test.ts` remain green.

### Known limitations (PR 9)
- **No sales / business accounting / tax** — explicitly out of scope per KRAVSPEC. Materialise is a one-way conversion; un-link is not in MVP.
- **No automatic re-allocation when `lot.totalCost` changes.** The detail view shows a stale-allocation warning when `Math.abs(allocationDifference) > 0.01` and the user clicks "Beregn allokering på nytt" to re-run.
- **No global / collection / wishlist CSV export.** Lot CSV uses the same `utils/csv.ts` writer the binder export landed in PR 8b. The other CSVs land with the dashboard PR.
- **Lot import** is not in scope. Items are added one at a time through the form.
- **Materialisation does not back-fill `language`, `tags`, or `status` from the item** because `LotItemRecord` has no such fields. Holdings get `language='en'`, empty `tags`, `status='owned'` as defaults; the user can edit any holding from Min samling later.
- **Card picker hits the live cache.** A 20k-card cache is fine in memory; the picker caps results at 10 to keep the dropdown legible.

### Added
- **PR 8b — Binders from-set wizard, sjekkliste, mangler-filter, CSV-eksport.** Closes the binder feature surface for MVP. The from-set wizard generates target-card slots automatically, the binder detail view gains a Sider/Sjekkliste toggle and a five-state filter, and any binder can be exported as a CSV checklist. Owned-status semantics, atomic transactions, soft-delete-only, and the no-permanent-delete rule from PR 8a all hold.
  - `src/domain/card-variants.ts` (new) — `cardHasReverseHolo(card)` runtime-narrows `tcgplayer.prices.reverseHolofoil`. Defensive: returns `false` for unknown shapes. Does **not** consult cardmarket. Also exports `REVERSE_HOLO_TEMPLATE_MARKER = 'template:reverse_holo'` and `isReverseHoloTemplateSlot(note)`.
  - `src/domain/binder-template.ts` (new) — pure `generateFromSetSlots(cards, options)` returns `{ slots, summary }`. Standard mode = one slot per card. Master mode = base slot + a second slot with `note = REVERSE_HOLO_TEMPLATE_MARKER` for every card with a known reverse-holo printing (master + `includeReverseHolos: true`). `BinderSlotRecord` has no `finish` field, so the marker in `note` is the only place we record the variant — the UI renders this as "Reverse holo" and never shows the raw token. Cards are sorted by a natural-ish comparator: pure-numeric numbers first, then mixed strings; final tiebreak is `card.id`. `grand_master` is rejected explicitly so a stale form value cannot silently produce an empty template.
  - `src/utils/csv.ts` (new) — generic RFC 4180 CSV writer. CRLF line endings, UTF-8 with optional BOM (default ON), header-row always emitted, embedded quotes/commas/newlines properly escaped. Plus `slugifyForFilename(input, fallback)` — NFKD-decompose, strip combining marks, lowercase, non-alnum to hyphens, collapse, trim, fall back to `'binder'` (or supplied default) when the result is empty.
  - `src/services/binder-service.ts` — extends with `createBinderFromSet({ binder, slots })`. Reuses the same `db.transaction('rw', binders, binderSlots, auditLog, …)` shape as PR 8a's `createManualBinder` so a from-set binder lands atomically: binder row, every slot, **one** `binder_created` audit row whose message includes the source set id and the chosen completion mode. `totalPages` is derived from the slot drafts so the persisted binder always matches the actual slot population. `binder.sourceSetId` is required and persisted. Validation runs before the transaction opens.
  - `src/services/binder-csv-export.ts` (new) — `createBinderCsvExporter(...)` returns `{ build(binderId), recordExport(binder, rowCount) }`. `build()` is read-only and joins binder + live slots + cards + sets + (live) holdings, then runs the rows through `csv.ts`. The exporter never mutates user data. Reverse-holo template slots get `finish=reverse_holo` in the CSV; the raw marker is hidden from the `slot_note` column. `recordExport()` writes a single `binder_csv_exported` audit row inside its own narrow rw-transaction over `auditLog` only — it is called **after** the CSV content has been generated and handed to `downloadTextFile`. Browsers cannot reliably observe a successful "save to disk", so the audit is documented as "CSV was generated and a download was started", not "the user definitely saved the file". Filename: `binder-checklist-<safe-slug>-<YYYYMMDD>.csv`.
  - `src/components/binder-from-set-wizard.ts` (new) — single dialog. Sets are listed sorted `releaseDate` desc. Name auto-fills from set name (`<setName>` for standard, `<setName> (master)` for master) and stops auto-updating once the user types in the name field. Live preview shows base / reverse-holo / total slots and required pages, recomputed on every change. Submit calls `binderService.createBinderFromSet`; failures surface inline. Cards are loaded once per `setId` and cached in the wizard's lifetime so toggling modes does not re-fetch.
  - `src/views/binders.ts` — adds a second action button "Ny perm fra sett" next to "Ny perm". Manual flow (PR 8a) and from-set flow open separate dialogs.
  - `src/views/binder-detail.ts` — substantial rewrite. Toolbar adds **Sider / Sjekkliste** toggle, a five-state filter (`alle | mangler | bestilt | duplikater | ferdig`), and an "Eksporter sjekkliste (CSV)" button. The filter applies to **both** views. **Sider preserves physical grid positions:** filtered-out slots remain in their grid cell with `binder-slot--filtered-out` (opacity + saturation) so cell positions never shift, but the tile renders **no focusable descendants whatsoever** — the actions container, the assign / status buttons, and even the card-name link are all skipped when `!matchesFilter`. The filter contract holds (filtered slots cannot be mutated by accident) and `aria-hidden` content has no focusable descendants for screen-reader / keyboard users. Reverse-holo template slots gain a `binder-slot--reverse-template` border style and a small "Reverse holo" label. The new Sjekkliste table shows `# / Kortnavn / Sett # / Finish / Mål-status / Eid / Side.Slot / Tilstand / Notat / Handlinger`, sorted by physical slot order. Row actions reuse `slot-action-menu` and `assign-holding-modal` — no new mutation paths. The slot-note column hides the internal reverse-holo marker; user-authored notes still pass through unchanged.
  - `src/styles.css` — toolbar (toggle + filter + export), filtered-out slot styling, reverse-holo dashed border, finish-badge label, sjekkliste table (sticky header, status-tinted rows), wizard form layout, preview block.

### Tests (344 / 344 across 50 files)
- `tests/card-variants.test.ts` — `cardHasReverseHolo` true only when `tcgplayer.prices.reverseHolofoil` is an object; returns false for null tcgplayer / missing prices / non-object reverseHolofoil / cardmarket-only data; marker token equals `'template:reverse_holo'`; `isReverseHoloTemplateSlot` only matches exactly.
- `tests/binder-template.test.ts` — natural sort (`1, 2, 9, 10, 102` then `TG01, TG02`), standard one-slot-per-card with correct page/slot indexing, master adds reverse-holo slots only for cards with the marker, `includeReverseHolos: false` skips them, standard never emits reverse holos, `grand_master` rejected, invalid `slotsPerPage` rejected, empty card list returns 0 slots and `totalPages = 1`.
- `tests/csv.test.ts` — header even with no rows, CRLF line endings, BOM default ON, escaping for commas + quotes + newlines, booleans render `true` / `false`, null/undefined render as empty, non-finite numbers render as empty, empty columns array throws, slug helper handles diacritics + collapsed hyphens + fallback.
- `tests/binder-from-set-service.test.ts` — atomic write of binder + slots + 1 audit row with the from-set audit message; `totalPages` derived from slots length; rollback on validator failure leaves all three stores empty; rollback on per-slot validation failure leaves all three stores empty; empty slot list rejected.
- `tests/binder-from-set-wizard.test.ts` — empty-state when no cached sets, set list sorted releaseDate desc, name auto-fills standard/master, master preview includes reverse-holo count, submit produces exactly one binder + slot rows + one `binder_created` audit (`sourceSetId` recorded).
- `tests/binder-detail-checklist.test.ts` — Sider/Sjekkliste toggle works, Sjekkliste finish column shows "Reverse holo" for template slots **without leaking the raw token**, missing filter narrows checklist to non-complete slots, completed filter shows only KRAVSPEC §6-complete slots, **Sider-view filter preserves grid cells** (filtered slots get `binder-slot--filtered-out`, count stays), **filtered-out slots have no interactive controls** (no `assign` / `open-menu` / `open-card` buttons, no focusable descendants at all), **clicking inside a filtered-out slot opens no dialog**, matching slots still render their action buttons normally.
- `tests/binder-csv-export.test.ts` — BOM + header + one row per slot, exact column order, reverse-holo template slot renders `finish=reverse_holo` and the raw marker NEVER appears in the file, assigned holding flows into condition columns, filename is `binder-checklist-<slug>-<YYYYMMDD>.csv`, missing/soft-deleted binder returns null, `recordExport` writes one `binder_csv_exported` audit row.
- All PR 1–8a tests including `tests/backup-roundtrip.test.ts` and `tests/browse-readonly-invariant.test.ts` remain green.

### Known limitations (PR 8b)
- **Grand-master mode** is still reserved. The wizard never offers it and `generateFromSetSlots` rejects it.
- **Promos / stamped** are not wizard-selectable categories. They're already part of the cards list for any set that includes them and arrive as standard slots — the wizard does not generate extra finish-variant slots for them.
- **Reverse-holo finish on `BinderSlotRecord`** is encoded in `slot.note` as the internal marker `template:reverse_holo`. `BinderSlotRecord` has no native `finish` field; adding one would be a schema migration outside this PR's scope. The marker is hidden from every user-facing surface (Sider grid, Sjekkliste, CSV `slot_note` column).
- **Browse "missing in binder"-filter is intentionally NOT shipped here.** The binder detail filter + CSV give the practical "what's left to find" workflow without needing a Browse-side join over slots.
- CSV audit semantics: `binder_csv_exported` means **CSV content was generated and handed to `downloadTextFile`**, not "saved to disk" — browsers cannot reliably observe download completion.
- Resizing existing binders (`slotsPerPage` / `totalPages` immutability) is unchanged from PR 8a.

### Added
- **PR 8a — Binders core: list view, manual create, page/slot detail, Card Detail integration.** First time a binder structure becomes visible and editable from the UI. Scope is intentionally narrow — the from-set wizard, master/grand-master template generation, missing-list filter, checklist alternative view, and binder CSV export ship in PR 8b. Owned status is **only** reachable through assignment of a holding (per KRAVSPEC §6); the slot status menu deliberately omits "Mark owned".
  - `src/router.ts` — adds the `#binder/<encodedBinderId>` sub-route. New `getCurrentBinderId()` and `navigateToBinder()` helpers mirror the PR 6 card-detail path: encoding via `encodeURIComponent`, decoding with a try/catch fallback, and `getCurrentRoute()` returning `'binder-detail'` only when the decoded id is non-empty. Bare `#binder/` and malformed encodings fall back to the default route. The card and binder id extractors share a unified `extractIdAfterPrefix()` helper.
  - `src/domain/binder-completion.ts` — pure, DB-free math for KRAVSPEC §6 completion. `calculateBinderCompletion(slots, liveHoldingIds)` returns `{ totalTargetSlots, completedSlots, missingSlots, percentage }`. A slot counts as **complete** only when `status === 'owned'` AND `holdingId !== null` AND the referenced holding id is in the `liveHoldingIds` set. Soft-deleted slots and slots with `targetCardId === null` are excluded from the denominator. Percentage is rounded to a whole number; the all-zero case returns 0.
  - `src/repositories/binder-slots-repo.ts` — extends the `update()` audit logic. The audit action now follows a precedence rule:
    - `holdingId` set to a non-null id → `binder_slot_assigned`
    - else `status` changed → `binder_slot_status_changed`
    - else → `binder_slot_updated`
    Assigned wins over status when both fields change in the same call (which is what the assign-holding modal does). Clearing `holdingId` (passing `null`) does **not** count as assigned, so the "Tøm slot" path keeps writing `binder_slot_status_changed`.
  - `src/services/binder-service.ts` — `createManualBinder(input)` runs the binder add, every empty slot (`totalPages * slotsPerPage`), and a single `binder_created` audit row inside one Dexie `rw` transaction over `binders`, `binderSlots`, and `auditLog`. If validation fails before the transaction opens — or any inner write throws — the database is left untouched. Slots are created with `status='empty'`, `holdingId=null`, `targetCardId=null`. The from-set template path in PR 8b will reuse this same shape with non-null `targetCardId` values.
  - `src/services/binder-slot-service.ts` — read-only joins. `listSummaries()` returns one entry per live binder with completion stats (sorted by most-recently-updated first). `getDetail(binderId)` returns the binder + every live slot (sorted by page+slot ascending) with joined `holdingsById` / `cardsById` maps so the view never makes per-slot lookups. `slotsForCardId(cardId)` returns every live binder slot that mentions the card — either via `targetCardId` or via the assigned holding's `cardId` — used by the Card Detail "Binder-lokasjoner" section.
  - `src/components/binder-form.ts` — Add/Edit modal. Fields: name, description, binder type (free text), slots-per-page (9 or 18), totalPages, completion mode (standard / master). The "Det opprettes N tomme slots" hint updates live as the user changes the layout fields. **Edit mode disables `slotsPerPage` and `totalPages`** — resizing a binder mid-life would require deciding what to do with slots that fall outside the new range and is out of scope for PR 8a. Create mode goes through `binderService.createManualBinder`; edit mode goes through `bindersRepo.update` and only forwards the mutable fields.
  - `src/components/slot-action-menu.ts` — small dialog opened from each slot's "Endre status" button. Buttons for `wanted`, `ordered`, `missing`, `duplicate`, `upgrade_needed`, plus "Tøm slot". The menu hides the option matching the slot's current status. **No "Mark owned" button** — owned only via assignment. "Tøm slot" preserves `targetCardId` **and `note`** (both user-data — no UI for slot notes ships in PR 8a, but `BinderSlotRecord.note` exists in the schema and a restored backup can already carry note text), and resets `holdingId=null`, `status='wanted'` (or `'empty'` when there is no target).
  - `src/components/assign-holding-modal.ts` — opened from each slot's "Tilordne holding" / "Bytt holding" button. Filter rule: when `slot.targetCardId` is set, only live holdings for that card are listed; when it is null (blank manual slot), every live holding is listed. On submit the modal sets `holdingId`, `status='owned'`, and **back-fills `targetCardId` to `holding.cardId`** for blank manual slots so the completion denominator is well-defined. Empty-state message tells the user to add a holding first when no candidates exist.
  - `src/views/binders.ts` (replaces placeholder) — list of `<article class="binder-card">` cards with name, optional binder type and description, totalPages / slotsPerPage / mode stats, completion text + a `role="progressbar"` strip, and Edit / Slett actions. Soft-delete is gated by `window.confirm()` and writes through `bindersRepo.softDelete`. Empty state explains how to create the first binder. Refreshes on `USER_DATA_CHANGED_EVENT` with the standard `isConnected` guard.
  - `src/views/binder-detail.ts` (new) — page/slot grid keyed by `slotsPerPage` (`grid--9` for 3×3, `grid--18` for 3×6). Each slot tile shows page.slot index, status badge (`status-chip--<status>`), assigned holding's card thumbnail + name (linking to Card Detail) or — when no holding — the target card or "Tom slot" placeholder. Two action buttons per slot: "Tilordne holding" / "Bytt holding" (assign modal) and "Endre status" (slot action menu). Header shows the binder summary + a progressbar mirroring the list view. Refreshes on `USER_DATA_CHANGED_EVENT` with the `isConnected` guard. Falls back to a "Permen finnes ikke" message if the route id does not match a live binder.
  - `src/views/card-detail.ts` — adds a `Binder-lokasjoner` section between the "Dine kort" holdings table and the "Ønskeliste-status" table. Lists every binder slot that mentions the card, distinguishing target matches ("Mål-kort") from assigned-holding matches ("Tilordnet holding"), with an "Åpne perm" button that navigates to `#binder/<id>`. Empty state explains how to assign a holding. Soft-deleted binders never appear.
  - `src/app.ts` — `binders` route now mounts the real `mountBindersView`; `'binder-detail'` registered in `VIEW_MOUNTERS` with `mountBinderDetailView`.
  - `src/styles.css` — binder list cards, binder detail page/slot grid (9 and 18 column variants), per-status status-chip variants (`empty`, `wanted`, `owned`, `missing`, `ordered`, `duplicate`, `upgrade_needed`), binder-form / assign-holding-modal / slot-action-menu layouts, Card Detail Binder-lokasjoner table.

### Tests (289 / 289 across 43 files)
- `tests/binder-completion.test.ts` — pure math: empty array → 0/0/0/0, only target slots count, owned + holdingId + live → complete, owned + dead holding → not complete, duplicate + live holding → not complete, soft-deleted slots skipped, percentage rounding.
- `tests/binder-service.test.ts` — atomic create writes binder + 27 slots + 1 audit for a 3×9 binder, validation failure leaves all three stores untouched, 18 slots-per-page produces slot numbers 1..18.
- `tests/binder-slot-service.test.ts` — `listSummaries` joins completion stats per binder, soft-deleted binders excluded; `getDetail` joins holdings + cards and skips soft-deleted slots; `slotsForCardId` matches both target and assigned holdings, ignores soft-deleted binders.
- `tests/binder-slot-audit.test.ts` — audit-action precedence: setting `holdingId` writes `binder_slot_assigned` even when status also changes, status-only writes `binder_slot_status_changed`, neither writes `binder_slot_updated`, clearing `holdingId` (null) does **not** count as assigned.
- `tests/binders-view.test.ts` — empty state, one card per live binder with progressbar at 0%, "Ny perm" submit creates binder + 18 slots + 1 audit, mount + render is read-only on user data.
- `tests/binder-detail-view.test.ts` — not-found state, 9-slot grid renders, slot action menu has no "Mark owned" option and applies status changes through the repo, "Tilordne holding" sets `holdingId` + back-fills `targetCardId` + sets `status='owned'`, **"Tøm slot" preserves both `targetCardId` and `note`** and resets to `wanted`.
- `tests/card-detail-with-binders.test.ts` — Binder-lokasjoner empty state, lists both target and assigned matches in the same row format, soft-deleted binders are excluded.
- `tests/router.test.ts` (extended) — `getCurrentBinderId` for normal routes, `#binder/<id>` decoding, `navigateToBinder` encoding, malformed-id fallback, `binder-detail` as bare hash falls back.
- All PR 1–7b tests including `tests/backup-roundtrip.test.ts` and `tests/browse-readonly-invariant.test.ts` remain green.

### Known limitations (PR 8a)
- **From-set wizard, checklist view, missing-list filter, master/grand-master template generation, and binder CSV export ship in PR 8b.** This PR is structural; PR 8b is the data import + alternative view layer.
- Binder layout (slotsPerPage, totalPages) is **immutable after creation** in this PR. Resizing a binder mid-life is out of scope and would need a slot migration. The form's edit mode disables both fields.
- Slot soft-delete is not exposed in the UI; deleting a slot in isolation has no clear product use case in PR 8a. The repo still supports it (audit-correct) for tests and future flows.
- The detail view re-fetches holdings + cards on every refresh — fine at MVP scale (≤ ~10k holdings) and avoids the complexity of a per-view cache. Profiling can revisit this once the dashboard lands in PR 10.
- Card thumbnails on the detail grid use `imageSmall`. The detail view does not show prices or condition for the assigned holding; "Åpne kortdetalj" is one click away through the card-name link.

### Added
- **PR 7b — Wishlist UI: Wishlist view, Add/Edit/Remove form, Browse + Card Detail integration.** Completes the user-data write surface started in PR 7a. The "Legg til i ønskeliste" buttons in Browse and Card Detail are now active and open a wishlist form modal. The Wishlist sidebar route is no longer a placeholder. **No tags on wishlist** — `WishlistRecord` does not have a `tags` field, and adding one would be a schema migration outside this PR's scope.
  - `src/repositories/wishlist-repo.ts` — adds `listByCardId(cardId)` using the existing `cardId` index from PR 3's schema. Returns both live and soft-deleted entries; callers narrow.
  - `src/components/wishlist-form.ts` — Add/Edit modal. Fields: finish, priority (low / medium / high / grail), target condition (raw conditions + blank), target price + currency, status (wanted / ordered / received / cancelled), note. Pre-validates inline; the actual write goes through `wishlistRepo.create` / `wishlistRepo.update` so PR 3's repo validation and audit are still authoritative.
  - `src/services/wishlist-service.ts` — joins `wishlist` + `cards` + `sets` and returns `WishlistRow[]` with `liveTotal` / `deletedTotal` counts. Filters: `status`, `priority`, `setId`, `search`, `showDeleted`. Default sort is **priority desc** with `createdAt` asc tiebreak; the priority enum is mapped to a numeric rank (`grail=4`, `high=3`, `medium=2`, `low=1`) inside the service. `listForCard()` returns ordered entries for one card.
  - `src/services/browse-service.ts` — extended with optional `wishlist: 'on-wishlist'` filter. Loads live wishlist entries once and builds a `Set<cardId>` of cards with status `wanted` or `ordered`. `received` and `cancelled` count as inactive.
  - `src/views/wishlist.ts` (replaces placeholder) — full table with toolbar, status / priority / set / search filters, default `priority desc` sort, `Vis slettede` toggle, soft-delete via `window.confirm`, restore.
  - `src/views/browse.ts` — `Legg til i ønskeliste` enabled (was disabled in PR 7a). New `Ønskeliste` filter (`Alle` / `På ønskelisten`). The `Eier` filter from PR 7a is unchanged.
  - `src/views/card-detail.ts` — `Legg til i ønskeliste` enabled. New `Ønskeliste-status` section lists every live wishlist entry for the card with Rediger / Fjern actions. The PR 7a `Dine kort` section is unchanged.
  - `src/app.ts` — registers `mountWishlistView` for the `wishlist` route.
  - `src/styles.css` — Wishlist table, wishlist-form layout (mirrors holding-form), Card Detail wishlist-status table.

### Tests (250 / 250 across 36 files)
- `tests/wishlist-service.test.ts` — live / deleted totals, default-deleted exclusion, priority desc default places `grail` first, status / priority / search filters, `showDeleted` toggle, `listForCard` ordering.
- `tests/wishlist-form.test.ts` — add + edit rendering, valid save through the repo, **no `tags` field is rendered**, negative target price blocks save, prefill on edit + status update through the repo, `wishlist_item_created` / `wishlist_item_updated` audit rows.
- `tests/wishlist-view.test.ts` — view structure, edit + Fjern actions, `Vis slettede` reveals deleted rows with Restore, empty state.
- `tests/browse-with-wishlist.test.ts` — Add to wishlist enabled and opens dialog, **on-wishlist filter includes `wanted` + `ordered`, excludes `received` / `cancelled` / soft-deleted**, passive interactions do not write user data, save through dialog produces exactly one new wishlist row + one audit row.
- `tests/card-detail-with-wishlist.test.ts` — Add button opens form, empty / populated `Ønskeliste-status` states, Fjern from Card Detail writes `wishlist_soft_deleted` audit, `Dine kort` section from PR 7a still renders.
- `tests/card-detail-view.test.ts` (existing) — updated assertion: both Add buttons are now enabled.
- `tests/browse-with-holdings.test.ts` (existing) — updated to match PR 7b: wishlist button is now enabled.
- `tests/browse-view.test.ts` (existing) — disabled-button-doesn't-navigate test reframed as "Add buttons handle their own clicks".
- All PR 1–6 tests including `tests/backup-roundtrip.test.ts` and `tests/browse-readonly-invariant.test.ts` remain green.

### Known limitations (PR 7b)
- `received` / `cancelled` are reachable via the Edit modal; there's no one-click row toggle yet. Can be polished later.
- Card Detail's `Ønskeliste-status` shows live entries only. Soft-deleted ones are still reachable via the dedicated Wishlist view's `Vis slettede` toggle.
- Bulk operations (mark many as cancelled, etc.) are out of scope for MVP.

### Added
- **PR 7a — Holdings: Collection view, Add/Edit/Delete flow, Browse + Card Detail integration.** First user-data writes from the UI. Wishlist UI is intentionally deferred to PR 7b — its Browse / Card Detail buttons remain disabled with the `kommer i PR 7b` tooltip.
  - `src/components/dialog.ts` — small `<dialog>` wrapper. `openDialog(content)` returns a Promise resolving to `'submitted'` or `'cancelled'`. Falls back to `setAttribute('open', '')` + manual `close` event when running under jsdom (older versions miss `dialog.close`).
  - `src/components/events.ts` — `USER_DATA_CHANGED_EVENT = 'pokemon:user-data-changed'`. Dispatched after every successful holding mutation; views listen and refresh.
  - `src/components/holding-form.ts` — Add/Edit modal. Renders all fields from `DATA_MODEL.md` §7 (quantity, condition type + raw / graded fields, finish, edition, language, purchase price + currency, manual estimated value + currency, tags, note, status, special variant). Pre-validates inline; the actual write goes through `holdingsRepo.create` / `holdingsRepo.update` so PR 3's repo validation and audit are still authoritative.
  - `src/domain/tags.ts` — `parseTags(text)` (comma-split, trim, lowercase, dedupe, first-occurrence ordered) + `formatTags`.
  - `src/services/collection-service.ts` — joins `holdings` + `cards` + `sets` and returns `CollectionRow[]` with `liveTotal` / `deletedTotal` counts. Filters: `conditionType`, `rawCondition`, `setId`, `status`, `missingCondition`, `missingValue`, `showDeleted`, `search`. Default sort: `updatedAt` desc per UI_DESIGN_SPEC §23. `listForCard()` returns the ordered holdings for a single card (live first, deleted last).
  - `src/services/browse-service.ts` — extended with optional `ownership: 'owned' | 'not-owned'` filter. Loads live holdings once and builds a `Set<cardId>` for O(1) per-card filtering.
  - `src/views/collection.ts` (replaces placeholder) — full table with toolbar, pagination, soft-delete with `confirm()` dialog, restore from a "Vis slettede" toggle, audit-correct mutation paths. Listens for `USER_DATA_CHANGED_EVENT` and re-renders only when the view is still attached (`isConnected` guard).
  - `src/views/browse.ts` — "Legg til i samling" enabled, opens the holding form modal. New `Eier` filter (Alle / Eid / Ikke eid). "Legg til i ønskeliste" remains disabled with the `kommer i PR 7b` tooltip. Click handler split so disabled buttons never navigate.
  - `src/views/card-detail.ts` — "Legg til i samling" enabled. New "Dine kort" section lists every holding for the card (raw and graded as separate rows) with Edit / Slett / Gjenopprett actions. Refreshes on `USER_DATA_CHANGED_EVENT`. "Legg til i ønskeliste" stays disabled with the `kommer i PR 7b` tooltip.
  - `src/app.ts` — registers `mountCollectionView` for the `collection` route.
  - `src/styles.css` — Collection table, dialog wrapper, holding-form layout, danger-action variant for destructive buttons.

### Tests (223 / 223 across 31 files)
- `tests/tags.test.ts` — `parseTags` / `formatTags` round-trip, dedupe, lowercasing, empty-token dropping.
- `tests/dialog.test.ts` — `<dialog>` mount, `submitted` / `cancelled` resolution, jsdom fallback path.
- `tests/holding-form.test.ts` — add-mode + edit-mode rendering, valid raw save through the repo, graded validation blocks save, negative purchase price blocks save, manual-value entry sets `valueSource = 'manual'` + `valueUpdatedAt`, dispatches `USER_DATA_CHANGED_EVENT`, audit row written.
- `tests/collection-service.test.ts` — live / deleted totals, default-deleted exclusion, `showDeleted` toggle, conditionType / setId / missingCondition / missingValue filters, search, default sort, `listForCard` ordering.
- `tests/collection-view.test.ts` — view structure, edit and soft-delete actions, `Vis slettede` reveals deleted rows with Restore, counts header, empty state.
- `tests/browse-with-holdings.test.ts` — Add button enabled and opens dialog, wishlist button stays disabled with `kommer i PR 7b`, owned / not-owned filter narrows rows, **passive interactions (search, sort, filter, page) do not write user data**, save through dialog produces exactly one new holding + one `holding_created` audit row.
- `tests/card-detail-with-holdings.test.ts` — Add button opens form, "Dine kort" empty / populated states, soft-delete from Card Detail writes one `holding_soft_deleted` audit.
- `tests/card-detail-view.test.ts` (existing) — updated assertion to match the new state: Add to collection enabled, Add to wishlist still disabled with `kommer i PR 7b`.
- All PR 1–6 tests including `tests/backup-roundtrip.test.ts` and `tests/browse-readonly-invariant.test.ts` remain green: passive Browse + Card Detail interactions still never write.

### Known limitations (PR 7a)
- Wishlist UI is deferred to PR 7b. Browse and Card Detail buttons render disabled with the documented tooltip.
- Card Detail's "binder locations" section (UI_DESIGN_SPEC §13) is deferred to PR 8 alongside binders.
- Lot picker on the holding form is deferred to PR 9; `holding.lotId` is preserved on edit but cannot be set in the UI yet.
- Sort by **value** in Browse is still deferred (an editable "value" needs aggregated holdings — coming with the dashboard in PR 10).
- The `<dialog>` wrapper relies on the browser's native modal behaviour; tests run against jsdom's partial implementation via the `setAttribute('open', '')` fallback.

### Added
- **PR 6 — Browse + Card Detail views over the cached card database.** First user-facing surface that reads from cache. Read-only over `cards` and `sets`; never reads or writes any user-owned store. Add-to-collection and add-to-wishlist buttons render disabled with a "kommer i PR 7" tooltip.
  - `src/router.ts` — extended with `#card/<encodedCardId>` sub-route. `getCurrentCardId()` decodes safely (returns `null` on empty or malformed input); `navigateToCard()` encodes via `encodeURIComponent`; `getCurrentRoute()` returns `'card-detail'` only when a non-empty card id is present, otherwise falls back to the default. The bare string `card-detail` is **not** a valid sidebar hash, so a malformed URL does not produce an empty page.
  - `src/services/browse-service.ts` (new) — joins `cards` and `sets` and returns rows as `{ card, set }` so the view never makes per-row set lookups. Picks the most selective indexed filter as the candidate set (`listBySet` / `listByRarity`) and applies remaining filters in JS. Default sort is set release date desc, with card number ascending tiebreak inside the same set. Search is case-insensitive substring against `name`, with whitespace trimmed.
  - `src/repositories/cards-repo.ts` — added `listByRarity(rarity)` so the browse service can use the existing `rarity` index.
  - `src/views/browse.ts` (replaces placeholder) — table-first, search + set / rarity filters + sort + sort-direction + page-size, paginated `<tbody>` re-render only (toolbar input focus is preserved). Search debounces at 150 ms. Empty state when the cache is empty links to Settings. At most `pageSize` rows in the DOM (verified by test). The owned / not-owned / missing / wishlist filters from UI_DESIGN_SPEC are deliberately **not** rendered in this PR — they require user-data joins and land in PR 7.
  - `src/views/card-detail.ts` (new) — large image, name, set name, number, rarity, supertype, subtypes, types, and safely-extracted TCGplayer / Cardmarket prices. "Legg til i samling" / "Legg til i ønskeliste" buttons disabled with the documented tooltip. The "all user holdings for this card" and "binder locations" sections from UI_DESIGN_SPEC §13 are deferred to PR 7.
  - `src/domain/price-extractors.ts` (new) — `extractTcgplayerPrices()` and `extractCardmarketPrices()`. Runtime-narrows the `unknown` price fields, returns a flat `PriceRow[]`, falls back to an empty array on unfamiliar shapes (the view shows "Ingen prisdata"). Never assumes the API shape — defence against shape drift.
  - `src/utils/lazy-image.ts` (new) — `createLazyImage()` builds an `<img loading="lazy" decoding="async">`; on load error swaps for a neutral placeholder so a broken thumbnail does not leave a crossed-out icon in a row.
  - `src/app.ts` — registers `card-detail` in the view-mounter map; topbar logic unchanged.
  - `src/styles.css` — browse table, toolbar, pagination, empty state, lazy-image placeholder, card-detail layout.
  - **Tests (181 / 181 across 24 files):**
    - `tests/router.test.ts` extended: `getCurrentCardId` for normal routes, `#card/<id>` decoding, `navigateToCard` encoding, malformed hash fallback, `card-detail` as bare hash falls back.
    - `tests/browse-service.test.ts` (new): join with set, default set-release sort with card-number tiebreak, set / rarity / combined filters, case-insensitive trimmed search, pagination, empty cache.
    - `tests/browse-view.test.ts` (new): empty state + Settings link, 60 cards → 50 on page 1 / 10 on page 2, debounced case-insensitive search, row click navigates, **clicking a disabled quick-action button does not navigate**, "Vis detaljer" navigates, no more than `pageSize` rows in the DOM with 200 cards.
    - `tests/card-detail-view.test.ts` (new): metadata + price rendering, "not in cache" state, missing card-id state, back button to `#browse`, **disabled action buttons with PR 7 tooltip**, unfamiliar price shape does not crash, planted `<script>` / `<img onerror>` in card name and set name render as text (not as HTML).
    - `tests/browse-readonly-invariant.test.ts` (new): seeds every user-owned store, drives Browse and Card Detail through filtering / paging / navigating, asserts every user-owned store is byte-for-byte unchanged.
  - `tests/backup-roundtrip.test.ts` remains green: PR_RULES §10 contract holds.

### Known limitations (PR 6)
- Sort by **value** is documented in UI_DESIGN_SPEC §11 but is intentionally not exposed in the toolbar — reliable price extraction lives in `domain/price-extractors.ts` for the detail view, but a "value" sort needs a stable per-card numeric value (manual or live-priced) and lands with the user-data layer.
- Substring search runs in memory (the cards index supports prefix only). For 20 000 cards this is acceptable; a normalized search index can be added in a later schema PR if profiling shows it is needed.
- Owned / not-owned / missing / wishlist filters are deferred to PR 7 because they require reading user-owned stores.
- Filter state is not preserved across navigation in this PR.

### Added
- **PR 5 — pokemontcg.io API sync + Settings view + topbar sync chip.** First time the app talks to the network. Sync is fetch-all-first-then-write-once: a failed sync leaves the cache, user-owned stores, and `lastSyncAt` untouched. The MVP roundtrip contract (`tests/backup-roundtrip.test.ts`) stays green.
  - `src/api/sanitize.ts` — `sanitizeErrorMessage(error, apiKey)` and `redactApiKey(text, apiKey)`. Used at every boundary that turns an error into UI / audit / appMeta text.
  - `src/api/types.ts` — wire DTOs (`PokemonTcgSetDto`, `PokemonTcgCardDto`, `PokemonTcgPaginatedResponse`) and pure mappers (`mapApiSet`, `mapApiCard`) that normalize optional/null API fields into our strict `SetRecord` / `CardRecord` shape.
  - `src/api/retry.ts` — `fetchWithRetry()` and `parseRetryAfterMs()`. Retries 429 (respecting `Retry-After` delta-seconds; HTTP-date form falls back to policy backoff), 5xx, and network errors with exponential backoff (1 s → 2 s → 4 s → 8 s, capped at 30 s). 4xx other than 429 fail immediately. `sleep` and `fetch` are injectable; tests pass a fake sleep so retries never wait wall-clock seconds. The retry loop applies its own ceiling so a server-supplied `Retry-After: 999999` still sleeps ≤ 30 s.
  - `src/api/pokemon-tcg-api.ts` — `createApiClient({ apiKey, fetchImpl, sleep, baseUrl, pageSize, retry })`. Methods: `fetchAllSets`, `fetchAllCardsForSet`, `testConnection`. The API key only goes in the `X-Api-Key` header; the client refuses to put it in the URL. Errors thrown out of the client are sanitized — even an accidental `fetch` implementation that echoes the header into its message cannot leak the key.
  - `src/db/sync.ts` — `syncCardDatabase({ db, apiKey?, fetchImpl?, sleep?, apiClient?, onProgress? })`. Fetches every set + every card into memory first. **Only after every fetch succeeded** does it open one Dexie `rw` transaction over `[sets, cards, appMeta, auditLog]` to clear-and-replace the cache, set `appMeta.lastSyncAt`, set `appMeta.lastSyncStatus = 'ok'`, clear `appMeta.lastSyncError`, and append exactly one `sync_run` audit row. On failure (during fetch or commit) it opens a separate small `rw` transaction over `[appMeta, auditLog]` only — sets `lastSyncStatus = 'failed'`, writes a sanitized `lastSyncError`, and appends one `sync_failed` audit. Cache, user-owned stores, and `lastSyncAt` are untouched on failure. The orchestrator never reads or writes `settings`, `holdings`, `binders`, `binderSlots`, `lots`, `lotItems`, or `wishlist`.
  - `src/views/settings.ts` — replaces the placeholder. Sections: **API** (password input + Save + Test connection + last-status feedback), **Sync** (last sync, status, last error, sets / cards counts, `Synk nå` with progress + result panel), **Defaults** (preferred currency, default raw condition, default binder slots-per-page), **Storage** (persistent storage status + schema version). The view owns reading and saving the API key via `settingsRepo`; the sync orchestrator never touches `settings`. After a successful sync the view dispatches `window.dispatchEvent(new CustomEvent('pokemon:sync-completed'))` so any listener (currently the topbar) can refresh — no global state framework. All dynamic content is rendered via `textContent` / `createElement`.
  - `src/app.ts` — topbar status region now renders a sync chip read from `appMeta.lastSyncAt` / `lastSyncStatus`. It listens for `pokemon:sync-completed` and re-reads. The view runner already supports interactive `(container) => void` mounts from PR 4; Settings now uses that signature.
  - `src/styles.css` — Settings-view classes mirroring the Backup-view panel/button/feedback look.
  - `src/domain/types.ts` — adds two reserved `appMeta` keys (`lastSyncStatus`, `lastSyncError`) and a `SyncStatus = 'ok' | 'failed'` type.
  - **Tests (139 / 139, 19 files):**
    - `tests/api-retry.test.ts` — 2xx fast path, 429 + `Retry-After` (seconds), 5xx exponential backoff, network-error retry, max-attempts exhaustion, no retry on other 4xx, fake sleep keeps tests sub-second, `Retry-After` clamp inside the loop.
    - `tests/api-client.test.ts` — pagination, DTO → record mapping, API key sent only in `X-Api-Key` (never in URL), header omitted when no key, sanitized errors, `testConnection()` returns `false` on error without leaking the key.
    - `tests/sync.test.ts` — happy path populates cache, success writes `lastSyncAt`/`lastSyncStatus=ok`/one `sync_run` audit, failure leaves cache + every user-owned store + `lastSyncAt` unchanged and writes one `sync_failed` audit + sanitized `lastSyncError`, progress callback fires for both sets and cards phases, sanitized error messages never contain the API key value.
    - `tests/settings-view.test.ts` — view mounts the four panels, API-key input is `type=password`, Save commits to the settings repo and surfaces a feedback message, `<script>` injected into `lastSyncError` is rendered as text (no script element appears), Save defaults persists currency / condition / slots-per-page, hydration restores existing settings on mount.
  - `tests/backup-roundtrip.test.ts` remains green: PR_RULES §10's mandatory contract holds across the new sync code path.
  - **Patch:** Renamed `SYNC_COMPLETED_EVENT` to `SYNC_STATUS_CHANGED_EVENT` (`'pokemon:sync-status-changed'`) and moved the dispatch into a `finally` block in the Settings view's sync handler so it fires after **both** successful and failed sync attempts. Without this, the topbar chip would stay "ok" after a subsequent failure until the user reloaded. New `tests/sync-status-event.test.ts` mounts the full app shell, drives a failed sync via the Settings view (with `vi.stubGlobal('fetch', ...)` returning 401 so retries fail fast), and asserts the topbar chip text contains `sync_failed` — proving the chip refreshes without reload. A second test covers the success path the same way.

### Added
- **PR 4 — Backup, restore, validation, round-trip tests, minimal Backup view.** The data-layer contract that all later PRs must keep green: `export → wipe → restore` produces an equivalent database. PR 4 adds:
  - `src/db/backup.ts` — `readBackupSnapshot()` (pure read; supports `includeApiKey: false` default), `serializeBackupToJson()` (UTF-8, two-space indent, no BOM), `buildBackupFileName()` (`pokemon-tracker-backup-v1-YYYYMMDD-HHMMSS.json`), and `exportToBackupFile()` which captures the snapshot first, then records `appMeta.lastBackupAt`, `appMeta.lastBackupHoldingCount`, and a `backup_exported` audit entry on the live DB.
  - `src/db/auto-backup.ts` — `tryPreRestoreAutoBackup()`: best-effort, never-throwing snapshot-and-serialize used as the safety net before a destructive restore. Returns `{ ok: true, filename, json }` or `{ ok: false, error }`. Filename prefix is `pre-restore-backup-` so it's distinguishable from real exports.
  - `src/db/restore.ts` — `parseBackupJson()`, `validateBackup()` (returns `{ ok: true, backup, warnings } | { ok: false, errors, warnings }`), `replaceRestore()`, and the typed `PreRestoreBackupFailedError`. Replace-restore runs every clear + bulkPut inside one Dexie transaction, preserves an existing `pokemonTcgApiKey` if the backup omits one, updates `appMeta` (`schemaVersion`, `lastBackupAt = backup.exportedAt`, `lastMigrationAt = now`), and appends a `backup_restored` audit row inside the transaction. A mid-transaction failure rolls back; the database is unchanged.
  - `src/utils/download.ts` — `downloadTextFile()`. Browser-only. Pure data-layer code never calls it.
  - `src/views/backup.ts` — replaces the placeholder. Status panel (last backup, holdings count at last backup, persistent storage status, `backup_old` / `storage_not_persistent` chips), Export button (calls `exportToBackupFile` → `downloadTextFile`), Restore flow (file picker → parse → validate → preview counts and warnings → `window.confirm()` → `tryPreRestoreAutoBackup` → `replaceRestore`). Merge-restore button is rendered but disabled with the documented "planned for a later release" tooltip. All dynamic content is rendered via `textContent`/`createElement` (verified by the view test that plants raw `<script>` text in `lastBackupAt` and asserts no script element appears in the DOM).
  - `src/app.ts` — view runner now uses a small `(container) => void` mount API so views with listeners (currently just Backup) can attach handlers cleanly. Existing string-render views are unaffected — they're wrapped in one-line adapters.
  - `src/styles.css` — minimal Backup-view styling (panels, primary/danger button variants, status grid, preview list).
  - **Tests:** `tests/backup-export.test.ts`, `tests/backup-validate.test.ts`, `tests/backup-restore.test.ts`, `tests/backup-roundtrip.test.ts`, `tests/backup-view.test.ts`. 108 tests across 15 files; the round-trip test seeds cards, holdings, binders, slots, lots, lot items, wishlist, and settings, exports, validates, restores into a separate fresh DB, and asserts equivalent counts plus per-record equality for binders / slots / lots / lot items / wishlist / holdings, and that re-exporting the restored DB validates without warnings.
  - `PR_RULES.md` patched: §10 cross-reference fixed (was §12 → now §13), section reframed as "(historical)" since PR 3 has merged. The closing paragraph now states explicitly that **from PR 4 onward, `export → wipe → restore` round-trip is mandatory for every data-layer PR** and that a failing round-trip blocks merge.
  - **Patch:** `readBackupSnapshot()` now wraps every `.toArray()` inside one Dexie read transaction over all 11 stores, matching `BACKUP_FORMAT.md §7`. A concurrent write that lands between two store reads can no longer produce an inconsistent snapshot. `recordExportSideEffects()` likewise wraps the two `appMeta.put` calls and the `backup_exported` audit insert in one rw-transaction so an export cannot leave `appMeta` updated without a matching audit row, or vice versa. Behaviour is otherwise unchanged: API-key exclusion default, snapshot-before-side-effects ordering, and download separation all hold.

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
