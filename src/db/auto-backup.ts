// Pre-restore safety net. Before a destructive replace-restore, the app
// snapshots the current database to a JSON string the caller can offer
// for download. This is *best-effort*: any failure surfaces as
// `{ ok: false, error }` rather than throwing, so the caller (the
// Backup view, or a future automated path) can decide whether to ask
// for an explicit "proceed without pre-restore backup" confirmation.
//
// Unlike `exportToBackupFile()`, this does NOT touch live `appMeta` or
// the audit log. The pre-restore backup is auxiliary and never claims
// to be the user's "real" backup of record.

import { buildBackupFileName, readBackupSnapshot, serializeBackupToJson } from './backup';
import type { PokemonTrackerDB } from './database';

export interface AutoBackupOk {
  readonly ok: true;
  readonly filename: string;
  readonly json: string;
}

export interface AutoBackupFail {
  readonly ok: false;
  readonly error: Error;
}

export type AutoBackupResult = AutoBackupOk | AutoBackupFail;

export async function tryPreRestoreAutoBackup(
  db: PokemonTrackerDB,
): Promise<AutoBackupResult> {
  try {
    const backup = await readBackupSnapshot(db, { includeApiKey: false });
    const json = serializeBackupToJson(backup);
    const baseName = buildBackupFileName(new Date(backup.exportedAt));
    const filename = baseName.replace(
      'pokemon-tracker-backup-v1',
      'pre-restore-backup',
    );
    return { ok: true, filename, json };
  } catch (caught) {
    const error =
      caught instanceof Error ? caught : new Error(String(caught));
    return { ok: false, error };
  }
}
