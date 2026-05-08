// PR 26 — master-gap desktop polish: table toolbar, density toggle,
// hide-complete, only-actionable, composition with status filter,
// pagination preserved, row actions intact in compact mode.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _resetDbSingletonForTests, getDb } from '../src/db/database';
import { initializeDataLayer } from '../src/db/init';
import { mountMasterGapView } from '../src/views/master-gap';
import { createBindersRepo } from '../src/repositories/binders-repo';
import { createBinderSlotsRepo } from '../src/repositories/binder-slots-repo';
import { createCardsRepo } from '../src/repositories/cards-repo';
import { createHoldingsRepo } from '../src/repositories/holdings-repo';
import { createSetsRepo } from '../src/repositories/sets-repo';
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
    totalPages: 8,
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

describe('master-gap desktop polish (PR 26)', () => {
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
    await settle(20);
    document.body.innerHTML = '';
    await closeAndDelete(db);
    _resetDbSingletonForTests();
    window.location.hash = '';
  });

  it('renders the sticky table toolbar', async () => {
    const binder = await makeBinder(db);
    await makeSlot(db, binder);
    window.location.hash = `master-gap/${binder.id}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountMasterGapView(root);
    await settle();
    expect(root.querySelector('[data-region="table-toolbar"]')).not.toBeNull();
  });

  it('density default is compact', async () => {
    const binder = await makeBinder(db);
    await makeSlot(db, binder);
    window.location.hash = `master-gap/${binder.id}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountMasterGapView(root);
    await settle();
    const table = root.querySelector<HTMLTableElement>('.master-gap-table');
    expect(table?.classList.contains('master-gap-table--compact')).toBe(true);
  });

  it('density toggle flips the table class', async () => {
    const binder = await makeBinder(db);
    await makeSlot(db, binder);
    window.location.hash = `master-gap/${binder.id}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountMasterGapView(root);
    await settle();
    const toggle = root.querySelector<HTMLButtonElement>(
      '[data-action="toggle-density"]',
    );
    expect(toggle).not.toBeNull();
    toggle?.click();
    await settle();
    const table = root.querySelector<HTMLTableElement>('.master-gap-table');
    expect(table?.classList.contains('master-gap-table--comfortable')).toBe(true);
    expect(table?.classList.contains('master-gap-table--compact')).toBe(false);
  });

  it('density toggle does not reload the report', async () => {
    const binder = await makeBinder(db);
    await makeSlot(db, binder);
    window.location.hash = `master-gap/${binder.id}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountMasterGapView(root);
    await settle();
    // Spy on the slow listLive paths the gap service uses. After the
    // initial mount and one settle, no further DB hits should happen
    // when we just flip density.
    const slotsLiveSpy = vi.spyOn(
      createBinderSlotsRepo(db),
      'listLive',
    );
    const baseline = slotsLiveSpy.mock.calls.length;
    const toggle = root.querySelector<HTMLButtonElement>(
      '[data-action="toggle-density"]',
    );
    toggle?.click();
    await settle();
    // The view re-renders from the cached report; no new repo reads.
    expect(slotsLiveSpy.mock.calls.length).toBe(baseline);
    slotsLiveSpy.mockRestore();
  });

  it('hide complete hides complete rows', async () => {
    const binder = await makeBinder(db);
    const h = await createHoldingsRepo(db).create(holdingInput());
    // Slot 1: complete
    await makeSlot(db, binder, {
      pageNumber: 1,
      slotNumber: 1,
      targetCardId: 'base1-4',
      holdingId: h.id,
      status: 'owned',
    });
    // Slot 2: missing
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
    const hideBtn = root.querySelector<HTMLButtonElement>(
      '[data-action="toggle-hide-complete"]',
    );
    hideBtn?.click();
    await settle();
    const rows = root.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.getAttribute('data-status')).toBe('missing');
  });

  it('hide complete resets pagination to page 0', async () => {
    const binder = await makeBinder(db);
    // 60 missing slots → spans 2 pages (50 per page)
    for (let i = 1; i <= 60; i += 1) {
      await makeSlot(db, binder, {
        pageNumber: Math.ceil(i / SLOTS_PER_PAGE),
        slotNumber: ((i - 1) % SLOTS_PER_PAGE) + 1,
        targetCardId: i % 2 === 0 ? 'base1-4' : 'base1-58',
      });
    }
    window.location.hash = `master-gap/${binder.id}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountMasterGapView(root);
    await settle();
    // Move to page 1.
    const next = root.querySelector<HTMLButtonElement>(
      '[data-action="next-page"]',
    );
    next?.click();
    await settle();
    expect(
      root.querySelector('.master-gap-view__counts')?.textContent,
    ).toContain('Side 2');
    // Now toggle hide-complete; page must reset.
    const hide = root.querySelector<HTMLButtonElement>(
      '[data-action="toggle-hide-complete"]',
    );
    hide?.click();
    await settle();
    expect(
      root.querySelector('.master-gap-view__counts')?.textContent,
    ).toContain('Side 1');
  });

  it('only actionable hides complete and blank rows', async () => {
    const binder = await makeBinder(db);
    const h = await createHoldingsRepo(db).create(holdingInput());
    // Complete
    await makeSlot(db, binder, {
      pageNumber: 1,
      slotNumber: 1,
      holdingId: h.id,
      status: 'owned',
    });
    // Blank
    await makeSlot(db, binder, {
      pageNumber: 1,
      slotNumber: 2,
      targetCardId: null,
      status: 'empty',
    });
    // Missing
    await makeSlot(db, binder, {
      pageNumber: 1,
      slotNumber: 3,
      targetCardId: 'base1-58',
    });
    window.location.hash = `master-gap/${binder.id}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountMasterGapView(root);
    await settle();
    const onlyAct = root.querySelector<HTMLButtonElement>(
      '[data-action="toggle-only-actionable"]',
    );
    onlyAct?.click();
    await settle();
    const rows = root.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.getAttribute('data-status')).toBe('missing');
  });

  it('only actionable resets pagination to page 0', async () => {
    const binder = await makeBinder(db);
    for (let i = 1; i <= 60; i += 1) {
      await makeSlot(db, binder, {
        pageNumber: Math.ceil(i / SLOTS_PER_PAGE),
        slotNumber: ((i - 1) % SLOTS_PER_PAGE) + 1,
        targetCardId: i % 2 === 0 ? 'base1-4' : 'base1-58',
      });
    }
    window.location.hash = `master-gap/${binder.id}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountMasterGapView(root);
    await settle();
    const next = root.querySelector<HTMLButtonElement>(
      '[data-action="next-page"]',
    );
    next?.click();
    await settle();
    const onlyAct = root.querySelector<HTMLButtonElement>(
      '[data-action="toggle-only-actionable"]',
    );
    onlyAct?.click();
    await settle();
    expect(
      root.querySelector('.master-gap-view__counts')?.textContent,
    ).toContain('Side 1');
  });

  it('status filter + hideComplete compose correctly', async () => {
    const binder = await makeBinder(db);
    const h = await createHoldingsRepo(db).create(holdingInput());
    await makeSlot(db, binder, {
      pageNumber: 1,
      slotNumber: 1,
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
    // Status filter "Mangler" + hideComplete is redundant but legal —
    // both should still leave only the missing row.
    root.querySelector<HTMLButtonElement>('[data-filter="missing"]')?.click();
    await settle();
    root
      .querySelector<HTMLButtonElement>('[data-action="toggle-hide-complete"]')
      ?.click();
    await settle();
    const rows = root.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.getAttribute('data-status')).toBe('missing');
  });

  it('status filter + onlyActionable compose correctly', async () => {
    const binder = await makeBinder(db);
    const h = await createHoldingsRepo(db).create(holdingInput());
    await makeSlot(db, binder, {
      pageNumber: 1,
      slotNumber: 1,
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
    // Filter "Alle" + onlyActionable → drops the complete row.
    root
      .querySelector<HTMLButtonElement>('[data-action="toggle-only-actionable"]')
      ?.click();
    await settle();
    const rows = root.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.getAttribute('data-status')).toBe('missing');
  });

  it('hideComplete + onlyActionable both on is the same as just onlyActionable', async () => {
    // Idempotency: onlyActionable strictly dominates hideComplete
    // (drops complete + blank), so combining them must still leave
    // only actionable rows.
    const binder = await makeBinder(db);
    const h = await createHoldingsRepo(db).create(holdingInput());
    await makeSlot(db, binder, {
      pageNumber: 1,
      slotNumber: 1,
      holdingId: h.id,
      status: 'owned',
    });
    await makeSlot(db, binder, {
      pageNumber: 1,
      slotNumber: 2,
      targetCardId: null,
      status: 'empty',
    });
    await makeSlot(db, binder, {
      pageNumber: 1,
      slotNumber: 3,
      targetCardId: 'base1-58',
    });
    window.location.hash = `master-gap/${binder.id}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountMasterGapView(root);
    await settle();
    root
      .querySelector<HTMLButtonElement>('[data-action="toggle-hide-complete"]')
      ?.click();
    await settle();
    root
      .querySelector<HTMLButtonElement>('[data-action="toggle-only-actionable"]')
      ?.click();
    await settle();
    const rows = root.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.getAttribute('data-status')).toBe('missing');
  });

  it('pagination still works after density toggle', async () => {
    const binder = await makeBinder(db);
    for (let i = 1; i <= 60; i += 1) {
      await makeSlot(db, binder, {
        pageNumber: Math.ceil(i / SLOTS_PER_PAGE),
        slotNumber: ((i - 1) % SLOTS_PER_PAGE) + 1,
        targetCardId: i % 2 === 0 ? 'base1-4' : 'base1-58',
      });
    }
    window.location.hash = `master-gap/${binder.id}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountMasterGapView(root);
    await settle();
    root
      .querySelector<HTMLButtonElement>('[data-action="toggle-density"]')
      ?.click();
    await settle();
    // Density did not move us off page 1.
    expect(
      root.querySelector('.master-gap-view__counts')?.textContent,
    ).toContain('Side 1');
    root
      .querySelector<HTMLButtonElement>('[data-action="next-page"]')
      ?.click();
    await settle();
    expect(
      root.querySelector('.master-gap-view__counts')?.textContent,
    ).toContain('Side 2');
  });

  it('row actions still render in compact mode', async () => {
    const binder = await makeBinder(db);
    await createHoldingsRepo(db).create(holdingInput());
    await makeSlot(db, binder); // owned_unplaced
    window.location.hash = `master-gap/${binder.id}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountMasterGapView(root);
    await settle();
    expect(root.querySelector('[data-action="open-card"]')).not.toBeNull();
    expect(root.querySelector('[data-action="go-to-slot"]')).not.toBeNull();
    expect(root.querySelector('[data-action="place-direct"]')).not.toBeNull();
  });

  it('Plasser button only appears for owned_unplaced with canPlaceDirectly', async () => {
    const binder = await makeBinder(db);
    // Two matching unplaced holdings → ambiguous_owned → no Plasser
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

  it('Velg holding still appears for ambiguous_owned rows', async () => {
    const binder = await makeBinder(db);
    await createHoldingsRepo(db).create(holdingInput({ rawCondition: 'NM' }));
    await createHoldingsRepo(db).create(holdingInput({ rawCondition: 'LP' }));
    await makeSlot(db, binder);
    window.location.hash = `master-gap/${binder.id}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountMasterGapView(root);
    await settle();
    expect(root.querySelector('[data-action="choose-holding"]')).not.toBeNull();
  });
});
