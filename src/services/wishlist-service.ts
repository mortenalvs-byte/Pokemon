// Wishlist service. Joins `wishlist` with `cards` and `sets` for the
// Wishlist view, applies filters / sort / pagination, and returns rows
// with the card + set already resolved (no N+1 lookups).
//
// Read-only. All wishlist mutations stay in the form / view code paths
// and go through `wishlistRepo` so repo validation + audit run.

import { cardMatchesQuery, isEmptyQuery } from '../domain/card-search';
import type {
  CardRecord,
  SetRecord,
  WishlistPriority,
  WishlistRecord,
  WishlistStatus,
} from '../domain/types';
import type { CardsRepo } from '../repositories/cards-repo';
import type { SetsRepo } from '../repositories/sets-repo';
import type { WishlistRepo } from '../repositories/wishlist-repo';

export type WishlistSort = 'priority' | 'name' | 'set-release' | 'updated';
export type SortDirection = 'asc' | 'desc';
export type WishlistPageSize = 25 | 50 | 100;

export interface WishlistFilters {
  readonly status?: WishlistStatus;
  readonly priority?: WishlistPriority;
  readonly setId?: string;
  readonly search?: string;
  readonly showDeleted?: boolean;
}

export interface WishlistCriteria extends WishlistFilters {
  readonly sort: WishlistSort;
  readonly sortDirection: SortDirection;
  readonly page: number;
  readonly pageSize: WishlistPageSize;
}

export interface WishlistRow {
  readonly wishlist: WishlistRecord;
  readonly card: CardRecord | null;
  readonly set: SetRecord | null;
}

export interface WishlistResult {
  readonly rows: readonly WishlistRow[];
  readonly total: number;
  readonly liveTotal: number;
  readonly deletedTotal: number;
  /**
   * PR 22 — counts per wishlist status across LIVE entries only.
   * Lets the view label "Aktive: X · Bestilt: Y · Mottatt: Z ·
   * Avbrutt: W · Slettede: D" without a second list call.
   * `received | cancelled` rows still count here even though they're
   * hidden from the active-flow.
   */
  readonly statusCounts: Record<WishlistStatus, number>;
  readonly activeTotal: number;
  readonly closedTotal: number;
}

export interface WishlistService {
  list(criteria: WishlistCriteria): Promise<WishlistResult>;
  listForCard(cardId: string): Promise<WishlistRow[]>;
}

// Used by the priority-desc default sort. `grail` highest, `low`
// lowest. The repo stores the string values; the numeric mapping
// lives only in the service.
const PRIORITY_RANK: Record<WishlistPriority, number> = {
  grail: 4,
  high: 3,
  medium: 2,
  low: 1,
};

export function createWishlistService(
  wishlistRepo: WishlistRepo,
  cardsRepo: CardsRepo,
  setsRepo: SetsRepo,
): WishlistService {
  return {
    async list(criteria) {
      const all = await wishlistRepo.list();
      const live = all.filter((w) => w.deletedAt === null);
      const liveTotal = live.length;
      const deletedTotal = all.length - liveTotal;
      const statusCounts: Record<WishlistStatus, number> = {
        wanted: 0,
        ordered: 0,
        received: 0,
        cancelled: 0,
      };
      for (const w of live) {
        statusCounts[w.status] += 1;
      }
      const activeTotal = statusCounts.wanted + statusCounts.ordered;
      const closedTotal = statusCounts.received + statusCounts.cancelled;

      const cards = await cardsRepo.list();
      const sets = await setsRepo.list();
      const cardsById = buildIndex(cards, (c) => c.id);
      const setsById = buildIndex(sets, (s) => s.id);

      const filtered = applyFilters(all, criteria, cardsById);
      const searched = applySearch(filtered, cardsById, setsById, criteria.search);
      const sorted = sortWishlist(
        searched,
        cardsById,
        setsById,
        criteria.sort,
        criteria.sortDirection,
      );

      const total = sorted.length;
      const start = Math.max(0, criteria.page * criteria.pageSize);
      const slice = sorted.slice(start, start + criteria.pageSize);
      const rows: WishlistRow[] = slice.map((wishlist) => ({
        wishlist,
        card: cardsById.get(wishlist.cardId) ?? null,
        set: getSetForCardId(wishlist.cardId, cardsById, setsById),
      }));

      return {
        rows,
        total,
        liveTotal,
        deletedTotal,
        statusCounts,
        activeTotal,
        closedTotal,
      };
    },

    async listForCard(cardId) {
      const all = await wishlistRepo.listByCardId(cardId);
      // Live first, deleted last; within group, most-recently updated
      // first.
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
      return sorted.map((wishlist) => ({ wishlist, card, set }));
    },
  };
}

// ---------------------------------------------------------------------
// Internals

function applyFilters(
  all: readonly WishlistRecord[],
  criteria: WishlistFilters,
  cardsById: Map<string, CardRecord>,
): WishlistRecord[] {
  const showDeleted = criteria.showDeleted === true;
  return all.filter((w) => {
    if (!showDeleted && w.deletedAt !== null) return false;
    if (showDeleted && w.deletedAt === null) return false;

    if (criteria.status !== undefined && w.status !== criteria.status) {
      return false;
    }
    if (criteria.priority !== undefined && w.priority !== criteria.priority) {
      return false;
    }
    if (criteria.setId !== undefined && criteria.setId.length > 0) {
      const card = cardsById.get(w.cardId);
      if (card === undefined || card.setId !== criteria.setId) return false;
    }
    return true;
  });
}

function applySearch(
  records: readonly WishlistRecord[],
  cardsById: Map<string, CardRecord>,
  setsById: Map<string, SetRecord>,
  search: string | undefined,
): WishlistRecord[] {
  if (search === undefined || isEmptyQuery(search)) {
    return [...records];
  }
  // PR 15A — F-6: shared `cardMatchesQuery` predicate.
  return records.filter((w) => {
    const card = cardsById.get(w.cardId);
    if (card === undefined) return false;
    return cardMatchesQuery(card, search, { setsById });
  });
}

function sortWishlist(
  records: readonly WishlistRecord[],
  cardsById: Map<string, CardRecord>,
  setsById: Map<string, SetRecord>,
  sort: WishlistSort,
  direction: SortDirection,
): WishlistRecord[] {
  const sign = direction === 'asc' ? 1 : -1;
  const copy = [...records];
  copy.sort((a, b) => {
    let cmp = 0;
    switch (sort) {
      case 'priority': {
        const aRank = PRIORITY_RANK[a.priority];
        const bRank = PRIORITY_RANK[b.priority];
        cmp = aRank - bRank;
        if (cmp === 0) {
          // Tiebreak by createdAt asc so older items are stable.
          cmp = a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
        }
        break;
      }
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
      case 'updated':
        cmp = a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0;
        break;
    }
    return cmp * sign;
  });
  return copy;
}

function getSetForCardId(
  cardId: string,
  cardsById: Map<string, CardRecord>,
  setsById: Map<string, SetRecord>,
): SetRecord | null {
  const card = cardsById.get(cardId);
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
