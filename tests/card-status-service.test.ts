// PR 23 — card status aggregation. Tests against a fresh DB so the
// real repos + binder-slot-service join correctly.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CardStatusNotFoundError,
  getCardStatus,
} from '../src/services/card-status-service';
import { createCardsRepo } from '../src/repositories/cards-repo';
import { createSetsRepo } from '../src/repositories/sets-repo';
import { createHoldingsRepo } from '../src/repositories/holdings-repo';
import { createWishlistRepo } from '../src/repositories/wishlist-repo';
import { createBindersRepo } from '../src/repositories/binders-repo';
import { createBinderSlotsRepo } from '../src/repositories/binder-slots-repo';
import { createLotsRepo } from '../src/repositories/lots-repo';
import { createLotItemsRepo } from '../src/repositories/lot-items-repo';
import { createBinderSlotService } from '../src/services/binder-slot-service';
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

function buildDeps(db: PokemonTrackerDB) {
  const cardsRepo = createCardsRepo(db);
  const setsRepo = createSetsRepo(db);
  const holdingsRepo = createHoldingsRepo(db);
  const wishlistRepo = createWishlistRepo(db);
  const bindersRepo = createBindersRepo(db);
  const binderSlotsRepo = createBinderSlotsRepo(db);
  const lotsRepo = createLotsRepo(db);
  const lotItemsRepo = createLotItemsRepo(db);
  const binderSlotService = createBinderSlotService(
    bindersRepo,
    binderSlotsRepo,
    holdingsRepo,
    cardsRepo,
  );
  return {
    cardsRepo,
    setsRepo,
    holdingsRepo,
    wishlistRepo,
    bindersRepo,
    binderSlotsRepo,
    lotsRepo,
    lotItemsRepo,
    binderSlotService,
  };
}

describe('card-status-service (PR 23)', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    db = await freshDb();
    await createSetsRepo(db).upsert(baseSet);
    await createCardsRepo(db).upsert(
      makeCard('base1-4', { overrides: { name: 'Charizard', number: '4' } }),
    );
    await createCardsRepo(db).upsert(
      makeCard('base1-58', { overrides: { name: 'Pikachu', number: '58' } }),
    );
  });

  afterEach(async () => {
    await closeAndDelete(db);
  });

  it('throws CardStatusNotFoundError for an unknown cardId', async () => {
    const deps = buildDeps(db);
    await expect(getCardStatus(deps, 'no-such-id')).rejects.toBeInstanceOf(
      CardStatusNotFoundError,
    );
  });

  it('returns empty sections for a known card with no user data', async () => {
    const deps = buildDeps(db);
    const status = await getCardStatus(deps, 'base1-4');
    expect(status.card.id).toBe('base1-4');
    expect(status.set?.id).toBe('base1');
    expect(status.holdings).toEqual([]);
    expect(status.binderSlots).toEqual([]);
    expect(status.activeWishlist).toEqual([]);
    expect(status.closedWishlist).toEqual([]);
    expect(status.unmaterialisedLotItems).toEqual([]);
    expect(status.summary.totalQuantityOwned).toBe(0);
    expect(status.summary.activeWishlistCount).toBe(0);
    expect(status.summary.binderSlotCount).toBe(0);
    expect(status.summary.unmaterialisedLotCount).toBe(0);
  });

  it('groups live holdings and skips soft-deleted ones', async () => {
    const deps = buildDeps(db);
    const live = await deps.holdingsRepo.create({
      cardId: 'base1-4',
      quantity: 2,
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
    const dead = await deps.holdingsRepo.create({
      cardId: 'base1-4',
      quantity: 1,
      conditionType: 'raw',
      rawCondition: 'LP',
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
    await deps.holdingsRepo.softDelete(dead.id);
    const status = await getCardStatus(deps, 'base1-4');
    expect(status.holdings.map((h) => h.id)).toEqual([live.id]);
    expect(status.summary.totalQuantityOwned).toBe(2);
  });

  it('partitions wishlist into active vs closed', async () => {
    const deps = buildDeps(db);
    const wanted = await deps.wishlistRepo.create({
      cardId: 'base1-4',
      finish: 'holo',
      priority: 'medium',
      targetCondition: null,
      targetPrice: null,
      targetCurrency: null,
      status: 'wanted',
      note: null,
    });
    const ordered = await deps.wishlistRepo.create({
      cardId: 'base1-4',
      finish: 'holo',
      priority: 'high',
      targetCondition: null,
      targetPrice: null,
      targetCurrency: null,
      status: 'ordered',
      note: null,
    });
    const recv = await deps.wishlistRepo.create({
      cardId: 'base1-4',
      finish: 'holo',
      priority: 'low',
      targetCondition: null,
      targetPrice: null,
      targetCurrency: null,
      status: 'wanted',
      note: null,
    });
    await deps.wishlistRepo.update(recv.id, { status: 'received' });
    const cancelled = await deps.wishlistRepo.create({
      cardId: 'base1-4',
      finish: 'holo',
      priority: 'low',
      targetCondition: null,
      targetPrice: null,
      targetCurrency: null,
      status: 'wanted',
      note: null,
    });
    await deps.wishlistRepo.update(cancelled.id, { status: 'cancelled' });

    const status = await getCardStatus(deps, 'base1-4');
    const activeIds = status.activeWishlist.map((w) => w.id).sort();
    expect(activeIds).toEqual([wanted.id, ordered.id].sort());
    const closedIds = status.closedWishlist.map((w) => w.id).sort();
    expect(closedIds).toEqual([recv.id, cancelled.id].sort());
    expect(status.summary.activeWishlistCount).toBe(2);
  });

  it('includes binder target slots and holding-assigned slots', async () => {
    const deps = buildDeps(db);
    const binder = await deps.bindersRepo.create({
      name: 'Base Master',
      description: null,
      binderType: null,
      totalPages: 1,
      slotsPerPage: 9,
      binderPreset: 'custom',
      completionMode: 'master',
      sourceSetId: null,
    });
    // target slot for base1-4
    await deps.binderSlotsRepo.create(
      {
        binderId: binder.id,
        pageNumber: 1,
        slotNumber: 1,
        targetCardId: 'base1-4',
        holdingId: null,
        status: 'wanted',
        note: null,
      },
      9,
    );
    // assigned holding slot for base1-4 (different slot, holdingId only)
    const h = await deps.holdingsRepo.create({
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
    await deps.binderSlotsRepo.create(
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

    const status = await getCardStatus(deps, 'base1-4');
    expect(status.binderSlots.length).toBe(2);
    const matchedBy = status.binderSlots.map((m) => m.matchedBy).sort();
    expect(matchedBy).toEqual(['assigned', 'target']);
  });

  it('lists unmaterialised lot items only (skips materialised + soft-deleted)', async () => {
    const deps = buildDeps(db);
    const lot = await deps.lotsRepo.create({
      name: 'Lot A',
      purchaseDate: '2026-04-01T00:00:00.000Z',
      totalCost: 50,
      currency: 'NOK',
      allocationMethod: 'equal',
      notes: null,
    });
    // unmaterialised (holdingId=null)
    const u = await deps.lotItemsRepo.create({
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
      holdingId: null,
      note: null,
    });
    // materialised (holdingId set)
    const h = await deps.holdingsRepo.create({
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
      lotId: lot.id,
      status: 'owned',
    });
    await deps.lotItemsRepo.create({
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
    // soft-deleted unmaterialised
    const dead = await deps.lotItemsRepo.create({
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
      holdingId: null,
      note: null,
    });
    await deps.lotItemsRepo.softDelete(dead.id);

    const status = await getCardStatus(deps, 'base1-4');
    expect(status.unmaterialisedLotItems.length).toBe(1);
    expect(status.unmaterialisedLotItems[0]?.item.id).toBe(u.id);
  });
});
