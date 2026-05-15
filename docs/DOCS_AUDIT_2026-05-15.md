# Docs audit — 2026-05-15

**Scope:** every Markdown file in the repo (22 files across root + `docs/`).
**This pass:** classification only. **No files are moved or deleted in this PR.**
After operator approval of the categories below, a follow-up PR can apply
the archival / deletion actions.

## Method

For each file the audit captured:

1. The opening intent (first ~30 lines).
2. Last-modifying commit (`git log -1 -- <path>`).
3. Inbound references — grepped across `*.md`, `*.ts`, `*.json` from the
   repo root to distinguish active hubs from orphans.
4. Stated status header where the doc declares one.

## Classification scheme

| Category | Meaning |
|---|---|
| **KEEP_CURRENT** | Active source of truth; referenced by code or live work. |
| **KEEP_HISTORICAL** | Useful as historical context (e.g. completed PR audit); should stay, possibly under `docs/archive/`. |
| **MERGE_INTO_README_OR_SPEC** | Overlapping content with another doc; target named in row. |
| **DELETE_STALE** | Superseded, completed-and-no-longer-needed, or zero inbound refs. |
| **NEEDS_DECISION** | Ambiguous; requires operator call. |

## Classification table

| File | Last touched | Inbound refs | Category | Rationale | Suggested action |
|---|---|---|---|---|---|
| `KRAVSPEC.md` | 2026-05-11 (3684168) | README + code comments | KEEP_CURRENT | Authoritative requirements; MVP scope + hard out-of-scope + user-data sanctity; updated for AI Supervisor carve-out. | Keep as root spec. |
| `MVP_ACCEPTANCE.md` | 2026-05-06 (c1e22b2) | README + CHANGELOG | KEEP_CURRENT | Acceptance checklist for MVP; tagged on `main`. | Keep as root spec. |
| `UI_DESIGN_SPEC.md` | 2026-05-06 (c1e22b2) | README + CHANGELOG + code | KEEP_CURRENT | Page-by-page UI specification (desktop-first, table-heavy). | Keep as root spec. |
| `USER_FLOWS.md` | 2026-05-06 (c1e22b2) | README + CHANGELOG | KEEP_CURRENT | 14 end-to-end flows; live requirements. | Keep as root spec. |
| `DASHBOARD_SPEC.md` | 2026-05-06 (c1e22b2) | README + CHANGELOG | KEEP_CURRENT | Dashboard sections, warnings, MVP exclusions. | Keep as root spec. |
| `DATA_MODEL.md` | 2026-05-06 (c1e22b2) | README + CHANGELOG + code + linked from BACKUP_FORMAT | KEEP_CURRENT | 11 IndexedDB stores, types, soft-delete, audit-log contract. | Keep as root spec. |
| `BACKUP_FORMAT.md` | 2026-05-06 (c1e22b2) | README + CHANGELOG + DATA_MODEL | KEEP_CURRENT | JSON backup format, restore behaviour, CSV rules, `schemaVersion`. | Keep as root spec. |
| `TECH_STACK.md` | 2026-05-11 (3684168) | README + references KRAVSPEC / DATA_MODEL | KEEP_CURRENT | Locked stack: TS strict, Vite, Dexie, Vitest, plain CSS + rationale. | Keep as root spec. |
| `PR_RULES.md` | 2026-05-11 (3684168) | AI Supervisor docs + CHANGELOG | KEEP_CURRENT | Branch + PR + scope + merge governance. | Keep as root spec. |
| `README.md` | 2026-05-06 (bc35eee) | Hub: links all 10 root specs + getting-started | KEEP_CURRENT | Project entry point. | Keep. |
| `CHANGELOG.md` | 2026-05-12 (ab36106) | Referenced by MVP_ACCEPTANCE / PR_RULES / IMPROVEMENT_ROADMAP | KEEP_CURRENT | Release log; recent entry (PR B1) active. | Keep. |
| `docs/IMPROVEMENT_ROADMAP.md` | 2026-05-11 (df27076) | **Canonical source** consumed by `scripts/ai-supervisor/discover-tasks.mjs` | KEEP_CURRENT | 24 follow-up PRs (A–F sections); task pipeline. | Keep. Live task source. |
| `docs/PR29_SCOPE_AUDIT.md` | 2026-05-09 (762f105) | Referenced in IMPROVEMENT_ROADMAP | KEEP_HISTORICAL | PR #29 scope audit (Desktop + smart placement); closed. | Move to `docs/archive/`. |
| `docs/PR30_CLEANUP_ROADMAP.md` | 2026-05-09 (812516a) | Referenced in IMPROVEMENT_ROADMAP header | KEEP_HISTORICAL | Cleanup roadmap (PR 31–38); superseded by IMPROVEMENT_ROADMAP. | Move to `docs/archive/`. |
| `docs/PR30_FULL_TECHNICAL_AUDIT.md` | 2026-05-09 (812516a) | Companion to PR30_FULL_TECHNICAL_REPORT | KEEP_HISTORICAL | Repo audit evidence base (file paths, 18 risk lanes); closed. | Move to `docs/archive/`. |
| `docs/PR30_FULL_TECHNICAL_REPORT.md` | 2026-05-09 (812516a) | Companion to PR30_FULL_TECHNICAL_AUDIT | KEEP_HISTORICAL | Human-readable system-health rollup (GREEN with minor YELLOW). | Move to `docs/archive/`. |
| `docs/DESKTOP_APP.md` | 2026-05-09 (762f105) | **No inbound refs** | NEEDS_DECISION | Tauri v2 prerequisites + commands. Active reference or PR #29 artefact? | Operator: confirm whether desktop docs are first-class. |
| `docs/QA_DESKTOP.md` | 2026-05-09 (762f105) | **No inbound refs** | NEEDS_DECISION | L1–L4 QA harness (seed determinism, report). Process doc or one-off? | Operator: confirm whether L1–L4 is run regularly. |
| `docs/governance/AI_SUPERVISOR_APPROVAL.md` | 2026-05-11 (3684168) | Referenced in tests + AI_SUPERVISOR_OVERVIEW | KEEP_CURRENT | Approval record (local dev tooling carve-out). | Keep. |
| `docs/governance/AI_SUPERVISOR_OPERATIONS.md` | 2026-05-11 (e609a93) | Referenced from AI_SUPERVISOR_OVERVIEW | KEEP_CURRENT | Runbook: setup, smoke test, daily ops, Stop-hook loop. | Keep. |
| `docs/governance/AI_SUPERVISOR_OVERVIEW.md` | 2026-05-11 (e609a93) | Referenced from APPROVAL + OPERATIONS + VERDICTS | KEEP_CURRENT | Supervisor mental model + verdict routing. | Keep. |
| `docs/governance/AI_SUPERVISOR_VERDICTS.md` | 2026-05-11 (e609a93) | Referenced from AI_SUPERVISOR_OVERVIEW + schemas/verdict.v1.json | KEEP_CURRENT | 7 model + 2 supervisor verdicts; cross-links the schema. | Keep. |

## Duplicate / overlap analysis

**KRAVSPEC vs MVP_ACCEPTANCE** — Complementary, not redundant. KRAVSPEC
defines *what* (scope, requirements); MVP_ACCEPTANCE defines *how to
measure done* (acceptance checklist). No merge.

**UI_DESIGN_SPEC vs DASHBOARD_SPEC** — Distinct. DASHBOARD_SPEC drills
into one page that UI_DESIGN_SPEC names; intentional layering. No merge.

**PR30 pair (AUDIT + REPORT)** — Intentional split. The audit holds the
evidence base (paths + risk lanes); the report is the human summary.
Archive together as historical record.

**PR29 → PR30 → IMPROVEMENT_ROADMAP** — Linear supersession.
IMPROVEMENT_ROADMAP (2026-05-11) is the live source consumed by the AI
supervisor automation. PR29 and PR30 docs are historical context.

**DESKTOP_APP + QA_DESKTOP** — Both PR #29 feature docs with zero
inbound refs. **Ambiguous status:** unclear if they are kept as
process docs or one-time artefacts. Operator decision required.

**AI_SUPERVISOR subsystem (4 docs)** — Intentional layering:
APPROVAL → OVERVIEW → OPERATIONS + VERDICTS. All active, tightly
coupled. No overlap.

## Executive summary

| Category | Count |
|---|---:|
| KEEP_CURRENT | 16 |
| KEEP_HISTORICAL | 4 |
| NEEDS_DECISION | 2 |
| MERGE_INTO_README_OR_SPEC | 0 |
| DELETE_STALE | 0 |

**No merge targets identified.** Every doc has a distinct role.

**Top 3 archival candidates (subject to operator approval):**

1. `docs/PR29_SCOPE_AUDIT.md` — PR #29 closed, useful history, no active
   refs outside the roadmap. → `docs/archive/`.
2. `docs/PR30_CLEANUP_ROADMAP.md` — Superseded by IMPROVEMENT_ROADMAP. →
   `docs/archive/`.
3. `docs/PR30_FULL_TECHNICAL_AUDIT.md` + `docs/PR30_FULL_TECHNICAL_REPORT.md`
   — Closed-PR companion docs. Archive as a pair. → `docs/archive/`.

**NEEDS_DECISION (2 items):**

- `docs/DESKTOP_APP.md` — keep if desktop is actively supported and
  this is the reference doc; archive otherwise.
- `docs/QA_DESKTOP.md` — keep if the L1–L4 QA process is run on
  demand; archive if it was a one-off PR #28 artefact.

## What happens next

This PR only adds this audit document. No files are moved or deleted.

Once you (the operator) approve the categories above, a follow-up PR
can:

1. Create `docs/archive/` and move the 4 KEEP_HISTORICAL files there.
2. Update inbound references in `docs/IMPROVEMENT_ROADMAP.md` so
   archived paths still resolve.
3. Resolve the 2 NEEDS_DECISION items based on your call.
4. Run `npm run qa:static` (now includes `lint` per PR #42) to confirm
   nothing broke; nothing in `src/**` or `tests/**` should be affected
   by doc moves.
