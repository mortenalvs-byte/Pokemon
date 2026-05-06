import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { appendAudit } from '../src/db/audit';
import { closeAndDelete, freshDb } from './helpers/fresh-db';
import type { PokemonTrackerDB } from '../src/db/database';

describe('audit log', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    db = await freshDb();
  });

  afterEach(async () => {
    await closeAndDelete(db);
  });

  it('appendAudit() writes a record with id, createdAt, and the given fields', async () => {
    const record = await appendAudit(db, {
      action: 'holding_created',
      entityType: 'holding',
      entityId: 'abc-123',
      message: 'created Charizard NM',
    });

    expect(record.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(typeof record.createdAt).toBe('string');
    expect(Date.parse(record.createdAt)).not.toBeNaN();
    expect(record.action).toBe('holding_created');
    expect(record.entityType).toBe('holding');
    expect(record.entityId).toBe('abc-123');
    expect(record.message).toBe('created Charizard NM');

    const persisted = await db.auditLog.get(record.id);
    expect(persisted).toEqual(record);
  });

  it('accepts only the documented entityType union (compile-time guard)', async () => {
    // The cast below is intentional: TypeScript already prevents invalid
    // entityType values in source, so we only need to confirm at runtime
    // that legal values round-trip cleanly.
    const legal: ReadonlyArray<
      'holding' | 'binder' | 'binderSlot' | 'lot' | 'lotItem' | 'wishlist' | 'settings' | 'system'
    > = [
      'holding',
      'binder',
      'binderSlot',
      'lot',
      'lotItem',
      'wishlist',
      'settings',
      'system',
    ];
    for (const entityType of legal) {
      await appendAudit(db, {
        action: 'test_action',
        entityType,
        entityId: null,
        message: `seeded ${entityType}`,
      });
    }
    const all = await db.auditLog.toArray();
    expect(all).toHaveLength(legal.length);
  });

  it('writes one audit entry per appendAudit call', async () => {
    // Five rapid inserts can land on the same millisecond, so order by
    // createdAt is best-effort. The contract this test pins is just:
    // every call produces exactly one new row.
    for (let i = 0; i < 5; i += 1) {
      await appendAudit(db, {
        action: 'sequence_test',
        entityType: 'system',
        entityId: null,
        message: `entry ${i}`,
      });
    }
    const entries = await db.auditLog
      .where('action')
      .equals('sequence_test')
      .toArray();
    expect(entries).toHaveLength(5);
    const messages = entries.map((e) => e.message).sort();
    expect(messages).toEqual([
      'entry 0',
      'entry 1',
      'entry 2',
      'entry 3',
      'entry 4',
    ]);
  });
});
