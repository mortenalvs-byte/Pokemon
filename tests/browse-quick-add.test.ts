// PR 15B — Browse Quick Add integration tests.
//
// Verifies that the new "+1 raw" button in each Browse row:
//   1. is present and enabled when the card has at least one verified
//      finish + edition (default normal + unlimited for the common
//      "normal-only" bulk card)
//   2. is rendered as a `disabled` button with a Norwegian tooltip
//      when the card has no API-verified variant
//   3. on click, calls `holdingsRepo.upsertByVariant` so the second
//      click on the same row increments quantity instead of creating
//      a duplicate row
//   4. the inline feedback chip changes class + text on created vs
//      merged outcomes
//   5. dispatches USER_DATA_CHANGED_EVENT after a successful write
//   6. does NOT bypass the variant validator — feeding a tampered
//      data-finish via the dataset fails inside the repo, no row
//      created.

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

const normalOnlyCard: CardRecord = {
  id: 'base1-46',
  setId: 'base1',
  name: 'Charmander',
  number: '46',
  rarity: 'Common',
  supertype: 'Pokémon',
  subtypes: ['Basic'],
  types: ['Fire'],
  imageSmall: null,
  imageLarge: null,
  tcgplayer: { prices: { normal: { market: 5 } } },
  cardmarket: null,
  updatedAt: '2026-05-06T00:00:00.000Z',
};

const noVariantCard: CardRecord = {
  id: 'basep-1',
  setId: 'base1',
  name: 'Mystery Promo',
  number: '1',
  rarity: 'Promo',
  supertype: 'Pokémon',
  subtypes: [],
  types: [],
  imageSmall: null,
  imageLarge: null,
  tcgplayer: null,
  cardmarket: null,
  updatedAt: '2026-05-06T00:00:00.000Z',
};

describe('Browse Quick Add Raw (PR 15B)', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    document.body.innerHTML = '<div id="content"></div>';
    _resetDbSingletonForTests();
    db = getDb();
    await initializeDataLayer({ db, skipPersistentStorage: true });
    await db.sets.put(setRecord);
    await db.cards.bulkPut([normalOnlyCard, noVariantCard]);
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

  function getQuickAddButton(
    root: HTMLElement,
    cardId: string,
  ): HTMLButtonElement {
    const btn = root.querySelector<HTMLButtonElement>(
      `tr[data-card-id="${cardId}"] button[data-action="quick-add-raw"]`,
    );
    if (btn === null) {
      throw new Error(`quick-add button not found for card ${cardId}`);
    }
    return btn;
  }

  it('renders an enabled +1 raw button for a card with verified variant', async () => {
    mountBrowseView(getRoot());
    await settle();
    const btn = getQuickAddButton(getRoot(), 'base1-46');
    expect(btn.disabled).toBe(false);
    expect(btn.textContent?.trim()).toBe('+1 raw');
    expect(btn.dataset['finish']).toBe('normal');
    expect(btn.dataset['edition']).toBe('unlimited');
    expect(btn.title).toContain('Klikk igjen');
  });

  it('renders a disabled button with explanatory tooltip when card has no verified variant', async () => {
    mountBrowseView(getRoot());
    await settle();
    const btn = getQuickAddButton(getRoot(), 'basep-1');
    expect(btn.disabled).toBe(true);
    expect(btn.title).toContain('Mangler API-verifisert variant');
    expect(btn.title).toContain('Legg til i samling');
  });

  it('first click creates a holding (action="created") with the verified defaults', async () => {
    mountBrowseView(getRoot());
    await settle();
    const btn = getQuickAddButton(getRoot(), 'base1-46');
    btn.click();
    await vi.waitFor(async () => {
      expect(await db.holdings.count()).toBe(1);
    });
    const holdings = await db.holdings.toArray();
    expect(holdings[0]).toMatchObject({
      cardId: 'base1-46',
      conditionType: 'raw',
      rawCondition: 'NM',
      finish: 'normal',
      edition: 'unlimited',
      quantity: 1,
      status: 'owned',
      language: 'en',
    });
    // Audit was appended via upsertByVariant's `holding_created` path.
    const audits = await db.auditLog
      .where('action')
      .equals('holding_created')
      .toArray();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.message).toContain('upsertByVariant');
  });

  it('second click on the same row merges quantity (action="merged") via upsertByVariant', async () => {
    mountBrowseView(getRoot());
    await settle();
    // First click — fetch + click against the freshly-mounted row.
    getQuickAddButton(getRoot(), 'base1-46').click();
    await vi.waitFor(async () => {
      expect(await db.holdings.count()).toBe(1);
    });
    // Browse rerenders on USER_DATA_CHANGED_EVENT, so the original
    // button reference is detached. Re-fetch the new button before
    // the second click.
    getQuickAddButton(getRoot(), 'base1-46').click();
    await vi.waitFor(async () => {
      const h = await db.holdings.toArray();
      expect(h[0]?.quantity).toBe(2);
    });
    // Still ONE row — the whole point of qty-merge.
    expect(await db.holdings.count()).toBe(1);
    const incremented = await db.auditLog
      .where('action')
      .equals('holding_qty_incremented')
      .toArray();
    expect(incremented).toHaveLength(1);
    expect(incremented[0]?.message).toContain('1 → 2');
  });

  it('feedback chip shows "Lagt til" on first click and "+1 → 2" on the merge', async () => {
    mountBrowseView(getRoot());
    await settle();
    const root = getRoot();
    getQuickAddButton(root, 'base1-46').click();
    await vi.waitFor(() => {
      const chip = root.querySelector(
        'tr[data-card-id="base1-46"] [data-region="quick-add-feedback"]',
      );
      expect(chip?.textContent?.trim()).toBe('Lagt til');
      expect(chip?.classList.contains('browse-table__quick-add-feedback--created')).toBe(true);
    });
    // Re-fetch after the rerender so we click the live button.
    getQuickAddButton(root, 'base1-46').click();
    await vi.waitFor(() => {
      const chip = root.querySelector(
        'tr[data-card-id="base1-46"] [data-region="quick-add-feedback"]',
      );
      expect(chip?.textContent?.trim()).toMatch(/\+1\s+→\s+2/);
      expect(chip?.classList.contains('browse-table__quick-add-feedback--merged')).toBe(true);
    });
  });

  it('dispatches USER_DATA_CHANGED_EVENT after a successful write', async () => {
    mountBrowseView(getRoot());
    await settle();
    const fired: number[] = [];
    const handler = (): void => {
      fired.push(Date.now());
    };
    window.addEventListener('pokemon:user-data-changed', handler);
    const btn = getQuickAddButton(getRoot(), 'base1-46');
    btn.click();
    await vi.waitFor(() => {
      expect(fired.length).toBeGreaterThanOrEqual(1);
    });
    window.removeEventListener('pokemon:user-data-changed', handler);
  });

  it('repo bypass: tampering with data-finish to a non-verified value is rejected by the repo', async () => {
    mountBrowseView(getRoot());
    await settle();
    const btn = getQuickAddButton(getRoot(), 'base1-46');
    // Simulate a devtools tweak: switch the finish to something the
    // card doesn't support. The repo's variant validator must reject
    // it; no row should be created.
    btn.dataset['finish'] = 'holo';
    btn.click();
    // Wait long enough for the click handler's async write to settle
    // (or fail) — the chip transitions to "Feil" on rejection.
    await vi.waitFor(() => {
      const chip = document.querySelector(
        'tr[data-card-id="base1-46"] [data-region="quick-add-feedback"]',
      );
      expect(chip?.textContent?.trim()).toBe('Feil');
      expect(chip?.classList.contains('browse-table__quick-add-feedback--error')).toBe(true);
    });
    expect(await db.holdings.count()).toBe(0);
    expect(btn.title).toContain('Quick Add avvist');
  });
});
