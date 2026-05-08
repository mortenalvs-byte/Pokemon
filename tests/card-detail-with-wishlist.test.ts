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

  // PR 22 — Card Detail receive-flow tests --------------------------

  it('PR 22: shows owned + active wishlist conflict banner when both exist', async () => {
    const wishlistRepo = createWishlistRepo(db);
    await wishlistRepo.create(baseInput);
    const { createHoldingsRepo } = await import('../src/repositories/holdings-repo');
    await createHoldingsRepo(db).create({
      cardId: 'base1-4',
      quantity: 1,
      conditionType: 'raw',
      rawCondition: 'NM',
      gradingCompany: null,
      grade: null,
      certNumber: null,
      certUrl: null,
      gradedDate: null,
      finish: 'holo',
      edition: 'unlimited',
      language: 'en',
      purchasePrice: null,
      purchaseCurrency: null,
      estimatedValue: null,
      valueCurrency: null,
      valueSource: 'unknown',
      valueNote: null,
      valueUpdatedAt: null,
      source: 'manual',
      note: null,
      specialVariant: false,
      tags: [],
      lotId: null,
      status: 'owned',
    });

    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountCardDetailView(root);
    await settle();

    const banner = root.querySelector(
      '[data-region="owned-active-wishlist-banner"]',
    );
    expect(banner).not.toBeNull();
    const action = banner?.querySelector<HTMLButtonElement>(
      'button[data-action="mark-active-received"]',
    );
    expect(action?.textContent ?? '').toMatch(/Marker.*mottatt/i);
  });

  it('PR 22: conflict banner is hidden when there are no holdings', async () => {
    const repo = createWishlistRepo(db);
    await repo.create(baseInput);

    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountCardDetailView(root);
    await settle();

    const banner = root.querySelector(
      '[data-region="owned-active-wishlist-banner"]',
    );
    expect(banner).toBeNull();
  });

  it('PR 22: conflict banner is hidden when wishlist is only received/cancelled', async () => {
    const wishlistRepo = createWishlistRepo(db);
    const w = await wishlistRepo.create(baseInput);
    await wishlistRepo.update(w.id, { status: 'received' });
    const { createHoldingsRepo } = await import('../src/repositories/holdings-repo');
    await createHoldingsRepo(db).create({
      cardId: 'base1-4',
      quantity: 1,
      conditionType: 'raw',
      rawCondition: 'NM',
      gradingCompany: null,
      grade: null,
      certNumber: null,
      certUrl: null,
      gradedDate: null,
      finish: 'holo',
      edition: 'unlimited',
      language: 'en',
      purchasePrice: null,
      purchaseCurrency: null,
      estimatedValue: null,
      valueCurrency: null,
      valueSource: 'unknown',
      valueNote: null,
      valueUpdatedAt: null,
      source: 'manual',
      note: null,
      specialVariant: false,
      tags: [],
      lotId: null,
      status: 'owned',
    });

    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountCardDetailView(root);
    await settle();

    const banner = root.querySelector(
      '[data-region="owned-active-wishlist-banner"]',
    );
    expect(banner).toBeNull();
  });

  it('PR 22: clicking conflict banner action opens prompt; submitting flips wishlist to received', async () => {
    const wishlistRepo = createWishlistRepo(db);
    const w = await wishlistRepo.create(baseInput);
    const { createHoldingsRepo } = await import('../src/repositories/holdings-repo');
    await createHoldingsRepo(db).create({
      cardId: 'base1-4',
      quantity: 1,
      conditionType: 'raw',
      rawCondition: 'NM',
      gradingCompany: null,
      grade: null,
      certNumber: null,
      certUrl: null,
      gradedDate: null,
      finish: 'holo',
      edition: 'unlimited',
      language: 'en',
      purchasePrice: null,
      purchaseCurrency: null,
      estimatedValue: null,
      valueCurrency: null,
      valueSource: 'unknown',
      valueNote: null,
      valueUpdatedAt: null,
      source: 'manual',
      note: null,
      specialVariant: false,
      tags: [],
      lotId: null,
      status: 'owned',
    });

    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountCardDetailView(root);
    await settle();

    const action = root.querySelector<HTMLButtonElement>(
      '[data-region="owned-active-wishlist-banner"] button[data-action="mark-active-received"]',
    );
    expect(action).not.toBeNull();
    action?.click();

    // The banner now opens the shared receive prompt — submit it to
    // actually flip the status. This proves the banner respects the
    // same prompt UX (exact match default-checked).
    const promptForm = await vi.waitFor<HTMLFormElement>(() => {
      const f = document.querySelector<HTMLFormElement>(
        'form.wishlist-receive-prompt',
      );
      if (f === null) throw new Error('prompt did not open');
      return f;
    });
    const checked = promptForm.querySelectorAll<HTMLInputElement>(
      'input[name="receive"]:checked',
    );
    expect(checked.length).toBe(1);
    expect(checked[0]?.dataset['wishlistId']).toBe(w.id);
    promptForm.dispatchEvent(
      new Event('submit', { cancelable: true, bubbles: true }),
    );
    await vi.waitFor(async () => {
      const stored = await wishlistRepo.get(w.id);
      expect(stored?.status).toBe('received');
    });
  });

  it('PR 22 review: banner respects finish — owned normal + wishlist reverse_holo hides banner', async () => {
    const wishlistRepo = createWishlistRepo(db);
    const reverseHoloWish = await wishlistRepo.create({
      ...baseInput,
      finish: 'reverse_holo',
    });
    const { createHoldingsRepo } = await import('../src/repositories/holdings-repo');
    await createHoldingsRepo(db).create({
      cardId: 'base1-4',
      quantity: 1,
      conditionType: 'raw',
      rawCondition: 'NM',
      gradingCompany: null,
      grade: null,
      certNumber: null,
      certUrl: null,
      gradedDate: null,
      finish: 'normal',
      edition: 'unlimited',
      language: 'en',
      purchasePrice: null,
      purchaseCurrency: null,
      estimatedValue: null,
      valueCurrency: null,
      valueSource: 'unknown',
      valueNote: null,
      valueUpdatedAt: null,
      source: 'manual',
      note: null,
      specialVariant: false,
      tags: [],
      lotId: null,
      status: 'owned',
    });

    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountCardDetailView(root);
    await settle();

    const banner = root.querySelector(
      '[data-region="owned-active-wishlist-banner"]',
    );
    // No banner: holding finish (normal) does not match wishlist finish
    // (reverse_holo). The reverse_holo wishlist row stays active.
    expect(banner).toBeNull();
    const stillActive = await wishlistRepo.get(reverseHoloWish.id);
    expect(stillActive?.status).toBe('wanted');
  });

  it('PR 22 review: banner only includes finish-matching candidates when card has multi-finish wishlist', async () => {
    const wishlistRepo = createWishlistRepo(db);
    const holoWish = await wishlistRepo.create({ ...baseInput, finish: 'holo' });
    const reverseHoloWish = await wishlistRepo.create({
      ...baseInput,
      finish: 'reverse_holo',
    });
    const { createHoldingsRepo } = await import('../src/repositories/holdings-repo');
    // Holding only matches the holo wishlist row.
    await createHoldingsRepo(db).create({
      cardId: 'base1-4',
      quantity: 1,
      conditionType: 'raw',
      rawCondition: 'NM',
      gradingCompany: null,
      grade: null,
      certNumber: null,
      certUrl: null,
      gradedDate: null,
      finish: 'holo',
      edition: 'unlimited',
      language: 'en',
      purchasePrice: null,
      purchaseCurrency: null,
      estimatedValue: null,
      valueCurrency: null,
      valueSource: 'unknown',
      valueNote: null,
      valueUpdatedAt: null,
      source: 'manual',
      note: null,
      specialVariant: false,
      tags: [],
      lotId: null,
      status: 'owned',
    });

    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountCardDetailView(root);
    await settle();

    const action = root.querySelector<HTMLButtonElement>(
      '[data-region="owned-active-wishlist-banner"] button[data-action="mark-active-received"]',
    );
    expect(action).not.toBeNull();
    // Banner says "Marker som mottatt" (single) since only the holo
    // candidate matches — even though the user has 2 active wishlist
    // rows for the same card.
    expect(action?.textContent ?? '').toBe('Marker som mottatt');
    action?.click();

    const promptForm = await vi.waitFor<HTMLFormElement>(() => {
      const f = document.querySelector<HTMLFormElement>(
        'form.wishlist-receive-prompt',
      );
      if (f === null) throw new Error('prompt did not open');
      return f;
    });
    const rowIds = Array.from(
      promptForm.querySelectorAll<HTMLInputElement>('input[name="receive"]'),
    ).map((cb) => cb.dataset['wishlistId']);
    expect(rowIds).toEqual([holoWish.id]);
    expect(rowIds).not.toContain(reverseHoloWish.id);
    // Submit and verify only holo flipped.
    promptForm.dispatchEvent(
      new Event('submit', { cancelable: true, bubbles: true }),
    );
    await vi.waitFor(async () => {
      const post = await wishlistRepo.get(holoWish.id);
      expect(post?.status).toBe('received');
    });
    const reverseAfter = await wishlistRepo.get(reverseHoloWish.id);
    expect(reverseAfter?.status).toBe('wanted');
  });

  it('PR 22 review: condition_mismatch candidate appears in prompt unchecked', async () => {
    const wishlistRepo = createWishlistRepo(db);
    const w = await wishlistRepo.create({
      ...baseInput,
      targetCondition: 'NM',
    });
    const { createHoldingsRepo } = await import('../src/repositories/holdings-repo');
    await createHoldingsRepo(db).create({
      cardId: 'base1-4',
      quantity: 1,
      conditionType: 'raw',
      rawCondition: 'LP',
      gradingCompany: null,
      grade: null,
      certNumber: null,
      certUrl: null,
      gradedDate: null,
      finish: 'holo',
      edition: 'unlimited',
      language: 'en',
      purchasePrice: null,
      purchaseCurrency: null,
      estimatedValue: null,
      valueCurrency: null,
      valueSource: 'unknown',
      valueNote: null,
      valueUpdatedAt: null,
      source: 'manual',
      note: null,
      specialVariant: false,
      tags: [],
      lotId: null,
      status: 'owned',
    });

    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountCardDetailView(root);
    await settle();

    const action = root.querySelector<HTMLButtonElement>(
      '[data-region="owned-active-wishlist-banner"] button[data-action="mark-active-received"]',
    );
    expect(action).not.toBeNull();
    action?.click();

    const promptForm = await vi.waitFor<HTMLFormElement>(() => {
      const f = document.querySelector<HTMLFormElement>(
        'form.wishlist-receive-prompt',
      );
      if (f === null) throw new Error('prompt did not open');
      return f;
    });
    const rows = promptForm.querySelectorAll<HTMLLIElement>(
      '.wishlist-receive-prompt__row',
    );
    expect(rows.length).toBe(1);
    expect(rows[0]?.dataset['matchType']).toBe('condition_mismatch');
    const cb = rows[0]?.querySelector<HTMLInputElement>(
      'input[name="receive"]',
    );
    expect(cb?.checked).toBe(false);
    // User did not check it — submit-as-is leaves wishlist active.
    promptForm.dispatchEvent(
      new Event('submit', { cancelable: true, bubbles: true }),
    );
    // Give the submit handler a tick to close the dialog.
    await settle(50);
    const after = await wishlistRepo.get(w.id);
    expect(after?.status).toBe('wanted');
  });

  it('PR 22: per-row Marker mottatt only on active rows in Card Detail wishlist table', async () => {
    const repo = createWishlistRepo(db);
    const wanted = await repo.create({ ...baseInput, status: 'wanted' });
    const ordered = await repo.create({ ...baseInput, status: 'ordered' });
    const closed = await repo.create({ ...baseInput });
    await repo.update(closed.id, { status: 'received' });

    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountCardDetailView(root);
    await settle();

    const table = root.querySelector(
      '.card-detail-view__wishlist-table tbody',
    );
    expect(table).not.toBeNull();
    const rows = table!.querySelectorAll<HTMLTableRowElement>('tr');
    const findRow = (id: string): HTMLTableRowElement | null =>
      Array.from(rows).find((r) => r.dataset['wishlistId'] === id) ?? null;
    expect(
      findRow(wanted.id)?.querySelector('button[data-action="mark-received"]'),
    ).not.toBeNull();
    expect(
      findRow(ordered.id)?.querySelector('button[data-action="mark-received"]'),
    ).not.toBeNull();
    expect(
      findRow(closed.id)?.querySelector('button[data-action="mark-received"]'),
    ).toBeNull();
  });
});
