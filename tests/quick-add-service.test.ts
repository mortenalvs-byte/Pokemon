// PR 23 — shared Quick Add helper. Tests pure behaviour: eligibility
// gate, repo write, receive-candidate lookup. No DOM, no dialog.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  QuickAddNotEligibleError,
  quickAddRawCard,
} from '../src/services/quick-add-service';
import { createHoldingsRepo } from '../src/repositories/holdings-repo';
import { createWishlistRepo } from '../src/repositories/wishlist-repo';
import { closeAndDelete, freshDb } from './helpers/fresh-db';
import { makeCard, makeUnverifiedCard } from './helpers/cards';
import type { PokemonTrackerDB } from '../src/db/database';

describe('quick-add-service (PR 23)', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    db = await freshDb();
  });

  afterEach(async () => {
    await closeAndDelete(db);
  });

  it('upserts a raw NM holding with verified defaults', async () => {
    const card = makeCard('base1-4');
    await db.cards.put(card);
    const holdingsRepo = createHoldingsRepo(db);
    const wishlistRepo = createWishlistRepo(db);

    const { result, receiveCandidates } = await quickAddRawCard(
      { holdingsRepo, wishlistRepo },
      card,
    );
    expect(result.action).toBe('created');
    expect(result.holding.cardId).toBe('base1-4');
    expect(result.holding.conditionType).toBe('raw');
    expect(result.holding.rawCondition).toBe('NM');
    expect(result.holding.quantity).toBe(1);
    expect(receiveCandidates).toEqual([]);
  });

  it('quantity-merges on second call (same variant tuple)', async () => {
    const card = makeCard('base1-4');
    await db.cards.put(card);
    const holdingsRepo = createHoldingsRepo(db);
    const wishlistRepo = createWishlistRepo(db);

    const first = await quickAddRawCard(
      { holdingsRepo, wishlistRepo },
      card,
    );
    expect(first.result.action).toBe('created');
    const second = await quickAddRawCard(
      { holdingsRepo, wishlistRepo },
      card,
    );
    expect(second.result.action).toBe('merged');
    expect(second.result.holding.quantity).toBe(2);
    expect(second.result.previousQuantity).toBe(1);
  });

  it('throws QuickAddNotEligibleError on unverified cards', async () => {
    const card = makeUnverifiedCard('mystery-1');
    const holdingsRepo = createHoldingsRepo(db);
    const wishlistRepo = createWishlistRepo(db);

    await expect(
      quickAddRawCard({ holdingsRepo, wishlistRepo }, card),
    ).rejects.toBeInstanceOf(QuickAddNotEligibleError);
  });

  it('returns receive candidates when an active wishlist row matches', async () => {
    const card = makeCard('base1-4');
    await db.cards.put(card);
    const holdingsRepo = createHoldingsRepo(db);
    const wishlistRepo = createWishlistRepo(db);
    // Default decideQuickAdd → finish=normal, so seed wishlist with normal.
    await wishlistRepo.create({
      cardId: 'base1-4',
      finish: 'normal',
      priority: 'medium',
      targetCondition: null,
      targetPrice: null,
      targetCurrency: null,
      status: 'wanted',
      note: null,
    });
    const { receiveCandidates } = await quickAddRawCard(
      { holdingsRepo, wishlistRepo },
      card,
    );
    expect(receiveCandidates).toHaveLength(1);
    expect(receiveCandidates[0]?.matchType).toBe('exact');
  });

  it('returns no candidates when wishlist finish does not match', async () => {
    const card = makeCard('base1-4');
    await db.cards.put(card);
    const holdingsRepo = createHoldingsRepo(db);
    const wishlistRepo = createWishlistRepo(db);
    // Quick Add defaults to `normal`. Wishlist on `reverse_holo`
    // should NOT match — same gate as the rest of PR 22.
    await wishlistRepo.create({
      cardId: 'base1-4',
      finish: 'reverse_holo',
      priority: 'medium',
      targetCondition: null,
      targetPrice: null,
      targetCurrency: null,
      status: 'wanted',
      note: null,
    });
    const { receiveCandidates } = await quickAddRawCard(
      { holdingsRepo, wishlistRepo },
      card,
    );
    expect(receiveCandidates).toEqual([]);
  });

  it('ignores received/cancelled wishlist rows', async () => {
    const card = makeCard('base1-4');
    await db.cards.put(card);
    const holdingsRepo = createHoldingsRepo(db);
    const wishlistRepo = createWishlistRepo(db);
    const w = await wishlistRepo.create({
      cardId: 'base1-4',
      finish: 'normal',
      priority: 'medium',
      targetCondition: null,
      targetPrice: null,
      targetCurrency: null,
      status: 'wanted',
      note: null,
    });
    await wishlistRepo.update(w.id, { status: 'received' });
    const { receiveCandidates } = await quickAddRawCard(
      { holdingsRepo, wishlistRepo },
      card,
    );
    expect(receiveCandidates).toEqual([]);
  });
});
