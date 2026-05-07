// Dashboard service: aggregates the seven sections from the existing
// repos. We use real Dexie (fake-indexeddb) so the count() / list()
// distinction is exercised end-to-end.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeAndDelete, freshDb } from './helpers/fresh-db';
import { createBinderService } from '../src/services/binder-service';
import { createDashboardService } from '../src/services/dashboard-service';
import { createLotService } from '../src/services/lot-service';
import {
  createAppMetaRepo,
  createBindersRepo,
  createBinderSlotsRepo,
  createCardsRepo,
  createHoldingsRepo,
  createLotItemsRepo,
  createLotsRepo,
  createSetsRepo,
  createWishlistRepo,
} from './helpers/repos';
import { APP_META_KEYS } from '../src/domain/types';
import type { CardRecord, SetRecord } from '../src/domain/types';
import type {
  HoldingInput,
  LotInput,
  LotItemInput,
  WishlistInput,
} from '../src/domain/validators';
import type { PokemonTrackerDB } from '../src/db/database';

function makeService(db: PokemonTrackerDB, now?: () => number) {
  return createDashboardService({
    appMetaRepo: createAppMetaRepo(db),
    cardsRepo: createCardsRepo(db),
    setsRepo: createSetsRepo(db),
    holdingsRepo: createHoldingsRepo(db),
    bindersRepo: createBindersRepo(db),
    binderSlotsRepo: createBinderSlotsRepo(db),
    lotsRepo: createLotsRepo(db),
    lotItemsRepo: createLotItemsRepo(db),
    wishlistRepo: createWishlistRepo(db),
    ...(now !== undefined ? { now } : {}),
  });
}

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

function makeCard(n: number): CardRecord {
  return {
    id: `base1-${n}`,
    setId: 'base1',
    name: `Card ${n}`,
    number: String(n),
    rarity: 'Common',
    supertype: 'Pokémon',
    subtypes: [],
    types: [],
    imageSmall: null,
    imageLarge: null,
    tcgplayer: null,
    cardmarket: null,
    updatedAt: '2026-05-06T00:00:00.000Z',
  };
}

function holdingInput(
  cardId: string,
  overrides: Partial<HoldingInput> = {},
): HoldingInput {
  return {
    cardId,
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

function lotInput(overrides: Partial<LotInput> = {}): LotInput {
  return {
    name: 'Lot',
    purchaseDate: '2026-04-01T00:00:00.000Z',
    totalCost: 100,
    currency: 'NOK',
    allocationMethod: 'equal',
    notes: null,
    ...overrides,
  };
}

function lotItemInput(
  lotId: string,
  cardId: string,
  overrides: Partial<LotItemInput> = {},
): LotItemInput {
  return {
    lotId,
    cardId,
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

function wishlistInput(
  cardId: string,
  overrides: Partial<WishlistInput> = {},
): WishlistInput {
  return {
    cardId,
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

describe('dashboard-service.buildSnapshot', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    db = await freshDb();
    await createSetsRepo(db).upsert(sampleSet);
  });

  afterEach(async () => {
    await closeAndDelete(db);
  });

  it('returns zero-counts on a brand-new database', async () => {
    const snapshot = await makeService(db).buildSnapshot();
    expect(snapshot.databaseHealth.cardCacheCount).toBe(0);
    expect(snapshot.databaseHealth.liveHoldingsCount).toBe(0);
    expect(snapshot.collection.liveCount).toBe(0);
    expect(snapshot.binders.count).toBe(0);
    expect(snapshot.lots.count).toBe(0);
    expect(snapshot.wishlist.wantedCount).toBe(0);
    // No backup → critical action surfaces.
    const ids = snapshot.actions.map((a) => a.id);
    expect(ids).toContain('backup_never');
  });

  it('counts cards via count(), never via list — large card sets do not appear in snapshot', async () => {
    // Seed 20 cards (small but proves the snapshot uses .count rather
    // than embedding the list). The snapshot has no `cards: ...`
    // field, so the only thing that should leak through is the count.
    const cards: CardRecord[] = Array.from({ length: 20 }, (_v, idx) =>
      makeCard(idx + 1),
    );
    await createCardsRepo(db).upsertMany(cards);
    const snapshot = await makeService(db).buildSnapshot();
    expect(snapshot.databaseHealth.cardCacheCount).toBe(20);
    expect(snapshot.sync.cardCacheCount).toBe(20);
    // Snapshot's public surface does not expose card rows.
    expect(JSON.stringify(snapshot)).not.toContain('"Card 5"');
  });

  it('aggregates collection raw/graded/missing counts and not-in-binder', async () => {
    await createCardsRepo(db).upsertMany([
      makeCard(1),
      makeCard(2),
      makeCard(3),
    ]);
    const holdingsRepo = createHoldingsRepo(db);
    const a = await holdingsRepo.create(
      holdingInput('base1-1', { rawCondition: 'NM' }),
    );
    await holdingsRepo.create(
      holdingInput('base1-2', { rawCondition: 'UNKNOWN' }),
    );
    await holdingsRepo.create(
      holdingInput('base1-3', {
        conditionType: 'graded',
        rawCondition: null,
        gradingCompany: 'PSA',
        grade: 9,
      }),
    );
    // Put `a` into a binder slot so it does NOT count as not-in-binder.
    const binder = await createBinderService(db).createManualBinder({
      name: 'Binder',
      description: null,
      binderType: null,
      totalPages: 1,
      slotsPerPage: 9,
      completionMode: 'standard',
      sourceSetId: null,
    });
    const slotsRepo = createBinderSlotsRepo(db);
    const slot = binder.slots[0];
    if (slot === undefined) throw new Error('test bootstrap failed');
    await slotsRepo.update(
      slot.id,
      { holdingId: a.id, targetCardId: 'base1-1', status: 'owned' },
      9,
    );

    const snapshot = await makeService(db).buildSnapshot();
    expect(snapshot.collection.liveCount).toBe(3);
    expect(snapshot.collection.rawCount).toBe(2);
    expect(snapshot.collection.gradedCount).toBe(1);
    expect(snapshot.collection.missingConditionCount).toBe(1); // UNKNOWN
    expect(snapshot.collection.missingValueCount).toBe(3); // none have estimatedValue
    expect(snapshot.collection.notInBinderCount).toBe(2); // a is in binder
    expect(snapshot.collection.uniqueCardIds).toBe(3);
  });

  it('binder average completion + top 3', async () => {
    await createCardsRepo(db).upsertMany([
      makeCard(1),
      makeCard(2),
      makeCard(3),
    ]);
    const holdingsRepo = createHoldingsRepo(db);
    const slotsRepo = createBinderSlotsRepo(db);

    // Binder A: 1/1 complete.
    const a = await createBinderService(db).createBinderFromSet({
      binder: {
        name: 'A',
        description: null,
        binderType: null,
        slotsPerPage: 9,
        completionMode: 'standard',
        sourceSetId: 'base1',
      },
      slots: [
        { pageNumber: 1, slotNumber: 1, targetCardId: 'base1-1', note: null },
      ],
    });
    const aHolding = await holdingsRepo.create(holdingInput('base1-1'));
    const aSlot = a.slots[0];
    if (aSlot === undefined) throw new Error('test bootstrap failed');
    await slotsRepo.update(
      aSlot.id,
      { holdingId: aHolding.id, status: 'owned' },
      9,
    );

    // Binder B: 0/2 complete.
    await createBinderService(db).createBinderFromSet({
      binder: {
        name: 'B',
        description: null,
        binderType: null,
        slotsPerPage: 9,
        completionMode: 'standard',
        sourceSetId: 'base1',
      },
      slots: [
        { pageNumber: 1, slotNumber: 1, targetCardId: 'base1-2', note: null },
        { pageNumber: 1, slotNumber: 2, targetCardId: 'base1-3', note: null },
      ],
    });

    const snapshot = await makeService(db).buildSnapshot();
    expect(snapshot.binders.count).toBe(2);
    // A = 100, B = 0 → avg 50.
    expect(snapshot.binders.averageCompletionPercent).toBe(50);
    expect(snapshot.binders.totalTargetSlots).toBe(3);
    expect(snapshot.binders.totalCompletedSlots).toBe(1);
    expect(snapshot.binders.totalMissingSlots).toBe(2);
    expect(snapshot.binders.topByCompletion[0]?.binder.name).toBe('A');
  });

  it('lots aggregate totals per currency and flag unallocated/imbalanced', async () => {
    await createCardsRepo(db).upsertMany([makeCard(1), makeCard(2)]);
    const lotsRepo = createLotsRepo(db);
    const itemsRepo = createLotItemsRepo(db);
    const lotA = await lotsRepo.create(lotInput({ name: 'A', totalCost: 200 }));
    await itemsRepo.create(lotItemInput(lotA.id, 'base1-1'));
    await itemsRepo.create(lotItemInput(lotA.id, 'base1-2'));
    await createLotService(db).applyAllocation(lotA.id);

    const lotB = await lotsRepo.create(
      lotInput({ name: 'B', totalCost: 300, currency: 'USD' }),
    );
    await itemsRepo.create(lotItemInput(lotB.id, 'base1-1'));
    // Don't allocate B — it's unallocated.

    const snapshot = await makeService(db).buildSnapshot();
    expect(snapshot.lots.count).toBe(2);
    expect(snapshot.lots.unallocatedCount).toBe(1); // lot B
    const totalsByCurrency = snapshot.lots.totalsByCurrency;
    expect(totalsByCurrency.length).toBe(2);
    expect(
      totalsByCurrency.find((t) => t.currency === 'NOK')?.total,
    ).toBe(200);
    expect(
      totalsByCurrency.find((t) => t.currency === 'USD')?.total,
    ).toBe(300);
  });

  it('wishlist counts per status + top-5 grail', async () => {
    const wishlistRepo = createWishlistRepo(db);
    await wishlistRepo.create(
      wishlistInput('base1-1', { priority: 'grail', status: 'wanted' }),
    );
    await wishlistRepo.create(
      wishlistInput('base1-2', { priority: 'high', status: 'wanted' }),
    );
    await wishlistRepo.create(
      wishlistInput('base1-3', { priority: 'low', status: 'ordered' }),
    );
    await wishlistRepo.create(
      wishlistInput('base1-4', { priority: 'medium', status: 'received' }),
    );
    const cancelled = await wishlistRepo.create(
      wishlistInput('base1-5', { priority: 'grail', status: 'cancelled' }),
    );
    void cancelled;

    const snapshot = await makeService(db).buildSnapshot();
    expect(snapshot.wishlist.wantedCount).toBe(2);
    expect(snapshot.wishlist.orderedCount).toBe(1);
    expect(snapshot.wishlist.receivedCount).toBe(1);
    expect(snapshot.wishlist.cancelledCount).toBe(1);
    // Cancelled grail must NOT appear in the top-grail list.
    expect(snapshot.wishlist.grailItems.length).toBe(1);
    expect(snapshot.wishlist.grailItems[0]?.cardId).toBe('base1-1');
  });

  it('uses appMeta for backup/sync info and computes daysSinceLastBackup', async () => {
    const appMeta = createAppMetaRepo(db);
    await appMeta.set(APP_META_KEYS.lastBackupAt, '2026-05-01T00:00:00.000Z');
    await appMeta.set(APP_META_KEYS.lastBackupHoldingCount, 0);
    await appMeta.set(APP_META_KEYS.lastSyncAt, '2026-05-04T00:00:00.000Z');
    await appMeta.set(APP_META_KEYS.lastSyncStatus, 'failed');
    await appMeta.set(APP_META_KEYS.lastSyncError, 'API ned');
    await appMeta.set(APP_META_KEYS.persistentStorageGranted, true);

    const fixedNow = Date.parse('2026-05-07T00:00:00.000Z'); // 6 days later
    const snapshot = await makeService(db, () => fixedNow).buildSnapshot();
    expect(snapshot.backup.daysSinceLastBackup).toBe(6);
    expect(snapshot.sync.lastSyncStatus).toBe('failed');
    expect(snapshot.sync.lastSyncError).toBe('API ned');
    const ids = snapshot.actions.map((a) => a.id);
    // 6 days < 7 → no backup_old yet
    expect(ids).not.toContain('backup_old');
    expect(ids).toContain('sync_failed');
  });

  it('flags schemaMigratedSinceLastBackup when lastMigrationAt > lastBackupAt', async () => {
    const appMeta = createAppMetaRepo(db);
    await appMeta.set(APP_META_KEYS.lastBackupAt, '2026-05-01T00:00:00.000Z');
    await appMeta.set(APP_META_KEYS.lastMigrationAt, '2026-05-03T00:00:00.000Z');
    const snapshot = await makeService(db).buildSnapshot();
    expect(snapshot.backup.schemaMigratedSinceLastBackup).toBe(true);
    const ids = snapshot.actions.map((a) => a.id);
    expect(ids).toContain('backup_after_migration');
  });
});
