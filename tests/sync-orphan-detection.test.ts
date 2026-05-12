// Phase-2 Plan B — sync orphan-card safety net.
//
// Pins the data-layer contract: after a successful sync that drops a
// previously-cached card, any user-data reference to that cardId
// remains in place (sync never writes user-owned stores) AND the
// orchestrator emits a summary under appMeta.lastSyncOrphans plus a
// `sync_orphans_detected` audit row so the dashboard can surface the
// situation to the operator.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { syncCardDatabase } from '../src/db/sync';
import { initializeDataLayer } from '../src/db/init';
import {
  APP_META_KEYS,
  type CardRecord,
  type SetRecord,
  type SyncOrphansSnapshot,
} from '../src/domain/types';
import { createHoldingsRepo } from '../src/repositories/holdings-repo';
import { createWishlistRepo } from '../src/repositories/wishlist-repo';
import { createLotsRepo } from '../src/repositories/lots-repo';
import { createLotItemsRepo } from '../src/repositories/lot-items-repo';
import { createBindersRepo } from '../src/repositories/binders-repo';
import { createBinderSlotsRepo } from '../src/repositories/binder-slots-repo';
import type {
  PokemonTcgApi,
  CardsProgress,
  SetsProgress,
} from '../src/api/pokemon-tcg-api';
import { closeAndDelete, freshDb } from './helpers/fresh-db';
import type { PokemonTrackerDB } from '../src/db/database';
import type { HoldingInput, WishlistInput, LotItemInput } from '../src/domain/validators';

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
    updatedAt: '2026-05-12T00:00:00.000Z',
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
    tcgplayer: {
      prices: {
        normal: { market: 1 },
        holofoil: { market: 1 },
        reverseHolofoil: { market: 1 },
        '1stEditionNormal': { market: 1 },
        '1stEditionHolofoil': { market: 1 },
      },
    },
    cardmarket: null,
    updatedAt: '2026-05-12T00:00:00.000Z',
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

function holdingInput(overrides: Partial<HoldingInput> = {}): HoldingInput {
  return {
    cardId: 'base1-1',
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
    ...overrides,
  };
}

function wishlistInput(overrides: Partial<WishlistInput> = {}): WishlistInput {
  return {
    cardId: 'base1-1',
    finish: 'normal',
    priority: 'medium',
    targetCondition: null,
    targetPrice: null,
    targetCurrency: null,
    status: 'wanted',
    note: null,
    ...overrides,
  };
}

function lotItemInput(
  lotId: string,
  overrides: Partial<LotItemInput> = {},
): LotItemInput {
  return {
    lotId,
    cardId: 'base1-1',
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
    ...overrides,
  };
}

describe('Sync orphan-card detection (Phase-2 Plan B)', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    db = await freshDb();
    // Seed two cards in the local cache so user-data writes can pass
    // variant validators (PR 11). After the sync runs with only one
    // of these cards in the upstream payload, the other becomes an
    // orphan.
    await db.cards.put(makeCard('base1-1', 'base1'));
    await db.cards.put(makeCard('base1-2', 'base1'));
    await initializeDataLayer({ db, skipPersistentStorage: true });
  });

  afterEach(async () => {
    await closeAndDelete(db);
  });

  async function getOrphanSnapshot(): Promise<SyncOrphansSnapshot | null> {
    const row = await db.appMeta.get(APP_META_KEYS.lastSyncOrphans);
    if (row === undefined) return null;
    return row.value as SyncOrphansSnapshot;
  }

  it('B: writes empty snapshot when no user data references missing cards', async () => {
    const sets = [makeSet('base1')];
    const cardsBySet = new Map([
      ['base1', [makeCard('base1-1', 'base1'), makeCard('base1-2', 'base1')]],
    ]);
    const apiClient = stubApi(sets, cardsBySet);

    const result = await syncCardDatabase({ db, apiClient });
    expect(result.ok).toBe(true);

    const snap = await getOrphanSnapshot();
    expect(snap).not.toBeNull();
    expect(snap!.count).toBe(0);
    expect(snap!.sampleIds).toEqual([]);

    // No orphan audit row should be appended for a zero-count snapshot.
    const audits = await db.auditLog
      .where('action')
      .equals('sync_orphans_detected')
      .toArray();
    expect(audits.length).toBe(0);
  });

  it('B: detects orphans across holdings + wishlist + lotItems + binderSlots', async () => {
    // Seed user data referencing both cards before sync drops one.
    const holdingsRepo = createHoldingsRepo(db);
    const wishlistRepo = createWishlistRepo(db);
    const lotsRepo = createLotsRepo(db);
    const lotItemsRepo = createLotItemsRepo(db);
    const bindersRepo = createBindersRepo(db);
    const slotsRepo = createBinderSlotsRepo(db);

    await holdingsRepo.create(holdingInput({ cardId: 'base1-1' }));
    await holdingsRepo.create(holdingInput({ cardId: 'base1-2' }));
    await wishlistRepo.create(wishlistInput({ cardId: 'base1-2' }));
    const lot = await lotsRepo.create({
      name: 'L',
      purchaseDate: '2026-05-12T00:00:00.000Z',
      totalCost: 10,
      currency: 'NOK',
      allocationMethod: 'equal',
      notes: null,
    });
    await lotItemsRepo.create(lotItemInput(lot.id, { cardId: 'base1-2' }));
    const binder = await bindersRepo.create({
      name: 'B',
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
        targetCardId: 'base1-2',
        holdingId: null,
        status: 'wanted',
        note: null,
      },
      9,
    );

    // Sync drops base1-2 from upstream — only base1-1 returns.
    const sets = [makeSet('base1')];
    const cardsBySet = new Map([
      ['base1', [makeCard('base1-1', 'base1')]],
    ]);
    const apiClient = stubApi(sets, cardsBySet);

    const beforeUserCounts = {
      holdings: await db.holdings.count(),
      wishlist: await db.wishlist.count(),
      lotItems: await db.lotItems.count(),
      binderSlots: await db.binderSlots.count(),
    };

    const result = await syncCardDatabase({ db, apiClient });
    expect(result.ok).toBe(true);

    // User-data stores untouched (sync NEVER writes user-owned).
    expect(await db.holdings.count()).toBe(beforeUserCounts.holdings);
    expect(await db.wishlist.count()).toBe(beforeUserCounts.wishlist);
    expect(await db.lotItems.count()).toBe(beforeUserCounts.lotItems);
    expect(await db.binderSlots.count()).toBe(beforeUserCounts.binderSlots);

    const snap = await getOrphanSnapshot();
    expect(snap).not.toBeNull();
    // Deduped: base1-2 is referenced 4 times (1 holding, 1 wishlist,
    // 1 lot item, 1 slot.targetCardId) but appears once in the count.
    expect(snap!.count).toBe(1);
    expect(snap!.sampleIds).toEqual(['base1-2']);

    // Exactly one audit row appended.
    const audits = await db.auditLog
      .where('action')
      .equals('sync_orphans_detected')
      .toArray();
    expect(audits.length).toBe(1);
    expect(audits[0]?.message).toContain('1 orphan');
    expect(audits[0]?.message).toContain('base1-2');
    expect(audits[0]?.entityType).toBe('system');
    expect(audits[0]?.entityId).toBeNull();
  });

  it('B: sampleIds is capped at 10 + sorted alphabetically', async () => {
    // Seed 15 holdings, one for each of 15 cardIds. To pass variant
    // validation, ensure every cardId we'll soon use as a holding
    // exists in the local cache BEFORE the holdings repo writes.
    const cardIds = Array.from(
      { length: 15 },
      (_, i) => `base1-${String(i + 100)}`,
    );
    for (const id of cardIds) {
      await db.cards.put(makeCard(id, 'base1'));
    }
    const holdingsRepo = createHoldingsRepo(db);
    for (const id of cardIds) {
      await holdingsRepo.create(holdingInput({ cardId: id }));
    }

    // Sync returns ONLY base1-1 — every other cardId becomes orphan.
    const sets = [makeSet('base1')];
    const cardsBySet = new Map([
      ['base1', [makeCard('base1-1', 'base1')]],
    ]);
    const apiClient = stubApi(sets, cardsBySet);

    const result = await syncCardDatabase({ db, apiClient });
    expect(result.ok).toBe(true);

    const snap = await getOrphanSnapshot();
    expect(snap).not.toBeNull();
    expect(snap!.count).toBe(15);
    expect(snap!.sampleIds.length).toBe(10);
    // Sorted alphabetically.
    const sorted = [...snap!.sampleIds].sort();
    expect(snap!.sampleIds).toEqual(sorted);
    // First sample is the alphabetically-earliest of the 15.
    expect(snap!.sampleIds[0]).toBe(cardIds.sort()[0]);
  });

  it('B: ignores soft-deleted user-data rows when detecting orphans', async () => {
    const holdingsRepo = createHoldingsRepo(db);
    // One live holding + one soft-deleted holding, both referencing
    // a soon-to-be-orphan card.
    const live = await holdingsRepo.create(
      holdingInput({ cardId: 'base1-1' }),
    );
    const deleted = await holdingsRepo.create(
      holdingInput({ cardId: 'base1-2' }),
    );
    await holdingsRepo.softDelete(deleted.id);

    // Sync drops BOTH base1-1 and base1-2 from upstream.
    const sets = [makeSet('base1')];
    const cardsBySet = new Map([['base1', [] as readonly CardRecord[]]]);
    const apiClient = stubApi(sets, cardsBySet);

    const result = await syncCardDatabase({ db, apiClient });
    expect(result.ok).toBe(true);

    const snap = await getOrphanSnapshot();
    expect(snap).not.toBeNull();
    // The live holding's cardId (base1-1) counts as orphan; the
    // soft-deleted one (base1-2) does not, even though its cardId
    // also went missing from upstream.
    expect(snap!.count).toBe(1);
    expect(snap!.sampleIds).toEqual(['base1-1']);
    void live;
  });

  it('B: a failing sync leaves no orphan snapshot (best-effort runs only on success path)', async () => {
    // Stub an API that fails at the first call. The orchestrator must
    // bail without committing the cache OR writing an orphan snapshot.
    const failingApi: PokemonTcgApi = {
      async fetchAllSets() {
        throw new Error('upstream offline');
      },
      async fetchAllCardsForSet() {
        return [];
      },
      async testConnection() {
        return true;
      },
    };

    const result = await syncCardDatabase({ db, apiClient: failingApi });
    expect(result.ok).toBe(false);

    const snap = await getOrphanSnapshot();
    expect(snap).toBeNull();
  });
});
