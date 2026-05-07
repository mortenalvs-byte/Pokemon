// PR 19 — Browse bulk mode integration tests.
//
// Verifies:
//   - Bulk-mode is OFF by default; the toolbar toggle is "Bulk-modus av"
//     and the checkbox column header is hidden.
//   - Toggling on shows the bulk action bar + checkbox column.
//   - Each row gets a checkbox only when `decideQuickAdd(card)` is
//     `canQuickAdd === true`. Ineligible rows render the
//     `browse-table__check-skip` placeholder with the explanation
//     in the `title` attribute.
//   - Per-row checkbox click updates the count + select-all + action
//     button label without re-fetching the rows.
//   - "Velg alle synlige" ticks every eligible visible row only.
//   - The bulk +1 raw action calls `holdingsRepo.upsertByVariant` per
//     selected card. Two clicks on the same card across separate
//     bulk runs increment the same holding's quantity (proved by
//     comparing total holdings count after).
//   - Result summary is shown after the run with correct counts.
//   - USER_DATA_CHANGED_EVENT is dispatched ONCE for a multi-card run,
//     not once per card.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountBrowseView } from '../src/views/browse';
import { _resetDbSingletonForTests, getDb } from '../src/db/database';
import { initializeDataLayer } from '../src/db/init';
import { closeAndDelete } from './helpers/fresh-db';
import type { CardRecord, SetRecord } from '../src/domain/types';
import type { PokemonTrackerDB } from '../src/db/database';

async function settle(ms = 120): Promise<void> {
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

const cardNoVariant: CardRecord = {
  ...cardCharizard,
  id: 'basep-1',
  name: 'Mystery Promo',
  number: '1',
  tcgplayer: null,
};

const cardCharmander: CardRecord = {
  ...cardCharizard,
  id: 'base1-46',
  name: 'Charmander',
  number: '46',
  rarity: 'Common',
  tcgplayer: { prices: { normal: { market: 5 } } },
};

describe('Browse bulk mode (PR 19)', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    document.body.innerHTML = '<div id="content"></div>';
    _resetDbSingletonForTests();
    db = getDb();
    await initializeDataLayer({ db, skipPersistentStorage: true });
    await db.sets.put(setRecord);
    await db.cards.bulkPut([cardCharizard, cardCharmander, cardNoVariant]);
    window.location.hash = '';
  });

  afterEach(async () => {
    document.body.innerHTML = '';
    await closeAndDelete(db);
    _resetDbSingletonForTests();
    window.location.hash = '';
  });

  function getRoot(): HTMLElement {
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    return root;
  }

  it('bulk-mode is OFF by default — bar hidden, checkbox column hidden, toggle reads "av"', async () => {
    mountBrowseView(getRoot());
    await settle();
    const toggle = getRoot().querySelector<HTMLButtonElement>(
      '[data-region="bulk-toggle"]',
    );
    const bar = getRoot().querySelector<HTMLElement>(
      '[data-region="bulk-bar"]',
    );
    const headCell = getRoot().querySelector<HTMLElement>(
      '[data-region="bulk-head"]',
    );
    expect(toggle?.textContent?.trim()).toBe('Bulk-modus av');
    expect(toggle?.getAttribute('aria-pressed')).toBe('false');
    expect(bar?.hidden).toBe(true);
    expect(headCell?.hidden).toBe(true);
    // No checkbox cell is rendered on rows when bulk-mode is off.
    expect(
      getRoot().querySelector('input[data-action="bulk-select"]'),
    ).toBeNull();
  });

  it('toggling on shows bar + column and renders one checkbox per eligible row', async () => {
    mountBrowseView(getRoot());
    await settle();
    const toggle = getRoot().querySelector<HTMLButtonElement>(
      '[data-region="bulk-toggle"]',
    );
    toggle!.click();
    await settle();

    expect(toggle!.textContent?.trim()).toBe('Bulk-modus på');
    expect(toggle!.getAttribute('aria-pressed')).toBe('true');
    const bar = getRoot().querySelector<HTMLElement>(
      '[data-region="bulk-bar"]',
    );
    const headCell = getRoot().querySelector<HTMLElement>(
      '[data-region="bulk-head"]',
    );
    expect(bar?.hidden).toBe(false);
    expect(headCell?.hidden).toBe(false);

    // Two of the three cards are Quick-Add-eligible (Charizard +
    // Charmander). The promo with no tcgplayer.prices renders the
    // skip placeholder instead.
    const eligibleBoxes = getRoot().querySelectorAll(
      'input[data-action="bulk-select"]',
    );
    expect(eligibleBoxes.length).toBe(2);
    const skipPlaceholders = getRoot().querySelectorAll(
      '.browse-table__check-skip',
    );
    expect(skipPlaceholders.length).toBe(1);
    expect(
      (skipPlaceholders[0] as HTMLElement).title,
    ).toContain('Mangler API-verifisert variant');
  });

  it('ticking a row updates the count + label + select-all without DB churn', async () => {
    mountBrowseView(getRoot());
    await settle();
    getRoot()
      .querySelector<HTMLButtonElement>('[data-region="bulk-toggle"]')!
      .click();
    await settle();

    const charizardBox = getRoot().querySelector<HTMLInputElement>(
      'input[data-action="bulk-select"][data-card-id="base1-4"]',
    );
    expect(charizardBox).not.toBeNull();
    charizardBox!.checked = true;
    charizardBox!.dispatchEvent(new Event('click', { bubbles: true }));
    await settle();

    const action = getRoot().querySelector<HTMLButtonElement>(
      '[data-region="bulk-action"]',
    );
    const count = getRoot().querySelector<HTMLElement>(
      '[data-region="bulk-count"]',
    );
    expect(action?.textContent).toBe('+1 raw på valgte (1)');
    expect(action?.disabled).toBe(false);
    expect(count?.textContent?.trim()).toBe('1 valgt');
  });

  it('"Velg alle synlige" ticks every eligible visible row only', async () => {
    mountBrowseView(getRoot());
    await settle();
    getRoot()
      .querySelector<HTMLButtonElement>('[data-region="bulk-toggle"]')!
      .click();
    await settle();

    const selectAll = getRoot().querySelector<HTMLInputElement>(
      '[data-region="bulk-select-all"]',
    );
    selectAll!.checked = true;
    selectAll!.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();

    const action = getRoot().querySelector<HTMLButtonElement>(
      '[data-region="bulk-action"]',
    );
    expect(action?.textContent).toBe('+1 raw på valgte (2)');
  });

  it('clicking the bulk action runs upsertByVariant per card and shows the summary', async () => {
    mountBrowseView(getRoot());
    await settle();
    getRoot()
      .querySelector<HTMLButtonElement>('[data-region="bulk-toggle"]')!
      .click();
    await settle();
    getRoot()
      .querySelector<HTMLInputElement>('[data-region="bulk-select-all"]')!
      .click();
    await settle();
    // Fire the bulk +1 raw.
    getRoot()
      .querySelector<HTMLButtonElement>('[data-region="bulk-action"]')!
      .click();
    // Two cards × one upsertByVariant each.
    await vi.waitFor(async () => {
      expect(await db.holdings.count()).toBe(2);
    });
    await settle();

    const summary = getRoot().querySelector<HTMLElement>(
      '[data-region="bulk-summary"]',
    );
    expect(summary?.hidden).toBe(false);
    expect(summary?.textContent).toContain('Bulk +1 raw kjørt på 2');
    expect(summary?.textContent).toContain('2 lagt til');
    expect(summary?.textContent).toContain('0 oppdatert');
    expect(summary?.textContent).toContain('0 hoppet over');
    expect(summary?.textContent).toContain('0 feilet');
  });

  it('second bulk run on the same card increments quantity (qty merge via upsertByVariant)', async () => {
    mountBrowseView(getRoot());
    await settle();
    getRoot()
      .querySelector<HTMLButtonElement>('[data-region="bulk-toggle"]')!
      .click();
    await settle();
    // First run: select Charizard only and fire.
    const charBox = (): HTMLInputElement =>
      getRoot().querySelector<HTMLInputElement>(
        'input[data-action="bulk-select"][data-card-id="base1-4"]',
      )!;
    charBox().checked = true;
    charBox().dispatchEvent(new Event('click', { bubbles: true }));
    await settle();
    getRoot()
      .querySelector<HTMLButtonElement>('[data-region="bulk-action"]')!
      .click();
    await vi.waitFor(async () => {
      expect(await db.holdings.count()).toBe(1);
    });
    await settle();

    // Successful row was unticked after the run — re-tick for the
    // second run.
    charBox().checked = true;
    charBox().dispatchEvent(new Event('click', { bubbles: true }));
    await settle();
    getRoot()
      .querySelector<HTMLButtonElement>('[data-region="bulk-action"]')!
      .click();
    await vi.waitFor(async () => {
      const all = await db.holdings.toArray();
      expect(all[0]?.quantity).toBe(2);
    });
    // Still ONE row in IDB — qty merged.
    expect(await db.holdings.count()).toBe(1);
    const summary = getRoot().querySelector<HTMLElement>(
      '[data-region="bulk-summary"]',
    );
    expect(summary?.textContent).toContain('1 oppdatert');
  });

  it('USER_DATA_CHANGED_EVENT fires exactly once for a multi-card bulk run', async () => {
    mountBrowseView(getRoot());
    await settle();
    getRoot()
      .querySelector<HTMLButtonElement>('[data-region="bulk-toggle"]')!
      .click();
    await settle();
    getRoot()
      .querySelector<HTMLInputElement>('[data-region="bulk-select-all"]')!
      .click();
    await settle();
    let fired = 0;
    const listener = (): void => {
      fired += 1;
    };
    window.addEventListener('pokemon:user-data-changed', listener);
    getRoot()
      .querySelector<HTMLButtonElement>('[data-region="bulk-action"]')!
      .click();
    await vi.waitFor(async () => {
      expect(await db.holdings.count()).toBe(2);
    });
    await settle();
    expect(fired).toBe(1);
    window.removeEventListener('pokemon:user-data-changed', listener);
  });

  it('toggling bulk-mode off clears the selection but keeps the last summary readable', async () => {
    mountBrowseView(getRoot());
    await settle();
    getRoot()
      .querySelector<HTMLButtonElement>('[data-region="bulk-toggle"]')!
      .click();
    await settle();
    getRoot()
      .querySelector<HTMLInputElement>('[data-region="bulk-select-all"]')!
      .click();
    await settle();
    getRoot()
      .querySelector<HTMLButtonElement>('[data-region="bulk-action"]')!
      .click();
    await vi.waitFor(async () => {
      expect(await db.holdings.count()).toBe(2);
    });
    await settle();
    // Now toggle off
    getRoot()
      .querySelector<HTMLButtonElement>('[data-region="bulk-toggle"]')!
      .click();
    await settle();
    expect(
      getRoot().querySelector<HTMLElement>('[data-region="bulk-bar"]')?.hidden,
    ).toBe(true);
    // Summary banner stays so the user can read what just happened.
    expect(
      getRoot().querySelector<HTMLElement>('[data-region="bulk-summary"]')
        ?.hidden,
    ).toBe(false);
    // No checkbox cell rendered now that bulk mode is off.
    expect(
      getRoot().querySelector('input[data-action="bulk-select"]'),
    ).toBeNull();
  });

  it('summary "Lukk" button dismisses the banner', async () => {
    mountBrowseView(getRoot());
    await settle();
    getRoot()
      .querySelector<HTMLButtonElement>('[data-region="bulk-toggle"]')!
      .click();
    await settle();
    getRoot()
      .querySelector<HTMLInputElement>('[data-region="bulk-select-all"]')!
      .click();
    await settle();
    getRoot()
      .querySelector<HTMLButtonElement>('[data-region="bulk-action"]')!
      .click();
    await vi.waitFor(async () => {
      expect(await db.holdings.count()).toBe(2);
    });
    await settle();
    const dismiss = getRoot().querySelector<HTMLButtonElement>(
      '[data-action="bulk-summary-dismiss"]',
    );
    expect(dismiss).not.toBeNull();
    dismiss!.click();
    await settle();
    expect(
      getRoot().querySelector<HTMLElement>('[data-region="bulk-summary"]')
        ?.hidden,
    ).toBe(true);
  });
});

// PR 19 review patch — selection must NOT cross pagination / filter
// changes. Bulk actions are only allowed to write the cards the user
// can actually see right now. Cross-page selection requires a
// dedicated UX affordance (later PR) and is not in this PR.
describe('Browse bulk mode — selection prune on rerender (PR 19 review patch)', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    document.body.innerHTML = '<div id="content"></div>';
    _resetDbSingletonForTests();
    db = getDb();
    await initializeDataLayer({ db, skipPersistentStorage: true });
    window.location.hash = '';
  });

  afterEach(async () => {
    document.body.innerHTML = '';
    await closeAndDelete(db);
    _resetDbSingletonForTests();
    window.location.hash = '';
  });

  function getRoot(): HTMLElement {
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    return root;
  }

  function ericCard(n: number, name: string, setId = 'base1'): CardRecord {
    return {
      id: `${setId}-${n}`,
      setId,
      name,
      number: String(n),
      rarity: 'Common',
      supertype: 'Pokémon',
      subtypes: [],
      types: [],
      imageSmall: null,
      imageLarge: null,
      tcgplayer: { prices: { normal: { market: 1 } } },
      cardmarket: null,
      updatedAt: '2026-05-06T00:00:00.000Z',
    };
  }

  it('paginating away drops selection of cards that are no longer rendered', async () => {
    // Seed 30 cards across two sets so we can exercise pagination
    // with page-size 25.
    await db.sets.put(setRecord);
    const cards: CardRecord[] = [];
    for (let i = 1; i <= 30; i += 1) cards.push(ericCard(i, `Card ${i}`));
    await db.cards.bulkPut(cards);

    mountBrowseView(getRoot());
    await settle(300);

    // The toolbar selects live OUTSIDE `<main>` in the test harness
    // (the test root IS the content panel, not the surrounding
    // shell). Query via the test root directly.
    const pageSizeSel = getRoot().querySelector<HTMLSelectElement>(
      '[data-region="page-size"]',
    );
    if (pageSizeSel === null) throw new Error('page-size select missing');
    pageSizeSel.value = '25';
    pageSizeSel.dispatchEvent(new Event('change', { bubbles: true }));
    await settle(150);

    // Bulk on
    getRoot()
      .querySelector<HTMLButtonElement>('[data-region="bulk-toggle"]')!
      .click();
    await settle();

    // Tick a card on page 1 — base1-3 always lives on page 1.
    const page1Box = getRoot().querySelector<HTMLInputElement>(
      'input[data-action="bulk-select"][data-card-id="base1-3"]',
    );
    expect(page1Box).not.toBeNull();
    page1Box!.checked = true;
    page1Box!.dispatchEvent(new Event('click', { bubbles: true }));
    await settle();

    // Sanity: count = 1.
    expect(
      getRoot()
        .querySelector('[data-region="bulk-action"]')
        ?.textContent,
    ).toBe('+1 raw på valgte (1)');

    // Navigate to page 2 — base1-3 is no longer rendered.
    getRoot()
      .querySelector<HTMLButtonElement>('[data-action="next-page"]')!
      .click();
    await settle(200);

    // Selection pruned, count back to 0, action disabled.
    expect(
      getRoot()
        .querySelector('[data-region="bulk-action"]')
        ?.textContent,
    ).toBe('+1 raw på valgte (0)');
    const action = getRoot().querySelector<HTMLButtonElement>(
      '[data-region="bulk-action"]',
    );
    expect(action?.disabled).toBe(true);

    // The base1-3 row is no longer in the DOM.
    expect(
      getRoot().querySelector(
        'tr[data-card-id="base1-3"]',
      ),
    ).toBeNull();
  });

  it('changing the search drops selection of cards that no longer match', async () => {
    await db.sets.put(setRecord);
    await db.cards.bulkPut([
      ericCard(1, 'Charizard'),
      ericCard(2, 'Pikachu'),
      ericCard(3, 'Mew'),
    ]);

    mountBrowseView(getRoot());
    await settle(150);

    getRoot()
      .querySelector<HTMLButtonElement>('[data-region="bulk-toggle"]')!
      .click();
    await settle();

    // Tick "Pikachu" (base1-2)
    const pika = getRoot().querySelector<HTMLInputElement>(
      'input[data-action="bulk-select"][data-card-id="base1-2"]',
    );
    expect(pika).not.toBeNull();
    pika!.checked = true;
    pika!.dispatchEvent(new Event('click', { bubbles: true }));
    await settle();
    expect(
      getRoot()
        .querySelector('[data-region="bulk-action"]')
        ?.textContent,
    ).toBe('+1 raw på valgte (1)');

    // Now search for "Charizard" — Pikachu is no longer rendered.
    const search = getRoot().querySelector<HTMLInputElement>(
      '[data-region="search"]',
    );
    if (search === null) throw new Error('search missing');
    search.value = 'Charizard';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    // Browse search is debounced ~150ms; wait long enough for the
    // rerender to settle.
    await settle(400);

    // Selection pruned.
    expect(
      getRoot()
        .querySelector('[data-region="bulk-action"]')
        ?.textContent,
    ).toBe('+1 raw på valgte (0)');
    expect(
      getRoot().querySelector(
        'tr[data-card-id="base1-2"]',
      ),
    ).toBeNull();
  });

  it('changing the set filter drops selection of cards from other sets', async () => {
    const setBase = setRecord;
    const setOther: SetRecord = {
      ...setRecord,
      id: 'sv1',
      name: 'Scarlet & Violet',
      releaseDate: '2023-03-31',
    };
    await db.sets.bulkPut([setBase, setOther]);
    await db.cards.bulkPut([
      ericCard(1, 'Charizard', 'base1'),
      ericCard(2, 'Pikachu', 'base1'),
      ericCard(1, 'Sprigatito', 'sv1'),
    ]);

    mountBrowseView(getRoot());
    await settle(150);

    getRoot()
      .querySelector<HTMLButtonElement>('[data-region="bulk-toggle"]')!
      .click();
    await settle();

    // Tick a base1 card.
    const cb = getRoot().querySelector<HTMLInputElement>(
      'input[data-action="bulk-select"][data-card-id="base1-1"]',
    );
    expect(cb).not.toBeNull();
    cb!.checked = true;
    cb!.dispatchEvent(new Event('click', { bubbles: true }));
    await settle();
    expect(
      getRoot()
        .querySelector('[data-region="bulk-action"]')
        ?.textContent,
    ).toBe('+1 raw på valgte (1)');

    // Set filter to sv1 — base1 cards are filtered out.
    const setSel = getRoot().querySelector<HTMLSelectElement>(
      '[data-region="set-filter"]',
    );
    if (setSel === null) throw new Error('set select missing');
    setSel.value = 'sv1';
    setSel.dispatchEvent(new Event('change', { bubbles: true }));
    await settle(200);

    expect(
      getRoot()
        .querySelector('[data-region="bulk-action"]')
        ?.textContent,
    ).toBe('+1 raw på valgte (0)');
  });

  it('bulk action after stale selection writes nothing — selection has already been pruned', async () => {
    // Worst-case path: user ticks, navigates page, then immediately
    // clicks the bulk action. Because the rerender on page change
    // already pruned the selection, the action sees an empty
    // selection and exits early without writing.
    await db.sets.put(setRecord);
    const cards: CardRecord[] = [];
    for (let i = 1; i <= 30; i += 1) cards.push(ericCard(i, `Card ${i}`));
    await db.cards.bulkPut(cards);

    mountBrowseView(getRoot());
    await settle(300);
    const pageSizeSel = getRoot().querySelector<HTMLSelectElement>(
      '[data-region="page-size"]',
    );
    pageSizeSel!.value = '25';
    pageSizeSel!.dispatchEvent(new Event('change', { bubbles: true }));
    await settle(150);

    getRoot()
      .querySelector<HTMLButtonElement>('[data-region="bulk-toggle"]')!
      .click();
    await settle();

    // Pick base1-3 (page 1)
    getRoot()
      .querySelector<HTMLInputElement>(
        'input[data-action="bulk-select"][data-card-id="base1-3"]',
      )!
      .click();
    await settle();
    // Navigate to page 2
    getRoot()
      .querySelector<HTMLButtonElement>('[data-action="next-page"]')!
      .click();
    await settle(200);
    // Try to fire — action is disabled, but click anyway via direct
    // dispatch (defensive).
    expect(await db.holdings.count()).toBe(0);
    const action = getRoot().querySelector<HTMLButtonElement>(
      '[data-region="bulk-action"]',
    );
    action!.disabled = false;
    action!.click();
    await settle(400);
    // No write happened — base1-3 was already pruned out of the
    // selection.
    expect(await db.holdings.count()).toBe(0);
  });
});
