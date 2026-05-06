// `sets` is API cache. Replaceable from pokemontcg.io. No soft delete; no
// audit log entries (cache churn would drown the log).

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
    },
    async upsertMany(records) {
      await db.sets.bulkPut(records as SetRecord[]);
    },
    async get(id) {
      return db.sets.get(id);
    },
    async list() {
      return db.sets.toArray();
    },
    async count() {
      return db.sets.count();
    },
    async clear() {
      await db.sets.clear();
    },
  };
}
