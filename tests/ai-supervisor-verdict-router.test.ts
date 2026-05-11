// @ts-ignore — supervisor .mjs imports
import { describe, expect, it } from 'vitest';

// @ts-ignore
import { routeVerdict } from '../scripts/ai-supervisor/verdict-router.mjs';

const VERIFICATION_PASS = {
  typecheck: { status: 'PASS', summary: '' },
  test:      { status: 'PASS', summary: '' },
  build:     { status: 'PASS', summary: '' },
  audit:     { status: 'PASS', summary: '' },
};

function vert(verdict: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    verdict,
    risk_level: 'LOW',
    confidence: 0.9,
    claude_next_prompt: null,
    quarantine_reason: null,
    summary: '',
    verification: VERIFICATION_PASS,
    scope_guard: { status: 'PASS', violations: [], approval_used: null },
    required_sources: [],
    blocking_findings: [],
    allowed_next_actions: [],
    forbidden_next_actions: [],
    behaviour_drift_check: { passed: true, notes: '' },
    ...overrides,
  };
}

const emptyState = { tasks: {}, cost: { daily: {}, tasks: {} }, quarantine_fingerprints: [] };
const emptyQueue = { schema_version: 'ai_supervisor_queue_v1', tasks: [] };

describe('verdict-router — short circuits', () => {
  it('STOP sentinel exists → allow-stop with human-halt report', () => {
    const r = routeVerdict({
      verdict: vert('CONTINUE_CLAUDE'),
      state: emptyState, queue: emptyQueue, currentTask: null, discoveryCandidate: null,
      options: { stopSentinelExists: true },
    });
    expect(r.action).toBe('allow-stop');
    expect(r.sideEffects).toEqual([{ kind: 'write-human-halt-report' }]);
  });

  it('budget exceeded → allow-stop with budget-halt report', () => {
    const r = routeVerdict({
      verdict: vert('CONTINUE_CLAUDE'),
      state: emptyState, queue: emptyQueue, currentTask: null, discoveryCandidate: null,
      options: { budgetExceeded: true, budgetDetails: { used: 510, cap: 500 } },
    });
    expect(r.action).toBe('allow-stop');
    expect(r.sideEffects[0].kind).toBe('write-budget-halt-report');
  });

  it('dirty worktree → block with recovery note', () => {
    const r = routeVerdict({
      verdict: vert('CONTINUE_CLAUDE'),
      state: emptyState, queue: emptyQueue, currentTask: null, discoveryCandidate: null,
      options: { dirtyWorktreeOutsideScope: true },
    });
    expect(r.action).toBe('block');
    expect(r.reason).toContain('Supervisor recovered from crash');
  });

  it('scope-guard failure → block without OpenAI call', () => {
    const r = routeVerdict({
      verdict: vert('CONTINUE_CLAUDE'),
      state: emptyState, queue: emptyQueue, currentTask: null, discoveryCandidate: null,
      options: { scopeGuardFailure: { reason: 'gate X', files: ['src/db/schema.ts'] } },
    });
    expect(r.action).toBe('block');
    expect(r.reason).toContain('Scope-guard violation');
  });
});

describe('verdict-router — model verdicts', () => {
  it('CONTINUE_CLAUDE → block + increment repair count', () => {
    const r = routeVerdict({
      verdict: vert('CONTINUE_CLAUDE', { claude_next_prompt: 'fix it' }),
      state: emptyState, queue: emptyQueue,
      currentTask: { id: 'task-1', branch_hint: 'feat/a' },
      discoveryCandidate: null,
    });
    expect(r.action).toBe('block');
    expect(r.reason).toBe('fix it');
    expect(r.sideEffects.find((e: any) => e.kind === 'increment-repair-count')).toBeTruthy();
  });

  it('AUTO_READY with queue head → block with next-task prompt + dequeue', () => {
    const r = routeVerdict({
      verdict: vert('AUTO_READY'),
      state: emptyState,
      queue: { schema_version: 'ai_supervisor_queue_v1', tasks: [{ id: 'task-2', title: 'next', description: 'do', branch_hint: 'feat/b' }] },
      currentTask: { id: 'task-1', branch_hint: 'feat/a' },
      discoveryCandidate: null,
    });
    expect(r.action).toBe('block');
    expect(r.reason).toContain('Next task');
    expect(r.sideEffects.find((e: any) => e.kind === 'dequeue-next-task')).toBeTruthy();
    expect(r.sideEffects.find((e: any) => e.kind === 'append-pending-push')).toBeTruthy();
  });

  it('AUTO_READY with empty queue and no discovery → allow-stop + queue-empty report', () => {
    const r = routeVerdict({
      verdict: vert('AUTO_READY'),
      state: emptyState, queue: emptyQueue,
      currentTask: { id: 'task-1' },
      discoveryCandidate: null,
    });
    expect(r.action).toBe('allow-stop');
    expect(r.sideEffects.find((e: any) => e.kind === 'write-queue-empty-report')).toBeTruthy();
  });

  it('AUTO_READY with discovery candidate fills in for empty queue', () => {
    const r = routeVerdict({
      verdict: vert('AUTO_READY'),
      state: emptyState, queue: emptyQueue,
      currentTask: { id: 'task-1' },
      discoveryCandidate: { id: 'task-discovered', title: 'auto', description: 'found' },
    });
    expect(r.action).toBe('block');
    expect(r.reason).toContain('Next task');
  });

  it('SECURITY_QUARANTINE → force-continue-no-output + STOP sentinel', () => {
    const r = routeVerdict({
      verdict: vert('SECURITY_QUARANTINE', { quarantine_reason: 'secret leak' }),
      state: emptyState, queue: emptyQueue,
      currentTask: { id: 'task-1' },
      discoveryCandidate: null,
    });
    expect(r.action).toBe('force-continue-no-output');
    expect(r.continueFalse).toBe(true);
    expect(r.sideEffects.find((e: any) => e.kind === 'write-stop-sentinel')).toBeTruthy();
  });

  it('QUARANTINE_AND_CONTINUE with queue → block + quarantine note + next-task', () => {
    const r = routeVerdict({
      verdict: vert('QUARANTINE_AND_CONTINUE', { quarantine_reason: 'stuck' }),
      state: emptyState,
      queue: { schema_version: 'ai_supervisor_queue_v1', tasks: [{ id: 'task-2', title: 'next', description: 'do' }] },
      currentTask: { id: 'task-1', branch_hint: 'feat/a' },
      discoveryCandidate: null,
    });
    expect(r.action).toBe('block');
    expect(r.reason).toContain('quarantined');
    expect(r.sideEffects.find((e: any) => e.kind === 'write-quarantine-report')).toBeTruthy();
    expect(r.sideEffects.find((e: any) => e.kind === 'record-quarantine-fingerprint')).toBeTruthy();
  });

  it('SPLIT_AUTOMATICALLY → block, resets repair count', () => {
    const r = routeVerdict({
      verdict: vert('SPLIT_AUTOMATICALLY', { claude_next_prompt: 'split into A and B' }),
      state: emptyState, queue: emptyQueue,
      currentTask: { id: 'task-1' },
      discoveryCandidate: null,
    });
    expect(r.action).toBe('block');
    expect(r.sideEffects.find((e: any) => e.kind === 'reset-repair-count')).toBeTruthy();
  });

  it('Unknown verdict falls through to defensive block', () => {
    const r = routeVerdict({
      verdict: vert('MYSTERY_VERDICT' as any),
      state: emptyState, queue: emptyQueue, currentTask: null, discoveryCandidate: null,
    });
    expect(r.action).toBe('block');
    expect(r.reason).toContain('Unrecognized verdict');
  });
});
