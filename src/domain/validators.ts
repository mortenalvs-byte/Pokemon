// Domain validators. Run before any repository write to keep IndexedDB
// from holding records that violate KRAVSPEC. The rules are documented in
// DATA_MODEL.md §10. All validators throw `ValidationError` on failure.

import type {
  BinderRecord,
  BinderSlotRecord,
  HoldingRecord,
  LotItemRecord,
  LotRecord,
  WishlistRecord,
} from './types';

export class ValidationError extends Error {
  public readonly field: string;

  constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = 'ValidationError';
    this.field = field;
  }
}

// -- Holdings -----------------------------------------------------------

export type HoldingInput = Omit<
  HoldingRecord,
  'id' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export function validateHoldingInput(input: HoldingInput): void {
  if (!Number.isInteger(input.quantity) || input.quantity < 1) {
    throw new ValidationError('quantity', 'must be an integer >= 1');
  }

  if (input.conditionType === 'raw') {
    if (input.rawCondition === null) {
      throw new ValidationError(
        'rawCondition',
        'raw holdings must have a rawCondition',
      );
    }
  } else if (input.conditionType === 'graded') {
    if (input.gradingCompany === null) {
      throw new ValidationError(
        'gradingCompany',
        'graded holdings must have a gradingCompany',
      );
    }
    if (input.grade === null) {
      throw new ValidationError(
        'grade',
        'graded holdings must have a grade',
      );
    }
    if (input.grade < 1 || input.grade > 10) {
      throw new ValidationError(
        'grade',
        'grade must be between 1.0 and 10.0',
      );
    }
  }

  if (input.purchasePrice !== null && input.purchasePrice < 0) {
    throw new ValidationError('purchasePrice', 'cannot be negative');
  }
  if (input.estimatedValue !== null && input.estimatedValue < 0) {
    throw new ValidationError('estimatedValue', 'cannot be negative');
  }
}

// -- Binders ------------------------------------------------------------

export type BinderInput = Omit<
  BinderRecord,
  'id' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export function validateBinderInput(input: BinderInput): void {
  if (input.slotsPerPage !== 9 && input.slotsPerPage !== 18) {
    throw new ValidationError(
      'slotsPerPage',
      'must be 9 or 18',
    );
  }
  if (!Number.isInteger(input.totalPages) || input.totalPages < 1) {
    throw new ValidationError('totalPages', 'must be an integer >= 1');
  }
  if (input.name.trim().length === 0) {
    throw new ValidationError('name', 'cannot be empty');
  }
}

// -- Binder slots -------------------------------------------------------

export type BinderSlotInput = Omit<
  BinderSlotRecord,
  'id' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export function validateBinderSlotInput(
  input: BinderSlotInput,
  slotsPerPage: 9 | 18,
): void {
  if (!Number.isInteger(input.pageNumber) || input.pageNumber < 1) {
    throw new ValidationError('pageNumber', 'must be an integer >= 1');
  }
  if (
    !Number.isInteger(input.slotNumber) ||
    input.slotNumber < 1 ||
    input.slotNumber > slotsPerPage
  ) {
    throw new ValidationError(
      'slotNumber',
      `must be between 1 and ${slotsPerPage}`,
    );
  }
}

// -- Lots ---------------------------------------------------------------

export type LotInput = Omit<
  LotRecord,
  'id' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export function validateLotInput(input: LotInput): void {
  if (input.name.trim().length === 0) {
    throw new ValidationError('name', 'cannot be empty');
  }
  if (input.totalCost < 0) {
    throw new ValidationError('totalCost', 'cannot be negative');
  }
}

// -- Lot items ----------------------------------------------------------

export type LotItemInput = Omit<
  LotItemRecord,
  'id' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export function validateLotItemInput(input: LotItemInput): void {
  if (!Number.isInteger(input.quantity) || input.quantity < 1) {
    throw new ValidationError('quantity', 'must be an integer >= 1');
  }
  if (input.manualPriceOverride !== null && input.manualPriceOverride < 0) {
    throw new ValidationError('manualPriceOverride', 'cannot be negative');
  }
  if (input.marketEstimate !== null && input.marketEstimate < 0) {
    throw new ValidationError('marketEstimate', 'cannot be negative');
  }
  if (input.allocatedCost !== null && input.allocatedCost < 0) {
    throw new ValidationError('allocatedCost', 'cannot be negative');
  }
  if (input.conditionType === 'graded') {
    if (input.gradingCompany === null) {
      throw new ValidationError(
        'gradingCompany',
        'graded lot items must have a gradingCompany',
      );
    }
    if (input.grade === null) {
      throw new ValidationError(
        'grade',
        'graded lot items must have a grade',
      );
    }
    if (input.grade < 1 || input.grade > 10) {
      throw new ValidationError(
        'grade',
        'grade must be between 1.0 and 10.0',
      );
    }
  } else if (input.conditionType === 'raw' && input.rawCondition === null) {
    throw new ValidationError(
      'rawCondition',
      'raw lot items must have a rawCondition',
    );
  }
}

// -- Wishlist -----------------------------------------------------------

export type WishlistInput = Omit<
  WishlistRecord,
  'id' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export function validateWishlistInput(input: WishlistInput): void {
  if (input.targetPrice !== null && input.targetPrice < 0) {
    throw new ValidationError('targetPrice', 'cannot be negative');
  }
}
