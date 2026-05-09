// PR 28 — command-center split between recommended ambiguous and
// manual ambiguous, plus focus-mode boost for the new kinds.

import { describe, expect, it } from 'vitest';

import { buildCommandCenterItems } from '../src/services/command-center-service';
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
    recommendedAmbiguousCount: 0,
    manualAmbiguousCount: 0,
    averageCompletionPercent: 0,
    closestBinder: null,
    weakestBinder: null,
    binders: [],
    ...overrides,
  };
}

function dashboard(): DashboardSnapshot {
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
  };
}

function prefs(
  overrides: Partial<PersonalPreferences> = {},
): PersonalPreferences {
  return { ...DEFAULT_PERSONAL_PREFERENCES, ...overrides };
}

describe('command-center best-copy split (PR 28)', () => {
  // 1
  it('recommendedAmbiguousCount creates a place_recommended_copies item', () => {
    const items = buildCommandCenterItems({
      masterGap: masterGap({
        ambiguousOwned: 5,
        recommendedAmbiguousCount: 5,
        manualAmbiguousCount: 0,
      }),
      dashboard: dashboard(),
      preferences: prefs(),
    });
    const rec = items.find((i) => i.kind === 'place_recommended_copies');
    expect(rec).toBeDefined();
    expect(rec?.count).toBe(5);
  });

  // 2
  it('manualAmbiguousCount creates a resolve_manual_ambiguous item', () => {
    const items = buildCommandCenterItems({
      masterGap: masterGap({
        ambiguousOwned: 4,
        recommendedAmbiguousCount: 0,
        manualAmbiguousCount: 4,
      }),
      dashboard: dashboard(),
      preferences: prefs(),
    });
    const manual = items.find((i) => i.kind === 'resolve_manual_ambiguous');
    expect(manual).toBeDefined();
    expect(manual?.count).toBe(4);
  });

  // 3
  it('recommended item sorts before manual item when both present', () => {
    const items = buildCommandCenterItems({
      masterGap: masterGap({
        ambiguousOwned: 6,
        recommendedAmbiguousCount: 4,
        manualAmbiguousCount: 2,
      }),
      dashboard: dashboard(),
      preferences: prefs(),
    });
    const recIdx = items.findIndex(
      (i) => i.kind === 'place_recommended_copies',
    );
    const manIdx = items.findIndex(
      (i) => i.kind === 'resolve_manual_ambiguous',
    );
    expect(recIdx).toBeGreaterThanOrEqual(0);
    expect(manIdx).toBeGreaterThanOrEqual(0);
    expect(recIdx).toBeLessThan(manIdx);
  });

  // 4
  it('critical invalid item still comes before recommended/manual', () => {
    const items = buildCommandCenterItems({
      masterGap: masterGap({
        invalidCount: 1,
        ambiguousOwned: 4,
        recommendedAmbiguousCount: 4,
        manualAmbiguousCount: 0,
      }),
      dashboard: dashboard(),
      preferences: prefs(),
    });
    expect(items[0]?.kind).toBe('fix_invalid_slots');
    expect(items[0]?.severity).toBe('critical');
  });

  // 5
  it('max-items does not drop the critical item even with both ambiguous chips', () => {
    const items = buildCommandCenterItems({
      masterGap: masterGap({
        invalidCount: 1,
        ambiguousOwned: 4,
        recommendedAmbiguousCount: 2,
        manualAmbiguousCount: 2,
        canPlaceDirectlyCount: 1,
        ownedUnplaced: 1,
      }),
      dashboard: dashboard(),
      preferences: prefs({ commandCenterMaxItems: 1 }),
    });
    // Critical survives at minimum.
    expect(items.find((i) => i.severity === 'critical')).toBeDefined();
  });

  // 6
  it('master_set focus boost lifts recommended item above unrelated infos', () => {
    const baseDash = dashboard();
    const dash: DashboardSnapshot = {
      ...baseDash,
      collection: { ...baseDash.collection, missingConditionCount: 5 },
    };
    const items = buildCommandCenterItems({
      masterGap: masterGap({
        ambiguousOwned: 3,
        recommendedAmbiguousCount: 3,
      }),
      dashboard: dash,
      preferences: prefs({ dashboardFocusMode: 'master_set' }),
    });
    const recIdx = items.findIndex(
      (i) => i.kind === 'place_recommended_copies',
    );
    const condIdx = items.findIndex(
      (i) => i.kind === 'collection_missing_condition',
    );
    expect(recIdx).toBeGreaterThanOrEqual(0);
    expect(condIdx).toBeGreaterThanOrEqual(0);
    expect(recIdx).toBeLessThan(condIdx);
  });

  // 7
  it('binder_work focus boost lifts recommended item above unrelated warnings', () => {
    const baseDash = dashboard();
    const dash: DashboardSnapshot = {
      ...baseDash,
      collection: { ...baseDash.collection, duplicateStatusCount: 5 },
    };
    const items = buildCommandCenterItems({
      masterGap: masterGap({
        ambiguousOwned: 3,
        recommendedAmbiguousCount: 3,
      }),
      dashboard: dash,
      preferences: prefs({ dashboardFocusMode: 'binder_work' }),
    });
    const recIdx = items.findIndex(
      (i) => i.kind === 'place_recommended_copies',
    );
    const dupIdx = items.findIndex(
      (i) => i.kind === 'collection_duplicates',
    );
    expect(recIdx).toBeLessThan(dupIdx);
  });

  // 8
  it('all_clear is suppressed when recommendation items exist', () => {
    const items = buildCommandCenterItems({
      masterGap: masterGap({
        ambiguousOwned: 1,
        recommendedAmbiguousCount: 1,
      }),
      dashboard: dashboard(),
      preferences: prefs(),
    });
    expect(items.find((i) => i.kind === 'all_clear')).toBeUndefined();
  });

  // 9
  it('command-center action target for recommendation chip is #master-gap', () => {
    const items = buildCommandCenterItems({
      masterGap: masterGap({
        ambiguousOwned: 1,
        recommendedAmbiguousCount: 1,
      }),
      dashboard: dashboard(),
      preferences: prefs(),
    });
    const rec = items.find((i) => i.kind === 'place_recommended_copies');
    expect(rec?.target).toEqual({ type: 'hash', hash: '#master-gap' });
  });
});
