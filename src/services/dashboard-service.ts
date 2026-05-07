// Dashboard aggregation. Read-only. Builds a single `DashboardSnapshot`
// from existing repos and services so the dashboard view never touches
// the database directly.
//
// Performance contract (DASHBOARD_SPEC + the user's PR 10 review):
//   - cards.count(), never cardsRepo.list() — keeps the 18k card cache
//     out of memory.
//   - sets.count() likewise.
//   - holdings / binderSlots / lots / lotItems / wishlist all toArray()
//     because their MVP volumes (≤ ~10k holdings; far less for the
//     rest) are fine in memory and the joins need to walk every row.
//
// The service writes nothing. Even reads stay outside the auditLog
// store. Click-throughs from the dashboard navigate to the views that
// own the actual mutation paths.

import { round2 } from '../domain/lot-allocation';
import { calculateBinderCompletion } from '../domain/binder-completion';
import {
  computeActionItems,
  type ActionItem,
} from '../domain/dashboard-actions';
import {
  APP_META_KEYS,
  type CurrencyCode,
  type IsoTimestamp,
  type SyncStatus,
  type WishlistRecord,
} from '../domain/types';
import type { AppMetaRepo } from '../repositories/app-meta-repo';
import type { BindersRepo } from '../repositories/binders-repo';
import type { BinderSlotsRepo } from '../repositories/binder-slots-repo';
import type { CardsRepo } from '../repositories/cards-repo';
import type { HoldingsRepo } from '../repositories/holdings-repo';
import type { LotItemsRepo } from '../repositories/lot-items-repo';
import type { LotsRepo } from '../repositories/lots-repo';
import type { SetsRepo } from '../repositories/sets-repo';
import type { WishlistRepo } from '../repositories/wishlist-repo';
import type { BinderSummary } from './binder-slot-service';

const MS_PER_DAY = 1000 * 60 * 60 * 24;

export interface DashboardSnapshot {
  readonly generatedAt: IsoTimestamp;
  readonly databaseHealth: DatabaseHealthSection;
  readonly sync: SyncSection;
  readonly backup: BackupSection;
  readonly collection: CollectionSection;
  readonly binders: BindersSection;
  readonly lots: LotsSection;
  readonly wishlist: WishlistSection;
  readonly actions: readonly ActionItem[];
}

export interface DatabaseHealthSection {
  readonly schemaVersion: number | null;
  readonly persistentStorageGranted: boolean;
  readonly cardCacheCount: number;
  readonly setCacheCount: number;
  readonly liveHoldingsCount: number;
  readonly liveBindersCount: number;
  readonly liveLotsCount: number;
}

export interface SyncSection {
  readonly lastSyncAt: IsoTimestamp | null;
  readonly lastSyncStatus: SyncStatus | null;
  readonly lastSyncError: string | null;
  readonly cardCacheCount: number;
  readonly setCacheCount: number;
}

export interface BackupSection {
  readonly lastBackupAt: IsoTimestamp | null;
  readonly lastBackupHoldingCount: number | null;
  readonly liveHoldingsCount: number;
  readonly holdingsSinceLastBackup: number;
  readonly daysSinceLastBackup: number | null;
  readonly schemaMigratedSinceLastBackup: boolean;
}

export interface CollectionSection {
  readonly liveCount: number;
  readonly deletedCount: number;
  readonly uniqueCardIds: number;
  readonly rawCount: number;
  readonly gradedCount: number;
  readonly missingConditionCount: number;
  readonly missingValueCount: number;
  readonly notInBinderCount: number;
  readonly duplicateStatusCount: number;
  readonly upgradeNeededCount: number;
}

export interface BindersSection {
  readonly count: number;
  readonly averageCompletionPercent: number;
  readonly totalTargetSlots: number;
  readonly totalCompletedSlots: number;
  readonly totalMissingSlots: number;
  readonly topByCompletion: readonly BinderSummary[];
}

export interface LotsTotalRow {
  readonly currency: CurrencyCode;
  readonly total: number;
}

export interface LotsSection {
  readonly count: number;
  readonly totalsByCurrency: readonly LotsTotalRow[];
  readonly unallocatedCount: number;
  readonly materializedCount: number;
  readonly imbalancedCount: number;
}

export interface WishlistSection {
  readonly wantedCount: number;
  readonly orderedCount: number;
  readonly receivedCount: number;
  readonly cancelledCount: number;
  readonly grailItems: readonly WishlistRecord[];
}

export interface DashboardService {
  buildSnapshot(): Promise<DashboardSnapshot>;
}

export interface DashboardServiceDeps {
  readonly appMetaRepo: AppMetaRepo;
  readonly cardsRepo: CardsRepo;
  readonly setsRepo: SetsRepo;
  readonly holdingsRepo: HoldingsRepo;
  readonly bindersRepo: BindersRepo;
  readonly binderSlotsRepo: BinderSlotsRepo;
  readonly lotsRepo: LotsRepo;
  readonly lotItemsRepo: LotItemsRepo;
  readonly wishlistRepo: WishlistRepo;
  /** Test seam — defaults to `() => Date.now()`. */
  readonly now?: () => number;
}

const TOP_BINDERS_LIMIT = 3;
const TOP_GRAIL_LIMIT = 5;

export function createDashboardService(
  deps: DashboardServiceDeps,
): DashboardService {
  const now = deps.now ?? (() => Date.now());

  return {
    async buildSnapshot() {
      // appMeta — read each key once; .get returns undefined when
      // missing, so coerce to null for the snapshot.
      const [
        schemaVersionMeta,
        persistentMeta,
        lastSyncAtMeta,
        lastSyncStatusMeta,
        lastSyncErrorMeta,
        lastBackupAtMeta,
        lastBackupCountMeta,
        lastMigrationAtMeta,
      ] = await Promise.all([
        deps.appMetaRepo.get<number>(APP_META_KEYS.schemaVersion),
        deps.appMetaRepo.get<boolean>(APP_META_KEYS.persistentStorageGranted),
        deps.appMetaRepo.get<string>(APP_META_KEYS.lastSyncAt),
        deps.appMetaRepo.get<SyncStatus>(APP_META_KEYS.lastSyncStatus),
        deps.appMetaRepo.get<string>(APP_META_KEYS.lastSyncError),
        deps.appMetaRepo.get<string>(APP_META_KEYS.lastBackupAt),
        deps.appMetaRepo.get<number>(APP_META_KEYS.lastBackupHoldingCount),
        deps.appMetaRepo.get<string>(APP_META_KEYS.lastMigrationAt),
      ]);

      // Cache sizes via count() — never load the cards/sets stores.
      const [cardCacheCount, setCacheCount] = await Promise.all([
        deps.cardsRepo.count(),
        deps.setsRepo.count(),
      ]);

      // User-data reads.
      const [
        allHoldings,
        liveBinders,
        allBinderSlots,
        liveLots,
        allLotItems,
        allWishlist,
      ] = await Promise.all([
        deps.holdingsRepo.list(),
        deps.bindersRepo.listLive(),
        deps.binderSlotsRepo.list(),
        deps.lotsRepo.listLive(),
        deps.lotItemsRepo.list(),
        deps.wishlistRepo.list(),
      ]);

      const liveHoldings = allHoldings.filter((h) => h.deletedAt === null);
      const deletedHoldings = allHoldings.length - liveHoldings.length;
      const liveSlots = allBinderSlots.filter((s) => s.deletedAt === null);
      const liveLotItems = allLotItems.filter((i) => i.deletedAt === null);
      const liveWishlist = allWishlist.filter((w) => w.deletedAt === null);

      const databaseHealth: DatabaseHealthSection = {
        schemaVersion:
          typeof schemaVersionMeta === 'number' ? schemaVersionMeta : null,
        persistentStorageGranted: persistentMeta === true,
        cardCacheCount,
        setCacheCount,
        liveHoldingsCount: liveHoldings.length,
        liveBindersCount: liveBinders.length,
        liveLotsCount: liveLots.length,
      };

      const sync: SyncSection = {
        lastSyncAt: typeof lastSyncAtMeta === 'string' ? lastSyncAtMeta : null,
        lastSyncStatus:
          lastSyncStatusMeta === 'ok' || lastSyncStatusMeta === 'failed'
            ? lastSyncStatusMeta
            : null,
        lastSyncError:
          typeof lastSyncErrorMeta === 'string' ? lastSyncErrorMeta : null,
        cardCacheCount,
        setCacheCount,
      };

      const lastBackupAt =
        typeof lastBackupAtMeta === 'string' ? lastBackupAtMeta : null;
      const lastBackupHoldingCount =
        typeof lastBackupCountMeta === 'number' ? lastBackupCountMeta : null;
      const lastMigrationAt =
        typeof lastMigrationAtMeta === 'string' ? lastMigrationAtMeta : null;

      const daysSinceLastBackup =
        lastBackupAt !== null
          ? Math.max(0, Math.floor((now() - Date.parse(lastBackupAt)) / MS_PER_DAY))
          : null;
      const schemaMigratedSinceLastBackup =
        lastBackupAt !== null &&
        lastMigrationAt !== null &&
        lastMigrationAt > lastBackupAt;
      const holdingsSinceLastBackup =
        lastBackupHoldingCount !== null
          ? liveHoldings.length - lastBackupHoldingCount
          : 0;

      const backup: BackupSection = {
        lastBackupAt,
        lastBackupHoldingCount,
        liveHoldingsCount: liveHoldings.length,
        holdingsSinceLastBackup,
        daysSinceLastBackup,
        schemaMigratedSinceLastBackup,
      };

      // Collection metrics
      const liveHoldingIds = new Set(liveHoldings.map((h) => h.id));
      const slotHoldingIds = new Set<string>();
      for (const slot of liveSlots) {
        if (slot.holdingId !== null) slotHoldingIds.add(slot.holdingId);
      }
      let rawCount = 0;
      let gradedCount = 0;
      let missingConditionCount = 0;
      let missingValueCount = 0;
      let notInBinderCount = 0;
      let duplicateStatusCount = 0;
      let upgradeNeededCount = 0;
      const uniqueCardIds = new Set<string>();
      for (const h of liveHoldings) {
        uniqueCardIds.add(h.cardId);
        if (h.conditionType === 'graded') {
          gradedCount += 1;
        } else {
          rawCount += 1;
          if (h.rawCondition === null || h.rawCondition === 'UNKNOWN') {
            missingConditionCount += 1;
          }
        }
        if (h.estimatedValue === null && h.valueSource === 'unknown') {
          missingValueCount += 1;
        }
        if (!slotHoldingIds.has(h.id)) {
          notInBinderCount += 1;
        }
        if (h.status === 'duplicate') duplicateStatusCount += 1;
        if (h.status === 'upgrade_needed') upgradeNeededCount += 1;
      }
      const collection: CollectionSection = {
        liveCount: liveHoldings.length,
        deletedCount: deletedHoldings,
        uniqueCardIds: uniqueCardIds.size,
        rawCount,
        gradedCount,
        missingConditionCount,
        missingValueCount,
        notInBinderCount,
        duplicateStatusCount,
        upgradeNeededCount,
      };

      // Binder summaries (per-binder completion + top-3)
      const binderSummaries: BinderSummary[] = [];
      let totalTargetSlots = 0;
      let totalCompletedSlots = 0;
      for (const binder of liveBinders) {
        const slotsForBinder = liveSlots.filter(
          (s) => s.binderId === binder.id,
        );
        const completion = calculateBinderCompletion(
          slotsForBinder,
          liveHoldingIds,
        );
        totalTargetSlots += completion.totalTargetSlots;
        totalCompletedSlots += completion.completedSlots;
        binderSummaries.push({ binder, completion });
      }
      const totalMissingSlots = totalTargetSlots - totalCompletedSlots;
      const averageCompletionPercent =
        binderSummaries.length === 0
          ? 0
          : Math.round(
              binderSummaries.reduce(
                (acc, s) => acc + s.completion.percentage,
                0,
              ) / binderSummaries.length,
            );
      const topByCompletion = [...binderSummaries]
        .sort((a, b) => b.completion.percentage - a.completion.percentage)
        .slice(0, TOP_BINDERS_LIMIT);
      const binders: BindersSection = {
        count: liveBinders.length,
        averageCompletionPercent,
        totalTargetSlots,
        totalCompletedSlots,
        totalMissingSlots,
        topByCompletion,
      };

      // Lots
      let unallocatedCount = 0;
      let materializedCount = 0;
      let imbalancedCount = 0;
      const totalsByCurrencyMap = new Map<CurrencyCode, number>();
      for (const lot of liveLots) {
        const items = liveLotItems.filter((i) => i.lotId === lot.id);
        const itemCount = items.length;
        const allocated = round2(
          items.reduce((acc, i) => acc + (i.allocatedCost ?? 0), 0),
        );
        const allMaterialized =
          itemCount > 0 && items.every((i) => i.holdingId !== null);
        const fullyAllocated =
          itemCount > 0 &&
          items.every((i) => i.allocatedCost !== null) &&
          Math.abs(lot.totalCost - allocated) <= 0.01;
        if (allMaterialized) {
          materializedCount += 1;
        } else if (itemCount > 0 && !fullyAllocated) {
          unallocatedCount += 1;
        }
        if (Math.abs(lot.totalCost - allocated) > 0.01) {
          imbalancedCount += 1;
        }
        const prev = totalsByCurrencyMap.get(lot.currency) ?? 0;
        totalsByCurrencyMap.set(lot.currency, round2(prev + lot.totalCost));
      }
      const totalsByCurrency: LotsTotalRow[] = [...totalsByCurrencyMap.entries()]
        .map(([currency, total]) => ({ currency, total }))
        .sort((a, b) => a.currency.localeCompare(b.currency));
      const lots: LotsSection = {
        count: liveLots.length,
        totalsByCurrency,
        unallocatedCount,
        materializedCount,
        imbalancedCount,
      };

      // Wishlist
      let wantedCount = 0;
      let orderedCount = 0;
      let receivedCount = 0;
      let cancelledCount = 0;
      for (const w of liveWishlist) {
        if (w.status === 'wanted') wantedCount += 1;
        else if (w.status === 'ordered') orderedCount += 1;
        else if (w.status === 'received') receivedCount += 1;
        else if (w.status === 'cancelled') cancelledCount += 1;
      }
      const grailItems = liveWishlist
        .filter((w) => w.priority === 'grail' && w.status !== 'cancelled')
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .slice(0, TOP_GRAIL_LIMIT);
      const wishlist: WishlistSection = {
        wantedCount,
        orderedCount,
        receivedCount,
        cancelledCount,
        grailItems,
      };

      const snapshot: DashboardSnapshot = {
        generatedAt: new Date(now()).toISOString(),
        databaseHealth,
        sync,
        backup,
        collection,
        binders,
        lots,
        wishlist,
        actions: [],
      };
      const actions = computeActionItems(snapshot);
      return { ...snapshot, actions };
    },
  };
}
