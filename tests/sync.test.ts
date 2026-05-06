import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { syncCardDatabase } from '../src/db/sync';
import { initializeDataLayer } from '../src/db/init';
import {
  APP_META_KEYS,
  SETTINGS_KEYS,
  type CardRecord,
  type SetRecord,
} from '../src/domain/types';
import { createBindersRepo } from '../src/repositories/binders-repo';
import { createBinderSlotsRepo } from '../src/repositories/binder-slots-repo';
import { createHoldingsRepo } from '../src/repositories/holdings-repo';
import { createLotsRepo } from '../src/repositories/lots-repo';
import { createLotItemsRepo } from '../src/repositories/lot-items-repo';
import { createSettingsRepo } from '../src/repositories/settings-repo';
import { createWishlistRepo } from '../src/repositories/wishlist-repo';
import type {
  PokemonTcgApi,
  CardsProgress,
  SetsProgress,
} from '../src/api/pokemon-tcg-api';
import { closeAndDelete, freshDb } from './helpers/fresh-db';
import type { HoldingInput } from '../src/domain/validators';
import type { PokemonTrackerDB } from '../src/db/database';

const sampleHolding: HoldingInput = {
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
};

function makeSet(id: string): SetRecord {
  return {
    id,
    name: id.toUpperCase(),
    series: 'Test',
    printedTotal: 10,
    total: 10,
    releaseDate: '2024-01-01',
    symbolUrl: null,
    logoUrl: null,
    updatedAt: '2026-05-06T00:00:00.000Z',
  };
}

function makeCard(id: string, setId: string): CardRecord {
  return {
    id,
    setId,
    name: id,
    number: id.split('-').pop() ?? '0',
    rarity: 'Rare',
    supertype: 'Pokémon',
    subtypes: [],
    types: ['Fire'],
    imageSmall: null,
    imageLarge: null,
    tcgplayer: null,
    cardmarket: null,
    updatedAt: '2026-05-06T00:00:00.000Z',
  };
}

function stubApi(
  sets: readonly SetRecord[],
  cardsBySet: ReadonlyMap<string, readonly CardRecord[]>,
): PokemonTcgApi {
  return {
    async fetchAllSets(onProgress?: (progress: SetsProgress) => void) {
      onProgress?.({ phase: 'sets', fetched: sets.length, total: sets.length });
      return Array.from(sets);
    },
    async fetchAllCardsForSet(
      setId: string,
      onProgress?: (progress: CardsProgress) => void,
    ) {
      const cards = cardsBySet.get(setId) ?? [];
      onProgress?.({
        phase: 'cards',
        setId,
        fetched: cards.length,
        total: cards.length,
      });
      return Array.from(cards);
    },
    async testConnection() {
      return true;
    },
  };
}

async function seedUserData(db: PokemonTrackerDB): Promise<void> {
  const holdingsRepo = createHoldingsRepo(db);
  const bindersRepo = createBindersRepo(db);
  const slotsRepo = createBinderSlotsRepo(db);
  const lotsRepo = createLotsRepo(db);
  const lotItemsRepo = createLotItemsRepo(db);
  const wishlistRepo = createWishlistRepo(db);
  const settingsRepo = createSettingsRepo(db);

  await holdingsRepo.create(sampleHolding);
  const binder = await bindersRepo.create({
    name: 'Test',
    description: null,
    binderType: null,
    totalPages: 1,
    slotsPerPage: 9,
    completionMode: 'standard',
    sourceSetId: null,
  });
  await slotsRepo.create(
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
  const lot = await lotsRepo.create({
    name: 'Test lot',
    purchaseDate: '2026-01-01T00:00:00.000Z',
    totalCost: 100,
    currency: 'NOK',
    allocationMethod: 'equal',
    notes: null,
  });
  await lotItemsRepo.create({
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
    marketEstimate: null,
    allocatedCost: null,
    holdingId: null,
    note: null,
  });
  await wishlistRepo.create({
    cardId: 'base1-5',
    finish: 'normal',
    priority: 'medium',
    targetCondition: 'NM',
    targetPrice: null,
    targetCurrency: null,
    status: 'wanted',
    note: null,
  });
  await settingsRepo.set(SETTINGS_KEYS.preferredCurrency, 'NOK');
  await settingsRepo.set(SETTINGS_KEYS.pokemonTcgApiKey, 'super-secret');
}

describe('syncCardDatabase', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    db = await freshDb();
    await initializeDataLayer({ db, skipPersistentStorage: true });
  });

  afterEach(async () => {
    await closeAndDelete(db);
  });

  it('happy path populates sets and cards cache', async () => {
    const sets = [makeSet('base1'), makeSet('base2')];
    const cards = new Map<string, readonly CardRecord[]>([
      ['base1', [makeCard('base1-4', 'base1'), makeCard('base1-5', 'base1')]],
      ['base2', [makeCard('base2-1', 'base2')]],
    ]);

    const result = await syncCardDatabase({
      db,
      apiClient: stubApi(sets, cards),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.setsCount).toBe(2);
    expect(result.cardsCount).toBe(3);

    expect(await db.sets.count()).toBe(2);
    expect(await db.cards.count()).toBe(3);
  });

  it('records lastSyncAt + lastSyncStatus=ok and one sync_run audit on success', async () => {
    await syncCardDatabase({
      db,
      apiClient: stubApi([makeSet('s1')], new Map([['s1', []]])),
    });

    const lastSyncAt = await db.appMeta.get(APP_META_KEYS.lastSyncAt);
    const lastStatus = await db.appMeta.get(APP_META_KEYS.lastSyncStatus);
    const lastError = await db.appMeta.get(APP_META_KEYS.lastSyncError);
    expect(typeof lastSyncAt?.value).toBe('string');
    expect(lastStatus?.value).toBe('ok');
    expect(lastError?.value).toBeNull();

    const audits = await db.auditLog
      .where('action')
      .equals('sync_run')
      .toArray();
    expect(audits).toHaveLength(1);
  });

  it('failure does not change cache, user data, lastSyncAt; writes sync_failed audit + sanitized lastSyncError', async () => {
    await seedUserData(db);

    // Snapshot user-owned + cache + lastSyncAt before sync.
    const beforeSnapshot = {
      sets: await db.sets.toArray(),
      cards: await db.cards.toArray(),
      holdings: await db.holdings.toArray(),
      binders: await db.binders.toArray(),
      binderSlots: await db.binderSlots.toArray(),
      lots: await db.lots.toArray(),
      lotItems: await db.lotItems.toArray(),
      wishlist: await db.wishlist.toArray(),
      settings: await db.settings.toArray(),
      lastSyncAt: await db.appMeta.get(APP_META_KEYS.lastSyncAt),
    };

    const apiKey = 'leakable-secret-XYZ';
    const failingApi: PokemonTcgApi = {
      async fetchAllSets() {
        throw new Error(`server died with key ${apiKey}`);
      },
      async fetchAllCardsForSet() {
        return [];
      },
      async testConnection() {
        return false;
      },
    };

    const result = await syncCardDatabase({
      db,
      apiKey,
      apiClient: failingApi,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).not.toContain(apiKey);

    // Cache and user-owned stores unchanged.
    expect(await db.sets.toArray()).toEqual(beforeSnapshot.sets);
    expect(await db.cards.toArray()).toEqual(beforeSnapshot.cards);
    expect(await db.holdings.toArray()).toEqual(beforeSnapshot.holdings);
    expect(await db.binders.toArray()).toEqual(beforeSnapshot.binders);
    expect(await db.binderSlots.toArray()).toEqual(beforeSnapshot.binderSlots);
    expect(await db.lots.toArray()).toEqual(beforeSnapshot.lots);
    expect(await db.lotItems.toArray()).toEqual(beforeSnapshot.lotItems);
    expect(await db.wishlist.toArray()).toEqual(beforeSnapshot.wishlist);
    expect(await db.settings.toArray()).toEqual(beforeSnapshot.settings);

    // lastSyncAt unchanged; status/error reflect failure.
    expect(await db.appMeta.get(APP_META_KEYS.lastSyncAt)).toEqual(
      beforeSnapshot.lastSyncAt,
    );
    const lastStatus = await db.appMeta.get(APP_META_KEYS.lastSyncStatus);
    expect(lastStatus?.value).toBe('failed');
    const lastError = await db.appMeta.get(APP_META_KEYS.lastSyncError);
    expect(typeof lastError?.value).toBe('string');
    expect(lastError?.value as string).not.toContain(apiKey);

    const audits = await db.auditLog
      .where('action')
      .equals('sync_failed')
      .toArray();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.message).not.toContain(apiKey);
  });

  it('successful sync leaves user-owned stores untouched', async () => {
    await seedUserData(db);
    const beforeHoldings = await db.holdings.toArray();
    const beforeBinders = await db.binders.toArray();
    const beforeWishlist = await db.wishlist.toArray();
    const beforeSettings = await db.settings.toArray();

    const result = await syncCardDatabase({
      db,
      apiClient: stubApi(
        [makeSet('s1')],
        new Map([['s1', [makeCard('s1-1', 's1')]]]),
      ),
    });
    expect(result.ok).toBe(true);

    expect(await db.holdings.toArray()).toEqual(beforeHoldings);
    expect(await db.binders.toArray()).toEqual(beforeBinders);
    expect(await db.wishlist.toArray()).toEqual(beforeWishlist);
    expect(await db.settings.toArray()).toEqual(beforeSettings);
  });

  it('uses the supplied progress callback', async () => {
    const progress = vi.fn();
    await syncCardDatabase({
      db,
      apiClient: stubApi(
        [makeSet('s1'), makeSet('s2')],
        new Map([
          ['s1', [makeCard('s1-1', 's1')]],
          ['s2', []],
        ]),
      ),
      onProgress: progress,
    });
    expect(progress).toHaveBeenCalled();
    const phases = progress.mock.calls.map(
      (call) => (call[0] as { phase: string }).phase,
    );
    expect(phases).toContain('sets');
    expect(phases).toContain('cards');
  });
});
