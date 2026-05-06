// Collection service. Joins `holdings` with `cards` and `sets` for the
// Collection view, applies filters / sort / pagination, and returns
// rows with the card + set already resolved (no N+1 lookups).
//
// All reads — no writes. Mutations stay in the form / view code paths
// and go through `holdingsRepo` so repo validation and audit run.

import type {
  CardRecord,
  HoldingRecord,
  HoldingStatus,
  RawCondition,
  SetRecord,
  ConditionType,
} from '../domain/types';
import type { CardsRepo } from '../repositories/cards-repo';
import type { HoldingsRepo } from '../repositories/holdings-repo';
import type { SetsRepo } from '../repositories/sets-repo';

export type CollectionSort =
  | 'updated'
  | 'name'
  | 'set-release'
  | 'condition'
  | 'value';
export type SortDirection = 'asc' | 'desc';
export type CollectionPageSize = 25 | 50 | 100;

export interface CollectionFilters {
  readonly conditionType?: ConditionType;
  readonly rawCondition?: RawCondition;
  readonly setId?: string;
  readonly status?: HoldingStatus;
  readonly missingCondition?: boolean;
  readonly missingValue?: boolean;
  readonly showDeleted?: boolean;
  readonly search?: string;
}

export interface CollectionCriteria extends CollectionFilters {
  readonly sort: CollectionSort;
  readonly sortDirection: SortDirection;
  readonly page: number;
  readonly pageSize: CollectionPageSize;
}

export interface CollectionRow {
  readonly holding: HoldingRecord;
  readonly card: CardRecord | null;
  readonly set: SetRecord | null;
}

export interface CollectionResult {
  readonly rows: readonly CollectionRow[];
  readonly total: number;
  readonly liveTotal: number;
  readonly deletedTotal: number;
}

export interface CollectionService {
  list(criteria: CollectionCriteria): Promise<CollectionResult>;
  listForCard(cardId: string): Promise<CollectionRow[]>;
}

export function createCollectionService(
  holdingsRepo: HoldingsRepo,
  cardsRepo: CardsRepo,
  setsRepo: SetsRepo,
): CollectionService {
  return {
    async list(criteria) {
      const all = await holdingsRepo.list();
      const liveTotal = all.filter((h) => h.deletedAt === null).length;
      const deletedTotal = all.length - liveTotal;

      const cards = await cardsRepo.list();
      const sets = await setsRepo.list();
      const cardsById = buildIndex(cards, (c) => c.id);
      const setsById = buildIndex(sets, (s) => s.id);

      const filtered = applyFilters(all, criteria, cardsById);
      const searched = applySearch(filtered, cardsById, criteria.search);
      const sorted = sortHoldings(
        searched,
        cardsById,
        setsById,
        criteria.sort,
        criteria.sortDirection,
      );

      const total = sorted.length;
      const start = Math.max(0, criteria.page * criteria.pageSize);
      const slice = sorted.slice(start, start + criteria.pageSize);
      const rows: CollectionRow[] = slice.map((holding) => ({
        holding,
        card: cardsById.get(holding.cardId) ?? null,
        set: getSetForHolding(holding, cardsById, setsById),
      }));

      return { rows, total, liveTotal, deletedTotal };
    },

    async listForCard(cardId) {
      const all = await holdingsRepo.listByCardId(cardId);
      // Sort: live first, deleted at the bottom; within a group, by
      // most recent update first.
      const sorted = [...all].sort((a, b) => {
        const aDeleted = a.deletedAt !== null;
        const bDeleted = b.deletedAt !== null;
        if (aDeleted !== bDeleted) {
          return aDeleted ? 1 : -1;
        }
        return a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0;
      });
      const card = (await cardsRepo.get(cardId)) ?? null;
      const set = card !== null ? ((await setsRepo.get(card.setId)) ?? null) : null;
      return sorted.map((holding) => ({ holding, card, set }));
    },
  };
}

// ---------------------------------------------------------------------
// Internals

function applyFilters(
  all: readonly HoldingRecord[],
  criteria: CollectionFilters,
  cardsById: Map<string, CardRecord>,
): HoldingRecord[] {
  const showDeleted = criteria.showDeleted === true;
  return all.filter((h) => {
    // Deleted toggle: false (default) = only live, true = only deleted.
    if (!showDeleted && h.deletedAt !== null) return false;
    if (showDeleted && h.deletedAt === null) return false;

    if (criteria.conditionType !== undefined && h.conditionType !== criteria.conditionType) {
      return false;
    }
    if (criteria.rawCondition !== undefined && h.rawCondition !== criteria.rawCondition) {
      return false;
    }
    if (criteria.status !== undefined && h.status !== criteria.status) {
      return false;
    }
    if (criteria.setId !== undefined && criteria.setId.length > 0) {
      const card = cardsById.get(h.cardId);
      if (card === undefined || card.setId !== criteria.setId) {
        return false;
      }
    }
    if (criteria.missingCondition === true) {
      const isMissing =
        h.conditionType === 'raw' &&
        (h.rawCondition === null || h.rawCondition === 'UNKNOWN');
      if (!isMissing) return false;
    }
    if (criteria.missingValue === true) {
      const noValue = h.estimatedValue === null || h.valueSource === 'unknown';
      if (!noValue) return false;
    }
    return true;
  });
}

function applySearch(
  holdings: readonly HoldingRecord[],
  cardsById: Map<string, CardRecord>,
  search: string | undefined,
): HoldingRecord[] {
  const normalized =
    search === undefined ? null : search.trim().toLowerCase();
  if (normalized === null || normalized.length === 0) {
    return [...holdings];
  }
  return holdings.filter((h) => {
    const card = cardsById.get(h.cardId);
    if (card === undefined) return false;
    return card.name.toLowerCase().includes(normalized);
  });
}

function sortHoldings(
  holdings: readonly HoldingRecord[],
  cardsById: Map<string, CardRecord>,
  setsById: Map<string, SetRecord>,
  sort: CollectionSort,
  direction: SortDirection,
): HoldingRecord[] {
  const sign = direction === 'asc' ? 1 : -1;
  const copy = [...holdings];
  copy.sort((a, b) => {
    let cmp = 0;
    switch (sort) {
      case 'updated':
        cmp = a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0;
        break;
      case 'name': {
        const an = cardsById.get(a.cardId)?.name ?? '';
        const bn = cardsById.get(b.cardId)?.name ?? '';
        cmp = an.localeCompare(bn);
        break;
      }
      case 'set-release': {
        const aSetId = cardsById.get(a.cardId)?.setId ?? '';
        const bSetId = cardsById.get(b.cardId)?.setId ?? '';
        const aDate = setsById.get(aSetId)?.releaseDate ?? '';
        const bDate = setsById.get(bSetId)?.releaseDate ?? '';
        cmp = aDate < bDate ? -1 : aDate > bDate ? 1 : 0;
        break;
      }
      case 'condition': {
        cmp = (a.rawCondition ?? '').localeCompare(b.rawCondition ?? '');
        break;
      }
      case 'value': {
        const av = a.estimatedValue ?? -Infinity;
        const bv = b.estimatedValue ?? -Infinity;
        cmp = av < bv ? -1 : av > bv ? 1 : 0;
        break;
      }
    }
    return cmp * sign;
  });
  return copy;
}

function getSetForHolding(
  holding: HoldingRecord,
  cardsById: Map<string, CardRecord>,
  setsById: Map<string, SetRecord>,
): SetRecord | null {
  const card = cardsById.get(holding.cardId);
  if (card === undefined) return null;
  return setsById.get(card.setId) ?? null;
}

function buildIndex<T, K>(items: readonly T[], keyOf: (item: T) => K): Map<K, T> {
  const map = new Map<K, T>();
  for (const item of items) {
    map.set(keyOf(item), item);
  }
  return map;
}
