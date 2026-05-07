// Dexie schema definition. The version chain is the single source of
// truth for migrations: every later schema change appends a new
// `db.version(N).stores({...}).upgrade(...)` block, never edits an
// existing one.

import type Dexie from 'dexie';

import { presetForLegacyRow } from '../domain/binder-presets';

export const DATABASE_NAME = 'pokemon-tcg-tracker';

/**
 * Current schema version. PR 14 bumped this from 1 → 2 to add the
 * `binderPreset` field on every persisted binder row (the field
 * itself is not indexed; the bump exists so we can run the v1→v2
 * upgrade hook to back-fill the field on existing rows).
 */
export const SCHEMA_VERSION = 2;

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

// PR 14 introduces `binderPreset` on `BinderRecord`. We do not index
// the field — there are at most a handful of binders per user so a
// linear scan is fine, and an index would just add migration cost.
// The schema string therefore matches v1; only the upgrade hook is new.
const SCHEMA_V2 = SCHEMA_V1;

export const STORE_NAMES = Object.keys(SCHEMA_V1) as ReadonlyArray<
  keyof typeof SCHEMA_V1
>;

export function applySchema(db: Dexie): void {
  db.version(1).stores(SCHEMA_V1);
  db.version(2)
    .stores(SCHEMA_V2)
    .upgrade(async (trans) => {
      // Back-fill `binderPreset` for every existing binder row.
      //   - 18-slot binders → 'legacy_18'
      //   - everything else → 'custom'
      // We deliberately do not try to recognise 9-slot 40-page rows
      // as Vault X 9-pocket. The user's binders before PR 14 were
      // ad-hoc; mapping them to a Vault X preset would change the
      // displayed preset label without any user signal.
      const table = trans.table('binders');
      await table.toCollection().modify((row: { binderPreset?: unknown; slotsPerPage?: unknown }) => {
        if (row.binderPreset !== undefined && row.binderPreset !== null) return;
        const slots =
          typeof row.slotsPerPage === 'number' ? row.slotsPerPage : 9;
        row.binderPreset = presetForLegacyRow(slots);
      });
    });
}
