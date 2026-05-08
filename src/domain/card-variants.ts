// Card-variant helpers: derive what printings actually exist for a
// given card based on the pokemontcg.io API data we already cache.
//
// Pokémon TCG API exposes per-printing pricing in `card.tcgplayer.prices`.
// Each key in that object names a printing the card was actually
// produced in. We treat the key set as the canonical truth: if a key
// is there, the printing exists; if not, it doesn't. We never guess
// from rarity, set name, card name, or `cardmarket` data — see
// `BACKUP_FORMAT.md` and the PR review notes.
//
// Recognised keys:
//   normal               → finish=normal       edition=unlimited
//   holofoil             → finish=holo         edition=unlimited
//   reverseHolofoil      → finish=reverse_holo edition=unlimited
//   1stEditionNormal     → finish=normal       edition=first_edition
//   1stEditionHolofoil   → finish=holo         edition=first_edition
//   unlimitedNormal      → finish=normal       edition=unlimited
//   unlimitedHolofoil    → finish=holo         edition=unlimited
//
// `unlimitedNormal` / `unlimitedHolofoil` were initially locked out
// because PR 11's review couldn't prove they appeared in pokemontcg.io
// data. The PR 14 QA report (F-2) verified them in live cache against
// 837 cards (4.3% of the 19 545-card priced cache) — Base / Jungle /
// Fossil unlimited holos in particular surface them. Mapping them to
// the unlimited+normal / unlimited+holo pair lets the user record
// these classic prints without falling through to the escape-hatch
// path. (Live data also occasionally shows them coexisting with their
// `1stEdition*` siblings; both edition values then surface, which is
// what we want.)
//
// Every other key — lowercase `firstEdition*`, other weird casings,
// future tcgplayer keys, and any cardmarket fields — is still
// deliberately ignored. No guessing. If a future PR proves such a key
// actually exists in our cache via documented API fixture, it can be
// added with its own dedicated test.
//
// `availableVariants(card)` returns:
//   { verified: true,  finishes, editions } — when at least one
//                                             recognised key is present
//   { verified: false, finishes:∅, editions:∅ } — when tcgplayer.prices
//                                             is missing, malformed,
//                                             empty, or only contains
//                                             unrecognised keys
//
// The form layer narrows dropdowns from this set; the repo layer runs
// the same rule at submit time so a user editing form state via
// devtools cannot bypass it. See `domain/validators.ts` for the
// validation predicates.

import type {
  CardFinish,
  CardRecord,
  Edition,
} from './types';

/**
 * Slot.note marker used to flag a generated reverse-holo template slot.
 *
 * `BinderSlotRecord` has no `finish` field, so we encode the variant
 * in `note` as a stable internal token. The UI renders this as the
 * finish "Reverse holo" and never shows the raw token to the user.
 *
 * Tøm slot in PR 8a preserves `note`, so the marker survives the
 * status-reset round-trip. assign-holding-modal in PR 8a does not
 * touch `note`, so the marker also survives an assignment.
 */
export const REVERSE_HOLO_TEMPLATE_MARKER = 'template:reverse_holo';

export interface AvailableVariants {
  /**
   * `true` iff at least one recognised key was found. Forms and the
   * repo validator branch on this — when `false`, only escape-hatch
   * finishes/editions are allowed, and a marker (`specialVariant=true`
   * or a non-empty `note`) is required.
   */
  readonly verified: boolean;
  readonly finishes: ReadonlySet<CardFinish>;
  readonly editions: ReadonlySet<Edition>;
}

const EMPTY: AvailableVariants = Object.freeze({
  verified: false,
  finishes: new Set<CardFinish>(),
  editions: new Set<Edition>(),
});

/**
 * "Escape hatch" finishes: always selectable in the UI but require
 * `specialVariant=true` or a non-empty `note` at submit time, since
 * the API cannot prove they exist for the chosen card.
 *
 * Per the PR review lock, only `unknown` and `stamped` qualify.
 * `non_holo` is not an escape hatch — if the API doesn't list a
 * non-holo printing, the user must record the card as `unknown` +
 * note/specialVariant.
 */
export const ESCAPE_HATCH_FINISHES: ReadonlySet<CardFinish> = new Set<CardFinish>([
  'unknown',
  'stamped',
]);

/**
 * Same idea for `Edition`. `shadowless` is real but never
 * API-detectable, so it is always treated as a manual / special
 * variant requiring note/specialVariant.
 */
export const ESCAPE_HATCH_EDITIONS: ReadonlySet<Edition> = new Set<Edition>([
  'unknown',
  'shadowless',
]);

export function cardHasReverseHolo(card: CardRecord): boolean {
  return availableVariants(card).finishes.has('reverse_holo');
}

export function isReverseHoloTemplateSlot(note: string | null): boolean {
  return note === REVERSE_HOLO_TEMPLATE_MARKER;
}

export function availableVariants(card: CardRecord): AvailableVariants {
  const prices = readTcgplayerPrices(card);
  if (prices === null) return EMPTY;

  const finishes = new Set<CardFinish>();
  const editions = new Set<Edition>();
  for (const [key, value] of Object.entries(prices)) {
    // The API exposes each printing as a plain object with market /
    // low / mid / high fields. A `null` or scalar value here means the
    // entry was malformed or stripped; we treat that as "not present"
    // and refuse to infer the printing exists. Same defence as the
    // PR 8b cardHasReverseHolo helper.
    if (!isPlainObject(value)) continue;
    switch (key) {
      case 'normal':
        finishes.add('normal');
        editions.add('unlimited');
        break;
      case 'holofoil':
        finishes.add('holo');
        editions.add('unlimited');
        break;
      case 'reverseHolofoil':
        finishes.add('reverse_holo');
        editions.add('unlimited');
        break;
      case '1stEditionNormal':
        finishes.add('normal');
        editions.add('first_edition');
        break;
      case '1stEditionHolofoil':
        finishes.add('holo');
        editions.add('first_edition');
        break;
      case 'unlimitedNormal':
        // F-2 (PR 14 QA) — verified in live cache. The `unlimited`
        // edition was already implied by `normal`/`holofoil`, but
        // these explicit keys appear on Base/Jungle/Fossil unlimited
        // holos when the API also exposes a `1stEdition*` key, so
        // ignoring them lost an entire printing.
        finishes.add('normal');
        editions.add('unlimited');
        break;
      case 'unlimitedHolofoil':
        finishes.add('holo');
        editions.add('unlimited');
        break;
      // Unrecognised keys are deliberately ignored. We do not guess.
    }
  }

  if (finishes.size === 0 && editions.size === 0) return EMPTY;
  return { verified: true, finishes, editions };
}

function readTcgplayerPrices(card: CardRecord): Record<string, unknown> | null {
  const tcgplayer = card.tcgplayer;
  if (!isPlainObject(tcgplayer)) return null;
  const prices = tcgplayer['prices'];
  if (!isPlainObject(prices)) return null;
  return prices;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
