// JSON backup export. Two layers:
//
//   readBackupSnapshot(db, opts) — pure read. Builds a `BackupFile` from
//   every store. No live-DB side effects. Used by both real exports and
//   the pre-restore auto-backup.
//
//   exportToBackupFile(db, opts) — "real" export. Uses readBackupSnapshot,
//   serialises to JSON, builds the conventional filename, and updates
//   live `appMeta` (lastBackupAt, lastBackupHoldingCount) plus a
//   `backup_exported` audit entry. The live-DB writes happen *after* the
//   JSON has been built so the snapshot is captured first and any later
//   write failure cannot corrupt the exported document.

import { nowIso } from '../utils/dates';
import {
  APP_META_KEYS,
  SETTINGS_KEYS,
  type BackupFile,
  type SettingsRecord,
} from '../domain/types';
import { appendAudit } from './audit';
import type { PokemonTrackerDB } from './database';
import { SCHEMA_VERSION } from './schema';

export const BACKUP_APP_LITERAL = 'Pokemon TCG Tracker' as const;

export interface ExportOptions {
  /**
   * Whether to include `settings.pokemonTcgApiKey` in the export.
   * Default: false. Even when true, the caller is expected to flag
   * the resulting file plainly to the user (see BACKUP_FORMAT.md §3).
   */
  readonly includeApiKey?: boolean;
}

export interface BackupExport {
  readonly backup: BackupFile;
  readonly json: string;
  readonly filename: string;
}

// ---------------------------------------------------------------------
// Pure read

export async function readBackupSnapshot(
  db: PokemonTrackerDB,
  options: ExportOptions = {},
): Promise<BackupFile> {
  const includeApiKey = options.includeApiKey === true;

  const [
    sets,
    cards,
    holdings,
    lots,
    lotItems,
    binders,
    binderSlots,
    wishlist,
    auditLog,
    rawSettings,
    appMeta,
  ] = await Promise.all([
    db.sets.toArray(),
    db.cards.toArray(),
    db.holdings.toArray(),
    db.lots.toArray(),
    db.lotItems.toArray(),
    db.binders.toArray(),
    db.binderSlots.toArray(),
    db.wishlist.toArray(),
    db.auditLog.toArray(),
    db.settings.toArray(),
    db.appMeta.toArray(),
  ]);

  const settings = includeApiKey
    ? rawSettings
    : rawSettings.filter(
        (record) => record.key !== SETTINGS_KEYS.pokemonTcgApiKey,
      );

  return {
    app: BACKUP_APP_LITERAL,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: nowIso(),
    settings,
    sets,
    cards,
    holdings,
    lots,
    lotItems,
    binders,
    binderSlots,
    wishlist,
    auditLog,
    appMeta,
  };
}

// ---------------------------------------------------------------------
// Serialization

export function serializeBackupToJson(backup: BackupFile): string {
  return JSON.stringify(backup, null, 2);
}

export function buildBackupFileName(now: Date = new Date()): string {
  const yyyy = String(now.getUTCFullYear()).padStart(4, '0');
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const mi = String(now.getUTCMinutes()).padStart(2, '0');
  const ss = String(now.getUTCSeconds()).padStart(2, '0');
  return `pokemon-tracker-backup-v1-${yyyy}${mm}${dd}-${hh}${mi}${ss}.json`;
}

// ---------------------------------------------------------------------
// Real export — captures the snapshot, then records the export

export async function exportToBackupFile(
  db: PokemonTrackerDB,
  options: ExportOptions = {},
): Promise<BackupExport> {
  // Capture a frozen-in-time snapshot first. Any side effects below
  // happen after the JSON has been built so they cannot leak into the
  // exported bytes.
  const backup = await readBackupSnapshot(db, options);
  const json = serializeBackupToJson(backup);
  const filename = buildBackupFileName(new Date(backup.exportedAt));

  await recordExportSideEffects(db, backup);

  return { backup, json, filename };
}

async function recordExportSideEffects(
  db: PokemonTrackerDB,
  backup: BackupFile,
): Promise<void> {
  const now = nowIso();
  const liveHoldingCount = backup.holdings.filter(
    (record) => record.deletedAt === null,
  ).length;

  await db.appMeta.put({
    key: APP_META_KEYS.lastBackupAt,
    value: backup.exportedAt,
    updatedAt: now,
  });
  await db.appMeta.put({
    key: APP_META_KEYS.lastBackupHoldingCount,
    value: liveHoldingCount,
    updatedAt: now,
  });

  await appendAudit(db, {
    action: 'backup_exported',
    entityType: 'system',
    entityId: null,
    message: `exported ${describeRecordCounts(backup)}`,
  });
}

function describeRecordCounts(backup: BackupFile): string {
  return `${backup.cards.length} cards, ${backup.holdings.length} holdings, ${backup.binders.length} binders, ${backup.lots.length} lots`;
}

// Re-export the SettingsRecord shape so backup.test.ts can build sample
// settings rows without leaking the Domain types module path.
export type { SettingsRecord };
