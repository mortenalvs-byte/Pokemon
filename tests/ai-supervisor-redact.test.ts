// @ts-ignore — supervisor scripts are .mjs without .d.mts in V1
import { describe, expect, it } from 'vitest';

// @ts-ignore
import { scrubSecretPatterns, isSensitiveFile, scrubLongTokens, redactFile, redactText, redactDiff } from '../scripts/ai-supervisor/redact.mjs';

describe('redact.mjs — scrubSecretPatterns', () => {
  it.each([
    ['openai-key',        'sk-' + 'A'.repeat(50)],
    ['openai-key-proj',   'sk-proj-' + 'B'.repeat(60)],
    ['github-token',      'ghp_' + 'C'.repeat(40)],
    ['github-pat',        'github_pat_' + 'D'.repeat(70)],
    ['aws-key',           'AKIA' + 'E'.repeat(16)],
    ['anthropic-key',     'sk-ant-' + 'F'.repeat(40)],
    ['jwt',               'eyJ' + 'G'.repeat(30) + '.' + 'H'.repeat(30) + '.' + 'I'.repeat(30)],
  ])('redacts %s patterns', (_label, secret) => {
    const out = scrubSecretPatterns(`prefix ${secret} suffix`);
    expect(out).toContain('[REDACTED:');
    expect(out).not.toContain(secret);
  });

  it('redacts private key blocks', () => {
    const block = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpgIBAAK...\n-----END RSA PRIVATE KEY-----';
    const out = scrubSecretPatterns(block);
    expect(out).toBe('[REDACTED:private-key-block]');
  });

  it('preserves normal code', () => {
    const code = 'const x = 42; if (a > b) { return c; }';
    expect(scrubSecretPatterns(code)).toBe(code);
  });
});

describe('redact.mjs — isSensitiveFile', () => {
  it.each([
    ['.env', true],
    ['.env.local', true],
    ['some/dir/.env.production', true],
    ['.local/ai-supervisor/state.json', true],
    ['.local/ai-supervisor/STOP', true],
    ['id_rsa', true],
    ['cert.pem', true],
    ['pokemon-tracker-backup-2026.json', true],
    ['public/local-fixture.json', false],  // fixture pattern requires .fixture.json
    ['public/foo.fixture.json', true],
    // Allowlisted .local subpaths
    ['.local/ai-supervisor/approvals/appr-test.md', false],
    ['.local/ai-supervisor/source-cache/abc123.json', false],
    // Source files
    ['src/main.ts', false],
    ['scripts/ai-supervisor/redact.mjs', false],
  ])('isSensitiveFile(%s) === %s', (filePath, expected) => {
    expect(isSensitiveFile(filePath)).toBe(expected);
  });
});

describe('redact.mjs — scrubLongTokens', () => {
  it('redacts long base64 runs in non-source files', () => {
    const text = 'token: ' + 'A'.repeat(50);
    expect(scrubLongTokens(text, 'data.log')).toContain('[REDACTED:long-token]');
  });

  it('keeps long hex literals in source files', () => {
    const text = 'const HASH = "' + 'a'.repeat(50) + '";';
    expect(scrubLongTokens(text, 'src/utils/hash.ts')).toBe(text);
  });

  it('also exempts .md and .css', () => {
    const text = 'sha: ' + 'b'.repeat(50);
    expect(scrubLongTokens(text, 'docs/notes.md')).toBe(text);
    expect(scrubLongTokens(text, 'style.css')).toBe(text);
  });
});

describe('redact.mjs — redactFile', () => {
  it('strips sensitive files entirely', () => {
    expect(redactFile('secret content', '.env')).toMatch(/\[REDACTED: sensitive file/);
    expect(redactFile('queue content', '.local/ai-supervisor/queue.json')).toMatch(/\[REDACTED: sensitive file/);
  });

  it('passes through allowlisted .local subpaths', () => {
    const text = 'approval body without secrets';
    expect(redactFile(text, '.local/ai-supervisor/approvals/test.md')).toBe(text);
  });

  it('redacts patterns in source content', () => {
    const text = 'const KEY = "sk-' + 'A'.repeat(50) + '";';
    const out = redactFile(text, 'src/some.ts');
    expect(out).toContain('[REDACTED:openai-key]');
  });
});

describe('redact.mjs — redactText', () => {
  it('handles raw text without filename', () => {
    const text = 'log line with sk-' + 'X'.repeat(50);
    expect(redactText(text)).toContain('[REDACTED:openai-key]');
  });
});

describe('redact.mjs — redactDiff (file-path-aware)', () => {
  function diffFor(file: string, body: string): string {
    return `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,3 +1,3 @@\n${body}`;
  }

  it('strips entire hunks for sensitive files (.env)', () => {
    const diff = diffFor('.env', '+OPENAI_API_KEY=sk-' + 'A'.repeat(50) + '\n');
    const out = redactDiff(diff);
    expect(out).toContain('[REDACTED: sensitive file content stripped');
    expect(out).not.toContain('OPENAI_API_KEY=sk-');
  });

  it('strips fixture JSON hunks entirely', () => {
    const diff = diffFor('tests/fixtures/test.fixture.json', '+{"secret": "embedded"}\n');
    expect(redactDiff(diff)).toContain('[REDACTED: sensitive file content stripped');
  });

  it('strips backup JSONs entirely', () => {
    const diff = diffFor('pokemon-tracker-backup-2026-05-11.json', '+{"some":"backup"}\n');
    expect(redactDiff(diff)).toContain('[REDACTED: sensitive file content stripped');
  });

  it('strips .local/** outside the approvals/source-cache allowlist', () => {
    const diff = diffFor('.local/ai-supervisor/state.json', '+{"cost":{"total":100}}\n');
    expect(redactDiff(diff)).toContain('[REDACTED: sensitive file content stripped');
  });

  it('preserves .local/ai-supervisor/approvals/* content (allowlisted)', () => {
    const diff = diffFor('.local/ai-supervisor/approvals/appr-x.md', '+approved_paths: []\n');
    const out = redactDiff(diff);
    expect(out).not.toContain('[REDACTED: sensitive file content stripped');
    expect(out).toContain('approved_paths: []');
  });

  it('applies pattern-redaction to non-sensitive files', () => {
    const diff = diffFor('src/some.ts', '+const KEY = "sk-' + 'A'.repeat(50) + '";\n');
    const out = redactDiff(diff);
    expect(out).toContain('[REDACTED:openai-key]');
    expect(out).not.toContain('sk-' + 'A'.repeat(50));
  });

  it('handles multi-file diff with mixed sensitivity', () => {
    const diff = diffFor('src/foo.ts', '+const x = 1;\n') + diffFor('.env', '+SECRET=abc\n');
    const out = redactDiff(diff);
    expect(out).toContain('src/foo.ts');
    expect(out).toContain('const x = 1;');
    expect(out).toContain('[REDACTED: sensitive file content stripped — .env]');
  });

  it('passes through non-diff prelude with pattern-redaction', () => {
    const diff = `### Composite header with sk-${'A'.repeat(50)}\n` + diffFor('src/x.ts', '+ok\n');
    const out = redactDiff(diff);
    expect(out).toContain('### Composite header');
    expect(out).toContain('[REDACTED:openai-key]');
  });
});
