// PR 17 — search inside the assign-holding modal for blank manual
// slots. Empty slots show all live holdings; the new search field
// uses `cardMatchesQuery` so the user can find one by name, id,
// number, or set id even with hundreds of live holdings.
//
// For target slots the search input stays hidden — the modal already
// filters to the slot's targetCardId.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildAssignHoldingModal } from '../src/components/assign-holding-modal';
import { _resetDbSingletonForTests, getDb } from '../src/db/database';
import { initializeDataLayer } from '../src/db/init';
import { closeAndDelete } from './helpers/fresh-db';
import { newId } from '../src/utils/ids';
import type {
  BinderSlotRecord,
  CardRecord,
  HoldingRecord,
  SetRecord,
} from '../src/domain/types';
import type { PokemonTrackerDB } from '../src/db/database';

async function settle(ms = 100): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const setRecord: SetRecord = {
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

const cardCharizard: CardRecord = {
  id: 'base1-4',
  setId: 'base1',
  name: 'Charizard',
  number: '4',
  rarity: 'Rare Holo',
  supertype: 'Pokémon',
  subtypes: [],
  types: [],
  imageSmall: null,
  imageLarge: null,
  tcgplayer: { prices: { holofoil: { market: 1 } } },
  cardmarket: null,
  updatedAt: '2026-05-06T00:00:00.000Z',
};

const cardAlakazam: CardRecord = { ...cardCharizard, id: 'base1-1', name: 'Alakazam', number: '1' };
const cardPikachu: CardRecord = { ...cardCharizard, id: 'base1-58', name: 'Pikachu', number: '58' };

function makeHolding(cardId: string): HoldingRecord {
  const now = '2026-05-06T00:00:00.000Z';
  return {
    id: newId(),
    cardId,
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
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

function blankSlot(): BinderSlotRecord {
  const now = '2026-05-06T00:00:00.000Z';
  return {
    id: newId(),
    binderId: 'b-1',
    pageNumber: 1,
    slotNumber: 1,
    targetCardId: null,
    holdingId: null,
    status: 'empty',
    note: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

function targetSlot(targetCardId: string): BinderSlotRecord {
  const now = '2026-05-06T00:00:00.000Z';
  return {
    id: newId(),
    binderId: 'b-1',
    pageNumber: 1,
    slotNumber: 1,
    targetCardId,
    holdingId: null,
    status: 'wanted',
    note: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

describe('Assign-holding modal search (PR 17)', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    document.body.innerHTML = '';
    _resetDbSingletonForTests();
    db = getDb();
    await initializeDataLayer({ db, skipPersistentStorage: true });
    await db.sets.put(setRecord);
    await db.cards.bulkPut([cardCharizard, cardAlakazam, cardPikachu]);
    await db.holdings.bulkAdd([
      makeHolding('base1-4'),
      makeHolding('base1-1'),
      makeHolding('base1-58'),
    ]);
  });

  afterEach(async () => {
    document.body.innerHTML = '';
    await closeAndDelete(db);
    _resetDbSingletonForTests();
  });

  function mountModal(slot: BinderSlotRecord): HTMLElement {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const content = buildAssignHoldingModal({ slot, slotsPerPage: 9 });
    content.mount(host, () => {
      // close noop for tests
    });
    return host;
  }

  it('blank manual slot shows the search input and all live holdings', async () => {
    const host = mountModal(blankSlot());
    await settle();
    const searchWrap = host.querySelector('[data-region="search-wrap"]');
    const searchInput = host.querySelector<HTMLInputElement>(
      '[data-region="search-input"]',
    );
    const select = host.querySelector<HTMLSelectElement>(
      '[data-region="holding-select"]',
    );
    expect(searchWrap).not.toBeNull();
    expect((searchWrap as HTMLElement).hidden).toBe(false);
    expect(searchInput).not.toBeNull();
    expect(select?.options.length).toBe(3);
  });

  it('target slot hides the search input and pre-filters to the target card', async () => {
    const host = mountModal(targetSlot('base1-4'));
    await settle();
    const searchWrap = host.querySelector('[data-region="search-wrap"]');
    expect((searchWrap as HTMLElement).hidden).toBe(true);
    const select = host.querySelector<HTMLSelectElement>(
      '[data-region="holding-select"]',
    );
    expect(select?.options.length).toBe(1);
    expect(select?.options[0]?.textContent).toContain('Charizard');
  });

  it('typing "Charizard" narrows the select to one matching holding', async () => {
    const host = mountModal(blankSlot());
    await settle();
    const searchInput = host.querySelector<HTMLInputElement>(
      '[data-region="search-input"]',
    );
    if (searchInput === null) throw new Error('search input missing');
    searchInput.value = 'Charizard';
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    await settle(250);
    const select = host.querySelector<HTMLSelectElement>(
      '[data-region="holding-select"]',
    );
    expect(select?.options.length).toBe(1);
    expect(select?.options[0]?.textContent).toContain('Charizard');
  });

  it('typing "base1-58" narrows to Pikachu via card-id match', async () => {
    const host = mountModal(blankSlot());
    await settle();
    const searchInput = host.querySelector<HTMLInputElement>(
      '[data-region="search-input"]',
    );
    if (searchInput === null) throw new Error('search input missing');
    searchInput.value = 'base1-58';
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    await settle(250);
    const select = host.querySelector<HTMLSelectElement>(
      '[data-region="holding-select"]',
    );
    expect(select?.options.length).toBe(1);
    expect(select?.options[0]?.textContent).toContain('Pikachu');
  });

  it('typing a query with no matches surfaces a helpful empty state', async () => {
    const host = mountModal(blankSlot());
    await settle();
    const searchInput = host.querySelector<HTMLInputElement>(
      '[data-region="search-input"]',
    );
    if (searchInput === null) throw new Error('search input missing');
    searchInput.value = 'Mewtwo';
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    await settle(250);
    const empty = host.querySelector<HTMLElement>('[data-region="empty"]');
    expect(empty?.hidden).toBe(false);
    expect(empty?.textContent).toContain('Ingen holdings matcher "Mewtwo"');
    const submitButton = host.querySelector<HTMLButtonElement>(
      '.assign-holding-modal__submit',
    );
    expect(submitButton?.disabled).toBe(true);
  });

  it('result-count chip reflects "N av M match" while filtered', async () => {
    const host = mountModal(blankSlot());
    await settle();
    const resultCount = host.querySelector<HTMLElement>(
      '[data-region="result-count"]',
    );
    expect(resultCount?.textContent).toBe('3 holdings');
    const searchInput = host.querySelector<HTMLInputElement>(
      '[data-region="search-input"]',
    );
    if (searchInput === null) throw new Error('search input missing');
    searchInput.value = 'Charizard';
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    await settle(250);
    expect(resultCount?.textContent).toBe('1 av 3 match');
  });
});
