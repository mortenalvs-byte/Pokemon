// PR 30 finding F-BACKUP-VALID-1 — originally pinned the
// pre-PR-33 `validateBackup` contract as a fail-then-fix baseline.
//
// PR 33 landed the deep validation. The three "PIN: ACCEPTS …"
// cases below have been flipped to "PIN: REJECTS …" and now serve
// as positive contract tests:
//   - per-record field types are checked (quantity, finish,
//     condition, …)
//   - enum values are checked (status, priority, allocationMethod,
//     …)
//   - cross-references stay warnings-only WHEN records are
//     otherwise valid; if a record is malformed, deep validation
//     hard-fails before the warning walk runs.
//
// The pre-existing rejection tests (root shape, app literal,
// schemaVersion, exportedAt, missing top-level array,
// non-string id) are unchanged — they still describe the
// outermost contract.

import { describe, expect, it } from 'vitest';

import { validateBackup } from '../src/db/restore';
import { BACKUP_APP_LITERAL } from '../src/db/backup';
import { SCHEMA_VERSION } from '../src/db/schema';

function freshBackupShell(): Record<string, unknown> {
  return {
    app: BACKUP_APP_LITERAL,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: '2026-05-09T12:00:00.000Z',
    settings: [],
    sets: [],
    cards: [],
    holdings: [],
    lots: [],
    lotItems: [],
    binders: [],
    binderSlots: [],
    wishlist: [],
    auditLog: [],
    appMeta: [],
  };
}

describe('validateBackup — current contract (PR 30 — F-BACKUP-VALID-1)', () => {
  it('accepts the minimum valid empty shell', () => {
    const result = validateBackup(freshBackupShell());
    expect(result.ok).toBe(true);
  });

  it('rejects null', () => {
    const result = validateBackup(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toContain('root: backup must be a JSON object');
    }
  });

  it('rejects an array root', () => {
    const result = validateBackup([] as unknown);
    expect(result.ok).toBe(false);
  });

  it('rejects a primitive root', () => {
    const result = validateBackup('not an object' as unknown);
    expect(result.ok).toBe(false);
  });

  it('rejects a wrong app literal', () => {
    const root = { ...freshBackupShell(), app: 'Some Other App' };
    const result = validateBackup(root);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.startsWith('app:'))).toBe(true);
    }
  });

  it('rejects a non-integer schemaVersion', () => {
    const root = { ...freshBackupShell(), schemaVersion: 1.5 };
    const result = validateBackup(root);
    expect(result.ok).toBe(false);
  });

  it('rejects a future schemaVersion the build does not support', () => {
    const root = {
      ...freshBackupShell(),
      schemaVersion: SCHEMA_VERSION + 1,
    };
    const result = validateBackup(root);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((e) => /schemaVersion/.test(e)),
      ).toBe(true);
    }
  });

  it('rejects a malformed exportedAt', () => {
    const root = { ...freshBackupShell(), exportedAt: 'yesterday' };
    const result = validateBackup(root);
    expect(result.ok).toBe(false);
  });

  it('rejects when a required top-level array is missing', () => {
    const root: Record<string, unknown> = freshBackupShell();
    delete root['holdings'];
    const result = validateBackup(root);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.startsWith('holdings:'))).toBe(true);
    }
  });

  it('rejects when a top-level array slot is not an array', () => {
    const root = { ...freshBackupShell(), holdings: 'not-an-array' };
    const result = validateBackup(root);
    expect(result.ok).toBe(false);
  });

  it('rejects a holding row with a non-string id', () => {
    const root = {
      ...freshBackupShell(),
      holdings: [{ id: 123 } as unknown],
    };
    const result = validateBackup(root);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => /holdings\[0\]/.test(e))).toBe(true);
    }
  });

  // ─── PR 33 — flipped from "PIN: ACCEPTS …" to "PIN: REJECTS …".
  // The originals lived here as fail-then-fix baselines for
  // F-BACKUP-VALID-1; once PR 33 landed deep validation they
  // describe the new contract instead of the gap. The third pin
  // (cross-references warnings-only) gets a paired positive test
  // below: with a fully-valid record, a dangling foreign key still
  // surfaces as a warning, never an error.

  it('PIN: REJECTS a holding row whose `quantity` is a string', () => {
    const root = {
      ...freshBackupShell(),
      holdings: [
        {
          id: 'h1',
          quantity: 'NOT_A_NUMBER',
          finish: 12345,
          condition: { not: 'a condition' },
          cardId: null,
        },
      ],
    };
    const result = validateBackup(root);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((e) => /holdings\[0\]\.quantity/.test(e)),
      ).toBe(true);
      expect(
        result.errors.some((e) => /holdings\[0\]\.finish/.test(e)),
      ).toBe(true);
      expect(
        result.errors.some((e) => /holdings\[0\]\.cardId/.test(e)),
      ).toBe(true);
    }
  });

  it('PIN: REJECTS a binderSlot row whose pageNumber is a boolean', () => {
    const root = {
      ...freshBackupShell(),
      binderSlots: [
        {
          id: 'slot1',
          pageNumber: true,
          slotNumber: 'x',
          binderId: 'no-such-binder',
          holdingId: null,
        },
      ],
    };
    const result = validateBackup(root);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((e) => /binderSlots\[0\]\.pageNumber/.test(e)),
      ).toBe(true);
      expect(
        result.errors.some((e) => /binderSlots\[0\]\.slotNumber/.test(e)),
      ).toBe(true);
    }
  });

  it('PIN: cross-references stay WARNINGS-ONLY when records are otherwise valid', () => {
    // Paired with the rejection above. A holding that passes deep
    // validation but points at a non-existent lot still produces a
    // warning, never an error — the warnings-vs-errors policy from
    // PR 30 is preserved.
    const validHolding = {
      id: 'h1',
      cardId: 'base1-4',
      quantity: 1,
      conditionType: 'raw',
      rawCondition: 'NM',
      gradingCompany: null,
      grade: null,
      certNumber: null,
      certUrl: null,
      gradedDate: null,
      finish: 'normal',
      edition: 'unlimited',
      language: 'en',
      purchasePrice: null,
      purchaseCurrency: null,
      estimatedValue: null,
      valueCurrency: null,
      valueSource: 'unknown',
      valueNote: null,
      valueUpdatedAt: null,
      source: 'manual',
      note: null,
      specialVariant: false,
      tags: [],
      lotId: 'no-such-lot',
      status: 'owned',
      createdAt: '2026-05-09T00:00:00.000Z',
      updatedAt: '2026-05-09T00:00:00.000Z',
      deletedAt: null,
    };
    const result = validateBackup({
      ...freshBackupShell(),
      holdings: [validHolding],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(
        result.warnings.some((w) =>
          /holdings\[0\]: references missing lotId "no-such-lot"/.test(w),
        ),
      ).toBe(true);
    }
  });
});
