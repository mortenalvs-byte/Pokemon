// PR 23 — global search service. Pure card-cache search with badges.
//
// Cases lock the contract for v1: cardMatchesQuery is reused, ranking
// favours id matches and owned cards, badges reflect live tables only,
// limits cap to 20 default / 100 expanded.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_GLOBAL_SEARCH_LIMIT,
  EXPANDED_GLOBAL_SEARCH_LIMIT,
  searchGlobalCards,
} from '../src/services/global-search-service';
import { createCardsRepo } from '../src/repositories/cards-repo';
import { createSetsRepo } from '../src/repositories/sets-repo';
import { createHoldingsRepo } from '../src/repositories/holdings-repo';
import { createWishlistRepo } from '../src/repositories/wishlist-repo';
import { createBindersRepo } from '../src/repositories/binders-repo';
import { createBinderSlotsRepo } from '../src/repositories/binder-slots-repo';
import { createLotsRepo } from '../src/repositories/lots-repo';
import { createLotItemsRepo } from '../src/repositories/lot-items-repo';
import { closeAndDelete, freshDb } from './helpers/fresh-db';
import { makeCard } from './helpers/cards';
import type { SetRecord } from '../src/domain/types';
import type { PokemonTrackerDB } from '../src/db/database';

const baseSet: SetRecord = {
  id: 'base1',
  name: 'Base',
  series: 'Base',
  printedTotal: 102,
  total: 102,
  releaseDate: '1999-01-09',
  symbolUrl: null,
  logoUrl: null,
  updatedAt: '2026-05-06T00:00:00.000Z',
};

const sv1Set: SetRecord = {
  id: 'sv1',
  name: 'Scarlet & Violet',
  series: 'Scarlet & Violet',
  printedTotal: 198,
  total: 198,
  releaseDate: '2023-03-31',
  symbolUrl: null,
  logoUrl: null,
  updatedAt: '2026-05-06T00:00:00.000Z',
};

describe('global-search-service (PR 23)', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    db = await freshDb();
    const setsRepo = createSetsRepo(db);
    const cardsRepo = createCardsRepo(db);
    await setsRepo.upsert(baseSet);
    await setsRepo.upsert(sv1Set);
    await cardsRepo.upsert(
      makeCard('base1-4', { overrides: { name: 'Charizard', number: '4' } }),
    );
    await cardsRepo.upsert(
      makeCard('base1-15', { overrides: { name: 'Mega Charizard EX', number: '15' } }),
    );
    await cardsRepo.upsert(
      makeCard('base1-58', { overrides: { name: 'Pikachu', number: '58' } }),
    );
    await cardsRepo.upsert(
      makeCard('sv1-198', {
        overrides: { setId: 'sv1', name: 'Mew ex', number: '198' },
      }),
    );
  });

  afterEach(async () => {
    await closeAndDelete(db);
  });

  it('empty query returns []', async () => {
    expect(await searchGlobalCards(db, '')).toEqual([]);
    expect(await searchGlobalCards(db, '   ')).toEqual([]);
  });

  it('exact card.id match ranks first', async () => {
    const results = await searchGlobalCards(db, 'base1-4');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.card.id).toBe('base1-4');
  });

  it('substring on card name returns hits', async () => {
    const results = await searchGlobalCards(db, 'charizard');
    const ids = results.map((r) => r.card.id);
    expect(ids).toContain('base1-4');
    expect(ids).toContain('base1-15');
  });

  it('exact card number match returns the right card', async () => {
    const results = await searchGlobalCards(db, '198');
    const ids = results.map((r) => r.card.id);
    expect(ids).toContain('sv1-198');
  });

  it('compound query "<set name> <number>" matches', async () => {
    const results = await searchGlobalCards(db, 'Scarlet & Violet 198');
    expect(results[0]?.card.id).toBe('sv1-198');
  });

  it('compound query "<setId> <number>" matches', async () => {
    const results = await searchGlobalCards(db, 'base1 4');
    expect(results[0]?.card.id).toBe('base1-4');
  });

  it('owned card gets a ranking boost', async () => {
    // Without ownership "charizard" returns base1-4 + base1-15 in some
    // order. Mark base1-15 as owned and verify it climbs.
    const holdingsRepo = createHoldingsRepo(db);
    await holdingsRepo.create({
      cardId: 'base1-15',
      quantity: 1,
      conditionType: 'raw',
      rawCondition: 'NM',
      gradingCompany: null,
      grade: null,
      certNumber: null,
      certUrl: null,
      gradedDate: null,
      finish: 'normal',
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
    });
    const results = await searchGlobalCards(db, 'charizard');
    const owned = results.find((r) => r.card.id === 'base1-15');
    const unowned = results.find((r) => r.card.id === 'base1-4');
    expect(owned).toBeDefined();
    expect(unowned).toBeDefined();
    if (!owned || !unowned) return;
    expect(owned.badges.owned).toBe(true);
    expect(unowned.badges.owned).toBe(false);
    expect(owned.rank).toBeGreaterThan(unowned.rank);
  });

  it('active wishlist sets badge; received does not', async () => {
    const wishlistRepo = createWishlistRepo(db);
    await wishlistRepo.create({
      cardId: 'base1-4',
      finish: 'holo',
      priority: 'high',
      targetCondition: null,
      targetPrice: null,
      targetCurrency: null,
      status: 'wanted',
      note: null,
    });
    const closed = await wishlistRepo.create({
      cardId: 'base1-15',
      finish: 'holo',
      priority: 'low',
      targetCondition: null,
      targetPrice: null,
      targetCurrency: null,
      status: 'wanted',
      note: null,
    });
    await wishlistRepo.update(closed.id, { status: 'received' });
    const results = await searchGlobalCards(db, 'charizard');
    const a = results.find((r) => r.card.id === 'base1-4');
    const b = results.find((r) => r.card.id === 'base1-15');
    expect(a?.badges.activeWishlist).toBe(true);
    expect(b?.badges.activeWishlist).toBe(false);
  });

  it('binder badge fires for target slots and for assigned holdings', async () => {
    const bindersRepo = createBindersRepo(db);
    const slotsRepo = createBinderSlotsRepo(db);
    const binder = await bindersRepo.create({
      name: 'Base Master',
      description: null,
      binderType: null,
      totalPages: 1,
      slotsPerPage: 9,
      binderPreset: 'custom',
      completionMode: 'master',
      sourceSetId: null,
    });
    await slotsRepo.create(
      {
        binderId: binder.id,
        pageNumber: 1,
        slotNumber: 1,
        targetCardId: 'base1-4', // direct target
        holdingId: null,
        status: 'wanted',
        note: null,
      },
      9,
    );
    // Add a holding for base1-58 and assign the slot to it. Slot has
    // no targetCardId — pure assignment.
    const holdingsRepo = createHoldingsRepo(db);
    const h = await holdingsRepo.create({
      cardId: 'base1-58',
      quantity: 1,
      conditionType: 'raw',
      rawCondition: 'NM',
      gradingCompany: null,
      grade: null,
      certNumber: null,
      certUrl: null,
      gradedDate: null,
      finish: 'normal',
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
    });
    const assignedSlot = await slotsRepo.create(
      {
        binderId: binder.id,
        pageNumber: 1,
        slotNumber: 2,
        targetCardId: null,
        holdingId: h.id,
        status: 'owned',
        note: null,
      },
      9,
    );
    void assignedSlot;
    const all = await searchGlobalCards(db, 'charizard');
    const charizard = all.find((r) => r.card.id === 'base1-4');
    expect(charizard?.badges.inBinder).toBe(true);
    const pikachu = await searchGlobalCards(db, 'pikachu');
    expect(pikachu[0]?.badges.inBinder).toBe(true);
  });

  it('lot badge fires only for UNMATERIALISED lot items', async () => {
    const lotsRepo = createLotsRepo(db);
    const lot = await lotsRepo.create({
      name: 'Test lot',
      purchaseDate: '2026-05-01T00:00:00.000Z',
      totalCost: 100,
      currency: 'NOK',
      allocationMethod: 'equal',
      notes: null,
    });
    const lotItemsRepo = createLotItemsRepo(db);
    await lotItemsRepo.create({
      lotId: lot.id,
      cardId: 'base1-58',
      finish: 'normal',
      edition: 'unlimited',
      conditionType: 'raw',
      rawCondition: 'NM',
      gradingCompany: null,
      grade: null,
      quantity: 1,
      manualPriceOverride: null,
      marketEstimate: null,
      allocatedCost: null,
      holdingId: null,
      note: null,
    });
    const results = await searchGlobalCards(db, 'pikachu');
    expect(results[0]?.badges.inLot).toBe(true);

    // Now create a materialised lot item for Charizard — badge must
    // NOT fire because the panel won't list materialised items.
    const holdingsRepo = createHoldingsRepo(db);
    const h = await holdingsRepo.create({
      cardId: 'base1-4',
      quantity: 1,
      conditionType: 'raw',
      rawCondition: 'NM',
      gradingCompany: null,
      grade: null,
      certNumber: null,
      certUrl: null,
      gradedDate: null,
      finish: 'normal',
      edition: 'unlimited',
      language: 'en',
      purchasePrice: null,
      purchaseCurrency: null,
      estimatedValue: null,
      valueCurrency: null,
      valueSource: 'unknown',
      valueNote: null,
      valueUpdatedAt: null,
      source: 'lot',
      note: null,
      specialVariant: false,
      tags: [],
      lotId: lot.id,
      status: 'owned',
    });
    await lotItemsRepo.create({
      lotId: lot.id,
      cardId: 'base1-4',
      finish: 'normal',
      edition: 'unlimited',
      conditionType: 'raw',
      rawCondition: 'NM',
      gradingCompany: null,
      grade: null,
      quantity: 1,
      manualPriceOverride: null,
      marketEstimate: null,
      allocatedCost: null,
      holdingId: h.id,
      note: null,
    });
    const charizardResult = (await searchGlobalCards(db, 'base1-4'))[0];
    expect(charizardResult?.badges.inLot).toBe(false);
  });

  it('default limit is 20 / expanded is 100', async () => {
    // Add 30 unique Pikachu copies with different ids to the cache.
    const cardsRepo = createCardsRepo(db);
    for (let i = 0; i < 30; i += 1) {
      await cardsRepo.upsert(
        makeCard(`bulk-${i}`, {
          overrides: {
            setId: 'sv1',
            name: `Pikachu Bulk ${i}`,
            number: String(i),
          },
        }),
      );
    }
    const small = await searchGlobalCards(db, 'pikachu');
    expect(small.length).toBe(DEFAULT_GLOBAL_SEARCH_LIMIT);
    const large = await searchGlobalCards(db, 'pikachu', {
      limit: EXPANDED_GLOBAL_SEARCH_LIMIT,
    });
    // 30 bulk + base1-58 Pikachu = 31 hits.
    expect(large.length).toBe(31);
  });

  it('does not crash when a card has a missing set', async () => {
    const cardsRepo = createCardsRepo(db);
    await cardsRepo.upsert(
      makeCard('orphan-1', {
        overrides: { setId: 'no-such-set', name: 'Orphan', number: '1' },
      }),
    );
    const results = await searchGlobalCards(db, 'orphan');
    expect(results[0]?.card.id).toBe('orphan-1');
    expect(results[0]?.set).toBeNull();
  });

  it('soft-deleted holdings/wishlist do not toggle badges', async () => {
    const holdingsRepo = createHoldingsRepo(db);
    const h = await holdingsRepo.create({
      cardId: 'base1-4',
      quantity: 1,
      conditionType: 'raw',
      rawCondition: 'NM',
      gradingCompany: null,
      grade: null,
      certNumber: null,
      certUrl: null,
      gradedDate: null,
      finish: 'normal',
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
    });
    await holdingsRepo.softDelete(h.id);
    const results = await searchGlobalCards(db, 'charizard');
    const c = results.find((r) => r.card.id === 'base1-4');
    expect(c?.badges.owned).toBe(false);
  });
});
