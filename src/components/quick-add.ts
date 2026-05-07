// Quick Add Raw — decision helper.
//
// Pure function that decides whether a single Browse / Card-detail row
// can offer a one-click "Add raw NM" button, and which verified
// finish/edition the click should use.
//
// Quick Add is intentionally narrow:
//   - Only fires when `availableVariants(card).verified === true`.
//   - Picks the first verified finish in the order
//       normal → holo → reverse_holo
//     and the first verified edition in the order
//       unlimited → first_edition.
//     This mirrors the holding form's defaulting and avoids surprising
//     the user with a finish/edition they didn't intend.
//   - When the card has tcgplayer prices but none of the recognised
//     keys map to a finish + edition pair (e.g. only `unlimitedHolofoil`
//     today, see PR 14 review note F-2), Quick Add is disabled and
//     the user is sent to the full holding form via the existing
//     "Legg til i samling" button.
//
// No DOM, no IO. The Browse view does the actual repo write via
// `holdingsRepo.upsertByVariant`, so the variant validator at the repo
// layer still has the final say — Quick Add does not bypass anything.

import { availableVariants } from '../domain/card-variants';
import type { CardFinish, CardRecord, Edition } from '../domain/types';

export interface QuickAddDefault {
  readonly finish: CardFinish;
  readonly edition: Edition;
}

export interface QuickAddDecision {
  /** `true` iff the row can offer the Quick Add button. */
  readonly canQuickAdd: boolean;
  /** The variant defaults to fire with — present iff `canQuickAdd`. */
  readonly defaults: QuickAddDefault | null;
  /**
   * Short Norwegian explanation rendered as a tooltip when
   * `canQuickAdd === false`. Always empty when Quick Add is allowed.
   */
  readonly reason: string;
}

const FINISH_PREFERENCE: readonly CardFinish[] = ['normal', 'holo', 'reverse_holo'];
const EDITION_PREFERENCE: readonly Edition[] = ['unlimited', 'first_edition'];

export function decideQuickAdd(card: CardRecord): QuickAddDecision {
  const variants = availableVariants(card);
  if (!variants.verified) {
    return {
      canQuickAdd: false,
      defaults: null,
      reason:
        'Mangler API-verifisert variant — bruk "Legg til i samling" for å oppgi variant manuelt.',
    };
  }
  const finish = pickFirst(FINISH_PREFERENCE, (f) => variants.finishes.has(f));
  const edition = pickFirst(EDITION_PREFERENCE, (e) => variants.editions.has(e));
  if (finish === null || edition === null) {
    return {
      canQuickAdd: false,
      defaults: null,
      reason:
        'Variantdata er ufullstendig — bruk "Legg til i samling" for å oppgi finish/edition.',
    };
  }
  return {
    canQuickAdd: true,
    defaults: { finish, edition },
    reason: '',
  };
}

function pickFirst<T>(
  prefs: readonly T[],
  isPresent: (value: T) => boolean,
): T | null {
  for (const v of prefs) {
    if (isPresent(v)) return v;
  }
  return null;
}
