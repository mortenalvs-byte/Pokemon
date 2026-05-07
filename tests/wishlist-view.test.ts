import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountWishlistView } from '../src/views/wishlist';
import { _resetDbSingletonForTests, getDb } from '../src/db/database';
import { initializeDataLayer } from '../src/db/init';
import { createCardsRepo } from '../src/repositories/cards-repo';
import { createSetsRepo } from '../src/repositories/sets-repo';
import { createWishlistRepo } from '../src/repositories/wishlist-repo';
import { closeAndDelete } from './helpers/fresh-db';
import type { CardRecord, SetRecord, WishlistRecord } from '../src/domain/types';
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

const sampleCard: CardRecord = {
  id: 'base1-4',
  setId: 'base1',
  name: 'Charizard',
  number: '4',
  rarity: 'Rare Holo',
  supertype: 'Pokémon',
  subtypes: [],
  types: ['Fire'],
  imageSmall: null,
  imageLarge: null,
  tcgplayer: null,
  cardmarket: null,
  updatedAt: '2026-05-06T00:00:00.000Z',
};

const baseInput: WishlistInput = {
  cardId: 'base1-4',
  finish: 'holo',
  priority: 'medium',
  targetCondition: null,
  targetPrice: null,
  targetCurrency: null,
  status: 'wanted',
  note: null,
};

describe('Wishlist view', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    document.body.innerHTML = '<div id="content"></div>';
    _resetDbSingletonForTests();
    db = getDb();
    await initializeDataLayer({ db, skipPersistentStorage: true });
    await createSetsRepo(db).upsert(sampleSet);
    await createCardsRepo(db).upsert(sampleCard);
  });

  afterEach(async () => {
    await settle(40);
    document.body.innerHTML = '';
    await closeAndDelete(db);
    _resetDbSingletonForTests();
  });

  async function seedThree(): Promise<WishlistRecord[]> {
    const repo = createWishlistRepo(db);
    const a = await repo.create({ ...baseInput, priority: 'grail' });
    const b = await repo.create({ ...baseInput, priority: 'high' });
    const c = await repo.create({ ...baseInput, priority: 'low' });
    return [a, b, c];
  }

  it('mounts heading, toolbar, and table regions', async () => {
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountWishlistView(root);
    await settle();
    expect(root.querySelector('h1')?.textContent).toBe('Ønskeliste');
    expect(root.querySelector('[data-region="rows"]')).not.toBeNull();
    expect(root.querySelector('[data-region="pagination"]')).not.toBeNull();
  });

  it('shows wishlist rows with Edit and Fjern actions', async () => {
    await seedThree();
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountWishlistView(root);
    await settle();

    const rows = root.querySelectorAll<HTMLTableRowElement>(
      '.wishlist-table__row',
    );
    expect(rows.length).toBe(3);
    const firstActions = rows[0]!.querySelectorAll<HTMLButtonElement>(
      'button[data-action]',
    );
    const names = Array.from(firstActions).map((b) => b.dataset['action']);
    expect(names).toContain('edit');
    expect(names).toContain('soft-delete');
  });

  it('Fjern confirms, removes the row, and writes audit', async () => {
    const [first] = await seedThree();
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountWishlistView(root);
    await settle();

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    const targetRow = root.querySelector<HTMLTableRowElement>(
      `.wishlist-table__row[data-wishlist-id="${first?.id}"]`,
    );
    const removeBtn = targetRow!.querySelector<HTMLButtonElement>(
      'button[data-action="soft-delete"]',
    );
    removeBtn?.click();

    await vi.waitFor(async () => {
      const rows = root.querySelectorAll('.wishlist-table__row');
      expect(rows.length).toBe(2);
    });

    const stored = await db.wishlist.get(first?.id ?? '');
    expect(stored?.deletedAt).not.toBeNull();
    confirmSpy.mockRestore();
  });

  it('show-deleted toggle reveals deleted rows with a Restore button', async () => {
    const repo = createWishlistRepo(db);
    const created = await repo.create(baseInput);
    await repo.softDelete(created.id);

    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountWishlistView(root);
    await settle();

    expect(root.querySelectorAll('.wishlist-table__row').length).toBe(0);

    const toggle = root.querySelector<HTMLInputElement>(
      '[data-region="show-deleted"]',
    );
    expect(toggle).not.toBeNull();
    toggle!.checked = true;
    toggle!.dispatchEvent(new Event('change'));
    await settle();

    const rows = root.querySelectorAll('.wishlist-table__row');
    expect(rows.length).toBe(1);
    const restore = rows[0]!.querySelector<HTMLButtonElement>(
      'button[data-action="restore"]',
    );
    expect(restore).not.toBeNull();

    restore?.click();
    await vi.waitFor(async () => {
      const fetched = await repo.get(created.id);
      expect(fetched?.deletedAt).toBeNull();
    });
  });

  it('does not crash when the wishlist is empty', async () => {
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountWishlistView(root);
    await settle();
    const empty = root.querySelector('.browse-table__empty-row');
    expect(empty?.textContent ?? '').toMatch(/Ønskelisten er tom/i);
  });
});
