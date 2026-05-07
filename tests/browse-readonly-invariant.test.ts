// Read-only contract: PR 6's Browse and Card Detail views may NOT
// touch any user-owned store. This test seeds every user-owned store,
// drives the views through their full happy-path interactions, and
// asserts every user-owned store comes out byte-for-byte unchanged.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mountBrowseView } from '../src/views/browse';
import { mountCardDetailView } from '../src/views/card-detail';
import { initializeDataLayer } from '../src/db/init';
import { _resetDbSingletonForTests, getDb } from '../src/db/database';
import { createBindersRepo } from '../src/repositories/binders-repo';
import { createBinderSlotsRepo } from '../src/repositories/binder-slots-repo';
import { createCardsRepo } from '../src/repositories/cards-repo';
import { createHoldingsRepo } from '../src/repositories/holdings-repo';
import { createLotsRepo } from '../src/repositories/lots-repo';
import { createLotItemsRepo } from '../src/repositories/lot-items-repo';
import { createSetsRepo } from '../src/repositories/sets-repo';
import { createSettingsRepo } from '../src/repositories/settings-repo';
import { createWishlistRepo } from '../src/repositories/wishlist-repo';
import { SETTINGS_KEYS } from '../src/domain/types';
import { closeAndDelete } from './helpers/fresh-db';
import type { CardRecord, SetRecord } from '../src/domain/types';
import type { HoldingInput } from '../src/domain/validators';
import type { PokemonTrackerDB } from '../src/db/database';

async function settle(ms = 80): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
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
  tcgplayer: { prices: { normal: { market: 1 }, holofoil: { market: 1 }, reverseHolofoil: { market: 1 }, "1stEditionNormal": { market: 1 }, "1stEditionHolofoil": { market: 1 } } },
  cardmarket: null,
  updatedAt: '2026-05-06T00:00:00.000Z',
};

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

async function seedUserData(db: PokemonTrackerDB): Promise<void> {
  await createSetsRepo(db).upsert(sampleSet);
  await createCardsRepo(db).upsert(sampleCard);

  await createHoldingsRepo(db).create(sampleHolding);

  const binder = await createBindersRepo(db).create({
    name: 'Test',
    description: null,
    binderType: null,
    totalPages: 1,
    slotsPerPage: 9,
    completionMode: 'standard',
    sourceSetId: null,
  });
  await createBinderSlotsRepo(db).create(
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

  const lot = await createLotsRepo(db).create({
    name: 'Test lot',
    purchaseDate: '2026-01-01T00:00:00.000Z',
    totalCost: 100,
    currency: 'NOK',
    allocationMethod: 'equal',
    notes: null,
  });
  await createLotItemsRepo(db).create({
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

  await createWishlistRepo(db).create({
    cardId: 'base1-4',
    finish: 'holo',
    priority: 'high',
    targetCondition: 'NM',
    targetPrice: 1000,
    targetCurrency: 'NOK',
    status: 'wanted',
    note: null,
  });

  await createSettingsRepo(db).set(
    SETTINGS_KEYS.pokemonTcgApiKey,
    'do-not-touch',
  );
  await createSettingsRepo(db).set(SETTINGS_KEYS.preferredCurrency, 'NOK');
}

interface UserDataSnapshot {
  readonly holdings: unknown[];
  readonly binders: unknown[];
  readonly binderSlots: unknown[];
  readonly lots: unknown[];
  readonly lotItems: unknown[];
  readonly wishlist: unknown[];
  readonly settings: unknown[];
  readonly auditLog: unknown[];
}

async function snapshotUserData(db: PokemonTrackerDB): Promise<UserDataSnapshot> {
  return {
    holdings: await db.holdings.toArray(),
    binders: await db.binders.toArray(),
    binderSlots: await db.binderSlots.toArray(),
    lots: await db.lots.toArray(),
    lotItems: await db.lotItems.toArray(),
    wishlist: await db.wishlist.toArray(),
    settings: await db.settings.toArray(),
    auditLog: await db.auditLog.toArray(),
  };
}

describe('Browse + Card Detail read-only invariant', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    document.body.innerHTML = '<div id="content"></div>';
    _resetDbSingletonForTests();
    db = getDb();
    await initializeDataLayer({ db, skipPersistentStorage: true });
    await seedUserData(db);
    window.location.hash = '';
  });

  afterEach(async () => {
    await settle(40);
    document.body.innerHTML = '';
    await closeAndDelete(db);
    _resetDbSingletonForTests();
    window.location.hash = '';
  });

  it('Browse view does not modify any user-owned store', async () => {
    const before = await snapshotUserData(db);

    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBrowseView(root);
    await settle();

    // Interact: change every filter, sort, search, paginate.
    const searchInput = root.querySelector<HTMLInputElement>(
      '[data-region="search"]',
    ) as HTMLInputElement;
    searchInput.value = 'char';
    searchInput.dispatchEvent(new Event('input'));
    await settle(200);

    (root.querySelector<HTMLSelectElement>('[data-region="rarity-filter"]') as HTMLSelectElement).value = 'Rare Holo';
    root
      .querySelector<HTMLSelectElement>('[data-region="rarity-filter"]')
      ?.dispatchEvent(new Event('change'));
    await settle();

    (root.querySelector<HTMLSelectElement>('[data-region="sort"]') as HTMLSelectElement).value = 'name';
    root
      .querySelector<HTMLSelectElement>('[data-region="sort"]')
      ?.dispatchEvent(new Event('change'));
    await settle();

    (root.querySelector<HTMLButtonElement>('[data-action="next-page"]') as HTMLButtonElement).click();
    await settle();

    const after = await snapshotUserData(db);
    expect(after).toEqual(before);
  });

  it('Card Detail view does not modify any user-owned store', async () => {
    const before = await snapshotUserData(db);

    window.location.hash = `card/${encodeURIComponent('base1-4')}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountCardDetailView(root);
    await settle();

    // Try the back button (still no writes expected).
    root
      .querySelector<HTMLButtonElement>('[data-action="back"]')
      ?.click();
    await settle();

    const after = await snapshotUserData(db);
    expect(after).toEqual(before);
  });
});
