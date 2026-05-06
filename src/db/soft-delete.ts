// Soft-delete helpers shared by every user-owned repository. Setting
// `deletedAt` to a timestamp marks the record as deleted; resetting it to
// `null` restores it. Permanent delete is intentionally not exposed here
// — it requires an explicit approval PR per PR_RULES §7.

import type { Table } from 'dexie';

import { nowIso } from '../utils/dates';
import type { AuditEntityType } from '../domain/types';
import { appendAudit } from './audit';
import type { PokemonTrackerDB } from './database';

export interface SoftDeletable {
  id: string;
  deletedAt: string | null;
  updatedAt: string;
}

export async function softDeleteRecord<T extends SoftDeletable>(
  db: PokemonTrackerDB,
  table: Table<T, string>,
  entityType: AuditEntityType,
  id: string,
  message: string,
): Promise<void> {
  const existing = await table.get(id);
  if (existing === undefined) {
    throw new Error(`${entityType} ${id} not found`);
  }
  if (existing.deletedAt !== null) {
    return; // already deleted; idempotent
  }
  const now = nowIso();
  // Use put() with a fully merged record so we sidestep Dexie's strict
  // UpdateSpec typing while preserving all fields exactly.
  const merged = {
    ...existing,
    deletedAt: now,
    updatedAt: now,
  };
  await table.put(merged);
  await appendAudit(db, {
    action: `${entityType}_soft_deleted`,
    entityType,
    entityId: id,
    message,
  });
}

export async function restoreRecord<T extends SoftDeletable>(
  db: PokemonTrackerDB,
  table: Table<T, string>,
  entityType: AuditEntityType,
  id: string,
  message: string,
): Promise<void> {
  const existing = await table.get(id);
  if (existing === undefined) {
    throw new Error(`${entityType} ${id} not found`);
  }
  if (existing.deletedAt === null) {
    return; // already live; idempotent
  }
  const now = nowIso();
  const merged = {
    ...existing,
    deletedAt: null,
    updatedAt: now,
  };
  await table.put(merged);
  await appendAudit(db, {
    action: `${entityType}_restored`,
    entityType,
    entityId: id,
    message,
  });
}

export async function listLive<T extends SoftDeletable>(
  table: Table<T, string>,
): Promise<T[]> {
  // IndexedDB does not index `null` consistently across browsers, so we
  // filter in memory. This is acceptable at the MVP scale (≤ ~10k holdings)
  // and avoids cross-browser surprises.
  return table.filter((record) => record.deletedAt === null).toArray();
}

export async function listDeleted<T extends SoftDeletable>(
  table: Table<T, string>,
): Promise<T[]> {
  return table.filter((record) => record.deletedAt !== null).toArray();
}
