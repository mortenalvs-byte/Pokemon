# PR #29 scope audit

Generated for the stabilization pass on `feat/desktop-smart-placement-verification`.

## Headline numbers

- **Branch HEAD:** `885a85c` (against `origin/main`)
- **Files changed:** 100
- **Insertions / deletions:** +12 704 / −23

## Category breakdown

| # | Category | Files | Insertions | Deletions | Production-runtime risk? |
|---|---|---:|---:|---:|---|
| 1 | App-core (router / main / shell / styles / keyboard) | 5 | 399 | 2 | **Yes** — runs in production. |
| 2 | Smart placement (services + domain + master-gap view) | 6 | 800 | 12 | **Yes** — runs in production. |
| 3 | Desktop scaffold (Tauri config + Rust + capabilities) | 6 | 4 639 | 0 | **Yes** for desktop builds; no effect on browser. The bulk of insertions here is `Cargo.lock` (~4 100 lines, generated). |
| 4 | Tauri icons (PNG/ICNS/ICO assets) | 53 | 9 | 0 | **No** runtime risk. Pure binary assets; the "9 insertions" are XML/`ic_launcher_background.xml`. |
| 5 | Build / config (`package.json`, `vite.config.ts`, `.gitignore`, CHANGELOG) | 5 | 632 | 7 | **Yes** — package-lock dominates the line count (~590 lines from added `classic-level` + `@tauri-apps/cli`). |
| 6 | QA / dev tooling (`src/qa/*` + `src/views/qa.ts`) | 6 | 2 861 | 0 | **No** — gated behind `import.meta.env.DEV`. Verified tree-shaken from `dist/` by `tests/qa-route-prod-gating.test.ts`. |
| 7 | Tests (`tests/*`) | 17 | 3 124 | 2 | **No** — test-only; never imported by `src/main.ts`. |
| 8 | Docs (`docs/*`) | 2 | 240 | 0 | **No** runtime risk. |
| **Total** | | **100** | **12 704** | **23** | |

## Production-runtime files (the only ones that ship)

This is the audit reviewers should focus on:

| File | Lines | Purpose |
|---|---:|---|
| `src/app.ts` | +29 | Adds `qa` route to `VIEW_MOUNTERS` (dev-only mounter via `import.meta.env.DEV`). Adds `runBootTimePersistenceAudit()` call (DEV-gated). The diff to `NAV_LINKS` in this PR is what Phase 2 cleans up — see section below. |
| `src/main.ts` | +260 | Adds DEV-only console capture, auto route-walk, dev-auto-public-sync, dev-auto-max-stress. All gated behind `import.meta.env.DEV`. |
| `src/router.ts` | +9 | Adds `'qa'` and `'master-gap'` to the `Route` union. `getCurrentRoute()` recognises `'qa'`. Production-safe: the route falls through to dashboard when no mounter is registered (verified by `tests/qa-route-prod-gating.test.ts` matching `qa: <same id as dashboard>` in `dist`). |
| `src/components/keyboard-shortcuts.ts` | +14 | Adds `g q → #qa` shortcut. Falls back to dashboard in production via the same mounter trick. |
| `src/styles.css` | +87 | Master-gap view + QA view styles. |
| `src/views/master-gap.ts` | +new | New master-gap report view (PR 25 was already merged; this PR adds the smart-placement overlay). |
| `src/services/best-copy-service.ts` | +new | Pure scoring function. No DB access. Imported by `master-set-gap-service.ts`. |
| `src/services/recommended-placement-service.ts` | +new | Bulk-placement orchestrator that reuses PR 24's `assignHoldingToSlot`. |
| `src/services/master-set-gap-service.ts` | +diff | Adds best-copy overlay + recommended/manual aggregates. PR 25 classification semantics unchanged. |
| `src/services/command-center-service.ts` | +diff | Splits `resolve_ambiguous_owned` into `place_recommended_copies` / `resolve_manual_ambiguous`. |
| `src/domain/master-set-gap.ts` | +diff | Adds `MasterGapBestCopyRecommendation` type + per-binder/dashboard recommendation aggregates. |

**App-core + smart-placement + production-runtime portion of `src/main.ts` and `src/router.ts` ≈ 1 200 production lines, mostly new pure functions and one new view.** That's a reviewable surface.

## Dev-only files (must be tree-shaken)

These never run in production. Each one is verified by `tests/qa-route-prod-gating.test.ts` to emit 0 occurrences in `dist/assets/index-*.js`:

```
src/qa/qa-seed.ts                          1 200 lines
src/qa/qa-runner.ts                          230 lines
src/qa/qa-report.ts                          290 lines
src/qa/qa-max-stress.ts                      560 lines
src/qa/desktop-persistence-diagnostic.ts     370 lines
src/views/qa.ts                              290 lines
```

Plus the `src/main.ts` segments inside `if (import.meta.env.DEV) { … }` and the dynamic `import('./views/qa')` in `src/app.ts`.

The strings banned in production builds are listed in `tests/qa-route-prod-gating.test.ts`'s `banned` array (currently 30+ identifiers covering QA harness, persistence diagnostic, max-stress, console-audit, route-walk, dev-auto-sync, dev-auto-stress).

## Test-only files

17 files in `tests/`, all run by Vitest. None are imported by `src/main.ts`. Coverage:
- `tests/desktop-app-config.test.ts` (30) — Tauri scaffold sanity
- `tests/best-copy-service.test.ts` (22) — scoring
- `tests/recommended-placement-service.test.ts` (16) — bulk placement
- `tests/master-gap-best-copy.test.ts` (16) — overlay + classification
- `tests/command-center-best-copy.test.ts` + `tests/command-center-service.test.ts` (9 + existing) — split
- `tests/qa-seed.test.ts` (9) — seed determinism
- `tests/qa-report.test.ts` + `tests/qa-runner.test.ts` (18 + 9) — report builder
- `tests/qa-max-stress.test.ts` (8) — max-stress live
- `tests/desktop-persistence-diagnostic.test.ts` + `tests/desktop-persistence-diagnostic-live.test.ts` (combined ~21) — persistence audit
- `tests/qa-route-prod-gating.test.ts` (3) — production-gating greps
- `tests/dashboard-workspace.test.ts` (workspace) — added in PR 27 territory
- `tests/app-shell-desktop.test.ts` + `tests/app.test.ts` — small extensions (already filtered the QA route out of the canonical-eight-nav-links assertion)

## Hard-rule check

| Rule | Status |
|---|---|
| No schema migration | ✅ `src/db/schema.ts` not touched. Dexie still at `db.version(2)`. |
| No new IndexedDB store | ✅ `STORE_NAMES` in `src/db/schema.ts` unchanged. |
| No new Tauri capability | ✅ `src-tauri/capabilities/main.json` declares only `core:default`. No `fs:`, `shell:`, `clipboard:`. Verified by `tests/desktop-app-config.test.ts`. |
| No pricing/value logic | ✅ Best-copy scoring deliberately ignores price fields. |
| No smart-placement scoring scope creep | ✅ Score components fixed: base + finish + condition + language + status + graded penalty + special-variant penalty. No price tier, no rarity multiplier. |
| No external API beyond pokemontcg.io | ✅ `src/api/pokemon-tcg-api.ts` only ever hits `https://api.pokemontcg.io/v2`. The new public-tier pacing (28 req/min) does not change the URL. |
| QA harness tree-shaken from production | ✅ `tests/qa-route-prod-gating.test.ts` 3/3 PASS. Re-built `dist/` has 0 occurrences of every banned string. |
| No new public Tauri command | ✅ `src-tauri/src/main.rs` is the canonical empty `tauri::Builder::default().run(...)`. No `invoke_handler`. |

## Conclusion

**`PR #29 is large but bounded.`**

- Production-runtime surface area is ~1 200 lines across the app-core, smart placement, and master-gap view. That is reviewable.
- The remaining ~11 500 lines are 53 binary icon files, a generated `Cargo.lock`, `package-lock.json`, dev-only QA tooling, tests, and docs. None of it ships in the user-facing browser bundle.
- Hard rules are intact. No schema migration, no new IndexedDB store, no new Tauri capability, no pricing logic, no smart-placement scope creep, no extra third-party API.
- Production gating tests have caught every dev-only string addition during this PR's lifetime.

The PR therefore does **not** need to be split. It needs the cleanup pass below before merge.

## Cleanup pass (Phase 2 onward)

The remaining stabilization work is tracked separately in this branch's commit log:

1. **Phase 2** — Remove `QA harness (dev)` from the visible sidebar nav. Add a dev-only "Developer QA" entry under Settings instead, plus the existing `g q` shortcut.
2. **Phase 3 + 4** — Local fixture importer so dashboard/image testing doesn't depend on a live API call.
3. **Phase 5** — Image audit + visible fallback placeholder for missing/broken images.
4. **Phase 6** — Dashboard refresh-after-sync audit (the earlier "0/0 first paint" confusion).
5. **Phase 7** — Confirm public API sync works without a key (already implemented; verify text + behaviour).
6. **Phase 8** — Max-stress run after fixture import.
7. **Phase 9** — Production gating ban list update for every new dev-only string.
8. **Phase 10** — Run `npm run typecheck`, `npm test`, `npm run qa:browser`, `npm run build`, `npm run qa:full`, `npm run desktop:dev`. `npm run desktop:build` only if a build-facing file changed.
9. **Phase 11** — Update PR body + final comment with hard numbers from this branch.

Until those phases land, PR #29 is **not ready to merge**.
