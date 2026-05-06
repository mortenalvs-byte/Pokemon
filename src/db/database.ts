// Typed Dexie instance for the tracker. The class binds each store to its
// record type so consumers (repositories, init code, tests) get autocomplete
// and `noUncheckedIndexedAccess`-friendly results.

import { Dexie } from 'dexie';
import type { Table } from 'dexie';

import type {
  AppMetaRecord,
  AuditLogRecord,
  BinderRecord,
  BinderSlotRecord,
  CardRecord,
  HoldingRecord,
  LotItemRecord,
  LotRecord,
  SetRecord,
  SettingsRecord,
  WishlistRecord,
} from '../domain/types';
import { DATABASE_NAME, applySchema } from './schema';

export class PokemonTrackerDB extends Dexie {
  declare sets: Table<SetRecord, string>;
  declare cards: Table<CardRecord, string>;
  declare holdings: Table<HoldingRecord, string>;
  declare lots: Table<LotRecord, string>;
  declare lotItems: Table<LotItemRecord, string>;
  declare binders: Table<BinderRecord, string>;
  declare binderSlots: Table<BinderSlotRecord, string>;
  declare wishlist: Table<WishlistRecord, string>;
  declare auditLog: Table<AuditLogRecord, string>;
  declare settings: Table<SettingsRecord, string>;
  declare appMeta: Table<AppMetaRecord, string>;

  constructor(name: string = DATABASE_NAME) {
    super(name);
    applySchema(this);
  }
}

export function createDatabase(name?: string): PokemonTrackerDB {
  return name === undefined
    ? new PokemonTrackerDB()
    : new PokemonTrackerDB(name);
}

let _singleton: PokemonTrackerDB | null = null;

export function getDb(): PokemonTrackerDB {
  if (_singleton === null) {
    _singleton = createDatabase();
  }
  return _singleton;
}

// Test-only helper. Closes and discards the cached singleton so the next
// `getDb()` rebuilds against whatever IndexedDB instance is current. Not
// exported through any UI surface.
export function _resetDbSingletonForTests(): void {
  if (_singleton !== null) {
    _singleton.close();
    _singleton = null;
  }
}
