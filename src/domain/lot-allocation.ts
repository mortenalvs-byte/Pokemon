// Pure cost-allocation engine for bulk lot purchases.
//
// Three modes (locked by KRAVSPEC, no other modes in MVP):
//
//   - equal:
//       totalCost / candidateCount, rounded to two decimals; the LAST
//       candidate absorbs the residual so `sum(allocatedCost)` lands
//       exactly on totalCost.
//
//   - weighted_by_market_price:
//       allocate proportionally to each candidate's `marketEstimate`.
//       Candidates with null/zero market value get 0 allocated. The
//       last candidate with a non-zero estimate absorbs the residual.
//       If every candidate has null/zero market estimate, the engine
//       errors — the user must switch to equal or manual.
//
//   - manual:
//       allocate from `manualPriceOverride` per candidate. Missing
//       overrides are an error. If the manual sum differs from
//       totalCost by more than `MANUAL_TOLERANCE`, the engine emits
//       a warning but still returns allocations (the user may have
//       deliberately paid extra for shipping etc.).
//
// The engine expects callers (the lot service) to pre-filter candidates:
//   - soft-deleted items excluded
//   - already-materialized items (holdingId !== null) excluded
//
// The engine never reads or writes IndexedDB. It does no currency
// conversion. All amounts are in `lot.currency`.

import type {
  AllocationMethod,
  CurrencyCode,
  LotItemRecord,
} from './types';

const MANUAL_TOLERANCE = 0.01;

export type AllocationStatus = 'ok' | 'warning' | 'error';

export interface AllocationLine {
  readonly itemId: string;
  readonly allocatedCost: number;
}

export interface AllocationResult {
  readonly status: AllocationStatus;
  readonly allocations: readonly AllocationLine[];
  readonly totalAllocated: number;
  /** `totalCost - totalAllocated`. Positive = under-allocated. */
  readonly residual: number;
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
}

export interface AllocateLotInput {
  readonly totalCost: number;
  readonly allocationMethod: AllocationMethod;
  readonly currency: CurrencyCode;
}

export function allocateLot(
  lot: AllocateLotInput,
  candidates: readonly LotItemRecord[],
): AllocationResult {
  if (candidates.length === 0) {
    return {
      status: 'ok',
      allocations: [],
      totalAllocated: 0,
      residual: lot.totalCost,
      warnings: ['Lot has no items to allocate'],
      errors: [],
    };
  }

  if (lot.totalCost < 0) {
    return {
      status: 'error',
      allocations: [],
      totalAllocated: 0,
      residual: 0,
      warnings: [],
      errors: ['Lot totalCost cannot be negative'],
    };
  }

  switch (lot.allocationMethod) {
    case 'equal':
      return allocateEqual(lot, candidates);
    case 'weighted_by_market_price':
      return allocateWeighted(lot, candidates);
    case 'manual':
      return allocateManual(lot, candidates);
  }
}

// ---------------------------------------------------------------------
// equal

function allocateEqual(
  lot: AllocateLotInput,
  candidates: readonly LotItemRecord[],
): AllocationResult {
  const baseShare = round2(lot.totalCost / candidates.length);
  const allocations: AllocationLine[] = candidates.map((c) => ({
    itemId: c.id,
    allocatedCost: baseShare,
  }));
  // Residual goes on the last candidate so the sum hits totalCost
  // exactly. With 3 items and totalCost=100 this turns
  // 33.33 / 33.33 / 33.33 (sum 99.99) into 33.33 / 33.33 / 33.34.
  const sumBeforeResidual = round2(baseShare * candidates.length);
  const residual = round2(lot.totalCost - sumBeforeResidual);
  const lastIndex = allocations.length - 1;
  if (residual !== 0 && lastIndex >= 0) {
    const last = allocations[lastIndex];
    if (last !== undefined) {
      allocations[lastIndex] = {
        itemId: last.itemId,
        allocatedCost: round2(last.allocatedCost + residual),
      };
    }
  }
  const totalAllocated = sumAllocations(allocations);
  return {
    status: 'ok',
    allocations,
    totalAllocated,
    residual: round2(lot.totalCost - totalAllocated),
    warnings: [],
    errors: [],
  };
}

// ---------------------------------------------------------------------
// weighted

function allocateWeighted(
  lot: AllocateLotInput,
  candidates: readonly LotItemRecord[],
): AllocationResult {
  const sumMarket = candidates.reduce(
    (acc, c) => acc + (c.marketEstimate ?? 0),
    0,
  );
  if (sumMarket <= 0) {
    return {
      status: 'error',
      allocations: candidates.map((c) => ({ itemId: c.id, allocatedCost: 0 })),
      totalAllocated: 0,
      residual: lot.totalCost,
      warnings: [],
      errors: [
        'All market estimates are zero or missing — switch to equal or manual',
      ],
    };
  }

  let lastNonZeroIndex = -1;
  const allocations: AllocationLine[] = candidates.map((c, idx) => {
    const market = c.marketEstimate ?? 0;
    if (market <= 0) {
      return { itemId: c.id, allocatedCost: 0 };
    }
    lastNonZeroIndex = idx;
    return {
      itemId: c.id,
      allocatedCost: round2((market / sumMarket) * lot.totalCost),
    };
  });

  const sumBeforeResidual = sumAllocations(allocations);
  const residual = round2(lot.totalCost - sumBeforeResidual);
  if (residual !== 0 && lastNonZeroIndex >= 0) {
    const last = allocations[lastNonZeroIndex];
    if (last !== undefined) {
      allocations[lastNonZeroIndex] = {
        itemId: last.itemId,
        allocatedCost: round2(last.allocatedCost + residual),
      };
    }
  }
  const totalAllocated = sumAllocations(allocations);
  return {
    status: 'ok',
    allocations,
    totalAllocated,
    residual: round2(lot.totalCost - totalAllocated),
    warnings: [],
    errors: [],
  };
}

// ---------------------------------------------------------------------
// manual

function allocateManual(
  lot: AllocateLotInput,
  candidates: readonly LotItemRecord[],
): AllocationResult {
  const errors: string[] = [];
  const allocations: AllocationLine[] = candidates.map((c) => {
    if (c.manualPriceOverride === null) {
      errors.push(`Item ${c.id} has no manual price override`);
      return { itemId: c.id, allocatedCost: 0 };
    }
    return { itemId: c.id, allocatedCost: round2(c.manualPriceOverride) };
  });

  if (errors.length > 0) {
    return {
      status: 'error',
      allocations,
      totalAllocated: sumAllocations(allocations),
      residual: round2(lot.totalCost - sumAllocations(allocations)),
      warnings: [],
      errors,
    };
  }

  const totalAllocated = sumAllocations(allocations);
  const diff = round2(totalAllocated - lot.totalCost);
  const warnings: string[] = [];
  if (Math.abs(diff) > MANUAL_TOLERANCE) {
    warnings.push(
      `Sum of manual prices (${totalAllocated.toFixed(2)} ${lot.currency}) ` +
        `differs from lot total (${lot.totalCost.toFixed(2)} ${lot.currency}) ` +
        `by ${diff.toFixed(2)}`,
    );
  }
  return {
    status: warnings.length > 0 ? 'warning' : 'ok',
    allocations,
    totalAllocated,
    residual: round2(lot.totalCost - totalAllocated),
    warnings,
    errors: [],
  };
}

// ---------------------------------------------------------------------
// helpers

export function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}

function sumAllocations(allocations: readonly AllocationLine[]): number {
  let sum = 0;
  for (const a of allocations) sum += a.allocatedCost;
  return round2(sum);
}
