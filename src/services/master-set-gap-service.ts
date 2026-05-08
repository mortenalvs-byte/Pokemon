// PR 25 — Master set gap analysis service.
//
// Bulk-loads every store the analysis needs ONCE, builds O(1) lookup
// maps, then walks each binder's slots in memory and runs the pure
// `classifySlot` from `domain/master-set-gap`.
//
// Performance contract (from PR 25 plan):
//   - One `listLive()` per store (binders, binderSlots, holdings,
//     wishlist, lotItems). Cards/sets are pulled via the per-DB cache
//     (PR 21).
//   - No per-slot Dexie calls. A 1088-slot Vault X 16-pocket binder
//     must build a report from the same in-memory data structures the
//     `autoAssignBinder` service already uses.
//
// Read-only. Never writes; never dispatches `USER_DATA_CHANGED_EVENT`.

import { nowIso } from '../utils/dates';
import {
  buildBinderSummary,
  buildDashboardSummary,
  classifySlot,
  type MasterGapBinderSummary,
  type MasterGapDashboardSummary,
  type MasterGapReport,
  type MasterGapRow,
} from '../domain/master-set-gap';
import type {
  BinderRecord,
  BinderSlotRecord,
  CardRecord,
  HoldingRecord,
  LotItemRecord,
  SetRecord,
  WishlistRecord,
} from '../domain/types';
import type { BindersRepo } from '../repositories/binders-repo';
import type { BinderSlotsRepo } from '../repositories/binder-slots-repo';
import type { CardsRepo } from '../repositories/cards-repo';
import type { HoldingsRepo } from '../repositories/holdings-repo';
import type { LotItemsRepo } from '../repositories/lot-items-repo';
import type { SetsRepo } from '../repositories/sets-repo';
import type { WishlistRepo } from '../repositories/wishlist-repo';

export interface MasterSetGapServiceDeps {
  readonly bindersRepo: BindersRepo;
  readonly binderSlotsRepo: BinderSlotsRepo;
  readonly cardsRepo: CardsRepo;
  readonly setsRepo: SetsRepo;
  readonly holdingsRepo: HoldingsRepo;
  readonly wishlistRepo: WishlistRepo;
  readonly lotItemsRepo: LotItemsRepo;
  readonly now?: () => string;
}

export interface MasterSetGapService {
  buildBinderReport(binderId: string): Promise<MasterGapReport | null>;
  buildDashboardSummary(): Promise<MasterGapDashboardSummary>;
}

interface SharedLookups {
  readonly liveSlots: readonly BinderSlotRecord[];
  readonly slotsByBinderId: Map<string, BinderSlotRecord[]>;
  readonly liveHoldings: readonly HoldingRecord[];
  readonly holdingsByCardId: Map<string, HoldingRecord[]>;
  readonly holdingsById: Map<string, HoldingRecord>;
  readonly assignedHoldingIds: Set<string>;
  readonly liveWishlist: readonly WishlistRecord[];
  readonly wishlistByCardId: Map<string, WishlistRecord[]>;
  readonly liveLotItems: readonly LotItemRecord[];
  readonly lotItemsByCardId: Map<string, LotItemRecord[]>;
  readonly cardsById: Map<string, CardRecord>;
  readonly setsById: Map<string, SetRecord>;
}

export function createMasterSetGapService(
  deps: MasterSetGapServiceDeps,
): MasterSetGapService {
  const now = deps.now ?? nowIso;

  return {
    async buildBinderReport(binderId) {
      const binder = await deps.bindersRepo.get(binderId);
      if (binder === undefined || binder.deletedAt !== null) {
        return null;
      }
      const lookups = await loadLookups(deps);
      const rows = buildRowsForBinder(binder, lookups);
      const summary = buildBinderSummary(binder.id, binder.name, rows);
      return {
        generatedAt: now(),
        binder: summary,
        rows,
      };
    },

    async buildDashboardSummary() {
      const liveBinders = await deps.bindersRepo.listLive();
      if (liveBinders.length === 0) {
        return buildDashboardSummary([], now());
      }
      const lookups = await loadLookups(deps);
      const summaries: MasterGapBinderSummary[] = [];
      for (const binder of liveBinders) {
        const rows = buildRowsForBinder(binder, lookups);
        summaries.push(
          buildBinderSummary(binder.id, binder.name, rows),
        );
      }
      return buildDashboardSummary(summaries, now());
    },
  };
}

async function loadLookups(
  deps: MasterSetGapServiceDeps,
): Promise<SharedLookups> {
  const [liveSlots, liveHoldings, liveWishlist, liveLotItems, cards, sets] =
    await Promise.all([
      deps.binderSlotsRepo.listLive(),
      deps.holdingsRepo.listLive(),
      deps.wishlistRepo.listLive(),
      deps.lotItemsRepo.listLive(),
      deps.cardsRepo.list(),
      deps.setsRepo.list(),
    ]);

  const slotsByBinderId = new Map<string, BinderSlotRecord[]>();
  for (const slot of liveSlots) {
    const arr = slotsByBinderId.get(slot.binderId);
    if (arr === undefined) slotsByBinderId.set(slot.binderId, [slot]);
    else arr.push(slot);
  }

  const holdingsByCardId = new Map<string, HoldingRecord[]>();
  const holdingsById = new Map<string, HoldingRecord>();
  for (const h of liveHoldings) {
    holdingsById.set(h.id, h);
    const arr = holdingsByCardId.get(h.cardId);
    if (arr === undefined) holdingsByCardId.set(h.cardId, [h]);
    else arr.push(h);
  }

  // assignedHoldingIds spans every live binder slot, not just the one
  // we're reporting on — a holding bound to another binder is NOT a
  // candidate for `owned_unplaced` here.
  const assignedHoldingIds = new Set<string>();
  for (const slot of liveSlots) {
    if (slot.holdingId !== null) assignedHoldingIds.add(slot.holdingId);
  }

  const wishlistByCardId = new Map<string, WishlistRecord[]>();
  for (const w of liveWishlist) {
    const arr = wishlistByCardId.get(w.cardId);
    if (arr === undefined) wishlistByCardId.set(w.cardId, [w]);
    else arr.push(w);
  }

  const lotItemsByCardId = new Map<string, LotItemRecord[]>();
  for (const li of liveLotItems) {
    const arr = lotItemsByCardId.get(li.cardId);
    if (arr === undefined) lotItemsByCardId.set(li.cardId, [li]);
    else arr.push(li);
  }

  const cardsById = new Map<string, CardRecord>();
  for (const c of cards) cardsById.set(c.id, c);

  const setsById = new Map<string, SetRecord>();
  for (const s of sets) setsById.set(s.id, s);

  return {
    liveSlots,
    slotsByBinderId,
    liveHoldings,
    holdingsByCardId,
    holdingsById,
    assignedHoldingIds,
    liveWishlist,
    wishlistByCardId,
    liveLotItems,
    lotItemsByCardId,
    cardsById,
    setsById,
  };
}

function buildRowsForBinder(
  binder: BinderRecord,
  lookups: SharedLookups,
): MasterGapRow[] {
  const slots = (lookups.slotsByBinderId.get(binder.id) ?? [])
    .slice()
    .sort((a, b) => {
      if (a.pageNumber !== b.pageNumber) return a.pageNumber - b.pageNumber;
      return a.slotNumber - b.slotNumber;
    });
  const rows: MasterGapRow[] = [];
  for (const slot of slots) {
    rows.push(buildRow(binder, slot, lookups));
  }
  return rows;
}

function buildRow(
  binder: BinderRecord,
  slot: BinderSlotRecord,
  lookups: SharedLookups,
): MasterGapRow {
  const card =
    slot.targetCardId !== null
      ? (lookups.cardsById.get(slot.targetCardId) ?? null)
      : null;
  const wishlist =
    slot.targetCardId !== null
      ? (lookups.wishlistByCardId.get(slot.targetCardId) ?? [])
      : [];
  const lotItems =
    slot.targetCardId !== null
      ? (lookups.lotItemsByCardId.get(slot.targetCardId) ?? [])
      : [];
  const liveHoldingsForCard =
    slot.targetCardId !== null
      ? (lookups.holdingsByCardId.get(slot.targetCardId) ?? [])
      : [];
  const assignedHolding =
    slot.holdingId !== null
      ? (lookups.holdingsById.get(slot.holdingId) ?? null)
      : null;
  const result = classifySlot(slot, {
    wishlist,
    lotItems,
    liveHoldingsForCard,
    assignedHoldingIds: lookups.assignedHoldingIds,
    assignedHolding,
    card,
  });
  const setRecord =
    card !== null ? (lookups.setsById.get(card.setId) ?? null) : null;
  return {
    binderId: binder.id,
    binderName: binder.name,
    slotId: slot.id,
    pageNumber: slot.pageNumber,
    slotNumber: slot.slotNumber,
    cardId: slot.targetCardId,
    cardName: card?.name ?? null,
    setId: card?.setId ?? null,
    setName: setRecord?.name ?? null,
    cardNumber: card?.number ?? null,
    required: result.required,
    status: result.status,
    severity: result.severity,
    reason: result.reason,
    assignedHoldingId: slot.holdingId,
    matchingUnplacedHoldingIds: result.matchingUnplacedHoldingIds,
    activeWishlistIds: result.activeWishlistIds,
    orderedWishlistIds: result.orderedWishlistIds,
    unmaterializedLotItemIds: result.unmaterializedLotItemIds,
    canPlaceDirectly: result.canPlaceDirectly,
  };
}
