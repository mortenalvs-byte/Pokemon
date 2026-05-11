# PR_RULES — Pokemon TCG Tracker

Pull-request rules for this repository. These rules protect user data, the backup contract, and the small-PR culture this project depends on.

---

## 1. Core rule

`main` must always remain stable.

- **No direct commits to `main`.**
- All changes go through a feature branch and a pull request.
- A PR is reviewed before merging.

---

## 2. Scope control — one purpose per PR

Each PR must have a single clear purpose. Allowed PR sizes:

- A small documentation PR.
- One data-model PR (e.g. add a store, add a field, add a migration).
- One database-feature PR (e.g. backup, restore, audit log).
- One UI-feature PR (e.g. binder detail view, wishlist view).
- One bugfix PR.

**Not allowed:**

- Large all-in-one app PRs.
- Unrelated refactors mixed into a feature PR.
- Tax / accounting features.
- Sales-tax reports.
- Rewriting stable files without a documented reason.

If you find an unrelated improvement while working, open a separate PR for it.

---

## 3. User-data protection

User-owned data is permanent. The PR must not alter or remove the following without an explicit approval PR landing first:

**Permanent (sacred) user data:**
- holdings
- lots
- lotItems
- binders
- binderSlots
- wishlist
- notes
- manual prices
- tags
- auditLog
- settings (excluding cache invalidation that doesn't change values)

**Replaceable cache:**
- sets
- cards
- API price cache

API sync **must never** modify user-owned data. PR reviewers reject any PR whose sync code path touches a user-owned store.

---

## 4. Backup safety

Backup and restore are MVP. **No PR is complete if it breaks any of:**

- JSON export
- JSON import
- Backup validation
- `schemaVersion` handling
- Pre-restore auto-backup

Schema changes (adding a store, renaming a field, changing a type) **must** ship the matching forward migration in the same PR, plus a Vitest test that opens an old-version database and verifies the new shape.

Changing the backup format requires a `schemaVersion` bump documented in [BACKUP_FORMAT.md](BACKUP_FORMAT.md) and [CHANGELOG.md](CHANGELOG.md).

---

## 5. Data layer before UI

Do not build the dashboard or any advanced UI feature before the data layer it depends on exists. The data-layer dependencies are, in order:

1. IndexedDB schema (Dexie).
2. Migrations.
3. Soft delete.
4. Audit log.
5. Repositories (typed CRUD).
6. Backup export.
7. Backup restore (replace mode).

Items 1–5 land together in PR 3 because the typed repositories are how PR 4's backup/restore reads and writes every store; building the schema without the typed CRUD layer would force the backup/restore PR to bypass validation. Items 6–7 land in PR 4. PRs 6 through 10 depend on PR 3 and PR 4 having landed.

---

## 6. Required PR description checklist

Every PR description includes:

- **What changed.**
- **Why it changed.**
- **Files changed.**
- **User data impact.** ("None" is a valid answer; say so explicitly.)
- **Backup/restore impact.** ("None — no schema or backup format change" is a valid answer.)
- **Tests run.** Include `typecheck`, `test`, and `build` results.
- **Known limitations.**

A PR that doesn't fill these out gets sent back for the description.

---

## 7. Forbidden without explicit approval

Do not, in any PR, do any of the following without a separate approval PR landing first:

- Delete a user-data store.
- Rename a database field without a migration.
- Change the backup format without a `schemaVersion` bump.
- Remove backup or restore.
- Replace IndexedDB with `localStorage` (or anything else) for user data.
- Add tax / accounting features.
- Add external paid APIs.
- Add login, accounts, OAuth, or cloud sync.
- Add image upload or image storage inside IndexedDB.
- Add a frontend framework (React, Vue, Svelte, Solid, …) or a CSS framework (Tailwind, Bootstrap, …).
- Skip pre-commit / pre-push hooks with `--no-verify`.
- Bypass commit signing.

If one of these is genuinely needed, the approval PR must:
1. Update the relevant foundation document (KRAVSPEC, TECH_STACK, DATA_MODEL, BACKUP_FORMAT) explicitly.
2. Be merged on its own.
3. Be referenced in the implementation PR's description.

### Local development tooling exception (2026-05-11)

Local dev/review tools that run only on the developer's machine, never ship in the application bundle, never call out from the production app, and never receive user-owned data, are NOT considered "external paid APIs" under this section. Adding a new local dev tool that uses an external paid API requires a docs-only approval PR updating [docs/governance/AI_SUPERVISOR_APPROVAL.md](docs/governance/AI_SUPERVISOR_APPROVAL.md) (or a sibling approval record) before any implementation PR.

---

## 8. Merge rule

A PR may merge only when **all** of the following are true:

- Scope matches the PR title.
- `npm run typecheck` is green.
- `npm test` is green.
- `npm run build` is green.
- The app starts locally with no console crash on startup.
- If the PR touches the data layer, backup and restore still work end-to-end (export → wipe → restore round-trip test passes).
- The PR description checklist (§6) is filled in.

Squash-merge is the default. The squashed commit message uses the PR title and description.

---

## 9. Bootstrap exception

PR 1 is a docs-only foundation PR created before the app shell, `package.json`, npm scripts, Vite, and Vitest exist.

**For PR 1 only**, the merge-rule items in §8 that depend on tooling are not applicable:

- `npm run typecheck` — N/A (no `package.json`, no TypeScript)
- `npm test` — N/A (no Vitest)
- `npm run build` — N/A (no Vite)
- "App starts locally with no console crash" — N/A (no application code)

Docs-only review is sufficient for PR 1. Reviewers verify that the eleven foundation documents exist, are internally consistent, and reflect the agreed scope.

After **PR 2** lands the Vite + TypeScript app shell and the npm scripts, every subsequent PR follows the normal §8 merge rule with no exception:

- `npm run typecheck` is green.
- `npm test` is green.
- `npm run build` is green.
- The app starts locally with no console crash on startup.

This bootstrap exception applies to PR 1 only. It cannot be reused.

---

## 10. PR 3 backup-rule exception (historical)

PR 3 introduced the Dexie schema, migrations, repositories, soft delete, and audit log — i.e. the typed data layer that PR 4's backup/restore is built on top of. Backup and restore did not exist yet.

**For PR 3 only:**
- The §4 backup-rule clause "no PR is complete if it breaks JSON export, JSON import, backup validation, schemaVersion handling" was satisfied because none of those code paths existed yet.
- The §8 merge-rule clause "if the PR touches the data layer, backup/restore still works end-to-end" was **N/A**.
- The §13 reviewer step "verifies that backup/restore still works" was **N/A**.

This exception was a one-time historical allowance. **It cannot be reused.** It is documented here so reviewers reading the merged PR 3 can see the contract that was in force at merge time.

**From PR 4 onward, the `export → wipe → restore` round-trip is mandatory for every data-layer PR.** PR 4 lands the export, the validator, the replace-restore (with the pre-restore auto-backup), and a Vitest round-trip test that subsequent data-layer PRs may not break. A failing round-trip test blocks merge of any later PR that touches stores, repositories, or the schema.

---

## 11. Branch naming

| Kind of change | Branch prefix | Example |
|---|---|---|
| Documentation | `docs/` | `docs/project-foundation-v1` |
| Feature (functional code) | `feat/` | `feat/dexie-schema-v1` |
| Bug fix | `fix/` | `fix/binder-completion-rounding` |
| Chore (tooling, config) | `chore/` | `chore/upgrade-vitest` |

Branches are created from up-to-date `main`.

---

## 12. Commit message style

- Short imperative subject line, ≤ 72 chars.
- A blank line, then a body explaining **why** when the change isn't obvious.
- Reference the PR number once it exists.

There is no enforced commit-message lint in MVP, but reviewers may ask for a clean rebase if the history is hard to read.

---

## 13. Reviews

- A PR has at least one reviewer (the project owner, in MVP).
- The reviewer reads the code, runs the branch locally if it touches the data layer, and verifies that backup/restore still works.
- "Approve" means the reviewer believes the PR meets §6 and §8.

---

## 14. CI (later)

CI is not configured in MVP. When CI lands (a future docs+chore PR will define the scope), it will, at minimum:

- Run `npm run typecheck`.
- Run `npm test`.
- Run `npm run build`.
- Refuse to merge a PR that fails any of the above.

Until CI exists, the same checks are run **locally** before opening the PR.

---

## 15. Hot rules — quick reference

> 1. Stable `main`. PR for everything.
> 2. One purpose per PR.
> 3. User data is sacred.
> 4. Backup/restore is MVP, never broken.
> 5. Data layer before UI.
> 6. No framework, no backend, no cloud, no tax.
> 7. Soft delete only — no permanent delete in MVP.
> 8. Schema changes ship with migrations and tests.
> 9. The PR description fills the checklist.
> 10. Don't bypass hooks.
