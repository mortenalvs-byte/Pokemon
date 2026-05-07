// PR 17 — search + filter additions in the binder detail view.
//
// Verifies:
//   1. The new "empty" filter shows only fully-blank slots (no
//      targetCardId, no holdingId).
//   2. The free-text search field uses `cardMatchesQuery` so a query
//      like "Charizard" filters slots by their target / assigned
//      card.
//   3. Search and filter compose — both must match for a slot to be
//      visible (not filtered-out).
//   4. Checklist mode renders rows in physical slot order (page asc,
//      slot asc) so set-based binders display in card-number order.
//   5. The deep-link path via `#binder/<id>/slot/<slotId>` adds the
//      `binder-slot--focused` class to the targeted slot tile.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mountBinderDetailView } from '../src/views/binder-detail';
import { _resetDbSingletonForTests, getDb } from '../src/db/database';
import { initializeDataLayer } from '../src/db/init';
import { closeAndDelete } from './helpers/fresh-db';
import { newId } from '../src/utils/ids';
import type { CardRecord, SetRecord } from '../src/domain/types';
import type { PokemonTrackerDB } from '../src/db/database';

async function settle(ms = 100): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// jsdom doesn't ship CSS.escape; UUIDs we generate via newId() only
// contain `[a-zA-Z0-9-]` so a no-op escape is sufficient for tests.
function escapeSelectorValue(value: string): string {
  return value.replace(/(["\\])/g, '\\$1');
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

const baseCard = (
  id: string,
  number: string,
  name: string,
): CardRecord => ({
  id,
  setId: 'base1',
  name,
  number,
  rarity: 'Rare Holo',
  supertype: 'Pokémon',
  subtypes: [],
  types: [],
  imageSmall: null,
  imageLarge: null,
  tcgplayer: { prices: { holofoil: { market: 1 } } },
  cardmarket: null,
  updatedAt: '2026-05-06T00:00:00.000Z',
});

describe('Binder detail (PR 17 — search, filters, deep-link)', () => {
  let db: PokemonTrackerDB;
  let binderId: string;
  let charizardSlotId: string;
  let alakazamSlotId: string;
  let blakeSlotId: string;
  let pikachuSlotId: string;

  beforeEach(async () => {
    document.body.innerHTML = '<div id="content"></div>';
    _resetDbSingletonForTests();
    db = getDb();
    await initializeDataLayer({ db, skipPersistentStorage: true });
    await db.sets.put(setRecord);
    await db.cards.bulkPut([
      baseCard('base1-4', '4', 'Charizard'),
      baseCard('base1-1', '1', 'Alakazam'),
      baseCard('base1-58', '58', 'Pikachu'),
    ]);
    binderId = newId();
    const now = '2026-05-06T00:00:00.000Z';
    await db.binders.add({
      id: binderId,
      name: 'Test Master',
      description: null,
      binderType: 'Vault X 9-pocket',
      slotsPerPage: 9,
      totalPages: 2,
      binderPreset: 'vaultx_9_360',
      completionMode: 'standard',
      sourceSetId: 'base1',
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
    charizardSlotId = newId();
    alakazamSlotId = newId();
    blakeSlotId = newId();
    pikachuSlotId = newId();
    await db.binderSlots.bulkAdd([
      // Page 1: Charizard target (filled), Alakazam target (filled),
      // empty manual slot (no target), then 6 empty placeholder slots.
      {
        id: alakazamSlotId,
        binderId,
        pageNumber: 1,
        slotNumber: 1,
        targetCardId: 'base1-1',
        holdingId: null,
        status: 'wanted',
        note: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
      {
        id: charizardSlotId,
        binderId,
        pageNumber: 1,
        slotNumber: 4,
        targetCardId: 'base1-4',
        holdingId: null,
        status: 'wanted',
        note: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
      {
        id: blakeSlotId,
        binderId,
        pageNumber: 1,
        slotNumber: 9,
        targetCardId: null,
        holdingId: null,
        status: 'empty',
        note: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
      {
        id: pikachuSlotId,
        binderId,
        pageNumber: 2,
        slotNumber: 1,
        targetCardId: 'base1-58',
        holdingId: null,
        status: 'wanted',
        note: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ]);
    window.location.hash = `#binder/${binderId}`;
  });

  afterEach(async () => {
    document.body.innerHTML = '';
    await closeAndDelete(db);
    _resetDbSingletonForTests();
    window.location.hash = '';
  });

  function root(): HTMLElement {
    const r = document.getElementById('content');
    if (!r) throw new Error('test bootstrap failed');
    return r;
  }

  function slotIsVisible(slotId: string): boolean {
    const tile = root().querySelector(
      `[data-slot-id="${escapeSelectorValue(slotId)}"]`,
    );
    if (tile === null) return false;
    return !tile.classList.contains('binder-slot--filtered-out');
  }

  it('renders the current page\'s slots when filter=all and search is empty', async () => {
    // PR 20 — Sider mode now paginates one physical page at a time.
    // Page 1 holds Alakazam, Charizard, blank manual slot.
    // Page 2 holds Pikachu — visible only after clicking Neste.
    mountBinderDetailView(root());
    await settle();
    expect(slotIsVisible(charizardSlotId)).toBe(true);
    expect(slotIsVisible(alakazamSlotId)).toBe(true);
    expect(slotIsVisible(blakeSlotId)).toBe(true);
    // Page 2 slots are not in DOM until the user paginates.
    expect(
      root().querySelector(
        `[data-slot-id="${escapeSelectorValue(pikachuSlotId)}"]`,
      ),
    ).toBeNull();
    // Click Neste — Pikachu now renders.
    const next = root().querySelector<HTMLButtonElement>(
      '[data-action="pages-next"]',
    );
    expect(next).not.toBeNull();
    next!.click();
    await settle();
    expect(slotIsVisible(pikachuSlotId)).toBe(true);
  });

  it('"empty" filter shows only the blank-manual slot', async () => {
    mountBinderDetailView(root());
    await settle();
    const filterSelect = root().querySelector<HTMLSelectElement>(
      '[data-region="filter-select"]',
    );
    if (filterSelect === null) throw new Error('filter select missing');
    expect([...filterSelect.options].map((o) => o.value)).toContain('empty');
    filterSelect.value = 'empty';
    filterSelect.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect(slotIsVisible(blakeSlotId)).toBe(true);
    expect(slotIsVisible(charizardSlotId)).toBe(false);
    expect(slotIsVisible(alakazamSlotId)).toBe(false);
    expect(slotIsVisible(pikachuSlotId)).toBe(false);
  });

  it('search "Charizard" filters slots by target card name', async () => {
    mountBinderDetailView(root());
    await settle();
    const searchInput = root().querySelector<HTMLInputElement>(
      '[data-region="search-input"]',
    );
    if (searchInput === null) throw new Error('search input missing');
    searchInput.value = 'Charizard';
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    await settle(350);
    expect(slotIsVisible(charizardSlotId)).toBe(true);
    expect(slotIsVisible(alakazamSlotId)).toBe(false);
    expect(slotIsVisible(pikachuSlotId)).toBe(false);
    // Empty manual slot has no card → filtered out.
    expect(slotIsVisible(blakeSlotId)).toBe(false);
  });

  it('search by card number "4" filters to slots whose target has number 4', async () => {
    mountBinderDetailView(root());
    await settle();
    const searchInput = root().querySelector<HTMLInputElement>(
      '[data-region="search-input"]',
    );
    if (searchInput === null) throw new Error('search input missing');
    searchInput.value = '4';
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    await settle(350);
    // Only Charizard (number "4") is visible. Alakazam is "1",
    // Pikachu is "58", blank slot has no card.
    expect(slotIsVisible(charizardSlotId)).toBe(true);
    expect(slotIsVisible(alakazamSlotId)).toBe(false);
    expect(slotIsVisible(pikachuSlotId)).toBe(false);
    expect(slotIsVisible(blakeSlotId)).toBe(false);
  });

  it('search by card-id "base1-58" filters to Pikachu', async () => {
    mountBinderDetailView(root());
    await settle();
    const searchInput = root().querySelector<HTMLInputElement>(
      '[data-region="search-input"]',
    );
    if (searchInput === null) throw new Error('search input missing');
    searchInput.value = 'base1-58';
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    await settle(350);
    expect(slotIsVisible(pikachuSlotId)).toBe(true);
    expect(slotIsVisible(charizardSlotId)).toBe(false);
    expect(slotIsVisible(alakazamSlotId)).toBe(false);
  });

  it('search + filter compose: "Charizard" + filter=missing both apply', async () => {
    mountBinderDetailView(root());
    await settle();
    const filterSelect = root().querySelector<HTMLSelectElement>(
      '[data-region="filter-select"]',
    );
    const searchInput = root().querySelector<HTMLInputElement>(
      '[data-region="search-input"]',
    );
    if (filterSelect === null || searchInput === null) {
      throw new Error('toolbar inputs missing');
    }
    filterSelect.value = 'missing';
    filterSelect.dispatchEvent(new Event('change', { bubbles: true }));
    searchInput.value = 'Charizard';
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    await settle(350);
    // Charizard slot has a target and is incomplete → missing ✓
    expect(slotIsVisible(charizardSlotId)).toBe(true);
    // Alakazam is also missing but does not match the search ✗
    expect(slotIsVisible(alakazamSlotId)).toBe(false);
  });

  it('checklist mode lists slots in (pageNumber, slotNumber) order', async () => {
    mountBinderDetailView(root());
    await settle();
    const checklistBtn = [...root().querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Sjekkliste',
    );
    if (!checklistBtn) throw new Error('Sjekkliste-knapp mangler');
    checklistBtn.click();
    await settle();
    const rows = [
      ...root().querySelectorAll<HTMLTableRowElement>('.checklist-table__row'),
    ];
    const order = rows.map((r) => r.dataset['slotId']);
    // Expected physical order: page 1 slot 1 (Alakazam), page 1 slot 4
    // (Charizard), page 1 slot 9 (blank), page 2 slot 1 (Pikachu).
    expect(order).toEqual([
      alakazamSlotId,
      charizardSlotId,
      blakeSlotId,
      pikachuSlotId,
    ]);
  });

  it('deep-link `#binder/<id>/slot/<slotId>` highlights the targeted slot', async () => {
    window.location.hash = `#binder/${binderId}/slot/${charizardSlotId}`;
    mountBinderDetailView(root());
    // The focus runs in a microtask after render; `settle` covers
    // both the async initial render and the queued highlight.
    await settle(150);
    const tile = root().querySelector(
      `[data-slot-id="${escapeSelectorValue(charizardSlotId)}"]`,
    );
    expect(tile).not.toBeNull();
    expect(tile?.classList.contains('binder-slot--focused')).toBe(true);
    // Sibling slot is not highlighted.
    const sibling = root().querySelector(
      `[data-slot-id="${escapeSelectorValue(alakazamSlotId)}"]`,
    );
    expect(sibling?.classList.contains('binder-slot--focused')).toBe(false);
  });
});
