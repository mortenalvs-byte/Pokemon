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

  // -- Compose user content (dynamic tail; the system prompt is the cached prefix)
  const sections = [];

  sections.push(`# Review task: ${currentTask?.id ?? '(no current task)'}\n`);
  if (currentTask) {
    sections.push(`Title: ${currentTask.title ?? ''}`);
    if (currentTask.roadmap_pr_ref) sections.push(`Roadmap reference: ${currentTask.roadmap_pr_ref}`);
    if (currentTask.allowedFiles?.length) sections.push(`allowedFiles: ${currentTask.allowedFiles.join(', ')}`);
    if (currentTask.mustNotChange?.length) sections.push(`mustNotChange: ${currentTask.mustNotChange.join(', ')}`);
    if (currentTask.description) sections.push(`Description: ${currentTask.description}`);
    sections.push('');
  }

  // Git evidence
  sections.push(`## Git state`);
  sections.push(`Branch: ${gitEvidence.branch}`);
  sections.push(`HEAD: ${gitEvidence.head_sha}`);
  sections.push(`Merge-base origin/main: ${gitEvidence.merge_base}`);
  sections.push(`Ahead of origin/main: ${gitEvidence.ahead_of_main} commit(s)`);
  sections.push(`Changed files (${gitEvidence.changed_files.length}):`);
  for (const f of gitEvidence.changed_files) sections.push(`- ${f}`);
  if (gitEvidence.binary_files.length > 0) {
    sections.push(`Binary file changes (content omitted, name+size only):`);
    for (const b of gitEvidence.binary_files) sections.push(`- ${b.file} (${b.size_bytes ?? '?'} bytes)`);
  }
  sections.push('');
  sections.push(`### Diff stat`);
  sections.push('```');
  sections.push(gitEvidence.diff_stat);
  sections.push('```');
  sections.push('');

  // Diff: use the packet_diff (truncated; safety already ran against full_diff)
  // and apply file-path-aware redaction so sensitive files (.env, *.pem, backups,
  // fixtures, .local/ outside the approval/source-cache allowlist) are stripped
  // by path, not just by pattern. The full_diff stays out of the packet entirely.
  sections.push(`### Diff (sensitive files stripped, packet-truncated; safety checks ran on full diff)`);
  sections.push('```diff');
  sections.push(redactDiff(gitEvidence.packet_diff ?? gitEvidence.diff ?? ''));
  sections.push('```');
  if (gitEvidence.diff_truncated) {
    sections.push(`\n_(Diff was truncated at ${PACKET_BYTE_BUDGET} bytes — original size larger)_`);
  }
  sections.push('');

  // Verification results
  sections.push(`## Verification (run-checks output)`);
  sections.push(`Overall: ${verification.overallStatus}${verification.cached ? ' (cached, <10min old)' : ''}`);
  for (const c of verification.commands) {
    sections.push(`- **${c.name}**: ${c.status} — ${c.summary} (${c.duration_ms}ms)`);
  }
  sections.push('');

  // Scope guard
  sections.push(`## Scope guard`);
  sections.push(`Status: ${scopeGuardResult.passed ? 'PASS' : 'FAIL'}`);
  if (scopeGuardResult.violations.length > 0) {
    sections.push(`Violations:`);
    for (const v of scopeGuardResult.violations) {
      sections.push(`- ${v.gate} (${v.severity}): ${v.file} — ${v.detail}`);
    }
  }
  if (scopeGuardResult.approvalsUsed.length > 0) {
    sections.push(`Active approvals applied: ${scopeGuardResult.approvalsUsed.join(', ')}`);
  }
  sections.push('');

  // Active approvals (summary — full paths but content stripped per redact rules)
  if (activeApprovals?.length > 0) {
    sections.push(`## Active approval records`);
    for (const { file, approval } of activeApprovals) {
      sections.push(`- ${file}: approval_id=${approval.approval_id}, task_id=${approval.task_id}, expires_at=${approval.expires_at}, operator=${approval.operator}`);
      sections.push(`  Rationale: ${approval.rationale.slice(0, 200).replace(/\n/g, ' ')}`);
    }
    sections.push('');
  }

  let userContent = sections.join('\n');

  // Defense-in-depth: pattern-redact the WHOLE packet body before it leaves
  // the supervisor. `redactDiff` already path-strips sensitive files in the
  // diff section, but task descriptions, approval rationale, verification
  // summaries, and any other free-form section can still embed a leaked
  // secret. Apply layer-1 (specific secret patterns) only — NOT layer-3
  // (catch-all long-token) which would corrupt legitimate hashes/SHAs
  // already in the packet (HEAD SHA, merge-base SHA, etc.).
  userContent = scrubSecretPatterns(userContent);

  // -- Truncate if necessary
  if (userContent.length > PACKET_BYTE_BUDGET) {
    userContent = userContent.slice(0, PACKET_BYTE_BUDGET) +
      `\n\n[USER CONTENT TRUNCATED at ${PACKET_BYTE_BUDGET} bytes — full packet preserved at .local/ai-supervisor/review-packets/${runId}.md]`;
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
