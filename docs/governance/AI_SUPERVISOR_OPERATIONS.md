# AI Supervisor — Operations Manual

Day-to-day operator runbook for the AI Supervisor system.

## One-time setup (Phase 0)

### 0.0 — API key

Set `OPENAI_API_KEY` as a Windows User environment variable:

```powershell
[Environment]::SetEnvironmentVariable("OPENAI_API_KEY", "sk-proj-...", "User")
```

Then:
1. Close all PowerShell windows.
2. Close Claude Code completely.
3. Reopen a PowerShell, verify with `echo $env:OPENAI_API_KEY`.
4. Reopen Claude Code in this worktree (it inherits env from the new parent shell).

### 0.A — OpenAI API smoke test

Verifies model availability, strict-schema, reasoning effort, response shape, and pricing on **your** OpenAI account. Writes `.local/ai-supervisor-smoke/phase0-config.json` for the supervisor to consume.

```powershell
node .local/ai-supervisor-smoke/openai-smoke.mjs
```

Expected: `=== PASSED ===` and a config file is created. Cost: ~$0.03 per call (smoke test uses a tiny diff).

### 0.B — Stop hook smoke test

Captures the exact stdin shape Claude Code passes to Stop hooks on your machine. Used to confirm assumptions in `stop-review.mjs`.

The temporary smoke hook is installed by hand in `.claude/settings.local.json` pointing at `.local/ai-supervisor-smoke/hook-smoke.mjs`. After verifying logs at `.local/ai-supervisor-smoke/hook.log`, the operator installs the real supervisor hook via `install-hook.mjs` (which overwrites).

### 0.C — Install the real supervisor hook

```powershell
node scripts/ai-supervisor/install-hook.mjs
```

This writes `.claude/settings.local.json` with three hook entries (Stop / PostToolUse / PreToolUse), plus `.local/ai-supervisor/code-pins.json` containing SHA-256 hashes of load-bearing supervisor modules.

After install, close + reopen Claude Code. The supervisor is now live.

## Going live

1. Seed `.local/ai-supervisor/queue.json` with the first task. See `docs/governance/AI_SUPERVISOR_VERDICTS.md` for the queue schema, or copy the example from the plan.

2. Open Claude Code in this worktree on a feature branch (NOT `main`).

3. Start a Claude conversation: "Begin the queued supervisor task" or similar.

4. The supervisor fires on every Stop. The loop runs until you close the chat, the queue empties, the daily cap trips, or SECURITY_QUARANTINE fires.

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | — | Required. Read once at startup; trimmed; format-validated. |
| `OPENAI_DAILY_USD_CAP` | `500` | Daily hard cap. Exceeding it emits `BUDGET_HALT` (allow-stop with report). |
| `OPENAI_PER_TASK_USD_CAP` | `50` | Per-task cap. Forces `QUARANTINE_AND_CONTINUE`; loop continues on next task. |
| `OPENAI_REQUEST_TIMEOUT_MS` | `400000` | AbortController timeout for each OpenAI request (6.5 min). |
| `AI_SUPERVISOR_VERIFY_BUDGET_MS` | `400000` | Total verification budget. Steps after this is exhausted become `SKIP`. |
| `AI_SUPERVISOR_DEDUP_WINDOW` | `5` | Hash-dedup window. Same hash 2x within this window → forced quarantine. |
| `AI_SUPERVISOR_MEMORY_POINTER_THRESHOLD` | `102400` | Tool outputs larger than this are stored as blobs and referenced. |
| `AI_SUPERVISOR_PACKET_BYTE_BUDGET` | `204800` | Max byte size of user-content packet sent to OpenAI. |

## Kill switches (priority order)

1. **Close the chat window** — soft pause; no new hooks fire.
2. **Create `.local/ai-supervisor/STOP`** — next hook fire allows stop immediately.
3. **`$env:OPENAI_DAILY_USD_CAP="0"`** + restart Claude Code — forces `BUDGET_HALT`.
4. **Ctrl+C in Claude Code's terminal** — kills the process. Zombies are reaped at next start.

## Inspecting state during a run

```powershell
# Current state (concise)
cat .local/ai-supervisor/state.json | jq '{tasks, cost: .cost.daily, pending_pushes}'

# Most recent review packet (full evidence sent to OpenAI)
Get-ChildItem .local/ai-supervisor/review-packets/*.md | Sort-Object LastWriteTime -Descending | Select-Object -First 1 | Get-Content

# Pending pushes (operator manually pushes these to remote)
cat .local/ai-supervisor/state.json | jq .pending_pushes

# Most recent quarantine
Get-ChildItem .local/ai-supervisor/quarantine/*.md | Sort-Object LastWriteTime -Descending | Select-Object -First 1 | Get-Content
```

## Approval-record workflow (unblocking sacred paths)

To let Claude touch a HARD-FORBIDDEN path (e.g. `src/db/restore.ts`) for one task:

1. Create `.local/ai-supervisor/approvals/appr-2026-MM-DD-<slug>.md`:

```markdown
---
approval_id: appr-2026-05-11-restore-deep-fix
task_id: task-20260511-abc123
status: active
issued_at: 2026-05-11T14:00:00.000Z
expires_at: 2026-05-13T14:00:00.000Z
operator: morten
approved_paths:
  - path: src/db/restore.ts
    type: exact
  - path: tests/restore-deep-validation.test.ts
    type: exact
restrictions:
  - no schemaVersion change
  - no backup format bump
max_renewals: 1
renewal_count: 0
rationale: |
  Adds deep validation for lots[].purchaseDate per PR33 hardening trajectory.
  No schema change, no format bump. (≥20 chars required.)
---
```

2. Ensure the queue task's `id` matches the `task_id` in the approval.
3. The supervisor re-reads approvals on every Stop fire — no restart needed.
4. **Supervisor-self-mod** (`scripts/ai-supervisor/**`) requires a QUORUM: two distinct `operator` values across two separate approval records covering the same `task_id`.

Approvals expire absolutely at `expires_at`. To renew, create a NEW record with `renewal_count` bumped (not edit the old one).

## Pushing AUTO_READY branches

V1 does NOT auto-push. Operator workflow:

```powershell
# List branches with AUTO_READY work pending push
git branch | findstr "auto/"  # or check state.pending_pushes

# Push and open draft PR
git push -u origin <branch>
gh pr create --draft --title "<task title>" --body "<see review-packet>" --base main --head <branch>

# Review the PR, mark Ready for review, squash-merge per PR_RULES §8.
```

PR2 will automate the push + draft-PR step.

## Disaster recovery

| Failure | Recovery |
|---|---|
| state.json corrupt, `.bak` exists | Auto-loads from most recent `.bak`. |
| state.json corrupt, no `.bak` | `node scripts/ai-supervisor/install-hook.mjs --reset` (preserves approvals + review packets). |
| `.claude/settings.local.json` corrupt | Re-run `install-hook.mjs --force`. |
| OpenAI account suspended | Supervisor returns CONTINUE_CLAUDE "check OpenAI status". Loop pauses; resumes when restored. |
| Disk full | ENOSPC propagates as crash → fallback block JSON → operator clears disk → next stop fires cleanly. |
| Supervisor code edited intentionally | `node scripts/ai-supervisor/install-hook.mjs --update-pins`. |
| Code-pin mismatch (unintended edit) | Supervisor refuses to start; operator inspects the mutated file vs `state.lock`'s `code_pins_verified_at`. |

## Cost monitoring

```powershell
# Today's cost
cat .local/ai-supervisor/state.json | jq '.cost.daily | to_entries | map(select(.key == "'$(Get-Date -Format yyyy-MM-dd)'")) | .[0].value'

# All-time cost per task
cat .local/ai-supervisor/state.json | jq '.cost.tasks'
```

For authoritative OpenAI billing, see https://platform.openai.com/usage. PR2 will integrate the org-usage API for reconciliation.

## Verifying the loop is making progress

Healthy iteration depth per task: **1-3 (optimal)**, 4-6 (OK), 7+ (thrashing).
With `AI_SUPERVISOR_MAX_REPAIRS=5`, the supervisor forces QUARANTINE on the 6th
attempt — so a task that has been working for >6 cycles on the same error
signature will auto-quarantine and the loop moves on.

A healthy multi-day run shows mostly AUTO_READY verdicts with occasional
CONTINUE_CLAUDE for genuine fixes. If you see ≥3 consecutive CONTINUE_CLAUDE
on the same task with the same error signature, the dedup check will
quarantine on iteration 2 (Aura-Guard pattern).
