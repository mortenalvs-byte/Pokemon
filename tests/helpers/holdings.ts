// PR 36 — shared holding-input factory for tests.
//
// Before PR 36, ~30 test files each declared a local
// `holdingInput(cardId, overrides?)` (or `baseHolding`) returning
// the same default-filled `HoldingInput`. That duplication made
// future per-view audit tests (PR 30 audit § Phase G) duplicate
// the boilerplate again.
//
// `holdingInput()` returns a HoldingInput that:
//   - passes `validateHoldingInput` (quantity ≥ 1, raw with
//     rawCondition NM, no graded fields, no negative prices)
//   - passes `validateHoldingVariants` against any card produced
//     by `makeCard()` from `tests/helpers/cards.ts` (default
//     finish 'normal' + edition 'unlimited' map onto
//     tcgplayer.prices.normal which `makeCard()` always sets)
//   - has `status: 'owned'` + `source: 'manual'` + `tags: []`
//
// Override any field via `overrides`. The factory does NOT call
// the holdings repo; tests choose when to persist.
//
// `seedHolding(db, cardId, overrides?)` is the convenience wrapper
// that creates the holding through the real `holdingsRepo.create`
// path — same validation chain a UI form would hit.

import type { HoldingInput } from '../../src/domain/validators';
import type { PokemonTrackerDB } from '../../src/db/database';
import { createHoldingsRepo } from '../../src/repositories/holdings-repo';

export function holdingInput(
  cardId: string,
  overrides: Partial<HoldingInput> = {},
): HoldingInput {
  return {
    cardId,
    quantity: 1,
    conditionType: 'raw',
    rawCondition: 'NM',
    gradingCompany: null,
    grade: null,
    certNumber: null,
    certUrl: null,
    gradedDate: null,
    finish: 'normal',
    edition: 'unlimited',
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
    ...overrides,
  };
}

export async function seedHolding(
  db: PokemonTrackerDB,
  cardId: string,
  overrides: Partial<HoldingInput> = {},
): Promise<Awaited<ReturnType<ReturnType<typeof createHoldingsRepo>['create']>>> {
  return createHoldingsRepo(db).create(holdingInput(cardId, overrides));
}
