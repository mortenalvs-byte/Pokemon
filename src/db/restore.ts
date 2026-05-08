// Backup parse + validate + replace-restore.
//
// Parse and validate are pure functions. They do not touch the database
// and they cannot throw past the boundary that matters: the caller sees
// either a successful parse + validation result or a typed error. The
// database is only read or written from within `replaceRestore()`, and
// every replaceRestore write happens inside one Dexie transaction so a
// mid-transaction failure leaves the original database intact.

import { isIsoTimestamp, nowIso } from '../utils/dates';
import { presetForLegacyRow } from '../domain/binder-presets';
import {
  APP_META_KEYS,
  SETTINGS_KEYS,
  type AppMetaRecord,
  type AuditLogRecord,
  type BackupFile,
  type BinderRecord,
  type BinderSlotRecord,
  type CardRecord,
  type HoldingRecord,
  type LotItemRecord,
  type LotRecord,
  type SetRecord,
  type SettingsRecord,
  type WishlistRecord,
} from '../domain/types';
import { newId } from '../utils/ids';
import { BACKUP_APP_LITERAL } from './backup';
import { tryPreRestoreAutoBackup } from './auto-backup';
import type { AutoBackupResult } from './auto-backup';
import { invalidateCardCache, invalidateSetCache } from './cards-cache';
import type { PokemonTrackerDB } from './database';
import { SCHEMA_VERSION } from './schema';

/**
 * Restore-time normalisation for binder rows. Pre-PR-14 backups and
 * any tampered JSON may carry rows where `binderPreset` is missing or
 * `null`; the rest of the app (binders list view, binder form, etc.)
 * branches on `binderPreset !== null`, which is true for `undefined`
 * — so feeding `undefined` straight in would crash
 * `getBinderPresetDefinition()` later.
 *
 * Same rule as the v1→v2 schema upgrade hook in `db/schema.ts`:
 *   slotsPerPage === 18 → legacy_18, else custom.
 */
function normaliseBackupBinder(binder: BinderRecord): BinderRecord {
  if (binder.binderPreset !== undefined && binder.binderPreset !== null) {
    return binder;
  }
  return {
    ...binder,
    binderPreset: presetForLegacyRow(binder.slotsPerPage),
  };
}

// ---------------------------------------------------------------------
// Errors

export class PreRestoreBackupFailedError extends Error {
  public readonly originalError: Error;

  constructor(originalError: Error) {
    super(
      `Pre-restore auto-backup failed: ${originalError.message}. The replace-restore was aborted because no safety-net backup could be written. Re-run with confirmedWithoutPreBackup=true to proceed anyway.`,
    );
    this.name = 'PreRestoreBackupFailedError';
    this.originalError = originalError;
  }
}

// ---------------------------------------------------------------------
// Parse

export function parseBackupJson(text: string): unknown {
  return JSON.parse(text);
}

// ---------------------------------------------------------------------
// Validate

export interface ValidationOk {
  readonly ok: true;
  readonly backup: BackupFile;
  readonly warnings: readonly string[];
}

export interface ValidationFail {
  readonly ok: false;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

export type ValidationResult = ValidationOk | ValidationFail;

const TOP_LEVEL_ARRAY_KEYS = [
  'settings',
  'sets',
  'cards',
  'holdings',
  'lots',
  'lotItems',
  'binders',
  'binderSlots',
  'wishlist',
  'auditLog',
  'appMeta',
] as const;

const ID_REQUIRED_STORES = [
  'holdings',
  'lots',
  'lotItems',
  'binders',
  'binderSlots',
  'wishlist',
] as const;

export function validateBackup(parsed: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      errors: ['root: backup must be a JSON object'],
      warnings,
    };
  }

  const root = parsed as Record<string, unknown>;

  if (root['app'] !== BACKUP_APP_LITERAL) {
    errors.push(
      `app: expected "${BACKUP_APP_LITERAL}", got ${JSON.stringify(root['app'])}`,
    );
  }

  const schemaVersion = root['schemaVersion'];
  if (
    typeof schemaVersion !== 'number' ||
    !Number.isInteger(schemaVersion) ||
    schemaVersion < 1
  ) {
    errors.push('schemaVersion: must be a positive integer');
  } else if (schemaVersion > SCHEMA_VERSION) {
    errors.push(
      `schemaVersion: backup is version ${schemaVersion} but this build supports up to ${SCHEMA_VERSION}. Update the app first.`,
    );
  }

  if (typeof root['exportedAt'] !== 'string' || !isIsoTimestamp(root['exportedAt'])) {
    errors.push('exportedAt: must be a valid ISO 8601 timestamp');
  }

  for (const key of TOP_LEVEL_ARRAY_KEYS) {
    const value = root[key];
    if (value === undefined) {
      errors.push(`${key}: required top-level array is missing`);
    } else if (!Array.isArray(value)) {
      errors.push(`${key}: must be an array`);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors, warnings };
  }

  // Past this point we can safely cast; every required key exists and is
  // an array of the expected outer shape. Per-record id check is a
  // separate pass because it only applies to user-data stores.

  for (const store of ID_REQUIRED_STORES) {
    const records = root[store] as unknown[];
    for (let i = 0; i < records.length; i += 1) {
      const record = records[i];
      if (
        record === null ||
        typeof record !== 'object' ||
        Array.isArray(record) ||
        typeof (record as Record<string, unknown>)['id'] !== 'string'
      ) {
        errors.push(`${store}[${i}]: record is missing a string id`);
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors, warnings };
  }

  // Cross-reference checks produce warnings only — bad references do
  // not abort the restore, but the user sees them in the preview.
  collectCrossReferenceWarnings(root, warnings);

  // The shape passes; we can claim the typed BackupFile.
  const backup: BackupFile = {
    app: BACKUP_APP_LITERAL,
    schemaVersion: schemaVersion as number,
    exportedAt: root['exportedAt'] as string,
    settings: root['settings'] as SettingsRecord[],
    sets: root['sets'] as SetRecord[],
    cards: root['cards'] as CardRecord[],
    holdings: root['holdings'] as HoldingRecord[],
    lots: root['lots'] as LotRecord[],
    lotItems: root['lotItems'] as LotItemRecord[],
    binders: root['binders'] as BinderRecord[],
    binderSlots: root['binderSlots'] as BinderSlotRecord[],
    wishlist: root['wishlist'] as WishlistRecord[],
    auditLog: root['auditLog'] as AuditLogRecord[],
    appMeta: root['appMeta'] as AppMetaRecord[],
  };

  return { ok: true, backup, warnings };
}

function collectCrossReferenceWarnings(
  root: Record<string, unknown>,
  warnings: string[],
): void {
  const binders = root['binders'] as Array<{ id: string }>;
  const holdings = root['holdings'] as Array<{ id: string; lotId: string | null }>;
  const lots = root['lots'] as Array<{ id: string }>;
  const binderSlots = root['binderSlots'] as Array<{
    binderId: string;
    holdingId: string | null;
  }>;
  const lotItems = root['lotItems'] as Array<{
    lotId: string;
    holdingId: string | null;
  }>;

  const binderIds = new Set(binders.map((b) => b.id));
  const lotIds = new Set(lots.map((l) => l.id));
  const holdingIds = new Set(holdings.map((h) => h.id));

  binderSlots.forEach((slot, i) => {
    if (!binderIds.has(slot.binderId)) {
      warnings.push(
        `binderSlots[${i}]: references missing binderId ${JSON.stringify(slot.binderId)}`,
      );
    }
    if (slot.holdingId !== null && !holdingIds.has(slot.holdingId)) {
      warnings.push(
        `binderSlots[${i}]: references missing holdingId ${JSON.stringify(slot.holdingId)}`,
      );
    }
  });

  holdings.forEach((holding, i) => {
    if (holding.lotId !== null && !lotIds.has(holding.lotId)) {
      warnings.push(
        `holdings[${i}]: references missing lotId ${JSON.stringify(holding.lotId)}`,
      );
    }
  });

  lotItems.forEach((item, i) => {
    if (!lotIds.has(item.lotId)) {
      warnings.push(
        `lotItems[${i}]: references missing lotId ${JSON.stringify(item.lotId)}`,
      );
    }
    if (item.holdingId !== null && !holdingIds.has(item.holdingId)) {
      warnings.push(
        `lotItems[${i}]: references missing holdingId ${JSON.stringify(item.holdingId)}`,
      );
    }
  });
}

// ---------------------------------------------------------------------
// Replace restore

export interface ReplaceRestoreOptions {
  /**
   * The result of `tryPreRestoreAutoBackup(db)`. If supplied and ok,
   * the restore proceeds. If supplied and fail (ok === false), the
   * caller must also set `confirmedWithoutPreBackup: true` or the
   * restore aborts with `PreRestoreBackupFailedError`.
   *
   * If not supplied at all, the restore runs `tryPreRestoreAutoBackup`
   * itself.
   */
  readonly preRestoreBackup?: AutoBackupResult;
  readonly confirmedWithoutPreBackup?: boolean;
}

export interface ReplaceRestoreResult {
  readonly preRestoreBackup: AutoBackupResult;
  readonly restoredAt: string;
}

export async function replaceRestore(
  db: PokemonTrackerDB,
  validatedBackup: BackupFile,
  options: ReplaceRestoreOptions = {},
): Promise<ReplaceRestoreResult> {
  // 1. Pre-restore safety net.
  const preRestoreBackup =
    options.preRestoreBackup ?? (await tryPreRestoreAutoBackup(db));

  if (!preRestoreBackup.ok && options.confirmedWithoutPreBackup !== true) {
    throw new PreRestoreBackupFailedError(preRestoreBackup.error);
  }

  // 2. Read the current API key so we can preserve it if the backup
  //    omits one.
  const existingApiKeyRow = await db.settings.get(
    SETTINGS_KEYS.pokemonTcgApiKey,
  );

  // 3. Apply the restore inside a single transaction. Any throw rolls
  //    back; on commit, the database is exactly the backup (plus the
  //    audit row appended below).
  const restoredAt = nowIso();

  await db.transaction(
    'rw',
    [
      db.sets,
      db.cards,
      db.holdings,
      db.lots,
      db.lotItems,
      db.binders,
      db.binderSlots,
      db.wishlist,
      db.auditLog,
      db.settings,
      db.appMeta,
    ],
    async () => {
      // Cache stores
      await db.sets.clear();
      await db.cards.clear();
      if (validatedBackup.sets.length > 0) {
        await db.sets.bulkPut(validatedBackup.sets);
      }
      if (validatedBackup.cards.length > 0) {
        await db.cards.bulkPut(validatedBackup.cards);
      }

      // User-owned stores
      await db.holdings.clear();
      await db.lots.clear();
      await db.lotItems.clear();
      await db.binders.clear();
      await db.binderSlots.clear();
      await db.wishlist.clear();
      await db.auditLog.clear();
      if (validatedBackup.holdings.length > 0) {
        await db.holdings.bulkPut(validatedBackup.holdings);
      }
      if (validatedBackup.lots.length > 0) {
        await db.lots.bulkPut(validatedBackup.lots);
      }
      if (validatedBackup.lotItems.length > 0) {
        await db.lotItems.bulkPut(validatedBackup.lotItems);
      }
      if (validatedBackup.binders.length > 0) {
        // Normalise `binderPreset` on every binder row before
        // persisting. Pre-PR-14 backups omit the field; without this
        // pass the resulting rows would carry `undefined`, which
        // breaks the binders list view's `binderPreset !== null`
        // guard the moment the user opens Permer.
        const normalised = validatedBackup.binders.map(normaliseBackupBinder);
        await db.binders.bulkPut(normalised);
      }
      if (validatedBackup.binderSlots.length > 0) {
        await db.binderSlots.bulkPut(validatedBackup.binderSlots);
      }
      if (validatedBackup.wishlist.length > 0) {
        await db.wishlist.bulkPut(validatedBackup.wishlist);
      }
      if (validatedBackup.auditLog.length > 0) {
        await db.auditLog.bulkPut(validatedBackup.auditLog);
      }

      // Settings — preserve current API key if backup lacks one.
      const backupHasApiKey = validatedBackup.settings.some(
        (record) => record.key === SETTINGS_KEYS.pokemonTcgApiKey,
      );
      const settingsToWrite: SettingsRecord[] =
        backupHasApiKey || existingApiKeyRow === undefined
          ? [...validatedBackup.settings]
          : [...validatedBackup.settings, existingApiKeyRow];
      await db.settings.clear();
      if (settingsToWrite.length > 0) {
        await db.settings.bulkPut(settingsToWrite);
      }

      // appMeta — write the backup's metadata, then override the three
      // keys that must reflect the post-restore reality.
      await db.appMeta.clear();
      if (validatedBackup.appMeta.length > 0) {
        await db.appMeta.bulkPut(validatedBackup.appMeta);
      }
      await db.appMeta.put({
        key: APP_META_KEYS.schemaVersion,
        value: SCHEMA_VERSION,
        updatedAt: restoredAt,
      });
      await db.appMeta.put({
        key: APP_META_KEYS.lastBackupAt,
        value: validatedBackup.exportedAt,
        updatedAt: restoredAt,
      });
      await db.appMeta.put({
        key: APP_META_KEYS.lastMigrationAt,
        value: restoredAt,
        updatedAt: restoredAt,
      });

      // 4. Audit entry inside the same transaction so it commits
      //    atomically with the new state.
      await db.auditLog.add({
        id: newId(),
        action: 'backup_restored',
        entityType: 'system',
        entityId: null,
        message: `restored from backup exported ${validatedBackup.exportedAt}`,
        createdAt: restoredAt,
      });
    },
  );

  // PR 21 — invalidate the in-memory `cards` and `sets` caches now
  // that the transaction has committed a fresh generation. Without
  // this every view mounted before the next page reload would still
  // see the old card list (cardsRepo.list reads through the cache).
  invalidateCardCache(db);
  invalidateSetCache(db);

  return { preRestoreBackup, restoredAt };
}
