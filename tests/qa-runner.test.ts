// PR 28 review patch — orchestrator tests for `runQa`. Covers the
// four mode combinations (reset/seed flags) and confirms the report
// pulls counts from the live DB and the master-gap service.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Same reasoning as qa-seed.test.ts — seeding inserts ~1700 audited
// rows on fake-indexeddb, so the per-test budget needs to grow.
vi.setConfig({ testTimeout: 180_000 });

import { runQa, buildQaDeps } from '../src/qa/qa-runner';
import { closeAndDelete, freshDb } from './helpers/fresh-db';
import type { PokemonTrackerDB } from '../src/db/database';

describe('qa-runner', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    db = await freshDb();
  });

  afterEach(async () => {
    await closeAndDelete(db);
  });

  it('measure-only on an empty DB returns zero counts and pass', async () => {
    const report = await runQa(db, {
      reset: false,
      seed: false,
      runtime: 'unknown',
    });
    expect(report.overall).toBe('pass');
    expect(report.seed).toBeNull();
    expect(report.dbCounts.cards).toBe(0);
    expect(report.dbCounts.holdings).toBe(0);
    expect(report.dbCounts.binders).toBe(0);
  });

  it('reset-only wipes everything but the settings store', async () => {
    await db.settings.put({
      key: 'appDisplayName',
      value: 'Keep Me',
      updatedAt: new Date().toISOString(),
    });
    // Seed first so reset has something to do.
    await runQa(db, { reset: false, seed: true, runtime: 'unknown' });
    expect(await db.holdings.count()).toBeGreaterThan(0);

    const report = await runQa(db, {
      reset: true,
      seed: false,
      runtime: 'unknown',
    });
    expect(report.dbCounts.holdings).toBe(0);
    expect(report.dbCounts.binders).toBe(0);
    expect(report.dbCounts.binderSlots).toBe(0);
    expect(report.dbCounts.cards).toBe(0);
    // settings survived
    expect((await db.settings.get('appDisplayName'))?.value).toBe('Keep Me');
  });

  it('reset+seed produces non-zero master-gap signals and pass verdict', async () => {
    const report = await runQa(db, {
      reset: true,
      seed: true,
      runtime: 'unknown',
    });
    expect(report.seed).not.toBeNull();
    expect(report.seed?.holdings).toBeGreaterThan(0);
    expect(report.masterGap).not.toBeNull();
    expect(report.masterGap?.recommendedAmbiguousCount ?? 0).toBeGreaterThan(0);
    expect(report.masterGap?.manualAmbiguousCount ?? 0).toBeGreaterThan(0);
    expect(report.overall).toBe('pass');
  });

  it('reports performance entries for every step it ran', async () => {
    const report = await runQa(db, {
      reset: true,
      seed: true,
      runtime: 'unknown',
    });
    const labels = report.performance.map((p) => p.label);
    expect(labels).toContain('reset');
    expect(labels).toContain('seed');
    expect(labels).toContain('count_all_stores');
    expect(labels).toContain('master_gap_dashboard_summary');
  });

  it('passes the documented route hashes through to the report', async () => {
    const report = await runQa(db, {
      reset: false,
      seed: false,
      runtime: 'unknown',
    });
    const hashes = report.routeChecks.map((r) => r.hash);
    expect(hashes).toEqual(
      expect.arrayContaining([
        '#dashboard',
        '#browse',
        '#collection',
        '#binders',
        '#lots',
        '#wishlist',
        '#backup',
        '#settings',
        '#master-gap',
      ]),
    );
    // Every route check is ok in the static check.
    expect(report.routeChecks.every((r) => r.ok)).toBe(true);
  });

  it('honours the explicit runtime flag', async () => {
    const report = await runQa(db, {
      reset: false,
      seed: false,
      runtime: 'tauri',
    });
    expect(report.runtime).toBe('tauri');
  });

  it('fails the run when the caller reports console errors', async () => {
    const report = await runQa(db, {
      reset: false,
      seed: false,
      runtime: 'unknown',
      consoleCounts: { errors: 1, warnings: 0 },
    });
    expect(report.overall).toBe('fail');
  });

  it('buildQaDeps wires every repo against the same db', () => {
    const deps = buildQaDeps(db);
    expect(deps.db).toBe(db);
    expect(typeof deps.bindersRepo.listLive).toBe('function');
    expect(typeof deps.binderSlotsRepo.listLive).toBe('function');
    expect(typeof deps.cardsRepo.upsertMany).toBe('function');
    expect(typeof deps.holdingsRepo.create).toBe('function');
    expect(typeof deps.lotsRepo.create).toBe('function');
    expect(typeof deps.lotItemsRepo.listLive).toBe('function');
    expect(typeof deps.setsRepo.upsertMany).toBe('function');
    expect(typeof deps.wishlistRepo.listLive).toBe('function');
  });
});
