// Pure-function verdict router. No I/O.
//
// Takes a validated verdict + supervisor state + queue + discovery hint,
// returns a routing decision that stop-review.mjs then applies.
//
// Routing decision shape:
//   { action: 'block' | 'allow-stop' | 'force-continue-no-output',
//     reason: string | null,
//     continueFalse: boolean,
//     sideEffects: SideEffect[] }
//
// SideEffect kinds (interpreted by stop-review.mjs):
//   - { kind: 'write-stop-sentinel' }
//   - { kind: 'write-budget-halt-report', details }
//   - { kind: 'write-queue-empty-report', details }
//   - { kind: 'write-quarantine-report', taskId, reason }
//   - { kind: 'increment-repair-count', taskId, errorSignature }
//   - { kind: 'reset-repair-count', taskId }
//   - { kind: 'dequeue-next-task' }
//   - { kind: 'append-pending-push', branch }

/**
 * Route a verdict to a hook decision.
 *
 * @param {object} input
 * @param {object} input.verdict — model-emitted verdict (already validated)
 * @param {object} input.state — current supervisor state
 * @param {object} input.queue — { schema_version, tasks: [...] }
 * @param {object|null} input.discoveryCandidate — first candidate from discover-tasks if any
 * @param {object} input.currentTask — task currently being worked on (or null)
 * @param {object} [input.options]
 * @param {boolean} [input.options.stopSentinelExists] — short-circuit
 * @param {boolean} [input.options.budgetExceeded] — short-circuit
 * @param {boolean} [input.options.dirtyWorktreeOutsideScope] — short-circuit
 * @param {boolean} [input.options.consecutiveBlocksCircuitBreaker] — supervisor wants forced QUARANTINE
 * @param {object|null} [input.options.scopeGuardFailure] — { reason, files } if scope-guard short-circuited
 * @returns {{action: string, reason: string|null, continueFalse: boolean, sideEffects: object[]}}
 */
export function routeVerdict(input) {
  const { verdict, state, queue, discoveryCandidate, currentTask, options = {} } = input;
  const sideEffects = [];

  // -- 1. Short-circuit: STOP sentinel
  if (options.stopSentinelExists) {
    return {
      action: 'allow-stop',
      reason: null,
      continueFalse: false,
      sideEffects: [{ kind: 'write-human-halt-report' }],
    };
  }

  // -- 2. Short-circuit: Budget cap exceeded (pre-call)
  if (options.budgetExceeded) {
    return {
      action: 'allow-stop',
      reason: null,
      continueFalse: false,
      sideEffects: [{ kind: 'write-budget-halt-report', details: options.budgetDetails ?? null }],
    };
  }

  // -- 3. Short-circuit: dirty worktree outside supervisor-owned set
  if (options.dirtyWorktreeOutsideScope) {
    return {
      action: 'block',
      reason: 'Supervisor recovered from crash. Uncommitted files exist outside supervisor scope. Review `git status` before continuing; commit, stash, or revert as appropriate. Do not stop until the operator (you) has reviewed.',
      continueFalse: false,
      sideEffects: [],
    };
  }

  // -- 4. Short-circuit: scope-guard failure (no OpenAI call was made)
  if (options.scopeGuardFailure) {
    const sgf = options.scopeGuardFailure;
    return {
      action: 'block',
      reason: `Scope-guard violation: ${sgf.reason}\nFiles: ${(sgf.files ?? []).join(', ')}\n\nRevert the listed files completely OR create an approval record at \`.local/ai-supervisor/approvals/<id>.md\` covering the touched paths. The supervisor reads approvals fresh on each iteration.`,
      continueFalse: false,
      sideEffects: [],
    };
  }

  // -- 5. Short-circuit: consecutive-blocks circuit breaker
  if (options.consecutiveBlocksCircuitBreaker) {
    // Force QUARANTINE_AND_CONTINUE regardless of model's verdict
    return routeQuarantineAndContinue({
      verdict: { ...verdict, quarantine_reason: 'consecutive-blocks circuit breaker fired' },
      state, queue, discoveryCandidate, currentTask, sideEffects,
    });
  }

  // -- 6. Normal verdict routing
  switch (verdict.verdict) {
    case 'CONTINUE_CLAUDE':
      return routeContinueClaude({ verdict, currentTask, sideEffects });
    case 'SOURCE_REQUIRED':
      return routeSourceRequired({ verdict, currentTask, sideEffects });
    case 'SPLIT_AUTOMATICALLY':
      return routeSplitAutomatically({ verdict, currentTask, sideEffects });
    case 'REBUILD_FROM_SCRATCH':
      return routeRebuildFromScratch({ verdict, currentTask, sideEffects });
    case 'AUTO_READY':
      return routeAutoReady({ verdict, queue, discoveryCandidate, currentTask, sideEffects });
    case 'QUARANTINE_AND_CONTINUE':
      return routeQuarantineAndContinue({ verdict, state, queue, discoveryCandidate, currentTask, sideEffects });
    case 'SECURITY_QUARANTINE':
      return routeSecurityQuarantine({ verdict, currentTask, sideEffects });
    default:
      // validate-verdict.mjs should have caught this; defensive fallback.
      return {
        action: 'block',
        reason: `Unrecognized verdict: ${verdict.verdict}. Re-emit a valid verdict (CONTINUE_CLAUDE, SOURCE_REQUIRED, SPLIT_AUTOMATICALLY, REBUILD_FROM_SCRATCH, AUTO_READY, QUARANTINE_AND_CONTINUE, SECURITY_QUARANTINE).`,
        continueFalse: false,
        sideEffects: [],
      };
  }
}

function routeContinueClaude({ verdict, currentTask, sideEffects }) {
  if (currentTask?.id && verdict.claude_next_prompt) {
    const errSig = computeErrorSignature(verdict);
    sideEffects.push({ kind: 'increment-repair-count', taskId: currentTask.id, errorSignature: errSig });
  }
  return {
    action: 'block',
    reason: verdict.claude_next_prompt ?? 'Continue work per supervisor review.',
    continueFalse: false,
    sideEffects,
  };
}

function routeSourceRequired({ verdict, currentTask, sideEffects }) {
  if (currentTask?.id) {
    sideEffects.push({ kind: 'increment-repair-count', taskId: currentTask.id, errorSignature: 'source-required' });
  }
  return {
    action: 'block',
    reason: verdict.claude_next_prompt ?? 'Fetch the required sources, cache them under .local/ai-supervisor/source-cache/, then retry.',
    continueFalse: false,
    sideEffects,
  };
}

function routeSplitAutomatically({ verdict, currentTask, sideEffects }) {
  if (currentTask?.id) {
    sideEffects.push({ kind: 'reset-repair-count', taskId: currentTask.id });
  }
  return {
    action: 'block',
    reason: verdict.claude_next_prompt ?? 'Split the current task into smaller sub-PRs per the reviewer\'s breakdown.',
    continueFalse: false,
    sideEffects,
  };
}

function routeRebuildFromScratch({ verdict, currentTask, sideEffects }) {
  if (currentTask?.id) {
    sideEffects.push({ kind: 'reset-repair-count', taskId: currentTask.id });
  }
  return {
    action: 'block',
    reason: verdict.claude_next_prompt ?? 'Rebuild this branch from origin/main following the reviewer\'s plan. Preserve the contaminated branch as forensic record.',
    continueFalse: false,
    sideEffects,
  };
}

function routeAutoReady({ verdict, queue, discoveryCandidate, currentTask, sideEffects }) {
  if (currentTask?.id) {
    sideEffects.push({ kind: 'reset-repair-count', taskId: currentTask.id });
    if (currentTask.branch_hint) {
      sideEffects.push({ kind: 'append-pending-push', branch: currentTask.branch_hint });
    }
  }

  // Pick the next task
  const nextTask = pickNextTask(queue, discoveryCandidate);
  if (nextTask) {
    sideEffects.push({ kind: 'dequeue-next-task', taskId: nextTask.id });
    return {
      action: 'block',
      reason: buildNextTaskReason(nextTask, currentTask, /* withQuarantineNote */ false),
      continueFalse: false,
      sideEffects,
    };
  }

  // Queue genuinely exhausted
  sideEffects.push({ kind: 'write-queue-empty-report', details: { reason: 'AUTO_READY but no next task' } });
  return {
    action: 'allow-stop',
    reason: null,
    continueFalse: false,
    sideEffects,
  };
}

function routeQuarantineAndContinue({ verdict, state, queue, discoveryCandidate, currentTask, sideEffects }) {
  if (currentTask?.id) {
    sideEffects.push({
      kind: 'write-quarantine-report',
      taskId: currentTask.id,
      reason: verdict.quarantine_reason ?? 'quarantined by supervisor',
    });
    sideEffects.push({ kind: 'reset-repair-count', taskId: currentTask.id });
    // Record fingerprint so discovery doesn't re-propose for 7 days
    sideEffects.push({
      kind: 'record-quarantine-fingerprint',
      kind_label: currentTask.roadmap_pr_ref ?? 'todo',
      file: currentTask.allowedFiles?.[0] ?? '',
      signature: computeTaskSignature(currentTask),
    });
  }

  const nextTask = pickNextTask(queue, discoveryCandidate);
  if (nextTask) {
    sideEffects.push({ kind: 'dequeue-next-task', taskId: nextTask.id });
    return {
      action: 'block',
      reason: buildNextTaskReason(nextTask, currentTask, /* withQuarantineNote */ true, verdict.quarantine_reason),
      continueFalse: false,
      sideEffects,
    };
  }

  sideEffects.push({ kind: 'write-queue-empty-report', details: { reason: 'quarantine-and-continue exhausted' } });
  return {
    action: 'allow-stop',
    reason: null,
    continueFalse: false,
    sideEffects,
  };
}

function routeSecurityQuarantine({ verdict, currentTask, sideEffects }) {
  sideEffects.push({ kind: 'write-stop-sentinel' });
  if (currentTask?.id) {
    sideEffects.push({
      kind: 'write-quarantine-report',
      taskId: currentTask.id,
      reason: `SECURITY: ${verdict.quarantine_reason ?? 'unspecified security concern'}`,
    });
  }
  return {
    action: 'force-continue-no-output',
    reason: verdict.quarantine_reason ?? 'security-quarantine halt',
    continueFalse: true, // {"continue": false} in stdout — ultimate STOP override
    sideEffects,
  };
}

function pickNextTask(queue, discoveryCandidate) {
  if (queue?.tasks && queue.tasks.length > 0) return queue.tasks[0];
  if (discoveryCandidate) return discoveryCandidate;
  return null;
}

function buildNextTaskReason(nextTask, currentTask, withQuarantineNote, quarantineReason = '') {
  const lines = [];
  if (withQuarantineNote) {
    lines.push(`## Previous task quarantined`);
    lines.push(`Task \`${currentTask?.id ?? 'unknown'}\` was quarantined. Reason: ${quarantineReason || 'see quarantine report'}.`);
    lines.push(`The branch \`${currentTask?.branch_hint ?? '?'}\` is left intact (not deleted). Do not resume that branch.`);
    lines.push('');
    lines.push('---');
    lines.push('');
  }
  lines.push(`## Next task: ${nextTask.id}: ${nextTask.title}`);
  lines.push('');
  if (currentTask && nextTask.branch_hint && currentTask.branch_hint !== nextTask.branch_hint) {
    lines.push('### Branch switch required');
    lines.push('1. Verify clean worktree (`git status --short`).');
    lines.push('2. Commit any work-in-progress to current branch with clear message.');
    lines.push('3. `git fetch origin main`.');
    lines.push(`4. \`git checkout -b ${nextTask.branch_hint} origin/main\` (or checkout if it already exists).`);
    lines.push('');
  }
  lines.push('### Task description');
  lines.push(nextTask.description ?? '(no description)');
  lines.push('');
  if (nextTask.acceptance?.length) {
    lines.push('### Acceptance criteria');
    for (const a of nextTask.acceptance) lines.push(`- ${a}`);
    lines.push('');
  }
  if (nextTask.mustNotChange?.length) {
    lines.push('### Constraints (mustNotChange)');
    for (const c of nextTask.mustNotChange) lines.push(`- ${c}`);
    lines.push('');
  }
  if (nextTask.allowedFiles?.length) {
    lines.push('### Allowed file scope');
    for (const f of nextTask.allowedFiles) lines.push(`- ${f}`);
    lines.push('');
  }
  lines.push('### Approach');
  lines.push('Plan step-by-step. Edit files. Verify. Continue until AUTO_READY.');
  return lines.join('\n');
}

function computeErrorSignature(verdict) {
  // Lightweight signature: concat of failing-check keys + first finding message
  const ver = verdict.verification ?? {};
  const failing = ['typecheck', 'test', 'build', 'audit']
    .filter(k => ver[k]?.status === 'FAIL')
    .join(',');
  const firstFinding = (verdict.blocking_findings ?? [])[0]?.message ?? '';
  return `${failing}|${firstFinding}`.slice(0, 200);
}

function computeTaskSignature(task) {
  return `${task.title ?? ''}|${(task.allowedFiles ?? []).join(',')}`.slice(0, 200);
}
