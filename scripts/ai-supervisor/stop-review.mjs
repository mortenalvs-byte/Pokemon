#!/usr/bin/env node
// Stop hook entry point. Orchestrates the supervisor pipeline.
//
// Reads stdin JSON from Claude Code, runs the verify→openai→route→emit cycle,
// and writes a single JSON to stdout for Claude to consume.
//
// Top-level try/catch + uncaughtException/unhandledRejection ALWAYS emit a
// valid block JSON on crash. This is the most important safety property.

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const REPO_ROOT = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const LOCAL_DIR = path.join(REPO_ROOT, '.local', 'ai-supervisor');
const STOP_SENTINEL_PATH = path.join(LOCAL_DIR, 'STOP');

// ---- Crash-safe boot ----

process.on('uncaughtException', (err) => emitFallbackBlockAndExit(`uncaughtException: ${err?.message ?? err}`, err?.stack));
process.on('unhandledRejection', (reason) => emitFallbackBlockAndExit(`unhandledRejection: ${reason?.message ?? reason}`, reason?.stack));

async function emitFallbackBlockAndExit(reason, stack = '') {
  const crashId = `crash-${Date.now()}`;
  try {
    await mkdir(LOCAL_DIR, { recursive: true });
    await writeFile(path.join(LOCAL_DIR, `${crashId}.json`),
      JSON.stringify({ at: new Date().toISOString(), reason, stack }, null, 2), 'utf8');
  } catch { /* even crash logging failed; soldier on */ }

  const out = {
    decision: 'block',
    reason: `Supervisor crashed unexpectedly. See .local/ai-supervisor/${crashId}.json. Do not stop until the operator (you) has reviewed.`,
  };
  // Flush stdout before exit (R3-2)
  await new Promise(r => process.stdout.write(JSON.stringify(out) + '\n', r));
  process.exit(0);
}

async function emitAndExit(out) {
  await new Promise(r => process.stdout.write(JSON.stringify(out) + '\n', r));
  process.exit(0);
}

// ---- Main ----

async function main() {
  // 1. Read stdin
  const stdinJson = await readStdin();
  const hookInput = stdinJson ? JSON.parse(stdinJson) : {};

  // 2. Special-case: sub-agent invocation — short-circuit
  if (hookInput.agent_id || hookInput.agent_type) {
    await mkdir(LOCAL_DIR, { recursive: true });
    await writeFile(path.join(LOCAL_DIR, 'sub-agent-skip.log'),
      `${new Date().toISOString()} skipped sub-agent ${hookInput.agent_id ?? hookInput.agent_type}\n`, 'utf8');
    return await emitAndExit({}); // allow stop
  }

  // 3. Special-case: plan mode — short-circuit
  if (hookInput.permission_mode === 'plan') {
    return await emitAndExit({}); // allow stop; plan mode is for human review
  }

  // 4. STOP sentinel — short-circuit
  if (await fileExists(STOP_SENTINEL_PATH)) {
    return await emitAndExit({});
  }

  // 5. Dynamic imports (after crash handlers are installed)
  const { collectGitEvidence } = await import('./git-evidence.mjs');
  const { runScopeGuard } = await import('./scope-guard.mjs');
  const { runChecks } = await import('./run-checks.mjs');
  const { buildPacket, loadSystemPrompt } = await import('./build-packet.mjs');
  const { callOpenAI } = await import('./openai-client.mjs');
  const { parseAndValidateVerdict } = await import('./validate-verdict.mjs');
  const { routeVerdict } = await import('./verdict-router.mjs');
  const { loadState, saveState, loadQueue, saveQueue, acquireLock, releaseLock,
          incrementRepairCount, resetRepairCount, recordIteration, addCostUsd,
          recordQuarantineFingerprint, appendPendingPush, computeHash } = await import('./state.mjs');
  const { discoverTasks } = await import('./discover-tasks.mjs');
  const { computeIterationHash, checkDedupTrigger } = await import('./dedup.mjs');
  const { loadActiveApprovals } = await import('./parse-approval.mjs');
  const { listZombieSupervisors, reapZombies } = await import('./cleanup-zombies.mjs');

  // 6. Verdict schema (read once)
  const verdictSchemaRaw = await readFile(path.join(import.meta.dirname, 'schemas', 'verdict.v1.json'), 'utf8');
  const verdictSchema = JSON.parse(verdictSchemaRaw);

  // 7. Startup validations
  // 7a. Reap zombies first
  const zombies = await listZombieSupervisors({ knownLivePids: [process.pid] });
  if (zombies.length > 0) {
    await reapZombies(zombies);
  }

  // 7b. Acquire lock
  const lock = await acquireLock(LOCAL_DIR);
  if (!lock.ok) {
    // Another supervisor is running; exit silently
    return await emitAndExit({});
  }

  // Ensure lock released on any exit path
  let releaseLockCalled = false;
  const release = async () => {
    if (releaseLockCalled) return;
    releaseLockCalled = true;
    try { await releaseLock(LOCAL_DIR); } catch {}
  };
  process.on('SIGTERM', () => { release().finally(() => process.exit(0)); });
  process.on('SIGINT',  () => { release().finally(() => process.exit(0)); });

  try {
    // 7c. Git evidence (includes main-branch + detached + rebase refusals)
    const gitResult = await collectGitEvidence({ cwd: REPO_ROOT });
    if (!gitResult.ok) {
      return await emitAndExit({
        decision: 'block',
        reason: `Git pre-check failed: ${gitResult.gate.reason} — ${gitResult.gate.detail}`,
      });
    }

    // 8. Load state + queue
    const state = await loadState(LOCAL_DIR);
    const queue = await loadQueue(LOCAL_DIR);
    const currentTask = queue.tasks?.[0] ?? null;

    // 9. Run scope-guard
    const scopeGuardResult = await runScopeGuard({
      changedFiles: gitResult.evidence.changed_files,
      fullDiff: gitResult.evidence.diff,
      currentTask,
      approvalsDir: path.join(LOCAL_DIR, 'approvals'),
    });

    if (!scopeGuardResult.passed) {
      // Block immediately; no OpenAI call
      const reason = `Scope-guard violation(s):\n${scopeGuardResult.violations.map(v => `- ${v.gate} (${v.severity}): ${v.file} — ${v.detail}`).join('\n')}\n\nRevert the listed files OR create an approval record at .local/ai-supervisor/approvals/<id>.md covering them.`;
      return await emitAndExit({ decision: 'block', reason });
    }

    // 10. Run verification
    const dirtyDiffHash = computeHash([gitResult.evidence.diff]);
    const verification = await runChecks({
      headSha: gitResult.evidence.head_sha,
      dirtyDiffHash,
      taskId: currentTask?.id ?? null,
      changedFiles: gitResult.evidence.changed_files,
      cwd: REPO_ROOT,
    });

    // 11. Dedup check
    if (currentTask?.id) {
      const errorSig = verification.commands.filter(c => c.status === 'FAIL').map(c => c.name).sort().join(',');
      const iterHash = computeIterationHash({
        taskId: currentTask.id,
        errorSignature: errorSig,
        headSha: gitResult.evidence.head_sha,
        allowedFiles: currentTask.allowedFiles ?? [],
      });
      const taskState = state.tasks?.[currentTask.id];
      const dedupCheck = checkDedupTrigger(taskState, iterHash);
      if (dedupCheck.shouldQuarantine) {
        const newState = recordQuarantineFingerprint(
          recordIteration(state, currentTask.id, iterHash, 'QUARANTINE_AND_CONTINUE'),
          { kind: 'dedup-trigger', file: currentTask.allowedFiles?.[0] ?? '', signature: errorSig }
        );
        await saveState(newState, LOCAL_DIR);
        return await emitAndExit({
          decision: 'block',
          reason: `${dedupCheck.reason}\n\nPicking next task from queue...`,
        });
      }
    }

    // 12. Build packet + call OpenAI
    const activeApprovals = (await loadActiveApprovals(path.join(LOCAL_DIR, 'approvals'))).active;
    const runId = `run-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const { userContent } = await buildPacket({
      gitEvidence: gitResult.evidence,
      verification,
      scopeGuardResult,
      currentTask,
      activeApprovals,
      runId,
    });
    const systemPrompt = await loadSystemPrompt();

    const dailyCapUsd = parseFloat(process.env.OPENAI_DAILY_USD_CAP ?? '500');
    const perTaskCapUsd = parseFloat(process.env.OPENAI_PER_TASK_USD_CAP ?? '50');
    const today = new Date().toISOString().slice(0, 10);
    const dailyUsedUsd = state.cost?.daily?.[today]?.total_usd ?? 0;
    const perTaskUsedUsd = currentTask?.id ? (state.cost?.tasks?.[currentTask.id]?.total_usd ?? 0) : 0;

    const openaiResult = await callOpenAI({
      systemPrompt,
      userContent,
      verdictSchema,
      options: {
        costContext: { dailyCapUsd, dailyUsedUsd, perTaskCapUsd, perTaskUsedUsd },
      },
    });

    // 13. Handle synthetic verdicts (BUDGET_HALT)
    if (!openaiResult.ok && openaiResult.syntheticVerdict) {
      await mkdir(LOCAL_DIR, { recursive: true });
      await writeFile(path.join(LOCAL_DIR, 'reports', `budget-halt-${Date.now()}.json`), JSON.stringify(openaiResult, null, 2), 'utf8').catch(async () => {
        // reports/ may not exist yet
        await mkdir(path.join(LOCAL_DIR, 'reports'), { recursive: true });
        await writeFile(path.join(LOCAL_DIR, 'reports', `budget-halt-${Date.now()}.json`), JSON.stringify(openaiResult, null, 2), 'utf8');
      });
      return await emitAndExit({}); // allow stop
    }

    if (!openaiResult.ok) {
      // Network/timeout/HTTP error — block with details
      return await emitAndExit({
        decision: 'block',
        reason: `OpenAI call failed: ${openaiResult.kind} — ${openaiResult.error}\n\nThis is likely transient. The supervisor will retry on the next Stop fire. If it persists, check OpenAI status + your API key + network.`,
      });
    }

    // 14. Parse + validate verdict
    const capturedVerification = Object.fromEntries(
      verification.commands.map(c => [c.name, { status: c.status, summary: c.summary }])
    );
    const validated = parseAndValidateVerdict(openaiResult.verdictText, {
      capturedVerification,
      isRoadmapTask: !!currentTask?.roadmap_pr_ref,
    });

    if (!validated.ok) {
      return await emitAndExit({
        decision: 'block',
        reason: `Verdict validation failed (${validated.kind}): ${validated.error}\n${validated.errors?.map(e => `- ${e}`).join('\n') ?? ''}\n\nSupervisor will retry next Stop with feedback.`,
      });
    }

    // 15. Update state: cost, iteration
    let newState = addCostUsd(state, currentTask?.id, openaiResult.costSplit);
    if (currentTask?.id) {
      const iterHash = computeIterationHash({
        taskId: currentTask.id,
        errorSignature: 'verdict-' + validated.verdict.verdict,
        headSha: gitResult.evidence.head_sha,
        allowedFiles: currentTask.allowedFiles ?? [],
      });
      newState = recordIteration(newState, currentTask.id, iterHash, validated.verdict.verdict);
    }

    // 16. Route verdict
    const discoveryCandidate = (queue.tasks?.length ?? 0) === 0 && validated.verdict.verdict === 'AUTO_READY'
      ? (await discoverTasks({ cwd: REPO_ROOT, state: newState })).candidates?.[0] ?? null
      : null;

    const routing = routeVerdict({
      verdict: validated.verdict,
      state: newState,
      queue,
      currentTask,
      discoveryCandidate,
      options: { stopSentinelExists: false },
    });

    // 17. Apply side-effects
    let modifiedState = newState;
    let modifiedQueue = queue;
    for (const eff of routing.sideEffects) {
      switch (eff.kind) {
        case 'increment-repair-count':
          modifiedState = incrementRepairCount(modifiedState, eff.taskId, eff.errorSignature);
          break;
        case 'reset-repair-count':
          modifiedState = resetRepairCount(modifiedState, eff.taskId);
          break;
        case 'record-quarantine-fingerprint':
          modifiedState = recordQuarantineFingerprint(modifiedState, {
            kind: eff.kind_label, file: eff.file, signature: eff.signature,
          });
          break;
        case 'append-pending-push':
          modifiedState = appendPendingPush(modifiedState, eff.branch);
          break;
        case 'dequeue-next-task':
          modifiedQueue = { ...modifiedQueue, tasks: modifiedQueue.tasks.slice(1) };
          break;
        case 'write-stop-sentinel':
          await writeFile(STOP_SENTINEL_PATH, `Security quarantine: ${validated.verdict.quarantine_reason ?? ''}\nAt: ${new Date().toISOString()}\n`, 'utf8');
          break;
        case 'write-quarantine-report':
        case 'write-budget-halt-report':
        case 'write-queue-empty-report':
        case 'write-human-halt-report': {
          const reportDir = path.join(LOCAL_DIR, eff.kind === 'write-quarantine-report' ? 'quarantine' : 'reports');
          await mkdir(reportDir, { recursive: true });
          const fname = eff.taskId ? `${eff.taskId}.md` : `${eff.kind}-${Date.now()}.md`;
          await writeFile(path.join(reportDir, fname), JSON.stringify(eff, null, 2), 'utf8');
          break;
        }
      }
    }
    await saveState(modifiedState, LOCAL_DIR);
    await saveQueue(modifiedQueue, LOCAL_DIR);

    // 18. Emit hook output
    if (routing.action === 'block') {
      return await emitAndExit({ decision: 'block', reason: routing.reason });
    }
    if (routing.action === 'force-continue-no-output') {
      return await emitAndExit({ continue: false, reason: routing.reason });
    }
    // allow-stop
    return await emitAndExit({});
  } finally {
    await release();
  }
}

// ---- Helpers ----

async function readStdin() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) buf += chunk;
  return buf.trim() ? buf : null;
}

async function fileExists(p) {
  try { await stat(p); return true; } catch { return false; }
}

main().catch(err => emitFallbackBlockAndExit(`main: ${err?.message ?? err}`, err?.stack));
