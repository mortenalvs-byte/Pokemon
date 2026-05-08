// PR 28 — best-copy scoring engine. Pure: no DB, no DOM, no external
// API, no price/value, no mutation. Decides which holding to put in
// the binder when an `ambiguous_owned` master-gap row has multiple
// valid candidates.
//
// Locked rules:
//   - Wrong finish disqualifies (never recommended, no matter the
//     score). Keeps PR 25's reverse-holo invariant intact.
//   - Tied top scores → manual_required. We never silently pick.
//   - We do NOT use market price. Best-copy is about physical
//     condition + status preferences only.
//   - Quantity > 1 still counts as one physical placement until the
//     future per-unit-splitting PR.
//   - Special variants are penalised only if a non-special candidate
//     exists; otherwise they compete normally.
//
// Score components (additive integers — easy to read in tests):
//   +100  base bonus for being a valid candidate
//   +100  finish matches the required finish (kept here as an
//         explicit signal even though invalid candidates are filtered
//         out earlier)
//
//   condition  NM +60, LP +45, MP +30, HP +15, DMG/UNKNOWN +0
//   language   en +15, other non-empty +5, empty/unknown +0
//   status     owned +25, ordered/wanted -30, duplicate -35,
//              upgrade_needed -45, for_sale/for_trade -50
//
//   graded     -25 if a raw alternative exists, else +5
//   special    -15 if the candidate is specialVariant=true AND a
//              non-special alternative exists; otherwise 0
//
// `reasons` and `penalties` are short Norwegian strings the master-gap
// view can render verbatim.

import type {
  CardFinish,
  HoldingRecord,
  RawCondition,
} from '../domain/types';

export type BestCopyRecommendationStatus =
  | 'recommended'
  | 'manual_required'
  | 'no_candidates';

export interface BestCopyCandidateScore {
  readonly holdingId: string;
  readonly score: number;
  readonly reasons: readonly string[];
  readonly penalties: readonly string[];
}

export interface BestCopyRecommendation {
  readonly status: BestCopyRecommendationStatus;
  readonly recommendedHoldingId: string | null;
  readonly score: number | null;
  readonly reasons: readonly string[];
  readonly candidates: readonly BestCopyCandidateScore[];
}

export interface BestCopyInput {
  readonly requiredFinish: CardFinish | null;
  readonly candidates: readonly HoldingRecord[];
}

export function recommendBestCopy(
  input: BestCopyInput,
): BestCopyRecommendation {
  if (input.candidates.length === 0) {
    return EMPTY;
  }

  // Filter wrong-finish candidates out *before* scoring; they're
  // disqualified outright per PR 25.
  const valid = input.candidates.filter((h) =>
    isFinishValid(h, input.requiredFinish),
  );

  if (valid.length === 0) {
    return EMPTY;
  }

  // Single valid candidate is the easy case — recommend it.
  if (valid.length === 1) {
    const only = valid[0]!;
    const scored = scoreCandidate(only, input.requiredFinish, valid);
    return {
      status: 'recommended',
      recommendedHoldingId: only.id,
      score: scored.score,
      reasons: scored.reasons,
      candidates: [scored],
    };
  }

  // Multiple valid candidates: score each, sort score-desc, then
  // either recommend the unique top OR ask for manual choice.
  const scored = valid.map((h) =>
    scoreCandidate(h, input.requiredFinish, valid),
  );
  const sorted = scored.slice().sort((a, b) => b.score - a.score);
  const top = sorted[0]!;
  const second = sorted[1];
  if (second !== undefined && second.score === top.score) {
    return {
      status: 'manual_required',
      recommendedHoldingId: null,
      score: null,
      reasons: [],
      candidates: sorted,
    };
  }
  return {
    status: 'recommended',
    recommendedHoldingId: top.holdingId,
    score: top.score,
    reasons: top.reasons,
    candidates: sorted,
  };
}

const EMPTY: BestCopyRecommendation = Object.freeze({
  status: 'no_candidates',
  recommendedHoldingId: null,
  score: null,
  reasons: [],
  candidates: [],
});

function isFinishValid(
  holding: HoldingRecord,
  requiredFinish: CardFinish | null,
): boolean {
  if (requiredFinish === null) return true;
  return holding.finish === requiredFinish;
}

function scoreCandidate(
  holding: HoldingRecord,
  requiredFinish: CardFinish | null,
  validPool: readonly HoldingRecord[],
): BestCopyCandidateScore {
  const reasons: string[] = [];
  const penalties: string[] = [];
  let score = 0;

  // Base + finish bonus.
  score += 100;
  reasons.push('Gyldig kandidat');
  if (requiredFinish !== null && holding.finish === requiredFinish) {
    score += 100;
    reasons.push('Finish matcher');
  }

  // Condition.
  const conditionPoints = conditionScore(holding.rawCondition);
  if (conditionPoints > 0) {
    score += conditionPoints;
    reasons.push(`${holding.rawCondition ?? 'UNKNOWN'} condition`);
  } else if (holding.rawCondition === 'DMG') {
    penalties.push('DMG condition');
  } else if (holding.rawCondition === 'UNKNOWN' || holding.rawCondition === null) {
    penalties.push('Ukjent condition');
  }

  // Language.
  const lang = (holding.language ?? '').trim().toLowerCase();
  if (lang === 'en') {
    score += 15;
    reasons.push('English');
  } else if (lang.length > 0) {
    score += 5;
    reasons.push(`Språk: ${lang}`);
  } else {
    penalties.push('Ukjent språk');
  }

  // Status.
  switch (holding.status) {
    case 'owned':
      score += 25;
      reasons.push('Owned');
      break;
    case 'duplicate':
      score -= 35;
      penalties.push('Duplikat');
      break;
    case 'for_sale':
      score -= 50;
      penalties.push('For sale');
      break;
    case 'for_trade':
      score -= 50;
      penalties.push('For trade');
      break;
    case 'upgrade_needed':
      score -= 45;
      penalties.push('Trenger oppgradering');
      break;
    case 'ordered':
      score -= 30;
      penalties.push('Bestilt — ikke mottatt');
      break;
    case 'wanted':
      score -= 30;
      penalties.push('Ønsket — ikke mottatt');
      break;
  }

  // Graded preference: prefer raw if a raw candidate exists.
  const anyRawValid = validPool.some((h) => h.conditionType === 'raw');
  if (holding.conditionType === 'graded') {
    if (anyRawValid) {
      score -= 25;
      penalties.push('Gradet kopi holdes tilbake når raw finnes');
    } else {
      // All valid candidates are graded — small bonus so a graded
      // copy still gets a positive nudge over an UNKNOWN-condition
      // raw blank.
      score += 5;
      reasons.push('Gradet kopi (ingen raw alternativer)');
    }
  } else {
    reasons.push('Raw kopi foretrukket for perm');
  }

  // Special variant: penalise only when a non-special alternative
  // exists. If every valid candidate is special, they compete on
  // condition / status alone.
  const anyNonSpecial = validPool.some((h) => !h.specialVariant);
  if (holding.specialVariant && anyNonSpecial) {
    score -= 15;
    penalties.push('Spesial-variant nedprioritert');
  }

  return {
    holdingId: holding.id,
    score,
    reasons,
    penalties,
  };
}

function conditionScore(condition: RawCondition | null): number {
  switch (condition) {
    case 'NM':
      return 60;
    case 'LP':
      return 45;
    case 'MP':
      return 30;
    case 'HP':
      return 15;
    case 'DMG':
      return 0;
    case 'UNKNOWN':
      return 0;
    case null:
      return 0;
  }
}
