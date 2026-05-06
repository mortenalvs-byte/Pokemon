import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountBrowseView } from '../src/views/browse';
import { initializeDataLayer } from '../src/db/init';
import { _resetDbSingletonForTests, getDb } from '../src/db/database';
import { createCardsRepo } from '../src/repositories/cards-repo';
import { createSetsRepo } from '../src/repositories/sets-repo';
import { closeAndDelete } from './helpers/fresh-db';
import type { CardRecord, SetRecord } from '../src/domain/types';
import type { PokemonTrackerDB } from '../src/db/database';

async function settle(ms = 80): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function makeSet(id: string, name: string, releaseDate = '2024-01-01'): SetRecord {
  return {
    id,
    name,
    series: 'Test',
    printedTotal: 100,
    total: 100,
    releaseDate,
    symbolUrl: null,
    logoUrl: null,
    updatedAt: '2026-05-06T00:00:00.000Z',
  };
}

function makeCard(setId: string, n: number): CardRecord {
  return {
    id: `${setId}-${n}`,
    setId,
    name: `Card ${n}`,
    number: String(n),
    rarity: n % 3 === 0 ? 'Rare Holo' : 'Common',
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

async function seedManyCards(db: PokemonTrackerDB, count: number): Promise<void> {
  const setsRepo = createSetsRepo(db);
  const cardsRepo = createCardsRepo(db);
  await setsRepo.upsert(makeSet('test-set', 'Test Set'));
  const cards: CardRecord[] = [];
  for (let i = 1; i <= count; i += 1) {
    cards.push(makeCard('test-set', i));
  }
  await cardsRepo.upsertMany(cards);
}

describe('Browse view', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    document.body.innerHTML = '<div id="content"></div>';
    _resetDbSingletonForTests();
    db = getDb();
    await initializeDataLayer({ db, skipPersistentStorage: true });
    window.location.hash = '';
  });

  afterEach(async () => {
    await settle(40);
    document.body.innerHTML = '';
    await closeAndDelete(db);
    _resetDbSingletonForTests();
    window.location.hash = '';
  });

  it('shows the empty state with a Settings link when no cards are cached', async () => {
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBrowseView(root);
    await settle();

    const empty = root.querySelector('.browse-view__empty');
    expect(empty).not.toBeNull();
    expect(empty?.textContent ?? '').toMatch(/Innstillinger/);

    const button = root.querySelector<HTMLButtonElement>(
      '.browse-view__empty-action',
    );
    expect(button).not.toBeNull();
    button?.click();
    expect(window.location.hash).toBe('#settings');
  });

  it('renders the toolbar and a paginated table when the cache has cards', async () => {
    await seedManyCards(db, 60);

    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBrowseView(root);
    await settle();

    expect(root.querySelector('[data-region="toolbar"]')?.hasAttribute('hidden')).toBe(false);
    const rows = root.querySelectorAll<HTMLTableRowElement>('.browse-table__row');
    expect(rows.length).toBe(50); // default pageSize
    expect(
      root.querySelector('[data-region="page-summary"]')?.textContent ?? '',
    ).toMatch(/Side 1 av 2/);
  });

  it('next-page button shows the remaining 10 rows on page 2 (60 cards total)', async () => {
    await seedManyCards(db, 60);
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBrowseView(root);
    await settle();

    (root.querySelector<HTMLButtonElement>('[data-action="next-page"]') as HTMLButtonElement).click();
    await settle();

    const rows = root.querySelectorAll<HTMLTableRowElement>('.browse-table__row');
    expect(rows.length).toBe(10);
  });

  it('search filters rows after debounce; case-insensitive + trim', async () => {
    await seedManyCards(db, 60);
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBrowseView(root);
    await settle();

    const input = root.querySelector<HTMLInputElement>(
      '[data-region="search"]',
    ) as HTMLInputElement;
    input.value = '  CARD 5  ';
    input.dispatchEvent(new Event('input'));

    // Search has 150ms debounce; wait a bit longer.
    await vi.waitFor(() => {
      const rows = root.querySelectorAll<HTMLTableRowElement>('.browse-table__row');
      // "Card 5", "Card 50", "Card 51", ... "Card 59" → 11 matches.
      expect(rows.length).toBe(11);
    });
  });

  it('clicking a row navigates to #card/<encoded-id>', async () => {
    await seedManyCards(db, 5);
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBrowseView(root);
    await settle();

    const firstRow = root.querySelector<HTMLTableRowElement>(
      '.browse-table__row',
    ) as HTMLTableRowElement;
    const cardId = firstRow.dataset['cardId'];
    expect(cardId).toBeDefined();
    firstRow.click();
    expect(window.location.hash).toBe(`#card/${encodeURIComponent(cardId ?? '')}`);
  });

  it('clicking a disabled quick-action button does not navigate', async () => {
    await seedManyCards(db, 3);
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBrowseView(root);
    await settle();

    const previousHash = window.location.hash;
    const disabledButton = root.querySelector<HTMLButtonElement>(
      '.browse-table__action--disabled',
    );
    expect(disabledButton).not.toBeNull();
    expect(disabledButton?.disabled).toBe(true);
    expect(disabledButton?.title ?? '').toMatch(/kommer i PR 7/i);
    disabledButton?.click();
    expect(window.location.hash).toBe(previousHash);
  });

  it('Vis detaljer button does navigate to card detail', async () => {
    await seedManyCards(db, 3);
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBrowseView(root);
    await settle();

    const detailButton = root.querySelector<HTMLButtonElement>(
      '[data-action="view-details"]',
    );
    expect(detailButton).not.toBeNull();
    detailButton?.click();
    expect(window.location.hash.startsWith('#card/')).toBe(true);
  });

  it('renders no more than pageSize rows in the DOM even with many cards', async () => {
    // 200 cards, default pageSize 50 → only 50 <tr> elements.
    await seedManyCards(db, 200);
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBrowseView(root);
    await settle();
    const rows = root.querySelectorAll<HTMLTableRowElement>('.browse-table__row');
    expect(rows.length).toBe(50);
  });
});
