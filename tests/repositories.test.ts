import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createAppMetaRepo,
  createBindersRepo,
  createBinderSlotsRepo,
  createCardsRepo,
  createHoldingsRepo,
  createLotItemsRepo,
  createLotsRepo,
  createSetsRepo,
  createSettingsRepo,
  createWishlistRepo,
} from './helpers/repos';
import { closeAndDelete, freshDb } from './helpers/fresh-db';
import type { CardRecord, SetRecord } from '../src/domain/types';
import { ValidationError } from '../src/domain/validators';
import type { PokemonTrackerDB } from '../src/db/database';

const sampleSet: SetRecord = {
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

const sampleCard: CardRecord = {
  id: 'base1-4',
  setId: 'base1',
  name: 'Charizard',
  number: '4',
  rarity: 'Rare Holo',
  supertype: 'Pokémon',
  subtypes: ['Stage 2'],
  types: ['Fire'],
  imageSmall: null,
  imageLarge: null,
  tcgplayer: null,
  cardmarket: null,
  updatedAt: '2026-05-06T00:00:00.000Z',
};

const baseHoldingInput = {
  cardId: 'base1-4',
  quantity: 1,
  conditionType: 'raw' as const,
  rawCondition: 'NM' as const,
  gradingCompany: null,
  grade: null,
  certNumber: null,
  certUrl: null,
  gradedDate: null,
  finish: 'holo' as const,
  edition: 'unlimited' as const,
  language: 'en',
  purchasePrice: null,
  purchaseCurrency: null,
  estimatedValue: null,
  valueCurrency: null,
  valueSource: 'unknown' as const,
  valueNote: null,
  valueUpdatedAt: null,
  source: 'manual' as const,
  note: null,
  specialVariant: false,
  tags: [],
  lotId: null,
  status: 'owned' as const,
};

describe('repositories', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    db = await freshDb();
  });

  afterEach(async () => {
    await closeAndDelete(db);
  });

  // -- Cache repositories ----------------------------------------------

  it('sets-repo upserts and lists without audit pollution', async () => {
    const repo = createSetsRepo(db);
    await repo.upsert(sampleSet);
    expect(await repo.count()).toBe(1);
    expect(await repo.get('base1')).toEqual(sampleSet);
    expect(await db.auditLog.count()).toBe(0);

    await repo.clear();
    expect(await repo.count()).toBe(0);
  });

  it('cards-repo can filter by setId', async () => {
    const repo = createCardsRepo(db);
    await repo.upsertMany([
      sampleCard,
      { ...sampleCard, id: 'base1-5', name: 'Other' },
      { ...sampleCard, id: 'base2-1', setId: 'base2', name: 'Different set' },
    ]);
    const filtered = await repo.listBySet('base1');
    expect(filtered.map((c) => c.id).sort()).toEqual(['base1-4', 'base1-5']);
  });

  // -- Holdings --------------------------------------------------------

  it('holdings-repo creates with audit + supports soft delete + restore', async () => {
    const repo = createHoldingsRepo(db);
    const created = await repo.create(baseHoldingInput);
    expect(created.id).toBeDefined();
    expect(created.deletedAt).toBeNull();

    const live1 = await repo.listLive();
    expect(live1).toHaveLength(1);

    await repo.softDelete(created.id);
    expect(await repo.listLive()).toHaveLength(0);
    expect(await repo.list()).toHaveLength(1);

    await repo.restore(created.id);
    expect((await repo.listLive())[0]?.id).toBe(created.id);

    const auditActions = (await db.auditLog.toArray())
      .map((entry) => entry.action)
      .sort();
    expect(auditActions).toEqual([
      'holding_created',
      'holding_restored',
      'holding_soft_deleted',
    ]);
  });

  it('holdings-repo rejects invalid input via ValidationError', async () => {
    const repo = createHoldingsRepo(db);
    await expect(
      repo.create({ ...baseHoldingInput, quantity: 0 }),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(await repo.list()).toHaveLength(0);
    expect(await db.auditLog.count()).toBe(0);
  });

  it('holdings-repo update revalidates and audits', async () => {
    const repo = createHoldingsRepo(db);
    const created = await repo.create(baseHoldingInput);
    const updated = await repo.update(created.id, { quantity: 3 });
    expect(updated.quantity).toBe(3);

    await expect(
      repo.update(created.id, { quantity: 0 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('holdings-repo has no permanent delete API', () => {
    const repo = createHoldingsRepo(db);
    expect((repo as unknown as { delete?: unknown }).delete).toBeUndefined();
  });

  // -- Lots + lot items ------------------------------------------------

  it('lots-repo and lot-items-repo create + soft delete', async () => {
    const lotsRepo = createLotsRepo(db);
    const itemsRepo = createLotItemsRepo(db);

    const lot = await lotsRepo.create({
      name: 'Booster box',
      purchaseDate: '2026-05-01T00:00:00.000Z',
      totalCost: 1500,
      currency: 'NOK',
      allocationMethod: 'weighted_by_market_price',
      notes: null,
    });

    const item = await itemsRepo.create({
      lotId: lot.id,
      cardId: 'base1-4',
      finish: 'holo',
      edition: 'unlimited',
      conditionType: 'raw',
      rawCondition: 'NM',
      gradingCompany: null,
      grade: null,
      quantity: 1,
      manualPriceOverride: null,
      marketEstimate: 800,
      allocatedCost: null,
      holdingId: null,
      note: null,
    });

    expect((await itemsRepo.listByLotId(lot.id))[0]?.id).toBe(item.id);

    await itemsRepo.softDelete(item.id);
    expect(await itemsRepo.listLive()).toHaveLength(0);

    expect((lotsRepo as unknown as { delete?: unknown }).delete).toBeUndefined();
    expect(
      (itemsRepo as unknown as { delete?: unknown }).delete,
    ).toBeUndefined();
  });

  // -- Binders + binder slots ------------------------------------------

  it('binders-repo + binder-slots-repo with bulk slot creation', async () => {
    const bindersRepo = createBindersRepo(db);
    const slotsRepo = createBinderSlotsRepo(db);

    const binder = await bindersRepo.create({
      name: 'S&V 151',
      description: null,
      binderType: 'VaultX XL',
      totalPages: 2,
      slotsPerPage: 9,
      completionMode: 'master',
      sourceSetId: 'sv3pt5',
    });

    const inputs = Array.from({ length: 9 }, (_v, idx) => ({
      binderId: binder.id,
      pageNumber: 1,
      slotNumber: idx + 1,
      targetCardId: `sv3pt5-${idx + 1}`,
      holdingId: null,
      status: 'wanted' as const,
      note: null,
    }));
    const slots = await slotsRepo.createMany(inputs, 9);
    expect(slots).toHaveLength(9);

    expect(await slotsRepo.listByBinderId(binder.id)).toHaveLength(9);

    await expect(
      slotsRepo.create(
        {
          binderId: binder.id,
          pageNumber: 1,
          slotNumber: 10, // > slotsPerPage = 9
          targetCardId: null,
          holdingId: null,
          status: 'empty',
          note: null,
        },
        9,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  // -- Wishlist --------------------------------------------------------

  it('wishlist-repo create + status update', async () => {
    const repo = createWishlistRepo(db);
    const item = await repo.create({
      cardId: 'base1-4',
      finish: 'holo',
      priority: 'high',
      targetCondition: 'NM',
      targetPrice: 1500,
      targetCurrency: 'NOK',
      status: 'wanted',
      note: null,
    });
    const updated = await repo.update(item.id, { status: 'ordered' });
    expect(updated.status).toBe('ordered');
  });

  // -- Settings + appMeta ----------------------------------------------

  it('settings-repo redacts API key from audit message', async () => {
    const repo = createSettingsRepo(db);
    await repo.set('pokemonTcgApiKey', 'super-secret');

    const audits = await db.auditLog
      .where('action')
      .equals('api_key_changed')
      .toArray();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.message).not.toContain('super-secret');
    expect(audits[0]?.message).toMatch(/redacted/i);

    expect(await repo.get<string>('pokemonTcgApiKey')).toBe('super-secret');
  });

  it('settings-repo has no generic delete API', () => {
    const repo = createSettingsRepo(db);
    expect((repo as unknown as { delete?: unknown }).delete).toBeUndefined();
  });

  it('appMeta-repo set/get without audit', async () => {
    const repo = createAppMetaRepo(db);
    await repo.set('lastSyncAt', '2026-05-06T00:00:00.000Z');
    expect(await repo.get<string>('lastSyncAt')).toBe(
      '2026-05-06T00:00:00.000Z',
    );
    expect(await db.auditLog.count()).toBe(0);
  });

  it('appMeta-repo has no generic delete API', () => {
    const repo = createAppMetaRepo(db);
    expect((repo as unknown as { delete?: unknown }).delete).toBeUndefined();
  });
});
