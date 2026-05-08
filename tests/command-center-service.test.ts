// PR 27 — command center service. Pure tests, no DB.

import { describe, expect, it } from 'vitest';

import {
  buildCommandCenterItems,
  type CommandCenterItem,
} from '../src/services/command-center-service';
import { DEFAULT_PERSONAL_PREFERENCES } from '../src/domain/personal-preferences';
import type { MasterGapDashboardSummary } from '../src/domain/master-set-gap';
import type { DashboardSnapshot } from '../src/services/dashboard-service';
import type { PersonalPreferences } from '../src/domain/personal-preferences';

function masterGap(
  overrides: Partial<MasterGapDashboardSummary> = {},
): MasterGapDashboardSummary {
  return {
    generatedAt: '2026-05-08T00:00:00.000Z',
    binderCount: 1,
    totalTargetSlots: 0,
    complete: 0,
    missing: 0,
    ownedUnplaced: 0,
    ambiguousOwned: 0,
    wishlistWanted: 0,
    wishlistOrdered: 0,
    inLotUnmaterialized: 0,
    invalidCount: 0,
    canPlaceDirectlyCount: 0,
    averageCompletionPercent: 0,
    closestBinder: null,
    weakestBinder: null,
    binders: [],
    ...overrides,
  };
}

function dashboard(
  overrides: Partial<DashboardSnapshot> = {},
): DashboardSnapshot {
  return {
    generatedAt: '2026-05-08T00:00:00.000Z',
    databaseHealth: {
      schemaVersion: 2,
      persistentStorageGranted: true,
      cardCacheCount: 0,
      setCacheCount: 0,
      liveHoldingsCount: 0,
      liveBindersCount: 0,
      liveLotsCount: 0,
    },
    sync: {
      lastSyncAt: '2026-05-08T00:00:00.000Z',
      lastSyncStatus: 'ok',
      lastSyncError: null,
      cardCacheCount: 0,
      setCacheCount: 0,
    },
    backup: {
      lastBackupAt: '2026-05-08T00:00:00.000Z',
      lastBackupHoldingCount: 0,
      liveHoldingsCount: 0,
      holdingsSinceLastBackup: 0,
      daysSinceLastBackup: 0,
      schemaMigratedSinceLastBackup: false,
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
    },
    binders: {
      count: 0,
      averageCompletionPercent: 0,
      totalTargetSlots: 0,
      totalCompletedSlots: 0,
      totalMissingSlots: 0,
      topByCompletion: [],
      bottomByCompletion: [],
      mostMissing: [],
    } as DashboardSnapshot['binders'],
    lots: {
      count: 0,
      unallocatedCount: 0,
      materializedCount: 0,
      imbalancedCount: 0,
      totalsByCurrency: [],
    } as DashboardSnapshot['lots'],
    wishlist: {
      wantedCount: 0,
      orderedCount: 0,
      receivedCount: 0,
      cancelledCount: 0,
      grailItems: [],
    } as DashboardSnapshot['wishlist'],
    actions: [],
    ...overrides,
  };
}

function prefs(
  overrides: Partial<PersonalPreferences> = {},
): PersonalPreferences {
  return { ...DEFAULT_PERSONAL_PREFERENCES, ...overrides };
}

function kinds(items: CommandCenterItem[]): string[] {
  return items.map((i) => i.kind);
}

describe('buildCommandCenterItems (PR 27)', () => {
  // -- empty signals → all_clear or empty -----------------------------
  it('returns a single all_clear item when nothing is actionable and showAllClear=true', () => {
    const items = buildCommandCenterItems({
      masterGap: masterGap(),
      dashboard: dashboard(),
      preferences: prefs(),
    });
    expect(kinds(items)).toEqual(['all_clear']);
    expect(items[0]?.severity).toBe('success');
  });

  it('returns an empty list when nothing is actionable and showAllClear=false', () => {
    const items = buildCommandCenterItems({
      masterGap: masterGap(),
      dashboard: dashboard(),
      preferences: prefs({ commandCenterShowAllClear: false }),
    });
    expect(items).toEqual([]);
  });

  // -- severity ordering ----------------------------------------------
  it('puts critical items first regardless of focus mode', () => {
    const items = buildCommandCenterItems({
      masterGap: masterGap({
        invalidCount: 1,
        canPlaceDirectlyCount: 5,
        ownedUnplaced: 3,
      }),
      dashboard: dashboard(),
      preferences: prefs({ dashboardFocusMode: 'wishlist' }),
    });
    expect(items[0]?.severity).toBe('critical');
    expect(items[0]?.kind).toBe('fix_invalid_slots');
  });

  it('warning items come before info items within the trimmed set', () => {
    const items = buildCommandCenterItems({
      masterGap: masterGap({
        canPlaceDirectlyCount: 1,
        wishlistOrdered: 1,
      }),
      dashboard: dashboard(),
      preferences: prefs(),
    });
    const idxWarning = items.findIndex((i) => i.severity === 'warning');
    const idxInfo = items.findIndex((i) => i.severity === 'info');
    expect(idxWarning).toBeLessThan(idxInfo);
  });

  // -- count gates ----------------------------------------------------
  it('omits items whose source count is zero', () => {
    const items = buildCommandCenterItems({
      masterGap: masterGap({ invalidCount: 0, canPlaceDirectlyCount: 1 }),
      dashboard: dashboard(),
      preferences: prefs(),
    });
    expect(kinds(items)).not.toContain('fix_invalid_slots');
  });

  // -- focus mode boosts ----------------------------------------------
  it('focus mode "wishlist" boosts follow-up-ordered above unrelated info items', () => {
    const items = buildCommandCenterItems({
      masterGap: masterGap({
        wishlistOrdered: 5,
      }),
      dashboard: dashboard({
        collection: {
          ...dashboard().collection,
          missingValueCount: 5,
        },
      }),
      preferences: prefs({ dashboardFocusMode: 'wishlist' }),
    });
    const orderedIdx = items.findIndex((i) => i.kind === 'follow_up_ordered');
    const valueIdx = items.findIndex(
      (i) => i.kind === 'collection_missing_value',
    );
    expect(orderedIdx).toBeGreaterThanOrEqual(0);
    expect(valueIdx).toBeGreaterThanOrEqual(0);
    expect(orderedIdx).toBeLessThan(valueIdx);
  });

  it('focus mode "lots" boosts materialize_lots above other infos', () => {
    const items = buildCommandCenterItems({
      masterGap: masterGap({ inLotUnmaterialized: 3 }),
      dashboard: dashboard({
        collection: {
          ...dashboard().collection,
          missingConditionCount: 5,
        },
      }),
      preferences: prefs({ dashboardFocusMode: 'lots' }),
    });
    const lotsIdx = items.findIndex((i) => i.kind === 'materialize_lots');
    const condIdx = items.findIndex(
      (i) => i.kind === 'collection_missing_condition',
    );
    expect(lotsIdx).toBeGreaterThanOrEqual(0);
    expect(condIdx).toBeGreaterThanOrEqual(0);
    expect(lotsIdx).toBeLessThan(condIdx);
  });

  // -- max items / never-drop-critical --------------------------------
  it('respects commandCenterMaxItems for non-critical items', () => {
    const items = buildCommandCenterItems({
      masterGap: masterGap({
        canPlaceDirectlyCount: 1,
        ownedUnplaced: 1,
        ambiguousOwned: 1,
        wishlistOrdered: 1,
        missing: 1,
        inLotUnmaterialized: 1,
      }),
      dashboard: dashboard(),
      preferences: prefs({ commandCenterMaxItems: 3 }),
    });
    expect(items.length).toBeLessThanOrEqual(3);
  });

  it('never drops critical items even if max is exceeded', () => {
    const items = buildCommandCenterItems({
      masterGap: masterGap({
        invalidCount: 1,
        canPlaceDirectlyCount: 1,
        ownedUnplaced: 1,
      }),
      dashboard: dashboard(),
      preferences: prefs({ commandCenterMaxItems: 1 }),
    });
    expect(items.find((i) => i.severity === 'critical')).toBeDefined();
  });

  // -- target shape ---------------------------------------------------
  it('items have a hash target so the dashboard can route on click', () => {
    const items = buildCommandCenterItems({
      masterGap: masterGap({ canPlaceDirectlyCount: 1 }),
      dashboard: dashboard(),
      preferences: prefs(),
    });
    expect(items[0]?.target).toEqual({
      type: 'hash',
      hash: '#master-gap',
    });
  });

  it('all_clear has target type none', () => {
    const items = buildCommandCenterItems({
      masterGap: masterGap(),
      dashboard: dashboard(),
      preferences: prefs(),
    });
    expect(items[0]?.target).toEqual({ type: 'none' });
  });

  // -- dashboard-only signals ----------------------------------------
  it('emits collection items from dashboard snapshot even when masterGap is null', () => {
    const items = buildCommandCenterItems({
      masterGap: null,
      dashboard: dashboard({
        collection: {
          ...dashboard().collection,
          missingConditionCount: 4,
          notInBinderCount: 2,
        },
      }),
      preferences: prefs(),
    });
    expect(kinds(items)).toContain('collection_missing_condition');
    expect(kinds(items)).toContain('collection_not_in_binder');
  });

  it('survives masterGap=null AND dashboard=null (returns all_clear if enabled)', () => {
    const items = buildCommandCenterItems({
      masterGap: null,
      dashboard: null,
      preferences: prefs(),
    });
    expect(kinds(items)).toEqual(['all_clear']);
  });

  // -- ambiguous owned (PR 27 aggregate) ------------------------------
  it('surfaces ambiguous_owned when masterGap.ambiguousOwned > 0', () => {
    const items = buildCommandCenterItems({
      masterGap: masterGap({ ambiguousOwned: 4 }),
      dashboard: dashboard(),
      preferences: prefs(),
    });
    expect(kinds(items)).toContain('resolve_ambiguous_owned');
  });

  // -- backup / sync derived from dashboard actions -------------------
  it('lifts a backup_never action into the command list as backup_needed', () => {
    const items = buildCommandCenterItems({
      masterGap: null,
      dashboard: dashboard({
        actions: [
          {
            id: 'backup_never',
            severity: 'critical',
            title: 'Aldri tatt backup',
            message: 'Eksporter en backup nå.',
            goTo: 'backup',
          },
        ],
      }),
      preferences: prefs(),
    });
    const item = items.find((i) => i.kind === 'backup_needed');
    expect(item).toBeDefined();
    expect(item?.severity).toBe('critical');
    expect(item?.target).toEqual({ type: 'hash', hash: '#backup' });
  });

  it('lifts a sync_failed action into the command list as sync_needed', () => {
    const items = buildCommandCenterItems({
      masterGap: null,
      dashboard: dashboard({
        actions: [
          {
            id: 'sync_failed',
            severity: 'warning',
            title: 'Sync feilet',
            message: 'Forrige synk feilet.',
            goTo: 'settings',
          },
        ],
      }),
      preferences: prefs(),
    });
    const item = items.find((i) => i.kind === 'sync_needed');
    expect(item).toBeDefined();
    expect(item?.target).toEqual({ type: 'hash', hash: '#settings' });
  });

  // -- canPlaceDirectly / ownedUnplaced overlap (review patch) -------
  // canPlaceDirectlyCount is a subset of ownedUnplaced. The command
  // center must subtract so we don't surface two near-duplicate
  // "place owned" items. Documented case: 10 owned-unplaced, 6 of
  // them placeable → direct=6, remaining=4.
  it('canPlaceDirectly + ownedUnplaced do not double-count (review patch)', () => {
    const items = buildCommandCenterItems({
      masterGap: masterGap({
        ownedUnplaced: 10,
        canPlaceDirectlyCount: 6,
      }),
      dashboard: dashboard(),
      preferences: prefs(),
    });
    const placeOwnedItems = items.filter(
      (i) => i.kind === 'place_owned_cards',
    );
    expect(placeOwnedItems).toHaveLength(2);
    // First in priority is the direct-placement item (kind order 1).
    expect(placeOwnedItems[0]?.title).toBe('Plasser kort du allerede eier');
    expect(placeOwnedItems[0]?.count).toBe(6);
    expect(placeOwnedItems[1]?.title).toBe('Rydd eide kort inn i permer');
    expect(placeOwnedItems[1]?.count).toBe(4);
  });

  it('canPlaceDirectly equal to ownedUnplaced suppresses the manual-rest item', () => {
    // When every owned-unplaced is directly placeable, only the
    // direct-placement item should appear; the "remaining manual"
    // bucket would be 0 and is dropped.
    const items = buildCommandCenterItems({
      masterGap: masterGap({
        ownedUnplaced: 4,
        canPlaceDirectlyCount: 4,
      }),
      dashboard: dashboard(),
      preferences: prefs(),
    });
    const placeOwnedItems = items.filter(
      (i) => i.kind === 'place_owned_cards',
    );
    expect(placeOwnedItems).toHaveLength(1);
    expect(placeOwnedItems[0]?.title).toBe('Plasser kort du allerede eier');
    expect(placeOwnedItems[0]?.count).toBe(4);
  });

  it('ownedUnplaced with no direct candidates only surfaces the manual-rest item', () => {
    const items = buildCommandCenterItems({
      masterGap: masterGap({
        ownedUnplaced: 5,
        canPlaceDirectlyCount: 0,
      }),
      dashboard: dashboard(),
      preferences: prefs(),
    });
    const placeOwnedItems = items.filter(
      (i) => i.kind === 'place_owned_cards',
    );
    expect(placeOwnedItems).toHaveLength(1);
    expect(placeOwnedItems[0]?.title).toBe('Rydd eide kort inn i permer');
    expect(placeOwnedItems[0]?.count).toBe(5);
  });

  // -- multiple critical items keep stable order ----------------------
  it('multiple critical items stay in a stable kind order', () => {
    const items = buildCommandCenterItems({
      masterGap: masterGap({ invalidCount: 1 }),
      dashboard: dashboard({
        actions: [
          {
            id: 'backup_never',
            severity: 'critical',
            title: 'Aldri tatt backup',
            message: 'Eksporter nå.',
            goTo: 'backup',
          },
        ],
      }),
      preferences: prefs(),
    });
    const criticals = items.filter((i) => i.severity === 'critical');
    expect(criticals.length).toBe(2);
    // fix_invalid_slots (kind order 0) must come before backup_needed
    // (kind order 10).
    expect(criticals[0]?.kind).toBe('fix_invalid_slots');
    expect(criticals[1]?.kind).toBe('backup_needed');
  });
});
