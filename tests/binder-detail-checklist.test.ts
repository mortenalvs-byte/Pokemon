// Binder detail view — checklist mode + missing filter integration.
//
// Together these two test files cover the new toolbar logic in the
// binder detail view; this one targets the rendering logic + reverse-
// holo display.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mountBinderDetailView } from '../src/views/binder-detail';
import { _resetDbSingletonForTests, getDb } from '../src/db/database';
import { initializeDataLayer } from '../src/db/init';
import { REVERSE_HOLO_TEMPLATE_MARKER } from '../src/domain/card-variants';
import { createBinderService } from '../src/services/binder-service';
import { createBinderSlotsRepo } from '../src/repositories/binder-slots-repo';
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

describe('Binder detail — checklist + missing filter', () => {
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

  it('toggle switches between Sider and Sjekkliste (default Sider)', async () => {
    const created = await createBinderService(db).createBinderFromSet({
      binder: {
        name: 'Toggle binder',
        description: null,
        binderType: null,
        slotsPerPage: 9,
        completionMode: 'standard',
        sourceSetId: 'base1',
      },
      slots: [
        { pageNumber: 1, slotNumber: 1, targetCardId: 'base1-1', note: null },
        { pageNumber: 1, slotNumber: 2, targetCardId: 'base1-2', note: null },
      ],
    });
    window.location.hash = `binder/${encodeURIComponent(created.binder.id)}`;

    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBinderDetailView(root);
    await settle();

    expect(root.querySelector('.binder-detail-view__pages')).not.toBeNull();
    expect(root.querySelector('.checklist-table')).toBeNull();

    const toggle = root.querySelector<HTMLButtonElement>(
      '[data-mode="checklist"]',
    );
    toggle?.click();
    await settle();

    expect(root.querySelector('.checklist-table')).not.toBeNull();
    expect(root.querySelector('.binder-detail-view__pages')).toBeNull();
  });

  it('checklist row finish column shows "Reverse holo" for template-marker slots without leaking the raw token', async () => {
    const created = await createBinderService(db).createBinderFromSet({
      binder: {
        name: 'Master',
        description: null,
        binderType: null,
        slotsPerPage: 9,
        completionMode: 'master',
        sourceSetId: 'base1',
      },
      slots: [
        { pageNumber: 1, slotNumber: 1, targetCardId: 'base1-1', note: null },
        {
          pageNumber: 1,
          slotNumber: 2,
          targetCardId: 'base1-1',
          note: REVERSE_HOLO_TEMPLATE_MARKER,
        },
      ],
    });
    window.location.hash = `binder/${encodeURIComponent(created.binder.id)}`;

    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBinderDetailView(root);
    await settle();

    root
      .querySelector<HTMLButtonElement>('[data-mode="checklist"]')
      ?.click();
    await settle();

    const rows = root.querySelectorAll<HTMLTableRowElement>(
      '.checklist-table__row',
    );
    expect(rows.length).toBe(2);

    // Row 0 = standard, row 1 = reverse-holo template
    const finishCells = Array.from(rows).map((r) => r.cells[3]?.textContent);
    const noteCells = Array.from(rows).map((r) => r.cells[8]?.textContent);
    expect(finishCells).toEqual(['–', 'Reverse holo']);
    expect(noteCells.every((c) => !c?.includes('template:reverse_holo'))).toBe(
      true,
    );
  });

  it('missing filter narrows checklist to non-complete slots', async () => {
    const created = await createBinderService(db).createBinderFromSet({
      binder: {
        name: 'Filter binder',
        description: null,
        binderType: null,
        slotsPerPage: 9,
        completionMode: 'standard',
        sourceSetId: 'base1',
      },
      slots: [
        { pageNumber: 1, slotNumber: 1, targetCardId: 'base1-1', note: null },
        { pageNumber: 1, slotNumber: 2, targetCardId: 'base1-2', note: null },
        { pageNumber: 1, slotNumber: 3, targetCardId: 'base1-3', note: null },
      ],
    });
    // Complete only slot 1 by assigning a holding for base1-1.
    const holding = await createHoldingsRepo(db).create(baseHolding);
    const slotsRepo = createBinderSlotsRepo(db);
    const slot1 = created.slots[0];
    if (slot1 === undefined) throw new Error('test bootstrap failed');
    await slotsRepo.update(
      slot1.id,
      { holdingId: holding.id, status: 'owned' },
      9,
    );

    window.location.hash = `binder/${encodeURIComponent(created.binder.id)}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBinderDetailView(root);
    await settle();

    // Switch to checklist and apply missing filter.
    root
      .querySelector<HTMLButtonElement>('[data-mode="checklist"]')
      ?.click();
    await settle();

    const filterSelect = root.querySelector<HTMLSelectElement>(
      '[data-region="filter-select"]',
    );
    filterSelect!.value = 'missing';
    filterSelect!.dispatchEvent(new Event('change'));
    await settle();

    const rows = root.querySelectorAll<HTMLTableRowElement>(
      '.checklist-table__row',
    );
    // Only the two not-yet-owned slots remain.
    expect(rows.length).toBe(2);
  });

  it('completed filter shows only KRAVSPEC §6 complete slots', async () => {
    const created = await createBinderService(db).createBinderFromSet({
      binder: {
        name: 'Filter binder',
        description: null,
        binderType: null,
        slotsPerPage: 9,
        completionMode: 'standard',
        sourceSetId: 'base1',
      },
      slots: [
        { pageNumber: 1, slotNumber: 1, targetCardId: 'base1-1', note: null },
        { pageNumber: 1, slotNumber: 2, targetCardId: 'base1-2', note: null },
      ],
    });
    const holding = await createHoldingsRepo(db).create(baseHolding);
    const slotsRepo = createBinderSlotsRepo(db);
    const slot1 = created.slots[0];
    if (slot1 === undefined) throw new Error('test bootstrap failed');
    await slotsRepo.update(
      slot1.id,
      { holdingId: holding.id, status: 'owned' },
      9,
    );

    window.location.hash = `binder/${encodeURIComponent(created.binder.id)}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBinderDetailView(root);
    await settle();

    root
      .querySelector<HTMLButtonElement>('[data-mode="checklist"]')
      ?.click();
    await settle();

    const filterSelect = root.querySelector<HTMLSelectElement>(
      '[data-region="filter-select"]',
    );
    filterSelect!.value = 'completed';
    filterSelect!.dispatchEvent(new Event('change'));
    await settle();

    const rows = root.querySelectorAll<HTMLTableRowElement>(
      '.checklist-table__row',
    );
    expect(rows.length).toBe(1);
    expect(rows[0]?.cells[1]?.textContent).toBe('Card 1');
  });

  it('Sider-view filter preserves grid positions (filtered slots stay in grid as muted)', async () => {
    const created = await createBinderService(db).createBinderFromSet({
      binder: {
        name: 'Grid filter',
        description: null,
        binderType: null,
        slotsPerPage: 9,
        completionMode: 'standard',
        sourceSetId: 'base1',
      },
      slots: [
        { pageNumber: 1, slotNumber: 1, targetCardId: 'base1-1', note: null },
        { pageNumber: 1, slotNumber: 2, targetCardId: 'base1-2', note: null },
        { pageNumber: 1, slotNumber: 3, targetCardId: 'base1-3', note: null },
      ],
    });
    const holding = await createHoldingsRepo(db).create(baseHolding);
    const slotsRepo = createBinderSlotsRepo(db);
    const slot1 = created.slots[0];
    if (slot1 === undefined) throw new Error('test bootstrap failed');
    await slotsRepo.update(
      slot1.id,
      { holdingId: holding.id, status: 'owned' },
      9,
    );

    window.location.hash = `binder/${encodeURIComponent(created.binder.id)}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBinderDetailView(root);
    await settle();

    // Stay in Sider mode, apply missing filter.
    const filterSelect = root.querySelector<HTMLSelectElement>(
      '[data-region="filter-select"]',
    );
    filterSelect!.value = 'missing';
    filterSelect!.dispatchEvent(new Event('change'));
    await settle();

    // All three slots still occupy a grid cell — only the matching ones
    // are NOT marked filtered-out.
    const tiles = root.querySelectorAll<HTMLElement>('.binder-slot');
    expect(tiles.length).toBe(3);
    const filteredOutCount = root.querySelectorAll(
      '.binder-slot--filtered-out',
    ).length;
    expect(filteredOutCount).toBe(1); // only slot 1 (the completed one) is muted
  });

  it('Sider-view filtered-out slots have no interactive controls', async () => {
    const created = await createBinderService(db).createBinderFromSet({
      binder: {
        name: 'No interactive on filtered',
        description: null,
        binderType: null,
        slotsPerPage: 9,
        completionMode: 'standard',
        sourceSetId: 'base1',
      },
      slots: [
        { pageNumber: 1, slotNumber: 1, targetCardId: 'base1-1', note: null },
        { pageNumber: 1, slotNumber: 2, targetCardId: 'base1-2', note: null },
      ],
    });
    // Complete slot 1 so the missing filter hides exactly that slot.
    const holding = await createHoldingsRepo(db).create(baseHolding);
    const slotsRepo = createBinderSlotsRepo(db);
    const slot1 = created.slots[0];
    if (slot1 === undefined) throw new Error('test bootstrap failed');
    await slotsRepo.update(
      slot1.id,
      { holdingId: holding.id, status: 'owned' },
      9,
    );

    window.location.hash = `binder/${encodeURIComponent(created.binder.id)}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBinderDetailView(root);
    await settle();

    const filterSelect = root.querySelector<HTMLSelectElement>(
      '[data-region="filter-select"]',
    );
    filterSelect!.value = 'missing';
    filterSelect!.dispatchEvent(new Event('change'));
    await settle();

    const filteredOutTile = root.querySelector<HTMLElement>(
      '.binder-slot--filtered-out',
    );
    expect(filteredOutTile).not.toBeNull();
    expect(filteredOutTile?.getAttribute('aria-hidden')).toBe('true');

    // No action buttons inside the filtered tile.
    expect(
      filteredOutTile?.querySelector('[data-action="assign"]'),
    ).toBeNull();
    expect(
      filteredOutTile?.querySelector('[data-action="open-menu"]'),
    ).toBeNull();
    expect(
      filteredOutTile?.querySelector('[data-action="open-card"]'),
    ).toBeNull();
    // No focusable descendants at all (the tile is aria-hidden).
    expect(
      filteredOutTile?.querySelectorAll('button, a, input, select').length,
    ).toBe(0);

    // Visible/matching tiles still have their action buttons.
    const matchingTiles = root.querySelectorAll<HTMLElement>(
      '.binder-slot:not(.binder-slot--filtered-out)',
    );
    expect(matchingTiles.length).toBe(1);
    expect(
      matchingTiles[0]?.querySelector('[data-action="assign"]'),
    ).not.toBeNull();
    expect(
      matchingTiles[0]?.querySelector('[data-action="open-menu"]'),
    ).not.toBeNull();
  });

  it('clicking inside a filtered-out slot does not open assign or status dialog', async () => {
    const created = await createBinderService(db).createBinderFromSet({
      binder: {
        name: 'Click filtered',
        description: null,
        binderType: null,
        slotsPerPage: 9,
        completionMode: 'standard',
        sourceSetId: 'base1',
      },
      slots: [
        { pageNumber: 1, slotNumber: 1, targetCardId: 'base1-1', note: null },
        { pageNumber: 1, slotNumber: 2, targetCardId: 'base1-2', note: null },
      ],
    });
    const holding = await createHoldingsRepo(db).create(baseHolding);
    const slotsRepo = createBinderSlotsRepo(db);
    const slot1 = created.slots[0];
    if (slot1 === undefined) throw new Error('test bootstrap failed');
    await slotsRepo.update(
      slot1.id,
      { holdingId: holding.id, status: 'owned' },
      9,
    );

    window.location.hash = `binder/${encodeURIComponent(created.binder.id)}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBinderDetailView(root);
    await settle();

    const filterSelect = root.querySelector<HTMLSelectElement>(
      '[data-region="filter-select"]',
    );
    filterSelect!.value = 'missing';
    filterSelect!.dispatchEvent(new Event('change'));
    await settle();

    const filteredOutTile = root.querySelector<HTMLElement>(
      '.binder-slot--filtered-out',
    );
    expect(filteredOutTile).not.toBeNull();

    // Click anywhere inside the filtered tile — there should be nothing
    // interactive to open a dialog.
    filteredOutTile?.click();
    await settle();

    expect(document.querySelector('dialog.app-dialog')).toBeNull();
  });
});
