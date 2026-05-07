// Binder slot read service. Joins live binders + slots + holdings + cards
// for the binder list and binder detail views, and surfaces every binder
// "location" that mentions a given card (used by the Card Detail view).
//
// Read-only. All mutations stay in the repos so validation + audit run.

import type {
  BinderRecord,
  BinderSlotRecord,
  CardRecord,
  HoldingRecord,
} from '../domain/types';
import {
  calculateBinderCompletion,
  type BinderCompletion,
} from '../domain/binder-completion';
import type { BindersRepo } from '../repositories/binders-repo';
import type { BinderSlotsRepo } from '../repositories/binder-slots-repo';
import type { CardsRepo } from '../repositories/cards-repo';
import type { HoldingsRepo } from '../repositories/holdings-repo';

export interface BinderSummary {
  readonly binder: BinderRecord;
  readonly completion: BinderCompletion;
}

export interface BinderDetail {
  readonly binder: BinderRecord;
  readonly slots: readonly BinderSlotRecord[];
  readonly completion: BinderCompletion;
  readonly holdingsById: ReadonlyMap<string, HoldingRecord>;
  readonly cardsById: ReadonlyMap<string, CardRecord>;
}

export interface SlotForCard {
  readonly binder: BinderRecord;
  readonly slot: BinderSlotRecord;
  readonly matchedBy: 'target' | 'assigned';
}

export interface BinderSlotService {
  /** All live binders, each with its completion stats. */
  listSummaries(): Promise<BinderSummary[]>;
  /** Detail view: a binder + every live slot, joined with holdings/cards. */
  getDetail(binderId: string): Promise<BinderDetail | null>;
  /**
   * Slots that mention the given card — either the slot's target is this
   * card, or the holding assigned to the slot is for this card. Used by
   * the Card Detail view's "Binder-lokasjoner" section.
   */
  slotsForCardId(cardId: string): Promise<SlotForCard[]>;
}

export function createBinderSlotService(
  bindersRepo: BindersRepo,
  slotsRepo: BinderSlotsRepo,
  holdingsRepo: HoldingsRepo,
  cardsRepo: CardsRepo,
): BinderSlotService {
  return {
    async listSummaries() {
      const binders = await bindersRepo.listLive();
      const allSlots = await slotsRepo.list();
      const liveHoldings = await holdingsRepo.listLive();
      const liveHoldingIds = new Set(liveHoldings.map((h) => h.id));

      const summaries = binders.map<BinderSummary>((binder) => {
        const slots = allSlots.filter(
          (s) => s.binderId === binder.id && s.deletedAt === null,
        );
        return {
          binder,
          completion: calculateBinderCompletion(slots, liveHoldingIds),
        };
      });

      summaries.sort((a, b) =>
        a.binder.updatedAt < b.binder.updatedAt
          ? 1
          : a.binder.updatedAt > b.binder.updatedAt
            ? -1
            : 0,
      );
      return summaries;
    },

    async getDetail(binderId) {
      const binder = await bindersRepo.get(binderId);
      if (binder === undefined || binder.deletedAt !== null) {
        return null;
      }
      const slotsForBinder = await slotsRepo.listByBinderId(binderId);
      const liveSlots = slotsForBinder
        .filter((s) => s.deletedAt === null)
        .sort((a, b) => {
          if (a.pageNumber !== b.pageNumber) {
            return a.pageNumber - b.pageNumber;
          }
          return a.slotNumber - b.slotNumber;
        });

      const liveHoldings = await holdingsRepo.listLive();
      const holdingsById = new Map<string, HoldingRecord>();
      for (const h of liveHoldings) {
        holdingsById.set(h.id, h);
      }

      const cardIds = new Set<string>();
      for (const slot of liveSlots) {
        if (slot.targetCardId !== null) cardIds.add(slot.targetCardId);
        if (slot.holdingId !== null) {
          const h = holdingsById.get(slot.holdingId);
          if (h !== undefined) cardIds.add(h.cardId);
        }
      }
      const cards = await cardsRepo.list();
      const cardsById = new Map<string, CardRecord>();
      for (const c of cards) {
        if (cardIds.has(c.id)) cardsById.set(c.id, c);
      }

      const completion = calculateBinderCompletion(
        liveSlots,
        new Set(holdingsById.keys()),
      );

      return {
        binder,
        slots: liveSlots,
        completion,
        holdingsById,
        cardsById,
      };
    },

    async slotsForCardId(cardId) {
      const allSlots = await slotsRepo.listLive();
      const liveBinders = await bindersRepo.listLive();
      const bindersById = new Map<string, BinderRecord>();
      for (const b of liveBinders) {
        bindersById.set(b.id, b);
      }
      const liveHoldings = await holdingsRepo.listLive();
      const holdingsById = new Map<string, HoldingRecord>();
      for (const h of liveHoldings) {
        holdingsById.set(h.id, h);
      }

      const matches: SlotForCard[] = [];
      for (const slot of allSlots) {
        const binder = bindersById.get(slot.binderId);
        if (binder === undefined) continue;
        if (slot.targetCardId === cardId) {
          matches.push({ binder, slot, matchedBy: 'target' });
          continue;
        }
        if (slot.holdingId !== null) {
          const holding = holdingsById.get(slot.holdingId);
          if (holding !== undefined && holding.cardId === cardId) {
            matches.push({ binder, slot, matchedBy: 'assigned' });
          }
        }
      }

      matches.sort((a, b) => {
        const nameCmp = a.binder.name.localeCompare(b.binder.name);
        if (nameCmp !== 0) return nameCmp;
        if (a.slot.pageNumber !== b.slot.pageNumber) {
          return a.slot.pageNumber - b.slot.pageNumber;
        }
        return a.slot.slotNumber - b.slot.slotNumber;
      });
      return matches;
    },
  };
}
