// Browse + wishlist integration. Three things to pin:
//   1. The "Legg til i ønskeliste" button is enabled and opens the
//      wishlist form modal.
//   2. The on-wishlist filter narrows the table by reading live
//      wishlist entries with status `wanted` or `ordered`. `received`
//      and `cancelled` count as inactive.
//   3. Mount + filter + sort + pagination + navigation paths still
//      do not write user-owned data — only an explicit save through
//      the dialog mutates `wishlist`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountBrowseView } from '../src/views/browse';
import { _resetDbSingletonForTests, getDb } from '../src/db/database';
import { initializeDataLayer } from '../src/db/init';
import { createCardsRepo } from '../src/repositories/cards-repo';
import { createSetsRepo } from '../src/repositories/sets-repo';
import { createWishlistRepo } from '../src/repositories/wishlist-repo';
import { closeAndDelete } from './helpers/fresh-db';
import type { CardRecord, SetRecord } from '../src/domain/types';
import type { WishlistInput } from '../src/domain/validators';
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

const baseInput: WishlistInput = {
  cardId: 'base1-1',
  finish: 'normal',
  priority: 'medium',
  targetCondition: null,
  targetPrice: null,
  targetCurrency: null,
  status: 'wanted',
  note: null,
};

describe('Browse + wishlist integration', () => {
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
      makeCard(4),
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

  it('"Legg til i ønskeliste" is enabled and opens a wishlist form dialog', async () => {
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBrowseView(root);
    await settle();

    const addBtn = root.querySelector<HTMLButtonElement>(
      '[data-action="add-to-wishlist"]',
    );
    expect(addBtn).not.toBeNull();
    expect(addBtn?.disabled).toBe(false);

    addBtn?.click();
    await settle();

    const dialog = document.querySelector('dialog.app-dialog');
    expect(dialog).not.toBeNull();
    expect(dialog?.querySelector('form.wishlist-form')).not.toBeNull();

    dialog
      ?.querySelector<HTMLButtonElement>('[data-action="cancel"]')
      ?.click();
    await settle();
  });

  it('on-wishlist filter includes wanted/ordered, excludes received/cancelled/deleted', async () => {
    const repo = createWishlistRepo(db);
    await repo.create({ ...baseInput, cardId: 'base1-1', status: 'wanted' });
    await repo.create({ ...baseInput, cardId: 'base1-2', status: 'ordered' });
    await repo.create({ ...baseInput, cardId: 'base1-3', status: 'received' });
    const cancelledForCard4 = await repo.create({
      ...baseInput,
      cardId: 'base1-4',
      status: 'cancelled',
    });
    void cancelledForCard4;
    // Soft-delete the wanted entry to confirm deleted entries are
    // also excluded.
    const extraWanted = await repo.create({
      ...baseInput,
      cardId: 'base1-1',
      status: 'wanted',
    });
    await repo.softDelete(extraWanted.id);

    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBrowseView(root);
    await settle();

    const wishlistFilter = root.querySelector<HTMLSelectElement>(
      '[data-region="wishlist-filter"]',
    );
    expect(wishlistFilter).not.toBeNull();
    wishlistFilter!.value = 'on-wishlist';
    wishlistFilter!.dispatchEvent(new Event('change'));
    await settle();

    const rows = root.querySelectorAll<HTMLTableRowElement>(
      '.browse-table__row',
    );
    const ids = Array.from(rows)
      .map((r) => r.dataset['cardId'])
      .sort();
    // Only base1-1 (wanted, with one live entry) and base1-2 (ordered).
    expect(ids).toEqual(['base1-1', 'base1-2']);
  });

  it('passive interactions do not write any wishlist data', async () => {
    const beforeWishlist = await db.wishlist.toArray();
    const beforeAudits = await db.auditLog.toArray();

    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBrowseView(root);
    await settle();

    const search = root.querySelector<HTMLInputElement>(
      '[data-region="search"]',
    );
    search!.value = 'card';
    search!.dispatchEvent(new Event('input'));
    await settle(200);

    (root.querySelector<HTMLSelectElement>('[data-region="wishlist-filter"]') as HTMLSelectElement).value = 'on-wishlist';
    root
      .querySelector<HTMLSelectElement>('[data-region="wishlist-filter"]')
      ?.dispatchEvent(new Event('change'));
    await settle();

    expect(await db.wishlist.toArray()).toEqual(beforeWishlist);
    expect(await db.auditLog.toArray()).toEqual(beforeAudits);
  });

  it('save through the dialog produces exactly one wishlist row + one audit row', async () => {
    const beforeAudits = await db.auditLog
      .where('action')
      .equals('wishlist_item_created')
      .count();

    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBrowseView(root);
    await settle();

    const firstAddBtn = root.querySelector<HTMLButtonElement>(
      '[data-action="add-to-wishlist"]',
    );
    firstAddBtn?.click();
    await settle();

    const form = document.querySelector<HTMLFormElement>('form.wishlist-form');
    expect(form).not.toBeNull();
    form!.requestSubmit();

    await vi.waitFor(async () => {
      const after = await db.auditLog
        .where('action')
        .equals('wishlist_item_created')
        .count();
      expect(after).toBe(beforeAudits + 1);
    });

    const wishlist = await db.wishlist.toArray();
    expect(wishlist.length).toBe(1);
  });
});
