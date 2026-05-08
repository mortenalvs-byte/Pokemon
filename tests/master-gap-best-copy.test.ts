// PR 28 — master-gap view + service integration with best-copy.

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

async function setupAmbiguousScenario(
  db: PokemonTrackerDB,
  variant: 'recommended' | 'manual',
): Promise<{ binder: BinderRecord; nmHoldingId: string; lpHoldingId: string }> {
  const binder = await makeBinder(db);
  const repo = createHoldingsRepo(db);
  const nm = await repo.create(holdingInput({ rawCondition: 'NM' }));
  // Manual variant: two NM holdings (same score → tied top → manual_required)
  // Recommended variant: NM + LP (NM clearly wins)
  const lp = await repo.create(
    holdingInput({
      rawCondition: variant === 'recommended' ? 'LP' : 'NM',
      // Slightly different cert/source so they're not exact dupes,
      // even though that doesn't affect score.
      note: variant === 'recommended' ? 'lp-copy' : 'second-nm',
    }),
  );
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
  return { binder, nmHoldingId: nm.id, lpHoldingId: lp.id };
}

describe('master-gap best-copy integration (PR 28)', () => {
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

  // 1
  it('ambiguous_owned row attaches a bestCopyRecommendation', async () => {
    const { binder } = await setupAmbiguousScenario(db, 'recommended');
    window.location.hash = `master-gap/${binder.id}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountMasterGapView(root);
    await vi.waitFor(() => {
      const row = root.querySelector('tr[data-status="ambiguous_owned"]');
      expect(row).not.toBeNull();
      const overlay = row?.querySelector('[data-region="best-copy-recommendation"]');
      expect(overlay).not.toBeNull();
    });
  });

  // 2
  it('recommended ambiguous row shows Plasser anbefalt', async () => {
    const { binder } = await setupAmbiguousScenario(db, 'recommended');
    window.location.hash = `master-gap/${binder.id}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountMasterGapView(root);
    await vi.waitFor(() => {
      expect(
        root.querySelector('[data-action="place-recommended"]'),
      ).not.toBeNull();
    });
  });

  // 3
  it('manual_required row hides Plasser anbefalt', async () => {
    const { binder } = await setupAmbiguousScenario(db, 'manual');
    window.location.hash = `master-gap/${binder.id}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountMasterGapView(root);
    await settle(160);
    expect(
      root.querySelector('[data-action="place-recommended"]'),
    ).toBeNull();
  });

  // 4
  it('manual_required row still shows Velg holding', async () => {
    const { binder } = await setupAmbiguousScenario(db, 'manual');
    window.location.hash = `master-gap/${binder.id}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountMasterGapView(root);
    await vi.waitFor(() => {
      expect(
        root.querySelector('[data-action="choose-holding"]'),
      ).not.toBeNull();
    });
  });

  // 5
  it('missing rows do NOT get a recommendation overlay', async () => {
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
    const row = root.querySelector('tr[data-status="missing"]');
    expect(row).not.toBeNull();
    expect(
      row?.querySelector('[data-region="best-copy-recommendation"]'),
    ).toBeNull();
  });

  // 6
  it('complete rows do NOT get a recommendation overlay', async () => {
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
    window.location.hash = `master-gap/${binder.id}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountMasterGapView(root);
    await settle(160);
    const row = root.querySelector('tr[data-status="complete"]');
    expect(
      row?.querySelector('[data-region="best-copy-recommendation"]'),
    ).toBeNull();
  });

  // 7
  it('owned_unplaced (single safe candidate) does NOT get a recommendation overlay', async () => {
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
    window.location.hash = `master-gap/${binder.id}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountMasterGapView(root);
    await settle(160);
    const row = root.querySelector('tr[data-status="owned_unplaced"]');
    expect(
      row?.querySelector('[data-region="best-copy-recommendation"]'),
    ).toBeNull();
  });

  // 8 + 9
  it('clicking Plasser anbefalt assigns the recommended holding and refreshes the report', async () => {
    const { binder, nmHoldingId } = await setupAmbiguousScenario(
      db,
      'recommended',
    );
    window.location.hash = `master-gap/${binder.id}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountMasterGapView(root);
    let placeBtn: HTMLButtonElement | null = null;
    await vi.waitFor(() => {
      placeBtn = root.querySelector<HTMLButtonElement>(
        '[data-action="place-recommended"]',
      );
      expect(placeBtn).not.toBeNull();
    });
    placeBtn!.click();
    await vi.waitFor(async () => {
      const liveSlots = await createBinderSlotsRepo(db).listLive();
      const slot = liveSlots[0];
      expect(slot?.holdingId).toBe(nmHoldingId);
      expect(slot?.status).toBe('owned');
    });
  });

  // 11 — recommendation reasons render
  it('recommendation reasons render in the overlay', async () => {
    const { binder } = await setupAmbiguousScenario(db, 'recommended');
    window.location.hash = `master-gap/${binder.id}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountMasterGapView(root);
    await vi.waitFor(() => {
      const list = root.querySelector(
        '.master-gap-row__recommendation-reasons',
      );
      expect(list).not.toBeNull();
      // At least one reason listed.
      expect(list?.querySelectorAll('li').length).toBeGreaterThan(0);
    });
  });

  // 12 — compact density still renders recommendation controls
  it('compact density still renders the Plasser anbefalt button', async () => {
    const { binder } = await setupAmbiguousScenario(db, 'recommended');
    window.location.hash = `master-gap/${binder.id}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountMasterGapView(root);
    await settle(160);
    // density default is compact; just confirm button exists.
    const table = root.querySelector('.master-gap-table');
    expect(table?.classList.contains('master-gap-table--compact')).toBe(true);
    expect(
      root.querySelector('[data-action="place-recommended"]'),
    ).not.toBeNull();
  });

  // 13 — onlyActionable still includes ambiguous rows with recommendation
  it('onlyActionable filter still includes ambiguous rows', async () => {
    const { binder } = await setupAmbiguousScenario(db, 'recommended');
    window.location.hash = `master-gap/${binder.id}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountMasterGapView(root);
    await settle(160);
    root
      .querySelector<HTMLButtonElement>('[data-action="toggle-only-actionable"]')
      ?.click();
    await settle(80);
    expect(
      root.querySelector('tr[data-status="ambiguous_owned"]'),
    ).not.toBeNull();
  });

  // 14 — hideComplete does not hide ambiguous rows
  it('hideComplete does not hide ambiguous recommendation rows', async () => {
    const { binder } = await setupAmbiguousScenario(db, 'recommended');
    window.location.hash = `master-gap/${binder.id}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountMasterGapView(root);
    await settle(160);
    root
      .querySelector<HTMLButtonElement>('[data-action="toggle-hide-complete"]')
      ?.click();
    await settle(80);
    expect(
      root.querySelector('tr[data-status="ambiguous_owned"]'),
    ).not.toBeNull();
  });

  // 15
  it('bulk button is enabled when safe recommendations exist', async () => {
    const { binder } = await setupAmbiguousScenario(db, 'recommended');
    window.location.hash = `master-gap/${binder.id}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountMasterGapView(root);
    await vi.waitFor(() => {
      const btn = root.querySelector<HTMLButtonElement>(
        '[data-action="place-all-recommended"]',
      );
      expect(btn).not.toBeNull();
      expect(btn?.disabled).toBe(false);
    });
  });

  // 16
  it('bulk button is disabled when no safe recommendations exist', async () => {
    const { binder } = await setupAmbiguousScenario(db, 'manual');
    window.location.hash = `master-gap/${binder.id}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountMasterGapView(root);
    await vi.waitFor(() => {
      const btn = root.querySelector<HTMLButtonElement>(
        '[data-action="place-all-recommended"]',
      );
      expect(btn).not.toBeNull();
      expect(btn?.disabled).toBe(true);
    });
  });

  // 17
  it('confirmation dialog opens for bulk placement', async () => {
    const { binder } = await setupAmbiguousScenario(db, 'recommended');
    window.location.hash = `master-gap/${binder.id}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountMasterGapView(root);
    await settle(160);
    root
      .querySelector<HTMLButtonElement>('[data-action="place-all-recommended"]')
      ?.click();
    await vi.waitFor(() => {
      const dialog = document.querySelector('dialog.app-dialog');
      expect(dialog).not.toBeNull();
      expect(
        dialog?.querySelector('[data-action="bulk-confirm"]'),
      ).not.toBeNull();
    });
  });

  // 18
  it('result summary renders after bulk placement', async () => {
    const { binder, nmHoldingId } = await setupAmbiguousScenario(
      db,
      'recommended',
    );
    window.location.hash = `master-gap/${binder.id}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountMasterGapView(root);
    await settle(160);
    root
      .querySelector<HTMLButtonElement>('[data-action="place-all-recommended"]')
      ?.click();
    await vi.waitFor(() => {
      expect(
        document.querySelector('[data-action="bulk-confirm"]'),
      ).not.toBeNull();
    });
    document
      .querySelector<HTMLButtonElement>('[data-action="bulk-confirm"]')
      ?.click();
    await vi.waitFor(async () => {
      const live = await createBinderSlotsRepo(db).listLive();
      const slot = live[0];
      expect(slot?.holdingId).toBe(nmHoldingId);
    });
    // Summary line eventually renders in the dedicated slot.
    await vi.waitFor(() => {
      const line = root.querySelector(
        '[data-region="bulk-recommended-summary-line"]',
      );
      expect(line?.textContent).toContain('plassert');
    });
  });
});
