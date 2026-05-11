# AI Supervisor — Overview

The AI Supervisor is a **local-only Node.js system** that lets Claude Code run
autonomously on Pokemon TCG Tracker work for days. Each time Claude tries to
stop, a Stop hook intercepts and runs the supervisor pipeline:

1. **Pre-checks** (branch, dirty worktree, sub-agent, plan mode, STOP sentinel).
2. **Scope-guard** (19 Pokemon-specific hard-forbidden gates).
3. **Run-checks** (sequential `typecheck` → `test` → `build` → `audit` + conditional gates).
4. **Dedup** (input-hash check against recent iterations; Aura-Guard pattern).
5. **Build packet** (git evidence + verification + scope-guard + approvals → redacted markdown).
6. **OpenAI Responses API** (`gpt-5.5-pro` at `xhigh` reasoning, strict JSON schema).
7. **Validate verdict** (semantic checks + cross-validation against captured verification).
8. **Route verdict** to one of `CONTINUE_CLAUDE`, `SOURCE_REQUIRED`, `SPLIT_AUTOMATICALLY`,
   `REBUILD_FROM_SCRATCH`, `AUTO_READY`, `QUARANTINE_AND_CONTINUE`, `SECURITY_QUARANTINE`.
9. **Apply side-effects** + persist state + emit hook output.

## Mental model

- **Supervisor**: decides + tracks state. Never `git checkout`, `git commit`, `git push`, `git branch -D`. Pure observer + decider + state-keeper.
- **Claude**: edits files, runs tools, makes commits — driven by block-prompts the supervisor sends back via stdout.
- **Operator (you)**: starts the chat, reviews quarantine reports, approves HARD-FORBIDDEN unblocks via `.local/ai-supervisor/approvals/`, manually pushes AUTO_READY branches and merges to main.

## In-session loop

```
Claude works → Stop hook fires
  ↓
Supervisor pipeline (above)
  ↓
Verdict + side-effects
  ↓
  • block + reason → Claude continues with the supervisor's instructions
  • allow-stop → Claude exits this turn (operator may continue manually)
  • continue:false → SECURITY_QUARANTINE; Claude exits and STOP sentinel is written
```

The loop is event-driven, not time-driven. Claude resting between turns does
NOT fire the hook. The loop pauses cleanly when the chat is idle.

## Files & directories

- `scripts/ai-supervisor/**` — the supervisor itself (committed)
- `docs/governance/AI_SUPERVISOR_*.md` — this trio (committed)
- `.claude/settings.local.json` — hook configuration (gitignored)
- `.local/ai-supervisor/**` — runtime state (gitignored):
  - `state.json` + `state.json.bak.*` — supervisor state with GFS retention
  - `state.lock` — concurrency lock (PID + start_time + hostname)
  - `queue.json` — task queue
  - `code-pins.json` — SHA pins of supervisor's own modules (tamper detection)
  - `review-packets/<run-id>.{md,json}` — full review evidence per iteration
  - `quarantine/<task-id>.md` — quarantine reports
  - `reports/<kind>-<ts>.json` — budget-halt, queue-empty, human-halt reports
  - `approvals/*.md` — operator-authored approval records
  - `source-cache/*.json` — cached authoritative API docs
  - `blobs/blob-<sha>.txt` — large tool outputs stored via memory-pointer pattern
  - `verification-cache/<hash>.json` — npm-script result cache (10-min TTL)
- `.local/ai-supervisor-smoke/` — Phase 0 throwaway scripts + config

## Closing the chat (operator-side stop semantics)

Three escalating stop methods:

| Method | When the next stop fires... |
|---|---|
| Close the chat window | Loop pauses. No new hooks fire. State preserved. |
| `New-Item -ItemType File .local/ai-supervisor/STOP` | Allows stop immediately. Hook reports human-halt. |
| `Set $env:OPENAI_DAILY_USD_CAP="0"` + restart Claude Code | Forces BUDGET_HALT verdict. Loop stops with budget report. |

## What is NOT automated (V1)

- Auto-push to remote, auto-PR-create, auto-merge — all manual. PR2 adds push + draft PR.
- Daemon that re-launches Claude if it crashes — deferred to PR5.
- Cross-process state sync across machines — out of scope; supervisor is per-machine.
- Full mutation-testing / lint-warnings task discovery — minimal in PR1, expanded in PR3.

## Where to start as operator

1. Read [AI_SUPERVISOR_APPROVAL.md](AI_SUPERVISOR_APPROVAL.md) for scope/policy.
2. Read [AI_SUPERVISOR_OPERATIONS.md](AI_SUPERVISOR_OPERATIONS.md) for the runbook.
3. Phase 0 (one-time setup) is documented at the top of [scripts/ai-supervisor/CLAUDE.md](../../scripts/ai-supervisor/CLAUDE.md).
