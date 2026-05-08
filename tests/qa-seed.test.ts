// PR 28 review patch — QA seed determinism + scenario coverage.
//
// The seed must produce *exactly* the same DB state every time so a
// QA report from one run is comparable with another. These tests
// also confirm the seed produces the master-gap scenarios PR 28
// claims to cover (recommended ambiguous, manual ambiguous,
// reverse-holo template, invalid_assignment, invalid_variant).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// QA seed inserts ~1700 rows through the production repo path
// (each insert appends an audit row), which is slow on fake-
// indexeddb. Lift the per-test timeout.
const SEED_TIMEOUT = 120_000;
vi.setConfig({ testTimeout: SEED_TIMEOUT });

import {
  QA_ASSIGNED_SLOTS_TARGET,
  QA_BINDERS_TARGET,
  QA_HOLDINGS_TARGET,
  QA_LOTS_TARGET,
  QA_LOT_ITEMS_PER_LOT,
  QA_SEED_NAME,
  QA_TOTAL_SLOTS_TARGET,
  QA_WISHLIST_TARGET,
  resetQaData,
  seedStressData,
} from '../src/qa/qa-seed';
import { buildQaDeps } from '../src/qa/qa-runner';
import { closeAndDelete, freshDb } from './helpers/fresh-db';
import { createMasterSetGapService } from '../src/services/master-set-gap-service';
import type { PokemonTrackerDB } from '../src/db/database';

describe('qa-seed (PR 28 review patch)', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    db = await freshDb();
  });

  afterEach(async () => {
    await closeAndDelete(db);
  });

  it('seed name is the documented constant', () => {
    expect(QA_SEED_NAME).toBe('morten-pokemon-qa-v1');
  });

  it('produces exactly the documented counts', async () => {
    const summary = await seedStressData(buildQaDeps(db));
    expect(summary.seed).toBe(QA_SEED_NAME);
    expect(summary.holdings).toBe(QA_HOLDINGS_TARGET);
    expect(summary.wishlist).toBe(QA_WISHLIST_TARGET);
    expect(summary.lots).toBe(QA_LOTS_TARGET);
    expect(summary.lotItems).toBe(QA_LOTS_TARGET * QA_LOT_ITEMS_PER_LOT);
    expect(summary.binders).toBe(QA_BINDERS_TARGET);
    expect(summary.slots).toBe(QA_TOTAL_SLOTS_TARGET);
    expect(summary.assignedSlots).toBeLessThanOrEqual(QA_ASSIGNED_SLOTS_TARGET);
  });

  it('reset wipes every QA-relevant store', async () => {
    const deps = buildQaDeps(db);
    await seedStressData(deps);
    await resetQaData(deps);
    expect(await db.cards.count()).toBe(0);
    expect(await db.sets.count()).toBe(0);
    expect(await db.holdings.count()).toBe(0);
    expect(await db.binders.count()).toBe(0);
    expect(await db.binderSlots.count()).toBe(0);
    expect(await db.lots.count()).toBe(0);
    expect(await db.lotItems.count()).toBe(0);
    expect(await db.wishlist.count()).toBe(0);
    expect(await db.auditLog.count()).toBe(0);
  });

  it('reset preserves the settings store (so PR 27 prefs survive)', async () => {
    const deps = buildQaDeps(db);
    await db.settings.put({
      key: 'appDisplayName',
      value: 'My Tracker',
      updatedAt: new Date().toISOString(),
    });
    await seedStressData(deps);
    await resetQaData(deps);
    const row = await db.settings.get('appDisplayName');
    expect(row?.value).toBe('My Tracker');
  });

  it('master-gap dashboard summary reports both ambiguous types after seed', async () => {
    const deps = buildQaDeps(db);
    await seedStressData(deps);
    const summary = await createMasterSetGapService(deps).buildDashboardSummary();
    // eslint-disable-next-line no-console -- debug while shaping the seed
    console.log('master-gap summary after seed:', {
      ambiguousOwned: summary.ambiguousOwned,
      recommendedAmbiguousCount: summary.recommendedAmbiguousCount,
      manualAmbiguousCount: summary.manualAmbiguousCount,
      complete: summary.complete,
      missing: summary.missing,
      ownedUnplaced: summary.ownedUnplaced,
      invalidCount: summary.invalidCount,
      totalTargetSlots: summary.totalTargetSlots,
    });
    expect(summary.ambiguousOwned).toBeGreaterThan(0);
    expect(summary.recommendedAmbiguousCount).toBeGreaterThan(0);
    expect(summary.manualAmbiguousCount).toBeGreaterThan(0);
  });

  it('master-gap dashboard summary reports at least one invalid signal', async () => {
    const deps = buildQaDeps(db);
    await seedStressData(deps);
    const summary = await createMasterSetGapService(deps).buildDashboardSummary();
    // The seed plants at least one invalid_assignment + one
    // invalid_variant, so the dashboard's combined count must be
    // non-zero.
    expect(summary.invalidCount).toBeGreaterThan(0);
  });

  it('seed is deterministic — running twice on a clean DB yields identical totals', async () => {
    const deps = buildQaDeps(db);
    const first = await seedStressData(deps);
    await resetQaData(deps);
    const second = await seedStressData(deps);
    // Counts (the contract; ids will differ because newId is random).
    expect(second.holdings).toBe(first.holdings);
    expect(second.wishlist).toBe(first.wishlist);
    expect(second.lots).toBe(first.lots);
    expect(second.lotItems).toBe(first.lotItems);
    expect(second.binders).toBe(first.binders);
    expect(second.slots).toBe(first.slots);
    expect(second.reverseTemplateSlots).toBe(first.reverseTemplateSlots);
    expect(second.invalidAssignmentSlots).toBe(first.invalidAssignmentSlots);
    expect(second.invalidVariantSlots).toBe(first.invalidVariantSlots);
  });

  it('seeded reverse-template slots use the documented marker', async () => {
    const deps = buildQaDeps(db);
    await seedStressData(deps);
    const slots = await db.binderSlots.toArray();
    const reverse = slots.filter((s) => s.note === 'template:reverse_holo');
    expect(reverse.length).toBeGreaterThan(0);
  });

  it('cards have at least the `normal` tcgplayer key so variant validators accept them', async () => {
    const deps = buildQaDeps(db);
    await seedStressData(deps);
    const card = await db.cards.get('qa1-1');
    expect(card).toBeDefined();
    const tcg = (card?.tcgplayer ?? null) as
      | { prices: Record<string, unknown> }
      | null;
    expect(tcg?.prices['normal']).toBeDefined();
  });
});
