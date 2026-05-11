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

  // Best-effort lock release on crash (the main flow may have acquired it).
  try {
    const { releaseLock } = await import('./state.mjs');
    await releaseLock(LOCAL_DIR);
  } catch { /* nothing to release or unreachable; ignore */ }

  const out = {
    decision: 'block',
    reason: `Supervisor crashed unexpectedly. See .local/ai-supervisor/${crashId}.json. Do not stop until the operator (you) has reviewed.`,
  };
  // Flush stdout before exit (R3-2)
  await new Promise(r => process.stdout.write(JSON.stringify(out) + '\n', r));
  process.exit(0);
}

async function writeOutput(out) {
  await new Promise(r => process.stdout.write(JSON.stringify(out) + '\n', r));
}

// ---- Main ----

async function main() {
  // 1. Read stdin
  const stdinJson = await readStdin();
  const hookInput = stdinJson ? JSON.parse(stdinJson) : {};

  // 2. Special-case: sub-agent invocation — short-circuit (no lock held)
  if (hookInput.agent_id || hookInput.agent_type) {
    await mkdir(LOCAL_DIR, { recursive: true });
    await writeFile(path.join(LOCAL_DIR, 'sub-agent-skip.log'),
      `${new Date().toISOString()} skipped sub-agent ${hookInput.agent_id ?? hookInput.agent_type}\n`, 'utf8');
    await writeOutput({});
    process.exit(0);
  }

  // 3. Special-case: plan mode — short-circuit (no lock held)
  if (hookInput.permission_mode === 'plan') {
    await writeOutput({});
    process.exit(0);
  }

  // 4. STOP sentinel — short-circuit (no lock held)
  if (await fileExists(STOP_SENTINEL_PATH)) {
    await writeOutput({});
    process.exit(0);
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

  // 7-pin. Verify supervisor module SHAs against pinned values. Tamper
  //        detection: if anyone (or Claude) modified a pinned module
  //        without running `install-hook.mjs --update-pins`, we refuse to
  //        start so an unreviewed change can't take effect silently.
  const pinCheck = await verifyCodePins();
  if (!pinCheck.ok) {
    await writeOutput({
      decision: 'block',
      reason:
        `Supervisor refuses to start: code-pin mismatch on ${pinCheck.mismatched.length} module(s).\n` +
        pinCheck.mismatched.map(m => `- ${m.file}: pinned ${m.pinned} actual ${m.actual}`).join('\n') +
        `\n\nIf the supervisor code was intentionally updated, run:\n  node scripts/ai-supervisor/install-hook.mjs --update-pins\n` +
        `If this is unexpected, investigate the unreviewed change before continuing.`,
    });
    process.exit(0);
  }

  // 7a. Identify any sibling supervisor that holds state.lock BEFORE reaping
  //     zombies — otherwise zombie-cleanup may kill the legitimate lock holder.
  let lockHolderPid = null;
  try {
    const lockContent = await readFile(path.join(LOCAL_DIR, 'state.lock'), 'utf8');
    const existing = JSON.parse(lockContent);
    if (typeof existing.pid === 'number') lockHolderPid = existing.pid;
  } catch { /* no lock or unreadable; that's fine — cleanup spares only self */ }

  // 7b. Reap zombies, sparing both our own PID and the live lock holder.
  const knownLive = [process.pid];
  if (lockHolderPid && lockHolderPid !== process.pid) knownLive.push(lockHolderPid);
  const zombies = await listZombieSupervisors({ knownLivePids: knownLive });
  if (zombies.length > 0) {
    await reapZombies(zombies);
  }

  // 7c. Acquire lock
  const lock = await acquireLock(LOCAL_DIR);
  if (!lock.ok) {
    // Another supervisor is running; exit silently (no lock held by us to release)
    await writeOutput({});
    process.exit(0);
  }

  // Ensure lock released on any exit path. Lock release happens BEFORE
  // process.exit, never after — process.exit doesn't wait for async finally.
  let releaseLockCalled = false;
  const release = async () => {
    if (releaseLockCalled) return;
    releaseLockCalled = true;
    try { await releaseLock(LOCAL_DIR); } catch {}
  };
  process.on('SIGTERM', () => { release().finally(() => process.exit(0)); });
  process.on('SIGINT',  () => { release().finally(() => process.exit(0)); });

  // Output accumulator — set inside the try block and emitted after `finally`
  // has released the lock. Defaults to a defensive block so a non-returning
  // pipeline doesn't accidentally allow-stop.
  let output = { decision: 'block', reason: 'Supervisor pipeline did not reach a verdict.' };

  try {
    // 7d. Git evidence (includes main-branch + detached + rebase refusals)
    const gitResult = await collectGitEvidence({ cwd: REPO_ROOT });
    if (!gitResult.ok) {
      output = {
        decision: 'block',
        reason: `Git pre-check failed: ${gitResult.gate.reason} — ${gitResult.gate.detail}`,
      };
      return;
    }

    // 8. Load state + queue
    const state = await loadState(LOCAL_DIR);
    const queue = await loadQueue(LOCAL_DIR);
    const currentTask = queue.tasks?.[0] ?? null;

    // 9. Run scope-guard against the FULL composite diff (committed + staged +
    //    unstaged + untracked), not the packet-truncated one. Safety must not
    //    rely on what fits in OpenAI's packet budget.
    const scopeGuardResult = await runScopeGuard({
      changedFiles: gitResult.evidence.changed_files,
      fullDiff: gitResult.evidence.full_diff ?? gitResult.evidence.diff,
      currentTask,
      approvalsDir: path.join(LOCAL_DIR, 'approvals'),
    });

    if (!scopeGuardResult.passed) {
      // Block immediately; no OpenAI call
      output = {
        decision: 'block',
        reason: `Scope-guard violation(s):\n${scopeGuardResult.violations.map(v => `- ${v.gate} (${v.severity}): ${v.file} — ${v.detail}`).join('\n')}\n\nRevert the listed files OR create an approval record at .local/ai-supervisor/approvals/<id>.md covering them.`,
      };
      return;
    }

    // 10. Run verification
    const dirtyDiffHash = computeHash([gitResult.evidence.full_diff ?? gitResult.evidence.diff]);
    const verification = await runChecks({
      headSha: gitResult.evidence.head_sha,
      dirtyDiffHash,
      taskId: currentTask?.id ?? null,
      changedFiles: gitResult.evidence.changed_files,
      cwd: REPO_ROOT,
    });

    // 11. Dedup check — same (task_id, error_signature, head_sha) hash twice
    //     in a 5-iteration window forces QUARANTINE_AND_CONTINUE without
    //     calling OpenAI. Route through verdict-router so the same dequeue +
    //     next-task prompt rendering applies as for a model-emitted
    //     QUARANTINE_AND_CONTINUE — the operator (and Claude) gets a real
    //     actionable next-task block, not a dangling "Picking next task..." text.
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
        let qState = recordQuarantineFingerprint(
          recordIteration(state, currentTask.id, iterHash, 'QUARANTINE_AND_CONTINUE'),
          { kind: 'dedup-trigger', file: currentTask.allowedFiles?.[0] ?? '', signature: errorSig }
        );
        // Synthesize a quarantine verdict and route it normally.
        const synthVerdict = {
          schema_version: 1,
          verdict: 'QUARANTINE_AND_CONTINUE',
          risk_level: 'MEDIUM',
          confidence: 1.0,
          claude_next_prompt: null,
          quarantine_reason: dedupCheck.reason,
          summary: `Dedup-trigger quarantine: ${dedupCheck.reason}`,
          verification: Object.fromEntries(verification.commands.map(c => [c.name, { status: c.status, summary: c.summary }])),
          scope_guard: { status: 'PASS', violations: [], approval_used: null },
          required_sources: [],
          blocking_findings: [],
          allowed_next_actions: [],
          forbidden_next_actions: [],
          behaviour_drift_check: { passed: true, notes: 'n/a — dedup-trigger quarantine' },
        };
        const routing = routeVerdict({
          verdict: synthVerdict,
          state: qState,
          queue,
          currentTask,
          discoveryCandidate: null,
          options: {},
        });
        // Apply dequeue + report side effects from the router
        let qQueue = queue;
        for (const eff of routing.sideEffects) {
          if (eff.kind === 'dequeue-next-task') {
            qQueue = { ...qQueue, tasks: qQueue.tasks.slice(1) };
          } else if (eff.kind === 'write-quarantine-report') {
            const qDir = path.join(LOCAL_DIR, 'quarantine');
            await mkdir(qDir, { recursive: true });
            const fname = eff.taskId ? `${eff.taskId}.md` : `dedup-${Date.now()}.md`;
            await writeFile(path.join(qDir, fname), JSON.stringify(eff, null, 2), 'utf8');
          }
        }
        await saveState(qState, LOCAL_DIR);
        await saveQueue(qQueue, LOCAL_DIR);
        output = routing.action === 'block'
          ? { decision: 'block', reason: routing.reason }
          : {};
        return;
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

    // 13. Handle synthetic verdicts (BUDGET_HALT terminal, QUARANTINE_AND_CONTINUE
    //     per-task-cap). Both arrive as `{ ok:false, syntheticVerdict }` — but
    //     BUDGET_HALT ends the loop while per-task-cap quarantines this task
    //     and lets the next one continue via the normal verdict-router.
    if (!openaiResult.ok && openaiResult.syntheticVerdict) {
      const sv = openaiResult.syntheticVerdict;
      const reportsDir = path.join(LOCAL_DIR, 'reports');
      await mkdir(reportsDir, { recursive: true });
      if (sv.verdict === 'BUDGET_HALT') {
        await writeFile(path.join(reportsDir, `budget-halt-${Date.now()}.json`), JSON.stringify(openaiResult, null, 2), 'utf8');
        output = {}; // allow stop
        return;
      }
      if (sv.verdict === 'QUARANTINE_AND_CONTINUE') {
        // Fall through to the verdict-router path with this synthesized verdict
        // so dequeue + next-task prompting works uniformly with model-emitted quarantines.
        await writeFile(path.join(reportsDir, `per-task-cap-quarantine-${Date.now()}.json`), JSON.stringify(openaiResult, null, 2), 'utf8');
        const routing = routeVerdict({
          verdict: sv,
          state,
          queue,
          currentTask,
          discoveryCandidate: null,
          options: {},
        });
        // Apply quarantine + dequeue side effects, then emit the router's decision.
        let qState = state;
        let qQueue = queue;
        for (const eff of routing.sideEffects) {
          if (eff.kind === 'record-quarantine-fingerprint') {
            qState = recordQuarantineFingerprint(qState, { kind: 'per-task-cost-cap', file: currentTask?.allowedFiles?.[0] ?? '', signature: 'per-task-cap' });
          } else if (eff.kind === 'dequeue-next-task') {
            qQueue = { ...qQueue, tasks: qQueue.tasks.slice(1) };
          } else if (eff.kind === 'write-quarantine-report') {
            const qDir = path.join(LOCAL_DIR, 'quarantine');
            await mkdir(qDir, { recursive: true });
            const fname = eff.taskId ? `${eff.taskId}.md` : `per-task-cap-${Date.now()}.md`;
            await writeFile(path.join(qDir, fname), JSON.stringify(eff, null, 2), 'utf8');
          }
        }
        await saveState(qState, LOCAL_DIR);
        await saveQueue(qQueue, LOCAL_DIR);
        output = routing.action === 'block'
          ? { decision: 'block', reason: routing.reason }
          : {};
        return;
      }
      // Other synthetic verdicts fall through to default block below
    }

    if (!openaiResult.ok) {
      // Network/timeout/HTTP error — block with details
      output = {
        decision: 'block',
        reason: `OpenAI call failed: ${openaiResult.kind} — ${openaiResult.error}\n\nThis is likely transient. The supervisor will retry on the next Stop fire. If it persists, check OpenAI status + your API key + network.`,
      };
      return;
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
      output = {
        decision: 'block',
        reason: `Verdict validation failed (${validated.kind}): ${validated.error}\n${validated.errors?.map(e => `- ${e}`).join('\n') ?? ''}\n\nSupervisor will retry next Stop with feedback.`,
      };
      return;
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

    // 18. Compute hook output (emitted after `finally` releases the lock)
    if (routing.action === 'block') {
      output = { decision: 'block', reason: routing.reason };
    } else if (routing.action === 'force-continue-no-output') {
      output = { continue: false, reason: routing.reason };
    } else {
      // allow-stop
      output = {};
    }
  } finally {
    await release();
  }
  // Lock is released; safe to emit and exit
  await writeOutput(output);
  process.exit(0);
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

/**
 * Verify pinned supervisor modules match their committed SHA. Returns:
 * - { ok: true } when pin file is absent (first install, no pins recorded yet)
 *   OR when every pinned module hashes to its expected value.
 * - { ok: false, mismatched: [{file, pinned, actual}] } on any drift.
 *
 * Intentionally tolerant of missing pin file so the supervisor still works
 * on a fresh install before the operator runs `install-hook.mjs`.
 */
async function verifyCodePins() {
  const pinsPath = path.join(LOCAL_DIR, 'code-pins.json');
  let pinsContent;
  try {
    pinsContent = await readFile(pinsPath, 'utf8');
  } catch { return { ok: true }; }  // no pins yet — first run

  let pinsDoc;
  try { pinsDoc = JSON.parse(pinsContent); } catch {
    return { ok: false, mismatched: [{ file: 'code-pins.json', pinned: 'valid JSON', actual: 'corrupt' }] };
  }
  const expected = pinsDoc?.pins ?? {};
  if (typeof expected !== 'object' || expected === null) return { ok: true };

  const { createHash } = await import('node:crypto');
  const supervisorDir = path.dirname(import.meta.dirname ? import.meta.dirname : '');
  const modulesDir = import.meta.dirname;
  const mismatched = [];
  for (const [file, pinned] of Object.entries(expected)) {
    try {
      const content = await readFile(path.join(modulesDir, file), 'utf8');
      const actual = 'sha256:' + createHash('sha256').update(content).digest('hex');
      if (actual !== pinned) {
        mismatched.push({ file, pinned: pinned.slice(0, 18) + '...', actual: actual.slice(0, 18) + '...' });
      }
    } catch (err) {
      mismatched.push({ file, pinned: pinned.slice(0, 18) + '...', actual: `unreadable (${err.code ?? err.message})` });
    }
  }
  return mismatched.length === 0 ? { ok: true } : { ok: false, mismatched };
}

main().catch(err => emitFallbackBlockAndExit(`main: ${err?.message ?? err}`, err?.stack));
