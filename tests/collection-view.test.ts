import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountCollectionView } from '../src/views/collection';
import { _resetDbSingletonForTests, getDb } from '../src/db/database';
import { initializeDataLayer } from '../src/db/init';
import { createCardsRepo } from '../src/repositories/cards-repo';
import { createHoldingsRepo } from '../src/repositories/holdings-repo';
import { createSetsRepo } from '../src/repositories/sets-repo';
import { closeAndDelete } from './helpers/fresh-db';
import type { CardRecord, HoldingRecord, SetRecord } from '../src/domain/types';
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
  subtypes: [],
  types: ['Fire'],
  imageSmall: null,
  imageLarge: null,
  tcgplayer: null,
  cardmarket: null,
  updatedAt: '2026-05-06T00:00:00.000Z',
};

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
  tags: [],
  lotId: null,
  status: 'owned',
};

describe('Collection view', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    document.body.innerHTML = '<div id="content"></div>';
    _resetDbSingletonForTests();
    db = getDb();
    await initializeDataLayer({ db, skipPersistentStorage: true });
    await createSetsRepo(db).upsert(sampleSet);
    await createCardsRepo(db).upsert(sampleCard);
  });

  afterEach(async () => {
    await settle(40);
    document.body.innerHTML = '';
    await closeAndDelete(db);
    _resetDbSingletonForTests();
  });

  async function seedThreeHoldings(): Promise<HoldingRecord[]> {
    const repo = createHoldingsRepo(db);
    const a = await repo.create(baseHolding);
    const b = await repo.create({ ...baseHolding, rawCondition: 'LP' });
    const c = await repo.create({ ...baseHolding, rawCondition: 'MP' });
    return [a, b, c];
  }

  it('mounts headers, toolbar, table, and pagination', async () => {
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountCollectionView(root);
    await settle();
    expect(root.querySelector('h1')?.textContent).toBe('Min samling');
    expect(root.querySelector('[data-region="toolbar"]')).not.toBeNull();
    expect(root.querySelector('[data-region="rows"]')).not.toBeNull();
    expect(root.querySelector('[data-region="pagination"]')).not.toBeNull();
  });

  it('shows holdings as rows with Edit and Slett actions', async () => {
    await seedThreeHoldings();
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountCollectionView(root);
    await settle();

    const rows = root.querySelectorAll<HTMLTableRowElement>('.collection-table__row');
    expect(rows.length).toBe(3);
    const firstRowActions = rows[0]!.querySelectorAll<HTMLButtonElement>('button[data-action]');
    const actionNames = Array.from(firstRowActions).map((b) => b.dataset['action']);
    expect(actionNames).toContain('edit');
    expect(actionNames).toContain('soft-delete');
  });

  it('soft-delete confirms, removes the row, and writes audit', async () => {
    const [first] = await seedThreeHoldings();
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountCollectionView(root);
    await settle();

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    const targetRow = root.querySelector<HTMLTableRowElement>(
      `.collection-table__row[data-holding-id="${first?.id}"]`,
    );
    expect(targetRow).not.toBeNull();
    const deleteBtn = targetRow!.querySelector<HTMLButtonElement>(
      'button[data-action="soft-delete"]',
    );
    deleteBtn?.click();

    await vi.waitFor(async () => {
      const rows = root.querySelectorAll('.collection-table__row');
      expect(rows.length).toBe(2);
    });

    const stored = await db.holdings.get(first?.id ?? '');
    expect(stored?.deletedAt).not.toBeNull();
    confirmSpy.mockRestore();
  });

  it('show-deleted toggle reveals deleted rows with a Restore button', async () => {
    const repo = createHoldingsRepo(db);
    const created = await repo.create(baseHolding);
    await repo.softDelete(created.id);

    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountCollectionView(root);
    await settle();

    expect(root.querySelectorAll('.collection-table__row').length).toBe(0);

    const toggle = root.querySelector<HTMLInputElement>(
      '[data-region="show-deleted"]',
    );
    expect(toggle).not.toBeNull();
    toggle!.checked = true;
    toggle!.dispatchEvent(new Event('change'));
    await settle();

    const rows = root.querySelectorAll('.collection-table__row');
    expect(rows.length).toBe(1);
    const restoreBtn = rows[0]!.querySelector<HTMLButtonElement>(
      'button[data-action="restore"]',
    );
    expect(restoreBtn).not.toBeNull();

    restoreBtn?.click();
    await vi.waitFor(async () => {
      const fetched = await db.holdings.get(created.id);
      expect(fetched?.deletedAt).toBeNull();
    });
  });

  it('counts header reflects live + deleted totals', async () => {
    const repo = createHoldingsRepo(db);
    await repo.create(baseHolding);
    const second = await repo.create({ ...baseHolding, rawCondition: 'LP' });
    await repo.softDelete(second.id);

    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountCollectionView(root);
    await settle();

    const counts = root.querySelector('[data-region="counts"]')?.textContent ?? '';
    expect(counts).toMatch(/1 aktiv/);
    expect(counts).toMatch(/1 slettede/);
  });

  it('does not throw when there are no holdings yet', async () => {
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountCollectionView(root);
    await settle();

    const emptyRow = root.querySelector('.browse-table__empty-row');
    expect(emptyRow?.textContent ?? '').toMatch(/Ingen holdings/i);
  });
});
