// PR 22 — wishlist receive helper. Finds active wishlist entries that
// match a freshly-created/merged holding and offers the UI a way to
// flip them to `received`. The matching rule and the writes both live
// here so views (full holding form, Quick Add, Bulk Add, lot
// materialise, Card Detail, Wishlist) all behave identically.
//
// Match rule (PR 22 v1):
//   wishlist.cardId === holding.cardId
//   wishlist.finish === holding.finish
//   wishlist.status ∈ {wanted, ordered}
//   wishlist.deletedAt === null
//
// We do NOT match on edition because wishlist does not store one
// today; do NOT match on condition either, because wishlist stores
// `targetCondition` (raw) while holdings can be raw or graded. When
// the wishlist has a `targetCondition` and the holding is raw with a
// different rawCondition, we still surface it as a candidate — the
// user might want to receive the upgrade — but we tag it
// `condition_mismatch` so the UI can label / pre-uncheck it. The
// caller never auto-marks; this service only returns candidates.
//
// Sort order:
//   1. Active status: ordered first, wanted second.
//   2. Priority desc: grail > high > medium > low.
//   3. updatedAt desc (most recent first).
// The first hit is therefore the most "ready to close" candidate.
//
// Writes:
//   `markWishlistCandidatesReceived` goes through `wishlistRepo.update`
//   so the existing audit + variant validator path is preserved. We
//   do not touch `db.wishlist` directly. Returns the updated records
//   so callers can reflect the new state.

import type { HoldingRecord, WishlistRecord, WishlistPriority } from '../domain/types';
import type { WishlistRepo } from '../repositories/wishlist-repo';
import { isActiveWishlistStatus } from '../domain/wishlist-status';

export type ReceiveMatchType = 'exact' | 'condition_mismatch';

export interface WishlistReceiveCandidate {
  readonly wishlist: WishlistRecord;
  readonly matchType: ReceiveMatchType;
  /** Short human description, used by the UI tooltip / row note. */
  readonly reason: string;
}

const PRIORITY_RANK: Record<WishlistPriority, number> = {
  grail: 4,
  high: 3,
  medium: 2,
  low: 1,
};

export async function findWishlistReceiveCandidates(
  wishlistRepo: WishlistRepo,
  holding: HoldingRecord,
): Promise<WishlistReceiveCandidate[]> {
  const all = await wishlistRepo.listByCardId(holding.cardId);
  const candidates: WishlistReceiveCandidate[] = [];
  for (const wishlist of all) {
    if (wishlist.deletedAt !== null) continue;
    if (!isActiveWishlistStatus(wishlist.status)) continue;
    if (wishlist.finish !== holding.finish) continue;
    candidates.push(buildCandidate(wishlist, holding));
  }
  return sortCandidates(candidates);
}

/**
 * Batch helper for paths that create/merge several holdings at once
 * (Bulk Add, Lot Materialise). Deduplicates by `wishlist.id` so the
 * same wishlist row is never offered twice in one summary even when
 * multiple holdings independently match it.
 */
export async function findReceiveCandidatesForHoldings(
  wishlistRepo: WishlistRepo,
  holdings: readonly HoldingRecord[],
): Promise<WishlistReceiveCandidate[]> {
  const seen = new Map<string, WishlistReceiveCandidate>();
  for (const holding of holdings) {
    const found = await findWishlistReceiveCandidates(wishlistRepo, holding);
    for (const candidate of found) {
      // First-write-wins keeps the order stable when the same row
      // matches multiple holdings — sorting happens at the end.
      if (!seen.has(candidate.wishlist.id)) {
        seen.set(candidate.wishlist.id, candidate);
      }
    }
  }
  return sortCandidates([...seen.values()]);
}

export async function markWishlistCandidatesReceived(
  wishlistRepo: WishlistRepo,
  wishlistIds: readonly string[],
  reason?: string,
): Promise<WishlistRecord[]> {
  void reason; // not stored — repo.update audits the change itself.
  const updated: WishlistRecord[] = [];
  for (const id of wishlistIds) {
    const record = await wishlistRepo.update(id, { status: 'received' });
    updated.push(record);
  }
  return updated;
}

// ---------------------------------------------------------------------
// Internals

function buildCandidate(
  wishlist: WishlistRecord,
  holding: HoldingRecord,
): WishlistReceiveCandidate {
  const targetCondition = wishlist.targetCondition;
  if (
    targetCondition !== null &&
    holding.conditionType === 'raw' &&
    holding.rawCondition !== null &&
    holding.rawCondition !== targetCondition
  ) {
    return {
      wishlist,
      matchType: 'condition_mismatch',
      reason: `Måltilstand ${targetCondition}, men holding er ${holding.rawCondition}.`,
    };
  }
  return {
    wishlist,
    matchType: 'exact',
    reason: `Match på kort + finish (${wishlist.finish}).`,
  };
}

function sortCandidates(
  candidates: readonly WishlistReceiveCandidate[],
): WishlistReceiveCandidate[] {
  return [...candidates].sort((a, b) => {
    // 1. ordered before wanted.
    if (a.wishlist.status !== b.wishlist.status) {
      if (a.wishlist.status === 'ordered') return -1;
      if (b.wishlist.status === 'ordered') return 1;
    }
    // 2. priority desc.
    const aRank = PRIORITY_RANK[a.wishlist.priority];
    const bRank = PRIORITY_RANK[b.wishlist.priority];
    if (aRank !== bRank) return bRank - aRank;
    // 3. updatedAt desc.
    if (a.wishlist.updatedAt !== b.wishlist.updatedAt) {
      return a.wishlist.updatedAt < b.wishlist.updatedAt ? 1 : -1;
    }
    return 0;
  });
}
