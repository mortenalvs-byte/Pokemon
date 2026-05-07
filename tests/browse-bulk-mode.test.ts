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
