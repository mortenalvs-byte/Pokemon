// Browse service. Joins `cards` and `sets`, applies filter / sort /
// pagination, and returns rows with the matching set already resolved
// so the view does not have to do per-row lookups (no N+1).
//
// Notes on performance and honesty:
//   - This service reads cards and sets from IndexedDB. With 20 000
//     cards in the cache, an unfiltered call loads them into memory
//     once per query. That is acceptable for MVP — see the comment on
//     `paginateAll`.
//   - Substring search is case-insensitive in-memory. We do not pretend
//     this is index-driven; a normalized search index would be a later
//     schema PR.
//   - Sort by "value" is intentionally NOT supported here. The view
//     does not expose it as an option until pricing extraction is
//     wired into the user-data layer (later PR).

import type { CardRecord, SetRecord } from '../domain/types';
import type { CardsRepo } from '../repositories/cards-repo';
import type { SetsRepo } from '../repositories/sets-repo';

export type BrowseSort = 'set-release' | 'name' | 'rarity' | 'set-number';
export type SortDirection = 'asc' | 'desc';
export type BrowsePageSize = 25 | 50 | 100;

export interface BrowseCriteria {
  /** Free-text substring (matched against card name, case-insensitive). */
  readonly search?: string;
  readonly setId?: string;
  readonly rarity?: string;
  readonly sort: BrowseSort;
  readonly sortDirection: SortDirection;
  /** Zero-indexed. */
  readonly page: number;
  readonly pageSize: BrowsePageSize;
}

export interface BrowseCardRow {
  readonly card: CardRecord;
  readonly set: SetRecord | null;
}

export interface BrowseResult {
  readonly rows: readonly BrowseCardRow[];
  readonly total: number;
}

export interface BrowseService {
  browse(criteria: BrowseCriteria): Promise<BrowseResult>;
  countTotalCards(): Promise<number>;
  listSetsForFilter(): Promise<SetRecord[]>;
  listRaritiesForFilter(): Promise<string[]>;
}

export function createBrowseService(
  cardsRepo: CardsRepo,
  setsRepo: SetsRepo,
): BrowseService {
  return {
    async browse(criteria) {
      const sets = await setsRepo.list();
      const setsById = buildSetsById(sets);
      const candidates = await selectCandidates(cardsRepo, criteria);
      const filtered = applyRemainingFilters(candidates, criteria);
      const sorted = sortCards(
        filtered,
        setsById,
        criteria.sort,
        criteria.sortDirection,
      );
      const total = sorted.length;
      const start = Math.max(0, criteria.page * criteria.pageSize);
      const slice = sorted.slice(start, start + criteria.pageSize);
      const rows: BrowseCardRow[] = slice.map((card) => ({
        card,
        set: setsById.get(card.setId) ?? null,
      }));
      return { rows, total };
    },

    async countTotalCards() {
      return cardsRepo.count();
    },

    async listSetsForFilter() {
      const sets = await setsRepo.list();
      return [...sets].sort(compareSetByReleaseDateDesc);
    },

    async listRaritiesForFilter() {
      const cards = await cardsRepo.list();
      const seen = new Set<string>();
      for (const card of cards) {
        if (card.rarity !== null && card.rarity.length > 0) {
          seen.add(card.rarity);
        }
      }
      return Array.from(seen).sort((a, b) => a.localeCompare(b));
    },
  };
}

// ---------------------------------------------------------------------
// Internals

function buildSetsById(sets: readonly SetRecord[]): Map<string, SetRecord> {
  const map = new Map<string, SetRecord>();
  for (const set of sets) {
    map.set(set.id, set);
  }
  return map;
}

async function selectCandidates(
  cardsRepo: CardsRepo,
  criteria: BrowseCriteria,
): Promise<CardRecord[]> {
  // Pick the most selective indexed filter as the candidate set.
  // Remaining predicates run in JS over a usually small list.
  if (isNonEmpty(criteria.setId)) {
    return cardsRepo.listBySet(criteria.setId);
  }
  if (isNonEmpty(criteria.rarity)) {
    return cardsRepo.listByRarity(criteria.rarity);
  }
  // No indexed filter — fall back to the full cache. See the file
  // header for the honesty caveat.
  return cardsRepo.list();
}

function applyRemainingFilters(
  cards: readonly CardRecord[],
  criteria: BrowseCriteria,
): CardRecord[] {
  const search = normalizeSearch(criteria.search);
  const rarity = isNonEmpty(criteria.rarity) ? criteria.rarity : null;
  const setId = isNonEmpty(criteria.setId) ? criteria.setId : null;

  const out: CardRecord[] = [];
  for (const card of cards) {
    if (rarity !== null && card.rarity !== rarity) continue;
    if (setId !== null && card.setId !== setId) continue;
    if (search !== null && !card.name.toLowerCase().includes(search)) continue;
    out.push(card);
  }
  return out;
}

function sortCards(
  cards: readonly CardRecord[],
  setsById: Map<string, SetRecord>,
  sort: BrowseSort,
  direction: SortDirection,
): CardRecord[] {
  const sign = direction === 'asc' ? 1 : -1;
  const copy = [...cards];

  copy.sort((a, b) => {
    let cmp = 0;
    switch (sort) {
      case 'set-release': {
        const aDate = setsById.get(a.setId)?.releaseDate ?? '';
        const bDate = setsById.get(b.setId)?.releaseDate ?? '';
        cmp = aDate < bDate ? -1 : aDate > bDate ? 1 : 0;
        if (cmp === 0) {
          // Tiebreak by card number ascending so a single set's cards
          // come out in printed order, regardless of the desc on dates.
          cmp = compareCardNumbersAscending(a.number, b.number);
          // Card-number tiebreak ignores `sign` — within a set, the
          // natural order is always 1, 2, 3, ...
          return cmp;
        }
        break;
      }
      case 'name':
        cmp = a.name.localeCompare(b.name);
        break;
      case 'rarity':
        cmp = (a.rarity ?? '').localeCompare(b.rarity ?? '');
        break;
      case 'set-number':
        cmp = compareCardNumbersAscending(a.number, b.number);
        break;
    }
    return cmp * sign;
  });

  return copy;
}

function compareCardNumbersAscending(a: string, b: string): number {
  const aNum = Number.parseInt(a, 10);
  const bNum = Number.parseInt(b, 10);
  const aIsNum = Number.isFinite(aNum);
  const bIsNum = Number.isFinite(bNum);
  if (aIsNum && bIsNum && aNum !== bNum) {
    return aNum - bNum;
  }
  if (aIsNum && !bIsNum) return -1;
  if (!aIsNum && bIsNum) return 1;
  return a.localeCompare(b);
}

function compareSetByReleaseDateDesc(a: SetRecord, b: SetRecord): number {
  if (a.releaseDate < b.releaseDate) return 1;
  if (a.releaseDate > b.releaseDate) return -1;
  return 0;
}

function normalizeSearch(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function isNonEmpty(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}
