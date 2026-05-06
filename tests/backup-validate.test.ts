import { describe, expect, it } from 'vitest';

import { BACKUP_APP_LITERAL } from '../src/db/backup';
import { parseBackupJson, validateBackup } from '../src/db/restore';
import { SCHEMA_VERSION } from '../src/db/schema';

function emptyBackup(): Record<string, unknown> {
  return {
    app: BACKUP_APP_LITERAL,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: '2026-05-06T00:00:00.000Z',
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

describe('parseBackupJson', () => {
  it('parses valid JSON', () => {
    const value = parseBackupJson('{"a": 1}');
    expect(value).toEqual({ a: 1 });
  });

  it('throws on invalid JSON', () => {
    expect(() => parseBackupJson('{not json')).toThrow();
  });
});

describe('validateBackup', () => {
  it('accepts a minimal empty backup', () => {
    const result = validateBackup(emptyBackup());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings).toEqual([]);
    }
  });

  it('rejects non-object roots', () => {
    expect(validateBackup(null).ok).toBe(false);
    expect(validateBackup([]).ok).toBe(false);
    expect(validateBackup('string').ok).toBe(false);
    expect(validateBackup(42).ok).toBe(false);
  });

  it('rejects wrong app literal', () => {
    const result = validateBackup({ ...emptyBackup(), app: 'Other Tracker' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(' ')).toContain('app');
    }
  });

  it('rejects non-positive-integer schemaVersion', () => {
    for (const bad of [0, -1, 1.5, 'one', null]) {
      const result = validateBackup({
        ...emptyBackup(),
        schemaVersion: bad,
      });
      expect(result.ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('rejects future schemaVersion', () => {
    const result = validateBackup({
      ...emptyBackup(),
      schemaVersion: SCHEMA_VERSION + 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(' ')).toMatch(/schemaVersion/);
    }
  });

  it('rejects invalid exportedAt', () => {
    const result = validateBackup({
      ...emptyBackup(),
      exportedAt: 'not-a-timestamp',
    });
    expect(result.ok).toBe(false);
  });

  it('rejects when a required top-level array is missing', () => {
    const incomplete = emptyBackup();
    delete (incomplete as Record<string, unknown>)['holdings'];
    const result = validateBackup(incomplete);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(' ')).toContain('holdings');
    }
  });

  it('rejects when a required top-level key is not an array', () => {
    const result = validateBackup({ ...emptyBackup(), holdings: 'not-array' });
    expect(result.ok).toBe(false);
  });

  it('rejects user-data records that are missing string ids', () => {
    const result = validateBackup({
      ...emptyBackup(),
      holdings: [{ cardId: 'x' } as unknown],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(' ')).toContain('holdings[0]');
    }
  });

  it('produces warnings for dangling foreign keys without failing', () => {
    const result = validateBackup({
      ...emptyBackup(),
      holdings: [
        {
          id: 'h-1',
          cardId: 'base1-4',
          lotId: 'missing-lot',
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings.join(' ')).toContain('missing-lot');
    }
  });

  it('warns about a binderSlot pointing at an unknown binder or holding', () => {
    const result = validateBackup({
      ...emptyBackup(),
      binders: [{ id: 'binder-1' }],
      holdings: [{ id: 'h-1', cardId: 'x', lotId: null }],
      binderSlots: [
        { id: 'slot-1', binderId: 'unknown-binder', holdingId: 'unknown-holding' },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings.join(' ')).toContain('unknown-binder');
      expect(result.warnings.join(' ')).toContain('unknown-holding');
    }
  });

  it('warns about lotItems pointing at unknown lots/holdings', () => {
    const result = validateBackup({
      ...emptyBackup(),
      lots: [{ id: 'lot-1' }],
      holdings: [{ id: 'h-1', cardId: 'x', lotId: null }],
      lotItems: [
        { id: 'item-1', lotId: 'unknown-lot', holdingId: 'unknown-holding' },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings.join(' ')).toContain('unknown-lot');
      expect(result.warnings.join(' ')).toContain('unknown-holding');
    }
  });
});
