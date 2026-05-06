// Audit log writer. The `auditLog` store is append-only by contract: only
// this module appends entries. No repository or UI module mutates or
// deletes audit rows.

import { nowIso } from '../utils/dates';
import { newId } from '../utils/ids';
import type { AuditEntityType, AuditLogRecord } from '../domain/types';
import type { PokemonTrackerDB } from './database';

export interface AuditInput {
  action: string;
  entityType: AuditEntityType;
  entityId: string | null;
  message: string;
}

export async function appendAudit(
  db: PokemonTrackerDB,
  entry: AuditInput,
): Promise<AuditLogRecord> {
  const record: AuditLogRecord = {
    id: newId(),
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    message: entry.message,
    createdAt: nowIso(),
  };
  await db.auditLog.add(record);
  return record;
}
