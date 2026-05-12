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
    tcgplayer: { prices: { normal: { market: 1 }, holofoil: { market: 1 }, reverseHolofoil: { market: 1 }, "1stEditionNormal": { market: 1 }, "1stEditionHolofoil": { market: 1 } } },
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

  it('quick-action buttons (Add to collection, Add to wishlist, Vis detaljer) handle their own clicks', async () => {
    // Both Add buttons are enabled from PR 7a/PR 7b. Click handler
    // discipline is verified separately in browse-with-holdings.test.ts
    // (Add to collection opens dialog) and browse-with-wishlist.test.ts
    // (Add to wishlist opens dialog) — here we just confirm that
    // clicking either Add button does NOT trigger row navigation.
    await seedManyCards(db, 3);
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBrowseView(root);
    await settle();

    const previousHash = window.location.hash;
    const addCollection = root.querySelector<HTMLButtonElement>(
      '[data-action="add-to-collection"]',
    );
    expect(addCollection).not.toBeNull();
    addCollection?.click();
    expect(window.location.hash).toBe(previousHash);
    // Close any dialog that opened so the next test starts fresh.
    document
      .querySelector<HTMLButtonElement>('dialog.app-dialog [data-action="cancel"]')
      ?.click();
    await settle();
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

  // PR C1 — Browse-table virtualization. Operator requirement #11:
  // the user can scroll smoothly through thousands of cards instead
  // of paging at 50/100. Selecting the new "Alle" page-size sends
  // every filtered row to the windowed renderer. The renderer holds
  // ~30 rows in the DOM regardless of dataset size (renderAllThreshold
  // = 100), plus two aria-hidden spacer rows that absorb the scroll
  // height for rows above/below the visible window.
  it('C1: "Alle" page-size keeps DOM row count well below dataset size', async () => {
    await seedManyCards(db, 1000);
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBrowseView(root);
    await settle();

    const pageSizeSel = root.querySelector<HTMLSelectElement>(
      '[data-region="page-size"]',
    );
    expect(pageSizeSel).not.toBeNull();
    pageSizeSel!.value = '100000';
    pageSizeSel!.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();

    const rows = root.querySelectorAll<HTMLTableRowElement>('.browse-table__row');
    // Window: jsdom innerHeight ≈ 768, rowHeight 52 ⇒ ~15 rows + 12
    // overscan ≈ 27. The exact number depends on jsdom defaults, but
    // it must stay far below the dataset size.
    expect(rows.length).toBeLessThan(50);
    expect(rows.length).toBeGreaterThan(0);
    // Pagination summary still reflects the full dataset.
    expect(
      root.querySelector('[data-region="page-summary"]')?.textContent ?? '',
    ).toMatch(/1000 kort/);
  });

  it('C1: scrolling past the rows region shifts the windowed slice forward', async () => {
    await seedManyCards(db, 500);
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBrowseView(root);
    await settle();

    const pageSizeSel = root.querySelector<HTMLSelectElement>(
      '[data-region="page-size"]',
    );
    pageSizeSel!.value = '100000';
    pageSizeSel!.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();

    const firstRowsBefore = Array.from(
      root.querySelectorAll<HTMLTableRowElement>('.browse-table__row'),
    ).map((r) => r.dataset['cardId']);
    expect(firstRowsBefore.length).toBeGreaterThan(0);
    expect(firstRowsBefore[0]).toBeDefined();

    // Mock the rows region's bounding rect so the window math thinks
    // we've scrolled far past it. jsdom returns all-zero rects by
    // default — overriding via a stub is the only path that exercises
    // the windowing logic.
    const rowsRegion = root.querySelector<HTMLElement>('[data-region="rows"]');
    expect(rowsRegion).not.toBeNull();
    const origRect = rowsRegion!.getBoundingClientRect.bind(rowsRegion!);
    Object.defineProperty(window, 'scrollY', { value: 5000, configurable: true });
    rowsRegion!.getBoundingClientRect = (): DOMRect => {
      // rect.top = -5000 means rows start 5000px above viewport.
      const original = origRect();
      return {
        ...original,
        top: -5000,
        bottom: original.bottom - 5000,
        x: original.x,
        y: -5000,
        toJSON: () => ({}),
      } as DOMRect;
    };
    window.dispatchEvent(new Event('scroll'));
    await settle(10);

    const firstRowsAfter = Array.from(
      root.querySelectorAll<HTMLTableRowElement>('.browse-table__row'),
    ).map((r) => r.dataset['cardId']);
    expect(firstRowsAfter.length).toBeGreaterThan(0);
    // After "scrolling 5000px", the first DOM row should be different
    // from before — the windowing math has moved the slice forward.
    expect(firstRowsAfter[0]).not.toBe(firstRowsBefore[0]);
  });

  it('C1: spacer rows are rendered and aria-hidden', async () => {
    await seedManyCards(db, 300);
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBrowseView(root);
    await settle();

    const pageSizeSel = root.querySelector<HTMLSelectElement>(
      '[data-region="page-size"]',
    );
    pageSizeSel!.value = '100000';
    pageSizeSel!.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();

    const topSpacer = root.querySelector<HTMLElement>(
      '[data-region="vs-top-spacer"]',
    );
    const bottomSpacer = root.querySelector<HTMLElement>(
      '[data-region="vs-bottom-spacer"]',
    );
    expect(topSpacer).not.toBeNull();
    expect(bottomSpacer).not.toBeNull();
    expect(topSpacer?.getAttribute('aria-hidden')).toBe('true');
    expect(bottomSpacer?.getAttribute('aria-hidden')).toBe('true');
    // Bottom spacer absorbs the rows BELOW the window — must be > 0.
    const bottomPx = Number.parseInt(bottomSpacer?.style.height ?? '0', 10);
    expect(bottomPx).toBeGreaterThan(0);
  });
});
