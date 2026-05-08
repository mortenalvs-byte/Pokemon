// PR 23 — card status aggregation. The status panel shown in the
// global-search dropdown reads from this service. It joins one
// cardId against every per-card data source the workflow PRs have
// added so the panel can answer:
//
//   "Hva eier jeg av dette kortet, hvor ligger det, hva er på
//    ønskelisten og hva er ufordelt i en lott?"
//
// Reads only. Writes go through the regular repos / shared services
// (Quick Add helper, receive prompt, navigateToBinderSlot,
// wishlist-form).
//
// Implementation notes
//   - Binder slot lookup delegates to `binder-slot-service.slotsForCardId`
//     (PR 17) — same matching, same ordering. We don't reimplement.
//   - Holdings + wishlist + lot-items use repo `listByCardId` so the
//     existing Dexie indexes are used.
//   - lot-items joins each entry to its lot via a per-status-call lot
//     index built once in this service (small set: typically 0–3 lots).

import type {
  BinderRecord,
  BinderSlotRecord,
  CardRecord,
  HoldingRecord,
  LotItemRecord,
  LotRecord,
  SetRecord,
  WishlistRecord,
} from '../domain/types';
import { isActiveWishlistStatus } from '../domain/wishlist-status';
import type { BinderSlotService, SlotForCard } from './binder-slot-service';
import type { CardsRepo } from '../repositories/cards-repo';
import type { HoldingsRepo } from '../repositories/holdings-repo';
import type { LotItemsRepo } from '../repositories/lot-items-repo';
import type { LotsRepo } from '../repositories/lots-repo';
import type { SetsRepo } from '../repositories/sets-repo';
import type { WishlistRepo } from '../repositories/wishlist-repo';
import { findReceiveCandidatesForHoldings } from './wishlist-receive-service';

export interface CardStatusBinderSlot {
  readonly binder: BinderRecord;
  readonly slot: BinderSlotRecord;
  /**
   * `target` — the slot expects this card.
   * `assigned` — the slot points at a live holding for this card.
   */
  readonly matchedBy: 'target' | 'assigned';
}

export interface CardStatusLotEntry {
  readonly lot: LotRecord;
  readonly item: LotItemRecord;
}

export interface CardStatus {
  readonly card: CardRecord;
  readonly set: SetRecord | null;
  readonly holdings: readonly HoldingRecord[];
  readonly binderSlots: readonly CardStatusBinderSlot[];
  readonly activeWishlist: readonly WishlistRecord[];
  readonly closedWishlist: readonly WishlistRecord[];
  readonly unmaterialisedLotItems: readonly CardStatusLotEntry[];
  readonly summary: {
    readonly totalQuantityOwned: number;
    readonly activeWishlistCount: number;
    readonly binderSlotCount: number;
    readonly unmaterialisedLotCount: number;
    /**
     * PR 23 review patch — actual receive candidates (cardId + finish
     * matched), not just "active wishlist exists for cardId". Lets
     * the panel hide the `Marker mottatt` button when no holding's
     * finish matches any active wishlist row, so the user never
     * lands in a dead-end "ingen matchende oppføringer" alert.
     */
    readonly receiveCandidateCount: number;
  };
}

export interface CardStatusServiceDeps {
  readonly cardsRepo: CardsRepo;
  readonly setsRepo: SetsRepo;
  readonly holdingsRepo: HoldingsRepo;
  readonly wishlistRepo: WishlistRepo;
  readonly binderSlotService: BinderSlotService;
  readonly lotsRepo: LotsRepo;
  readonly lotItemsRepo: LotItemsRepo;
}

export class CardStatusNotFoundError extends Error {
  public readonly cardId: string;
  constructor(cardId: string) {
    super(`Card ${cardId} not in cache`);
    this.name = 'CardStatusNotFoundError';
    this.cardId = cardId;
  }
}

export async function getCardStatus(
  deps: CardStatusServiceDeps,
  cardId: string,
): Promise<CardStatus> {
  const card = await deps.cardsRepo.get(cardId);
  if (card === undefined) {
    throw new CardStatusNotFoundError(cardId);
  }
  const set = (await deps.setsRepo.get(card.setId)) ?? null;

  const [holdingsAll, wishlistAll, lotItemsAll, slotMatches] = await Promise.all([
    deps.holdingsRepo.listByCardId(cardId),
    deps.wishlistRepo.listByCardId(cardId),
    deps.lotItemsRepo.listByCardId(cardId),
    deps.binderSlotService.slotsForCardId(cardId),
  ]);

  const holdings = holdingsAll.filter((h) => h.deletedAt === null);

  const activeWishlist: WishlistRecord[] = [];
  const closedWishlist: WishlistRecord[] = [];
  for (const w of wishlistAll) {
    if (w.deletedAt !== null) continue;
    if (isActiveWishlistStatus(w.status)) activeWishlist.push(w);
    else closedWishlist.push(w);
  }

  const binderSlots: CardStatusBinderSlot[] = slotMatches.map(
    (m: SlotForCard): CardStatusBinderSlot => ({
      binder: m.binder,
      slot: m.slot,
      matchedBy: m.matchedBy,
    }),
  );

  const unmaterialisedLotItems = await collectUnmaterialisedLotItems(
    deps,
    lotItemsAll,
  );

  // PR 23 review patch — only count receive candidates that actually
  // match holdings on cardId + finish (the same gate Quick Add /
  // Bulk / Card Detail conflict banner use). Cheap because the
  // wishlist set is already loaded.
  const receiveCandidates =
    holdings.length > 0 && activeWishlist.length > 0
      ? await findReceiveCandidatesForHoldings(deps.wishlistRepo, holdings)
      : [];

  return {
    card,
    set,
    holdings,
    binderSlots,
    activeWishlist,
    closedWishlist,
    unmaterialisedLotItems,
    summary: {
      totalQuantityOwned: holdings.reduce((sum, h) => sum + h.quantity, 0),
      activeWishlistCount: activeWishlist.length,
      binderSlotCount: binderSlots.length,
      unmaterialisedLotCount: unmaterialisedLotItems.length,
      receiveCandidateCount: receiveCandidates.length,
    },
  };
}

async function collectUnmaterialisedLotItems(
  deps: CardStatusServiceDeps,
  lotItemsAll: readonly LotItemRecord[],
): Promise<CardStatusLotEntry[]> {
  // Cache lot lookups so a card with two items in the same lot only
  // costs one `lotsRepo.get`.
  const lotById = new Map<string, LotRecord>();
  const out: CardStatusLotEntry[] = [];
  for (const item of lotItemsAll) {
    if (item.deletedAt !== null) continue;
    if (item.holdingId !== null) continue; // already materialised
    let lot = lotById.get(item.lotId);
    if (lot === undefined) {
      const fetched = await deps.lotsRepo.get(item.lotId);
      if (fetched === undefined) continue;
      lot = fetched;
      lotById.set(item.lotId, lot);
    }
    if (lot.deletedAt !== null) continue;
    out.push({ lot, item });
  }
  out.sort((a, b) => {
    if (a.lot.purchaseDate !== b.lot.purchaseDate) {
      return a.lot.purchaseDate < b.lot.purchaseDate ? 1 : -1;
    }
    return a.lot.name.localeCompare(b.lot.name);
  });
  return out;
}
