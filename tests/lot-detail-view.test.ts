// Lot detail view — summary, items table, allocation toolbar,
// materialize, CSV button, stale-allocation warning.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountLotDetailView } from '../src/views/lot-detail';
import { _resetDbSingletonForTests, getDb } from '../src/db/database';
import { initializeDataLayer } from '../src/db/init';
import { createCardsRepo } from '../src/repositories/cards-repo';
import { createLotItemsRepo } from '../src/repositories/lot-items-repo';
import { createLotsRepo } from '../src/repositories/lots-repo';
import { createSetsRepo } from '../src/repositories/sets-repo';
import { closeAndDelete } from './helpers/fresh-db';
import type { CardRecord, SetRecord } from '../src/domain/types';
import type { LotItemInput } from '../src/domain/validators';
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

function lotItem(
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

describe('Lot detail view', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    document.body.innerHTML = '<div id="content"></div>';
    _resetDbSingletonForTests();
    db = getDb();
    await initializeDataLayer({ db, skipPersistentStorage: true });
    await createSetsRepo(db).upsert(sampleSet);
    await createCardsRepo(db).upsertMany([
      makeCard(1),
      makeCard(2),
      makeCard(3),
    ]);
    window.location.hash = '';
  });

  afterEach(async () => {
    await settle(40);
    document.body.innerHTML = '';
    await closeAndDelete(db);
    _resetDbSingletonForTests();
    window.location.hash = '';
  });

  it('renders not-found message when the hash points to an unknown id', async () => {
    window.location.hash = 'lot/does-not-exist';
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountLotDetailView(root);
    await settle();
    expect(
      root.querySelector('.lot-detail-view__message')?.textContent,
    ).toMatch(/finnes ikke/);
  });

  it('renders summary, toolbar, and items table for a lot with items', async () => {
    const lot = await createLotsRepo(db).create({
      name: 'Visible lot',
      purchaseDate: '2026-04-01T00:00:00.000Z',
      totalCost: 200,
      currency: 'NOK',
      allocationMethod: 'equal',
      notes: 'Notater',
    });
    await createLotItemsRepo(db).create(lotItem(lot.id, 'base1-1'));
    await createLotItemsRepo(db).create(lotItem(lot.id, 'base1-2'));
    window.location.hash = `lot/${encodeURIComponent(lot.id)}`;

    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountLotDetailView(root);
    await settle();

    expect(root.querySelector('.lot-detail-view__title')?.textContent).toBe(
      'Visible lot',
    );
    expect(root.querySelector('.lot-detail-view__notes')?.textContent).toBe(
      'Notater',
    );
    expect(root.querySelectorAll('.lot-items-table__row').length).toBe(2);
    // Stale allocation warning should appear (allocatedTotal=0 vs total=200)
    expect(
      root.querySelector('[data-region="allocation-warning"]'),
    ).not.toBeNull();
    // Materialize button is disabled because no allocatedCost yet.
    const materializeBtn = root.querySelector<HTMLButtonElement>(
      '[data-action="materialize"]',
    );
    expect(materializeBtn?.disabled).toBe(true);
  });

  it('Beregn allokering på nytt fills allocatedCost and clears the warning', async () => {
    const lot = await createLotsRepo(db).create({
      name: 'Allocate me',
      purchaseDate: '2026-04-01T00:00:00.000Z',
      totalCost: 200,
      currency: 'NOK',
      allocationMethod: 'equal',
      notes: null,
    });
    await createLotItemsRepo(db).create(lotItem(lot.id, 'base1-1'));
    await createLotItemsRepo(db).create(lotItem(lot.id, 'base1-2'));
    window.location.hash = `lot/${encodeURIComponent(lot.id)}`;

    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountLotDetailView(root);
    await settle();

    const applyBtn = root.querySelector<HTMLButtonElement>(
      '[data-action="apply-allocation"]',
    );
    applyBtn?.click();

    await vi.waitFor(async () => {
      const items = await db.lotItems.toArray();
      expect(items.every((i) => i.allocatedCost === 100)).toBe(true);
    });

    await settle();
    expect(
      root.querySelector('[data-region="allocation-warning"]'),
    ).toBeNull();
  });

  it('Materialize creates holdings via the service, then locks the items', async () => {
    const lot = await createLotsRepo(db).create({
      name: 'Materialize me',
      purchaseDate: '2026-04-01T00:00:00.000Z',
      totalCost: 200,
      currency: 'NOK',
      allocationMethod: 'equal',
      notes: null,
    });
    await createLotItemsRepo(db).create(lotItem(lot.id, 'base1-1'));
    await createLotItemsRepo(db).create(lotItem(lot.id, 'base1-2'));
    window.location.hash = `lot/${encodeURIComponent(lot.id)}`;

    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountLotDetailView(root);
    await settle();

    // Allocate first
    root
      .querySelector<HTMLButtonElement>('[data-action="apply-allocation"]')
      ?.click();
    await vi.waitFor(async () => {
      const items = await db.lotItems.toArray();
      expect(items.every((i) => i.allocatedCost !== null)).toBe(true);
    });
    await settle();

    // Confirm dialog → just accept
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    root
      .querySelector<HTMLButtonElement>('[data-action="materialize"]')
      ?.click();
    await vi.waitFor(async () => {
      expect(await db.holdings.count()).toBe(2);
    });
    confirmSpy.mockRestore();

    await settle();
    // After materialise, items show "låst" instead of edit/delete.
    const lockedCells = root.querySelectorAll<HTMLElement>(
      '.lot-items-table__locked',
    );
    expect(lockedCells.length).toBe(2);
  });
});
