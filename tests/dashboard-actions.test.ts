// Pure tests for the dashboard-actions rules engine.
// No DB. The function takes a snapshot and returns ActionItem[].

import { describe, expect, it } from 'vitest';

import {
  BACKUP_OLD_DAYS,
  HOLDINGS_SINCE_BACKUP_THRESHOLD,
  computeActionItems,
  filterStripItems,
} from '../src/domain/dashboard-actions';
import type { DashboardSnapshot } from '../src/services/dashboard-service';

function snapshot(
  overrides: {
    backup?: Partial<DashboardSnapshot['backup']>;
    sync?: Partial<DashboardSnapshot['sync']>;
    databaseHealth?: Partial<DashboardSnapshot['databaseHealth']>;
    collection?: Partial<DashboardSnapshot['collection']>;
    binders?: Partial<DashboardSnapshot['binders']>;
    lots?: Partial<DashboardSnapshot['lots']>;
    wishlist?: Partial<DashboardSnapshot['wishlist']>;
  } = {},
): DashboardSnapshot {
  return {
    generatedAt: '2026-05-07T12:00:00.000Z',
    databaseHealth: {
      schemaVersion: 1,
      persistentStorageGranted: true,
      cardCacheCount: 0,
      setCacheCount: 0,
      liveHoldingsCount: 0,
      liveBindersCount: 0,
      liveLotsCount: 0,
      ...overrides.databaseHealth,
    },
    sync: {
      lastSyncAt: null,
      lastSyncStatus: null,
      lastSyncError: null,
      cardCacheCount: 0,
      setCacheCount: 0,
      ...overrides.sync,
    },
    backup: {
      lastBackupAt: '2026-05-07T00:00:00.000Z',
      lastBackupHoldingCount: 0,
      liveHoldingsCount: 0,
      holdingsSinceLastBackup: 0,
      daysSinceLastBackup: 0,
      schemaMigratedSinceLastBackup: false,
      ...overrides.backup,
    },
    collection: {
      liveCount: 0,
      deletedCount: 0,
      uniqueCardIds: 0,
      rawCount: 0,
      gradedCount: 0,
      missingConditionCount: 0,
      missingValueCount: 0,
      notInBinderCount: 0,
      duplicateStatusCount: 0,
      upgradeNeededCount: 0,
      ...overrides.collection,
    },
    binders: {
      count: 0,
      averageCompletionPercent: 0,
      totalTargetSlots: 0,
      totalCompletedSlots: 0,
      totalMissingSlots: 0,
      topByCompletion: [],
      ...overrides.binders,
    },
    lots: {
      count: 0,
      totalsByCurrency: [],
      unallocatedCount: 0,
      materializedCount: 0,
      imbalancedCount: 0,
      ...overrides.lots,
    },
    wishlist: {
      wantedCount: 0,
      orderedCount: 0,
      receivedCount: 0,
      cancelledCount: 0,
      grailItems: [],
      ...overrides.wishlist,
    },
    actions: [],
  };
}

describe('computeActionItems', () => {
  it('flags "never backed up" as critical when lastBackupAt is null', () => {
    const items = computeActionItems(
      snapshot({ backup: { lastBackupAt: null, daysSinceLastBackup: null } }),
    );
    const ids = items.map((i) => i.id);
    expect(ids).toContain('backup_never');
    const item = items.find((i) => i.id === 'backup_never');
    expect(item?.severity).toBe('critical');
  });

  it(`triggers "backup_old" only when daysSinceLastBackup > ${BACKUP_OLD_DAYS}`, () => {
    const exactlySeven = computeActionItems(
      snapshot({
        backup: {
          daysSinceLastBackup: BACKUP_OLD_DAYS,
          lastBackupAt: '2026-04-30T00:00:00.000Z',
        },
      }),
    );
    expect(exactlySeven.find((i) => i.id === 'backup_old')).toBeUndefined();
    const eight = computeActionItems(
      snapshot({
        backup: {
          daysSinceLastBackup: BACKUP_OLD_DAYS + 1,
          lastBackupAt: '2026-04-29T00:00:00.000Z',
        },
      }),
    );
    expect(eight.find((i) => i.id === 'backup_old')?.severity).toBe('warning');
  });

  it('flags "schema migrated since backup" when the boolean is true', () => {
    const items = computeActionItems(
      snapshot({
        backup: {
          schemaMigratedSinceLastBackup: true,
          lastBackupAt: '2026-04-29T00:00:00.000Z',
          daysSinceLastBackup: 1,
        },
      }),
    );
    expect(
      items.find((i) => i.id === 'backup_after_migration')?.severity,
    ).toBe('warning');
  });

  it(`flags "many holdings since backup" only when delta > ${HOLDINGS_SINCE_BACKUP_THRESHOLD}`, () => {
    const exact = computeActionItems(
      snapshot({
        backup: {
          holdingsSinceLastBackup: HOLDINGS_SINCE_BACKUP_THRESHOLD,
          daysSinceLastBackup: 1,
          lastBackupAt: '2026-05-06T00:00:00.000Z',
        },
      }),
    );
    expect(
      exact.find((i) => i.id === 'backup_holdings_drift'),
    ).toBeUndefined();
    const above = computeActionItems(
      snapshot({
        backup: {
          holdingsSinceLastBackup: HOLDINGS_SINCE_BACKUP_THRESHOLD + 1,
          daysSinceLastBackup: 1,
          lastBackupAt: '2026-05-06T00:00:00.000Z',
        },
      }),
    );
    expect(
      above.find((i) => i.id === 'backup_holdings_drift')?.severity,
    ).toBe('warning');
  });

  it('flags storage when persistentStorageGranted is false', () => {
    const items = computeActionItems(
      snapshot({ databaseHealth: { persistentStorageGranted: false } }),
    );
    expect(
      items.find((i) => i.id === 'storage_not_persistent')?.severity,
    ).toBe('warning');
  });

  it('flags sync_failed when lastSyncStatus = failed', () => {
    const items = computeActionItems(
      snapshot({ sync: { lastSyncStatus: 'failed', lastSyncError: 'boom' } }),
    );
    const item = items.find((i) => i.id === 'sync_failed');
    expect(item?.severity).toBe('warning');
    expect(item?.message).toContain('boom');
  });

  it('flags lots_unallocated as warning when count > 0', () => {
    const items = computeActionItems(snapshot({ lots: { unallocatedCount: 2 } }));
    expect(items.find((i) => i.id === 'lots_unallocated')?.severity).toBe(
      'warning',
    );
  });

  it('emits info-severity items for collection / binders flags', () => {
    const items = computeActionItems(
      snapshot({
        collection: {
          missingConditionCount: 3,
          missingValueCount: 4,
          notInBinderCount: 5,
        },
        binders: { totalMissingSlots: 6 },
      }),
    );
    const ids = items.map((i) => i.id);
    expect(ids).toContain('holdings_missing_condition');
    expect(ids).toContain('holdings_missing_value');
    expect(ids).toContain('holdings_not_in_binder');
    expect(ids).toContain('binder_slots_missing');
    for (const id of [
      'holdings_missing_condition',
      'holdings_missing_value',
      'holdings_not_in_binder',
      'binder_slots_missing',
    ]) {
      expect(items.find((i) => i.id === id)?.severity).toBe('info');
    }
  });

  it('sorts by severity (critical, warning, info)', () => {
    const items = computeActionItems(
      snapshot({
        backup: {
          lastBackupAt: null,
          daysSinceLastBackup: null,
        },
        databaseHealth: { persistentStorageGranted: false },
        collection: { missingConditionCount: 1 },
      }),
    );
    expect(items[0]?.severity).toBe('critical');
    const lastIdx = items.length - 1;
    expect(items[lastIdx]?.severity).toBe('info');
  });
});

describe('filterStripItems', () => {
  it('drops info items, keeps warning + critical', () => {
    const items = computeActionItems(
      snapshot({
        backup: { lastBackupAt: null, daysSinceLastBackup: null },
        databaseHealth: { persistentStorageGranted: false },
        collection: { missingConditionCount: 1 },
      }),
    );
    const stripped = filterStripItems(items);
    expect(stripped.every((i) => i.severity !== 'info')).toBe(true);
    expect(stripped.length).toBeLessThan(items.length);
  });
});
