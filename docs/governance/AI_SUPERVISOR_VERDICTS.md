# AI Supervisor — Verdict reference

OpenAI emits one of seven **model verdicts** per Stop hook fire. Two additional
**supervisor verdicts** (`BUDGET_HALT`, `QUEUE_EXHAUSTED`) are synthesized in
code; the model cannot emit them. (`AUTO_MERGE_TO_INTEGRATION` is RESERVED for a
future PR and not in the V1 verdict enum.)

The full schema lives in [scripts/ai-supervisor/schemas/verdict.v1.json](../../scripts/ai-supervisor/schemas/verdict.v1.json).

## Model verdicts (7)

### `CONTINUE_CLAUDE`
**When**: fixable issue (failing test, scope-creep that's salvageable, missing comment, etc.)
**Risk level**: depends on the issue (often LOW or MEDIUM)
**`claude_next_prompt`**: required, non-empty; precise fix instructions
**What Claude sees**: a block-prompt rendered from `templates/continue-claude.md` with the failing checks and step-by-step fix actions.
**State effect**: `repairCount += 1` (forces QUARANTINE_AND_CONTINUE after `AI_SUPERVISOR_MAX_REPAIRS=5` consecutive on the same error signature)

### `SOURCE_REQUIRED`
**When**: diff touches an external API (OpenAI, Claude hooks, Tauri, GitHub, pokemontcg.io) but no cached authoritative docs exist.
**Risk level**: typically MEDIUM
**`required_sources[]`**: required non-empty; each entry has `topic`, `url`, `rationale`, `max_age_days`.
**What Claude sees**: rendered prompt instructing it to fetch each URL via the WebFetch tool, cache under `.local/ai-supervisor/source-cache/`, then retry.
**State effect**: `repairCount += 1`.

### `SPLIT_AUTOMATICALLY`
**When**: diff covers multiple concerns and should be decomposed.
**Risk level**: LOW (mechanical)
**`claude_next_prompt`**: required; should propose sub-PR breakdown.
**What Claude sees**: rendered prompt with sub-PR list and instructions to commit current wip to a `wip/<task-id>-pre-split` branch, then create sub-branches from `origin/main`.
**State effect**: `repairCount` reset to 0 (new tasks begin).

### `REBUILD_FROM_SCRATCH`
**When**: branch is contaminated (interleaved unrelated changes, broken-patched-broken cycles, fundamentally wrong approach).
**Risk level**: HIGH (significant work to redo)
**`quarantine_reason`**: should describe what went wrong (used for the rebuild prompt's "lessons learned" section).
**What Claude sees**: prompt instructing it to archive current state to `wip/<task-id>-rebuild-archive`, then `git checkout -b <new-branch> origin/main`.
**State effect**: `repairCount` reset.

### `AUTO_READY`
**When**: all gates pass — scope clean, verification all PASS, no blocking findings, behaviour_drift_check.passed=true on roadmap tasks.
**Risk level**: LOW
**`claude_next_prompt`**: should be the next task's prompt (rendered by verdict-router from queue or discovery), OR null if queue exhausted.
**What Claude sees**: either the next-task prompt (with branch-switch instructions if applicable), OR allow-stop (queue exhausted; supervisor writes a queue-empty report).
**State effect**: current task `repairCount` reset; if AUTO_READY produces a next-task block-prompt, queue is dequeued. The completed task's `branch_hint` is appended to `pending_pushes`.

### `QUARANTINE_AND_CONTINUE`
**When**: branch is unsalvageable cheaply (repair-cap hit, unsafe regression, operator should review later).
**Risk level**: typically MEDIUM
**`quarantine_reason`**: required non-empty.
**What Claude sees**: quarantine-and-continue prompt (mentions the quarantined task, then renders the next task).
**State effect**: quarantine report written to `.local/ai-supervisor/quarantine/<task-id>.md`; fingerprint added to `state.quarantine_fingerprints` (filters discovery for 7 days); next task dequeued.

### `SECURITY_QUARANTINE`
**When**: destructive operation in progress, secret leak detected, attempt to violate a §3 sacred-data invariant.
**Risk level**: HIGH
**`quarantine_reason`**: required.
**Stdout output**: `{"continue": false, "reason": "..."}` — ULTIMATE STOP override. Claude exits immediately.
**State effect**: writes `.local/ai-supervisor/STOP` sentinel (sticky across session restarts). Quarantine report written.

## Supervisor verdicts (2)

### `BUDGET_HALT` (supervisor-only)
**When**: daily $ cap reached, or OpenAI returns `insufficient_quota`.
**What Claude sees**: allow-stop. Budget-halt report written to `.local/ai-supervisor/reports/`.
**Recovery**: wait for UTC midnight (daily cap resets) OR raise `OPENAI_DAILY_USD_CAP` and restart Claude Code.

### `QUEUE_EXHAUSTED` (supervisor-only)
**When**: AUTO_READY fired with empty queue AND no auto-discoverable next task.
**What Claude sees**: allow-stop. Queue-empty report written.
**Recovery**: operator adds tasks to `.local/ai-supervisor/queue.json` and reopens Claude Code.

## Per-task cost cap

Independent of daily cap: `OPENAI_PER_TASK_USD_CAP=$50` (default). When a single
task accumulates this much spend, the supervisor forces `QUARANTINE_AND_CONTINUE`
(not BUDGET_HALT — the LOOP continues, just on the next task).

## Verdict-router decision table

| Verdict | Routing |
|---|---|
| `CONTINUE_CLAUDE` | block + fix prompt |
| `SOURCE_REQUIRED` | block + source-fetch prompt |
| `SPLIT_AUTOMATICALLY` | block + split prompt |
| `REBUILD_FROM_SCRATCH` | block + rebuild prompt |
| `AUTO_READY` + queue head | block + next-task prompt; dequeue |
| `AUTO_READY` + queue empty + discovery hit | block + next-task prompt |
| `AUTO_READY` + queue empty + no discovery | allow-stop + queue-empty report (`QUEUE_EXHAUSTED`) |
| `QUARANTINE_AND_CONTINUE` + queue head | block + quarantine-and-continue prompt |
| `QUARANTINE_AND_CONTINUE` + queue empty | allow-stop + quarantine + queue-empty reports |
| `SECURITY_QUARANTINE` | stdout `{continue:false}` + write STOP sentinel + quarantine report |
| Synthetic `BUDGET_HALT` | allow-stop + budget-halt report |
