// Card Detail + wishlist integration. Mirrors the holdings-side test
// from PR 7a but for wishlist entries.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountCardDetailView } from '../src/views/card-detail';
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
  tcgplayer: { prices: { normal: { market: 1 }, holofoil: { market: 1 }, reverseHolofoil: { market: 1 }, "1stEditionNormal": { market: 1 }, "1stEditionHolofoil": { market: 1 } } },
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

describe('Card Detail + wishlist', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    document.body.innerHTML = '<div id="content"></div>';
    _resetDbSingletonForTests();
    db = getDb();
    await initializeDataLayer({ db, skipPersistentStorage: true });
    await createSetsRepo(db).upsert(sampleSet);
    await createCardsRepo(db).upsert(sampleCard);
    window.location.hash = `card/${encodeURIComponent('base1-4')}`;
  });

  afterEach(async () => {
    await settle(40);
    document.body.innerHTML = '';
    await closeAndDelete(db);
    _resetDbSingletonForTests();
    window.location.hash = '';
  });

  it('"Legg til i ønskeliste" is enabled and opens the wishlist form', async () => {
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountCardDetailView(root);
    await settle();

    const button = root.querySelector<HTMLButtonElement>(
      '[data-action="add-to-wishlist"]',
    );
    expect(button).not.toBeNull();
    expect(button?.disabled).toBe(false);

    button?.click();
    await settle();
    const dialog = document.querySelector('dialog.app-dialog');
    expect(dialog).not.toBeNull();
    expect(dialog?.querySelector('form.wishlist-form')).not.toBeNull();
    dialog
      ?.querySelector<HTMLButtonElement>('[data-action="cancel"]')
      ?.click();
    await settle();
  });

  it('shows the empty state when no wishlist entries exist', async () => {
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountCardDetailView(root);
    await settle();
    expect(root.textContent ?? '').toMatch(/ligger ikke på ønskelisten/i);
  });

  it('lists existing wishlist entries with Edit / Fjern actions', async () => {
    const repo = createWishlistRepo(db);
    await repo.create({ ...baseInput, priority: 'grail', status: 'wanted' });
    await repo.create({ ...baseInput, priority: 'high', status: 'ordered' });

    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountCardDetailView(root);
    await settle();

    const rows = root.querySelectorAll(
      '.card-detail-view__wishlist-table tbody tr',
    );
    expect(rows.length).toBe(2);
  });

  it('Fjern soft-deletes from Card Detail and writes audit', async () => {
    const repo = createWishlistRepo(db);
    const created = await repo.create(baseInput);

    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountCardDetailView(root);
    await settle();

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const tbody = root.querySelector(
      '.card-detail-view__wishlist-table tbody',
    );
    expect(tbody).not.toBeNull();
    const removeButton = Array.from(
      tbody!.querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => b.textContent?.trim() === 'Fjern');
    expect(removeButton).toBeDefined();

    removeButton?.click();
    await vi.waitFor(async () => {
      const stored = await repo.get(created.id);
      expect(stored?.deletedAt).not.toBeNull();
    });

    const audits = await db.auditLog
      .where('action')
      .equals('wishlist_soft_deleted')
      .toArray();
    expect(audits.length).toBe(1);

    confirmSpy.mockRestore();
  });

  it('does not regress the holdings ("Dine kort") section', async () => {
    const repo = createWishlistRepo(db);
    await repo.create(baseInput);

    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountCardDetailView(root);
    await settle();

    // The "Dine kort" section header still renders even though there
    // are no holdings — the section never disappears in PR 7b.
    const headings = Array.from(root.querySelectorAll('h3')).map((h) => h.textContent);
    expect(headings).toContain('Dine kort');
    expect(headings).toContain('Ønskeliste-status');
  });
});
