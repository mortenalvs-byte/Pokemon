// @ts-ignore — supervisor .mjs imports
import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// @ts-ignore
import { parseApprovalFile, validateApproval, loadActiveApprovals, isPathCoveredByApproval } from '../scripts/ai-supervisor/parse-approval.mjs';

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(path.join(tmpdir(), 'sup-approval-'));
});

function futureIso(daysFromNow: number = 1): string {
  return new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000).toISOString();
}

function pastIso(daysAgo: number = 1): string {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}

function validApprovalMd(overrides: Record<string, string> = {}): string {
  const defaults: Record<string, string> = {
    approval_id: 'appr-test-123',
    task_id: 'task-x',
    status: 'active',
    issued_at: '2026-05-11T14:00:00.000Z',
    expires_at: futureIso(2),
    operator: 'morten',
  };
  const fields = { ...defaults, ...overrides };
  return `---
approval_id: ${fields.approval_id}
task_id: ${fields.task_id}
status: ${fields.status}
issued_at: ${fields.issued_at}
expires_at: ${fields.expires_at}
operator: ${fields.operator}
approved_paths:
  - path: src/db/restore.ts
    type: exact
  - path: tests/restore-*.test.ts
    type: glob
rationale: |
  This is a valid test approval with at least 20 chars of rationale text.
---

# Body content`;
}

describe('parse-approval — validateApproval (happy path)', () => {
  it('accepts a well-formed approval', () => {
    const approval = {
      approval_id: 'appr-1',
      task_id: 'task-x',
      status: 'active',
      issued_at: '2026-05-11T14:00:00.000Z',
      expires_at: futureIso(),
      operator: 'morten',
      approved_paths: [{ path: 'src/db/restore.ts', type: 'exact' }],
      rationale: 'Valid 20-char-long rationale text here.',
    };
    expect(validateApproval(approval).ok).toBe(true);
  });
});

describe('parse-approval — rejections', () => {
  const base = () => ({
    approval_id: 'appr-1',
    task_id: 'task-x',
    status: 'active',
    issued_at: '2026-05-11T14:00:00.000Z',
    expires_at: futureIso(),
    operator: 'morten',
    approved_paths: [{ path: 'src/db/restore.ts', type: 'exact' }],
    rationale: 'Valid 20-char-long rationale text here.',
  });

  it('rejects missing required field', () => {
    const a: any = base(); delete a.approval_id;
    const r = validateApproval(a);
    expect(r.ok).toBe(false);
    expect((r as any).error).toContain('approval_id');
  });

  it('rejects status != active', () => {
    const a: any = base(); a.status = 'expired';
    expect(validateApproval(a).ok).toBe(false);
  });

  it('rejects timestamps without explicit timezone', () => {
    const a: any = base(); a.expires_at = '2026-05-15T14:00:00';  // missing Z
    expect(validateApproval(a).ok).toBe(false);
  });

  it('rejects expired approval', () => {
    const a: any = base(); a.expires_at = pastIso();
    const r = validateApproval(a);
    expect(r.ok).toBe(false);
    expect((r as any).error).toContain('expired');
  });

  it('rejects empty operator', () => {
    const a: any = base(); a.operator = '';
    expect(validateApproval(a).ok).toBe(false);
  });

  it('rejects empty approved_paths', () => {
    const a: any = base(); a.approved_paths = [];
    expect(validateApproval(a).ok).toBe(false);
  });

  it('rejects approved_paths with .. (path-traversal)', () => {
    const a: any = base(); a.approved_paths = [{ path: '../etc/passwd', type: 'exact' }];
    expect(validateApproval(a).ok).toBe(false);
  });

  it('rejects rationale shorter than 20 chars', () => {
    const a: any = base(); a.rationale = 'short';
    expect(validateApproval(a).ok).toBe(false);
  });

  it('rejects renewal_count > max_renewals', () => {
    const a: any = base(); a.max_renewals = 1; a.renewal_count = 2;
    expect(validateApproval(a).ok).toBe(false);
  });
});

describe('parse-approval — parseApprovalFile + loadActiveApprovals', () => {
  it('parses a valid file', async () => {
    const file = path.join(testDir, 'valid.md');
    await writeFile(file, validApprovalMd());
    const r = await parseApprovalFile(file);
    expect(r.ok).toBe(true);
    expect((r as any).approval.task_id).toBe('task-x');
  });

  it('returns error for file without frontmatter', async () => {
    const file = path.join(testDir, 'no-fm.md');
    await writeFile(file, '# Just a markdown file');
    const r = await parseApprovalFile(file);
    expect(r.ok).toBe(false);
    expect((r as any).error).toContain('frontmatter');
  });

  it('loadActiveApprovals returns empty when dir does not exist', async () => {
    const r = await loadActiveApprovals(path.join(testDir, 'no-such-dir'));
    expect(r.active).toEqual([]);
    expect(r.invalid).toEqual([]);
  });

  it('loadActiveApprovals separates active from invalid', async () => {
    await writeFile(path.join(testDir, 'valid.md'), validApprovalMd());
    await writeFile(path.join(testDir, 'expired.md'), validApprovalMd({ expires_at: pastIso() }));
    const r = await loadActiveApprovals(testDir);
    expect(r.active.length).toBe(1);
    expect(r.invalid.length).toBe(1);
  });
});

describe('parse-approval — isPathCoveredByApproval', () => {
  it('matches exact path', async () => {
    await writeFile(path.join(testDir, 'valid.md'), validApprovalMd());
    const { active } = await loadActiveApprovals(testDir);
    const r = isPathCoveredByApproval('src/db/restore.ts', 'task-x', active);
    expect(r.approved).toBe(true);
    expect(r.approval_id).toBe('appr-test-123');
  });

  it('matches glob path', async () => {
    await writeFile(path.join(testDir, 'valid.md'), validApprovalMd());
    const { active } = await loadActiveApprovals(testDir);
    expect(isPathCoveredByApproval('tests/restore-deep.test.ts', 'task-x', active).approved).toBe(true);
  });

  it('rejects wrong task_id', async () => {
    await writeFile(path.join(testDir, 'valid.md'), validApprovalMd());
    const { active } = await loadActiveApprovals(testDir);
    expect(isPathCoveredByApproval('src/db/restore.ts', 'WRONG_TASK', active).approved).toBe(false);
  });

  it('rejects path-traversal in queried path', async () => {
    await writeFile(path.join(testDir, 'valid.md'), validApprovalMd());
    const { active } = await loadActiveApprovals(testDir);
    const r = isPathCoveredByApproval('../../etc/passwd', 'task-x', active);
    expect(r.approved).toBe(false);
    expect(r.note).toContain('outside repo root');
  });
});
