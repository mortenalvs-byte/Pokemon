// PR 26 — dashboard workspace polish: workspace header, next-best-
// action helper inside Master Set Progress card, lazy load survives,
// existing card surface intact.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _resetDbSingletonForTests, getDb } from '../src/db/database';
import { initializeDataLayer } from '../src/db/init';
import {
  getMasterGapNextAction,
  mountDashboardView,
} from '../src/views/dashboard';
import { createBindersRepo } from '../src/repositories/binders-repo';
import { createCardsRepo } from '../src/repositories/cards-repo';
import { createSetsRepo } from '../src/repositories/sets-repo';
import { closeAndDelete } from './helpers/fresh-db';
import { makeCard } from './helpers/cards';
import type {
  MasterGapDashboardSummary,
} from '../src/domain/master-set-gap';
import type { SetRecord, SlotsPerPage } from '../src/domain/types';
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

async function settle(ms = 80): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function summary(
  overrides: Partial<MasterGapDashboardSummary> = {},
): MasterGapDashboardSummary {
  return {
    generatedAt: '2026-05-08T00:00:00.000Z',
    binderCount: 1,
    totalTargetSlots: 0,
    complete: 0,
    missing: 0,
    ownedUnplaced: 0,
    ambiguousOwned: 0,
    wishlistWanted: 0,
    wishlistOrdered: 0,
    inLotUnmaterialized: 0,
    invalidCount: 0,
    canPlaceDirectlyCount: 0,
    recommendedAmbiguousCount: 0,
    manualAmbiguousCount: 0,
    averageCompletionPercent: 0,
    closestBinder: null,
    weakestBinder: null,
    binders: [],
    ...overrides,
  };
}

describe('dashboard workspace polish (PR 26)', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    document.body.innerHTML = '<div id="content"></div>';
    _resetDbSingletonForTests();
    db = getDb();
    await initializeDataLayer({ db, skipPersistentStorage: true });
    await createSetsRepo(db).upsert(sampleSet);
    await createCardsRepo(db).upsert(makeCard('base1-4'));
    window.location.hash = '';
  });

  afterEach(async () => {
    await settle(20);
    document.body.innerHTML = '';
    await closeAndDelete(db);
    _resetDbSingletonForTests();
    window.location.hash = '';
  });

  // -- workspace header / structural ----------------------------------

  it('dashboard renders the workspace header with data-region', async () => {
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountDashboardView(root);
    await settle();
    const ws = root.querySelector('[data-region="dashboard-workspace"]');
    expect(ws).not.toBeNull();
    expect(ws?.textContent).toContain('Kontrollrom');
  });

  it('Master Set Progress card scaffolding includes a loading region or empty/error replacement', async () => {
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountDashboardView(root);
    // The scaffolding paints with `master-gap-loading` first, then
    // the lazy populate replaces it with stats / empty / error. Wait
    // for the card to render in any state and assert one of the
    // valid lazy-load endpoints exists.
    await vi.waitFor(() => {
      const card = root.querySelector('[data-region="card-master-gap"]');
      expect(card).not.toBeNull();
      const loading = card?.querySelector('[data-region="master-gap-loading"]');
      const empty = card?.querySelector('[data-region="master-gap-empty"]');
      const stats = card?.querySelector('dl.dashboard-card__stats');
      const err = card?.querySelector('[data-region="master-gap-error"]');
      expect(
        loading !== null ||
          empty !== null ||
          stats !== null ||
          err !== null,
      ).toBe(true);
    });
  });

  it('Master Set Progress shows empty-state when no binders exist', async () => {
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountDashboardView(root);
    await vi.waitFor(() => {
      expect(
        root.querySelector('[data-region="master-gap-empty"]'),
      ).not.toBeNull();
    });
  });

  it('Master Set Progress survives a gap-service throw', async () => {
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    db.close();
    mountDashboardView(root);
    await vi.waitFor(() => {
      const cardErr = root.querySelector('[data-region="master-gap-error"]');
      const dashErr = root.querySelector('[data-region="error"]');
      expect(cardErr !== null || dashErr !== null).toBe(true);
    });
  });

  it('existing CSV buttons still render', async () => {
    await createBindersRepo(db).create({
      name: 'A',
      description: null,
      binderType: null,
      totalPages: 1,
      slotsPerPage: SLOTS_PER_PAGE,
      binderPreset: 'custom',
      completionMode: 'master',
      sourceSetId: null,
    });
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountDashboardView(root);
    await settle();
    const csvButtons = root.querySelectorAll(
      '[data-action="export-csv"]',
    );
    expect(csvButtons.length).toBeGreaterThan(0);
  });

  it('existing dashboard cards still render', async () => {
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountDashboardView(root);
    await settle();
    expect(
      root.querySelector('[data-region="card-database-health"]'),
    ).not.toBeNull();
    expect(root.querySelector('[data-region="card-sync"]')).not.toBeNull();
    expect(root.querySelector('[data-region="card-collection"]')).not.toBeNull();
    expect(root.querySelector('[data-region="card-binders"]')).not.toBeNull();
    expect(root.querySelector('[data-region="card-lots"]')).not.toBeNull();
    expect(root.querySelector('[data-region="card-wishlist"]')).not.toBeNull();
  });

  // -- next-best-action priority ordering -----------------------------

  it('next-best-action prioritises invalidCount above everything', () => {
    expect(
      getMasterGapNextAction(
        summary({
          invalidCount: 1,
          canPlaceDirectlyCount: 5,
          ownedUnplaced: 5,
          wishlistOrdered: 5,
          wishlistWanted: 5,
          missing: 5,
        }),
      ),
    ).toBe('Rett feilplasserte kort eller feil variant først.');
  });

  it('next-best-action prioritises canPlaceDirectly after invalid', () => {
    expect(
      getMasterGapNextAction(
        summary({
          canPlaceDirectlyCount: 1,
          ownedUnplaced: 5,
          wishlistWanted: 5,
        }),
      ),
    ).toBe('Start med kortene som kan plasseres direkte i perm.');
  });

  it('next-best-action prioritises ownedUnplaced after canPlaceDirectly', () => {
    expect(
      getMasterGapNextAction(
        summary({ ownedUnplaced: 1, wishlistOrdered: 5, missing: 5 }),
      ),
    ).toBe('Du eier kort som ikke er plassert i perm.');
  });

  it('next-best-action surfaces ordered wishlist before wanted', () => {
    expect(
      getMasterGapNextAction(
        summary({ wishlistOrdered: 1, wishlistWanted: 5, missing: 5 }),
      ),
    ).toBe('Følg opp bestilte kort og marker dem mottatt når de kommer.');
  });

  it('next-best-action surfaces wanted wishlist before missing', () => {
    expect(
      getMasterGapNextAction(summary({ wishlistWanted: 1, missing: 5 })),
    ).toBe('Følg ønskelisten og prioriter manglende master set-kort.');
  });

  it('next-best-action surfaces missing when nothing actionable above it', () => {
    expect(getMasterGapNextAction(summary({ missing: 1 }))).toBe(
      'Legg manglende kort i ønskeliste eller lot.',
    );
  });

  it('next-best-action shows all-clear text when nothing actionable exists', () => {
    expect(getMasterGapNextAction(summary())).toBe(
      'Alle registrerte master set-slots ser ryddige ut.',
    );
  });

  it('next-best-action renders inline in the populated card', async () => {
    await createBindersRepo(db).create({
      name: 'A',
      description: null,
      binderType: null,
      totalPages: 1,
      slotsPerPage: SLOTS_PER_PAGE,
      binderPreset: 'custom',
      completionMode: 'master',
      sourceSetId: null,
    });
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountDashboardView(root);
    await vi.waitFor(() => {
      const next = root.querySelector(
        '[data-region="master-gap-next-action"]',
      );
      expect(next).not.toBeNull();
      expect(next?.textContent).toContain('Neste beste handling:');
    });
  });
});
