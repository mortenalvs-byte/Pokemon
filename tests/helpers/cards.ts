// Test fixture helpers that produce CardRecord values matching the
// shape pokemontcg.io v2 actually returns. PR 11 introduced strict
// variant validation that consults `card.tcgplayer.prices` keys, so
// fixtures that only set `tcgplayer: null` no longer round-trip
// through `holdingsRepo.create` etc.
//
// `makeCard()` defaults to a card with the four common printing keys
// (`normal`, `holofoil`, `reverseHolofoil`, `1stEditionNormal`,
// `1stEditionHolofoil`). Tests that want to exercise the unverified
// path can pass `{ tcgplayer: null }` explicitly. Tests that want a
// narrow set of variants can pass `{ priceKeys: ['normal'] }` etc.

import type { CardRecord } from '../../src/domain/types';

export type TcgPriceKey =
  | 'normal'
  | 'holofoil'
  | 'reverseHolofoil'
  | '1stEditionNormal'
  | '1stEditionHolofoil'
  | 'unlimitedNormal'
  | 'unlimitedHolofoil';

export const ALL_PRICE_KEYS: readonly TcgPriceKey[] = [
  'normal',
  'holofoil',
  'reverseHolofoil',
  '1stEditionNormal',
  '1stEditionHolofoil',
];

export interface MakeCardOptions {
  /** Override any field on the produced record. */
  readonly overrides?: Partial<CardRecord>;
  /**
   * Limit which `tcgplayer.prices` keys exist. Defaults to ALL_PRICE_KEYS
   * which cover the common cases (normal + holo + reverse + 1st-ed
   * variants) and let test fixtures pass strict variant validation
   * without thinking about it.
   */
  readonly priceKeys?: readonly TcgPriceKey[];
}

export function makeCard(
  id: string,
  options: MakeCardOptions = {},
): CardRecord {
  const priceKeys = options.priceKeys ?? ALL_PRICE_KEYS;
  const prices: Record<string, { market: number }> = {};
  for (const key of priceKeys) {
    prices[key] = { market: 1 };
  }
  const setId = id.split('-')[0] ?? id;
  return {
    id,
    setId,
    name: `Card ${id}`,
    number: '1',
    rarity: 'Common',
    supertype: 'Pokémon',
    subtypes: [],
    types: [],
    imageSmall: null,
    imageLarge: null,
    tcgplayer:
      priceKeys.length === 0 ? null : { prices },
    cardmarket: null,
    updatedAt: '2026-05-06T00:00:00.000Z',
    ...options.overrides,
  };
}

/** Card with no tcgplayer pricing — exercises the unverified path. */
export function makeUnverifiedCard(
  id: string,
  overrides: Partial<CardRecord> = {},
): CardRecord {
  return makeCard(id, { priceKeys: [], overrides });
}
