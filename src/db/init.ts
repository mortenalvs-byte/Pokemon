// Boot-time data layer initialization. Opens the database, records
// schemaVersion + appVersion + lastMigrationAt the first time it sees a
// fresh DB, requests persistent storage best-effort, and writes a single
// `schema_migration` audit entry per migration run.
//
// `initializeDataLayer()` is safe to call from `main.ts`: any failure is
// the caller's to handle — it must not crash the app shell.

import { nowIso } from '../utils/dates';
import { APP_META_KEYS } from '../domain/types';
import type { AppMetaRecord } from '../domain/types';
import { appendAudit } from './audit';
import { getDb } from './database';
import type { PokemonTrackerDB } from './database';
import { requestPersistentStorage } from './persistence';
import { SCHEMA_VERSION } from './schema';

// Bumped manually in package.json or a future appVersion source. Kept as
// a constant here because PR 3 has no build-time injection yet.
const APP_VERSION = '0.0.0';

export interface InitializeOptions {
  readonly db?: PokemonTrackerDB;
  readonly skipPersistentStorage?: boolean;
}

export interface InitializeResult {
  readonly schemaVersion: number;
  readonly appVersion: string;
  readonly migrationApplied: boolean;
  readonly persistentStorageGranted: boolean;
}

export async function initializeDataLayer(
  options: InitializeOptions = {},
): Promise<InitializeResult> {
  const db = options.db ?? getDb();
  await db.open();

  const migrationApplied = await ensureSchemaVersionRecorded(db);

  let persistentStorageGranted = false;
  if (options.skipPersistentStorage !== true) {
    persistentStorageGranted = await requestPersistentStorage();
    await writeAppMeta(db, APP_META_KEYS.persistentStorageGranted, persistentStorageGranted);
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    appVersion: APP_VERSION,
    migrationApplied,
    persistentStorageGranted,
  };
}

async function ensureSchemaVersionRecorded(
  db: PokemonTrackerDB,
): Promise<boolean> {
  const existing = await db.appMeta.get(APP_META_KEYS.schemaVersion);
  const recordedVersion =
    typeof existing?.value === 'number' ? existing.value : null;

  if (recordedVersion === SCHEMA_VERSION) {
    return false; // No migration needed; do not duplicate the audit entry.
  }

  await writeAppMeta(db, APP_META_KEYS.schemaVersion, SCHEMA_VERSION);
  await writeAppMeta(db, APP_META_KEYS.appVersion, APP_VERSION);
  await writeAppMeta(db, APP_META_KEYS.lastMigrationAt, nowIso());

  await appendAudit(db, {
    action: 'schema_migration',
    entityType: 'system',
    entityId: null,
    message:
      recordedVersion === null
        ? `initialized schemaVersion=${SCHEMA_VERSION}`
        : `migrated schemaVersion ${recordedVersion} -> ${SCHEMA_VERSION}`,
  });

  return true;
}

async function writeAppMeta(
  db: PokemonTrackerDB,
  key: string,
  value: unknown,
): Promise<void> {
  const record: AppMetaRecord = {
    key,
    value,
    updatedAt: nowIso(),
  };
  await db.appMeta.put(record);
}
