// Purpose-built semantic validator for OpenAI supervisor verdicts.
//
// Schema-shape validation is done by OpenAI's strict mode (verdict.v1.json).
// This module enforces SEMANTIC rules that strict-mode can't express:
//   - AUTO_READY requires empty blocking_findings + all verification PASS
//   - SECURITY_QUARANTINE requires non-null quarantine_reason
//   - CONTINUE/SOURCE/SPLIT/REBUILD require non-empty claude_next_prompt
//   - confidence in [0, 1]
//   - model never emits supervisor-only verdicts (BUDGET_HALT, QUEUE_EXHAUSTED)
//   - verdict's verification.* claims match the supervisor's captured run-checks
//   - response isn't a refusal pattern
//   - AUTO_READY on roadmap task requires behaviour_drift_check.passed=true

const MODEL_VERDICTS = new Set([
  'CONTINUE_CLAUDE',
  'SOURCE_REQUIRED',
  'SPLIT_AUTOMATICALLY',
  'REBUILD_FROM_SCRATCH',
  'AUTO_READY',
  'QUARANTINE_AND_CONTINUE',
  'SECURITY_QUARANTINE',
]);

const SUPERVISOR_ONLY_VERDICTS = new Set([
  'BUDGET_HALT',
  'QUEUE_EXHAUSTED',
  'AUTO_MERGE_TO_INTEGRATION', // reserved for future PR; model must not emit
]);

const NON_TERMINAL_VERDICTS = new Set([
  'CONTINUE_CLAUDE',
  'SOURCE_REQUIRED',
  'SPLIT_AUTOMATICALLY',
  'REBUILD_FROM_SCRATCH',
]);

const REFUSAL_PREFIXES = [
  "i can't",
  "i cannot",
  "i'm sorry",
  "i am sorry",
  "i won't",
  "i will not",
  "sorry, i can't",
  "as an ai",
];

/**
 * Detect if a response body is a refusal pattern rather than a JSON verdict.
 */
export function isRefusalPattern(rawText) {
  if (!rawText || typeof rawText !== 'string') return false;
  const t = rawText.trim().toLowerCase();
  // Looks like JSON? not a refusal.
  if (t.startsWith('{') || t.startsWith('[')) return false;
  return REFUSAL_PREFIXES.some(p => t.startsWith(p));
}

/**
 * Validate a parsed verdict object semantically.
 *
 * @param {object} verdict — the parsed JSON verdict
 * @param {object} ctx — supervisor's captured context for cross-validation
 * @param {object} [ctx.capturedVerification] — { typecheck, test, build, audit } with status: 'PASS'|'FAIL'|'SKIP'
 * @param {boolean} [ctx.isRoadmapTask] — true if the task has roadmap_pr_ref set
 * @returns {{ok: true} | {ok: false, errors: string[]}}
 */
export function validateVerdict(verdict, ctx = {}) {
  const errors = [];

  // -- Structural pre-checks (defense in depth; strict mode should have already enforced)
  if (!verdict || typeof verdict !== 'object' || Array.isArray(verdict)) {
    return { ok: false, errors: ['verdict is not an object'] };
  }

  // -- Verdict enum
  const v = verdict.verdict;
  if (typeof v !== 'string') {
    errors.push('verdict.verdict must be a string');
  } else if (!MODEL_VERDICTS.has(v)) {
    if (SUPERVISOR_ONLY_VERDICTS.has(v)) {
      errors.push(`verdict.verdict=${v} is supervisor-only; model must not emit it`);
    } else {
      errors.push(`verdict.verdict=${v} is not a valid model verdict`);
    }
  }

  // -- confidence range
  if (typeof verdict.confidence !== 'number') {
    errors.push('verdict.confidence must be a number');
  } else if (verdict.confidence < 0 || verdict.confidence > 1) {
    errors.push(`verdict.confidence=${verdict.confidence} out of range [0,1]`);
  }

  // -- claude_next_prompt: required non-empty for non-terminal verdicts
  if (NON_TERMINAL_VERDICTS.has(v)) {
    if (typeof verdict.claude_next_prompt !== 'string' || verdict.claude_next_prompt.trim().length === 0) {
      errors.push(`${v} requires non-empty claude_next_prompt`);
    }
  }

  // -- quarantine_reason: required for QUARANTINE_AND_CONTINUE and SECURITY_QUARANTINE
  if (v === 'QUARANTINE_AND_CONTINUE' || v === 'SECURITY_QUARANTINE') {
    if (typeof verdict.quarantine_reason !== 'string' || verdict.quarantine_reason.trim().length === 0) {
      errors.push(`${v} requires non-empty quarantine_reason`);
    }
  }

  // -- AUTO_READY gating: hardest check
  if (v === 'AUTO_READY') {
    // Blocking findings must be empty
    if (Array.isArray(verdict.blocking_findings) && verdict.blocking_findings.length > 0) {
      errors.push(`AUTO_READY with ${verdict.blocking_findings.length} blocking_findings — must be 0`);
    }
    // All verification statuses claimed by the model must be PASS
    const ver = verdict.verification ?? {};
    for (const key of ['typecheck', 'test', 'build', 'audit']) {
      const s = ver[key]?.status;
      if (s !== 'PASS') {
        errors.push(`AUTO_READY but verification.${key}.status=${s} (must be PASS)`);
      }
    }
    // Scope guard must also be PASS (added per Layer 2 review finding)
    if (verdict.scope_guard?.status !== 'PASS') {
      errors.push(`AUTO_READY requires scope_guard.status=PASS, got ${verdict.scope_guard?.status}`);
    }
    // Roadmap task: behaviour_drift_check must be passed
    if (ctx.isRoadmapTask) {
      const drift = verdict.behaviour_drift_check ?? {};
      if (drift.passed !== true) {
        errors.push('AUTO_READY on roadmap task requires behaviour_drift_check.passed=true');
      }
    }
  }

  // -- SOURCE_REQUIRED: required_sources must be non-empty
  if (v === 'SOURCE_REQUIRED') {
    if (!Array.isArray(verdict.required_sources) || verdict.required_sources.length === 0) {
      errors.push('SOURCE_REQUIRED requires non-empty required_sources[] array');
    }
  }

  // -- Cross-validation of verification claims (applies to ALL verdicts, per Layer 2 review):
  // if the model claims a step PASS but supervisor captured FAIL, it's hallucinating.
  if (ctx.capturedVerification) {
    const ver = verdict.verification ?? {};
    for (const key of ['typecheck', 'test', 'build', 'audit']) {
      const claimed = ver[key]?.status;
      const captured = ctx.capturedVerification[key]?.status;
      if (captured && claimed && claimed !== captured) {
        errors.push(`verification.${key} mismatch: model=${claimed}, supervisor captured=${captured}`);
      }
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/**
 * Parse a raw OpenAI response text into a verdict, applying refusal detection first.
 *
 * @param {string} rawText
 * @param {object} [ctx]
 * @returns {{ok: true, verdict: object} | {ok: false, error: string, kind: 'refusal'|'malformed-json'|'semantic', errors?: string[]}}
 */
export function parseAndValidateVerdict(rawText, ctx = {}) {
  if (isRefusalPattern(rawText)) {
    return { ok: false, kind: 'refusal', error: 'response is a refusal pattern, not a JSON verdict' };
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (e) {
    return { ok: false, kind: 'malformed-json', error: `JSON.parse failed: ${e.message}` };
  }

  const result = validateVerdict(parsed, ctx);
  if (!result.ok) {
    return { ok: false, kind: 'semantic', error: 'semantic validation failed', errors: result.errors };
  }
  return { ok: true, verdict: parsed };
}
