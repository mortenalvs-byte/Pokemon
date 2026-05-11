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
});
