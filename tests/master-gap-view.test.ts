// PR 25 — master-gap view UI tests. Covers loading, summary, filter,
// per-row action wiring, and the safe-only `Plasser` button.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _resetDbSingletonForTests, getDb } from '../src/db/database';
import { initializeDataLayer } from '../src/db/init';
import { mountMasterGapView } from '../src/views/master-gap';
import { createBindersRepo } from '../src/repositories/binders-repo';
import { createBinderSlotsRepo } from '../src/repositories/binder-slots-repo';
import { createCardsRepo } from '../src/repositories/cards-repo';
import { createHoldingsRepo } from '../src/repositories/holdings-repo';
import { createSetsRepo } from '../src/repositories/sets-repo';
import { createWishlistRepo } from '../src/repositories/wishlist-repo';
import { closeAndDelete } from './helpers/fresh-db';
import { makeCard } from './helpers/cards';
import type {
  BinderRecord,
  BinderSlotRecord,
  SetRecord,
  SlotsPerPage,
} from '../src/domain/types';
import type { HoldingInput } from '../src/domain/validators';
import type { PokemonTrackerDB } from '../src/db/database';

const SLOTS_PER_PAGE: SlotsPerPage = 9;

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

function holdingInput(overrides: Partial<HoldingInput> = {}): HoldingInput {
  return {
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
    ...overrides,
  };
}

async function settle(ms = 80): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function makeBinder(db: PokemonTrackerDB): Promise<BinderRecord> {
  return createBindersRepo(db).create({
    name: 'Test binder',
    description: null,
    binderType: null,
    totalPages: 1,
    slotsPerPage: SLOTS_PER_PAGE,
    binderPreset: 'custom',
    completionMode: 'master',
    sourceSetId: null,
  });
}

async function makeSlot(
  db: PokemonTrackerDB,
  binder: BinderRecord,
  overrides: Partial<{
    pageNumber: number;
    slotNumber: number;
    targetCardId: string | null;
    holdingId: string | null;
    status: BinderSlotRecord['status'];
    note: string | null;
  }> = {},
): Promise<BinderSlotRecord> {
  return createBinderSlotsRepo(db).create(
    {
      binderId: binder.id,
      pageNumber: overrides.pageNumber ?? 1,
      slotNumber: overrides.slotNumber ?? 1,
      targetCardId:
        'targetCardId' in overrides
          ? (overrides.targetCardId as string | null)
          : 'base1-4',
      holdingId: overrides.holdingId ?? null,
      status: overrides.status ?? 'wanted',
      note: overrides.note ?? null,
    },
    SLOTS_PER_PAGE,
  );
}

describe('master-gap view (PR 25)', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    document.body.innerHTML = '<div id="content"></div>';
    _resetDbSingletonForTests();
    db = getDb();
    await initializeDataLayer({ db, skipPersistentStorage: true });
    await createSetsRepo(db).upsert(sampleSet);
    await createCardsRepo(db).upsert(
      makeCard('base1-4', { overrides: { name: 'Charizard', number: '4' } }),
    );
    await createCardsRepo(db).upsert(
      makeCard('base1-58', { overrides: { name: 'Pikachu', number: '58' } }),
    );
    window.location.hash = '';
  });

  afterEach(async () => {
    await settle(40);
    document.body.innerHTML = '';
    await closeAndDelete(db);
    _resetDbSingletonForTests();
    window.location.hash = '';
  });

  it('with no binder selected shows empty selector message when DB is empty', async () => {
    window.location.hash = 'master-gap';
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountMasterGapView(root);
    await settle();
    expect(root.textContent).toContain('Ingen permer ennå');
  });

  it('with no binder selected and binders present shows selector + dashboard summary', async () => {
    const binder = await makeBinder(db);
    await makeSlot(db, binder);
    window.location.hash = 'master-gap';
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountMasterGapView(root);
    await settle();
    const list = root.querySelector('.master-gap-view__binder-list');
    expect(list).not.toBeNull();
    expect(list?.querySelectorAll('.master-gap-view__binder-row')).toHaveLength(1);
    const summary = root.querySelector('[data-region="dashboard-summary"]');
    expect(summary).not.toBeNull();
  });

  it('with binder selected renders header + filter strip + table', async () => {
    const binder = await makeBinder(db);
    await makeSlot(db, binder);
    window.location.hash = `master-gap/${binder.id}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountMasterGapView(root);
    await settle();
    expect(root.querySelector('.master-gap-view__binder-title')?.textContent)
      .toBe('Test binder');
    expect(root.querySelectorAll('.master-gap-view__filter')).not.toHaveLength(0);
    expect(root.querySelector('.master-gap-table')).not.toBeNull();
  });

  it('Plasser button is rendered only on owned_unplaced rows', async () => {
    const binder = await makeBinder(db);
    await createHoldingsRepo(db).create(holdingInput());
    await makeSlot(db, binder); // owned_unplaced
    await makeSlot(db, binder, {
      slotNumber: 2,
      targetCardId: 'base1-58',
    }); // missing
    window.location.hash = `master-gap/${binder.id}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountMasterGapView(root);
    await settle();
    const placeButtons = root.querySelectorAll<HTMLButtonElement>(
      '[data-action="place-direct"]',
    );
    expect(placeButtons).toHaveLength(1);
  });

  it('ambiguous_owned shows "Velg holding" instead of "Plasser"', async () => {
    const binder = await makeBinder(db);
    await createHoldingsRepo(db).create(holdingInput({ rawCondition: 'NM' }));
    await createHoldingsRepo(db).create(holdingInput({ rawCondition: 'LP' }));
    await makeSlot(db, binder);
    window.location.hash = `master-gap/${binder.id}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountMasterGapView(root);
    await settle();
    expect(root.querySelector('[data-action="place-direct"]')).toBeNull();
    expect(root.querySelector('[data-action="choose-holding"]')).not.toBeNull();
  });

  it('clicking Plasser assigns the holding and updates the table', async () => {
    const binder = await makeBinder(db);
    const h = await createHoldingsRepo(db).create(holdingInput());
    await makeSlot(db, binder);
    window.location.hash = `master-gap/${binder.id}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountMasterGapView(root);
    await settle();
    const placeBtn = root.querySelector<HTMLButtonElement>(
      '[data-action="place-direct"]',
    );
    expect(placeBtn).not.toBeNull();
    placeBtn?.click();
    await vi.waitFor(async () => {
      const allSlots = await createBinderSlotsRepo(db).listLive();
      expect(allSlots[0]?.holdingId).toBe(h.id);
    });
  });

  it('filter "Mangler" hides non-missing rows', async () => {
    const binder = await makeBinder(db);
    const h = await createHoldingsRepo(db).create(holdingInput());
    await makeSlot(db, binder, {
      pageNumber: 1,
      slotNumber: 1,
      targetCardId: 'base1-4',
      holdingId: h.id,
      status: 'owned',
    });
    await makeSlot(db, binder, {
      pageNumber: 1,
      slotNumber: 2,
      targetCardId: 'base1-58',
    });
    window.location.hash = `master-gap/${binder.id}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountMasterGapView(root);
    await settle();
    expect(root.querySelectorAll('tbody tr')).toHaveLength(2);
    const missingFilter = root.querySelector<HTMLButtonElement>(
      '[data-filter="missing"]',
    );
    missingFilter?.click();
    await settle();
    const rows = root.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.getAttribute('data-status')).toBe('missing');
  });

  it('invalid_variant rows render with the danger severity class', async () => {
    const binder = await makeBinder(db);
    const h = await createHoldingsRepo(db).create(
      holdingInput({ finish: 'normal' }),
    );
    // Create a reverse-holo template slot bound to a normal-finish
    // holding — this is the invalid_variant case.
    const slot = await createBinderSlotsRepo(db).create(
      {
        binderId: binder.id,
        pageNumber: 1,
        slotNumber: 1,
        targetCardId: 'base1-4',
        holdingId: null,
        status: 'wanted',
        note: 'template:reverse_holo',
      },
      SLOTS_PER_PAGE,
    );
    await db.binderSlots.put({ ...slot, holdingId: h.id, status: 'owned' });
    window.location.hash = `master-gap/${binder.id}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountMasterGapView(root);
    await settle();
    const tr = root.querySelector('tr[data-status="invalid_variant"]');
    expect(tr).not.toBeNull();
    expect(tr?.classList.contains('master-gap-row--critical')).toBe(true);
  });

  it('binder selector row navigates to #master-gap/<binderId>', async () => {
    const binder = await makeBinder(db);
    await makeSlot(db, binder);
    window.location.hash = 'master-gap';
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountMasterGapView(root);
    await settle();
    const link = root.querySelector<HTMLButtonElement>(
      '.master-gap-view__binder-name',
    );
    expect(link).not.toBeNull();
    link?.click();
    await settle();
    expect(window.location.hash).toBe(`#master-gap/${binder.id}`);
  });

  it('soft-deleted binder shows "perm finnes ikke"', async () => {
    const binder = await makeBinder(db);
    await createBindersRepo(db).softDelete(binder.id);
    window.location.hash = `master-gap/${binder.id}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountMasterGapView(root);
    await settle();
    expect(root.textContent).toContain('finnes ikke');
  });

  it('wishlist_wanted rows show "Åpne wishlist" button', async () => {
    const binder = await makeBinder(db);
    await createWishlistRepo(db).create({
      cardId: 'base1-4',
      finish: 'normal',
      priority: 'medium',
      targetCondition: null,
      targetPrice: null,
      targetCurrency: null,
      status: 'wanted',
      note: null,
    });
    await makeSlot(db, binder);
    window.location.hash = `master-gap/${binder.id}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountMasterGapView(root);
    await settle();
    expect(
      root.querySelector('tr[data-status="wishlist_wanted"]'),
    ).not.toBeNull();
    expect(root.querySelector('[data-action="open-wishlist"]')).not.toBeNull();
  });
});
