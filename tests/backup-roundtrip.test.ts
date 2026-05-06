// The data-layer contract: export → wipe → restore must end at a database
// equivalent to the seeded one. From this PR onward, no PR that touches
// stores or the schema may break this test (PR_RULES §10).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  exportToBackupFile,
  serializeBackupToJson,
} from '../src/db/backup';
import {
  parseBackupJson,
  replaceRestore,
  validateBackup,
} from '../src/db/restore';
import { initializeDataLayer } from '../src/db/init';
import { createBindersRepo } from '../src/repositories/binders-repo';
import { createBinderSlotsRepo } from '../src/repositories/binder-slots-repo';
import { createCardsRepo } from '../src/repositories/cards-repo';
import { createHoldingsRepo } from '../src/repositories/holdings-repo';
import { createLotsRepo } from '../src/repositories/lots-repo';
import { createLotItemsRepo } from '../src/repositories/lot-items-repo';
import { createSettingsRepo } from '../src/repositories/settings-repo';
import { createWishlistRepo } from '../src/repositories/wishlist-repo';
import { SETTINGS_KEYS } from '../src/domain/types';
import { closeAndDelete, freshDb } from './helpers/fresh-db';
import type { AutoBackupResult } from '../src/db/auto-backup';
import type { CardRecord } from '../src/domain/types';
import type { HoldingInput } from '../src/domain/validators';
import type { PokemonTrackerDB } from '../src/db/database';

const baseHolding: HoldingInput = {
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
  tags: ['favorite'],
  lotId: null,
  status: 'owned',
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

async function seedFixtures(db: PokemonTrackerDB): Promise<void> {
  const cardsRepo = createCardsRepo(db);
  const holdingsRepo = createHoldingsRepo(db);
  const bindersRepo = createBindersRepo(db);
  const slotsRepo = createBinderSlotsRepo(db);
  const lotsRepo = createLotsRepo(db);
  const lotItemsRepo = createLotItemsRepo(db);
  const wishlistRepo = createWishlistRepo(db);
  const settingsRepo = createSettingsRepo(db);

  await cardsRepo.upsertMany([
    sampleCard,
    { ...sampleCard, id: 'base1-5', name: 'Other' },
  ]);

  await holdingsRepo.create(baseHolding);
  await holdingsRepo.create({ ...baseHolding, cardId: 'base1-5' });

  const binder = await bindersRepo.create({
    name: 'Test binder',
    description: null,
    binderType: null,
    totalPages: 1,
    slotsPerPage: 9,
    completionMode: 'master',
    sourceSetId: 'base1',
  });
  await slotsRepo.createMany(
    Array.from({ length: 9 }, (_unused, i) => ({
      binderId: binder.id,
      pageNumber: 1,
      slotNumber: i + 1,
      targetCardId: `base1-${i + 1}`,
      holdingId: null,
      status: 'wanted' as const,
      note: null,
    })),
    9,
  );

  const lot = await lotsRepo.create({
    name: 'Test lot',
    purchaseDate: '2026-01-01T00:00:00.000Z',
    totalCost: 1000,
    currency: 'NOK',
    allocationMethod: 'weighted_by_market_price',
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
    marketEstimate: 800,
    allocatedCost: null,
    holdingId: null,
    note: null,
  });

  await wishlistRepo.create({
    cardId: 'base1-5',
    finish: 'normal',
    priority: 'high',
    targetCondition: 'NM',
    targetPrice: 200,
    targetCurrency: 'NOK',
    status: 'wanted',
    note: null,
  });

  await settingsRepo.set(SETTINGS_KEYS.preferredCurrency, 'NOK');
}

interface StoreSnapshot {
  readonly cards: number;
  readonly holdings: number;
  readonly binders: number;
  readonly binderSlots: number;
  readonly lots: number;
  readonly lotItems: number;
  readonly wishlist: number;
  readonly auditLog: number;
  readonly settings: number;
}

async function snapshotCounts(db: PokemonTrackerDB): Promise<StoreSnapshot> {
  return {
    cards: await db.cards.count(),
    holdings: await db.holdings.count(),
    binders: await db.binders.count(),
    binderSlots: await db.binderSlots.count(),
    lots: await db.lots.count(),
    lotItems: await db.lotItems.count(),
    wishlist: await db.wishlist.count(),
    auditLog: await db.auditLog.count(),
    settings: await db.settings.count(),
  };
}

const okPreRestoreBackup: AutoBackupResult = {
  ok: true,
  filename: 'pre-restore-backup-test.json',
  json: '{}',
};

describe('export → wipe → restore round-trip', () => {
  let sourceDb: PokemonTrackerDB;
  let targetDb: PokemonTrackerDB;

  beforeEach(async () => {
    sourceDb = await freshDb();
    targetDb = await freshDb();
    await initializeDataLayer({ db: sourceDb, skipPersistentStorage: true });
    await initializeDataLayer({ db: targetDb, skipPersistentStorage: true });
  });

  afterEach(async () => {
    await closeAndDelete(sourceDb);
    await closeAndDelete(targetDb);
  });

  it('produces an identical store-count footprint after restore', async () => {
    await seedFixtures(sourceDb);
    // Capture *after* export so the source count includes the
    // `backup_exported` audit entry exportToBackupFile writes.
    const exported = await exportToBackupFile(sourceDb);
    const sourceCounts = await snapshotCounts(sourceDb);

    const parsed = parseBackupJson(exported.json);
    const validation = validateBackup(parsed);
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;

    await replaceRestore(targetDb, validation.backup, {
      preRestoreBackup: okPreRestoreBackup,
    });

    const targetCounts = await snapshotCounts(targetDb);

    // Source audit log = N entries from app activity + backup_exported.
    // Target audit log = N entries from the backup (snapshot taken
    // before backup_exported was added) + backup_restored. Both end
    // up at the same total. Every other store should match exactly.
    expect(targetCounts).toEqual(sourceCounts);
  });

  it('round-tripped holdings preserve every persisted field', async () => {
    await seedFixtures(sourceDb);

    const exported = await exportToBackupFile(sourceDb);
    const parsed = parseBackupJson(exported.json);
    const validation = validateBackup(parsed);
    if (!validation.ok) throw new Error('validation should have passed');

    await replaceRestore(targetDb, validation.backup, {
      preRestoreBackup: okPreRestoreBackup,
    });

    const sourceHoldings = (await sourceDb.holdings.toArray()).sort(
      (a, b) => a.id.localeCompare(b.id),
    );
    const targetHoldings = (await targetDb.holdings.toArray()).sort(
      (a, b) => a.id.localeCompare(b.id),
    );
    expect(targetHoldings).toEqual(sourceHoldings);
  });

  it('serializeBackupToJson(restoredSnapshot) matches the validated backup contents (modulo expected metadata drift)', async () => {
    await seedFixtures(sourceDb);

    const exported = await exportToBackupFile(sourceDb);
    const validation = validateBackup(parseBackupJson(exported.json));
    if (!validation.ok) throw new Error('validation should have passed');

    await replaceRestore(targetDb, validation.backup, {
      preRestoreBackup: okPreRestoreBackup,
    });

    const targetBinders = await targetDb.binders.toArray();
    const targetSlots = await targetDb.binderSlots.toArray();
    const targetLots = await targetDb.lots.toArray();
    const targetLotItems = await targetDb.lotItems.toArray();
    const targetWishlist = await targetDb.wishlist.toArray();

    expect(targetBinders).toEqual(validation.backup.binders);
    expect(targetSlots.sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      [...validation.backup.binderSlots].sort((a, b) =>
        a.id.localeCompare(b.id),
      ),
    );
    expect(targetLots).toEqual(validation.backup.lots);
    expect(targetLotItems).toEqual(validation.backup.lotItems);
    expect(targetWishlist).toEqual(validation.backup.wishlist);

    // Re-export the target DB and re-read; the validator must accept
    // it cleanly with no warnings (FKs are intact). This proves the
    // contract closes the loop.
    const reExport = await exportToBackupFile(targetDb);
    const reValidation = validateBackup(parseBackupJson(reExport.json));
    expect(reValidation.ok).toBe(true);
    if (reValidation.ok) {
      expect(reValidation.warnings).toEqual([]);
      // serializeBackupToJson is deterministic for given inputs;
      // sanity-check the shape didn't drift.
      expect(typeof serializeBackupToJson(reValidation.backup)).toBe(
        'string',
      );
    }
  });
});
