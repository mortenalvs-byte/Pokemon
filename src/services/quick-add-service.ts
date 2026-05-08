// PR 23 — shared Quick Add helper.
//
// Before this module the Quick Add Raw sequence (decide → upsert → find
// receive candidates) lived inline in `src/views/browse.ts` as a
// `runQuickAddRaw` helper plus a `runReceivePromptForHoldingSafe`
// helper. Importing those into `global-search.ts` would have crossed
// view boundaries (view-internal helpers becoming shared dependencies),
// so we lift the pure parts here. The Browse view continues to handle
// its own DOM-side feedback chip; this helper does only the
// repository write + receive-candidate lookup.
//
// The helper is intentionally narrow:
//   - One card in.
//   - Repo write via `holdingsRepo.upsertByVariant` so the variant
//     validator stays the final gate.
//   - Returns the upsert result PLUS the wishlist receive candidates
//     (computed for the just-written holding) so the caller can decide
//     what UX to show (toast, inline banner, prompt, nothing).
//   - Never opens a dialog itself. The caller wires the receive prompt
//     if it wants the full UX from PR 22.
//
// Errors propagate. Validation errors from the variant validator stay
// `ValidationError`; the caller decides whether to surface them.

import type { CardRecord } from '../domain/types';
import { decideQuickAdd } from '../components/quick-add';
import {
  findWishlistReceiveCandidates,
  type WishlistReceiveCandidate,
} from './wishlist-receive-service';
import type { HoldingsRepo, UpsertHoldingResult } from '../repositories/holdings-repo';
import type { WishlistRepo } from '../repositories/wishlist-repo';

export interface QuickAddRawResult {
  readonly result: UpsertHoldingResult;
  readonly receiveCandidates: WishlistReceiveCandidate[];
}

export class QuickAddNotEligibleError extends Error {
  public readonly reason: string;

  constructor(reason: string) {
    super(`Quick Add ikke tilgjengelig: ${reason}`);
    this.name = 'QuickAddNotEligibleError';
    this.reason = reason;
  }
}

export interface QuickAddRawDeps {
  readonly holdingsRepo: HoldingsRepo;
  readonly wishlistRepo: WishlistRepo;
}

/**
 * Run a one-click "+1 raw NM" against a card. Throws
 * `QuickAddNotEligibleError` when the card lacks verified variants
 * (same gate `decideQuickAdd` returns). Validation errors from the
 * repo bubble up unchanged.
 */
export async function quickAddRawCard(
  deps: QuickAddRawDeps,
  card: CardRecord,
): Promise<QuickAddRawResult> {
  const decision = decideQuickAdd(card);
  if (!decision.canQuickAdd || decision.defaults === null) {
    throw new QuickAddNotEligibleError(decision.reason);
  }
  const result = await deps.holdingsRepo.upsertByVariant({
    cardId: card.id,
    quantity: 1,
    conditionType: 'raw',
    rawCondition: 'NM',
    gradingCompany: null,
    grade: null,
    certNumber: null,
    certUrl: null,
    gradedDate: null,
    finish: decision.defaults.finish,
    edition: decision.defaults.edition,
    language: 'en',
    purchasePrice: null,
    purchaseCurrency: null,
    estimatedValue: null,
    valueCurrency: null,
    valueSource: 'unknown',
    valueNote: null,
    valueUpdatedAt: null,
    source: 'manual',
    note: null,
    specialVariant: false,
    tags: [],
    lotId: null,
    status: 'owned',
  });
  // PR 22 — surface receive candidates so the caller can offer the
  // standard receive prompt without re-implementing the lookup.
  let receiveCandidates: WishlistReceiveCandidate[] = [];
  try {
    receiveCandidates = await findWishlistReceiveCandidates(
      deps.wishlistRepo,
      result.holding,
    );
  } catch {
    // Receive-flow is non-blocking. Holding is already saved.
    receiveCandidates = [];
  }
  return { result, receiveCandidates };
}
