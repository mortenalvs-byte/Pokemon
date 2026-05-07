// Lot read service. Joins a lot with its live items, the cached cards
// each item references, and any holdings that have already been
// materialised. Computes a derived status chip + the imbalance warning
// the detail view surfaces.
//
// Read-only. All writes go through `lot-service` or the existing repos.

import { round2 } from '../domain/lot-allocation';
import type {
  CardRecord,
  HoldingRecord,
  LotItemRecord,
  LotRecord,
} from '../domain/types';
import type { CardsRepo } from '../repositories/cards-repo';
import type { HoldingsRepo } from '../repositories/holdings-repo';
import type { LotItemsRepo } from '../repositories/lot-items-repo';
import type { LotsRepo } from '../repositories/lots-repo';

export type LotStatus = 'unallocated' | 'partial' | 'allocated' | 'materialized';

export interface LotSummary {
  readonly lot: LotRecord;
  readonly itemCount: number;
  readonly materializedCount: number;
  readonly unmaterializedCount: number;
  readonly allocatedTotal: number;
  /** lot.totalCost − allocatedTotal. Positive = under-allocated. */
  readonly allocationDifference: number;
  readonly status: LotStatus;
}

export interface LotDetail {
  readonly lot: LotRecord;
  readonly items: readonly LotItemRecord[];
  readonly cardsById: ReadonlyMap<string, CardRecord>;
  readonly holdingsById: ReadonlyMap<string, HoldingRecord>;
  readonly summary: LotSummary;
}

export interface LotDetailService {
  listSummaries(): Promise<LotSummary[]>;
  getDetail(lotId: string): Promise<LotDetail | null>;
}

export function createLotDetailService(
  lotsRepo: LotsRepo,
  lotItemsRepo: LotItemsRepo,
  holdingsRepo: HoldingsRepo,
  cardsRepo: CardsRepo,
): LotDetailService {
  return {
    async listSummaries() {
      const lots = await lotsRepo.listLive();
      if (lots.length === 0) return [];
      const allItems = await lotItemsRepo.list();
      const summaries: LotSummary[] = lots.map((lot) => {
        const items = allItems.filter(
          (i) => i.lotId === lot.id && i.deletedAt === null,
        );
        return summarise(lot, items);
      });
      summaries.sort((a, b) =>
        a.lot.purchaseDate < b.lot.purchaseDate
          ? 1
          : a.lot.purchaseDate > b.lot.purchaseDate
            ? -1
            : 0,
      );
      return summaries;
    },

    async getDetail(lotId) {
      const lot = await lotsRepo.get(lotId);
      if (lot === undefined || lot.deletedAt !== null) return null;

      const items = (await lotItemsRepo.listByLotId(lotId))
        .filter((i) => i.deletedAt === null)
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));

      const cardIds = new Set<string>();
      const holdingIds = new Set<string>();
      for (const item of items) {
        cardIds.add(item.cardId);
        if (item.holdingId !== null) holdingIds.add(item.holdingId);
      }

      const cards = await cardsRepo.list();
      const cardsById = new Map<string, CardRecord>();
      for (const c of cards) {
        if (cardIds.has(c.id)) cardsById.set(c.id, c);
      }

      // Materialised holdings remain even after they are soft-deleted
      // (so the detail view can flag the link with a strikethrough),
      // so we read all holdings, not just live ones.
      const holdings = await holdingsRepo.list();
      const holdingsById = new Map<string, HoldingRecord>();
      for (const h of holdings) {
        if (holdingIds.has(h.id)) holdingsById.set(h.id, h);
      }

      return {
        lot,
        items,
        cardsById,
        holdingsById,
        summary: summarise(lot, items),
      };
    },
  };
}

function summarise(lot: LotRecord, items: readonly LotItemRecord[]): LotSummary {
  const itemCount = items.length;
  const materializedCount = items.filter((i) => i.holdingId !== null).length;
  const unmaterializedCount = itemCount - materializedCount;
  const allocatedTotal = round2(
    items.reduce((acc, i) => acc + (i.allocatedCost ?? 0), 0),
  );
  const allocationDifference = round2(lot.totalCost - allocatedTotal);

  let status: LotStatus;
  if (itemCount === 0) {
    status = 'unallocated';
  } else if (materializedCount === itemCount) {
    status = 'materialized';
  } else if (
    items.every((i) => i.allocatedCost !== null) &&
    Math.abs(allocationDifference) <= 0.01
  ) {
    status = 'allocated';
  } else if (items.some((i) => i.allocatedCost !== null)) {
    status = 'partial';
  } else {
    status = 'unallocated';
  }

  return {
    lot,
    itemCount,
    materializedCount,
    unmaterializedCount,
    allocatedTotal,
    allocationDifference,
    status,
  };
}
