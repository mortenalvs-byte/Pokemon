// `cards` is API cache. Same shape as sets-repo: replaceable, no soft
// delete, no audit log.

import type { CardRecord } from '../domain/types';
import type { PokemonTrackerDB } from '../db/database';

export interface CardsRepo {
  upsert(record: CardRecord): Promise<void>;
  upsertMany(records: readonly CardRecord[]): Promise<void>;
  get(id: string): Promise<CardRecord | undefined>;
  list(): Promise<CardRecord[]>;
  listBySet(setId: string): Promise<CardRecord[]>;
  listByRarity(rarity: string): Promise<CardRecord[]>;
  count(): Promise<number>;
  clear(): Promise<void>;
}

export function createCardsRepo(db: PokemonTrackerDB): CardsRepo {
  return {
    async upsert(record) {
      await db.cards.put(record);
    },
    async upsertMany(records) {
      await db.cards.bulkPut(records as CardRecord[]);
    },
    async get(id) {
      return db.cards.get(id);
    },
    async list() {
      return db.cards.toArray();
    },
    async listBySet(setId) {
      return db.cards.where('setId').equals(setId).toArray();
    },
    async listByRarity(rarity) {
      return db.cards.where('rarity').equals(rarity).toArray();
    },
    async count() {
      return db.cards.count();
    },
    async clear() {
      await db.cards.clear();
    },
  };
}
