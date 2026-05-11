// @ts-ignore — supervisor .mjs imports
import { describe, expect, it } from 'vitest';

// @ts-ignore
import { runScopeGuard } from '../scripts/ai-supervisor/scope-guard.mjs';

function makeDiff(filePath: string, body: string): string {
  return `diff --git a/${filePath} b/${filePath}\n--- a/${filePath}\n+++ b/${filePath}\n@@ -1,3 +1,3 @@\n${body}`;
}

describe('scope-guard — hard-forbidden paths', () => {
  it('blocks src/db/schema.ts without approval', async () => {
    const r = await runScopeGuard({
      changedFiles: ['src/db/schema.ts'],
      fullDiff: makeDiff('src/db/schema.ts', '+ const newField = 1;\n'),
      currentTask: { id: 't', allowedFiles: ['src/**'] },
    });
    expect(r.passed).toBe(false);
    expect(r.violations.find((v: any) => v.gate === 'src-db-schema')).toBeTruthy();
  });

  it('blocks BACKUP_FORMAT.md changes', async () => {
    const r = await runScopeGuard({
      changedFiles: ['BACKUP_FORMAT.md'],
      fullDiff: makeDiff('BACKUP_FORMAT.md', '+ small change\n'),
      currentTask: { id: 't' },
    });
    expect(r.passed).toBe(false);
    expect(r.violations.find((v: any) => v.gate === 'backup-format-doc')).toBeTruthy();
  });

  it('blocks src-tauri capability changes', async () => {
    const r = await runScopeGuard({
      changedFiles: ['src-tauri/capabilities/main.json'],
      fullDiff: '',
      currentTask: { id: 't' },
    });
    expect(r.passed).toBe(false);
    expect(r.violations.find((v: any) => v.gate === 'tauri-capabilities')).toBeTruthy();
  });

  it('blocks tauri.conf.json security.csp changes', async () => {
    const r = await runScopeGuard({
      changedFiles: ['src-tauri/tauri.conf.json'],
      fullDiff: makeDiff('src-tauri/tauri.conf.json', '-    "csp": "default-src \'self\'"\n+    "csp": "default-src \'self\' https://evil.example.com"\n'),
      currentTask: { id: 't' },
    });
    expect(r.passed).toBe(false);
    expect(r.violations.find((v: any) => v.gate === 'tauri-csp')).toBeTruthy();
  });

  it('blocks .claude/plans edits', async () => {
    const r = await runScopeGuard({
      changedFiles: ['.claude/plans/some-plan.md'],
      fullDiff: '',
      currentTask: { id: 't' },
    });
    expect(r.passed).toBe(false);
    expect(r.violations.find((v: any) => v.gate === 'claude-plans')).toBeTruthy();
  });

  it('blocks CLAUDE.md edits without approval', async () => {
    const r = await runScopeGuard({
      changedFiles: ['CLAUDE.md'],
      fullDiff: '',
      currentTask: { id: 't' },
    });
    expect(r.passed).toBe(false);
    expect(r.violations.find((v: any) => v.gate === 'claude-md')).toBeTruthy();
  });

  it('blocks vitest.config.ts changes', async () => {
    const r = await runScopeGuard({
      changedFiles: ['vitest.config.ts'],
      fullDiff: '',
      currentTask: { id: 't' },
    });
    expect(r.passed).toBe(false);
    expect(r.violations.find((v: any) => v.gate === 'test-infrastructure')).toBeTruthy();
  });
});

describe('scope-guard — auditLog append-only (broadened)', () => {
  it.each([
    ['auditLogRepo.update',                          'auditLogRepo.update(1, {x:1})'],
    ['auditLogRepo.delete',                          'auditLogRepo.delete(1)'],
    ['auditLogRepo.bulkDelete',                      'auditLogRepo.bulkDelete([1,2])'],
    ['auditLogRepo.clear',                           'auditLogRepo.clear()'],
    ['db.auditLog.update',                           'db.auditLog.update(1, {x:1})'],
    ['db.auditLog.delete',                           'db.auditLog.delete(1)'],
    ['db.auditLog.bulkDelete',                       'db.auditLog.bulkDelete([1,2])'],
    ['db.table("auditLog").update',                  'db.table("auditLog").update(1, {x:1})'],
    ['db.table("auditLog").delete',                  'db.table("auditLog").delete(1)'],
    ['db.table("auditLog").bulkDelete',              'db.table("auditLog").bulkDelete([1,2])'],
    ['db.table(\'auditLog\').clear',                  "db.table('auditLog').clear()"],
  ])('blocks %s', async (_label, snippet) => {
    const r = await runScopeGuard({
      changedFiles: ['src/services/audit-service.ts'],
      fullDiff: makeDiff('src/services/audit-service.ts', `+ ${snippet};\n`),
      currentTask: { id: 't' },
    });
    expect(r.passed).toBe(false);
    expect(r.violations.find((v: any) => v.gate === 'audit-log-mutation')).toBeTruthy();
  });

  it('allows auditLog INSERT via .add', async () => {
    const r = await runScopeGuard({
      changedFiles: ['src/services/audit-service.ts'],
      fullDiff: makeDiff('src/services/audit-service.ts', '+ db.auditLog.add({ at: Date.now(), action: "x" });\n'),
      currentTask: { id: 't' },
    });
    // .add() is not in the forbidden verbs, so this content-pattern doesn't fire.
    // (Some src/db/* gate may still fire, but for this file it should pass.)
    expect(r.violations.find((v: any) => v.gate === 'audit-log-mutation')).toBeUndefined();
  });
});

describe('scope-guard — content-pattern checks', () => {
  it('blocks .skip() addition in existing test', async () => {
    const r = await runScopeGuard({
      changedFiles: ['tests/example.test.ts'],
      fullDiff: makeDiff('tests/example.test.ts', "-it('works', () => {});\n+it.skip('works', () => {});\n"),
      currentTask: { id: 't', allowedFiles: ['tests/**'] },
    });
    expect(r.passed).toBe(false);
    expect(r.violations.find((v: any) => v.gate === 'test-skip-addition')).toBeTruthy();
  });

  it('blocks tsconfig strictness loosening', async () => {
    const r = await runScopeGuard({
      changedFiles: ['tsconfig.json'],
      fullDiff: makeDiff('tsconfig.json', '-    "strict": true,\n+    "strict": false,\n'),
      currentTask: { id: 't' },
    });
    expect(r.passed).toBe(false);
    const v = r.violations.find((v: any) => v.gate === 'tsconfig-strictness');
    expect(v).toBeTruthy();
  });

  it('blocks package.json dependency additions', async () => {
    const r = await runScopeGuard({
      changedFiles: ['package.json'],
      fullDiff: makeDiff('package.json', '+    "react": "^18.0.0",\n'),
      currentTask: { id: 't' },
    });
    expect(r.passed).toBe(false);
    // package.json hits BOTH the path-pattern test (if any) and content scanner
  });

  it('blocks new external API hostname in src/api', async () => {
    const r = await runScopeGuard({
      changedFiles: ['src/api/sneaky.ts'],
      fullDiff: makeDiff('src/api/sneaky.ts', '+ fetch("https://evil.example.com/track")\n'),
      currentTask: { id: 't', allowedFiles: ['src/api/**'] },
    });
    expect(r.passed).toBe(false);
    expect(r.violations.find((v: any) => v.gate === 'new-api-hostname')).toBeTruthy();
  });
});

describe('scope-guard — allowedFiles enforcement', () => {
  it('blocks files outside allowedFiles', async () => {
    const r = await runScopeGuard({
      changedFiles: ['src/views/random.ts'],
      fullDiff: '',
      currentTask: { id: 't', allowedFiles: ['src/db/**'] },
    });
    expect(r.passed).toBe(false);
    expect(r.violations.find((v: any) => v.gate === 'allowed-files-out-of-scope')).toBeTruthy();
  });

  it('passes files inside allowedFiles', async () => {
    const r = await runScopeGuard({
      changedFiles: ['src/views/binder-detail.ts'],
      fullDiff: '',
      currentTask: { id: 't', allowedFiles: ['src/views/binder-*.ts'] },
    });
    // Note: this file has no diff content that triggers content gates
    expect(r.passed).toBe(true);
  });
});

describe('scope-guard — supervisor self-mod requires quorum', () => {
  it('blocks scripts/ai-supervisor/** without approval', async () => {
    const r = await runScopeGuard({
      changedFiles: ['scripts/ai-supervisor/state.mjs'],
      fullDiff: '',
      currentTask: { id: 't', allowedFiles: ['scripts/ai-supervisor/**'] },
    });
    expect(r.passed).toBe(false);
    expect(r.violations.find((v: any) => v.gate === 'supervisor-self-mod')).toBeTruthy();
  });

  it('passes scripts/ai-supervisor/** with two distinct-operator approvals (type-correct match)', async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const dir = await mkdtemp(path.join(tmpdir(), 'sg-quorum-'));

    const future = new Date(Date.now() + 2*24*60*60*1000).toISOString();
    function approvalMd(id: string, op: string, type: 'exact'|'glob', p: string): string {
      return `---
approval_id: ${id}
task_id: task-quorum
status: active
issued_at: 2026-05-11T14:00:00.000Z
expires_at: ${future}
operator: ${op}
approved_paths:
  - path: ${p}
    type: ${type}
rationale: |
  Two-pair-of-eyes approval for supervisor self-mod test.
---`;
    }
    await writeFile(path.join(dir, 'a1.md'), approvalMd('appr-1', 'morten', 'glob', 'scripts/ai-supervisor/**'));
    await writeFile(path.join(dir, 'a2.md'), approvalMd('appr-2', 'second-op', 'glob', 'scripts/ai-supervisor/**'));

    const r = await runScopeGuard({
      changedFiles: ['scripts/ai-supervisor/state.mjs'],
      fullDiff: '',
      currentTask: { id: 'task-quorum' },
      approvalsDir: dir,
    });
    expect(r.passed).toBe(true);
  });

  it('rejects quorum when an `exact` approval has wildcard-looking text (not glob-interpreted)', async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const dir = await mkdtemp(path.join(tmpdir(), 'sg-quorum-exact-'));

    const future = new Date(Date.now() + 2*24*60*60*1000).toISOString();

    // First approval is a real glob from operator A — matches.
    await writeFile(path.join(dir, 'a-glob.md'), `---
approval_id: appr-glob
task_id: task-mix
status: active
issued_at: 2026-05-11T14:00:00.000Z
expires_at: ${future}
operator: morten
approved_paths:
  - path: scripts/ai-supervisor/**
    type: glob
rationale: |
  Operator A's real glob approval — covers the file in question.
---`);
    // Second approval from operator B looks glob-y but is declared `exact` —
    // must NOT contribute to quorum just because its path resembles a glob.
    await writeFile(path.join(dir, 'b-exact.md'), `---
approval_id: appr-exact
task_id: task-mix
status: active
issued_at: 2026-05-11T14:00:00.000Z
expires_at: ${future}
operator: second-op
approved_paths:
  - path: scripts/ai-supervisor/**
    type: exact
rationale: |
  Operator B accidentally declared a glob-looking path as exact. This must
  NOT count as a separate matching approval; quorum should fail with only 1
  real cover.
---`);

    const r = await runScopeGuard({
      changedFiles: ['scripts/ai-supervisor/state.mjs'],
      fullDiff: '',
      currentTask: { id: 'task-mix' },
      approvalsDir: dir,
    });
    // Only 1 distinct operator's approval truly covers → quorum fails → still blocked.
    expect(r.passed).toBe(false);
    expect(r.violations.find((v: any) => v.gate === 'supervisor-self-mod')).toBeTruthy();
  });
});
