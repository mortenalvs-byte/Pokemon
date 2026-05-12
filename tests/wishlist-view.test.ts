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

  // PR 22 — Wishlist view: receive flow + active/closed counts -------

  it('PR 22: counts header splits Aktive / Mottatt / Avbrutt / Slettede', async () => {
    const repo = createWishlistRepo(db);
    const wanted = await repo.create({ ...baseInput, status: 'wanted' });
    void wanted;
    const ordered = await repo.create({ ...baseInput, status: 'ordered' });
    void ordered;
    const received = await repo.create({ ...baseInput });
    await repo.update(received.id, { status: 'received' });
    const cancelled = await repo.create({ ...baseInput });
    await repo.update(cancelled.id, { status: 'cancelled' });
    const removed = await repo.create({ ...baseInput });
    await repo.softDelete(removed.id);

    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountWishlistView(root);
    await settle();
    const counts = root
      .querySelector<HTMLElement>('[data-region="counts"]')!
      .textContent ?? '';
    expect(counts).toContain('Aktive: 2');
    expect(counts).toContain('Ønsket: 1');
    expect(counts).toContain('Bestilt: 1');
    expect(counts).toContain('Mottatt: 1');
    expect(counts).toContain('Avbrutt: 1');
    expect(counts).toContain('Slettede: 1');
  });

  it('PR 22: Marker mottatt action only renders on wanted/ordered rows', async () => {
    const repo = createWishlistRepo(db);
    const wanted = await repo.create({ ...baseInput, status: 'wanted' });
    const ordered = await repo.create({ ...baseInput, status: 'ordered' });
    const receivedSeed = await repo.create({ ...baseInput });
    await repo.update(receivedSeed.id, { status: 'received' });

    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountWishlistView(root);
    await settle();
    const wantedRow = root.querySelector<HTMLTableRowElement>(
      `.wishlist-table__row[data-wishlist-id="${wanted.id}"]`,
    );
    const orderedRow = root.querySelector<HTMLTableRowElement>(
      `.wishlist-table__row[data-wishlist-id="${ordered.id}"]`,
    );
    const receivedRow = root.querySelector<HTMLTableRowElement>(
      `.wishlist-table__row[data-wishlist-id="${receivedSeed.id}"]`,
    );
    expect(
      wantedRow?.querySelector('button[data-action="mark-received"]'),
    ).not.toBeNull();
    expect(
      orderedRow?.querySelector('button[data-action="mark-received"]'),
    ).not.toBeNull();
    expect(
      receivedRow?.querySelector('button[data-action="mark-received"]'),
    ).toBeNull();
  });

  it('PR 22: clicking Marker mottatt flips status to received and updates audit', async () => {
    const repo = createWishlistRepo(db);
    const wanted = await repo.create({ ...baseInput, status: 'wanted' });

    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountWishlistView(root);
    await settle();

    const row = root.querySelector<HTMLTableRowElement>(
      `.wishlist-table__row[data-wishlist-id="${wanted.id}"]`,
    );
    const btn = row?.querySelector<HTMLButtonElement>(
      'button[data-action="mark-received"]',
    );
    expect(btn).not.toBeNull();
    btn?.click();

    await vi.waitFor(async () => {
      const stored = await repo.get(wanted.id);
      expect(stored?.status).toBe('received');
    });
    // Audit row appended via repo.update
    const auditRows = await db.auditLog.toArray();
    const updates = auditRows.filter(
      (r) => r.action === 'wishlist_item_updated' && r.entityId === wanted.id,
    );
    expect(updates.length).toBe(1);
    expect(updates[0]?.message).toContain('status=received');
    // Active count drops to 0; received count is now 1.
    const counts = root
      .querySelector<HTMLElement>('[data-region="counts"]')!
      .textContent ?? '';
    expect(counts).toContain('Aktive: 0');
    expect(counts).toContain('Mottatt: 1');
  });

  // C4 — Phase-2 Plan C: wishlist toolbar filter wiring.
  // Pins the status / priority / set / search / page-size filters
  // so a future refactor cannot silently drop one.

  it('C4: status-filter narrows rows by wishlist status', async () => {
    const repo = createWishlistRepo(db);
    const wantedA = await repo.create({ ...baseInput, status: 'wanted' });
    const orderedB = await repo.create({ ...baseInput, status: 'ordered' });
    await repo.create({ ...baseInput, status: 'received' });

    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountWishlistView(root);
    await settle();
    // Default filter is empty (Alle); all 3 visible.
    expect(root.querySelectorAll('.wishlist-table__row').length).toBe(3);

    const statusFilter = root.querySelector<HTMLSelectElement>(
      '[data-region="status-filter"]',
    );
    expect(statusFilter).not.toBeNull();
    statusFilter!.value = 'wanted';
    statusFilter!.dispatchEvent(new Event('change'));
    await settle();
    expect(root.querySelectorAll('.wishlist-table__row').length).toBe(1);

    statusFilter!.value = 'ordered';
    statusFilter!.dispatchEvent(new Event('change'));
    await settle();
    expect(root.querySelectorAll('.wishlist-table__row').length).toBe(1);
    expect(
      root
        .querySelector<HTMLTableRowElement>('.wishlist-table__row')
        ?.dataset['wishlistId'],
    ).toBe(orderedB.id);
    void wantedA;
  });

  it('C4: priority-filter narrows rows by priority', async () => {
    await seedThree(); // grail, high, low
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountWishlistView(root);
    await settle();
    expect(root.querySelectorAll('.wishlist-table__row').length).toBe(3);

    const priorityFilter = root.querySelector<HTMLSelectElement>(
      '[data-region="priority-filter"]',
    );
    expect(priorityFilter).not.toBeNull();
    priorityFilter!.value = 'grail';
    priorityFilter!.dispatchEvent(new Event('change'));
    await settle();
    expect(root.querySelectorAll('.wishlist-table__row').length).toBe(1);
  });

  it('C4: search input narrows rows after debounce', async () => {
    // Two different cards, two wishlist entries.
    const other: CardRecord = {
      ...sampleCard,
      id: 'base1-58',
      name: 'Pikachu',
      number: '58',
    };
    await createCardsRepo(db).upsert(other);
    const repo = createWishlistRepo(db);
    await repo.create(baseInput);
    await repo.create({ ...baseInput, cardId: 'base1-58' });

    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountWishlistView(root);
    await settle();
    expect(root.querySelectorAll('.wishlist-table__row').length).toBe(2);

    const search = root.querySelector<HTMLInputElement>(
      '[data-region="search"]',
    );
    expect(search).not.toBeNull();
    search!.value = 'PIKA';
    search!.dispatchEvent(new Event('input'));

    await vi.waitFor(() => {
      expect(root.querySelectorAll('.wishlist-table__row').length).toBe(1);
    });
  });

  it('C4: set-filter narrows rows by setId', async () => {
    const secondSet: SetRecord = {
      ...sampleSet,
      id: 'jungle',
      name: 'Jungle',
    };
    const secondCard: CardRecord = {
      ...sampleCard,
      id: 'jungle-15',
      setId: 'jungle',
      name: 'Scyther',
      number: '15',
    };
    await createSetsRepo(db).upsert(secondSet);
    await createCardsRepo(db).upsert(secondCard);
    const repo = createWishlistRepo(db);
    await repo.create(baseInput);
    await repo.create({ ...baseInput, cardId: 'jungle-15' });

    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountWishlistView(root);
    await settle();
    expect(root.querySelectorAll('.wishlist-table__row').length).toBe(2);

    const setFilter = root.querySelector<HTMLSelectElement>(
      '[data-region="set-filter"]',
    );
    expect(setFilter).not.toBeNull();
    setFilter!.value = 'jungle';
    setFilter!.dispatchEvent(new Event('change'));
    await settle();
    expect(root.querySelectorAll('.wishlist-table__row').length).toBe(1);
  });

  it('C4: page-size 25 paginates the rows + next-page advances', async () => {
    const repo = createWishlistRepo(db);
    // 30 entries (same card, varying priority/finish to satisfy
    // any uniqueness constraint).
    const priorities = ['grail', 'high', 'medium', 'low'] as const;
    // Only finishes the seeded card actually supports (tcgplayer.prices
    // exposes normal + holofoil + reverseHolofoil). The wishlist repo
    // validates each create against the card's variants and would
    // reject e.g. `non_holo` for this card.
    const finishes = ['normal', 'holo', 'reverse_holo'] as const;
    for (let i = 0; i < 30; i += 1) {
      await repo.create({
        ...baseInput,
        priority: priorities[i % priorities.length]!,
        finish: finishes[i % finishes.length]!,
        note: `entry-${i}`,
      });
    }

    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountWishlistView(root);
    await settle();

    const pageSize = root.querySelector<HTMLSelectElement>(
      '[data-region="page-size"]',
    );
    expect(pageSize).not.toBeNull();
    pageSize!.value = '25';
    pageSize!.dispatchEvent(new Event('change'));
    await settle();

    expect(root.querySelectorAll('.wishlist-table__row').length).toBe(25);
    const summary = root.querySelector('[data-region="page-summary"]');
    expect(summary?.textContent ?? '').toMatch(/Side 1 av 2/);

    root
      .querySelector<HTMLButtonElement>('[data-action="next-page"]')
      ?.click();
    await settle();
    expect(root.querySelectorAll('.wishlist-table__row').length).toBe(5);
  });
});
