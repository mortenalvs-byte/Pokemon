// PR 23 — global search service. Pure card-cache search with
// lightweight ownership / wishlist / binder / lot badges so the UI can
// render a results dropdown without N+1 queries.
//
// Search source:
//   - Primary: cards-cache (PR 21).
//   - Set context: sets-cache so set-name + number queries match.
//   - cardMatchesQuery (PR 15A — F-6) is reused unchanged so the global
//     search obeys exactly the same rules as Browse / Collection /
//     Wishlist. No drift, no surprise behaviour.
//
// Badges:
//   For each result we attach four booleans:
//     - owned         — at least one live holding for this cardId
//     - activeWishlist — at least one live wishlist row with
//                        status ∈ {wanted, ordered}
//     - inBinder      — at least one live binder slot whose
//                        targetCardId === cardId, OR whose holdingId
//                        points to a live holding for cardId
//     - inLot         — at least one live lot-item for cardId
//   The boolean indexes are built ONCE per search call from the live
//   tables; per-result lookup is O(1) via the same Set/Map. Callers
//   that want full per-card aggregations should use card-status-
//   service.
//
// Ranking:
//   1. Exact `card.id` match (case-insensitive).
//   2. Owned cards get a boost.
//   3. Active wishlist cards get a (smaller) boost.
//   4. Compound queries (`<rest> <number>`) score above plain substring
//      matches so "Charizard 4" doesn't lose to a card with "4" in the
//      number when the user clearly meant a specific row.
//   5. Set release date desc.
//   6. card.number asc as a deterministic tie-breaker.

import { cardMatchesQuery, isEmptyQuery, normalizeQuery } from '../domain/card-search';
import { isActiveWishlistStatus } from '../domain/wishlist-status';
import { getCachedCardList, getCachedSetList } from '../db/cards-cache';
import type {
  CardRecord,
  SetRecord,
} from '../domain/types';
import type { PokemonTrackerDB } from '../db/database';

export const DEFAULT_GLOBAL_SEARCH_LIMIT = 20;
export const EXPANDED_GLOBAL_SEARCH_LIMIT = 100;

export interface GlobalSearchBadges {
  readonly owned: boolean;
  readonly activeWishlist: boolean;
  readonly inBinder: boolean;
  readonly inLot: boolean;
}

export interface GlobalSearchResult {
  readonly card: CardRecord;
  readonly set: SetRecord | null;
  readonly badges: GlobalSearchBadges;
  readonly rank: number;
}

export interface GlobalSearchOptions {
  /** Default `DEFAULT_GLOBAL_SEARCH_LIMIT` (20). Caller can pass `EXPANDED_GLOBAL_SEARCH_LIMIT` (100) for "vis flere". */
  readonly limit?: number;
}

export async function searchGlobalCards(
  db: PokemonTrackerDB,
  query: string,
  options: GlobalSearchOptions = {},
): Promise<GlobalSearchResult[]> {
  if (isEmptyQuery(query)) return [];

  const limit = options.limit ?? DEFAULT_GLOBAL_SEARCH_LIMIT;

  // Cards + sets via PR 21 cache. Holdings / wishlist / binderSlots /
  // lotItems are read once each (no per-card queries).
  const [cards, sets, holdings, wishlist, binderSlots, lotItems] = await Promise.all([
    getCachedCardList(db),
    getCachedSetList(db),
    db.holdings.toArray(),
    db.wishlist.toArray(),
    db.binderSlots.toArray(),
    db.lotItems.toArray(),
  ]);

  const setsById = new Map<string, SetRecord>();
  for (const set of sets) setsById.set(set.id, set);

  // Build O(1) badge indexes. Live filter applied here so we don't
  // count soft-deleted rows.
  const ownedCardIds = new Set<string>();
  const liveHoldingIdToCardId = new Map<string, string>();
  for (const h of holdings) {
    if (h.deletedAt !== null) continue;
    ownedCardIds.add(h.cardId);
    liveHoldingIdToCardId.set(h.id, h.cardId);
  }
  const activeWishlistCardIds = new Set<string>();
  for (const w of wishlist) {
    if (w.deletedAt !== null) continue;
    if (!isActiveWishlistStatus(w.status)) continue;
    activeWishlistCardIds.add(w.cardId);
  }
  const binderCardIds = new Set<string>();
  for (const slot of binderSlots) {
    if (slot.deletedAt !== null) continue;
    if (slot.targetCardId !== null) binderCardIds.add(slot.targetCardId);
    if (slot.holdingId !== null) {
      const cid = liveHoldingIdToCardId.get(slot.holdingId);
      if (cid !== undefined) binderCardIds.add(cid);
    }
  }
  // Only flag `inLot` for UNMATERIALISED items so the badge matches
  // what the status panel shows under "Ufordelte lot-items". Once an
  // item has a holdingId, it's already in the collection and Eid/Perm
  // cover its location.
  const lotCardIds = new Set<string>();
  for (const item of lotItems) {
    if (item.deletedAt !== null) continue;
    if (item.holdingId !== null) continue;
    lotCardIds.add(item.cardId);
  }

  const normalized = normalizeQuery(query);
  const compoundShape = isCompoundQuery(normalized);

  const matches: GlobalSearchResult[] = [];
  for (const card of cards) {
    if (!cardMatchesQuery(card, query, { setsById })) continue;
    const badges: GlobalSearchBadges = {
      owned: ownedCardIds.has(card.id),
      activeWishlist: activeWishlistCardIds.has(card.id),
      inBinder: binderCardIds.has(card.id),
      inLot: lotCardIds.has(card.id),
    };
    const rank = scoreResult(card, setsById, normalized, compoundShape, badges);
    matches.push({
      card,
      set: setsById.get(card.setId) ?? null,
      badges,
      rank,
    });
  }

  matches.sort((a, b) => {
    if (a.rank !== b.rank) return b.rank - a.rank;
    // Deterministic tie-breakers: set release date desc, then card
    // number asc.
    const aDate = a.set?.releaseDate ?? '';
    const bDate = b.set?.releaseDate ?? '';
    if (aDate !== bDate) return aDate < bDate ? 1 : -1;
    return compareCardNumber(a.card.number, b.card.number);
  });

  return matches.slice(0, limit);
}

// ---------------------------------------------------------------------
// Scoring

function scoreResult(
  card: CardRecord,
  setsById: ReadonlyMap<string, SetRecord>,
  normalized: string,
  compound: boolean,
  badges: GlobalSearchBadges,
): number {
  let score = 0;
  if (card.id.toLowerCase() === normalized) {
    score += 1000;
  }
  if (compound) score += 200;
  if (badges.owned) score += 60;
  if (badges.activeWishlist) score += 30;
  if (badges.inBinder) score += 10;
  if (badges.inLot) score += 5;
  // Mild bonus when the substring matches the card name from the
  // start, to surface "Charizard" before "Mega Charizard".
  if (card.name.toLowerCase().startsWith(normalized)) score += 25;
  // Newer sets first, but capped so it never beats id-match.
  const set = setsById.get(card.setId);
  if (set !== undefined) {
    score += yearScoreFromIso(set.releaseDate);
  }
  return score;
}

function yearScoreFromIso(iso: string): number {
  const year = Number.parseInt(iso.slice(0, 4), 10);
  if (!Number.isFinite(year)) return 0;
  // 2026 → 26, 1999 → -1 (cap so old sets don't dominate id-match).
  return Math.max(-25, Math.min(40, year - 2000));
}

function isCompoundQuery(normalized: string): boolean {
  const tokens = normalized.split(' ');
  if (tokens.length < 2) return false;
  const last = tokens[tokens.length - 1];
  if (last === undefined) return false;
  return /^\d+(\/\d+)?$/.test(last) || /^[a-z]+\d+$/.test(last);
}

function compareCardNumber(a: string, b: string): number {
  const an = Number.parseInt(a, 10);
  const bn = Number.parseInt(b, 10);
  if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) {
    return an - bn;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}
