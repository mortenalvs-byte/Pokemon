// PR 25 — Master set gap analysis. Pure classification + types.
//
// The service in `services/master-set-gap-service.ts` does the bulk
// loading + lookup-map building; this file owns the per-slot status
// decision so the rules can be tested without touching IndexedDB.
//
// Locked rules (carried forward from PR 8a / PR 24 / KRAVSPEC §6):
//   - Reverse-holo template slots (note === REVERSE_HOLO_TEMPLATE_MARKER)
//     require finish=reverse_holo. Holdings with any other finish are
//     `invalid_variant`, never `complete`.
//   - Normal target slots derive their required finish from
//     `availableVariants(card)` — the API is variant truth. We never
//     guess from rarity / set name. Holo-only cards may require `holo`.
//   - Edition is informational only in PR 25 (no schema migration; the
//     wishlist and binder slot rows have no edition field).
//   - Ambiguous (>1 unassigned matching holding) is never auto-picked.
//   - Blank slots (targetCardId === null) are excluded from the
//     totalTargetSlots denominator. They render as `blank_slot`.

import {
  availableVariants,
  isReverseHoloTemplateSlot,
} from './card-variants';
import type {
  BinderSlotRecord,
  CardFinish,
  CardRecord,
  Edition,
  HoldingRecord,
  IsoTimestamp,
  LotItemRecord,
  WishlistRecord,
} from './types';

export type MasterGapStatus =
  | 'complete'
  | 'missing'
  | 'owned_unplaced'
  | 'wishlist_wanted'
  | 'wishlist_ordered'
  | 'in_lot_unmaterialized'
  | 'ambiguous_owned'
  | 'invalid_assignment'
  | 'invalid_variant'
  | 'unverified_variant_data'
  | 'blank_slot';

export type MasterGapSeverity = 'ok' | 'info' | 'warning' | 'critical';

export interface MasterGapRequiredVariant {
  readonly finish: CardFinish | null;
  readonly edition: Edition | null;
  readonly verified: boolean;
  readonly reason: string;
}

export interface MasterGapRow {
  readonly binderId: string;
  readonly binderName: string;
  readonly slotId: string;
  readonly pageNumber: number;
  readonly slotNumber: number;

  readonly cardId: string | null;
  readonly cardName: string | null;
  readonly setId: string | null;
  readonly setName: string | null;
  readonly cardNumber: string | null;

  readonly required: MasterGapRequiredVariant;

  readonly status: MasterGapStatus;
  readonly severity: MasterGapSeverity;
  readonly reason: string;

  readonly assignedHoldingId: string | null;
  readonly matchingUnplacedHoldingIds: readonly string[];
  readonly activeWishlistIds: readonly string[];
  readonly orderedWishlistIds: readonly string[];
  readonly unmaterializedLotItemIds: readonly string[];

  readonly canPlaceDirectly: boolean;
}

export interface MasterGapBinderSummary {
  readonly binderId: string;
  readonly binderName: string;

  readonly totalTargetSlots: number;
  readonly complete: number;
  readonly missing: number;
  readonly ownedUnplaced: number;
  readonly wishlistWanted: number;
  readonly wishlistOrdered: number;
  readonly inLotUnmaterialized: number;
  readonly ambiguousOwned: number;
  readonly invalidAssignment: number;
  readonly invalidVariant: number;
  readonly unverifiedVariantData: number;

  readonly completionPercent: number;
  readonly actionableCount: number;
  readonly canPlaceDirectlyCount: number;
}

export interface MasterGapReport {
  readonly generatedAt: IsoTimestamp;
  readonly binder: MasterGapBinderSummary;
  readonly rows: readonly MasterGapRow[];
}

export interface MasterGapDashboardSummary {
  readonly generatedAt: IsoTimestamp;
  readonly binderCount: number;
  readonly totalTargetSlots: number;
  readonly complete: number;
  readonly missing: number;
  readonly ownedUnplaced: number;
  readonly wishlistWanted: number;
  readonly wishlistOrdered: number;
  readonly inLotUnmaterialized: number;
  readonly invalidCount: number;
  readonly canPlaceDirectlyCount: number;
  readonly averageCompletionPercent: number;
  readonly closestBinder: MasterGapBinderSummary | null;
  readonly weakestBinder: MasterGapBinderSummary | null;
  readonly binders: readonly MasterGapBinderSummary[];
}

// ---------------------------------------------------------------------
// Required-variant derivation

const BLANK_REQUIRED: MasterGapRequiredVariant = Object.freeze({
  finish: null,
  edition: null,
  verified: false,
  reason: 'Slot uten målkort.',
});

const UNVERIFIED_REQUIRED: MasterGapRequiredVariant = Object.freeze({
  finish: null,
  edition: null,
  verified: false,
  reason: 'Mangler trygg variantdata for kortet.',
});

/**
 * Decide what finish the slot demands. Reverse-holo template slots
 * always require `reverse_holo`; everything else falls back to the
 * card's `availableVariants` (normal > holo > reverse_holo) so a
 * holo-only card doesn't get a phantom `normal` requirement and a
 * normal-only card doesn't get a phantom `reverse_holo` requirement.
 */
export function deriveRequiredVariant(
  slot: BinderSlotRecord,
  card: CardRecord | null,
): MasterGapRequiredVariant {
  if (slot.targetCardId === null) {
    return BLANK_REQUIRED;
  }
  if (isReverseHoloTemplateSlot(slot.note)) {
    return {
      finish: 'reverse_holo',
      edition: null,
      verified: true,
      reason: 'Reverse-holo template-slot.',
    };
  }
  if (card === null) {
    return UNVERIFIED_REQUIRED;
  }
  const variants = availableVariants(card);
  if (!variants.verified) {
    return UNVERIFIED_REQUIRED;
  }
  if (variants.finishes.has('normal')) {
    return {
      finish: 'normal',
      edition: null,
      verified: true,
      reason: 'Standardprint (normal) finnes for kortet.',
    };
  }
  if (variants.finishes.has('holo')) {
    return {
      finish: 'holo',
      edition: null,
      verified: true,
      reason: 'Kortet finnes kun som holo.',
    };
  }
  if (variants.finishes.has('reverse_holo')) {
    return {
      finish: 'reverse_holo',
      edition: null,
      verified: true,
      reason: 'Kortet finnes kun som reverse holo.',
    };
  }
  return UNVERIFIED_REQUIRED;
}

// ---------------------------------------------------------------------
// Pure classification

export interface ClassifyDeps {
  /** All live wishlist rows for the slot's targetCardId. */
  readonly wishlist: readonly WishlistRecord[];
  /** All live lot items (any holdingId) for the slot's targetCardId. */
  readonly lotItems: readonly LotItemRecord[];
  /** Live holdings keyed by id; assigned set tells us which are in slots. */
  readonly liveHoldingsForCard: readonly HoldingRecord[];
  /** Holdings already bound to a live slot (any binder). */
  readonly assignedHoldingIds: ReadonlySet<string>;
  /** The holding currently bound to this slot (if any). May be soft-deleted. */
  readonly assignedHolding: HoldingRecord | null;
  /** The card record for the slot's targetCardId, if cached. */
  readonly card: CardRecord | null;
}

export interface ClassificationResult {
  readonly status: MasterGapStatus;
  readonly severity: MasterGapSeverity;
  readonly reason: string;
  readonly required: MasterGapRequiredVariant;
  readonly matchingUnplacedHoldingIds: readonly string[];
  readonly activeWishlistIds: readonly string[];
  readonly orderedWishlistIds: readonly string[];
  readonly unmaterializedLotItemIds: readonly string[];
  readonly canPlaceDirectly: boolean;
}

const REASONS: Record<MasterGapStatus, string> = {
  complete: 'Slotten er fullført.',
  missing: 'Kortet finnes ikke i samlingen.',
  owned_unplaced: 'Du eier kortet, men det er ikke plassert i denne permen.',
  wishlist_wanted: 'Kortet finnes på ønskelisten.',
  wishlist_ordered: 'Kortet er markert som bestilt.',
  in_lot_unmaterialized:
    'Kortet finnes i en lot, men er ikke lagt i samlingen ennå.',
  ambiguous_owned: 'Flere holdings matcher. Velg manuelt.',
  invalid_assignment: 'Slotten har holding for feil kort.',
  invalid_variant:
    'Reverse-holo slot har holding med feil finish.',
  unverified_variant_data: 'API-data mangler trygg variantinformasjon.',
  blank_slot: 'Slot uten målkort.',
};

/**
 * Run the full classification for one slot. The service feeds in
 * pre-built lookups so a 1088-slot binder doesn't repeat the same
 * filtering work per row.
 */
export function classifySlot(
  slot: BinderSlotRecord,
  deps: ClassifyDeps,
): ClassificationResult {
  // Blank slots short-circuit: they don't count toward target totals
  // and we don't run the matching machinery.
  if (slot.targetCardId === null) {
    return {
      status: 'blank_slot',
      severity: 'info',
      reason: REASONS.blank_slot,
      required: BLANK_REQUIRED,
      matchingUnplacedHoldingIds: [],
      activeWishlistIds: [],
      orderedWishlistIds: [],
      unmaterializedLotItemIds: [],
      canPlaceDirectly: false,
    };
  }

  const required = deriveRequiredVariant(slot, deps.card);

  // 1) Assignment validity check.
  if (slot.holdingId !== null) {
    const assigned = deps.assignedHolding;
    if (
      assigned === null ||
      assigned.deletedAt !== null ||
      assigned.cardId !== slot.targetCardId
    ) {
      return {
        status: 'invalid_assignment',
        severity: 'critical',
        reason: REASONS.invalid_assignment,
        required,
        matchingUnplacedHoldingIds: [],
        activeWishlistIds: [],
        orderedWishlistIds: [],
        unmaterializedLotItemIds: [],
        canPlaceDirectly: false,
      };
    }
    if (
      required.finish !== null &&
      assigned.finish !== required.finish
    ) {
      return {
        status: 'invalid_variant',
        severity: 'critical',
        reason: REASONS.invalid_variant,
        required,
        matchingUnplacedHoldingIds: [],
        activeWishlistIds: [],
        orderedWishlistIds: [],
        unmaterializedLotItemIds: [],
        canPlaceDirectly: false,
      };
    }
    return {
      status: 'complete',
      severity: 'ok',
      reason: REASONS.complete,
      required,
      matchingUnplacedHoldingIds: [],
      activeWishlistIds: [],
      orderedWishlistIds: [],
      unmaterializedLotItemIds: [],
      canPlaceDirectly: false,
    };
  }

  // 2) Unverified variant data — flag rather than gamble.
  if (!required.verified) {
    return {
      status: 'unverified_variant_data',
      severity: 'warning',
      reason: REASONS.unverified_variant_data,
      required,
      matchingUnplacedHoldingIds: [],
      activeWishlistIds: [],
      orderedWishlistIds: [],
      unmaterializedLotItemIds: [],
      canPlaceDirectly: false,
    };
  }

  // 3) Find live unassigned holdings that match cardId + required finish.
  const matchingHoldings = deps.liveHoldingsForCard.filter(
    (h) =>
      h.deletedAt === null &&
      !deps.assignedHoldingIds.has(h.id) &&
      (required.finish === null || h.finish === required.finish),
  );
  const matchingUnplacedHoldingIds = matchingHoldings.map((h) => h.id);

  // 4) Wishlist match (active = wanted or ordered).
  const activeWishlist = deps.wishlist.filter(
    (w) =>
      w.deletedAt === null &&
      w.cardId === slot.targetCardId &&
      (required.finish === null || w.finish === required.finish) &&
      (w.status === 'wanted' || w.status === 'ordered'),
  );
  const orderedWishlistIds = activeWishlist
    .filter((w) => w.status === 'ordered')
    .map((w) => w.id);
  const activeWishlistIds = activeWishlist
    .filter((w) => w.status === 'wanted')
    .map((w) => w.id);

  // 5) Lot match (unmaterialised live lot item with same cardId).
  const unmaterializedLotItemIds = deps.lotItems
    .filter(
      (li) =>
        li.deletedAt === null &&
        li.cardId === slot.targetCardId &&
        li.holdingId === null,
    )
    .map((li) => li.id);

  if (matchingHoldings.length === 1) {
    return {
      status: 'owned_unplaced',
      severity: 'warning',
      reason: REASONS.owned_unplaced,
      required,
      matchingUnplacedHoldingIds,
      activeWishlistIds,
      orderedWishlistIds,
      unmaterializedLotItemIds,
      canPlaceDirectly: true,
    };
  }
  if (matchingHoldings.length > 1) {
    return {
      status: 'ambiguous_owned',
      severity: 'warning',
      reason: REASONS.ambiguous_owned,
      required,
      matchingUnplacedHoldingIds,
      activeWishlistIds,
      orderedWishlistIds,
      unmaterializedLotItemIds,
      canPlaceDirectly: false,
    };
  }
  if (orderedWishlistIds.length > 0) {
    return {
      status: 'wishlist_ordered',
      severity: 'info',
      reason: REASONS.wishlist_ordered,
      required,
      matchingUnplacedHoldingIds,
      activeWishlistIds,
      orderedWishlistIds,
      unmaterializedLotItemIds,
      canPlaceDirectly: false,
    };
  }
  if (activeWishlistIds.length > 0) {
    return {
      status: 'wishlist_wanted',
      severity: 'info',
      reason: REASONS.wishlist_wanted,
      required,
      matchingUnplacedHoldingIds,
      activeWishlistIds,
      orderedWishlistIds,
      unmaterializedLotItemIds,
      canPlaceDirectly: false,
    };
  }
  if (unmaterializedLotItemIds.length > 0) {
    return {
      status: 'in_lot_unmaterialized',
      severity: 'info',
      reason: REASONS.in_lot_unmaterialized,
      required,
      matchingUnplacedHoldingIds,
      activeWishlistIds,
      orderedWishlistIds,
      unmaterializedLotItemIds,
      canPlaceDirectly: false,
    };
  }
  return {
    status: 'missing',
    severity: 'warning',
    reason: REASONS.missing,
    required,
    matchingUnplacedHoldingIds,
    activeWishlistIds,
    orderedWishlistIds,
    unmaterializedLotItemIds,
    canPlaceDirectly: false,
  };
}

// ---------------------------------------------------------------------
// Aggregation

interface BinderRowAggregate {
  totalTargetSlots: number;
  complete: number;
  missing: number;
  ownedUnplaced: number;
  wishlistWanted: number;
  wishlistOrdered: number;
  inLotUnmaterialized: number;
  ambiguousOwned: number;
  invalidAssignment: number;
  invalidVariant: number;
  unverifiedVariantData: number;
  canPlaceDirectlyCount: number;
}

function emptyAggregate(): BinderRowAggregate {
  return {
    totalTargetSlots: 0,
    complete: 0,
    missing: 0,
    ownedUnplaced: 0,
    wishlistWanted: 0,
    wishlistOrdered: 0,
    inLotUnmaterialized: 0,
    ambiguousOwned: 0,
    invalidAssignment: 0,
    invalidVariant: 0,
    unverifiedVariantData: 0,
    canPlaceDirectlyCount: 0,
  };
}

function addToAggregate(
  agg: BinderRowAggregate,
  row: { status: MasterGapStatus; canPlaceDirectly: boolean },
): void {
  if (row.status === 'blank_slot') return;
  agg.totalTargetSlots += 1;
  if (row.canPlaceDirectly) agg.canPlaceDirectlyCount += 1;
  switch (row.status) {
    case 'complete':
      agg.complete += 1;
      break;
    case 'missing':
      agg.missing += 1;
      break;
    case 'owned_unplaced':
      agg.ownedUnplaced += 1;
      break;
    case 'wishlist_wanted':
      agg.wishlistWanted += 1;
      break;
    case 'wishlist_ordered':
      agg.wishlistOrdered += 1;
      break;
    case 'in_lot_unmaterialized':
      agg.inLotUnmaterialized += 1;
      break;
    case 'ambiguous_owned':
      agg.ambiguousOwned += 1;
      break;
    case 'invalid_assignment':
      agg.invalidAssignment += 1;
      break;
    case 'invalid_variant':
      agg.invalidVariant += 1;
      break;
    case 'unverified_variant_data':
      agg.unverifiedVariantData += 1;
      break;
  }
}

export function buildBinderSummary(
  binderId: string,
  binderName: string,
  rows: readonly MasterGapRow[],
): MasterGapBinderSummary {
  const agg = emptyAggregate();
  for (const row of rows) addToAggregate(agg, row);
  const completionPercent =
    agg.totalTargetSlots === 0
      ? 0
      : Math.round((agg.complete / agg.totalTargetSlots) * 100);
  const actionableCount =
    agg.missing +
    agg.ownedUnplaced +
    agg.wishlistWanted +
    agg.wishlistOrdered +
    agg.inLotUnmaterialized +
    agg.ambiguousOwned +
    agg.invalidAssignment +
    agg.invalidVariant +
    agg.unverifiedVariantData;
  return {
    binderId,
    binderName,
    totalTargetSlots: agg.totalTargetSlots,
    complete: agg.complete,
    missing: agg.missing,
    ownedUnplaced: agg.ownedUnplaced,
    wishlistWanted: agg.wishlistWanted,
    wishlistOrdered: agg.wishlistOrdered,
    inLotUnmaterialized: agg.inLotUnmaterialized,
    ambiguousOwned: agg.ambiguousOwned,
    invalidAssignment: agg.invalidAssignment,
    invalidVariant: agg.invalidVariant,
    unverifiedVariantData: agg.unverifiedVariantData,
    completionPercent,
    actionableCount,
    canPlaceDirectlyCount: agg.canPlaceDirectlyCount,
  };
}

export function buildDashboardSummary(
  binders: readonly MasterGapBinderSummary[],
  generatedAt: IsoTimestamp,
): MasterGapDashboardSummary {
  if (binders.length === 0) {
    return {
      generatedAt,
      binderCount: 0,
      totalTargetSlots: 0,
      complete: 0,
      missing: 0,
      ownedUnplaced: 0,
      wishlistWanted: 0,
      wishlistOrdered: 0,
      inLotUnmaterialized: 0,
      invalidCount: 0,
      canPlaceDirectlyCount: 0,
      averageCompletionPercent: 0,
      closestBinder: null,
      weakestBinder: null,
      binders: [],
    };
  }
  let totalTargetSlots = 0;
  let complete = 0;
  let missing = 0;
  let ownedUnplaced = 0;
  let wishlistWanted = 0;
  let wishlistOrdered = 0;
  let inLotUnmaterialized = 0;
  let invalidCount = 0;
  let canPlaceDirectlyCount = 0;
  let percentSum = 0;
  for (const b of binders) {
    totalTargetSlots += b.totalTargetSlots;
    complete += b.complete;
    missing += b.missing;
    ownedUnplaced += b.ownedUnplaced;
    wishlistWanted += b.wishlistWanted;
    wishlistOrdered += b.wishlistOrdered;
    inLotUnmaterialized += b.inLotUnmaterialized;
    invalidCount += b.invalidAssignment + b.invalidVariant;
    canPlaceDirectlyCount += b.canPlaceDirectlyCount;
    percentSum += b.completionPercent;
  }
  // Closest = highest completion %, but only among binders that
  // actually have target slots and aren't yet at 100%. Weakest =
  // lowest completion % among binders that have target slots.
  // Skipping zero-target binders avoids surfacing an empty placeholder
  // binder as "the weakest".
  const withTargets = binders.filter((b) => b.totalTargetSlots > 0);
  const closestCandidates = withTargets.filter(
    (b) => b.completionPercent < 100,
  );
  const closestBinder =
    closestCandidates.length > 0
      ? closestCandidates.reduce((best, b) =>
          b.completionPercent > best.completionPercent ? b : best,
        )
      : null;
  const weakestBinder =
    withTargets.length > 0
      ? withTargets.reduce((worst, b) =>
          b.completionPercent < worst.completionPercent ? b : worst,
        )
      : null;
  const averageCompletionPercent = Math.round(percentSum / binders.length);
  return {
    generatedAt,
    binderCount: binders.length,
    totalTargetSlots,
    complete,
    missing,
    ownedUnplaced,
    wishlistWanted,
    wishlistOrdered,
    inLotUnmaterialized,
    invalidCount,
    canPlaceDirectlyCount,
    averageCompletionPercent,
    closestBinder,
    weakestBinder,
    binders,
  };
}

// ---------------------------------------------------------------------
// Display helpers (Norwegian labels)

export const STATUS_LABEL_NB: Record<MasterGapStatus, string> = {
  complete: 'Fullført',
  missing: 'Mangler',
  owned_unplaced: 'Eier, ikke plassert',
  wishlist_wanted: 'Ønsket',
  wishlist_ordered: 'Bestilt',
  in_lot_unmaterialized: 'I lot',
  ambiguous_owned: 'Flere mulige holdings',
  invalid_assignment: 'Feilplassert',
  invalid_variant: 'Feil variant',
  unverified_variant_data: 'Mangler variantdata',
  blank_slot: 'Blank slot',
};
