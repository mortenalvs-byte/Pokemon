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
    tcgplayer: { prices: { normal: { market: 1 }, holofoil: { market: 1 }, reverseHolofoil: { market: 1 }, "1stEditionNormal": { market: 1 }, "1stEditionHolofoil": { market: 1 } } },
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
      '[data-action="materialize-all"]',
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
      .querySelector<HTMLButtonElement>('[data-action="materialize-all"]')
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

// PR 18 — partial materialise via per-row checkboxes + the new
// "Legg valgte i samling" toolbar button. Also covers the per-row
// "Legg i samling" button and the materialised-row visual state.
describe('Lot detail — partial materialise (PR 18)', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    document.body.innerHTML = '<div id="content"></div>';
    _resetDbSingletonForTests();
    db = getDb();
    await initializeDataLayer({ db, skipPersistentStorage: true });
    await createSetsRepo(db).upsert(sampleSet);
    await createCardsRepo(db).upsertMany([makeCard(1), makeCard(2), makeCard(3)]);
    window.location.hash = '';
  });

  afterEach(async () => {
    await closeAndDelete(db);
    _resetDbSingletonForTests();
  });

  function getRoot(): HTMLElement {
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    return root;
  }

  it('"Legg hele loten i samling" carries the count and is disabled until allocation', async () => {
    const lot = await createLotsRepo(db).create({
      name: 'L',
      purchaseDate: '2026-04-01T00:00:00.000Z',
      totalCost: 100,
      currency: 'NOK',
      allocationMethod: 'equal',
      notes: null,
    });
    await createLotItemsRepo(db).create(lotItem(lot.id, 'base1-1'));
    await createLotItemsRepo(db).create(lotItem(lot.id, 'base1-2'));
    window.location.hash = `lot/${encodeURIComponent(lot.id)}`;
    mountLotDetailView(getRoot());
    await settle();

    const allBtn = getRoot().querySelector<HTMLButtonElement>(
      '[data-action="materialize-all"]',
    );
    expect(allBtn?.textContent).toContain('Legg hele loten i samling');
    // No allocation yet → 0 ready, button disabled.
    expect(allBtn?.textContent).toContain('(0)');
    expect(allBtn?.disabled).toBe(true);

    getRoot()
      .querySelector<HTMLButtonElement>('[data-action="apply-allocation"]')
      ?.click();
    await vi.waitFor(async () => {
      const items = await db.lotItems.toArray();
      expect(items.every((i) => i.allocatedCost !== null)).toBe(true);
    });
    await settle();

    const allBtn2 = getRoot().querySelector<HTMLButtonElement>(
      '[data-action="materialize-all"]',
    );
    expect(allBtn2?.textContent).toContain('(2)');
    expect(allBtn2?.disabled).toBe(false);
  });

  it('"Legg valgte i samling" stays at (0) and disabled until rows are ticked', async () => {
    const lot = await createLotsRepo(db).create({
      name: 'L',
      purchaseDate: '2026-04-01T00:00:00.000Z',
      totalCost: 100,
      currency: 'NOK',
      allocationMethod: 'equal',
      notes: null,
    });
    await createLotItemsRepo(db).create(lotItem(lot.id, 'base1-1'));
    await createLotItemsRepo(db).create(lotItem(lot.id, 'base1-2'));
    window.location.hash = `lot/${encodeURIComponent(lot.id)}`;
    mountLotDetailView(getRoot());
    await settle();
    getRoot()
      .querySelector<HTMLButtonElement>('[data-action="apply-allocation"]')
      ?.click();
    await vi.waitFor(async () => {
      const items = await db.lotItems.toArray();
      expect(items.every((i) => i.allocatedCost !== null)).toBe(true);
    });
    await settle();

    const sel = getRoot().querySelector<HTMLButtonElement>(
      '[data-action="materialize-selected"]',
    );
    expect(sel?.textContent).toContain('Legg valgte i samling (0)');
    expect(sel?.disabled).toBe(true);

    // Tick the first row's checkbox.
    const firstCheckbox = getRoot().querySelector<HTMLInputElement>(
      'input[data-action="select-item"]',
    );
    expect(firstCheckbox).not.toBeNull();
    firstCheckbox!.checked = true;
    firstCheckbox!.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();

    const sel2 = getRoot().querySelector<HTMLButtonElement>(
      '[data-action="materialize-selected"]',
    );
    expect(sel2?.textContent).toContain('Legg valgte i samling (1)');
    expect(sel2?.disabled).toBe(false);
  });

  it('partial materialise via toolbar moves only the selected items into the collection', async () => {
    const lot = await createLotsRepo(db).create({
      name: 'L',
      purchaseDate: '2026-04-01T00:00:00.000Z',
      totalCost: 300,
      currency: 'NOK',
      allocationMethod: 'equal',
      notes: null,
    });
    const item1 = await createLotItemsRepo(db).create(lotItem(lot.id, 'base1-1'));
    const item2 = await createLotItemsRepo(db).create(lotItem(lot.id, 'base1-2'));
    const item3 = await createLotItemsRepo(db).create(lotItem(lot.id, 'base1-3'));
    window.location.hash = `lot/${encodeURIComponent(lot.id)}`;
    mountLotDetailView(getRoot());
    await settle();
    getRoot()
      .querySelector<HTMLButtonElement>('[data-action="apply-allocation"]')
      ?.click();
    await vi.waitFor(async () => {
      const items = await db.lotItems.toArray();
      expect(items.every((i) => i.allocatedCost !== null)).toBe(true);
    });
    await settle();

    // Tick item1 + item3, leave item2.
    const cb1 = getRoot().querySelector<HTMLInputElement>(
      `input[data-action="select-item"][data-item-id="${item1.id}"]`,
    );
    const cb3 = getRoot().querySelector<HTMLInputElement>(
      `input[data-action="select-item"][data-item-id="${item3.id}"]`,
    );
    cb1!.checked = true;
    cb1!.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    // Re-fetch cb3 since the rerender replaced the row.
    const cb3b = getRoot().querySelector<HTMLInputElement>(
      `input[data-action="select-item"][data-item-id="${item3.id}"]`,
    );
    cb3b!.checked = true;
    cb3b!.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    void cb3;

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    getRoot()
      .querySelector<HTMLButtonElement>(
        '[data-action="materialize-selected"]',
      )
      ?.click();
    await vi.waitFor(async () => {
      expect(await db.holdings.count()).toBe(2);
    });
    confirmSpy.mockRestore();

    const items = await createLotItemsRepo(db).listByLotId(lot.id);
    const byId = new Map(items.map((i) => [i.id, i] as const));
    expect(byId.get(item1.id)?.holdingId).not.toBeNull();
    expect(byId.get(item2.id)?.holdingId).toBeNull();
    expect(byId.get(item3.id)?.holdingId).not.toBeNull();
  });

  it('per-row "Legg i samling" button creates one holding for that row', async () => {
    const lot = await createLotsRepo(db).create({
      name: 'L',
      purchaseDate: '2026-04-01T00:00:00.000Z',
      totalCost: 200,
      currency: 'NOK',
      allocationMethod: 'equal',
      notes: null,
    });
    const item1 = await createLotItemsRepo(db).create(lotItem(lot.id, 'base1-1'));
    await createLotItemsRepo(db).create(lotItem(lot.id, 'base1-2'));
    window.location.hash = `lot/${encodeURIComponent(lot.id)}`;
    mountLotDetailView(getRoot());
    await settle();
    getRoot()
      .querySelector<HTMLButtonElement>('[data-action="apply-allocation"]')
      ?.click();
    await vi.waitFor(async () => {
      const items = await db.lotItems.toArray();
      expect(items.every((i) => i.allocatedCost !== null)).toBe(true);
    });
    await settle();

    const rowOne = getRoot().querySelector<HTMLTableRowElement>(
      `tr[data-item-id="${item1.id}"]`,
    );
    const addOne = rowOne?.querySelector<HTMLButtonElement>(
      '[data-action="materialize-one"]',
    );
    expect(addOne).not.toBeNull();
    expect(addOne?.disabled).toBe(false);
    addOne!.click();
    await vi.waitFor(async () => {
      expect(await db.holdings.count()).toBe(1);
    });

    const items = await createLotItemsRepo(db).listByLotId(lot.id);
    expect(items.find((i) => i.id === item1.id)?.holdingId).not.toBeNull();
  });

  it('materialised row gains the materialised CSS class and shows "✓ I samlingen"', async () => {
    const lot = await createLotsRepo(db).create({
      name: 'L',
      purchaseDate: '2026-04-01T00:00:00.000Z',
      totalCost: 100,
      currency: 'NOK',
      allocationMethod: 'equal',
      notes: null,
    });
    await createLotItemsRepo(db).create(lotItem(lot.id, 'base1-1'));
    window.location.hash = `lot/${encodeURIComponent(lot.id)}`;
    mountLotDetailView(getRoot());
    await settle();
    getRoot()
      .querySelector<HTMLButtonElement>('[data-action="apply-allocation"]')
      ?.click();
    await vi.waitFor(async () => {
      const items = await db.lotItems.toArray();
      expect(items[0]?.allocatedCost).not.toBeNull();
    });
    await settle();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    getRoot()
      .querySelector<HTMLButtonElement>('[data-action="materialize-all"]')
      ?.click();
    await vi.waitFor(async () => {
      expect(await db.holdings.count()).toBe(1);
    });
    confirmSpy.mockRestore();
    await settle();

    const row = getRoot().querySelector<HTMLTableRowElement>(
      '.lot-items-table__row',
    );
    expect(row?.classList.contains('lot-items-table__row--materialized')).toBe(
      true,
    );
    expect(row?.querySelector('.lot-items-table__locked')?.textContent).toBe(
      '✓ I samlingen',
    );
  });

  it('pagination is hidden for ≤ 50 items', async () => {
    const small = await createLotsRepo(db).create({
      name: 'Small',
      purchaseDate: '2026-04-01T00:00:00.000Z',
      totalCost: 100,
      currency: 'NOK',
      allocationMethod: 'equal',
      notes: null,
    });
    await createLotItemsRepo(db).create(lotItem(small.id, 'base1-1'));
    window.location.hash = `lot/${encodeURIComponent(small.id)}`;
    mountLotDetailView(getRoot());
    await settle();
    expect(
      getRoot().querySelector<HTMLElement>(
        '.lot-detail-view__pagination',
      )?.hidden,
    ).toBe(true);
  });

  // PR 18 hardening — real pagination flow with > 50 items so the
  // page summary, Neste / Forrige buttons, and visible-page-only
  // select-all behaviour are all locked in by tests, not just by
  // the browser-preview check in the PR body.
  it('pagination flow with 51 items: navigation, summary, and visible-page select-all', async () => {
    // 51 cards so we have exactly two pages with 50 + 1 split.
    const cards: CardRecord[] = [];
    for (let i = 1; i <= 51; i += 1) cards.push(makeCard(i));
    await createCardsRepo(db).upsertMany(cards);

    const lot = await createLotsRepo(db).create({
      name: 'Big lot',
      purchaseDate: '2026-04-01T00:00:00.000Z',
      totalCost: 5100,
      currency: 'NOK',
      allocationMethod: 'equal',
      notes: null,
    });
    for (let i = 1; i <= 51; i += 1) {
      await createLotItemsRepo(db).create(lotItem(lot.id, `base1-${i}`));
    }
    window.location.hash = `lot/${encodeURIComponent(lot.id)}`;
    mountLotDetailView(getRoot());
    await settle();
    // Allocate so every item has allocatedCost (and so per-row
    // checkboxes render).
    getRoot()
      .querySelector<HTMLButtonElement>('[data-action="apply-allocation"]')
      ?.click();
    await vi.waitFor(async () => {
      const items = await db.lotItems.toArray();
      expect(items.every((i) => i.allocatedCost !== null)).toBe(true);
    });
    await settle();

    // Pagination is visible with the right summary.
    const pagination = getRoot().querySelector<HTMLElement>(
      '.lot-detail-view__pagination',
    );
    expect(pagination).not.toBeNull();
    expect(pagination!.hidden).toBe(false);
    const summary = (): string =>
      getRoot()
        .querySelector('[data-region="page-summary"]')
        ?.textContent?.trim() ?? '';
    expect(summary()).toBe('Side 1 av 2 — viser 1–50 av 51');
    expect(
      getRoot().querySelectorAll('.lot-items-table__row').length,
    ).toBe(50);

    // Visible-page select-all only ticks the 50 visible rows on page 1.
    const selectAll = getRoot().querySelector<HTMLInputElement>(
      '[data-region="select-all"]',
    );
    expect(selectAll).not.toBeNull();
    selectAll!.checked = true;
    selectAll!.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    const selectedAfterSelectAll = getRoot().querySelector<HTMLButtonElement>(
      '[data-action="materialize-selected"]',
    );
    expect(selectedAfterSelectAll?.textContent).toContain(
      'Legg valgte i samling (50)',
    );

    // Neste advances to page 2 and shows the last single item.
    getRoot()
      .querySelector<HTMLButtonElement>('[data-action="next-page"]')
      ?.click();
    await settle();
    expect(summary()).toBe('Side 2 av 2 — viser 51–51 av 51');
    expect(
      getRoot().querySelectorAll('.lot-items-table__row').length,
    ).toBe(1);

    // The 51st row's checkbox is NOT ticked — select-all on page 1
    // did not affect items on other pages.
    const cb51 = getRoot().querySelector<HTMLInputElement>(
      'input[data-action="select-item"]',
    );
    expect(cb51).not.toBeNull();
    expect(cb51!.checked).toBe(false);
    // The total selection count therefore stayed at 50.
    expect(
      getRoot()
        .querySelector('[data-action="materialize-selected"]')
        ?.textContent,
    ).toContain('Legg valgte i samling (50)');

    // Forrige goes back to page 1.
    getRoot()
      .querySelector<HTMLButtonElement>('[data-action="prev-page"]')
      ?.click();
    await settle();
    expect(summary()).toBe('Side 1 av 2 — viser 1–50 av 51');
    expect(
      getRoot().querySelectorAll('.lot-items-table__row').length,
    ).toBe(50);
    // Forrige on page 1 is now disabled; Neste is enabled.
    expect(
      getRoot().querySelector<HTMLButtonElement>(
        '[data-action="prev-page"]',
      )?.disabled,
    ).toBe(true);
    expect(
      getRoot().querySelector<HTMLButtonElement>(
        '[data-action="next-page"]',
      )?.disabled,
    ).toBe(false);
  });
});
