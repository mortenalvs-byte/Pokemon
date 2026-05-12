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

/**
 * PR A3 — Open slot in a set-scoped binder for a specific card.
 *
 * Returned by `findOpenSlotsForCardInSetBinder`: a slot that is
 * available to assign for the given cardId, in a binder bound to
 * the card's set. Legacy null-sourceSetId binders are excluded.
 */
export interface OpenSlotForCard {
  readonly binder: BinderRecord;
  readonly slot: BinderSlotRecord;
  /**
   * Why this slot is considered "open":
   *  - 'targeted-empty': slot.targetCardId === cardId AND status !== 'owned' AND holdingId is null.
   *  - 'blank-untargeted': slot.targetCardId === null AND status !== 'owned' AND holdingId is null.
   *    The user can backfill this slot with the holding. Defence-in-depth:
   *    we only emit this when the binder is scoped to the same set as the card.
   */
  readonly openReason: 'targeted-empty' | 'blank-untargeted';
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
  /**
   * PR A3 — open slots for a card across binders bound to that card's set.
   *
   * Returns slots in any LIVE binder where `binder.sourceSetId === card.setId`
   * AND the slot is currently open (status not 'owned', holdingId is null,
   * not soft-deleted) AND the slot either explicitly targets this cardId or
   * is blank/untargeted. Legacy null-sourceSetId binders are deliberately
   * excluded — this lookup is the supervised "where can I put this card in
   * MY set's binder?" UX answer (operator requirement #9), and legacy
   * unscoped binders are not part of that semantic.
   *
   * Returns `[]` when:
   *   - the cardId is unknown
   *   - the card's set has no set-scoped binders
   *   - all such binders' relevant slots are already owned
   */
  findOpenSlotsForCardInSetBinder(cardId: string): Promise<OpenSlotForCard[]>;
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

    async findOpenSlotsForCardInSetBinder(cardId) {
      // Look up the card's set first; without it we can't match binders.
      const card = await cardsRepo.get(cardId);
      if (card === undefined) return [];
      const targetSetId = card.setId;

      // Filter to live binders that are explicitly scoped to this set.
      // Legacy null-sourceSetId binders are excluded — operator
      // requirement #9 is specifically about a card's "own set" binder.
      const liveBinders = await bindersRepo.listLive();
      const setScoped = liveBinders.filter(
        (b) => b.sourceSetId === targetSetId,
      );
      if (setScoped.length === 0) return [];

      const setScopedIds = new Set(setScoped.map((b) => b.id));
      const allLiveSlots = await slotsRepo.listLive();

      const open: OpenSlotForCard[] = [];
      for (const slot of allLiveSlots) {
        if (!setScopedIds.has(slot.binderId)) continue;
        // "Open" = not currently owned AND no holding assigned.
        if (slot.status === 'owned') continue;
        if (slot.holdingId !== null) continue;
        // Targeting check: explicit target match OR blank slot the user
        // can backfill. Wanted/missing/duplicate slots with another
        // targetCardId aren't "open for this card" — that'd be visual
        // noise; skip them.
        let openReason: OpenSlotForCard['openReason'];
        if (slot.targetCardId === cardId) {
          openReason = 'targeted-empty';
        } else if (slot.targetCardId === null) {
          openReason = 'blank-untargeted';
        } else {
          continue;
        }

        const binder = setScoped.find((b) => b.id === slot.binderId);
        if (binder === undefined) continue;
        open.push({ binder, slot, openReason });
      }

      // Stable order: by binder name then page/slot — same ordering
      // convention as slotsForCardId so the UI feels consistent.
      open.sort((a, b) => {
        const nameCmp = a.binder.name.localeCompare(b.binder.name);
        if (nameCmp !== 0) return nameCmp;
        if (a.slot.pageNumber !== b.slot.pageNumber) {
          return a.slot.pageNumber - b.slot.pageNumber;
        }
        return a.slot.slotNumber - b.slot.slotNumber;
      });
      return open;
    },
  };
}
