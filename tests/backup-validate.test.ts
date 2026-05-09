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

// PR 33 — full record factories. Cross-reference warning tests need
// per-record fields to be otherwise valid; the deep validator now
// rejects malformed records before warnings are even computed. The
// factories below produce records that pass deep validation, so the
// warning-walk is the only thing the tests exercise.

const VALID_TS = '2026-05-06T00:00:00.000Z';

function fullHolding(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'h-1',
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
    lotId: null,
    status: 'owned',
    createdAt: VALID_TS,
    updatedAt: VALID_TS,
    deletedAt: null,
    ...over,
  };
}

function fullBinder(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'binder-1',
    name: 'Test',
    description: null,
    binderType: null,
    totalPages: 1,
    slotsPerPage: 9,
    binderPreset: 'custom',
    completionMode: 'master',
    sourceSetId: null,
    createdAt: VALID_TS,
    updatedAt: VALID_TS,
    deletedAt: null,
    ...over,
  };
}

function fullBinderSlot(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'slot-1',
    binderId: 'binder-1',
    pageNumber: 1,
    slotNumber: 1,
    targetCardId: null,
    holdingId: null,
    status: 'empty',
    note: null,
    createdAt: VALID_TS,
    updatedAt: VALID_TS,
    deletedAt: null,
    ...over,
  };
}

function fullLot(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'lot-1',
    name: 'Test Lot',
    purchaseDate: VALID_TS,
    totalCost: 0,
    currency: 'NOK',
    allocationMethod: 'manual',
    notes: null,
    createdAt: VALID_TS,
    updatedAt: VALID_TS,
    deletedAt: null,
    ...over,
  };
}

function fullLotItem(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'item-1',
    lotId: 'lot-1',
    cardId: 'base1-4',
    finish: 'normal',
    edition: 'unlimited',
    conditionType: 'raw',
    rawCondition: 'NM',
    gradingCompany: null,
    grade: null,
    quantity: 1,
    manualPriceOverride: null,
    marketEstimate: null,
    allocatedCost: null,
    holdingId: null,
    note: null,
    createdAt: VALID_TS,
    updatedAt: VALID_TS,
    deletedAt: null,
    ...over,
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
    // PR 33: records must be otherwise valid for the cross-reference
    // warning walk to fire — deep validation rejects malformed
    // records before warnings are computed.
    const result = validateBackup({
      ...emptyBackup(),
      holdings: [fullHolding({ lotId: 'missing-lot' })],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings.join(' ')).toContain('missing-lot');
    }
  });

  it('warns about a binderSlot pointing at an unknown binder or holding', () => {
    const result = validateBackup({
      ...emptyBackup(),
      binders: [fullBinder()],
      holdings: [fullHolding()],
      binderSlots: [
        fullBinderSlot({
          binderId: 'unknown-binder',
          holdingId: 'unknown-holding',
        }),
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
      lots: [fullLot()],
      holdings: [fullHolding()],
      lotItems: [
        fullLotItem({
          lotId: 'unknown-lot',
          holdingId: 'unknown-holding',
        }),
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings.join(' ')).toContain('unknown-lot');
      expect(result.warnings.join(' ')).toContain('unknown-holding');
    }
  });
});
