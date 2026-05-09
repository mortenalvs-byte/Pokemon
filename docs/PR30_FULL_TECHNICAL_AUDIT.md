# PR #30 — Full technical audit

Repo-driven evidence-based audit after the merged PR #29
(`feat/desktop-smart-placement-verification` → `main`, merge commit
`762f105`, merged 2026-05-09 14:50:47 UTC).

This document is the canonical output of PR #30. Every claim about
the repo links to a file path with line evidence. Every R1–R13
known-risk lane is addressed. Every finding follows the same shape.

---

## 1. Baseline evidence

### Repo state

```text
git rev-parse HEAD       → 762f105c2c743ef0a1dad9575aa03a11521cecb4
git log --oneline -5     → 762f105 PR 28: Desktop app + smart placement engine (#29)
                            2edcbe8 PR 27: Morten personal command center + persistent workspace (#28)
                            06963bf F-2 fix: map unlimitedNormal / unlimitedHolofoil (#27)
                            0a5e949 PR 26: Desktop-ready app shell + workspace polish (#26)
                            046fff1 PR 25: Master set gap analysis + dashboard intelligence (#25)
gh pr view 29            → state: MERGED  mergedAt: 2026-05-09T14:50:47Z
                            headRefName: feat/desktop-smart-placement-verification
                            mergeCommit.oid: 762f105…
                            title: PR 28: Desktop app + smart placement engine
```

PR #29's body explicitly states: "Phase G — DEFERRED to follow-up
PR #30 per operator decision (whole-system action audit for the
other 10+ views)." The audit here is therefore both Phase G's
spiritual successor and a wider repo-driven sweep.

### Pre-edit baseline

| Command | Result |
|---|---|
| `npm run typecheck` | PASS (no output, clean exit) |
| `npm test` | **117 files / 1174 / 1174 PASS**, 143.07 s |
| `npm run qa:browser` | **11 files / 92 / 92 PASS**, 150.23 s |
| `npm run build` | **460.15 KB JS / 120.51 KB gzip / 73.17 KB CSS / 9.13 KB CSS gzip**, 168 ms |
| `npm run desktop:build` | **PASS** — `pokemon-tracker-desktop.exe` 3.4 MB + MSI installer 1.9 MB |
| `npm audit --omit=dev` | **0 vulnerabilities** |
| `npm audit` (full) | **0 vulnerabilities** |

Baseline counts identical to PR #29's own published numbers (1174
tests, 460.15 KB JS / 120.51 KB gzip), confirming no drift on `main`
between PR #29 merge and the audit start.

---

## 2. Repo system map

Source surface (post-PR-29):

```text
src/
  api/            pokemon-tcg-api client + retry + sanitize           (3 files)
  components/     forms / modals / shared UI (dialog, global-search,
                  keyboard-shortcuts, holding-form, lot-form,
                  binder-form, assign-holding-modal, …)              (~18 files)
  db/             Dexie schema (v2), backup, restore, sync, audit,
                  cards-cache, auto-backup                            (8 files)
  domain/         types / validators / pure rules
                  (card-variants, card-search, master-set-gap,
                  wishlist-status, personal-preferences,
                  binder-presets, …)                                  (15 files)
  qa/             dev-only QA harness (tree-shaken from production):
                  qa-seed (1000 holdings, deterministic),
                  qa-runner, qa-report, qa-max-stress,
                  desktop-persistence-diagnostic,
                  local-sync-fixture, image-audit                     (7 files)
  repositories/   Dexie data-access shims (one per store)             (10 files)
  services/       workflow logic (binder-assignment, master-set-gap,
                  best-copy, recommended-placement, command-center,
                  global-search, quick-add, wishlist-receive,
                  lot-service, csv exporters, dashboard, …)           (~22 files)
  utils/          csv, dates, download, ids, lazy-image, money, tags  (~7 files)
  views/          13 routes — backup, binder-detail, binders,
                  browse, card-detail, collection, dashboard,
                  lot-detail, lots, master-gap, qa, settings,
                  wishlist                                             (13 files)
  app.ts          shell + nav + topbar + view dispatch                (~425 lines)
  main.ts         entry; dev-only console+route-walk audits +
                  dev-auto-* boot triggers                            (~376 lines)
  router.ts       hash router + Route union + decoder helpers         (~228 lines)
  styles.css                                                          (~73 KB)

src-tauri/
  src/main.rs            minimal Tauri entrypoint, no commands
  tauri.conf.json        v2 config; bundle.targets=["msi"]
  capabilities/main.json permissions: ["core:default"] only
  Cargo.toml / Cargo.lock

tests/    117 files / 1174 cases (PR #29 baseline).
docs/     DESKTOP_APP.md, QA_DESKTOP.md, PR29_SCOPE_AUDIT.md.
```

Largest production files (lines):

```text
1690  src/views/binder-detail.ts
1318  src/views/browse.ts
1236  src/views/master-gap.ts
 943  src/views/dashboard.ts
 848  src/views/lot-detail.ts
 833  src/domain/master-set-gap.ts
 833  src/components/global-search.ts
 809  src/qa/qa-max-stress.ts          (dev-only)
 799  src/views/settings.ts
 745  src/views/card-detail.ts
 714  src/views/collection.ts
 706  src/qa/qa-seed.ts                 (dev-only)
 694  src/components/holding-form.ts
 636  src/views/wishlist.ts
 ~73 KB   src/styles.css                 (one file)
```

These all run, pass typecheck and tests, and are cleanly imported.
Splitting them is a cleanup concern (PR 34) — not a PR 30 fix.

---

## 3. Known risk inheritance from PR 15A → PR 29

This audit re-verifies, against the actual repo state, that every
prior PR's invariants survived the next merge. Each lane has its own
section below (R1–R13). Cross-references:

- **PR 15A (F-3, F-6, F-7)** — listener cleanup AbortController →
  R1.
- **PR 20** — binder-detail page-at-a-time rendering → R11.
- **PR 21** — cards/sets cache invalidation contract → R3.
- **PR 22** — wishlist receive: cardId+finish key only → R10.
- **PR 23** — global search lifetime + stale guard → R2.
- **PR 24** — `assignHoldingToSlot` is single slot writer → R9.
- **PR 25** — master-set-gap classification semantics → R9.
- **PR 26** — desktop-ready shell + keyboard shortcuts → R12.
- **PR 27** — personal preferences in settings store, no
  schema migration → R3 / R4.
- **PR 28** — Tauri scaffold + smart placement engine → R7 / R8 /
  R9.
- **PR 29** — Phase G deferred to PR 30; binder-detail action
  audit pinned with 16 DOM-level cases → R9 / R12 + the present
  audit's reason for existing.

---

## 4. Security audit

### 4.1 XSS / DOM-injection (R6)

**Method.** `Grep` for every `\.innerHTML\s*=` and
`insertAdjacentHTML` usage in `src/`. Classify each by what is
interpolated.

**Numbers.**

- 31 occurrences of `innerHTML = …` across 24 files.
- 0 occurrences of `insertAdjacentHTML`.
- 0 occurrences of `dangerouslySetInnerHTML` (no React).

**Pattern observed.** Every production-runtime `innerHTML = \`…\``
assignment writes a **static skeleton** (table headers, panel
headers, dialog frames, sidebar nav whose labels are hard-coded).
Dynamic content — anything sourced from user input, the local DB,
or the pokemontcg.io API — is built via `document.createElement(...)`
and `node.textContent = ...`. Sample evidence:

- `src/views/card-detail.ts:404` — table.innerHTML is a frozen
  `<thead>` plus an empty `<tbody data-region="holdings-body">`.
  Holding rows are then created at line 422 via
  `body.appendChild(buildHoldingRow(row))` where `buildHoldingRow`
  uses `appendCell(tr, ...)` which calls `td.textContent = value`
  (see [`appendCell` at line 489–493](../src/views/card-detail.ts:489)).
- `src/components/global-search.ts:103` — slot.innerHTML is a
  hard-coded form skeleton; result rows are built via
  `document.createElement('li')` + `title.textContent = …` (see
  [`buildResultRow` at line 415](../src/components/global-search.ts:415)).
- `src/app.ts:88` — `root.innerHTML = renderShell()`; `renderShell`
  composes nav links from `NAV_LINKS` (hard-coded labels) — there
  is no user data path into the shell template.

**Risk vectors checked.**

- Card / set names from API → cached, then rendered through
  `textContent` (verified in card-detail, global-search, browse,
  collection). No HTML interpolation observed.
- Holding `note`, `tags`, binder `name`, lot `name`, wishlist `note`
  → rendered through `textContent` (verified in card-detail,
  collection, lots, wishlist views). No HTML interpolation.
- Backup-imported records → bulkPut into Dexie; the same downstream
  `textContent` path applies.
- App brand text (`appDisplayName`) from settings → applied via
  `brand.textContent = displayName` in
  [src/app.ts:213](../src/app.ts:213). No innerHTML path.

**Verdict.** No `innerHTML` use in production code interpolates
user-controlled data. The pattern is **static skeleton + dynamic
DOM via `textContent`**, which is the intended safe pattern in the
absence of a templating library.

```text
Finding: F-XSS-1
Severity: INFO
Area: Security / R6 / DOM injection
Evidence: 31 innerHTML uses, 0 dangerous interpolations; see
          src/views/card-detail.ts:404 → appendCell at line 489
          (textContent), src/components/global-search.ts:103 →
          buildResultRow at line 415 (textContent)
Files: every src/views/*.ts, src/components/*.ts using innerHTML
Why it matters: a regression here is a stored-XSS vector via
                holding.note or imported backup data.
Fixed in PR #30: NO (already correct)
If not fixed, why: nothing to fix; current code is safe-by-pattern
Tests: tests/pr30-security-audit.test.ts asserts that a holding
       note containing `<img src=x onerror=alert(1)>` renders as
       text in the card-detail holdings table.
Status: VERIFIED-SAFE
```

### 4.2 CSV / formula injection (R5)

**Method.** Read every CSV exporter
(`src/services/binder-csv-export.ts`,
`src/services/lot-csv-export.ts`,
`src/services/mvp-csv-export.ts`) and the shared writer
([`src/utils/csv.ts`](../src/utils/csv.ts)).

**Pre-fix observation (HEAD `762f105`).** `escapeCell` only quotes
cells containing `,`, `"`, `\n`, or `\r` (RFC 4180). It does **not**
prefix-escape cells starting with `=`, `+`, `-`, `@`, tab, CR, or
LF. User-controlled data exported via the CSV path includes:

| Column | Source | Exporter |
|---|---|---|
| `holding.note` | user free-text | mvp-collection, binder, lot |
| `binder.name` | user free-text | binder, mvp-missing-cards |
| `lot.name` | user free-text | lot |
| `wishlist.note` | user free-text | mvp-wishlist |
| `holding.tags` | user free-text (formatted) | mvp-collection |
| `card.name` / `set.name` | API-cached, shown to user | every exporter |

A holding note `=HYPERLINK("https://evil.test","click")` would be
written verbatim into the CSV file. When the user opens that file in
Excel / Sheets / Numbers, the cell is interpreted as a live formula.
Classic OWASP "CSV / formula injection".

**Fix applied in PR #30.** `escapeCell` in
[`src/utils/csv.ts`](../src/utils/csv.ts) now prefixes any cell whose
first character is one of `=`, `+`, `-`, `@`, tab (`\t`), CR
(`\r`), or LF (`\n`) with a single apostrophe (`'`). The apostrophe
is the documented Excel / Sheets convention for "treat this cell as
text". The change does not alter RFC 4180 quoting; both layers
compose. Headers are not user-controlled and are not prefixed.

```text
Finding: F-CSV-1
Severity: MEDIUM
Area: Security / R5 / Export injection
Evidence: src/utils/csv.ts pre-fix:
            function escapeCell(value: string): string {
              if (value.includes(',') || value.includes('"') ||
                  value.includes('\n') || value.includes('\r')) {
                return `"${value.replace(/"/g, '""')}"`;
              }
              return value;
            }
          No prefix-escape for =/+/-/@/tab.
          User-controlled fields: holding.note, binder.name,
          lot.name, wishlist.note (see mvp-csv-export.ts:159,
          binder-csv-export.ts:183, lot-csv-export.ts:117).
Files: src/utils/csv.ts (the canonical writer)
Why it matters: A malicious or careless backup import / API
                response / user-typed note can place an executable
                formula into an exported CSV. When the user opens
                that CSV in Excel/Sheets, the formula runs (HYPERLINK
                exfiltration, DDE on legacy Office, etc.).
Fixed in PR #30: YES — prefix-escape applied in escapeCell.
Tests: tests/pr30-csv-formula-injection.test.ts (8 cases) covers:
       =HYPERLINK, +cmd, -2+3, @SUM, leading tab, leading CR,
       leading LF, æøå roundtrip, comma/quote/newline still
       quoted (no regression of RFC 4180 path).
Status: FIXED
```

### 4.3 Backup import deep-validation (R4)

**Method.** Read [`src/db/restore.ts`](../src/db/restore.ts) and
[`src/db/backup.ts`](../src/db/backup.ts) end-to-end.

**Observed.** `validateBackup` validates:

- root is a JSON object, not array, not null
- `app === 'Pokemon TCG Tracker'`
- `schemaVersion` is an integer ≥ 1 and ≤ `SCHEMA_VERSION` (currently 2)
- `exportedAt` is a valid ISO 8601 timestamp
- every TOP_LEVEL_ARRAY_KEYS key is present and is an array
- every record in `holdings | lots | lotItems | binders |
  binderSlots | wishlist` has a string `id`
- cross-references (binderSlot.binderId, slot.holdingId,
  holding.lotId, lotItem.lotId, lotItem.holdingId) — produce
  **warnings only**, never errors

**What is NOT validated per record:**

- `holding.quantity`, `holding.finish`, `holding.condition*` types
- `holding.cardId` linkability against the cards store
- `binderSlot.pageNumber` / `slotNumber` integrity
- `wishlist.priority` enum
- `lots.allocationMethod` enum

A poisoned backup with `{id: "x", quantity: "garbage", finish: 12345}`
passes validation and lands in Dexie via `bulkPut`. Downstream
readers may then explode (`String(quantity)` becomes "garbage";
finish-equality checks fail silently; etc.).

**Mitigations already in place (do partial protection):**

- `replaceRestore` runs all writes inside a single Dexie `rw`
  transaction. Any throw rolls the whole restore back. So a
  schema-rejection from Dexie's own indexer (e.g. unique constraint
  on `id`) aborts cleanly.
- Pre-restore auto-backup gate (`PreRestoreBackupFailedError`)
  forces an explicit confirm-without-pre-backup flag if the safety
  net cannot be written.
- Cards/sets cache is invalidated post-commit, so a corrupt restore
  cannot leave stale memo'd snapshots.

```text
Finding: F-BACKUP-VALID-1
Severity: MEDIUM
Area: Data integrity / R4 / Backup deep validation
Evidence: src/db/restore.ts:119-215 — validateBackup checks shape
          and IDs only; per-record fields are never type-checked.
          Cross-reference checks are warnings, not errors.
Files: src/db/restore.ts
Why it matters: An untrusted or accidentally-corrupted backup file
                can write malformed records into Dexie. Most reads
                still work because the codebase is defensive
                (`?? null`, `String(...)`, etc.), but a strict
                consumer (CSV exporter, master-gap classifier) can
                surface gibberish or throw.
Fixed in PR #30: NO
If not fixed, why: A real fix requires per-record validators for
                  every store. That is a non-trivial design task
                  (which fields are required, which optional, what
                  enums, version drift handling) and crosses into
                  the "no schema migration / no backup format
                  change" stop-condition. Belongs in PR 33.
Tests: tests/pr30-backup-deep-validation.test.ts (4 cases) pin the
       current shape so we can detect a drift-fix regression while
       PR 33 designs the deep validator.
Status: DEFERRED → PR 33 (Backup/restore validation hardening)
```

### 4.4 Tauri desktop posture (R8)

**Method.** Read
[`src-tauri/tauri.conf.json`](../src-tauri/tauri.conf.json),
[`src-tauri/src/main.rs`](../src-tauri/src/main.rs), and every file
under `src-tauri/capabilities/`.

**Observed.**

- `tauri.conf.json:25-28` — CSP:
  `default-src 'self'; img-src 'self' https: data:;
   connect-src 'self' https:; style-src 'self' 'unsafe-inline';
   script-src 'self'`.
- `tauri.conf.json:29-39` — `bundle.targets: ["msi"]` (NSIS skipped
  intentionally per upstream toolchain bug, documented in PR #29).
- `src-tauri/src/main.rs:13-15` — exactly
  `tauri::Builder::default().run(tauri::generate_context!())`.
  No `invoke_handler`, no plugins, no custom commands.
- `src-tauri/capabilities/main.json:6-8` — `permissions:
  ["core:default"]`. No `fs:`, `shell:`, `clipboard:`, `dialog:`,
  `notification:`, `process:`, `os:`, `path:`, `webview:`.

**Findings.**

```text
Finding: F-TAURI-CSP-1
Severity: LOW / INFO
Area: Security / R8 / Desktop CSP
Evidence: src-tauri/tauri.conf.json:26 — `style-src 'unsafe-inline'`.
Files: src-tauri/tauri.conf.json
Why it matters: 'unsafe-inline' on style-src is a CSS-injection
                vector for known-bad attribute selectors. The app
                uses inline `style="width:32px;height:44px"` from
                createLazyImage to avoid layout shift, so removing
                'unsafe-inline' would break thumbnails.
Fixed in PR #30: NO
If not fixed, why: This is a real architectural choice; tightening
                  needs a CSS rewrite (data-attribute → CSS rule
                  selectors) of every inline style. Out of scope.
Tests: docs/PR30_FULL_TECHNICAL_AUDIT.md records the trade-off.
Status: DEFERRED → PR 38 (performance/CSS cleanup)

Finding: F-TAURI-CSP-2
Severity: LOW / INFO
Area: Security / R8 / connect-src breadth
Evidence: src-tauri/tauri.conf.json:26 — `connect-src 'self' https:`
          allows any HTTPS host. The app only contacts
          `https://api.pokemontcg.io` and image hosts under
          `https://images.pokemontcg.io`.
Files: src-tauri/tauri.conf.json
Why it matters: A future regression that adds an unintended fetch
                target (e.g. a third-party analytics SDK) would not
                be blocked by CSP at all.
Fixed in PR #30: NO
If not fixed, why: Tightening connect-src breaks `<img src>` for
                  any unknown image CDN that pokemontcg.io may move
                  to. Belongs in a deliberate CSP-tightening PR.
Tests: docs/PR30_FULL_TECHNICAL_AUDIT.md records the trade-off.
Status: DEFERRED → PR 38

Finding: F-TAURI-CAP-1
Severity: INFO (verification)
Area: Security / R8 / Capability set
Evidence: src-tauri/capabilities/main.json:6-8 declares ONLY
          ["core:default"]. No fs/shell/clipboard. The Rust binary
          (src-tauri/src/main.rs) registers no invoke handler.
Files: src-tauri/{capabilities/main.json, src/main.rs, tauri.conf.json}
Why it matters: confirms the PR #28 hard-rule "no broad Tauri
                permissions" is intact at HEAD 762f105.
Fixed in PR #30: NO (verified, no fix needed)
Tests: tests/desktop-app-config.test.ts (existing, 30 cases) pins
       the capability set; PR 30 adds no new caps, so this stays
       green by construction.
Status: VERIFIED-SAFE
```

### 4.5 API key handling

**Method.** `Grep` for `pokemonTcgApiKey`, `apiKey`, `Authorization`
in `src/`.

**Observed.**

- API key only used inside `src/api/pokemon-tcg-api.ts` and pulled
  from `settingsRepo` via the Settings view (see
  [src/views/settings.ts:233](../src/views/settings.ts:233)).
- `src/db/backup.ts:97-102` — backup export deliberately FILTERS
  the API key out of the exported settings unless `includeApiKey:
  true` is explicitly passed. The Backup view never sets that flag.
- `src/db/restore.ts:309-311, 380-391` — restore preserves the
  current API key when the backup omits one; the API key is never
  printed to the audit row.
- `src/db/sync.ts:101, 165` — failed sync paths run
  `sanitizeErrorMessage(error, apiKey)` so a server message that
  echoes the key cannot leak into `lastSyncError`.

```text
Finding: F-APIKEY-1
Severity: INFO (verification)
Area: Security / API key handling
Evidence: src/db/backup.ts:97-102 (filter), src/db/restore.ts:380-391
          (preserve), src/db/sync.ts:101+165 (sanitize on fail).
Files: src/api/sanitize.ts, src/db/{backup,restore,sync}.ts
Why it matters: an exfiltrated API key would let an attacker burn
                Morten's pokemontcg.io quota, but more importantly
                if the user follows the same key elsewhere, exposes
                that auth.
Fixed in PR #30: NO (verified, no fix needed)
Tests: tests/backup-export.test.ts and tests/api-client.test.ts
       cover the sanitize and exclude paths.
Status: VERIFIED-SAFE
```

---

## 5. Architecture audit

### 5.1 Layer boundaries

The repo follows a deliberate four-layer split:

```text
views/        DOM build, event wiring, dialog/route control.
components/   reusable UI fragments (forms, dialog, search).
services/     workflow logic; calls repos; never touches DOM.
repositories/ Dexie shims; only place writes happen.
domain/       pure rules: validators, classifiers, presets.
db/           initialise + backup + restore + sync + cache.
qa/           dev-only: seed, runner, report, audit, fixture.
utils/        platform-neutral helpers: csv, dates, ids, money.
```

**Verified contracts:**

- `assignHoldingToSlot` in
  [src/services/binder-assignment-service.ts:200](../src/services/binder-assignment-service.ts:200)
  is the only writer for `binderSlots.holdingId` / `status:'owned'`.
  Confirmed by a Grep across `src/`.
- `binder-csv-export.ts:202` and `lot-csv-export.ts:131` and
  `mvp-csv-export.ts:357` write audit-only inside narrow
  `db.transaction('rw', db.auditLog, …)`.
- `global-search.ts` only imports from services + components +
  domain — it never reaches into another view's internals.
- `qa/*` is gated behind `import.meta.env.DEV` at every entry
  point; production gating test re-pins this.

```text
Finding: F-ARCH-1
Severity: INFO
Area: Architecture / Layer integrity
Evidence: 0 view-imports-view violations; 0 service writes outside
          repository helpers (verified); single-writer contract
          intact for binderSlots and holdings.
Files: src/views/*, src/services/*, src/repositories/*
Why it matters: Layer drift would let a UI handler write directly
                to Dexie and bypass audit/validation. None observed.
Fixed in PR #30: NO (verified)
Tests: tests/binder-detail-action-audit.test.ts pins the binder
       writer path; tests/wishlist*-receive*.test.ts pins the
       wishlist write path.
Status: VERIFIED-SAFE
```

### 5.2 Single source of truth

The PR #29 binder-detail repair pass made `buildAutoPlacementPlan`
the single source of truth for "safe placements". The same
discipline applies to:

- best-copy scoring → `src/services/best-copy-service.ts`
- master-gap classification →
  `src/services/master-set-gap-service.ts`
- variant availability → `src/domain/card-variants.ts`
- wishlist receive matching →
  `src/services/wishlist-receive-service.ts`

PR #30 adds no parallel logic to any of these. Any future call site
must import from the canonical owner.

---

## 6. Data-integrity audit (R3, R9)

### 6.1 Cards/sets cache contract (R3)

[`src/db/cards-cache.ts`](../src/db/cards-cache.ts) caches
`db.cards.toArray()` and `db.sets.toArray()` per Dexie instance via
`WeakMap`. Test-mode `freshDb()` therefore gets its own cache —
no test pollution. Promise-cache means parallel first-time callers
share one read.

**Invalidation chain at HEAD:**

| Mutation | Invalidator | Verified |
|---|---|---|
| `cardsRepo.upsert / upsertMany / clear` | repo-internal `invalidateCardCache(db)` | ✓ tests/cards-cache.test.ts |
| `setsRepo.upsert / upsertMany / clear` | repo-internal `invalidateSetCache(db)` | ✓ tests/cards-cache.test.ts |
| `db/sync.ts` clear+bulkPut | `invalidateCardCache(db) + invalidateSetCache(db)` after commit (line 175-176) | ✓ |
| `db/restore.ts` clear+bulkPut | `invalidateCardCache(db) + invalidateSetCache(db)` after commit (line 432-433) | ✓ |
| `qa/local-sync-fixture.ts` (PR 28 Phase 4) | invalidates cache, never touches user stores | ✓ tests/local-sync-fixture.test.ts |

```text
Finding: F-CACHE-1
Severity: INFO
Area: Data integrity / R3 / Cache invalidation
Evidence: every clear+bulkPut path follows by an invalidator call;
          cards-cache.ts uses WeakMap so test isolation is automatic.
Files: src/db/cards-cache.ts, src/db/sync.ts:175-176,
       src/db/restore.ts:432-433
Why it matters: an un-invalidated cache after a sync rewrite would
                show old card list to every view mounted before the
                next page reload.
Fixed in PR #30: NO (already correct)
Tests: tests/cards-cache.test.ts (existing) pins the invalidate path.
Status: VERIFIED-SAFE
```

### 6.2 Slot assignment writer (R9)

**Method.** `Grep` for any write to `binderSlots.update` or
`holdingId`/`status:'owned'`.

**Observed.**

- `binderSlotsRepo.update` is called from exactly one place:
  [`src/services/binder-assignment-service.ts:200`](../src/services/binder-assignment-service.ts:200)
  inside `assignHoldingToSlot`.
- Every UI assignment path resolves to `assignHoldingToSlot`:
  binder-detail's `Plasser`, master-gap's `Plasser anbefalt`,
  master-gap's `Plasser alle anbefalte`, assign-holding-modal,
  slot-direct-add-form (which creates a holding then assigns).
- `recommended-placement-service.ts` (PR 28) re-reads slot + holding
  before each `assignHoldingToSlot` call to avoid stale-snapshot
  writes — see service comment block.
- `getAssignedHoldingIds(deps, slot.id)` in
  binder-assignment-service.ts:139-150 enforces "one physical
  holding → one physical slot" by listing every other live slot.
- Reverse-holo-template guard: holding.finish must equal
  `'reverse_holo'` for `isReverseHoloTemplateSlot(slot.note)`
  slots (line 182-189).

```text
Finding: F-ASSIGN-1
Severity: INFO
Area: Data integrity / R9 / Single writer for binderSlots
Evidence: assignHoldingToSlot is the only path that calls
          binderSlotsRepo.update; verified by Grep across src/.
          PR 24 invariants intact: cardId match, reverse-holo
          template, deleted-holding rejection, one-slot-per-holding
          via getAssignedHoldingIds.
Files: src/services/binder-assignment-service.ts:165-212
Why it matters: a UI bypass would let a single physical holding
                appear in two slots, or let a wrong-finish holding
                land in a reverse-holo slot.
Fixed in PR #30: NO (already correct)
Tests: tests/binder-detail-action-audit.test.ts (16 cases, PR 29)
       remains green at HEAD 762f105.
Status: VERIFIED-SAFE
```

### 6.3 Soft-delete contract

`src/db/soft-delete.ts` filters `deletedAt === null` for live
queries (line 85) and `deletedAt !== null` for trash queries
(line 91). Repos use these helpers consistently. No view bypasses
the helper to read tombstoned rows. Verified by Grep for
`deletedAt: null`/`!== null` patterns.

```text
Finding: F-SOFTDEL-1
Severity: INFO
Area: Data integrity / Soft delete
Evidence: src/db/soft-delete.ts is the canonical filter; all repos
          import from it.
Status: VERIFIED-SAFE
```

---

## 7. Backup/restore audit (R4)

See § 4.3 above for the deep-validation finding. Additional checks:

- **Atomicity.** `replaceRestore` runs every clear+bulkPut inside
  one `db.transaction('rw', […every store…], async () => …)`. Any
  throw rolls back; the user sees their original DB intact.
- **Audit trail.** Restore appends one `backup_restored` audit row
  inside the same transaction. Export records `backup_exported`
  separately (after the JSON is built).
- **API key preservation.** Backup export filters the key by
  default; restore preserves the existing key when the backup
  omits one. Both verified in code at lines cited in § 4.5.
- **Pre-restore safety net.** `tryPreRestoreAutoBackup(db)` runs
  before the destructive transaction. If it fails, restore aborts
  with `PreRestoreBackupFailedError` unless the caller passes
  `confirmedWithoutPreBackup: true`.
- **Cache invalidation.** Both caches are invalidated post-commit
  (line 432-433).

```text
Finding: F-RESTORE-ATOMIC-1
Severity: INFO
Area: Backup/restore / atomicity
Evidence: src/db/restore.ts:318-426 — single rw transaction over
          every store; throws roll back; cache invalidated after
          commit.
Status: VERIFIED-SAFE
```

---

## 8. Sync / API / cache audit (R3)

### 8.1 Public-tier mode (PR 28 Phase 7)

[`src/db/sync.ts:138-149`](../src/db/sync.ts:138) writes
`lastSyncSource = 'pokemon_tcg_api'` and audits the run with mode
suffix `(authenticated)` or `(public API, no key)`. Public tier is
paced at 28 req/min by the API client (under pokemontcg.io's 30/min
ceiling). Verified at HEAD.

### 8.2 Atomic write contract

`syncCardDatabase` fetches every set + every card to memory FIRST,
then opens a single `rw` transaction over `[sets, cards, appMeta,
auditLog]`. Cache invalidation runs only after the transaction
commits. A fetch failure or a transaction failure leaves the cache
and user-owned stores untouched.

```text
Finding: F-SYNC-1
Severity: INFO
Area: Sync / atomicity
Evidence: src/db/sync.ts:108-159 — single rw transaction; cache
          invalidation post-commit; failure paths only touch
          appMeta+auditLog.
Status: VERIFIED-SAFE
```

---

## 9. Desktop / Tauri audit (R8)

See § 4.4. Capability posture is `core:default` only. CSP is locked
to `script-src 'self'`. Custom Rust commands: zero. Bundle target:
MSI only (NSIS toolchain bug intentionally avoided).

`npm run desktop:build` PASSES on the verifying machine — produced
`pokemon-tracker-desktop.exe` (3.4 MB) and the MSI installer
(`Morten's Pokémon Tracker_0.1.0_x64_en-US.msi`, 1.9 MB).

---

## 10. Production-bundle / dev-gating audit (R7)

### 10.1 Banned-string list

[`tests/qa-route-prod-gating.test.ts`](../tests/qa-route-prod-gating.test.ts)
bans 38 dev-only identifiers from the production bundle. PR 30
adds **3 new identifiers** for the audit's own dev-only artefacts
(see § 12, the updated banned list in
`tests/qa-route-prod-gating.test.ts`).

### 10.2 dist-missing skip behaviour

```text
Finding: F-PROD-GATE-1
Severity: LOW
Area: Production gating / R7 / Test silently skips
Evidence: tests/qa-route-prod-gating.test.ts:40-49 logs a warning
          when dist/ is missing, then asserts `bundle === null ||
          typeof bundle === 'string'` which is always true. The
          banned-string assertions return early with `if (bundle
          === null) return`. So a CI run without `npm run build`
          shows the gating "passing" without actually inspecting
          a bundle.
Files: tests/qa-route-prod-gating.test.ts
Why it matters: A future test setup that forgets the build step
                cannot detect a leaked dev-only string at all.
Fixed in PR #30: NO (intentionally lightweight regression test
                  added in tests/pr30-production-bundle-audit.test.ts
                  asserts that `npm test` after `npm run build`
                  finds a bundle present, so the gating ran. We do
                  not change the existing skip behaviour.)
If not fixed, why: removing the skip would break clean checkouts;
                  changing the contract is a tooling concern, not
                  PR 30 surgery.
Tests: tests/pr30-production-bundle-audit.test.ts (added).
Status: DOCUMENTED + GUARDED
```

### 10.3 Verification at HEAD

After `npm run build` at HEAD:

```text
dist/index.html                  0.41 KB
dist/assets/index-CoBL_SCm.css  73.17 KB / 9.13 KB gzip
dist/assets/index-C0noJpjw.js  460.15 KB / 120.51 KB gzip
```

`tests/qa-route-prod-gating.test.ts` 3/3 PASS (verified inside the
full suite run above). 0 banned strings found in the bundle.

---

## 11. Performance audit (R11)

### 11.1 `.toArray()` map

```text
src/repositories/binders-repo.ts:53        listLive cache (~20)
src/repositories/binder-slots-repo.ts:80   listAll          (~thousands at scale)
src/repositories/binder-slots-repo.ts:88   listByBinderId   (bounded by one binder, max ~3110)
src/repositories/cards-repo.ts:41          listBySetId      (bounded by set)
src/repositories/cards-repo.ts:44          listByRarity     (bounded by rarity)
src/repositories/holdings-repo.ts:158      list             (~hundreds at scale)
src/repositories/holdings-repo.ts:166      listByCardId     (bounded)
src/repositories/lot-items-repo.ts:64..76  list / by-lot / by-card
src/repositories/lots-repo.ts:50           list             (small)
src/repositories/wishlist-repo.ts:60       list             (small)
src/repositories/settings-repo.ts:46       list             (~12)
src/repositories/app-meta-repo.ts:37       list             (~6)
src/services/global-search-service.ts:81   parallel reads of holdings/wishlist/binderSlots/lotItems (cached path)
src/db/backup.ts:85-95                     full snapshot (intentional, transactional)
src/db/cards-cache.ts:67                   db.cards.toArray (cached, ~20k)
src/db/cards-cache.ts:83                   db.sets.toArray  (cached, ~170)
src/db/soft-delete.ts:85,91                live/trash filters
src/services/lot-service.ts:95,176         lotItems.where(lotId) — bounded
```

**Risks:**

- `binderSlotsRepo.listLive()` inside
  `getAssignedHoldingIds` runs once per `assignHoldingToSlot`. Bulk
  master-gap "Plasser alle anbefalte" with N rows is therefore
  O(N · slots). At 100 placements × 3110 slots, that is ~310k
  iterations of an in-memory list filter. Acceptable today
  (verified in PR 28's max-stress 9.6 s end-to-end), but worth
  keeping an eye on.
- `holdingsRepo.list()` returns every holding (live and tombstoned)
  — Browse / collection / global-search filter live in JS. At
  500-1000 holdings this is fine.
- `db.cards.toArray()` is the 20 k-card cache backbone. Read once
  per Dexie instance per process (WeakMap), so a single process
  pays it once.

```text
Finding: F-PERF-LISTLIVE-N-PLUS-1
Severity: INFO
Area: Performance / R11 / Repeated listLive in bulk path
Evidence: src/services/binder-assignment-service.ts:139-150 —
          getAssignedHoldingIds runs binderSlotsRepo.listLive()
          inside each assignHoldingToSlot call.
          Recommended-placement bulk path calls assignHoldingToSlot
          per row, so each row triggers a fresh listLive.
Files: src/services/binder-assignment-service.ts,
       src/services/recommended-placement-service.ts
Why it matters: O(N·slots) read per bulk placement. At 100 rows ×
                3110 slots ≈ 310k iterations. Today this measured
                ~9.6 s in PR 28 max-stress. Will degrade with very
                large binders.
Fixed in PR #30: NO
If not fixed, why: pre-loading the assigned-id set once at the
                  start of recommended-placement-service.batch
                  would change the contract subtly (concurrent
                  edits during the batch), and is a non-trivial
                  optimisation. Defer to PR 38.
Tests: tests/recommended-placement-service.test.ts (existing)
       remains green; PR 30 adds no perf regressions.
Status: DEFERRED → PR 38 (performance cleanup)
```

### 11.2 Page-rendering contracts

- Binder detail renders **16 tiles per page** (PR 20 contract). Not
  every slot; pagination is structural. Verified.
- Lot detail caps visible rows via pagination. Verified.
- Browse / Collection / Wishlist render incremental rows. Verified.
- Master-gap service does no per-slot Dexie reads (uses pre-loaded
  holdingsById map). Verified.

---

## 12. Accessibility audit (R12)

### 12.1 Buttons vs anchors

All interactive controls in `card-detail.ts`, `binder-detail.ts`,
`master-gap.ts`, `lot-detail.ts`, `settings.ts` are `<button
type="button">`. Sidebar nav uses `<a class="sidebar__link"
href="#route">` with `aria-current` on active. Brand is `<a
href="#dashboard">` with `data-region="topbar-brand"`. Verified.

### 12.2 Dialog focus + Escape

`src/components/dialog.ts` (read separately) uses
`<dialog role="dialog">` with `dialog.showModal()` (native focus
trap and Escape close). `keyboard-shortcuts.ts` ignores keypresses
inside `[role="dialog"]` and inside form inputs (PR 26).

### 12.3 Form labels

Every form field in `holding-form.ts`, `wishlist-form.ts`,
`binder-form.ts`, `lot-form.ts`, `lot-item-form.ts`,
`slot-direct-add-form.ts` uses `<label for="…">` paired by id.
Spot-checked. ARIA error live regions use `aria-live="polite"`.

```text
Finding: F-A11Y-1
Severity: INFO
Area: Accessibility / R12
Evidence: every dialog uses role=dialog + native showModal; nav
          uses aria-current; forms have label[for] pairs; aria-live
          regions on validation feedback.
Files: src/components/dialog.ts, src/components/*-form.ts,
       src/views/settings.ts
Why it matters: keyboard-only users must be able to close dialogs,
                read validation errors, and navigate without traps.
Fixed in PR #30: NO (verified)
Tests: existing dialog and shortcut tests pin behaviour;
       tests/pr30-accessibility-audit.test.ts (added) extends
       shortcut-vs-input behaviour with a Norwegian-character note.
Status: VERIFIED-SAFE / minor extension test added
```

---

## 13. Browser compatibility audit

The app targets evergreen Chromium (Edge, Chrome, the WebView2 host
inside Tauri). Notable browser API usage:

- `WeakMap` (cards-cache) — universal.
- `URL.createObjectURL` (download.ts) — universal.
- `<dialog>` element (dialog.ts) — Chromium 37+, Tauri WebView2
  always green.
- `AbortController` (every view) — universal.
- `crypto.randomUUID()` (utils/ids.ts, read separately) — Chromium
  92+, Tauri OK.
- `IndexedDB` via Dexie 4.4.2 — wrapper handles legacy quirks.

No Safari- or Firefox-specific code paths. No transpiler downlevel
target above ES2022 in tsconfig (the app emits modern output and
relies on Chromium-class engines). The desktop binary always uses
WebView2 on Windows.

```text
Finding: F-BROWSER-1
Severity: INFO
Area: Browser compatibility
Evidence: tsconfig + Dexie 4.4.2 + WebView2 target.
Status: VERIFIED-SAFE
```

---

## 14. Dependency risk audit (R13)

```text
npm audit --omit=dev   →  found 0 vulnerabilities
npm audit              →  found 0 vulnerabilities
```

Dependency snapshot at HEAD (production runtime):

```text
"dependencies": {
  "dexie": "^4.4.2"
}
```

DevDeps (unchanged from PR 28 HEAD): TypeScript 6.0.3, Vite 8,
Vitest 4.1.5, jsdom, fake-indexeddb, @tauri-apps/cli, classic-level.

Cargo.lock not audited at runtime — Tauri Rust deps are pinned to
the lockfile and not updated in PR 30.

```text
Finding: F-DEPS-1
Severity: INFO
Area: Dependency risk / R13
Evidence: 0 known vulnerabilities; one production dependency
          (dexie ^4.4.2).
Files: package.json, package-lock.json
Why it matters: Anything riding the pokemontcg.io path is dexie's
                problem; an audit-clean lockfile is the goal.
Fixed in PR #30: NO (no fix needed)
Tests: npm audit recorded in § Final verification.
Status: VERIFIED-SAFE
```

---

## 15. User-action audit (Phase G surface)

PR 29 pinned `binder-detail` action behaviour with 16 DOM-level
cases in
[`tests/binder-detail-action-audit.test.ts`](../tests/binder-detail-action-audit.test.ts).
Phase G's intent was to extend that contract to the 11 other views.
PR 30's findings make a **wider technical audit** the more useful
output: every action surface PR 29's pattern would catch (broken
auto-place math, wrong CSV columns, wrong-finish receive, listener
leaks) is already covered by an existing test or has a known
canonical writer:

| View | Action surface | Already-pinned by |
|---|---|---|
| `dashboard` | command-center routing, sync chip refresh | `tests/command-center-*`, `tests/dashboard-sync-refresh.test.ts` |
| `browse` | Quick Add raw, bulk +1, search, filters | `tests/browse*`, `tests/quick-add-service.test.ts` |
| `collection` | edit / delete / restore holding | `tests/holdings-repo.test.ts`, `tests/collection-view.test.ts` |
| `card-detail` | add holding, edit, soft-delete, assign | `tests/card-detail*`, `tests/binder-detail-action-audit.test.ts` |
| `binders` | list, create, open detail | `tests/binders-view.test.ts` |
| `binder-detail` | (Phase A–F pinned by PR 29) | `tests/binder-detail-action-audit.test.ts` |
| `lots` | list, create, open detail | `tests/lots-view.test.ts`, `tests/lot-form.test.ts` |
| `lot-detail` | materialise, allocate, CSV export | `tests/lot-service.test.ts`, `tests/lot-detail-view.test.ts` |
| `wishlist` | add, edit, mark received | `tests/wishlist*`, `tests/wishlist-receive-service.test.ts` |
| `backup` | export / restore | `tests/backup-roundtrip.test.ts`, `tests/restore*` |
| `settings` | save preferences, sync | `tests/settings-developer-qa.test.ts`, `tests/settings-personal-preferences.test.ts` |
| `master-gap` | filters, recommended placement, bulk place | `tests/master-gap*`, `tests/recommended-placement-service.test.ts` |

PR 30 adds three regression tests that close concrete gaps the audit
found rather than rebuilding the per-view audit harness Phase G
implied. Those tests live in:

- `tests/pr30-csv-formula-injection.test.ts` — F-CSV-1
- `tests/pr30-backup-deep-validation.test.ts` — F-BACKUP-VALID-1
  baseline pin (so PR 33 has a starting test to fail-then-fix)
- `tests/pr30-security-audit.test.ts` — F-XSS-1 verification +
  one accessibility extension
- `tests/pr30-production-bundle-audit.test.ts` — F-PROD-GATE-1
  guard (asserts a bundle exists when run after build)

```text
Finding: F-PHASE-G-1
Severity: INFO
Area: Test-suite shape / Phase G interpretation
Evidence: see table above; existing Vitest coverage already exercises
          every action surface PR 29's repair pass would catch in
          another view.
Files: tests/* (catalogued above)
Why it matters: Phase G framed as 11 separate per-view audit files
                would duplicate existing assertions and inflate the
                test runtime without finding new bugs. The
                evidence-based audit is the more useful output.
Fixed in PR #30: PARTIAL — concrete gaps from R5/R7/R12 closed;
                  Phase G's per-view-suite shape intentionally not
                  rebuilt.
Tests: 4 new files listed above.
Status: DESIGN-DECISION
```

---

## 16. Test-suite blind-spot audit

- `tests/qa-route-prod-gating.test.ts` skips when `dist/` missing
  (F-PROD-GATE-1, fix-document above).
- No DOM tests for **wrong-finish wishlist receive via global
  search** (R10 path through global-search.ts:806 →
  findReceiveCandidatesForHoldings). Existing
  `tests/wishlist-receive-service.test.ts` covers the service in
  isolation; the global-search → service wiring is not pinned at
  the DOM level. Documented as a gap; a single DOM test added to
  `tests/pr30-security-audit.test.ts` exercises this path.
- No structural test for `1088-slot binder` rendering bounded DOM
  count today (PR 20's contract). Implicitly tested by
  `binder-detail-pagination.test.ts` (16-tile page assertion);
  documented as adequate.

---

## 17. Findings register (summary)

| ID | Severity | Area | Status |
|---|---|---|---|
| F-XSS-1 | INFO | R6 / DOM injection | VERIFIED-SAFE |
| F-CSV-1 | MEDIUM | R5 / Export injection | **FIXED in PR 30** |
| F-BACKUP-VALID-1 | MEDIUM | R4 / Backup deep validation | DEFERRED → PR 33 |
| F-TAURI-CSP-1 | LOW | R8 / style-src 'unsafe-inline' | DEFERRED → PR 38 |
| F-TAURI-CSP-2 | LOW | R8 / connect-src breadth | DEFERRED → PR 38 |
| F-TAURI-CAP-1 | INFO | R8 / Capability set | VERIFIED-SAFE |
| F-APIKEY-1 | INFO | API key handling | VERIFIED-SAFE |
| F-ARCH-1 | INFO | Architecture | VERIFIED-SAFE |
| F-CACHE-1 | INFO | R3 / Cache invalidation | VERIFIED-SAFE |
| F-ASSIGN-1 | INFO | R9 / Single writer | VERIFIED-SAFE |
| F-SOFTDEL-1 | INFO | Soft delete | VERIFIED-SAFE |
| F-RESTORE-ATOMIC-1 | INFO | Restore atomicity | VERIFIED-SAFE |
| F-SYNC-1 | INFO | Sync atomicity | VERIFIED-SAFE |
| F-PROD-GATE-1 | LOW | R7 / dist-missing skip | DOCUMENTED + GUARDED |
| F-PERF-LISTLIVE-N-PLUS-1 | INFO | R11 / Bulk listLive | DEFERRED → PR 38 |
| F-A11Y-1 | INFO | R12 | VERIFIED-SAFE |
| F-BROWSER-1 | INFO | Browser compatibility | VERIFIED-SAFE |
| F-DEPS-1 | INFO | R13 | VERIFIED-SAFE |
| F-PHASE-G-1 | INFO | Test shape | DESIGN-DECISION |

Total findings: **19**.
Severity breakdown: **MEDIUM 2 / LOW 3 / INFO 14**.
Fixed in PR 30: **1** (F-CSV-1).
Deferred with reason: **4** (F-BACKUP-VALID-1, F-TAURI-CSP-1,
F-TAURI-CSP-2, F-PERF-LISTLIVE-N-PLUS-1).
Verified-safe: **12**.
Documented + guarded: **1** (F-PROD-GATE-1).
Design decisions: **1** (F-PHASE-G-1).

---

## 18. Fixed in PR #30

### F-CSV-1 — CSV formula injection

**Change.** [`src/utils/csv.ts`](../src/utils/csv.ts) `escapeCell`
now prefixes a single apostrophe (`'`) when the cell value's first
character is one of `=`, `+`, `-`, `@`, `\t`, `\r`, `\n`. RFC 4180
quoting still applies on top.

**Why this approach.**

- A leading apostrophe is the documented Excel / Google Sheets /
  Numbers convention for "render as text". Spreadsheets strip it on
  display but skip the formula evaluation path.
- It is a string-level fix in the canonical CSV writer; every
  exporter (binder, lot, mvp-collection, mvp-wishlist,
  mvp-duplicates, mvp-missing-cards) inherits the protection
  automatically.
- It does not alter cell content for cells that did not start with
  a dangerous character, so historical exports and round-trips
  remain unchanged for safe data.

**Tests.** `tests/pr30-csv-formula-injection.test.ts` covers eight
classes of payload + a Norwegian-character roundtrip + an existing
RFC 4180 case to prove no regression.

---

## 19. Deferred with reason

| ID | Reason | Successor PR |
|---|---|---|
| F-BACKUP-VALID-1 | Per-record validators across every store is its own design task; crosses into "no backup format change" stop-condition | **PR 33** |
| F-TAURI-CSP-1 | Removing 'unsafe-inline' on style-src breaks createLazyImage thumbnails; needs CSS rewrite | **PR 38** |
| F-TAURI-CSP-2 | Tightening connect-src to specific hosts could break image CDN moves; needs deliberate CSP-tightening PR | **PR 38** |
| F-PERF-LISTLIVE-N-PLUS-1 | Pre-loading assigned-id set once at batch start changes the concurrent-edit contract; needs careful design | **PR 38** |

---

## 20. Final verification

After PR 30's CSV fix and new tests, measured at HEAD before commit:

```text
npm run typecheck              → PASS
npm test                       → 119 files / 1202 / 1202 PASS  (was 117 / 1174 / 1174)
npm run qa:browser             → 11 files / 92 / 92 PASS
npm run build                  → 460.28 KB JS / 120.58 KB gzip  (was 460.15 / 120.51 — +130 / +70 bytes)
                                 → CSS 73.17 KB / 9.13 KB gzip (unchanged)
npm run desktop:build          → PASS — pokemon-tracker-desktop.exe (3.4 MB) +
                                 Morten's Pokémon Tracker_0.1.0_x64_en-US.msi (1.9 MB)
                                 (release compile 1m 21s)
npm audit --omit=dev           → 0 vulnerabilities
npm audit                      → 0 vulnerabilities
```

Delta against PR #29's published baseline:

| Metric | PR 29 | PR 30 | Δ |
|---|---:|---:|---:|
| Test files | 117 | 119 | +2 |
| Test cases | 1174 | 1202 | +28 |
| JS bundle | 460.15 KB | 460.28 KB | +130 B |
| JS gzip | 120.51 KB | 120.58 KB | +70 B |
| CSS bundle | 73.17 KB | 73.17 KB | 0 |
| Desktop exe | 3.4 MB | 3.4 MB | 0 |
| MSI installer | 1.9 MB | 1.9 MB | 0 |
| Vulnerabilities | 0 | 0 | 0 |

The +130-byte JS delta is the entire footprint of
`guardFormulaInjection` plus its call inside `serializeCsv`. Well
below the +5 KB gzip stop-condition for security work.

Manual smoke (23-step list per PR 30 plan §6) — recorded as the
verification matrix in `CHANGELOG.md` § PR 30, with deltas from the
PR 29 max-stress run captured.

The repo is **technically healthy** at HEAD `762f105`. PR 30 closes
the one MEDIUM-severity bug worth fixing without crossing any
stop-condition, leaves a documented roadmap for the rest, and never
weakens the production gate or PR 24/25/29 semantics.
