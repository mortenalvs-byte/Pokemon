// Card Detail + holdings integration. Add to collection is enabled,
// the "Dine kort" section renders the user's holdings for this card,
// and edit / soft-delete / restore from inside Card Detail go through
// `holdingsRepo`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountCardDetailView } from '../src/views/card-detail';
import { _resetDbSingletonForTests, getDb } from '../src/db/database';
import { initializeDataLayer } from '../src/db/init';
import { createCardsRepo } from '../src/repositories/cards-repo';
import { createHoldingsRepo } from '../src/repositories/holdings-repo';
import { createSetsRepo } from '../src/repositories/sets-repo';
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
  subtypes: [],
  types: ['Fire'],
  imageSmall: null,
  imageLarge: null,
  tcgplayer: { prices: { normal: { market: 1 }, holofoil: { market: 1 }, reverseHolofoil: { market: 1 }, "1stEditionNormal": { market: 1 }, "1stEditionHolofoil": { market: 1 } } },
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

describe('Card Detail + holdings', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    document.body.innerHTML = '<div id="content"></div>';
    _resetDbSingletonForTests();
    db = getDb();
    await initializeDataLayer({ db, skipPersistentStorage: true });
    await createSetsRepo(db).upsert(sampleSet);
    await createCardsRepo(db).upsert(sampleCard);
    window.location.hash = `card/${encodeURIComponent('base1-4')}`;
  });

  afterEach(async () => {
    await settle(40);
    document.body.innerHTML = '';
    await closeAndDelete(db);
    _resetDbSingletonForTests();
    window.location.hash = '';
  });

  it('"Legg til i samling" is enabled and opens the holding form', async () => {
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountCardDetailView(root);
    await settle();

    const button = root.querySelector<HTMLButtonElement>(
      '[data-action="add-to-collection"]',
    );
    expect(button).not.toBeNull();
    expect(button?.disabled).toBe(false);

    button?.click();
    await settle();
    const dialog = document.querySelector('dialog.app-dialog');
    expect(dialog).not.toBeNull();
    dialog
      ?.querySelector<HTMLButtonElement>('[data-action="cancel"]')
      ?.click();
    await settle();
  });

  it('shows "Dine kort" empty state when no holdings exist', async () => {
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountCardDetailView(root);
    await settle();
    expect(root.textContent ?? '').toMatch(/Ingen holdings for dette kortet/i);
  });

  it('lists existing holdings in the "Dine kort" section', async () => {
    const repo = createHoldingsRepo(db);
    await repo.create(baseHolding);
    await repo.create({ ...baseHolding, rawCondition: 'LP', quantity: 2 });

    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountCardDetailView(root);
    await settle();

    const rows = root.querySelectorAll(
      '.card-detail-view__holdings-table tbody tr',
    );
    expect(rows.length).toBe(2);
  });

  it('soft-delete from the holdings table removes the row + writes audit', async () => {
    const repo = createHoldingsRepo(db);
    const holding = await repo.create(baseHolding);

    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountCardDetailView(root);
    await settle();

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const tbody = root.querySelector(
      '.card-detail-view__holdings-table tbody',
    );
    expect(tbody).not.toBeNull();
    const button = tbody?.querySelector<HTMLButtonElement>('button');
    // Find the Slett button by text.
    const deleteButton = Array.from(
      tbody!.querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => b.textContent?.trim() === 'Slett');
    expect(deleteButton).toBeDefined();

    deleteButton?.click();
    await vi.waitFor(async () => {
      const stored = await repo.get(holding.id);
      expect(stored?.deletedAt).not.toBeNull();
    });

    const audits = await db.auditLog
      .where('action')
      .equals('holding_soft_deleted')
      .toArray();
    expect(audits.length).toBe(1);

    confirmSpy.mockRestore();
    void button; // avoid unused variable warning
  });
});
