// Key/value store for system metadata. Unlike `settings`, app-meta values
// (schemaVersion, lastSyncAt, lastBackupAt, …) are written by the app
// itself, not the user, so writes do *not* append audit entries: the
// init code, sync code, and backup code emit their own audit lines.
//
// Like `settings`, the public surface is read + write + list only. No
// generic `delete(key)` in MVP; later PRs can add a narrow named method
// if a real need arises.

import { nowIso } from '../utils/dates';
import type { AppMetaKey, AppMetaRecord } from '../domain/types';
import type { PokemonTrackerDB } from '../db/database';

export interface AppMetaRepo {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  all(): Promise<AppMetaRecord[]>;
}

export function createAppMetaRepo(db: PokemonTrackerDB): AppMetaRepo {
  return {
    async get<T>(key: string): Promise<T | undefined> {
      const row = await db.appMeta.get(key);
      return row?.value as T | undefined;
    },

    async set(key, value) {
      const record: AppMetaRecord = {
        key,
        value,
        updatedAt: nowIso(),
      };
      await db.appMeta.put(record);
    },

    async all() {
      return db.appMeta.toArray();
    },
  };
}

export type { AppMetaKey };
