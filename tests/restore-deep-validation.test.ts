// PR 33 — comprehensive rejection cases for the new per-record
// deep validators in `src/db/restore.ts:validateBackup`.
//
// Acceptance criteria from `docs/PR30_CLEANUP_ROADMAP.md` PR 33:
//   - "At least 8 new 'rejects malformed X' cases."
//   - "All current happy-path restore tests still PASS."
//
// This file covers all six user-data stores (holdings, lots,
// lotItems, binders, binderSlots, wishlist) plus the lighter
// settings / appMeta / auditLog validators. Each `it()` exercises
// one specific malformed field at a time so the error message it
// asserts against is unambiguous.
//
// Cross-reference warnings (PR 30 unchanged behaviour) live in
// `tests/backup-validate.test.ts`. The "PIN" cases that flipped
// from ACCEPTS → REJECTS in PR 33 live in
// `tests/pr30-backup-deep-validation.test.ts`.

import { describe, expect, it } from 'vitest';

import { BACKUP_APP_LITERAL } from '../src/db/backup';
import { validateBackup } from '../src/db/restore';
import { SCHEMA_VERSION } from '../src/db/schema';

const VALID_TS = '2026-05-09T00:00:00.000Z';

function emptyBackup(): Record<string, unknown> {
  return {
    app: BACKUP_APP_LITERAL,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: VALID_TS,
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

function holding(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
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

function binder(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'b-1',
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

function binderSlot(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 's-1',
    binderId: 'b-1',
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

function lot(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'l-1',
    name: 'Test Lot',
    purchaseDate: VALID_TS,
    totalCost: 100,
    currency: 'NOK',
    allocationMethod: 'manual',
    notes: null,
    createdAt: VALID_TS,
    updatedAt: VALID_TS,
    deletedAt: null,
    ...over,
  };
}

function lotItem(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'li-1',
    lotId: 'l-1',
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

function wishlist(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'w-1',
    cardId: 'base1-4',
    finish: 'normal',
    priority: 'medium',
    targetCondition: null,
    targetPrice: null,
    targetCurrency: null,
    status: 'wanted',
    note: null,
    createdAt: VALID_TS,
    updatedAt: VALID_TS,
    deletedAt: null,
    ...over,
  };
}

function audit(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'a-1',
    action: 'test_action',
    entityType: 'system',
    entityId: null,
    message: 'hello',
    createdAt: VALID_TS,
    ...over,
  };
}

function setting(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    key: 'preferredCurrency',
    value: 'NOK',
    updatedAt: VALID_TS,
    ...over,
  };
}

function expectError(
  result: ReturnType<typeof validateBackup>,
  pattern: RegExp,
): void {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    const matched = result.errors.some((e) => pattern.test(e));
    if (!matched) {
      throw new Error(
        `expected an error matching ${pattern}; got:\n${result.errors.join('\n')}`,
      );
    }
  }
}

// ─── Sanity: a fully-valid record set passes ──────────────────────

describe('validateBackup deep — sanity', () => {
  it('accepts an empty backup', () => {
    expect(validateBackup(emptyBackup()).ok).toBe(true);
  });

  it('accepts a backup with one fully-populated row in every user-data store', () => {
    const root = {
      ...emptyBackup(),
      holdings: [holding()],
      binders: [binder()],
      binderSlots: [binderSlot()],
      lots: [lot()],
      lotItems: [lotItem()],
      wishlist: [wishlist()],
      auditLog: [audit()],
      settings: [setting()],
      appMeta: [setting({ key: 'lastSyncAt' })],
    };
    expect(validateBackup(root).ok).toBe(true);
  });
});

// ─── Holdings (12+ rejection cases) ────────────────────────────────

describe('validateBackup deep — holdings', () => {
  it('rejects non-string cardId', () => {
    const r = validateBackup({ ...emptyBackup(), holdings: [holding({ cardId: 123 })] });
    expectError(r, /holdings\[0\]\.cardId/);
  });

  it('rejects negative quantity', () => {
    const r = validateBackup({ ...emptyBackup(), holdings: [holding({ quantity: -5 })] });
    expectError(r, /holdings\[0\]\.quantity/);
  });

  it('rejects fractional quantity', () => {
    const r = validateBackup({ ...emptyBackup(), holdings: [holding({ quantity: 1.5 })] });
    expectError(r, /holdings\[0\]\.quantity/);
  });

  it('rejects unknown conditionType', () => {
    const r = validateBackup({ ...emptyBackup(), holdings: [holding({ conditionType: 'mint' })] });
    expectError(r, /holdings\[0\]\.conditionType/);
  });

  it('rejects unknown rawCondition value', () => {
    const r = validateBackup({ ...emptyBackup(), holdings: [holding({ rawCondition: 'PERFECT' })] });
    expectError(r, /holdings\[0\]\.rawCondition/);
  });

  it('rejects unknown finish enum', () => {
    const r = validateBackup({ ...emptyBackup(), holdings: [holding({ finish: 'sparkly' })] });
    expectError(r, /holdings\[0\]\.finish/);
  });

  it('rejects unknown edition enum', () => {
    const r = validateBackup({ ...emptyBackup(), holdings: [holding({ edition: 'special' })] });
    expectError(r, /holdings\[0\]\.edition/);
  });

  it('rejects unknown status enum', () => {
    const r = validateBackup({ ...emptyBackup(), holdings: [holding({ status: 'pending_review' })] });
    expectError(r, /holdings\[0\]\.status/);
  });

  it('rejects unknown valueSource enum', () => {
    const r = validateBackup({ ...emptyBackup(), holdings: [holding({ valueSource: 'guess' })] });
    expectError(r, /holdings\[0\]\.valueSource/);
  });

  it('rejects unknown source value', () => {
    const r = validateBackup({ ...emptyBackup(), holdings: [holding({ source: 'inheritance' })] });
    expectError(r, /holdings\[0\]\.source/);
  });

  it('rejects unknown purchaseCurrency code', () => {
    const r = validateBackup({ ...emptyBackup(), holdings: [holding({ purchaseCurrency: 'GBP' })] });
    expectError(r, /holdings\[0\]\.purchaseCurrency/);
  });

  it('rejects negative purchasePrice', () => {
    const r = validateBackup({ ...emptyBackup(), holdings: [holding({ purchasePrice: -10 })] });
    expectError(r, /holdings\[0\]\.purchasePrice/);
  });

  it('rejects non-finite estimatedValue (NaN)', () => {
    const r = validateBackup({ ...emptyBackup(), holdings: [holding({ estimatedValue: NaN })] });
    expectError(r, /holdings\[0\]\.estimatedValue/);
  });

  it('rejects non-array tags', () => {
    const r = validateBackup({ ...emptyBackup(), holdings: [holding({ tags: 'favorite' })] });
    expectError(r, /holdings\[0\]\.tags/);
  });

  it('rejects tags containing a non-string', () => {
    const r = validateBackup({ ...emptyBackup(), holdings: [holding({ tags: ['ok', 42] })] });
    expectError(r, /holdings\[0\]\.tags/);
  });

  it('rejects malformed createdAt', () => {
    const r = validateBackup({ ...emptyBackup(), holdings: [holding({ createdAt: 'yesterday' })] });
    expectError(r, /holdings\[0\]\.createdAt/);
  });

  it('rejects undefined-via-missing required field (specialVariant)', () => {
    const partial = { ...holding() };
    delete partial['specialVariant'];
    const r = validateBackup({ ...emptyBackup(), holdings: [partial] });
    expectError(r, /holdings\[0\]\.specialVariant/);
  });
});

// ─── Lots (4+ rejection cases) ─────────────────────────────────────

describe('validateBackup deep — lots', () => {
  it('rejects empty name', () => {
    const r = validateBackup({ ...emptyBackup(), lots: [lot({ name: '' })] });
    expectError(r, /lots\[0\]\.name/);
  });

  it('rejects negative totalCost', () => {
    const r = validateBackup({ ...emptyBackup(), lots: [lot({ totalCost: -1 })] });
    expectError(r, /lots\[0\]\.totalCost/);
  });

  it('rejects unknown currency', () => {
    const r = validateBackup({ ...emptyBackup(), lots: [lot({ currency: 'JPY' })] });
    expectError(r, /lots\[0\]\.currency/);
  });

  it('rejects unknown allocationMethod', () => {
    const r = validateBackup({ ...emptyBackup(), lots: [lot({ allocationMethod: 'random' })] });
    expectError(r, /lots\[0\]\.allocationMethod/);
  });

  it('rejects malformed purchaseDate', () => {
    // isIsoTimestamp delegates to Date.parse which is lenient
    // (accepts e.g. "2026/05/09"); we use a value Date.parse
    // unambiguously rejects.
    const r = validateBackup({ ...emptyBackup(), lots: [lot({ purchaseDate: 'not-a-date' })] });
    expectError(r, /lots\[0\]\.purchaseDate/);
  });
});

// ─── LotItems (5+ rejection cases) ─────────────────────────────────

describe('validateBackup deep — lotItems', () => {
  it('rejects empty lotId', () => {
    const r = validateBackup({ ...emptyBackup(), lotItems: [lotItem({ lotId: '' })] });
    expectError(r, /lotItems\[0\]\.lotId/);
  });

  it('rejects unknown finish', () => {
    const r = validateBackup({ ...emptyBackup(), lotItems: [lotItem({ finish: 'glitter' })] });
    expectError(r, /lotItems\[0\]\.finish/);
  });

  it('rejects unknown conditionType', () => {
    const r = validateBackup({
      ...emptyBackup(),
      lotItems: [lotItem({ conditionType: 'pristine' })],
    });
    expectError(r, /lotItems\[0\]\.conditionType/);
  });

  it('rejects negative quantity', () => {
    const r = validateBackup({ ...emptyBackup(), lotItems: [lotItem({ quantity: -1 })] });
    expectError(r, /lotItems\[0\]\.quantity/);
  });

  it('rejects negative manualPriceOverride', () => {
    const r = validateBackup({
      ...emptyBackup(),
      lotItems: [lotItem({ manualPriceOverride: -50 })],
    });
    expectError(r, /lotItems\[0\]\.manualPriceOverride/);
  });
});

// ─── Binders (5+ rejection cases) ──────────────────────────────────

describe('validateBackup deep — binders', () => {
  it('rejects empty name', () => {
    const r = validateBackup({ ...emptyBackup(), binders: [binder({ name: '' })] });
    expectError(r, /binders\[0\]\.name/);
  });

  it('rejects unknown slotsPerPage value', () => {
    const r = validateBackup({ ...emptyBackup(), binders: [binder({ slotsPerPage: 8 })] });
    expectError(r, /binders\[0\]\.slotsPerPage/);
  });

  it('rejects unknown completionMode', () => {
    const r = validateBackup({
      ...emptyBackup(),
      binders: [binder({ completionMode: 'gold' })],
    });
    expectError(r, /binders\[0\]\.completionMode/);
  });

  it('rejects unknown binderPreset value', () => {
    const r = validateBackup({
      ...emptyBackup(),
      binders: [binder({ binderPreset: 'platinum_x' })],
    });
    expectError(r, /binders\[0\]\.binderPreset/);
  });

  it('accepts null binderPreset (legacy back-fill normalises post-validate)', () => {
    const r = validateBackup({
      ...emptyBackup(),
      binders: [binder({ binderPreset: null })],
    });
    expect(r.ok).toBe(true);
  });

  it('accepts missing binderPreset (legacy back-fill normalises post-validate)', () => {
    const partial = { ...binder() };
    delete partial['binderPreset'];
    const r = validateBackup({ ...emptyBackup(), binders: [partial] });
    expect(r.ok).toBe(true);
  });

  it('rejects negative totalPages', () => {
    const r = validateBackup({ ...emptyBackup(), binders: [binder({ totalPages: -1 })] });
    expectError(r, /binders\[0\]\.totalPages/);
  });
});

// ─── BinderSlots (5+ rejection cases) ──────────────────────────────

describe('validateBackup deep — binderSlots', () => {
  it('rejects empty binderId', () => {
    const r = validateBackup({
      ...emptyBackup(),
      binderSlots: [binderSlot({ binderId: '' })],
    });
    expectError(r, /binderSlots\[0\]\.binderId/);
  });

  it('rejects non-integer pageNumber', () => {
    const r = validateBackup({
      ...emptyBackup(),
      binderSlots: [binderSlot({ pageNumber: 1.5 })],
    });
    expectError(r, /binderSlots\[0\]\.pageNumber/);
  });

  it('rejects boolean slotNumber', () => {
    const r = validateBackup({
      ...emptyBackup(),
      binderSlots: [binderSlot({ slotNumber: true })],
    });
    expectError(r, /binderSlots\[0\]\.slotNumber/);
  });

  it('rejects unknown status enum', () => {
    const r = validateBackup({
      ...emptyBackup(),
      binderSlots: [binderSlot({ status: 'maybe_owned' })],
    });
    expectError(r, /binderSlots\[0\]\.status/);
  });

  it('rejects malformed updatedAt', () => {
    const r = validateBackup({
      ...emptyBackup(),
      binderSlots: [binderSlot({ updatedAt: 'now' })],
    });
    expectError(r, /binderSlots\[0\]\.updatedAt/);
  });
});

// ─── Wishlist (5+ rejection cases) ─────────────────────────────────

describe('validateBackup deep — wishlist', () => {
  it('rejects empty cardId', () => {
    const r = validateBackup({ ...emptyBackup(), wishlist: [wishlist({ cardId: '' })] });
    expectError(r, /wishlist\[0\]\.cardId/);
  });

  it('rejects unknown finish', () => {
    const r = validateBackup({ ...emptyBackup(), wishlist: [wishlist({ finish: 'matte' })] });
    expectError(r, /wishlist\[0\]\.finish/);
  });

  it('rejects unknown priority', () => {
    const r = validateBackup({ ...emptyBackup(), wishlist: [wishlist({ priority: 'urgent' })] });
    expectError(r, /wishlist\[0\]\.priority/);
  });

  it('rejects unknown status', () => {
    const r = validateBackup({ ...emptyBackup(), wishlist: [wishlist({ status: 'pending' })] });
    expectError(r, /wishlist\[0\]\.status/);
  });

  it('rejects unknown targetCurrency', () => {
    const r = validateBackup({
      ...emptyBackup(),
      wishlist: [wishlist({ targetCurrency: 'CHF' })],
    });
    expectError(r, /wishlist\[0\]\.targetCurrency/);
  });
});

// ─── Settings + AppMeta (KV shape) ─────────────────────────────────

describe('validateBackup deep — settings / appMeta', () => {
  it('rejects empty settings.key', () => {
    const r = validateBackup({ ...emptyBackup(), settings: [setting({ key: '' })] });
    expectError(r, /settings\[0\]\.key/);
  });

  it('rejects missing settings.value (JSON null is fine, undefined is not)', () => {
    const partial = { ...setting() };
    delete partial['value'];
    const r = validateBackup({ ...emptyBackup(), settings: [partial] });
    expectError(r, /settings\[0\]\.value/);
  });

  it('accepts settings.value === null (legitimate "key cleared")', () => {
    const r = validateBackup({ ...emptyBackup(), settings: [setting({ value: null })] });
    expect(r.ok).toBe(true);
  });

  it('rejects malformed appMeta.updatedAt', () => {
    const r = validateBackup({
      ...emptyBackup(),
      appMeta: [setting({ key: 'lastSyncAt', updatedAt: 'soon' })],
    });
    expectError(r, /appMeta\[0\]\.updatedAt/);
  });
});

// ─── AuditLog ──────────────────────────────────────────────────────

describe('validateBackup deep — auditLog', () => {
  it('rejects unknown entityType', () => {
    const r = validateBackup({
      ...emptyBackup(),
      auditLog: [audit({ entityType: 'spaceship' })],
    });
    expectError(r, /auditLog\[0\]\.entityType/);
  });

  it('rejects non-string message', () => {
    const r = validateBackup({
      ...emptyBackup(),
      auditLog: [audit({ message: 123 })],
    });
    expectError(r, /auditLog\[0\]\.message/);
  });

  it('rejects malformed createdAt', () => {
    const r = validateBackup({
      ...emptyBackup(),
      auditLog: [audit({ createdAt: 'today' })],
    });
    expectError(r, /auditLog\[0\]\.createdAt/);
  });
});

// ─── Multi-record aggregation ──────────────────────────────────────

describe('validateBackup deep — multi-record aggregation', () => {
  it('reports per-record errors with index labels', () => {
    const r = validateBackup({
      ...emptyBackup(),
      holdings: [
        holding({ id: 'h-1' }),                  // valid
        holding({ id: 'h-2', quantity: 'no' }),  // bad quantity
        holding({ id: 'h-3', finish: 'shiny' }), // bad finish
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => /holdings\[1\]\.quantity/.test(e))).toBe(true);
      expect(r.errors.some((e) => /holdings\[2\]\.finish/.test(e))).toBe(true);
      // record 0 is valid; no error for it
      expect(r.errors.some((e) => /holdings\[0\]/.test(e))).toBe(false);
    }
  });

  it('aggregates errors across stores in one validation pass', () => {
    const r = validateBackup({
      ...emptyBackup(),
      holdings: [holding({ status: 'bad' })],
      lots: [lot({ currency: 'XYZ' })],
      wishlist: [wishlist({ priority: 'super' })],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => /holdings\[0\]\.status/.test(e))).toBe(true);
      expect(r.errors.some((e) => /lots\[0\]\.currency/.test(e))).toBe(true);
      expect(r.errors.some((e) => /wishlist\[0\]\.priority/.test(e))).toBe(true);
    }
  });
});
