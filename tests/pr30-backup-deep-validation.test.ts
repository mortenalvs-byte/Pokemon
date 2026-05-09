// PR 30 finding F-BACKUP-VALID-1 — pin the current `validateBackup`
// contract so PR 33 (Backup/restore validation hardening) has a
// fail-then-fix baseline.
//
// Today, `validateBackup` checks:
//   - root is an object (not array, not null)
//   - app === 'Pokemon TCG Tracker'
//   - schemaVersion is integer ≥ 1 and ≤ SCHEMA_VERSION
//   - exportedAt is an ISO 8601 timestamp
//   - every TOP_LEVEL_ARRAY_KEYS key is present and is an array
//   - every record in user-data stores has a string `id`
//   - cross-references → warnings only
//
// What it does NOT check:
//   - per-record field types (quantity, finish, condition, …)
//   - enum values (status, priority, allocationMethod, …)
//   - referential integrity (treated as warnings, not errors)
//
// This file pins both halves so a regression of the existing checks
// fails loud, and any new strictness from PR 33 will mark these
// `accepts-today` tests as red — the intended hand-off signal.

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

  // ─── PINS THAT REPRESENT THE GAP F-BACKUP-VALID-1 ──────────────
  // Each of the following currently RETURNS OK. PR 33 should flip
  // them to fail; when that happens, these tests become the
  // fail-then-fix signal for the hardening work.

  it('PIN: ACCEPTS a holding row whose `quantity` is a string today', () => {
    const root = {
      ...freshBackupShell(),
      holdings: [
        {
          id: 'h1',
          // every other field is intentionally garbage, only `id` is
          // checked. PR 33 should reject this; today the validator
          // returns ok.
          quantity: 'NOT_A_NUMBER',
          finish: 12345,
          condition: { not: 'a condition' },
          cardId: null,
        },
      ],
    };
    const result = validateBackup(root);
    expect(result.ok).toBe(true);
  });

  it('PIN: ACCEPTS a binderSlot row whose pageNumber is a boolean today', () => {
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
    // Currently returns ok — only `id` is checked per record. The
    // cross-reference walk emits warnings (binderId not found) but
    // does not fail validation.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(
        result.warnings.some((w) =>
          /binderSlots\[0\]: references missing binderId/.test(w),
        ),
      ).toBe(true);
    }
  });

  it('PIN: cross-references produce warnings only, never errors', () => {
    const root = {
      ...freshBackupShell(),
      holdings: [{ id: 'h1', lotId: 'no-such-lot' }],
    };
    const result = validateBackup(root);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(
        result.warnings.some((w) => /holdings\[0\]/.test(w)),
      ).toBe(true);
    }
  });
});
