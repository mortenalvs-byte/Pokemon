// PR 27 — master-gap view picks up persisted personal preferences on
// mount and persists toggles asynchronously without reloading the
// report.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _resetDbSingletonForTests, getDb } from '../src/db/database';
import { initializeDataLayer } from '../src/db/init';
import { mountMasterGapView } from '../src/views/master-gap';
import { createBindersRepo } from '../src/repositories/binders-repo';
import { createBinderSlotsRepo } from '../src/repositories/binder-slots-repo';
import { createCardsRepo } from '../src/repositories/cards-repo';
import { createHoldingsRepo } from '../src/repositories/holdings-repo';
import { createSetsRepo } from '../src/repositories/sets-repo';
import { createSettingsRepo } from '../src/repositories/settings-repo';
import { createPersonalPreferencesService } from '../src/services/personal-preferences-service';
import { closeAndDelete } from './helpers/fresh-db';
import { makeCard } from './helpers/cards';
import type {
  BinderRecord,
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

describe('master-gap personal preferences (PR 27)', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    document.body.innerHTML = '<div id="content"></div>';
    _resetDbSingletonForTests();
    db = getDb();
    await initializeDataLayer({ db, skipPersistentStorage: true });
    await createSetsRepo(db).upsert(sampleSet);
    await createCardsRepo(db).upsert(makeCard('base1-4'));
    await createCardsRepo(db).upsert(makeCard('base1-58'));
    window.location.hash = '';
  });

  afterEach(async () => {
    await settle(20);
    document.body.innerHTML = '';
    await closeAndDelete(db);
    _resetDbSingletonForTests();
    window.location.hash = '';
  });

  it('seeds density from stored preferences on mount', async () => {
    const svc = createPersonalPreferencesService(createSettingsRepo(db));
    await svc.updatePreferences({ masterGapDensity: 'comfortable' });

    const binder = await makeBinder(db);
    await createBinderSlotsRepo(db).create(
      {
        binderId: binder.id,
        pageNumber: 1,
        slotNumber: 1,
        targetCardId: 'base1-4',
        holdingId: null,
        status: 'wanted',
        note: null,
      },
      SLOTS_PER_PAGE,
    );

    window.location.hash = `master-gap/${binder.id}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountMasterGapView(root);
    await vi.waitFor(() => {
      const table = root.querySelector('.master-gap-table');
      expect(
        table?.classList.contains('master-gap-table--comfortable'),
      ).toBe(true);
    });
  });

  it('seeds hideComplete from stored preferences', async () => {
    const svc = createPersonalPreferencesService(createSettingsRepo(db));
    await svc.updatePreferences({ masterGapHideComplete: true });

    const binder = await makeBinder(db);
    const h = await createHoldingsRepo(db).create(holdingInput());
    await createBinderSlotsRepo(db).create(
      {
        binderId: binder.id,
        pageNumber: 1,
        slotNumber: 1,
        targetCardId: 'base1-4',
        holdingId: h.id,
        status: 'owned',
        note: null,
      },
      SLOTS_PER_PAGE,
    );
    await createBinderSlotsRepo(db).create(
      {
        binderId: binder.id,
        pageNumber: 1,
        slotNumber: 2,
        targetCardId: 'base1-58',
        holdingId: null,
        status: 'wanted',
        note: null,
      },
      SLOTS_PER_PAGE,
    );

    window.location.hash = `master-gap/${binder.id}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountMasterGapView(root);
    await vi.waitFor(() => {
      const rows = root.querySelectorAll('tbody tr');
      // hideComplete=true → only the missing row should be visible.
      expect(rows).toHaveLength(1);
      expect(rows[0]?.getAttribute('data-status')).toBe('missing');
    });
  });

  it('seeds default filter from stored preferences', async () => {
    const svc = createPersonalPreferencesService(createSettingsRepo(db));
    await svc.updatePreferences({ masterGapDefaultFilter: 'missing' });

    const binder = await makeBinder(db);
    const h = await createHoldingsRepo(db).create(holdingInput());
    await createBinderSlotsRepo(db).create(
      {
        binderId: binder.id,
        pageNumber: 1,
        slotNumber: 1,
        targetCardId: 'base1-4',
        holdingId: h.id,
        status: 'owned',
        note: null,
      },
      SLOTS_PER_PAGE,
    );
    await createBinderSlotsRepo(db).create(
      {
        binderId: binder.id,
        pageNumber: 1,
        slotNumber: 2,
        targetCardId: 'base1-58',
        holdingId: null,
        status: 'wanted',
        note: null,
      },
      SLOTS_PER_PAGE,
    );

    window.location.hash = `master-gap/${binder.id}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountMasterGapView(root);
    await vi.waitFor(() => {
      const active = root.querySelector(
        '.master-gap-view__filter--active',
      );
      expect(active?.getAttribute('data-filter')).toBe('missing');
    });
  });

  it('density toggle persists the new density', async () => {
    const binder = await makeBinder(db);
    await createBinderSlotsRepo(db).create(
      {
        binderId: binder.id,
        pageNumber: 1,
        slotNumber: 1,
        targetCardId: 'base1-4',
        holdingId: null,
        status: 'wanted',
        note: null,
      },
      SLOTS_PER_PAGE,
    );
    window.location.hash = `master-gap/${binder.id}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountMasterGapView(root);
    await settle(160);
    const toggle = root.querySelector<HTMLButtonElement>(
      '[data-action="toggle-density"]',
    );
    toggle?.click();
    await vi.waitFor(async () => {
      const svc = createPersonalPreferencesService(createSettingsRepo(db));
      const prefs = await svc.getPreferences();
      expect(prefs.masterGapDensity).toBe('comfortable');
    });
  });

  it('hideComplete toggle persists the new value', async () => {
    const binder = await makeBinder(db);
    await createBinderSlotsRepo(db).create(
      {
        binderId: binder.id,
        pageNumber: 1,
        slotNumber: 1,
        targetCardId: 'base1-4',
        holdingId: null,
        status: 'wanted',
        note: null,
      },
      SLOTS_PER_PAGE,
    );
    window.location.hash = `master-gap/${binder.id}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountMasterGapView(root);
    await settle(160);
    const toggle = root.querySelector<HTMLButtonElement>(
      '[data-action="toggle-hide-complete"]',
    );
    toggle?.click();
    await vi.waitFor(async () => {
      const svc = createPersonalPreferencesService(createSettingsRepo(db));
      const prefs = await svc.getPreferences();
      expect(prefs.masterGapHideComplete).toBe(true);
    });
  });

  it('onlyActionable toggle persists the new value', async () => {
    const binder = await makeBinder(db);
    await createBinderSlotsRepo(db).create(
      {
        binderId: binder.id,
        pageNumber: 1,
        slotNumber: 1,
        targetCardId: 'base1-4',
        holdingId: null,
        status: 'wanted',
        note: null,
      },
      SLOTS_PER_PAGE,
    );
    window.location.hash = `master-gap/${binder.id}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountMasterGapView(root);
    await settle(160);
    const toggle = root.querySelector<HTMLButtonElement>(
      '[data-action="toggle-only-actionable"]',
    );
    toggle?.click();
    await vi.waitFor(async () => {
      const svc = createPersonalPreferencesService(createSettingsRepo(db));
      const prefs = await svc.getPreferences();
      expect(prefs.masterGapOnlyActionable).toBe(true);
    });
  });

  it('filter button persists the new filter', async () => {
    const binder = await makeBinder(db);
    await createBinderSlotsRepo(db).create(
      {
        binderId: binder.id,
        pageNumber: 1,
        slotNumber: 1,
        targetCardId: 'base1-4',
        holdingId: null,
        status: 'wanted',
        note: null,
      },
      SLOTS_PER_PAGE,
    );
    window.location.hash = `master-gap/${binder.id}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountMasterGapView(root);
    await settle(160);
    const filterBtn = root.querySelector<HTMLButtonElement>(
      '[data-filter="missing"]',
    );
    filterBtn?.click();
    await vi.waitFor(async () => {
      const svc = createPersonalPreferencesService(createSettingsRepo(db));
      const prefs = await svc.getPreferences();
      expect(prefs.masterGapDefaultFilter).toBe('missing');
    });
  });

  it('density toggle does NOT call the master-set-gap service again', async () => {
    const binder = await makeBinder(db);
    await createBinderSlotsRepo(db).create(
      {
        binderId: binder.id,
        pageNumber: 1,
        slotNumber: 1,
        targetCardId: 'base1-4',
        holdingId: null,
        status: 'wanted',
        note: null,
      },
      SLOTS_PER_PAGE,
    );
    window.location.hash = `master-gap/${binder.id}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountMasterGapView(root);
    await settle(160);
    // Spy AFTER the first render so the initial fetch doesn't count.
    const spy = vi.spyOn(createBinderSlotsRepo(db), 'listLive');
    const baseline = spy.mock.calls.length;
    const toggle = root.querySelector<HTMLButtonElement>(
      '[data-action="toggle-density"]',
    );
    toggle?.click();
    await settle(120);
    expect(spy.mock.calls.length).toBe(baseline);
    spy.mockRestore();
  });

  it('failed preference save does NOT break the table', async () => {
    const binder = await makeBinder(db);
    await createBinderSlotsRepo(db).create(
      {
        binderId: binder.id,
        pageNumber: 1,
        slotNumber: 1,
        targetCardId: 'base1-4',
        holdingId: null,
        status: 'wanted',
        note: null,
      },
      SLOTS_PER_PAGE,
    );
    window.location.hash = `master-gap/${binder.id}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountMasterGapView(root);
    await settle(160);
    // Close DB → next persistMasterGapPreference will throw inside;
    // it should be swallowed and the table must still be visible.
    db.close();
    const toggle = root.querySelector<HTMLButtonElement>(
      '[data-action="toggle-density"]',
    );
    toggle?.click();
    await settle(120);
    // Table is still rendered.
    expect(root.querySelector('.master-gap-table')).not.toBeNull();
  });

  it('renders preferences feedback region for write failures', async () => {
    const binder = await makeBinder(db);
    await createBinderSlotsRepo(db).create(
      {
        binderId: binder.id,
        pageNumber: 1,
        slotNumber: 1,
        targetCardId: 'base1-4',
        holdingId: null,
        status: 'wanted',
        note: null,
      },
      SLOTS_PER_PAGE,
    );
    window.location.hash = `master-gap/${binder.id}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountMasterGapView(root);
    await settle(160);
    expect(
      root.querySelector('[data-region="master-gap-preferences-feedback"]'),
    ).not.toBeNull();
  });
});
