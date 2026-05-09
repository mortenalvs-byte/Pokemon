# QA harness — desktop verification

PR 28 introduced a Tauri-based desktop wrapper plus a smarter master-set placement engine. The QA harness (PR 28 review patch) is how we verify that those features actually run end-to-end before merging — without requiring DevTools tricks or hand-typed JS payloads.

## Goals

1. **Deterministic seed** — every QA run starts from the same DB state so report numbers are comparable across machines and runs.
2. **No DevTools paste** — the dev-only `#qa` route exposes Reset / Seed / Run / Measure / Download buttons. You never need to open DevTools or paste JavaScript into the console.
3. **Automatic report** — every run produces a Markdown + JSON report you can attach to the PR.
4. **No production risk** — the QA route is gated behind `import.meta.env.DEV`. Production builds never wire it up; the seed never runs against real data unless a developer explicitly opens `#qa` during `npm run dev` or `npm run desktop:dev`.

## QA levels

| Level | Command | What it covers |
|---|---|---|
| **L1 — merge gate (static)** | `npm run qa:static` | typecheck + full Vitest suite + browser build. No Tauri / Rust required. |
| **L2 — browser smoke** | `npm run qa:browser` | Targeted Vitest run for the QA harness itself (seed determinism, report shape, runner orchestration). |
| **L3 — desktop manual** | `npm run desktop:dev` then `#qa` | Run the seed inside the actual Tauri window and download the report. The only level that proves the desktop runtime works. |
| **L4 — full** | `npm run qa:full` | L1 + L2 in one command. Run before pushing a review patch. |

`npm run qa:desktop:manual` prints the L3 instructions so you don't have to look them up.

## Seed contract

Constants in [src/qa/qa-seed.ts](../src/qa/qa-seed.ts):

| Constant | Value | Why |
|---|---:|---|
| `QA_SEED_NAME` | `morten-pokemon-qa-v1` | Marker for cross-run comparison; the report writes this verbatim. |
| `QA_HOLDINGS_TARGET` | 1000 | Stress check for cards listing + gap classification. |
| `QA_WISHLIST_TARGET` | 200 | Mixed wanted / ordered for wishlist views and gap status. |
| `QA_LOTS_TARGET` | 5 | Each carries `QA_LOT_ITEMS_PER_LOT` items. |
| `QA_LOT_ITEMS_PER_LOT` | 50 | Total lot items 250 — well above any UI virtualisation threshold. |
| `QA_BINDERS_TARGET` | 7 | Mix of Vault9 / Vault12 / Vault12XL / Vault16 / custom + master + reverse-template. |
| `QA_TOTAL_SLOTS_TARGET` | 3422 | Includes a 1088-slot stress binder; `Master Base` caps at 102. |
| `QA_ASSIGNED_SLOTS_TARGET` | 400 | Upper bound; the seed assigns ≤ this so `complete` never starves the unassigned scenarios. |

Master-gap signals the seed is engineered to produce:

- `recommendedAmbiguousCount > 0` — 30 cards in set 1 each have `NM + LP` so the recommended copy beats the alternative.
- `manualAmbiguousCount > 0` — 30 cards in set 2 each have `NM + NM` so the score ties → manual choice required.
- `ambiguousOwned > 0` — sum of the two above.
- `invalidCount > 0` — at least one `invalid_assignment` (assigned holding for a different card) and one `invalid_variant` (normal holding parked on a `template:reverse_holo` slot).
- `reverseTemplateSlots > 0` — every other slot in the reverse-test binder gets `note=template:reverse_holo` and a set-4 (reverse-holo-priced) target card.

## L5 — max stress (sync + all-states populate)

This is the broadest coverage test the harness supports. It assumes the user has already run a real pokemontcg.io sync (Innstillinger → Synk nå) so the local card cache holds the full ~20 000-card dataset, then drives a single seed pass that exercises every domain-state axis the app can render.

### What it populates

- **Holdings** — one row per `(condition × finish × edition × status)` combo for every finish the cache supports, plus a graded layer per `(grading company × grade)` pair (PSA / BGS / CGC / TAG / ACE / OTHER × 10/9/8/7/6).
- **Binders** — six binders covering every Vault X preset (`vaultx_9_360`, `vaultx_12_480`, `vaultx_12xl_624`, `vaultx_16xxl_1088`) plus a custom master binder with a reverse-holo template mix and a custom grand_master binder. Each binder gets ≤ 50 slot assignments through PR 24's `assignHoldingToSlot`, so the placement contract is exercised.
- **Wishlist** — one entry per `(status × priority × {normal, holo})` combo. Covers `wanted` / `ordered` / `received` / `cancelled` × `low` / `medium` / `high` / `grail`.
- **Lots** — three lots covering unallocated (`allocatedCost = null`), allocated (`allocatedCost = 200`, no holding) and materialised (allocated + linked to a fresh `holdingId`). Five items per lot.

The function is implemented in [src/qa/qa-max-stress.ts](../src/qa/qa-max-stress.ts) and seeds under the name `morten-pokemon-stress-v1`. It returns a `QaMaxStressSummary` with per-axis counts so the operator can see exact coverage.

### Recipe

```
1. npm run desktop:dev   (or npm run dev for browser preview)
2. Innstillinger → API-nøkkel → Lagre → Synk nå.
   Wait until Sett-i-cache and Kort-i-cache settle (~150 sets / 20k cards).
3. Open #qa (sidebar dev link or `g q`).
4. Click "Max stress (all-states populate)".
5. Click "Last ned stress-summary JSON" → save to `.local/qa/`.
6. Walk every route — Min samling, Permer, Lotter, Ønskeliste, Master gap.
   Confirm seeded data renders correctly across all states.
```

If the cache is empty when "Max stress" runs, the function falls back to an 8-card fixture (logged in `summary.notes`). That keeps the seed always-runnable, but the matrix is much smaller.

The entire surface is dev-only and tree-shaken from production builds — `tests/qa-route-prod-gating.test.ts` greps `dist/` for `seedMaxStressData`, `morten-pokemon-stress-v1`, `data-action="qa-max-stress"` and fails if any leak through.

## L4 — desktop persistence audit (Launch A → B → C)

This is the dedicated recipe for the desktop persistence regression that the 2026-05-09 manual run hit (data on disk but `db.holdings.count() === 0` after restart). It exercises the persistence diagnostic the QA harness ships in `src/qa/desktop-persistence-diagnostic.ts`.

The recipe writes two sentinels:

1. `localStorage` key `pokemon.desktopPersistenceSentinel` (and `pokemon.desktopPersistenceBootCounter` for the boot counter).
2. `appMeta` row keyed by `desktopPersistenceSentinel`.

Both encode `bootCounter`, `timestamp`, `origin`, `runtime`. If the IndexedDB store empties out across a restart while the localStorage sentinel survives, the diagnostic returns `fail_seeded_holdings_zero_with_sentinel` and `runQa` flips the report to `overall: FAIL`.

### Recipe

| # | Step | Expectation |
|---|---|---|
| **Launch A** | `npm run desktop:dev`, open `#qa`. Click **Reset + Seed + Run report** (this also runs the persistence diagnostic). Click **Write persistence sentinel**. Click **Last ned diagnostic JSON** → save to `.local/qa/`. | Overall: PASS · holdings = 1000 · sentinel bootCounter = 1. |
| **Close A** | Click the window's X button. | Tauri dev exits cleanly. |
| **Launch B** | `npm run desktop:dev` again, open `#qa`. Click **Run + expect seeded data**. Click **Last ned diagnostic JSON** → save to `.local/qa/`. | Verdict: pass · holdings = 1000 · same Dexie name + verno · same origin · localStorageSentinel.bootCounter = 1 (unchanged from A). |
| **Close B** | Click X. | Tauri dev exits cleanly. |
| **Launch C** | `npm run desktop:dev` again, open `#qa`. Click **Run + expect seeded data**. Click **Last ned diagnostic JSON** → save to `.local/qa/`. | Same expectations as Launch B. |

PASS = Launch B and Launch C both return verdict `pass` AND identical Dexie name/verno AND identical origin AND `holdings = 1000`. FAIL = the localStorage sentinel survives but `holdings === 0`, which is the exact regression we're auditing.

If FAIL: do NOT merge. Inspect the diagnostic JSON for clues:

- **origin changed** → Tauri dev/release origin strategy needs to change.
- **Dexie verno or db.name changed** → schema migration ate the rows.
- **`storeCounts.appMeta` dropped while localStorageSentinel survived** → IndexedDB-specific eviction in the WebView2 profile.
- **All counts dropped including localStorageSentinel** → the WebView2 user profile is not stable.

The pure verdict logic lives in `evaluatePersistenceDiagnostic` (covered by `tests/desktop-persistence-diagnostic.test.ts`) and the live diagnostic builder is covered by `tests/desktop-persistence-diagnostic-live.test.ts`. Production builds must NOT contain any of `buildPersistenceDiagnostic` / `writePersistenceSentinel` / `desktopPersistenceSentinel` — `tests/qa-route-prod-gating.test.ts` greps the `dist/` bundle and fails if any leak through.

## L3 — desktop QA recipe

Prerequisites: see [docs/DESKTOP_APP.md](DESKTOP_APP.md). On Windows you need Node + Rust + MSVC C++ Build Tools + WebView2 installed.

1. `npm install` (once).
2. `npm run desktop:dev` — wait for `Finished `dev` profile` and the Tauri window to open.
3. Inside the Tauri window, navigate to `#qa` (paste into the URL bar of the Tauri WebView, or click any link to a hash route then edit it).
4. Click **Reset + Seed + Run report**. The status line reports `Ferdig. Overall: PASS — 1000 holdings, 7 binders, 3422 slots, …`.
5. Click **Last ned JSON** and **Last ned Markdown**. The browser save dialog is wired up by `downloadTextFile`.
6. Move both files to `.local/qa/` (gitignored) so you can keep a per-run history.
7. Walk the routes by clicking each sidebar entry. Watch for console errors in the Tauri DevTools (right-click → Inspect Element).
8. Open `#master-gap`, pick a binder, confirm both ambiguous types appear in the table.
9. Open `#binder/<id>` for any populated binder, confirm the gap-summary banner counts match the dashboard card.
10. Optional — Backup → Eksporter, then Backup → Importer to confirm the desktop FS dialog flow works.

## What the report contains

Generated by [src/qa/qa-report.ts](../src/qa/qa-report.ts):

- Overall PASS / FAIL verdict
- Runtime detection (`browser` / `tauri` / `unknown` from `__TAURI_INTERNALS__`)
- Node / npm / rustc / cargo versions (only when the caller passes them)
- Seed summary (counts + elapsed)
- Master-gap aggregates (recommended / manual / invalid / can-place-directly)
- DB counts for every store (alphabetical, deterministic)
- Route check table (one row per documented hash)
- Performance timings (reset / seed / count / master-gap)
- Console error / warning counts (caller-supplied; the harness doesn't tail console itself)
- Backup roundtrip status (`ok` / `failed` / `not_run`)
- Free-form `notes` array

Pass/fail rules in [evaluateQaPassFail](../src/qa/qa-report.ts):

- **Fail** if `console.errors > 0`.
- **Fail** if `backupRoundtrip === 'failed'`.
- **Fail** if any `routeCheck.ok === false`.
- **Fail** if seed ran but master-gap snapshot is missing.
- **Fail** if seed ran and either `recommendedAmbiguousCount` or `manualAmbiguousCount` is zero.
- Warnings alone do not fail the run.

## Hard rules (do not break)

- No schema migration. The seed only writes through existing repos; reverse-holo encoding stays in `note=template:reverse_holo`.
- No new DB store. Reports live in browser memory and download as files; nothing is persisted under `db.*` for QA.
- No broad Tauri permissions. The capability set stays at `core:default`. The QA flow does not need `fs`, `shell`, or `clipboard`.
- `import.meta.env.DEV` gates the route. Production / Tauri release builds do not register a mounter for `#qa`.
- Reset preserves `db.settings`. PR 27 user prefs survive a wipe.

## Where reports go

`.local/qa/` is gitignored (see `.gitignore`). The QA view writes the filename `desktop-qa-report.md` / `.json` and the OS save dialog picks the destination — you decide where to keep them. Convention is:

```
.local/qa/
  2026-05-08T21-30-browser.md
  2026-05-08T21-30-browser.json
  2026-05-08T21-45-tauri.md
  2026-05-08T21-45-tauri.json
```

…but rename freely. Nothing in the repo reads these.

## Troubleshooting

- **`overall: FAIL` with `master_gap` zeroes** — probably ran Seed onto a non-empty DB. Click **Reset QA data** first, then **Seed stress data**.
- **`overall: FAIL` with `seed: null`** — you ran Measure-only on an empty DB and console.errors are non-zero. Open DevTools and look at the actual error.
- **Tauri window fails to compile** — see [docs/DESKTOP_APP.md](DESKTOP_APP.md) prerequisites. Most common cause on Windows is missing MSVC C++ Build Tools.
- **`#qa` shows the dashboard instead** — you're running a production build (`npm run preview` or a release `desktop:build`). The QA route is dev-only by design.
