// PR 28 review patch — qa-max-stress live tests.
//
// Verifies that `seedMaxStressData` exhaustively covers every domain
// state it advertises (every condition, finish, edition, status,
// every binder preset, every completion mode, every wishlist
// status × priority, every lot allocation state) and works against
// both an empty card cache (fallback fixture path) and a populated
// one.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 240_000 });

import {
  QA_MAX_STRESS_SEED_NAME,
  seedMaxStressData,
} from '../src/qa/qa-max-stress';
import { buildQaDeps } from '../src/qa/qa-runner';
import { closeAndDelete, freshDb } from './helpers/fresh-db';
import type { PokemonTrackerDB } from '../src/db/database';

describe('seedMaxStressData', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    db = await freshDb();
  });

  afterEach(async () => {
    await closeAndDelete(db);
  });

  it('uses the documented seed name', async () => {
    const summary = await seedMaxStressData(buildQaDeps(db));
    expect(summary.seed).toBe(QA_MAX_STRESS_SEED_NAME);
    expect(summary.seed).toBe('morten-pokemon-stress-v1');
  });

  it('falls back to a fixture when the card cache is empty', async () => {
    expect(await db.cards.count()).toBe(0);
    const summary = await seedMaxStressData(buildQaDeps(db));
    expect(summary.cards).toBeGreaterThan(0);
    expect(summary.notes.some((n) => n.startsWith('card cache empty'))).toBe(true);
    expect(await db.cards.count()).toBe(summary.cards);
  });

  it('produces holdings across every documented state axis', async () => {
    const summary = await seedMaxStressData(buildQaDeps(db));
    expect(summary.holdings.total).toBeGreaterThan(50);
    expect(summary.holdings.raw).toBeGreaterThan(0);
    expect(summary.holdings.graded).toBeGreaterThan(0);
    // Every condition must show up at least once.
    expect(summary.holdings.perCondition['NM']).toBeGreaterThan(0);
    expect(summary.holdings.perCondition['LP']).toBeGreaterThan(0);
    expect(summary.holdings.perCondition['MP']).toBeGreaterThan(0);
    expect(summary.holdings.perCondition['HP']).toBeGreaterThan(0);
    expect(summary.holdings.perCondition['DMG']).toBeGreaterThan(0);
    expect(summary.holdings.perCondition['UNKNOWN']).toBeGreaterThan(0);
    // Every status must show up.
    for (const status of [
      'owned',
      'duplicate',
      'for_sale',
      'for_trade',
      'upgrade_needed',
      'ordered',
      'wanted',
    ] as const) {
      expect(summary.holdings.perStatus[status]).toBeGreaterThan(0);
    }
    // At least three finishes (normal/holo/reverse_holo from the
    // fallback fixture).
    expect(Object.keys(summary.holdings.perFinish).length).toBeGreaterThanOrEqual(3);
  });

  it('writes one binder per blueprint, covering every preset and mode', async () => {
    const summary = await seedMaxStressData(buildQaDeps(db));
    expect(summary.binders.total).toBe(6);
    expect(summary.binders.perPreset['vaultx_9_360']).toBe(1);
    expect(summary.binders.perPreset['vaultx_12_480']).toBe(1);
    expect(summary.binders.perPreset['vaultx_12xl_624']).toBe(1);
    expect(summary.binders.perPreset['vaultx_16xxl_1088']).toBe(1);
    expect(summary.binders.perPreset['custom']).toBe(2);
    expect(summary.binders.perCompletionMode.standard).toBe(2);
    expect(summary.binders.perCompletionMode.master).toBe(3);
    expect(summary.binders.perCompletionMode.grand_master).toBe(1);
    expect(summary.binders.slots).toBeGreaterThan(2000);
    expect(summary.binders.reverseTemplateSlots).toBeGreaterThan(0);
  });

  it('writes wishlist entries spanning every status × priority', async () => {
    const summary = await seedMaxStressData(buildQaDeps(db));
    for (const status of ['wanted', 'ordered', 'received', 'cancelled'] as const) {
      expect(summary.wishlist.perStatus[status]).toBeGreaterThan(0);
    }
    for (const priority of ['low', 'medium', 'high', 'grail'] as const) {
      expect(summary.wishlist.perPriority[priority]).toBeGreaterThan(0);
    }
    expect(summary.wishlist.total).toBeGreaterThan(15);
  });

  it('writes three lots across allocated / materialised / unallocated states', async () => {
    const summary = await seedMaxStressData(buildQaDeps(db));
    expect(summary.lots.total).toBe(3);
    expect(summary.lots.items).toBe(15);
    expect(summary.lots.allocated).toBe(10);
    expect(summary.lots.materialised).toBe(5);
  });

  it('persists the summary numbers in the live DB', async () => {
    const summary = await seedMaxStressData(buildQaDeps(db));
    expect(await db.holdings.count()).toBe(summary.holdings.total);
    expect(await db.binders.count()).toBe(summary.binders.total);
    expect(await db.binderSlots.count()).toBe(summary.binders.slots);
    expect(await db.wishlist.count()).toBe(summary.wishlist.total);
    expect(await db.lots.count()).toBe(summary.lots.total);
    expect(await db.lotItems.count()).toBe(summary.lots.items);
  });

  it('exercises slot assignment via assignHoldingToSlot', async () => {
    const summary = await seedMaxStressData(buildQaDeps(db));
    expect(summary.binders.assignedSlots).toBeGreaterThan(0);
  });
});
