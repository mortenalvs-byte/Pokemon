# PR #30 — Cleanup roadmap (PR 31 → PR 38)

Output of PR 30's repo-growth audit (plan §9 + §10). Each entry below
proposes a follow-up PR derived from a concrete finding inside
[`PR30_FULL_TECHNICAL_AUDIT.md`](./PR30_FULL_TECHNICAL_AUDIT.md) or
[`PR30_FULL_TECHNICAL_REPORT.md`](./PR30_FULL_TECHNICAL_REPORT.md).

The numbering is a planning aid, not a strict order. Pull cleanup
PRs in opportunistically; do not block feature work on them.

## Status overview (as of 2026-05-12)

| PR | Title | Status | Merge commit |
| --- | --- | --- | --- |
| PR 31 | Dev/QA runtime separation | ✅ Merged | a5cbe2e (#31) |
| PR 32 | Event / localStorage registry | ✅ Merged | f7f0d52 (#33) |
| PR 33 | Backup/restore validation hardening | ✅ Merged | b57b53e (#32) |
| PR 34 | View file decomposition | ✅ Merged | b9b6c14 (#35) |
| PR 35 | CSS modular cleanup | ✅ Merged | bundled with c70970a (PR #39) |
| PR 36 | Test helper consolidation | ✅ Merged | 0ec707d (#34) |
| PR 37 | Accessibility polish | 🟡 Pending (only with concrete finding) | — |
| PR 38 | Performance cleanup + CSP tightening | 🟡 Pending | — |

Discovery in `scripts/ai-supervisor/discover-tasks.mjs` looks for `^## PR N — ` headings. Merged PRs below are demoted to `### ✅ PR N — ` (h3) so auto-discovery does not re-propose them. Active PRs (`PR 37`, `PR 38`) keep their `## PR N — ` headings.

---

### ✅ PR 31 — Dev/QA runtime separation (merged a5cbe2e)

```text
PR: 31
Title: Lift dev-only boot triggers out of src/main.ts
Scope: Move the four `pokemon.devAuto*` boot blocks + console audit
       + auto route-walk out of `src/main.ts` into a dedicated
       `src/qa/dev-runtime.ts` (or similar). The new module is
       imported only inside `if (import.meta.env.DEV) { … }` so it
       tree-shakes from production exactly as the inline blocks do.
Files likely touched:
  - src/main.ts                         (~250 lines lift out)
  - src/qa/dev-runtime.ts               (new file, dev-only)
  - tests/qa-route-prod-gating.test.ts  (banned-string list updated
                                          if any new identifier names
                                          appear)
Why: src/main.ts has accumulated four dev-auto orchestrations and
     a console-audit / route-walk pair (~250 of its 376 lines).
     A dedicated dev-runtime module keeps src/main.ts to its actual
     job (mount the shell, start the data layer) and gives the QA
     team a single doc to point at.
Risk: LOW. The lift is mechanical; production gating tests already
      ban every dev-only identifier the dev-auto-* paths use.
Acceptance criteria:
  - npm run typecheck PASS
  - npm test PASS (no count drop)
  - npm run qa:browser PASS
  - npm run build PASS, banned-string grep on dist/ stays at 0
  - production bundle size unchanged ±2 KB
Must not change:
  - production bundle behaviour
  - localStorage key strings
  - QA route gating (#qa still maps to dashboard in prod)
  - desktop behaviour
Suggested tests:
  - tests/dev-runtime.test.ts asserts the module is dev-only and
    its identifiers do not appear in dist/.
```

---

### ✅ PR 32 — Event / localStorage registry (merged f7f0d52)

```text
PR: 32
Title: Centralise event names and localStorage keys
Scope: Two small registry files, then update every dispatcher and
       listener to import from the registry.
       - src/domain/events.ts — exports every CustomEvent name as
         a const literal (USER_DATA_CHANGED_EVENT, SETTINGS_CHANGED_EVENT,
         SYNC_STATUS_CHANGED_EVENT, pokemon:image-load-error).
       - src/domain/storage-keys.ts — exports every localStorage key
         (pokemon.devAutoFixtureImport, pokemon.consoleAuditHistory,
         pokemon.routeWalkHistory, pokemon.persistenceDiagBootHistory,
         pokemon.desktopPersistenceSentinel, pokemon.desktopPersistenceBootCounter,
         pokemon.devAuto*Result, etc.).
Files likely touched:
  - src/domain/events.ts                (new)
  - src/domain/storage-keys.ts          (new)
  - src/components/events.ts            (re-export from registry)
  - src/main.ts, src/app.ts, src/views/settings.ts
  - src/qa/desktop-persistence-diagnostic.ts
  - tests/qa-route-prod-gating.test.ts  (banned-string list reads
                                          from registry literals)
Why: localStorage keys and event names are scattered across ~10
     files today. Tests duplicate the strings. A registry collapses
     this and makes the production gating ban list authoritative.
Risk: LOW. String literals don't change; only the symbol that
      points at them does.
Acceptance criteria:
  - All identical strings in dist/ before/after
  - npm test PASS (no count drop)
  - tests/qa-route-prod-gating.test.ts still finds 0 banned strings
Must not change:
  - actual key strings (pokemon.devAutoFixtureImport stays exactly
    that — backwards compatibility for any tooling that reads
    localStorage from outside the app)
  - event names
  - production behaviour
Suggested tests:
  - tests/event-registry.test.ts pins the exported literals.
  - tests/storage-keys.test.ts pins the exported keys.
```

---

### ✅ PR 33 — Backup / restore validation hardening (merged b57b53e)

```text
PR: 33
Title: Deep per-record validation in validateBackup
Scope: Extend src/db/restore.ts:validateBackup with per-record
       field validators for every user-data store. Replace the
       ID-only pass with a full schema check. Cross-references
       remain warnings (per existing UX), but field-type / enum
       errors hard-fail.
Files likely touched:
  - src/db/restore.ts (validateBackup body)
  - src/domain/validators.ts (extend HoldingInput-like validators
    so they can be re-used as backup-record validators)
  - tests/pr30-backup-deep-validation.test.ts → today's "PIN:
    ACCEPTS …" cases flip to "REJECTS …" (the fail-then-fix signal)
  - tests/restore-deep-validation.test.ts (new)
Why: Today validateBackup checks shape and IDs only. A poisoned
     backup with quantity:"garbage" or finish:12345 lands in Dexie
     via bulkPut and corrupts downstream readers. PR 30 finding
     F-BACKUP-VALID-1 pinned this gap.
Risk: MEDIUM. A stricter validator could reject legitimate older
      backups. PR 33 must include a backwards-compat test set
      against every shipped backup-format snapshot in tests/fixtures.
Acceptance criteria:
  - All current happy-path restore tests still PASS.
  - tests/pr30-backup-deep-validation.test.ts "PIN: ACCEPTS …" cases
    now FAIL (proving the strictness landed) — they get renamed to
    "REJECTS …" once green.
  - At least 8 new "rejects malformed X" cases.
  - No backup format change: schemaVersion stays at 2;
    BACKUP_FORMAT.md stays the source of truth for the on-disk
    shape.
Must not change without operator approval:
  - the on-disk JSON shape
  - schemaVersion
  - the warnings-vs-errors policy for cross-references
  - the API key preservation rule
Suggested tests:
  - tests/restore-deep-validation.test.ts — wrong-type cases per
    store; missing required field cases; enum-violation cases.
  - tests/restore-backwards-compat.test.ts — every fixture in
    tests/fixtures/backup-snapshots/ still imports cleanly.
```

---

### ✅ PR 34 — View file decomposition (merged b9b6c14)

```text
PR: 34
Title: Mechanical decomposition of overgrown view files
Scope: Split the three SHOULD-SPLIT views into render / actions /
       state helpers WITHOUT changing UI behaviour. Targets:
       - src/views/binder-detail.ts (1690 lines) → render +
         action-handlers + state
       - src/views/browse.ts (1318 lines) → same pattern
       - src/views/master-gap.ts (1236 lines) → same pattern
       - src/views/settings.ts (799 lines) → split optional
Files likely touched:
  - src/views/<view>/{index.ts,render.ts,actions.ts,state.ts}
    (one folder per view; mountX still exported from the same
    public path)
Why: Each of these files mixes DOM construction, action handlers,
     repo wiring, and local state in one module. The maintenance
     cost is real (1690 lines is hard to navigate). The tests
     already pin the contracts; a mechanical split keeps them
     green.
Risk: MEDIUM. UI behaviour preservation across a large split is
      non-trivial. PR 29 binder-detail action audit MUST stay
      green; same for every existing view test.
Acceptance criteria:
  - Every existing test PASSES unchanged.
  - tests/binder-detail-action-audit.test.ts (16 cases, PR 29) is
    untouched and still GREEN.
  - npm run build size delta ≤ +5 KB gzip.
Must not change:
  - UI behaviour (rendered DOM, action results)
  - route behaviour (hash-driven mount points)
  - DB writes
  - tests
Suggested tests:
  - No new tests required. The test suite IS the contract.
```

---

### ✅ PR 35 — CSS modular cleanup (bundled into PR #39 — see c70970a)

```text
PR: 35
Title: Split src/styles.css into feature sections
Scope: Carve src/styles.css (~73 KB) into per-feature files and
       a Vite import chain. Sections derived from the audit doc:
       - global layout
       - app shell / topbar / sidebar
       - tables (browse / collection / wishlist)
       - dialogs / forms
       - browse, collection, binders, binder-detail, lots,
         lot-detail, wishlist, backup, settings, master-gap
       - QA / dev-only
       - desktop / Tauri runtime badge
       - utility classes
Files likely touched:
  - src/styles.css                       (deleted)
  - src/styles/{base,layout,…}.css       (new)
  - src/main.ts                          (one import chain)
  - vite.config.ts                       (no change expected)
Why: src/styles.css is one ~73 KB file. The CSS bundle output is
     not the problem (Vite emits one minified CSS regardless); the
     maintenance cost is. Splitting by feature makes ownership clear
     and lets future PRs touch one section without merge conflicts.
Risk: LOW. CSS is loaded once; Vite concatenates. No class-name
      changes.
Acceptance criteria:
  - dist/assets/index-*.css size unchanged ±2 KB
  - Visual-regression: spot-check every route at HEAD vs PR 35.
  - No data-region selector or class-name changes.
Must not change:
  - visual layout
  - class names used by tests or by data-region selectors
  - data-region attribute names
Suggested tests:
  - Sniff: count occurrences of every used class name in
    src/styles.css before vs the new tree → equal.
```

---

### ✅ PR 36 — Test helper consolidation (merged 0ec707d)

```text
PR: 36
Title: Extract common DOM / DB seed helpers into tests/helpers/
Scope: Catalogue duplicated fixture setup across action-audit tests
       and refactor into shared helpers. Leave per-file specifics
       (the actual assertions) in place.
Files likely touched:
  - tests/helpers/seed-card.ts                (new)
  - tests/helpers/seed-binder.ts              (new)
  - tests/helpers/seed-holding.ts             (new)
  - tests/helpers/dom.ts                      (new — settle, click,
                                                read-region)
  - the ~15 action-audit-style tests that today copy these helpers
Why: PR 29 binder-detail-action-audit and existing
     binder-detail-checklist / pagination / search tests all
     hand-build a similar fixture (set + card + binder + slot +
     holding) inline. Future per-view audits would duplicate again.
Risk: LOW. Pure refactor; tests still assert the same things.
Acceptance criteria:
  - npm test count unchanged or higher.
  - npm test runtime ≤ 2 s slower (helper extraction shouldn't add
    cost).
  - tests/binder-detail-action-audit.test.ts assertions byte-for-
    byte identical (only `beforeEach` body shrinks).
Must not change:
  - coverage
  - regression strength (PR 29 16-case binder-detail audit identical)
Suggested tests:
  - No new product tests. Helpers themselves get a tiny self-test.
```

---

## PR 37 — Accessibility polish

```text
PR: 37
Title: Lower-risk accessibility fixes (ONLY if concrete findings)
Scope: Triggered only when a concrete a11y finding lands. PR 30
       has none worth fixing — every dialog uses showModal,
       buttons have text, labels are paired, aria-live regions
       exist on validation feedback.
Files likely touched: TBD per finding.
Why: Document the slot in advance so a future a11y finding has a
     known home. Without a finding, this PR does not exist.
Risk: LOW per finding. UI logic stays put.
Acceptance criteria:
  - Each fix references a concrete file:line.
  - No business logic touched.
Must not change:
  - business logic
  - data model
  - tests' subject matter
Suggested tests:
  - One DOM test per fix.
```

---

## PR 38 — Performance cleanup + CSP tightening

```text
PR: 38
Title: Bulk-batch performance + Tauri CSP tightening
Scope: Two concrete items from the audit:
       (a) Pre-load assigned-id set once at the start of
           recommended-placement-service.batch so each
           assignHoldingToSlot call no longer re-walks every live
           slot. Closes F-PERF-LISTLIVE-N-PLUS-1.
       (b) Tighten src-tauri/tauri.conf.json CSP:
           - replace `style-src 'self' 'unsafe-inline'` with
             `style-src 'self'` (requires moving createLazyImage's
             inline width/height to data-attribute-driven CSS rules)
           - replace `connect-src 'self' https:` with
             `connect-src 'self' https://api.pokemontcg.io
              https://images.pokemontcg.io`
           Closes F-TAURI-CSP-1 and F-TAURI-CSP-2.
Files likely touched:
  - src/services/recommended-placement-service.ts
  - src/services/binder-assignment-service.ts (signature: accept a
    pre-loaded assigned-id set)
  - src/utils/lazy-image.ts (inline style → CSS class with
    data-width/data-height)
  - src/styles.css (or src/styles/lazy-image.css after PR 35)
  - src-tauri/tauri.conf.json
  - tests/recommended-placement-service.test.ts (extend)
  - tests/desktop-app-config.test.ts (extend CSP assertions)
Why:
  - F-PERF-LISTLIVE-N-PLUS-1: bulk path is O(N·slots); pre-load is
    a small contract change for a measurable scale win.
  - F-TAURI-CSP-1 / F-TAURI-CSP-2: tighter CSP reduces blast radius
    of any future regression that lands user-controlled content
    inside a style attribute or fetches from an unintended host.
Risk: MEDIUM.
  - Performance change must preserve concurrent-edit behaviour.
  - CSS rewrite must produce identical thumbnails (no visible
    layout shift).
Acceptance criteria:
  - All existing tests PASS.
  - tests/recommended-placement-service.test.ts adds at least one
    case that exercises the pre-loaded set path (e.g. assigning
    same holding twice in a batch is rejected once, not twice).
  - tests/desktop-app-config.test.ts asserts the tightened CSP
    string exactly.
  - Manual: Tauri desktop launch shows thumbnails sized as before.
Must not change:
  - data semantics
  - assignment semantics (PR 24 invariants)
  - backup format
  - the four-finish / five-edition / four-status enums
Suggested tests:
  - As listed above.
```

---

## What is intentionally NOT in this roadmap

- **Schema migration** — stop condition. There is no v3 schema.
- **New IndexedDB store** — stop condition.
- **Backup format change** — PR 33 hardens validation only; on-disk
  shape stays at schemaVersion 2.
- **Tauri capability change** — stays at `core:default` only.
- **Adding a backend / cloud / login** — out of project scope per
  CLAUDE.md.
- **Changing PR 24 / PR 25 / PR 29 semantics** — pinned by tests.
- **Bulk dependency upgrade** — `npm audit` is clean; upgrades are
  per-PR with focused tests.
- **Renaming public localStorage keys / events** — backwards-compat
  with any external tooling that reads them.
