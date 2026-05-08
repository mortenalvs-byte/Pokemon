// PR 22 — wishlist receive service. Pure tests over a fresh DB. No
// UI, no router, no event-loop coupling. Each case is documented by
// what wishlist + holding state it sets up and what
// `findWishlistReceiveCandidates` / `markWishlistCandidatesReceived`
// must return.
//
// Match rule recap (see src/services/wishlist-receive-service.ts):
//   wishlist.cardId === holding.cardId
//   wishlist.finish === holding.finish
//   wishlist.status ∈ {wanted, ordered}
//   wishlist.deletedAt === null
//
// Sort order:
//   1. ordered before wanted
//   2. priority desc (grail > high > medium > low)
//   3. updatedAt desc

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  findReceiveCandidatesForHoldings,
  findWishlistReceiveCandidates,
  markWishlistCandidatesReceived,
} from '../src/services/wishlist-receive-service';
import { createHoldingsRepo } from '../src/repositories/holdings-repo';
import { createWishlistRepo } from '../src/repositories/wishlist-repo';
import type { HoldingRecord } from '../src/domain/types';
import type {
  HoldingInput,
  WishlistInput,
} from '../src/domain/validators';
import { closeAndDelete, freshDb } from './helpers/fresh-db';
import { makeCard } from './helpers/cards';
import type { PokemonTrackerDB } from '../src/db/database';

function holdingInput(overrides: Partial<HoldingInput> = {}): HoldingInput {
  return {
    cardId: 'base1-4',
    quantity: 1,
    conditionType: 'raw',
    rawCondition: 'NM',
    gradingCompany: null,
    grade: null,
    certNumber: null,
    certUrl: null,
    gradedDate: null,
    finish: 'holo',
    edition: 'unlimited',
    language: 'en',
    purchasePrice: null,
    purchaseCurrency: null,
    estimatedValue: null,
    valueCurrency: null,
    valueSource: 'unknown',
    valueNote: null,
    valueUpdatedAt: null,
    source: 'manual',
    note: null,
    specialVariant: false,
    tags: [],
    lotId: null,
    status: 'owned',
    ...overrides,
  };
}

function wishlistInput(overrides: Partial<WishlistInput> = {}): WishlistInput {
  return {
    cardId: 'base1-4',
    finish: 'holo',
    priority: 'medium',
    targetCondition: null,
    targetPrice: null,
    targetCurrency: null,
    status: 'wanted',
    note: null,
    ...overrides,
  };
}

describe('wishlist-receive-service (PR 22)', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    db = await freshDb();
    // Seed a card so the variant validator passes through every
    // wishlist / holding write.
    await db.cards.put(makeCard('base1-4'));
  });

  afterEach(async () => {
    await closeAndDelete(db);
  });

  it('no wishlist entries → no candidates', async () => {
    const holding = await createHoldingsRepo(db).create(holdingInput());
    const candidates = await findWishlistReceiveCandidates(
      createWishlistRepo(db),
      holding,
    );
    expect(candidates).toEqual([]);
  });

  it('wanted same card + finish → candidate (exact)', async () => {
    const wishlist = await createWishlistRepo(db).create(wishlistInput());
    const holding = await createHoldingsRepo(db).create(holdingInput());
    const candidates = await findWishlistReceiveCandidates(
      createWishlistRepo(db),
      holding,
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.wishlist.id).toBe(wishlist.id);
    expect(candidates[0]?.matchType).toBe('exact');
  });

  it('ordered same card + finish → candidate', async () => {
    await createWishlistRepo(db).create(
      wishlistInput({ status: 'ordered' }),
    );
    const holding = await createHoldingsRepo(db).create(holdingInput());
    const candidates = await findWishlistReceiveCandidates(
      createWishlistRepo(db),
      holding,
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.wishlist.status).toBe('ordered');
  });

  it('received and cancelled wishlist entries are ignored', async () => {
    const repo = createWishlistRepo(db);
    const a = await repo.create(wishlistInput());
    await repo.update(a.id, { status: 'received' });
    const b = await repo.create(wishlistInput({ priority: 'high' }));
    await repo.update(b.id, { status: 'cancelled' });
    const holding = await createHoldingsRepo(db).create(holdingInput());
    const candidates = await findWishlistReceiveCandidates(repo, holding);
    expect(candidates).toEqual([]);
  });

  it('soft-deleted wishlist entries are ignored', async () => {
    const repo = createWishlistRepo(db);
    const a = await repo.create(wishlistInput());
    await repo.softDelete(a.id);
    const holding = await createHoldingsRepo(db).create(holdingInput());
    expect(
      await findWishlistReceiveCandidates(repo, holding),
    ).toEqual([]);
  });

  it('same card, different finish does NOT match', async () => {
    const repo = createWishlistRepo(db);
    await repo.create(wishlistInput({ finish: 'reverse_holo' }));
    const holding = await createHoldingsRepo(db).create(
      holdingInput({ finish: 'holo' }),
    );
    expect(await findWishlistReceiveCandidates(repo, holding)).toEqual([]);
  });

  it('different cardId does NOT match', async () => {
    await db.cards.put(makeCard('base1-5'));
    const repo = createWishlistRepo(db);
    await repo.create(wishlistInput({ cardId: 'base1-5' }));
    const holding = await createHoldingsRepo(db).create(
      holdingInput({ cardId: 'base1-4' }),
    );
    expect(await findWishlistReceiveCandidates(repo, holding)).toEqual([]);
  });

  it('targetCondition mismatch → candidate is condition_mismatch', async () => {
    const repo = createWishlistRepo(db);
    await repo.create(
      wishlistInput({ targetCondition: 'NM' }),
    );
    const holding = await createHoldingsRepo(db).create(
      holdingInput({ rawCondition: 'LP' }),
    );
    const candidates = await findWishlistReceiveCandidates(repo, holding);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.matchType).toBe('condition_mismatch');
    expect(candidates[0]?.reason).toContain('NM');
    expect(candidates[0]?.reason).toContain('LP');
  });

  it('targetCondition match → candidate is exact', async () => {
    const repo = createWishlistRepo(db);
    await repo.create(wishlistInput({ targetCondition: 'NM' }));
    const holding = await createHoldingsRepo(db).create(
      holdingInput({ rawCondition: 'NM' }),
    );
    const candidates = await findWishlistReceiveCandidates(repo, holding);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.matchType).toBe('exact');
  });

  it('graded holding ignores targetCondition (still exact)', async () => {
    const repo = createWishlistRepo(db);
    await repo.create(wishlistInput({ targetCondition: 'NM' }));
    const holding = await createHoldingsRepo(db).create(
      holdingInput({
        conditionType: 'graded',
        rawCondition: null,
        gradingCompany: 'PSA',
        grade: 9,
      }),
    );
    const candidates = await findWishlistReceiveCandidates(repo, holding);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.matchType).toBe('exact');
  });

  it('ordered sorts before wanted', async () => {
    const repo = createWishlistRepo(db);
    const wantedFirst = await repo.create(wishlistInput()); // wanted
    const ordered = await repo.create(
      wishlistInput({ status: 'ordered' }),
    );
    const holding = await createHoldingsRepo(db).create(holdingInput());
    const candidates = await findWishlistReceiveCandidates(repo, holding);
    expect(candidates.map((c) => c.wishlist.id)).toEqual([
      ordered.id,
      wantedFirst.id,
    ]);
  });

  it('priority sorts grail > high > medium > low within same status', async () => {
    const repo = createWishlistRepo(db);
    const low = await repo.create(wishlistInput({ priority: 'low' }));
    const grail = await repo.create(wishlistInput({ priority: 'grail' }));
    const high = await repo.create(wishlistInput({ priority: 'high' }));
    const medium = await repo.create(wishlistInput({ priority: 'medium' }));
    const holding = await createHoldingsRepo(db).create(holdingInput());
    const candidates = await findWishlistReceiveCandidates(repo, holding);
    expect(candidates.map((c) => c.wishlist.id)).toEqual([
      grail.id,
      high.id,
      medium.id,
      low.id,
    ]);
  });

  it('markWishlistCandidatesReceived flips status via repo.update + audit', async () => {
    const repo = createWishlistRepo(db);
    const a = await repo.create(wishlistInput());
    const b = await repo.create(
      wishlistInput({ status: 'ordered', priority: 'high' }),
    );
    const updated = await markWishlistCandidatesReceived(repo, [a.id, b.id]);
    expect(updated).toHaveLength(2);
    expect(updated.every((w) => w.status === 'received')).toBe(true);
    // Audit log was appended (one create per wishlist + one update per
    // status flip = 4 entries on the wishlist entity type).
    const auditRows = await db.auditLog.toArray();
    const wishlistAudit = auditRows.filter(
      (r) => r.entityType === 'wishlist',
    );
    expect(wishlistAudit.length).toBe(4);
    const updates = wishlistAudit.filter(
      (r) => r.action === 'wishlist_item_updated',
    );
    expect(updates.length).toBe(2);
    expect(
      updates.every((r) => r.message.includes('status=received')),
    ).toBe(true);
  });

  it('after markReceived, the wishlist no longer surfaces as a candidate', async () => {
    const repo = createWishlistRepo(db);
    const a = await repo.create(wishlistInput());
    const holding = await createHoldingsRepo(db).create(holdingInput());
    expect(await findWishlistReceiveCandidates(repo, holding)).toHaveLength(1);
    await markWishlistCandidatesReceived(repo, [a.id]);
    expect(await findWishlistReceiveCandidates(repo, holding)).toEqual([]);
  });

  it('findReceiveCandidatesForHoldings dedupes by wishlist id across holdings', async () => {
    const repo = createWishlistRepo(db);
    const wishlist = await repo.create(wishlistInput()); // 1 wishlist row
    // Two raw holdings with different conditions but same card+finish:
    // both match the same wishlist row, but the helper must surface it
    // exactly once.
    const h1 = await createHoldingsRepo(db).create(holdingInput());
    const h2: HoldingRecord = {
      ...h1,
      id: 'h2-fake',
      rawCondition: 'LP',
    } as HoldingRecord;
    const candidates = await findReceiveCandidatesForHoldings(repo, [h1, h2]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.wishlist.id).toBe(wishlist.id);
  });

  it('findReceiveCandidatesForHoldings sorts the merged result', async () => {
    await db.cards.put(makeCard('base1-5'));
    const repo = createWishlistRepo(db);
    const a = await repo.create(
      wishlistInput({ priority: 'low' }),
    );
    const b = await repo.create(
      wishlistInput({ cardId: 'base1-5', status: 'ordered', priority: 'low' }),
    );
    const c = await repo.create(
      wishlistInput({ priority: 'grail' }),
    );
    void a;
    const h1 = await createHoldingsRepo(db).create(holdingInput());
    const h2 = await createHoldingsRepo(db).create(
      holdingInput({ cardId: 'base1-5' }),
    );
    const candidates = await findReceiveCandidatesForHoldings(repo, [h1, h2]);
    // ordered first (b), then grail (c), then low (a from h1).
    const ids = candidates.map((cand) => cand.wishlist.id);
    expect(ids[0]).toBe(b.id);
    expect(ids[1]).toBe(c.id);
  });

  it('rejects active wishlist with different finish even when condition matches', async () => {
    const repo = createWishlistRepo(db);
    await repo.create(
      wishlistInput({
        finish: 'normal',
        targetCondition: 'NM',
      }),
    );
    const holding = await createHoldingsRepo(db).create(
      holdingInput({ finish: 'reverse_holo' }),
    );
    expect(await findWishlistReceiveCandidates(repo, holding)).toEqual([]);
  });

  it('finds nothing when wishlistRepo.listByCardId is empty', async () => {
    const repo = createWishlistRepo(db);
    const holding = await createHoldingsRepo(db).create(holdingInput());
    expect(await findWishlistReceiveCandidates(repo, holding)).toEqual([]);
  });
});

describe('wishlist-receive-service: wishlist-status helpers', () => {
  it('isActiveWishlistStatus + isClosedWishlistStatus partition the four statuses', async () => {
    const mod = await import('../src/domain/wishlist-status');
    expect(mod.isActiveWishlistStatus('wanted')).toBe(true);
    expect(mod.isActiveWishlistStatus('ordered')).toBe(true);
    expect(mod.isActiveWishlistStatus('received')).toBe(false);
    expect(mod.isActiveWishlistStatus('cancelled')).toBe(false);
    expect(mod.isClosedWishlistStatus('received')).toBe(true);
    expect(mod.isClosedWishlistStatus('cancelled')).toBe(true);
    expect(mod.isClosedWishlistStatus('wanted')).toBe(false);
    expect(mod.isClosedWishlistStatus('ordered')).toBe(false);
    expect(mod.ACTIVE_WISHLIST_STATUSES).toEqual(['wanted', 'ordered']);
    expect(mod.CLOSED_WISHLIST_STATUSES).toEqual(['received', 'cancelled']);
  });
});
