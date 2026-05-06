import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initializeDataLayer } from '../src/db/init';
import { APP_META_KEYS } from '../src/domain/types';
import { SCHEMA_VERSION } from '../src/db/schema';
import { closeAndDelete, freshDb } from './helpers/fresh-db';
import type { PokemonTrackerDB } from '../src/db/database';

describe('initializeDataLayer migrations', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    db = await freshDb();
  });

  afterEach(async () => {
    await closeAndDelete(db);
  });

  it('records schemaVersion exactly once on first init', async () => {
    const result = await initializeDataLayer({
      db,
      skipPersistentStorage: true,
    });

    expect(result.schemaVersion).toBe(SCHEMA_VERSION);
    expect(result.migrationApplied).toBe(true);

    const storedVersion = await db.appMeta.get(APP_META_KEYS.schemaVersion);
    expect(storedVersion?.value).toBe(SCHEMA_VERSION);
  });

  it('writes lastMigrationAt and appVersion on first init', async () => {
    await initializeDataLayer({
      db,
      skipPersistentStorage: true,
    });

    const lastMigrationAt = await db.appMeta.get(
      APP_META_KEYS.lastMigrationAt,
    );
    const appVersion = await db.appMeta.get(APP_META_KEYS.appVersion);
    expect(typeof lastMigrationAt?.value).toBe('string');
    expect(typeof appVersion?.value).toBe('string');
  });

  it('appends a single schema_migration audit entry on first init', async () => {
    await initializeDataLayer({
      db,
      skipPersistentStorage: true,
    });

    const migrationEntries = await db.auditLog
      .where('action')
      .equals('schema_migration')
      .toArray();

    expect(migrationEntries).toHaveLength(1);
    expect(migrationEntries[0]?.entityType).toBe('system');
  });

  it('does not duplicate audit entries when init runs again on the same DB', async () => {
    await initializeDataLayer({
      db,
      skipPersistentStorage: true,
    });
    const result = await initializeDataLayer({
      db,
      skipPersistentStorage: true,
    });

    expect(result.migrationApplied).toBe(false);

    const migrationEntries = await db.auditLog
      .where('action')
      .equals('schema_migration')
      .toArray();
    expect(migrationEntries).toHaveLength(1);
  });
});
