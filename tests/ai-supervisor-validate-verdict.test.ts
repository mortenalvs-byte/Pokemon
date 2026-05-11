// @ts-ignore — supervisor .mjs imports
import { describe, expect, it } from 'vitest';

// @ts-ignore
import { validateVerdict, isRefusalPattern, parseAndValidateVerdict } from '../scripts/ai-supervisor/validate-verdict.mjs';

const VERIFICATION_ALL_PASS = {
  typecheck:           { status: 'PASS', summary: 'ok' },
  test:                { status: 'PASS', summary: '1296 tests' },
  build:               { status: 'PASS', summary: 'built' },
  audit:               { status: 'PASS', summary: 'clean' },
  qa_browser:          { status: 'SKIP', summary: 'n/a' },
  banned_strings_dist: { status: 'PASS', summary: '0 hits' },
  backup_tests:        { status: 'SKIP', summary: 'n/a' },
  binder_tests:        { status: 'SKIP', summary: 'n/a' },
};

function baseVerdict(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    verdict: 'AUTO_READY',
    risk_level: 'LOW',
    confidence: 0.9,
    claude_next_prompt: null,
    quarantine_reason: null,
    summary: 'all green',
    verification: VERIFICATION_ALL_PASS,
    scope_guard: { status: 'PASS', violations: [], approval_used: null },
    required_sources: [],
    blocking_findings: [],
    allowed_next_actions: [],
    forbidden_next_actions: [],
    behaviour_drift_check: { passed: true, notes: '' },
    ...overrides,
  };
}

describe('isRefusalPattern', () => {
  it.each([
    "I can't help with that",
    "I'm sorry, I cannot",
    "I cannot proceed",
    "As an AI assistant",
    "Sorry, I can't",
  ])('detects refusal: %s', (text) => {
    expect(isRefusalPattern(text)).toBe(true);
  });

  it('does not flag JSON starts', () => {
    expect(isRefusalPattern('{"verdict": "AUTO_READY"}')).toBe(false);
    expect(isRefusalPattern('[1,2,3]')).toBe(false);
  });
});

describe('validateVerdict — happy paths', () => {
  it('accepts a clean AUTO_READY', () => {
    expect(validateVerdict(baseVerdict()).ok).toBe(true);
  });

  it('accepts CONTINUE_CLAUDE with non-empty prompt', () => {
    expect(validateVerdict(baseVerdict({
      verdict: 'CONTINUE_CLAUDE',
      claude_next_prompt: 'fix the failing test',
      verification: { ...VERIFICATION_ALL_PASS, test: { status: 'FAIL', summary: 'oops' } },
    })).ok).toBe(true);
  });
});

describe('validateVerdict — AUTO_READY gating', () => {
  it('rejects AUTO_READY with blocking_findings', () => {
    const r = validateVerdict(baseVerdict({
      blocking_findings: [{ category: 'TEST', severity: 'HIGH', file_path: null, line_hint: null, message: 'x' }],
    }));
    expect(r.ok).toBe(false);
    expect((r as any).errors[0]).toContain('blocking_findings');
  });

  it('rejects AUTO_READY when a verification step is FAIL', () => {
    const r = validateVerdict(baseVerdict({
      verification: { ...VERIFICATION_ALL_PASS, build: { status: 'FAIL', summary: 'oh no' } },
    }));
    expect(r.ok).toBe(false);
    expect((r as any).errors.join('\n')).toContain('build');
  });

  it('rejects AUTO_READY when scope_guard FAILs', () => {
    const r = validateVerdict(baseVerdict({
      scope_guard: { status: 'FAIL', violations: [], approval_used: null },
    }));
    expect(r.ok).toBe(false);
    expect((r as any).errors.join('\n')).toContain('scope_guard.status=PASS');
  });

  it('rejects AUTO_READY on roadmap task with behaviour_drift_check.passed=false', () => {
    const r = validateVerdict(
      baseVerdict({ behaviour_drift_check: { passed: false, notes: 'changed selectors' } }),
      { isRoadmapTask: true },
    );
    expect(r.ok).toBe(false);
    expect((r as any).errors.join('\n')).toContain('behaviour_drift_check.passed=true');
  });
});

describe('validateVerdict — semantic rules', () => {
  it('rejects supervisor-only verdicts emitted by model', () => {
    for (const v of ['BUDGET_HALT', 'QUEUE_EXHAUSTED', 'AUTO_MERGE_TO_INTEGRATION']) {
      const r = validateVerdict(baseVerdict({ verdict: v }));
      expect(r.ok).toBe(false);
      expect((r as any).errors.join('\n')).toContain('supervisor-only');
    }
  });

  it('rejects unknown verdict enum value', () => {
    const r = validateVerdict(baseVerdict({ verdict: 'MAGIC_FIX' }));
    expect(r.ok).toBe(false);
  });

  it('requires non-empty claude_next_prompt for CONTINUE_CLAUDE', () => {
    const r = validateVerdict(baseVerdict({
      verdict: 'CONTINUE_CLAUDE',
      claude_next_prompt: '',
      verification: { ...VERIFICATION_ALL_PASS, test: { status: 'FAIL', summary: 'x' } },
    }));
    expect(r.ok).toBe(false);
    expect((r as any).errors.join('\n')).toContain('claude_next_prompt');
  });

  it('requires non-empty quarantine_reason for SECURITY_QUARANTINE', () => {
    const r = validateVerdict(baseVerdict({
      verdict: 'SECURITY_QUARANTINE',
      quarantine_reason: null,
    }));
    expect(r.ok).toBe(false);
    expect((r as any).errors.join('\n')).toContain('quarantine_reason');
  });

  it('requires non-empty required_sources for SOURCE_REQUIRED', () => {
    const r = validateVerdict(baseVerdict({
      verdict: 'SOURCE_REQUIRED',
      claude_next_prompt: 'fetch the docs',
      required_sources: [],
    }));
    expect(r.ok).toBe(false);
    expect((r as any).errors.join('\n')).toContain('required_sources');
  });

  it('rejects confidence outside [0,1]', () => {
    expect(validateVerdict(baseVerdict({ confidence: 1.5 })).ok).toBe(false);
    expect(validateVerdict(baseVerdict({ confidence: -0.1 })).ok).toBe(false);
  });

  it('cross-validates verification against captured truth', () => {
    const r = validateVerdict(
      baseVerdict({ verdict: 'CONTINUE_CLAUDE', claude_next_prompt: 'fix it' }),
      { capturedVerification: { typecheck: { status: 'FAIL' } } },
    );
    expect(r.ok).toBe(false);
    expect((r as any).errors.join('\n')).toContain('verification.typecheck mismatch');
  });
});

describe('parseAndValidateVerdict', () => {
  it('rejects refusal patterns', () => {
    const r = parseAndValidateVerdict("I'm sorry but I can't review that.", {});
    expect(r.ok).toBe(false);
    expect((r as any).kind).toBe('refusal');
  });

  it('rejects malformed JSON', () => {
    const r = parseAndValidateVerdict('{not json', {});
    expect(r.ok).toBe(false);
    expect((r as any).kind).toBe('malformed-json');
  });

  it('accepts a well-formed AUTO_READY string', () => {
    const r = parseAndValidateVerdict(JSON.stringify(baseVerdict()), {});
    expect(r.ok).toBe(true);
  });
});
