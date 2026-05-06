// Dexie schema definition. The version chain is the single source of
// truth for migrations: every later schema change appends a new
// `db.version(N).stores({...}).upgrade(...)` block, never edits an
// existing one.

import type Dexie from 'dexie';

export const DATABASE_NAME = 'pokemon-tcg-tracker';

export const SCHEMA_VERSION = 1;

// Schema strings. First field is the primary key; the rest are indexes.
//   * prefix = multi-entry index (for arrays)
//   [a+b]   = compound index
// User-owned stores include `deletedAt` so soft-delete-aware queries can
// filter on it. Cache stores omit it; they are wiped and reseeded by
// API sync, never soft-deleted.
const SCHEMA_V1 = {
  // Cache (replaceable)
  sets: 'id, releaseDate, series',
  cards: 'id, setId, name, number, rarity',

  // User-owned (sacred)
  holdings: 'id, cardId, lotId, status, deletedAt, *tags',
  lots: 'id, purchaseDate, deletedAt',
  lotItems: 'id, lotId, cardId, holdingId, deletedAt',
  binders: 'id, name, sourceSetId, deletedAt',
  binderSlots:
    'id, [binderId+pageNumber+slotNumber], binderId, targetCardId, holdingId, status, deletedAt',
  wishlist: 'id, cardId, priority, status, deletedAt',
  auditLog: 'id, createdAt, action, entityType, entityId',

  // Key/value stores
  settings: 'key',
  appMeta: 'key',
} as const;

export const STORE_NAMES = Object.keys(SCHEMA_V1) as ReadonlyArray<
  keyof typeof SCHEMA_V1
>;

export function applySchema(db: Dexie): void {
  db.version(SCHEMA_VERSION).stores(SCHEMA_V1);
  // PR 4 and later append `db.version(N+1).stores(...).upgrade(...)`
  // blocks here. Existing version blocks are immutable.
}
