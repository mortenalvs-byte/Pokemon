import { describe, expect, it } from 'vitest';

import {
  ValidationError,
  validateBinderInput,
  validateBinderSlotInput,
  validateHoldingInput,
  validateLotInput,
  validateLotItemInput,
  validateWishlistInput,
  type BinderInput,
  type BinderSlotInput,
  type HoldingInput,
  type LotInput,
  type LotItemInput,
  type WishlistInput,
} from '../src/domain/validators';

const baseRawHolding: HoldingInput = {
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
};

describe('validateHoldingInput', () => {
  it('accepts a valid raw holding', () => {
    expect(() => validateHoldingInput(baseRawHolding)).not.toThrow();
  });

  it('rejects raw holding without rawCondition', () => {
    expect(() =>
      validateHoldingInput({ ...baseRawHolding, rawCondition: null }),
    ).toThrowError(ValidationError);
  });

  it('rejects graded holding without gradingCompany', () => {
    expect(() =>
      validateHoldingInput({
        ...baseRawHolding,
        conditionType: 'graded',
        rawCondition: null,
        gradingCompany: null,
        grade: 9,
      }),
    ).toThrowError(/gradingCompany/);
  });

  it('rejects graded holding without grade', () => {
    expect(() =>
      validateHoldingInput({
        ...baseRawHolding,
        conditionType: 'graded',
        rawCondition: null,
        gradingCompany: 'PSA',
        grade: null,
      }),
    ).toThrowError(/grade/);
  });

  it('rejects grade outside [1.0, 10.0]', () => {
    const tooLow: HoldingInput = {
      ...baseRawHolding,
      conditionType: 'graded',
      rawCondition: null,
      gradingCompany: 'PSA',
      grade: 0.5,
    };
    const tooHigh: HoldingInput = { ...tooLow, grade: 10.5 };

    expect(() => validateHoldingInput(tooLow)).toThrowError(/grade/);
    expect(() => validateHoldingInput(tooHigh)).toThrowError(/grade/);
  });

  it('accepts grade exactly at the boundaries', () => {
    const atOne: HoldingInput = {
      ...baseRawHolding,
      conditionType: 'graded',
      rawCondition: null,
      gradingCompany: 'PSA',
      grade: 1,
    };
    const atTen: HoldingInput = { ...atOne, grade: 10 };

    expect(() => validateHoldingInput(atOne)).not.toThrow();
    expect(() => validateHoldingInput(atTen)).not.toThrow();
  });

  it('rejects quantity < 1', () => {
    expect(() =>
      validateHoldingInput({ ...baseRawHolding, quantity: 0 }),
    ).toThrowError(/quantity/);
    expect(() =>
      validateHoldingInput({ ...baseRawHolding, quantity: -2 }),
    ).toThrowError(/quantity/);
  });

  it('rejects non-integer quantity', () => {
    expect(() =>
      validateHoldingInput({ ...baseRawHolding, quantity: 1.5 }),
    ).toThrowError(/quantity/);
  });

  it('rejects negative purchase or estimated values', () => {
    expect(() =>
      validateHoldingInput({ ...baseRawHolding, purchasePrice: -1 }),
    ).toThrowError(/purchasePrice/);
    expect(() =>
      validateHoldingInput({ ...baseRawHolding, estimatedValue: -10 }),
    ).toThrowError(/estimatedValue/);
  });
});

describe('validateBinderInput', () => {
  const base: BinderInput = {
    name: 'Master Set 151',
    description: null,
    binderType: null,
    totalPages: 12,
    slotsPerPage: 18,
    binderPreset: null,
    completionMode: 'master',
    sourceSetId: null,
  };

  it('accepts a valid binder', () => {
    expect(() => validateBinderInput(base)).not.toThrow();
  });

  it('rejects unsupported slotsPerPage', () => {
    // PR 14 allows 4, 9, 12, 16, 18 — anything else must reject.
    expect(() =>
      validateBinderInput({ ...base, slotsPerPage: 7 as 9 | 18 }),
    ).toThrowError(/slotsPerPage/);
    expect(() =>
      validateBinderInput({ ...base, slotsPerPage: 24 as 9 | 18 }),
    ).toThrowError(/slotsPerPage/);
  });

  it('accepts the new Vault X slot counts (4, 12, 16)', () => {
    for (const slotsPerPage of [4, 9, 12, 16, 18] as const) {
      expect(() =>
        validateBinderInput({ ...base, slotsPerPage, binderPreset: null }),
      ).not.toThrow();
    }
  });

  it('rejects empty name', () => {
    expect(() => validateBinderInput({ ...base, name: '   ' })).toThrowError(
      /name/,
    );
  });

  it('rejects totalPages < 1', () => {
    expect(() => validateBinderInput({ ...base, totalPages: 0 })).toThrowError(
      /totalPages/,
    );
  });
});

describe('validateBinderSlotInput', () => {
  const base: BinderSlotInput = {
    binderId: 'binder-1',
    pageNumber: 1,
    slotNumber: 1,
    targetCardId: null,
    holdingId: null,
    status: 'empty',
    note: null,
  };

  it('accepts valid input', () => {
    expect(() => validateBinderSlotInput(base, 9)).not.toThrow();
    expect(() => validateBinderSlotInput(base, 18)).not.toThrow();
  });

  it('rejects slotNumber > slotsPerPage', () => {
    expect(() =>
      validateBinderSlotInput({ ...base, slotNumber: 10 }, 9),
    ).toThrowError(/slotNumber/);
  });

  it('rejects pageNumber < 1', () => {
    expect(() =>
      validateBinderSlotInput({ ...base, pageNumber: 0 }, 9),
    ).toThrowError(/pageNumber/);
  });
});

describe('validateLotInput', () => {
  const base: LotInput = {
    name: 'Booster box',
    purchaseDate: '2026-05-06T00:00:00.000Z',
    totalCost: 100,
    currency: 'NOK',
    allocationMethod: 'weighted_by_market_price',
    notes: null,
  };

  it('accepts valid input', () => {
    expect(() => validateLotInput(base)).not.toThrow();
  });

  it('rejects negative totalCost', () => {
    expect(() => validateLotInput({ ...base, totalCost: -1 })).toThrowError(
      /totalCost/,
    );
  });

  it('rejects empty name', () => {
    expect(() => validateLotInput({ ...base, name: '' })).toThrowError(/name/);
  });
});

describe('validateLotItemInput', () => {
  const base: LotItemInput = {
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
  };

  it('accepts valid input', () => {
    expect(() => validateLotItemInput(base)).not.toThrow();
  });

  it('rejects negative numbers', () => {
    expect(() =>
      validateLotItemInput({ ...base, manualPriceOverride: -1 }),
    ).toThrowError(/manualPriceOverride/);
    expect(() =>
      validateLotItemInput({ ...base, marketEstimate: -1 }),
    ).toThrowError(/marketEstimate/);
    expect(() =>
      validateLotItemInput({ ...base, allocatedCost: -1 }),
    ).toThrowError(/allocatedCost/);
  });
});

describe('validateWishlistInput', () => {
  const base: WishlistInput = {
    cardId: 'base1-4',
    finish: 'holo',
    priority: 'high',
    targetCondition: 'NM',
    targetPrice: 500,
    targetCurrency: 'NOK',
    status: 'wanted',
    note: null,
  };

  it('accepts valid input', () => {
    expect(() => validateWishlistInput(base)).not.toThrow();
  });

  it('rejects negative target price', () => {
    expect(() =>
      validateWishlistInput({ ...base, targetPrice: -1 }),
    ).toThrowError(/targetPrice/);
  });
});
