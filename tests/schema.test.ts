import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeAndDelete, freshDb } from './helpers/fresh-db';
import type { PokemonTrackerDB } from '../src/db/database';
import { SCHEMA_VERSION, STORE_NAMES } from '../src/db/schema';

describe('Dexie schema', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    db = await freshDb();
  });

  afterEach(async () => {
    await closeAndDelete(db);
  });

  it('opens the database', () => {
    expect(db.isOpen()).toBe(true);
  });

  it('reports the locked schema version', () => {
    expect(db.verno).toBe(SCHEMA_VERSION);
  });

  it('exposes all 11 stores', () => {
    const tableNames = db.tables.map((table) => table.name).sort();
    expect(tableNames).toEqual([...STORE_NAMES].sort());
    expect(tableNames).toHaveLength(11);
  });

  it('declares the compound binderSlot index', () => {
    const binderSlots = db.table('binderSlots');
    const compoundIndex = binderSlots.schema.indexes.find(
      (idx) => idx.name === '[binderId+pageNumber+slotNumber]',
    );
    expect(compoundIndex).toBeDefined();
    expect(compoundIndex?.compound).toBe(true);
    expect(compoundIndex?.keyPath).toEqual([
      'binderId',
      'pageNumber',
      'slotNumber',
    ]);
  });

  it('declares the multi-entry tags index on holdings', () => {
    const holdings = db.table('holdings');
    const tagsIndex = holdings.schema.indexes.find(
      (idx) => idx.name === 'tags',
    );
    expect(tagsIndex).toBeDefined();
    expect(tagsIndex?.multi).toBe(true);
  });

  it('declares the deletedAt index on every soft-deletable store', () => {
    const userOwned = [
      'holdings',
      'lots',
      'lotItems',
      'binders',
      'binderSlots',
      'wishlist',
    ] as const;
    for (const name of userOwned) {
      const indexes = db.table(name).schema.indexes.map((idx) => idx.name);
      expect(indexes, name).toContain('deletedAt');
    }
  });

  it('uses the `key` primary key for settings and appMeta', () => {
    expect(db.table('settings').schema.primKey.keyPath).toBe('key');
    expect(db.table('appMeta').schema.primKey.keyPath).toBe('key');
  });
});
