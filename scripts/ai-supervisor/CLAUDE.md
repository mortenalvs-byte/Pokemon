# scripts/ai-supervisor/ — operator/maintainer guide

This directory contains the **AI Supervisor**: a local-only Node.js system that
intercepts Claude Code's Stop / PostToolUse / PreToolUse hooks, runs full local
verification (`typecheck`/`test`/`build`/`audit` + conditional gates), sends a
redacted review packet to OpenAI for a strict-JSON verdict, and routes the
verdict back to Claude as the next-action prompt.

For background, design rationale, and full audit history, see the plan at
`~/.claude/plans/hei-purring-minsky.md` (local operator file, not committed).
For policy/scope, see [../../docs/governance/AI_SUPERVISOR_APPROVAL.md](../../docs/governance/AI_SUPERVISOR_APPROVAL.md)
and the trio:
- [AI_SUPERVISOR_OVERVIEW.md](../../docs/governance/AI_SUPERVISOR_OVERVIEW.md) — what it is, mental model
- [AI_SUPERVISOR_VERDICTS.md](../../docs/governance/AI_SUPERVISOR_VERDICTS.md) — every verdict, when, what Claude sees
- [AI_SUPERVISOR_OPERATIONS.md](../../docs/governance/AI_SUPERVISOR_OPERATIONS.md) — runbook, env vars, kill switches

## Module map

| File | Layer | Role |
|---|---|---|
| `stop-review.mjs` | entry | Stop hook entry point; orchestrates the pipeline. |
| `post-tool-use.mjs` | entry | PostToolUse hook; runs `vitest related` in background. |
| `pre-tool-use-keyscan.mjs` | entry | PreToolUse hook; blocks API-key leaks. |
| `install-hook.mjs` | setup | Idempotent installer + `--update-pins` / `--reset` / `--force`. |
| `state.mjs` | I/O | Atomic state.json load/save + concurrency lock + .bak rotation. |
| `parse-approval.mjs` | I/O | YAML-subset parser for `.local/ai-supervisor/approvals/*.md`. |
| `git-evidence.mjs` | I/O | Collects git state; refuses on main/detached/rebase-in-progress. |
| `scope-guard.mjs` | I/O | 19 Pokemon-specific hard-forbidden gates; approval-record unblock. |
| `run-checks.mjs` | I/O | Sequential npm-script runner; verification cache. |
| `discover-tasks.mjs` | I/O | Roadmap PRs + TODO/FIXME scan; quarantine-fingerprint filter. |
| `build-packet.mjs` | I/O | Composes OpenAI user content; byte-deterministic cached prefix. |
| `openai-client.mjs` | API | Responses API client; streaming, retries, BUDGET_HALT synth. |
| `cleanup-zombies.mjs` | I/O | Reaps orphaned supervisor processes (Windows + Unix). |
| `dedup.mjs` | pure | Input-hash dedup ($47K-postmortem mitigation). |
| `blob-store.mjs` | I/O | Memory-pointer pattern for tool outputs >100KB. |
| `redact.mjs` | pure | Three-layer secret-redaction. |
| `validate-verdict.mjs` | pure | Semantic verdict validation; cross-validates verification claims. |
| `verdict-router.mjs` | pure | State-machine routing to hook decision. |
| `templates.mjs` | pure | Handlebars-subset renderer. |
| `schemas/*.json` | spec | verdict.v1, state.v1, queue.v1 — JSON schemas. |
| `templates/*.md` | spec | system-prompt + 6 block-prompt templates. |

## Day-1 quick start

1. Set `OPENAI_API_KEY` as a Windows User env var (one-time).
2. `node scripts/ai-supervisor/install-hook.mjs` (writes `.claude/settings.local.json`).
3. Hand-seed `.local/ai-supervisor/queue.json` with a first task (the plan has a PR 35 example).
4. Open Claude Code in this worktree; start any task.
5. The loop runs autonomously until you close the chat or create `.local/ai-supervisor/STOP`.

## Kill switches (in priority order)

1. **Close the chat** — soft stop; the current Stop hook completes, then no new hooks fire.
2. **`New-Item -ItemType File .local/ai-supervisor/STOP`** — the next Stop hook fire allows stop immediately.
3. **Set `OPENAI_DAILY_USD_CAP=0`** — forces `BUDGET_HALT` on the next call.
4. **`Ctrl+C` in Claude Code's terminal** — kills the process. Zombies are reaped on next start.

## Common tasks

- **Inspect state**: `cat .local/ai-supervisor/state.json | jq .`
- **See last review's evidence**: `ls -t .local/ai-supervisor/review-packets/ | head -1` → open the `.md`
- **Read a quarantine report**: `.local/ai-supervisor/quarantine/<task-id>.md`
- **Bypass a HARD-FORBIDDEN path for one task**: create `.local/ai-supervisor/approvals/appr-<date>-<slug>.md` per the schema in `parse-approval.mjs`.
- **Upgrade supervisor code**: edit modules, run `node scripts/ai-supervisor/install-hook.mjs --update-pins`.
- **Reset everything**: `node scripts/ai-supervisor/install-hook.mjs --reset` (preserves approvals + packets).
