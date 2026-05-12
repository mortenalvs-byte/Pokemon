// Packet builder. Assembles the OpenAI request body's user content from
// git evidence + verification results + task description + redacted file content.
//
// Byte-deterministic ordering of the CACHED PREFIX (system-prompt + Pokemon
// invariants) is critical for prompt-cache hits (90% input discount on
// gpt-5.5/5.5-pro for 24h cache window).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { redactDiff, scrubSecretPatterns } from './redact.mjs';
import { maybeStoreAsBlob } from './blob-store.mjs';

const REVIEW_PACKETS_DIR_DEFAULT = path.join(process.cwd(), '.local', 'ai-supervisor', 'review-packets');
const PACKET_BYTE_BUDGET = parseInt(process.env.AI_SUPERVISOR_PACKET_BYTE_BUDGET ?? '204800', 10);

/**
 * Build the user-content packet (dynamic, per-iteration) for an OpenAI call.
 * The SYSTEM PROMPT (cached prefix) is loaded separately by stop-review.mjs.
 *
 * @param {object} input
 * @param {object} input.gitEvidence — from collectGitEvidence()
 * @param {object} input.verification — from runChecks()
 * @param {object} input.scopeGuardResult — from runScopeGuard()
 * @param {object} input.currentTask — task being worked on
 * @param {object[]} input.activeApprovals — from loadActiveApprovals()
 * @param {string} input.runId
 * @returns {Promise<{userContent: string, packetPath: string}>}
 */
export async function buildPacket(input) {
  const { gitEvidence, verification, scopeGuardResult, currentTask, activeApprovals, runId } = input;

  // Compose userContent so CRITICAL METADATA always survives truncation.
  // Order: task header → verification → scope-guard → approvals → git state
  // → diff stat → diff body. If the total exceeds PACKET_BYTE_BUDGET, only
  // the diff body (tail) truncates — the metadata at the front stays intact.
  // Prior bug: the diff was emitted BEFORE verification, so a large diff
  // pushed verification past the truncation cliff and the reviewer
  // hallucinated FAIL/SKIP claims. Approved via quorum 2026-05-12
  // (appr-2026-05-12-build-packet-reorder-A/B).

  // -- Header block (always small + always included) -------------------
  const headerLines = [];
  headerLines.push(`# Review task: ${currentTask?.id ?? '(no current task)'}\n`);
  if (currentTask) {
    headerLines.push(`Title: ${currentTask.title ?? ''}`);
    if (currentTask.roadmap_pr_ref) headerLines.push(`Roadmap reference: ${currentTask.roadmap_pr_ref}`);
    if (currentTask.allowedFiles?.length) headerLines.push(`allowedFiles: ${currentTask.allowedFiles.join(', ')}`);
    if (currentTask.mustNotChange?.length) headerLines.push(`mustNotChange: ${currentTask.mustNotChange.join(', ')}`);
    if (currentTask.description) headerLines.push(`Description: ${currentTask.description}`);
    headerLines.push('');
  }

  // -- Verification (small, ALWAYS preserved) --------------------------
  headerLines.push(`## Verification (run-checks output) — supervisor-captured truth`);
  headerLines.push(`Overall: ${verification.overallStatus}${verification.cached ? ' (cached, <10min old)' : ''}`);
  for (const c of verification.commands) {
    headerLines.push(`- **${c.name}**: ${c.status} — ${c.summary} (${c.duration_ms}ms)`);
  }
  headerLines.push('');
  headerLines.push('IMPORTANT: the verdict\'s verification.{typecheck,test,build,audit,…} fields MUST');
  headerLines.push('match the statuses above. validate-verdict.mjs cross-checks model claims against');
  headerLines.push('this captured truth and rejects mismatched verdicts.');
  headerLines.push('');

  // -- Scope guard (small, ALWAYS preserved) ---------------------------
  headerLines.push(`## Scope guard`);
  headerLines.push(`Status: ${scopeGuardResult.passed ? 'PASS' : 'FAIL'}`);
  if (scopeGuardResult.violations.length > 0) {
    headerLines.push(`Violations:`);
    for (const v of scopeGuardResult.violations) {
      headerLines.push(`- ${v.gate} (${v.severity}): ${v.file} — ${v.detail}`);
    }
  }
  if (scopeGuardResult.approvalsUsed.length > 0) {
    headerLines.push(`Active approvals applied: ${scopeGuardResult.approvalsUsed.join(', ')}`);
  }
  headerLines.push('');

  // -- Active approval records (small, ALWAYS preserved) ---------------
  if (activeApprovals?.length > 0) {
    headerLines.push(`## Active approval records`);
    for (const { file, approval } of activeApprovals) {
      headerLines.push(`- ${file}: approval_id=${approval.approval_id}, task_id=${approval.task_id}, expires_at=${approval.expires_at}, operator=${approval.operator}`);
      headerLines.push(`  Rationale: ${approval.rationale.slice(0, 200).replace(/\n/g, ' ')}`);
    }
    headerLines.push('');
  }

  // -- Git state header (file list + stat — small) ---------------------
  headerLines.push(`## Git state`);
  headerLines.push(`Branch: ${gitEvidence.branch}`);
  headerLines.push(`HEAD: ${gitEvidence.head_sha}`);
  headerLines.push(`Merge-base origin/main: ${gitEvidence.merge_base}`);
  headerLines.push(`Ahead of origin/main: ${gitEvidence.ahead_of_main} commit(s)`);
  headerLines.push(`Changed files (${gitEvidence.changed_files.length}):`);
  for (const f of gitEvidence.changed_files) headerLines.push(`- ${f}`);
  if (gitEvidence.binary_files.length > 0) {
    headerLines.push(`Binary file changes (content omitted, name+size only):`);
    for (const b of gitEvidence.binary_files) headerLines.push(`- ${b.file} (${b.size_bytes ?? '?'} bytes)`);
  }
  headerLines.push('');
  headerLines.push(`### Diff stat`);
  headerLines.push('```');
  headerLines.push(gitEvidence.diff_stat);
  headerLines.push('```');
  headerLines.push('');

  const headerBlock = scrubSecretPatterns(headerLines.join('\n'));

  // -- Diff body (large; the part that truncates if budget exceeded) ---
  const diffHeader = `### Diff (sensitive files stripped, packet-truncated; safety checks ran on full diff)\n\`\`\`diff\n`;
  const diffFooter = '\n```\n';
  const redactedDiff = scrubSecretPatterns(redactDiff(gitEvidence.packet_diff ?? gitEvidence.diff ?? ''));

  // Compute remaining budget for the diff body so the header is never
  // dropped. Reserve 4 KB headroom for the truncation marker + footer.
  const HEADROOM = 4096;
  const budgetForDiff = Math.max(
    0,
    PACKET_BYTE_BUDGET - headerBlock.length - diffHeader.length - diffFooter.length - HEADROOM,
  );

  let diffBody = redactedDiff;
  let truncatedHere = false;
  if (diffBody.length > budgetForDiff) {
    diffBody = diffBody.slice(0, budgetForDiff) +
      `\n\n[DIFF BODY TRUNCATED at ${budgetForDiff} bytes — original size ${redactedDiff.length} bytes. ` +
      `Full diff preserved at .local/ai-supervisor/review-packets/${runId}.md (truncated here too) and at ` +
      `git diff origin/main..${gitEvidence.head_sha} on disk.]\n`;
    truncatedHere = true;
  }

  let userContent = headerBlock + diffHeader + diffBody + diffFooter;
  if (gitEvidence.diff_truncated || truncatedHere) {
    userContent += `\n_(Note: diff body was capped to fit the packet budget. Verification + scope-guard above remain authoritative.)_\n`;
  }

  // -- Persist for human review
  await mkdir(REVIEW_PACKETS_DIR_DEFAULT, { recursive: true });
  const packetPath = path.join(REVIEW_PACKETS_DIR_DEFAULT, `${runId}.md`);
  await writeFile(packetPath, userContent, 'utf8');

  // Also write the JSON form, but NEVER persist raw full_diff or unredacted
  // packet_diff/diff to disk — review-packets are local but still operator-
  // accessible and could be backed up. Replace diff fields with sha+size
  // references; the .md form (above) holds the redacted packet content.
  const jsonPath = path.join(REVIEW_PACKETS_DIR_DEFAULT, `${runId}.json`);
  const { createHash } = await import('node:crypto');
  const sha = (s) => createHash('sha256').update(String(s ?? '')).digest('hex').slice(0, 16);
  const evidenceForJson = { ...gitEvidence };
  for (const k of ['full_diff', 'packet_diff', 'diff']) {
    if (typeof evidenceForJson[k] === 'string') {
      const orig = evidenceForJson[k];
      evidenceForJson[k] = `(omitted from JSON; size=${orig.length}, sha256-prefix=${sha(orig)}) — see ${runId}.md for the redacted packet body`;
    }
  }
  await writeFile(jsonPath, JSON.stringify({
    runId,
    at: new Date().toISOString(),
    currentTask,
    gitEvidence: evidenceForJson,
    verification,
    scopeGuardResult,
  }, null, 2), 'utf8');

  return { userContent, packetPath };
}

/**
 * Load the system prompt (cached prefix). Combined with the dynamic packet,
 * the request becomes [system-prompt + dynamic-tail]. Byte-deterministic
 * by virtue of the system prompt being read-only.
 */
export async function loadSystemPrompt() {
  const promptPath = path.join(import.meta.dirname, 'templates', 'system-prompt.md');
  const raw = await readFile(promptPath, 'utf8');
  return raw.replace(/\r\n/g, '\n');
}
