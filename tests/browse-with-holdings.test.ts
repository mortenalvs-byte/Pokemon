// Browse view + holdings integration. Three things to pin:
//   1. The "Legg til i samling" button is now ENABLED and opens the
//      holding form.
//   2. The owned/not-owned filter narrows the table by reading live
//      holdings.
//   3. Mount + filter + sort + pagination + navigation paths still
//      do not write user-owned data — only an explicit save through
//      the dialog mutates `holdings`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountBrowseView } from '../src/views/browse';
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
    tcgplayer: { prices: { normal: { market: 1 }, holofoil: { market: 1 }, reverseHolofoil: { market: 1 }, "1stEditionNormal": { market: 1 }, "1stEditionHolofoil": { market: 1 } } },
    cardmarket: null,
    updatedAt: '2026-05-06T00:00:00.000Z',
  };
}

const baseHolding: HoldingInput = {
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
};

describe('Browse + holdings integration', () => {
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

  it('"Legg til i samling" is enabled and opens a holding form dialog', async () => {
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBrowseView(root);
    await settle();

    const addBtn = root.querySelector<HTMLButtonElement>(
      '[data-action="add-to-collection"]',
    );
    expect(addBtn).not.toBeNull();
    expect(addBtn?.disabled).toBe(false);

    addBtn?.click();
    await settle();

    const dialog = document.querySelector('dialog.app-dialog');
    expect(dialog).not.toBeNull();
    expect(dialog?.querySelector('form.holding-form')).not.toBeNull();

    // Cancel the dialog so the test does not leak.
    dialog
      ?.querySelector<HTMLButtonElement>('[data-action="cancel"]')
      ?.click();
    await settle();
  });

  it('"Legg til i ønskeliste" is enabled (PR 7b shipped wishlist UI)', async () => {
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBrowseView(root);
    await settle();

    const wishlistButtons = root.querySelectorAll<HTMLButtonElement>(
      '[data-action="add-to-wishlist"]',
    );
    expect(wishlistButtons.length).toBeGreaterThan(0);
    for (const btn of wishlistButtons) {
      expect(btn.disabled).toBe(false);
    }
  });

  it('owned filter narrows rows to cards with at least one live holding', async () => {
    await createHoldingsRepo(db).create(baseHolding); // base1-1 only

    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBrowseView(root);
    await settle();

    const ownership = root.querySelector<HTMLSelectElement>(
      '[data-region="ownership-filter"]',
    );
    expect(ownership).not.toBeNull();
    ownership!.value = 'owned';
    ownership!.dispatchEvent(new Event('change'));
    await settle();

    const rows = root.querySelectorAll<HTMLTableRowElement>(
      '.browse-table__row',
    );
    expect(rows.length).toBe(1);
    expect(rows[0]?.dataset['cardId']).toBe('base1-1');
  });

  it('not-owned filter excludes cards with a live holding', async () => {
    await createHoldingsRepo(db).create(baseHolding);

    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBrowseView(root);
    await settle();

    const ownership = root.querySelector<HTMLSelectElement>(
      '[data-region="ownership-filter"]',
    );
    ownership!.value = 'not-owned';
    ownership!.dispatchEvent(new Event('change'));
    await settle();

    const rows = root.querySelectorAll<HTMLTableRowElement>(
      '.browse-table__row',
    );
    const ids = Array.from(rows).map((r) => r.dataset['cardId']);
    expect(ids).not.toContain('base1-1');
  });

  it('passive interactions (mount, filter, sort, page) do not write any user data', async () => {
    await createHoldingsRepo(db).create(baseHolding);
    const beforeHoldings = await db.holdings.toArray();
    const beforeAudits = await db.auditLog.toArray();

    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBrowseView(root);
    await settle();

    // Drive every passive control we can.
    const search = root.querySelector<HTMLInputElement>(
      '[data-region="search"]',
    );
    search!.value = 'card';
    search!.dispatchEvent(new Event('input'));
    await settle(200);

    (root.querySelector<HTMLSelectElement>('[data-region="sort"]') as HTMLSelectElement).value = 'name';
    root
      .querySelector<HTMLSelectElement>('[data-region="sort"]')
      ?.dispatchEvent(new Event('change'));
    await settle();

    (root.querySelector<HTMLSelectElement>('[data-region="ownership-filter"]') as HTMLSelectElement).value = 'owned';
    root
      .querySelector<HTMLSelectElement>('[data-region="ownership-filter"]')
      ?.dispatchEvent(new Event('change'));
    await settle();

    expect(await db.holdings.toArray()).toEqual(beforeHoldings);
    expect(await db.auditLog.toArray()).toEqual(beforeAudits);
  });

  it('save through the dialog produces exactly one new holding and one audit row', async () => {
    const beforeAudits = await db.auditLog.where('action').equals('holding_created').count();

    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBrowseView(root);
    await settle();

    const firstAddBtn = root.querySelector<HTMLButtonElement>(
      '[data-action="add-to-collection"]',
    );
    firstAddBtn?.click();
    await settle();

    const form = document.querySelector<HTMLFormElement>('form.holding-form');
    expect(form).not.toBeNull();
    form!.requestSubmit();

    await vi.waitFor(async () => {
      const after = await db.auditLog
        .where('action')
        .equals('holding_created')
        .count();
      expect(after).toBe(beforeAudits + 1);
    });

    const holdings = await db.holdings.toArray();
    expect(holdings.length).toBe(1);
  });
});
