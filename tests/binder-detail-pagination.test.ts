// PR 20 — page-at-a-time rendering for binder detail.
//
// The QA report flagged a Vault X 16-pocket binder (68 pages × 16
// slots = 1088 slot tiles) at ~1 s render time. PR 20 paginates the
// "Sider" view to a single physical page at a time, and the
// "Sjekkliste" view to 50 rows per page. This file covers:
//
//   - Sider mode renders one page; nav buttons advance.
//   - Sjekkliste mode renders 50 rows; nav summary correct.
//   - Filter / search auto-jumps to the first page with matches.
//   - Deep-link `#binder/<id>/slot/<slotId>` lands directly on the
//     page containing that slot, without requiring nav clicks.
//   - DOM size is small even for a synthetic 64-page binder (200
//     elements, not 1088).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mountBinderDetailView } from '../src/views/binder-detail';
import { _resetDbSingletonForTests, getDb } from '../src/db/database';
import { initializeDataLayer } from '../src/db/init';
import { closeAndDelete } from './helpers/fresh-db';
import { newId } from '../src/utils/ids';
import type {
  BinderSlotRecord,
  CardRecord,
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

const card = (id: string, number: string, name: string): CardRecord => ({
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

describe('Binder detail pagination (PR 20)', () => {
  let db: PokemonTrackerDB;
  let binderId: string;

  beforeEach(async () => {
    document.body.innerHTML = '<div id="content"></div>';
    _resetDbSingletonForTests();
    db = getDb();
    await initializeDataLayer({ db, skipPersistentStorage: true });
    await db.sets.put(setRecord);
    binderId = newId();
  });

  afterEach(async () => {
    document.body.innerHTML = '';
    await closeAndDelete(db);
    _resetDbSingletonForTests();
    window.location.hash = '';
  });

  function getRoot(): HTMLElement {
    const r = document.getElementById('content');
    if (!r) throw new Error('test bootstrap failed');
    return r;
  }

  function escapeSelectorValue(value: string): string {
    return value.replace(/(["\\])/g, '\\$1');
  }

  /**
   * Build a binder with `pages` pages of 9 slots each. Cards
   * `base1-001..base1-(pages*9)` are seeded so `resolveCardForSlot`
   * always returns a card. Slot ids and target ids are returned
   * page-major for the test to assert against.
   */
  async function seedBinder(pages: number): Promise<{
    slotIds: string[];
    cardIds: string[];
  }> {
    const cards: CardRecord[] = [];
    for (let i = 1; i <= pages * 9; i += 1) {
      cards.push(card(`base1-${i}`, String(i), `Card ${i}`));
    }
    await db.cards.bulkPut(cards);

    const now = '2026-05-06T00:00:00.000Z';
    await db.binders.add({
      id: binderId,
      name: 'Big Binder',
      description: null,
      binderType: 'Vault X 9-pocket',
      slotsPerPage: 9,
      totalPages: pages,
      binderPreset: 'vaultx_9_360',
      completionMode: 'standard',
      sourceSetId: 'base1',
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
    const slotIds: string[] = [];
    const cardIds: string[] = [];
    const slots: BinderSlotRecord[] = [];
    for (let p = 1; p <= pages; p += 1) {
      for (let s = 1; s <= 9; s += 1) {
        const idx = (p - 1) * 9 + s;
        const cardId = `base1-${idx}`;
        const sid = newId();
        slotIds.push(sid);
        cardIds.push(cardId);
        slots.push({
          id: sid,
          binderId,
          pageNumber: p,
          slotNumber: s,
          targetCardId: cardId,
          holdingId: null,
          status: 'wanted',
          note: null,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        });
      }
    }
    await db.binderSlots.bulkAdd(slots);
    return { slotIds, cardIds };
  }

  it('Sider mode renders ONLY the current page (page 1 by default), not the whole 1088-slot tree', async () => {
    // 4 pages × 9 = 36 slots total. Page 1 has 9 slots — that's
    // what should be in the DOM, not 36.
    await seedBinder(4);
    window.location.hash = `#binder/${binderId}`;
    mountBinderDetailView(getRoot());
    await settle(150);

    const tilesInDom = getRoot().querySelectorAll('.binder-slot').length;
    expect(tilesInDom).toBe(9);

    const summary = getRoot().querySelector(
      '[data-region="pages-summary"]',
    )?.textContent;
    expect(summary).toBe('Side 1 av 4');
  });

  it('Forrige / Neste advance pages and disable correctly at the edges', async () => {
    await seedBinder(3);
    window.location.hash = `#binder/${binderId}`;
    mountBinderDetailView(getRoot());
    await settle(150);

    const next = (): HTMLButtonElement =>
      getRoot().querySelector<HTMLButtonElement>(
        '[data-action="pages-next"]',
      )!;
    const prev = (): HTMLButtonElement =>
      getRoot().querySelector<HTMLButtonElement>(
        '[data-action="pages-prev"]',
      )!;
    const summary = (): string =>
      getRoot()
        .querySelector('[data-region="pages-summary"]')
        ?.textContent ?? '';

    expect(prev().disabled).toBe(true);
    expect(next().disabled).toBe(false);
    expect(summary()).toBe('Side 1 av 3');

    next().click();
    await settle();
    expect(summary()).toBe('Side 2 av 3');
    expect(prev().disabled).toBe(false);
    expect(next().disabled).toBe(false);

    next().click();
    await settle();
    expect(summary()).toBe('Side 3 av 3');
    expect(next().disabled).toBe(true);

    prev().click();
    await settle();
    expect(summary()).toBe('Side 2 av 3');
  });

  it('search auto-jumps to the first page that has a match', async () => {
    // 3 pages. Search for the unique name "Card 27" which lives on
    // page 3 (slot index 27 = page 3, slot 9). Expectation: render
    // lands on page 3 immediately, not page 1.
    await seedBinder(3);
    window.location.hash = `#binder/${binderId}`;
    mountBinderDetailView(getRoot());
    await settle(150);

    const search = getRoot().querySelector<HTMLInputElement>(
      '[data-region="search-input"]',
    );
    if (search === null) throw new Error('search input missing');
    search.value = 'Card 27';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    // 200ms debounce + render
    await settle(400);

    const summary = getRoot()
      .querySelector('[data-region="pages-summary"]')
      ?.textContent;
    expect(summary).toBe('Side 3 av 3');
    // Card 27 tile is rendered.
    const tile = getRoot().querySelector(
      'tr.checklist-table__row',
    );
    // No checklist rows in pages mode — make sure pages-mode rendered
    // the tile by checking for the slot tile.
    expect(tile).toBeNull();
    expect(
      getRoot().querySelectorAll('.binder-slot').length,
    ).toBeGreaterThan(0);
  });

  it('Sjekkliste mode paginates at 50 rows per page', async () => {
    // 8 pages × 9 = 72 slots → page 1 of checklist (50 rows), page 2
    // (22 rows).
    await seedBinder(8);
    window.location.hash = `#binder/${binderId}`;
    mountBinderDetailView(getRoot());
    await settle(150);

    // Switch to checklist mode.
    const checklistBtn = [
      ...getRoot().querySelectorAll('button'),
    ].find((b) => b.textContent?.trim() === 'Sjekkliste');
    if (!checklistBtn) throw new Error('Sjekkliste button missing');
    checklistBtn.click();
    await settle();

    const rowsPage1 = getRoot().querySelectorAll(
      'tr.checklist-table__row',
    ).length;
    expect(rowsPage1).toBe(50);

    const summary = getRoot().querySelector(
      '[data-region="checklist-summary"]',
    )?.textContent;
    expect(summary).toBe('Side 1 av 2 — viser 1–50 av 72');

    // Neste → page 2.
    getRoot()
      .querySelector<HTMLButtonElement>('[data-action="checklist-next"]')!
      .click();
    await settle();
    expect(
      getRoot().querySelectorAll('tr.checklist-table__row').length,
    ).toBe(22);
    expect(
      getRoot().querySelector('[data-region="checklist-summary"]')
        ?.textContent,
    ).toBe('Side 2 av 2 — viser 51–72 av 72');
  });

  it('deep-link `#binder/<id>/slot/<slotId>` lands directly on the slot\'s page', async () => {
    const { slotIds } = await seedBinder(5);
    // Slot index 36 (zero-based 35) = page 4, slot 9.
    const targetSlotId = slotIds[35]!;
    window.location.hash = `#binder/${binderId}/slot/${targetSlotId}`;
    mountBinderDetailView(getRoot());
    await settle(200);

    const summary = getRoot()
      .querySelector('[data-region="pages-summary"]')
      ?.textContent;
    expect(summary).toBe('Side 4 av 5');
    // The focused tile is on this page and got the highlight class.
    const tile = getRoot().querySelector(
      `[data-slot-id="${escapeSelectorValue(targetSlotId)}"]`,
    );
    expect(tile).not.toBeNull();
    expect(tile?.classList.contains('binder-slot--focused')).toBe(true);
  });

  it('1088-slot binder renders 16 tiles, not 1088 — DOM size proof', async () => {
    // Use the production preset: 68 pages × 16 = 1088 slots.
    const cards: CardRecord[] = [];
    for (let i = 1; i <= 1088; i += 1) {
      cards.push(card(`base1-${i}`, String(i), `Card ${i}`));
    }
    await db.cards.bulkPut(cards);
    const now = '2026-05-06T00:00:00.000Z';
    await db.binders.add({
      id: binderId,
      name: 'Mega Vault X 16',
      description: null,
      binderType: 'Vault X 16-pocket XXL',
      slotsPerPage: 16,
      totalPages: 68,
      binderPreset: 'vaultx_16xxl_1088',
      completionMode: 'master',
      sourceSetId: 'base1',
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
    const slots: BinderSlotRecord[] = [];
    let idx = 0;
    for (let p = 1; p <= 68; p += 1) {
      for (let s = 1; s <= 16; s += 1) {
        idx += 1;
        slots.push({
          id: newId(),
          binderId,
          pageNumber: p,
          slotNumber: s,
          targetCardId: `base1-${idx}`,
          holdingId: null,
          status: 'wanted',
          note: null,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        });
      }
    }
    await db.binderSlots.bulkAdd(slots);
    window.location.hash = `#binder/${binderId}`;
    mountBinderDetailView(getRoot());
    await settle(300);

    // Page 1 = 16 tiles. Pre-PR-20 this was 1088.
    expect(
      getRoot().querySelectorAll('.binder-slot').length,
    ).toBe(16);
    expect(
      getRoot().querySelector('[data-region="pages-summary"]')
        ?.textContent,
    ).toBe('Side 1 av 68');
  });
});
