// Domain validators. Run before any repository write to keep IndexedDB
// from holding records that violate KRAVSPEC. The rules are documented in
// DATA_MODEL.md §10. All validators throw `ValidationError` on failure.

import {
  CREATABLE_SLOTS_PER_PAGE,
  getBinderPresetDefinition,
  isLegacyPreset,
  isVaultXPreset,
} from './binder-presets';
import {
  ESCAPE_HATCH_EDITIONS,
  ESCAPE_HATCH_FINISHES,
  availableVariants,
  type AvailableVariants,
} from './card-variants';
import type {
  BinderRecord,
  BinderSlotRecord,
  CardFinish,
  CardRecord,
  Edition,
  HoldingRecord,
  LotItemRecord,
  LotRecord,
  SlotsPerPage,
  WishlistRecord,
} from './types';

const ALLOWED_SLOTS_PER_PAGE: readonly SlotsPerPage[] = [4, 9, 12, 16, 18];

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
  if (
    !ALLOWED_SLOTS_PER_PAGE.includes(input.slotsPerPage as SlotsPerPage)
  ) {
    throw new ValidationError(
      'slotsPerPage',
      `must be one of ${ALLOWED_SLOTS_PER_PAGE.join(', ')}`,
    );
  }
  if (!Number.isInteger(input.totalPages) || input.totalPages < 1) {
    throw new ValidationError('totalPages', 'must be an integer >= 1');
  }
  if (input.name.trim().length === 0) {
    throw new ValidationError('name', 'cannot be empty');
  }

  // PR 14 preset consistency. `binderPreset` is allowed to be `null`
  // for backups that pre-date this PR; the migration / restore path
  // assigns a value before the row reaches the repo on read.
  if (input.binderPreset !== null) {
    const def = getBinderPresetDefinition(input.binderPreset);
    if (isVaultXPreset(input.binderPreset)) {
      if (input.slotsPerPage !== def.slotsPerPage) {
        throw new ValidationError(
          'slotsPerPage',
          `Vault X preset ${input.binderPreset} requires slotsPerPage=${def.slotsPerPage}`,
        );
      }
      if (input.totalPages !== def.totalPages) {
        throw new ValidationError(
          'totalPages',
          `Vault X preset ${input.binderPreset} requires totalPages=${def.totalPages}`,
        );
      }
    } else if (isLegacyPreset(input.binderPreset)) {
      if (input.slotsPerPage !== 18) {
        throw new ValidationError(
          'slotsPerPage',
          'legacy_18 preset requires slotsPerPage=18',
        );
      }
    } else {
      // `custom` — only restrict the slot count.
      if (
        !CREATABLE_SLOTS_PER_PAGE.includes(input.slotsPerPage as SlotsPerPage) &&
        input.slotsPerPage !== 18
      ) {
        throw new ValidationError(
          'slotsPerPage',
          `custom preset slotsPerPage must be one of ${CREATABLE_SLOTS_PER_PAGE.join(', ')} (or legacy 18)`,
        );
      }
    }
  }
}

// -- Binder slots -------------------------------------------------------

export type BinderSlotInput = Omit<
  BinderSlotRecord,
  'id' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export function validateBinderSlotInput(
  input: BinderSlotInput,
  slotsPerPage: SlotsPerPage,
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

// -- Variant validation against the cached card -------------------------
//
// These run after the shape validators above. They enforce the strict
// API-truth contract from PR 11: the chosen `finish` (and `edition`,
// where the record has one) must either appear in
// `availableVariants(card)` or fall into the escape-hatch set with a
// `specialVariant=true` / non-empty `note` marker.
//
// The validators are pure: callers (the repos) load the card from the
// cache and pass it in. When the card is missing from the cache, we
// synthesise an "unverified" variant set so the rule still applies —
// the user must explicitly mark their record as a manual/special
// variant. No guessing, no fallback to "all options".

export interface VariantValidationContext {
  /**
   * The cached card the record is being created/updated against. Pass
   * `null` when the card is not in the cache — this is treated as the
   * unverified path (`verified=false`) and only escape-hatch finishes
   * + a note/specialVariant marker will satisfy the rule.
   */
  readonly card: CardRecord | null;
}

function variantsForContext(
  ctx: VariantValidationContext,
): AvailableVariants {
  if (ctx.card === null) {
    return { verified: false, finishes: new Set(), editions: new Set() };
  }
  return availableVariants(ctx.card);
}

function hasManualMarker(input: {
  readonly note: string | null;
  readonly specialVariant?: boolean;
}): boolean {
  if (input.specialVariant === true) return true;
  if (input.note !== null && input.note.trim().length > 0) return true;
  return false;
}

function checkFinish(
  finish: CardFinish,
  variants: AvailableVariants,
  manualMarker: boolean,
  field: string,
): void {
  if (variants.finishes.has(finish)) return;
  if (ESCAPE_HATCH_FINISHES.has(finish)) {
    if (!manualMarker) {
      throw new ValidationError(
        field,
        `finish "${finish}" requires specialVariant=true or a non-empty note`,
      );
    }
    return;
  }
  throw new ValidationError(
    field,
    variants.verified
      ? `finish "${finish}" not produced for this card (API exposes ${listOrNone(
          variants.finishes,
        )})`
      : `finish "${finish}" cannot be verified — pick "unknown" or "stamped" with note/specialVariant`,
  );
}

function checkEdition(
  edition: Edition,
  variants: AvailableVariants,
  manualMarker: boolean,
  field: string,
): void {
  if (variants.editions.has(edition)) return;
  if (ESCAPE_HATCH_EDITIONS.has(edition)) {
    if (!manualMarker) {
      throw new ValidationError(
        field,
        `edition "${edition}" requires specialVariant=true or a non-empty note`,
      );
    }
    return;
  }
  throw new ValidationError(
    field,
    variants.verified
      ? `edition "${edition}" not produced for this card (API exposes ${listOrNone(
          variants.editions,
        )})`
      : `edition "${edition}" cannot be verified — pick "unknown" or "shadowless" with note/specialVariant`,
  );
}

function listOrNone<T extends string>(set: ReadonlySet<T>): string {
  if (set.size === 0) return 'none';
  return Array.from(set).sort().join(', ');
}

export function validateHoldingVariants(
  input: HoldingInput,
  ctx: VariantValidationContext,
): void {
  const variants = variantsForContext(ctx);
  const manual = hasManualMarker({
    note: input.note,
    specialVariant: input.specialVariant,
  });
  checkFinish(input.finish, variants, manual, 'finish');
  checkEdition(input.edition, variants, manual, 'edition');
}

export function validateLotItemVariants(
  input: LotItemInput,
  ctx: VariantValidationContext,
): void {
  const variants = variantsForContext(ctx);
  const manual = hasManualMarker({ note: input.note });
  checkFinish(input.finish, variants, manual, 'finish');
  checkEdition(input.edition, variants, manual, 'edition');
}

export function validateWishlistVariants(
  input: WishlistInput,
  ctx: VariantValidationContext,
): void {
  const variants = variantsForContext(ctx);
  const manual = hasManualMarker({ note: input.note });
  checkFinish(input.finish, variants, manual, 'finish');
}
