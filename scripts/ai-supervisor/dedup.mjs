// Input-hash deduplication. Aura-Guard pattern.
// Catches "same (task, error_signature) repeated for days" failure mode at iteration 2
// instead of day 11 ($47K postmortem).

import crypto from 'node:crypto';

const DEFAULT_WINDOW = parseInt(process.env.AI_SUPERVISOR_DEDUP_WINDOW ?? '5', 10);

/**
 * Compute the dedup hash for an iteration.
 * @param {object} input
 * @param {string} input.taskId
 * @param {string} input.errorSignature — e.g. concat of failing checks + first finding
 * @param {string} input.headSha — git HEAD SHA
 * @param {string[]} input.allowedFiles — sorted list
 * @returns {string} sha256 hex
 */
export function computeIterationHash({ taskId, errorSignature, headSha, allowedFiles }) {
  const sortedFiles = [...(allowedFiles ?? [])].sort();
  const h = crypto.createHash('sha256');
  h.update(String(taskId ?? ''));
  h.update('\0');
  h.update(String(errorSignature ?? ''));
  h.update('\0');
  h.update(String(headSha ?? ''));
  h.update('\0');
  h.update(sortedFiles.join(','));
  return h.digest('hex');
}

/**
 * Check if a new iteration hash should trigger a forced QUARANTINE.
 * Rule: if the same hash appears 2+ times in the last WINDOW iterations
 * for the same task, we're stuck. Quarantine.
 *
 * @param {object} taskState — state.tasks[taskId]
 * @param {string} newHash
 * @param {number} [windowSize]
 * @returns {{shouldQuarantine: boolean, occurrenceCount: number, reason: string|null}}
 */
export function checkDedupTrigger(taskState, newHash, windowSize = DEFAULT_WINDOW) {
  if (!taskState?.iterations) {
    return { shouldQuarantine: false, occurrenceCount: 0, reason: null };
  }
  const recent = taskState.iterations.slice(-windowSize);
  const matchCount = recent.filter(it => it.hash === newHash).length;
  // Counting `matchCount + 1` because the NEW hash will be added if we proceed
  const wouldBeCount = matchCount + 1;
  if (wouldBeCount >= 2) {
    return {
      shouldQuarantine: true,
      occurrenceCount: wouldBeCount,
      reason: `Input-hash repeated ${wouldBeCount} times within last ${windowSize} iterations. Same (task, error_signature, HEAD, allowedFiles) keeps failing — supervisor is stuck on this task. Quarantining to avoid runaway cost (Aura-Guard pattern).`,
    };
  }
  return { shouldQuarantine: false, occurrenceCount: wouldBeCount, reason: null };
}
