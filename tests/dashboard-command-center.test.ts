// PR 27 — dashboard "Arbeidskø" command center + personal workspace
// summary. Driven by the real DB so the dashboard service +
// preferences service paths get exercised.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _resetDbSingletonForTests, getDb } from '../src/db/database';
import { initializeDataLayer } from '../src/db/init';
import { mountDashboardView } from '../src/views/dashboard';
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

describe('dashboard command center + workspace summary (PR 27)', () => {
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

  // -- structure ------------------------------------------------------
  it('renders the Arbeidskø panel and heading', async () => {
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountDashboardView(root);
    await vi.waitFor(() => {
      const panel = root.querySelector('[data-region="command-center"]');
      expect(panel).not.toBeNull();
      expect(
        panel?.querySelector('.dashboard-command-center__heading')?.textContent,
      ).toBe('Arbeidskø');
    });
  });

  it('renders the command-center list region', async () => {
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountDashboardView(root);
    await vi.waitFor(() => {
      expect(
        root.querySelector('[data-region="command-center-list"]'),
      ).not.toBeNull();
    });
  });

  // -- content driven by data ----------------------------------------
  it('renders a critical command-center item when invalid slots exist', async () => {
    const binder = await makeBinder(db);
    // Force one invalid_assignment row by binding a wrong-card
    // holding to a slot via a low-level put.
    const wrongHolding = await createHoldingsRepo(db).create(
      holdingInput({ cardId: 'base1-58' }),
    );
    const slot = await createBinderSlotsRepo(db).create(
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
    await db.binderSlots.put({ ...slot, holdingId: wrongHolding.id });
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountDashboardView(root);
    await vi.waitFor(() => {
      const item = root.querySelector('[data-kind="fix_invalid_slots"]');
      expect(item).not.toBeNull();
      expect(item?.getAttribute('data-severity')).toBe('critical');
    });
  });

  it('renders a warning command-center item for owned-unplaced', async () => {
    const binder = await makeBinder(db);
    await createHoldingsRepo(db).create(holdingInput());
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
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountDashboardView(root);
    await vi.waitFor(() => {
      const item = root.querySelector('[data-kind="place_owned_cards"]');
      expect(item).not.toBeNull();
    });
  });

  it('clicking a command-center item with hash target navigates', async () => {
    const binder = await makeBinder(db);
    await createHoldingsRepo(db).create(holdingInput());
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
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountDashboardView(root);
    let action: HTMLButtonElement | null = null;
    await vi.waitFor(() => {
      action = root.querySelector<HTMLButtonElement>(
        '[data-kind="place_owned_cards"] [data-action="command-center-action"]',
      );
      expect(action).not.toBeNull();
    });
    action!.click();
    expect(window.location.hash).toBe('#master-gap');
  });

  it('shows all-clear item when nothing is actionable and showAllClear=true', async () => {
    // Seed a recent backup so the dashboard's "backup_never" critical
    // action does not fire — we want to exercise the empty-list path.
    await db.appMeta.put({
      key: 'lastBackupAt',
      value: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountDashboardView(root);
    await vi.waitFor(() => {
      const item = root.querySelector('[data-kind="all_clear"]');
      expect(item).not.toBeNull();
      expect(item?.getAttribute('data-severity')).toBe('success');
    });
  });

  it('hides all-clear when showAllClear=false', async () => {
    await db.appMeta.put({
      key: 'lastBackupAt',
      value: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await createPersonalPreferencesService(
      createSettingsRepo(db),
    ).updatePreferences({ commandCenterShowAllClear: false });
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountDashboardView(root);
    await settle(200);
    expect(root.querySelector('[data-kind="all_clear"]')).toBeNull();
    // The list should show the empty-state placeholder instead.
    expect(
      root.querySelector('.dashboard-command-center__empty'),
    ).not.toBeNull();
  });

  // -- personal workspace summary ------------------------------------
  it('renders personal workspace summary when preference is on', async () => {
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountDashboardView(root);
    await vi.waitFor(() => {
      const slot = root.querySelector(
        '[data-region="personal-workspace-summary"]',
      );
      expect(slot).not.toBeNull();
    });
  });

  it('hides personal workspace summary when preference is off', async () => {
    await createPersonalPreferencesService(
      createSettingsRepo(db),
    ).updatePreferences({ showPersonalWorkspaceSummary: false });
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountDashboardView(root);
    await settle(180);
    expect(
      root.querySelector('[data-region="personal-workspace-summary"]'),
    ).toBeNull();
  });

  it('personal workspace summary shows the configured app name', async () => {
    await createPersonalPreferencesService(
      createSettingsRepo(db),
    ).updatePreferences({ appDisplayName: 'Mortens samling' });
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountDashboardView(root);
    await vi.waitFor(() => {
      const heading = root.querySelector(
        '.personal-workspace-summary__heading',
      );
      expect(heading?.textContent).toBe('Mortens samling');
    });
  });

  // -- error survival -------------------------------------------------
  it('survives a master-gap service throw and still renders the rest of the dashboard', async () => {
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    db.close();
    mountDashboardView(root);
    await settle(200);
    // Either the dashboard's top-level error panel OR the master-gap
    // error chip renders. Either way: no throw.
    const dashErr = root.querySelector('[data-region="error"]');
    const masterErr = root.querySelector('[data-region="master-gap-error"]');
    expect(dashErr !== null || masterErr !== null).toBe(true);
  });

  // -- max items respected -------------------------------------------
  it('respects commandCenterMaxItems for non-critical items', async () => {
    await createPersonalPreferencesService(
      createSettingsRepo(db),
    ).updatePreferences({ commandCenterMaxItems: 3 });

    // Build several non-critical signals: owned_unplaced + missing
    // by adding a binder with two missing target slots and one
    // owned_unplaced. Plus a missing-condition holding row.
    const binder = await makeBinder(db);
    await createHoldingsRepo(db).create(holdingInput()); // owned, not placed
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
    await createHoldingsRepo(db).create(
      holdingInput({
        cardId: 'base1-58',
        rawCondition: 'UNKNOWN',
      }),
    );

    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountDashboardView(root);
    await vi.waitFor(() => {
      const items = root.querySelectorAll(
        '.dashboard-command-center__item',
      );
      expect(items.length).toBeGreaterThan(0);
      expect(items.length).toBeLessThanOrEqual(3);
    });
  });
});
