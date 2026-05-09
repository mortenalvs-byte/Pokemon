// PR 28 review patch — live tests for the persistence diagnostic.
// Uses fake-indexeddb (already wired into the project's vitest setup)
// so we can verify `buildPersistenceDiagnostic` against a real Dexie
// instance + that `writePersistenceSentinel` round-trips.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildPersistenceDiagnostic,
  PERSISTENCE_BOOT_COUNTER_LOCAL_STORAGE_KEY,
  PERSISTENCE_SENTINEL_APP_META_KEY,
  PERSISTENCE_SENTINEL_LOCAL_STORAGE_KEY,
  writePersistenceSentinel,
} from '../src/qa/desktop-persistence-diagnostic';
import { closeAndDelete, freshDb } from './helpers/fresh-db';
import type { PokemonTrackerDB } from '../src/db/database';

describe('buildPersistenceDiagnostic (live)', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    db = await freshDb();
    if (typeof localStorage !== 'undefined') localStorage.clear();
  });

  afterEach(async () => {
    await closeAndDelete(db);
  });

  it('reports the live Dexie metadata and zero counts on a fresh DB', async () => {
    const d = await buildPersistenceDiagnostic(db);
    expect(d.dexie.name).toBe(db.name);
    expect(d.dexie.verno).toBeGreaterThanOrEqual(2);
    expect(d.dexie.tables.length).toBeGreaterThan(0);
    expect(d.storeCounts['holdings']).toBe(0);
    expect(d.storeCounts['cards']).toBe(0);
    expect(d.storeCounts['appMeta']).toBe(0);
    expect(d.firstHoldingIds).toEqual([]);
    expect(d.localStorageSentinel).toBeNull();
    expect(d.appMetaSentinel).toBeNull();
  });

  it('captures the localStorage and appMeta sentinels after writing one', async () => {
    const payload = await writePersistenceSentinel(db, { note: 'launch-A' });
    const d = await buildPersistenceDiagnostic(db);
    expect(d.localStorageSentinel?.bootCounter).toBe(payload.bootCounter);
    expect(d.appMetaSentinel?.bootCounter).toBe(payload.bootCounter);
    expect(d.localStorageSentinel?.note).toBe('launch-A');
  });

  it('bumps the boot counter on each writePersistenceSentinel call', async () => {
    const a = await writePersistenceSentinel(db);
    const b = await writePersistenceSentinel(db);
    const c = await writePersistenceSentinel(db);
    expect(a.bootCounter).toBe(1);
    expect(b.bootCounter).toBe(2);
    expect(c.bootCounter).toBe(3);
  });

  it('persists the appMeta sentinel into the appMeta store', async () => {
    await writePersistenceSentinel(db);
    const row = await db.appMeta.get(PERSISTENCE_SENTINEL_APP_META_KEY);
    expect(row).toBeDefined();
    expect(typeof row?.value).toBe('object');
  });

  it('uses the documented localStorage keys', async () => {
    await writePersistenceSentinel(db);
    expect(
      typeof localStorage !== 'undefined'
        ? localStorage.getItem(PERSISTENCE_SENTINEL_LOCAL_STORAGE_KEY)
        : null,
    ).not.toBeNull();
    expect(
      typeof localStorage !== 'undefined'
        ? localStorage.getItem(PERSISTENCE_BOOT_COUNTER_LOCAL_STORAGE_KEY)
        : null,
    ).toBe('1');
  });

  it('reports holdings from a populated table', async () => {
    await db.holdings.bulkPut([
      // bare-bones rows, the diagnostic only counts and lists primaryKeys
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ({ id: 'h-1' } as any),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ({ id: 'h-2' } as any),
    ]);
    const d = await buildPersistenceDiagnostic(db);
    expect(d.storeCounts['holdings']).toBe(2);
    expect(d.firstHoldingIds).toEqual(expect.arrayContaining(['h-1', 'h-2']));
  });
});
