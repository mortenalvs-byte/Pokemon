// `sets` is API cache. Replaceable from pokemontcg.io. No soft delete; no
// audit log entries (cache churn would drown the log).

import { getCachedSetList, invalidateSetCache } from '../db/cards-cache';
import type { SetRecord } from '../domain/types';
import type { PokemonTrackerDB } from '../db/database';

export interface SetsRepo {
  upsert(record: SetRecord): Promise<void>;
  upsertMany(records: readonly SetRecord[]): Promise<void>;
  get(id: string): Promise<SetRecord | undefined>;
  list(): Promise<SetRecord[]>;
  count(): Promise<number>;
  clear(): Promise<void>;
}

export function createSetsRepo(db: PokemonTrackerDB): SetsRepo {
  return {
    async upsert(record) {
      await db.sets.put(record);
      // PR 21 review patch — repo writes must invalidate the
      // per-DB cache so the very next list() call sees this write.
      invalidateSetCache(db);
    },
    async upsertMany(records) {
      await db.sets.bulkPut(records as SetRecord[]);
      invalidateSetCache(db);
    },
    async get(id) {
      return db.sets.get(id);
    },
    async list() {
      // PR 21 — read through the per-DB Promise cache. Repo writes
      // (above) and the sync/restore paths invalidate it on every
      // successful write.
      return getCachedSetList(db);
    },
    async count() {
      return db.sets.count();
    },
    async clear() {
      await db.sets.clear();
      invalidateSetCache(db);
    },
  };
}
