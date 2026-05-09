# PR #30 — Full technical report

System health classification at HEAD `762f105` (PR #29 merge, plus
PR #30's CSV formula-injection fix and three new test files).

This report is the human-readable companion to
[`PR30_FULL_TECHNICAL_AUDIT.md`](./PR30_FULL_TECHNICAL_AUDIT.md). The
audit lists evidence per finding; this file rolls them up into a
GREEN / YELLOW / RED status per system area, names the highest-risk
modules, and recommends what to do next.

---

## 1. Executive summary

**Status: GREEN — minor YELLOW tail.**

The repo is technically healthy at PR #30's HEAD. PR #29's
binder-detail action audit pinned the most fragile workflow with
16 DOM-level cases; PR #30's repo-wide audit found one MEDIUM
security bug (CSV formula injection in user-controlled note /
name fields), fixed it, and surveyed the remaining 18 risk lanes.
Architecture, data integrity, sync, restore, single-writer
contracts, dev-only tooling tree-shaking, dependency posture, and
desktop capability set all verified green.

Two YELLOW lanes remain — neither blocking, both with concrete
follow-up PRs:

- **Backup deep validation (R4)** — `validateBackup` checks shape
  and IDs only, not per-record field types. A poisoned backup can
  still pass into Dexie. Pinned with a fail-then-fix baseline test
  for **PR 33**.
- **Tauri CSP / connect-src tightening (R8)** — `style-src
  'unsafe-inline'` and `connect-src 'self' https:` are broader than
  the app needs. Both have real reasons (inline thumbnail sizing,
  third-party image hosts) and need a deliberate CSP-tightening PR.
  Deferred to **PR 38**.

No schema migration, no new IndexedDB store, no backup format
change, no new dependency, no new external API, no Tauri
capability change. PR #29's binder-detail action audit remains
green. Production gating remains green. Stop conditions all
respected.

**Recommendation:** continue feature work on the existing PR
trajectory, with the cleanup roadmap (PR 31–38) pulled in
opportunistically when the surface area lines up.

---

## 2. Current system size and complexity

| Metric | Value |
|---|---|
| Production runtime files | ~80 TypeScript files in `src/` |
| Largest production file | `src/views/binder-detail.ts` (1690 lines) |
| Largest dev-only file | `src/qa/qa-max-stress.ts` (809 lines, tree-shaken) |
| Production bundle | 460.15 KB JS / 120.51 KB gzip |
| CSS bundle | 73.17 KB / 9.13 KB gzip (one file) |
| Test files | 117 → 119 after PR 30 |
| Test cases | 1174 → 1201 after PR 30 (+27) |
| Production runtime dependencies | 1 (`dexie ^4.4.2`) |
| Open vulnerabilities | 0 (`npm audit` and `npm audit --omit=dev`) |
| Tauri capabilities | `core:default` only |

Five production view files exceed 800 lines:
`binder-detail` (1690), `browse` (1318), `master-gap` (1236),
`dashboard` (943), `lot-detail` (848). All five are domain-rich
views, not bloat. Splitting them is a cleanup concern (PR 34) —
not health-critical.

---

## 3. Architecture health

```text
Area: Layer boundaries (views ↔ services ↔ repos ↔ domain ↔ db)
Status: GREEN
Evidence: 0 view-imports-view violations; 0 services writing to
          Dexie outside their repository; single-writer contract
          intact for binderSlots; PR 29 binder-detail action audit
          (16 cases) remains green.
Risk: A future view that calls db.* directly (skipping the repo)
      could bypass audit logging and cache invalidation.
Recommended action: keep the lint-by-pattern stance; no PR 30
                    refactor needed.
Suggested PR: PR 34 (mechanical view file decomposition only)
```

```text
Area: Single source of truth
Status: GREEN
Evidence: buildAutoPlacementPlan owns auto-place math (PR 29);
          best-copy scoring lives in best-copy-service; master-gap
          classification in master-set-gap-service; variant
          availability in domain/card-variants; wishlist matching
          in wishlist-receive-service. No parallel logic added.
Risk: a future helper that recomputes any of these locally would
      drift; today nothing does.
Recommended action: none for PR 30.
Suggested PR: none.
```

---

## 4. Security health

```text
Area: XSS / DOM injection (R6)
Status: GREEN
Evidence: 31 innerHTML uses across 24 files; every one writes a
          static skeleton. Dynamic data goes through createElement +
          textContent. See audit § 4.1 for sampled file:line
          evidence.
Risk: a future view that interpolates a user-controlled string into
      a template-literal innerHTML would re-introduce the vector.
Recommended action: keep the convention; no PR 30 fix needed.
Suggested PR: none (architectural discipline).

Area: CSV / formula injection (R5)
Status: GREEN — was YELLOW before PR 30
Evidence: src/utils/csv.ts:guardFormulaInjection prefixes a leading
          `=`/`+`/`-`/`@`/tab/CR/LF with apostrophe.
          14 regression cases in tests/pr30-csv-formula-injection.
Risk: very low post-fix; the guard is a single utility call.
Recommended action: closed.
Suggested PR: none.

Area: Tauri desktop posture (R8)
Status: YELLOW
Evidence: capabilities = core:default only; Rust binary has zero
          custom commands; CSP locks script-src to 'self'. BUT
          style-src 'unsafe-inline' and connect-src 'self' https:
          are broader than required.
Risk: low-impact. style-src 'unsafe-inline' enables CSS-injection
      attacks IF a separate vector lands user-controlled content
      inside a style attribute (none today). connect-src lets a
      future regression silently exfiltrate via any HTTPS host.
Recommended action: tighten both in a deliberate CSP PR.
Suggested PR: PR 38

Area: API key handling
Status: GREEN
Evidence: backup excludes the key by default; restore preserves
          an existing key when the backup omits one; sync sanitizes
          error messages with apiKey.
Suggested PR: none.

Area: Dependency vulnerabilities (R13)
Status: GREEN
Evidence: 0 vulnerabilities in npm audit (full and prod-only).
          Single production dependency: dexie ^4.4.2.
Suggested PR: none.
```

---

## 5. Data-integrity health

```text
Area: Cards / sets cache (R3)
Status: GREEN
Evidence: WeakMap by Dexie instance; invalidated on every
          repo write, sync commit, restore commit, local-fixture
          import. Tests pin the contract at every layer.
Suggested PR: none.

Area: Slot assignment writer (R9)
Status: GREEN
Evidence: assignHoldingToSlot is the only call to
          binderSlotsRepo.update; PR 24 invariants intact (cardId
          match, reverse-holo template, deleted-holding rejection,
          one-physical-holding-one-slot).
Suggested PR: none.

Area: Soft-delete contract
Status: GREEN
Evidence: live/trash queries route through src/db/soft-delete.ts.
          Repos all import from the canonical filter.
Suggested PR: none.
```

---

## 6. Backup / restore health

```text
Area: Atomicity (R4)
Status: GREEN
Evidence: replaceRestore runs every clear+bulkPut in one
          transaction; failure rolls back; cache invalidated
          post-commit; pre-restore safety net via
          tryPreRestoreAutoBackup.
Suggested PR: none.

Area: Deep validation (R4)
Status: YELLOW
Evidence: validateBackup checks shape + IDs only; per-record
          field types are NOT validated. A poisoned backup with
          quantity:"garbage" and finish:12345 lands in Dexie.
          tests/pr30-backup-deep-validation.test.ts pins both the
          checks-it-does-do AND the gap.
Risk: medium. Most readers are defensive (`?? null`, `String(...)`)
      so app-wide breakage is unlikely, but specific consumers
      (CSV exporter, master-gap classifier) could throw on
      malformed records.
Recommended action: design per-record validators and apply them
                   inside validateBackup before bulkPut.
Suggested PR: PR 33 (Backup/restore validation hardening)

Area: API key in backups
Status: GREEN
Evidence: see security § 4.5 in audit doc.
Suggested PR: none.
```

---

## 7. Desktop / Tauri health

```text
Area: Capability posture
Status: GREEN
Evidence: src-tauri/capabilities/main.json declares only
          core:default; Rust binary registers no commands; bundle
          targets MSI only; desktop:build PASS at HEAD with
          exe (3.4 MB) + MSI (1.9 MB).
Suggested PR: none.

Area: CSP breadth
Status: YELLOW
Evidence: style-src 'unsafe-inline' (createLazyImage uses inline
          width/height); connect-src 'self' https: (broad).
Suggested PR: PR 38
```

---

## 8. Production bundle health

```text
Area: Dev-only tooling tree-shaking (R7)
Status: GREEN
Evidence: tests/qa-route-prod-gating.test.ts bans 38 dev-only
          identifiers; bundle re-built at HEAD shows 0 occurrences.
          Test runs 3/3 PASS as part of npm test.
Risk: the same gating test silently skips when dist/ is missing
      (F-PROD-GATE-1, LOW). Documented in audit § 10.2; a CI run
      forgetting `npm run build` would not detect a leak. PR 30
      does not change this contract.
Suggested PR: none in PR 30; tooling refinement out of scope.
```

---

## 9. Performance health

```text
Area: Repository .toArray() patterns (R11)
Status: GREEN with one INFO finding
Evidence: 22 .toArray() call sites; bounded ones (where(...).
          equals(...)) and cached ones (db.cards / db.sets via
          cards-cache) are fine. Bulk recommended-placement runs
          binderSlotsRepo.listLive() per row → O(N·slots).
Risk: at extreme scale (1000 placements × 3110 slots) the bulk
      operation becomes noticeable. PR 28 max-stress measured 9.6 s
      for the realistic case, which is acceptable.
Recommended action: pre-load assigned-id set once at batch start
                   in recommended-placement-service.
Suggested PR: PR 38
```

```text
Area: Page-rendering contracts
Status: GREEN
Evidence: binder-detail page-at-a-time (16 tiles); lot-detail
          paginated; browse / collection / wishlist incremental;
          master-gap service uses pre-loaded holdingsById map (no
          per-slot Dexie reads).
Suggested PR: none.
```

---

## 10. Accessibility health

```text
Area: Keyboard / screen-reader basics (R12)
Status: GREEN
Evidence: <button type="button"> for actions; <a href> for nav with
          aria-current; <dialog role="dialog"> with showModal native
          focus trap; aria-live on validation regions; form
          label[for] pairs.
Risk: an icon-only button in a future view would break this. None
      today.
Recommended action: keep the convention.
Suggested PR: PR 37 (lower-risk a11y polish only when concrete
              findings appear; PR 30 has none worth fixing).
```

---

## 11. Test-suite health

```text
Area: Coverage
Status: GREEN
Evidence: 117 → 119 files / 1174 → 1201 cases; 0 flaky retries
          observed; 143 s full suite + 150 s qa:browser stable.
Suggested PR: none.

Area: Duplication
Status: YELLOW (cosmetic)
Evidence: every action-audit-style test file repeats fixture
          construction (set + card + binder + slot bootstrap).
          tests/binder-detail-action-audit.test.ts is 16 cases
          that share most setup; future per-view audits would
          duplicate it again.
Risk: no test-correctness risk; only repo growth.
Recommended action: extract common DOM seed helpers into
                   tests/helpers/ when the next action audit lands.
Suggested PR: PR 36 (test helper consolidation)
```

---

## 12. Highest-risk modules (ranked)

1. `src/db/restore.ts` — single transaction over every store; one
   bug here corrupts the DB. **GREEN today**, but the highest-blast-
   radius file in the repo. F-BACKUP-VALID-1 is its only weak spot.
2. `src/services/binder-assignment-service.ts` — single writer for
   `binderSlots.holdingId`. **GREEN**. PR 29 pinned 16 contract
   cases. R9 invariants intact.
3. `src/db/sync.ts` — rewrites the cache + audit; failure here is
   recoverable but a bad commit corrupts the catalog. **GREEN**.
4. `src/utils/csv.ts` — touches every CSV exporter. **GREEN after
   PR 30 fix**. F-CSV-1 was here; no other risk surface.
5. `src/main.ts` — entry; dev-only console + route walks; six
   dev-auto-* boot triggers. **GREEN** (gated and tree-shaken),
   but the largest non-view production file with the most
   localStorage keys. Rebalance is the goal of PR 31.

---

## 13. Overgrown modules / files

| File | Lines | Verdict |
|---|---|---|
| `src/views/binder-detail.ts` | 1690 | SHOULD-SPLIT (PR 34) — render / actions / state |
| `src/views/browse.ts` | 1318 | SHOULD-SPLIT (PR 34) |
| `src/views/master-gap.ts` | 1236 | SHOULD-SPLIT (PR 34) |
| `src/views/dashboard.ts` | 943 | ACCEPTABLE-LARGE — domain-driven |
| `src/views/lot-detail.ts` | 848 | ACCEPTABLE-LARGE |
| `src/components/global-search.ts` | 833 | ACCEPTABLE-LARGE — single concern |
| `src/qa/qa-max-stress.ts` | 809 | TEST-ONLY-LARGE (dev-only, tree-shaken) |
| `src/qa/qa-seed.ts` | 706 | TEST-ONLY-LARGE (dev-only, tree-shaken) |
| `src/views/settings.ts` | 799 | SHOULD-SPLIT-EVENTUALLY (PR 34) |
| `src/styles.css` | ~73 KB | SHOULD-SPLIT-BY-FEATURE (PR 35) |

None block PR 30. None are TODAY a correctness or performance
hazard. Splitting them is risk-bearing (UI behaviour preservation),
so it gets its own PR with mechanical changes only.

---

## 14. Duplicate or drifting logic

Audited categories per PR 30 plan § 9.3:

- **Card variant availability** → single owner
  (`src/domain/card-variants.ts`). No duplication.
- **Finish/edition validation** → `domain/validators.ts`. Browse,
  Card Detail, holding-form all import from the same source.
- **Wishlist receive matching** → `wishlist-receive-service.ts`.
  Card Detail, Browse Quick Add, Global Search, Lot materialise,
  Binder direct-add all call the canonical service.
- **Binder slot assignment** → `binder-assignment-service.ts`.
- **Master-gap classification** → `master-set-gap-service.ts`.
- **Auto-place count** → `buildAutoPlacementPlan` (PR 29 single
  source of truth).
- **CSV row building** → three exporters, one shared
  `serializeCsv` writer. Each exporter knows its own column set;
  this is intended.
- **Search matching** → `domain/card-search.ts` shared.
- **Pagination** → per-view (binder-detail 16-per-page,
  lot-detail row caps). No shared paginator helper. Acceptable
  given the views' distinct UX.
- **localStorage keys** → scattered across `src/main.ts`,
  `src/app.ts`, and `src/qa/desktop-persistence-diagnostic.ts`.
  See PR 32 in the roadmap.
- **Event names** → most via `src/components/events.ts`; sync chip
  uses `SYNC_STATUS_CHANGED_EVENT` exported from `src/views/settings.ts`.
  See PR 32 in the roadmap.
- **Dev-only gating strings** → all listed in
  `tests/qa-route-prod-gating.test.ts:54-127`. Acceptable; the
  list IS the registry.
- **Backup validation** → one site
  (`src/db/restore.ts:validateBackup`). No drift.
- **Settings normalisation** → `domain/personal-preferences.ts`
  + `services/personal-preferences-service.ts`. Centralised.

**No drift requiring PR 30 surgery.** The two roadmap candidates
(PR 32 — event/key registry) are organisational, not correctness
issues.

---

## 15. Cleanup opportunities

Listed exhaustively in [`PR30_CLEANUP_ROADMAP.md`](./PR30_CLEANUP_ROADMAP.md).
Headline items:

- PR 31 — Move dev-only auto-trigger orchestration out of
  `src/main.ts` into a dedicated dev/QA module (~250 lines of
  conditional code lifts cleanly).
- PR 32 — Centralise event names + localStorage keys into
  `src/domain/events.ts` and `src/domain/storage-keys.ts`.
- PR 33 — Backup/restore deep validation (closes
  F-BACKUP-VALID-1).
- PR 34 — Mechanical decomposition of overgrown view files.
- PR 35 — CSS modular split.
- PR 36 — Test helper consolidation.
- PR 37 — Accessibility polish (low-risk only).
- PR 38 — Tauri CSP tightening + assignment-batch performance.

---

## 16. Recommended PR roadmap

```text
PR 31 (LOW risk)   Dev/QA runtime separation
PR 32 (LOW risk)   Event/localStorage registry
PR 33 (MED risk)   Backup/restore validation hardening
PR 34 (MED risk)   View file decomposition (mechanical)
PR 35 (LOW risk)   CSS modular cleanup
PR 36 (LOW risk)   Test helper consolidation
PR 37 (LOW risk)   Accessibility polish (concrete findings only)
PR 38 (MED risk)   Performance + CSP tightening
```

This is a guide, not a contract. Pull cleanup PRs in alongside
feature work where the surface area lines up; do not block feature
PRs on cleanup that has no concrete finding behind it.

---

## 17. What must NOT be cleaned yet

- **Schema migration / new IndexedDB store** — stop condition.
- **Backup format change** — PR 33 strengthens validation but does
  not change the on-disk JSON shape.
- **Tauri capability change** — keep `core:default` only.
- **PR 24 / PR 25 / PR 29 semantics** — assignment, master-gap
  classification, auto-place count are pinned. Do not "improve"
  any of these without writing a fresh red-then-green test pair.
- **Production gating ban list** — extend, never shrink.
- **Existing tests** — never delete; never weaken assertions.
  Renames are fine; weaker behaviour is not.

---

## 18. Final technical recommendation

**Continue feature work.** PR 30 closes the one MEDIUM bug worth
fixing without crossing any stop-condition. The remaining items
on the cleanup roadmap are organisational improvements (PR 31,
32, 36), risk-bearing mechanical splits best done in their own
focused PRs (PR 33, 34, 35), or YELLOW lanes that need a deliberate
CSP / performance PR (PR 38) — none are blockers for new
feature work.

The repo is ready for the next feature wave. The audit, this
report, and the cleanup roadmap give the operator a single
source-of-truth on what was checked, what passed, and what's
intentionally deferred — with the file:line evidence behind every
claim.
