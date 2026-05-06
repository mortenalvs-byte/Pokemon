import { nowIso } from '../utils/dates';
import { newId } from '../utils/ids';
import type { WishlistRecord } from '../domain/types';
import {
  validateWishlistInput,
  type WishlistInput,
} from '../domain/validators';
import { appendAudit } from '../db/audit';
import type { PokemonTrackerDB } from '../db/database';
import {
  listLive,
  restoreRecord,
  softDeleteRecord,
} from '../db/soft-delete';

export interface WishlistRepo {
  create(input: WishlistInput): Promise<WishlistRecord>;
  get(id: string): Promise<WishlistRecord | undefined>;
  list(): Promise<WishlistRecord[]>;
  listLive(): Promise<WishlistRecord[]>;
  update(
    id: string,
    changes: Partial<WishlistInput>,
  ): Promise<WishlistRecord>;
  softDelete(id: string, reason?: string): Promise<void>;
  restore(id: string, reason?: string): Promise<void>;
}

export function createWishlistRepo(db: PokemonTrackerDB): WishlistRepo {
  return {
    async create(input) {
      validateWishlistInput(input);
      const now = nowIso();
      const record: WishlistRecord = {
        ...input,
        id: newId(),
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      await db.wishlist.add(record);
      await appendAudit(db, {
        action: 'wishlist_item_created',
        entityType: 'wishlist',
        entityId: record.id,
        message: `wishlist: card ${record.cardId} (${record.priority})`,
      });
      return record;
    },

    async get(id) {
      return db.wishlist.get(id);
    },

    async list() {
      return db.wishlist.toArray();
    },

    async listLive() {
      return listLive(db.wishlist);
    },

    async update(id, changes) {
      const existing = await db.wishlist.get(id);
      if (existing === undefined) {
        throw new Error(`wishlist ${id} not found`);
      }
      const merged: WishlistRecord = {
        ...existing,
        ...changes,
        id: existing.id,
        createdAt: existing.createdAt,
        deletedAt: existing.deletedAt,
        updatedAt: nowIso(),
      };
      validateWishlistInput(merged);
      await db.wishlist.put(merged);
      await appendAudit(db, {
        action: 'wishlist_item_updated',
        entityType: 'wishlist',
        entityId: id,
        message: `wishlist: card ${merged.cardId} status=${merged.status}`,
      });
      return merged;
    },

    async softDelete(id, reason) {
      await softDeleteRecord(
        db,
        db.wishlist,
        'wishlist',
        id,
        reason ?? 'soft-deleted wishlist item',
      );
    },

    async restore(id, reason) {
      await restoreRecord(
        db,
        db.wishlist,
        'wishlist',
        id,
        reason ?? 'restored wishlist item',
      );
    },
  };
}
