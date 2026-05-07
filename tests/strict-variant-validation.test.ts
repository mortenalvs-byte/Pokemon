// Strict variant validation (PR 11). Two layers:
//   1. Pure: validateHoldingVariants / validateLotItemVariants /
//      validateWishlistVariants — given a card and an input, decide
//      whether the finish/edition is acceptable.
//   2. Repo: holdingsRepo.create / lotItemsRepo.create /
//      wishlistRepo.create must run the same rule at submit time so
//      a user editing form state via devtools cannot persist a
//      finish the API does not list.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeAndDelete, freshDb } from './helpers/fresh-db';
import {
  validateHoldingVariants,
  validateLotItemVariants,
  validateWishlistVariants,
  ValidationError,
} from '../src/domain/validators';
import { createCardsRepo } from '../src/repositories/cards-repo';
import { createHoldingsRepo } from '../src/repositories/holdings-repo';
import { createLotItemsRepo } from '../src/repositories/lot-items-repo';
import { createLotsRepo } from '../src/repositories/lots-repo';
import { createWishlistRepo } from '../src/repositories/wishlist-repo';
import type { CardRecord } from '../src/domain/types';
import type {
  HoldingInput,
  LotItemInput,
  WishlistInput,
} from '../src/domain/validators';
import type { PokemonTrackerDB } from '../src/db/database';

function makeCard(
  id: string,
  prices: Record<string, unknown> | null,
): CardRecord {
  return {
    id,
    setId: 'base1',
    name: 'Test',
    number: '1',
    rarity: 'Common',
    supertype: 'Pokémon',
    subtypes: [],
    types: [],
    imageSmall: null,
    imageLarge: null,
    tcgplayer: prices === null ? null : { prices },
    cardmarket: null,
    updatedAt: '2026-05-06T00:00:00.000Z',
  };
}

function holdingInput(
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

function lotItemInput(
  lotId: string,
  cardId: string,
  overrides: Partial<LotItemInput> = {},
): LotItemInput {
  return {
    lotId,
    cardId,
    finish: 'normal',
    edition: 'unlimited',
    conditionType: 'raw',
    rawCondition: 'NM',
    gradingCompany: null,
    grade: null,
    quantity: 1,
    manualPriceOverride: null,
    marketEstimate: null,
    allocatedCost: null,
    holdingId: null,
    note: null,
    ...overrides,
  };
}

function wishlistInput(
  cardId: string,
  overrides: Partial<WishlistInput> = {},
): WishlistInput {
  return {
    cardId,
    finish: 'normal',
    priority: 'medium',
    targetCondition: null,
    targetPrice: null,
    targetCurrency: null,
    status: 'wanted',
    note: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------
// Pure validators

describe('validateHoldingVariants', () => {
  it('accepts a finish/edition the card explicitly lists', () => {
    const card = makeCard('c', {
      normal: { market: 1 },
      reverseHolofoil: { market: 1 },
    });
    expect(() =>
      validateHoldingVariants(holdingInput('c', { finish: 'normal' }), { card }),
    ).not.toThrow();
    expect(() =>
      validateHoldingVariants(holdingInput('c', { finish: 'reverse_holo' }), { card }),
    ).not.toThrow();
  });

  it('rejects holo when the card only has normal', () => {
    const card = makeCard('c', { normal: { market: 1 } });
    expect(() =>
      validateHoldingVariants(holdingInput('c', { finish: 'holo' }), { card }),
    ).toThrow(ValidationError);
  });

  it('rejects reverse_holo when the API does not expose reverseHolofoil', () => {
    const card = makeCard('c', { normal: { market: 1 } });
    expect(() =>
      validateHoldingVariants(holdingInput('c', { finish: 'reverse_holo' }), { card }),
    ).toThrow(ValidationError);
  });

  it('rejects first_edition when the API does not expose any 1stEdition*', () => {
    const card = makeCard('c', { normal: { market: 1 } });
    expect(() =>
      validateHoldingVariants(
        holdingInput('c', { edition: 'first_edition' }),
        { card },
      ),
    ).toThrow(ValidationError);
  });

  it('rejects unknown finish without specialVariant or note', () => {
    const card = makeCard('c', { normal: { market: 1 } });
    expect(() =>
      validateHoldingVariants(holdingInput('c', { finish: 'unknown' }), { card }),
    ).toThrow(/specialVariant|note/);
  });

  it('accepts unknown finish with specialVariant=true', () => {
    const card = makeCard('c', { normal: { market: 1 } });
    expect(() =>
      validateHoldingVariants(
        holdingInput('c', { finish: 'unknown', specialVariant: true }),
        { card },
      ),
    ).not.toThrow();
  });

  it('accepts unknown finish with a non-empty note', () => {
    const card = makeCard('c', { normal: { market: 1 } });
    expect(() =>
      validateHoldingVariants(
        holdingInput('c', { finish: 'unknown', note: 'misprint' }),
        { card },
      ),
    ).not.toThrow();
  });

  it('rejects every non-escape finish when card has no tcgplayer.prices', () => {
    const card = makeCard('c', null);
    expect(() =>
      validateHoldingVariants(holdingInput('c', { finish: 'normal' }), { card }),
    ).toThrow(ValidationError);
    expect(() =>
      validateHoldingVariants(holdingInput('c', { finish: 'holo' }), { card }),
    ).toThrow(ValidationError);
  });

  it('accepts unknown finish + edition with specialVariant when card has no tcgplayer.prices', () => {
    const card = makeCard('c', null);
    // Both finish and edition must take an escape-hatch value when
    // the card is unverified — `unlimited` is not in the verified set.
    expect(() =>
      validateHoldingVariants(
        holdingInput('c', {
          finish: 'unknown',
          edition: 'unknown',
          specialVariant: true,
        }),
        { card },
      ),
    ).not.toThrow();
  });

  it('rejects the input when card is missing entirely from the cache', () => {
    expect(() =>
      validateHoldingVariants(holdingInput('c', { finish: 'normal' }), {
        card: null,
      }),
    ).toThrow(ValidationError);
  });
});

describe('validateLotItemVariants', () => {
  it('rejects holo when the card only has normal', () => {
    const card = makeCard('c', { normal: { market: 1 } });
    expect(() =>
      validateLotItemVariants(lotItemInput('lot', 'c', { finish: 'holo' }), { card }),
    ).toThrow(ValidationError);
  });

  it('accepts unknown finish + edition when note is non-empty', () => {
    const card = makeCard('c', null);
    expect(() =>
      validateLotItemVariants(
        lotItemInput('lot', 'c', {
          finish: 'unknown',
          edition: 'unknown',
          note: 'manual entry',
        }),
        { card },
      ),
    ).not.toThrow();
  });
});

describe('validateWishlistVariants', () => {
  it('rejects reverse_holo when card lacks reverseHolofoil key', () => {
    const card = makeCard('c', { normal: { market: 1 } });
    expect(() =>
      validateWishlistVariants(
        wishlistInput('c', { finish: 'reverse_holo' }),
        { card },
      ),
    ).toThrow(ValidationError);
  });

  it('accepts a verified finish on the card', () => {
    const card = makeCard('c', {
      normal: { market: 1 },
      reverseHolofoil: { market: 1 },
    });
    expect(() =>
      validateWishlistVariants(
        wishlistInput('c', { finish: 'reverse_holo' }),
        { card },
      ),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------
// Repo-level enforcement (devtools-style bypass)

describe('repos enforce variant validation at submit time', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    db = await freshDb();
  });

  afterEach(async () => {
    await closeAndDelete(db);
  });

  it('holdingsRepo.create rejects a finish the card does not list', async () => {
    await createCardsRepo(db).upsert(makeCard('c', { normal: { market: 1 } }));
    await expect(
      createHoldingsRepo(db).create(holdingInput('c', { finish: 'holo' })),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await db.holdings.count()).toBe(0);
    expect(await db.auditLog.where('action').equals('holding_created').count()).toBe(0);
  });

  it('holdingsRepo.create rejects when card is missing from the cache', async () => {
    await expect(
      createHoldingsRepo(db).create(holdingInput('uncached')),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await db.holdings.count()).toBe(0);
  });

  it('holdingsRepo.update re-validates against the card', async () => {
    await createCardsRepo(db).upsert(
      makeCard('c', { normal: { market: 1 }, holofoil: { market: 1 } }),
    );
    const holding = await createHoldingsRepo(db).create(
      holdingInput('c', { finish: 'normal' }),
    );
    // Trying to flip the existing holding to a finish the API does
    // not list must fail at update too.
    await createCardsRepo(db).upsert(
      makeCard('c', { normal: { market: 1 } }), // remove holofoil
    );
    await expect(
      createHoldingsRepo(db).update(holding.id, { finish: 'holo' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('lotItemsRepo.create rejects an unverifiable finish', async () => {
    const lot = await createLotsRepo(db).create({
      name: 'Lot',
      purchaseDate: '2026-04-01T00:00:00.000Z',
      totalCost: 100,
      currency: 'NOK',
      allocationMethod: 'equal',
      notes: null,
    });
    await createCardsRepo(db).upsert(makeCard('c', { normal: { market: 1 } }));
    await expect(
      createLotItemsRepo(db).create(
        lotItemInput(lot.id, 'c', { finish: 'reverse_holo' }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('wishlistRepo.create rejects an unverifiable finish', async () => {
    await createCardsRepo(db).upsert(makeCard('c', { normal: { market: 1 } }));
    await expect(
      createWishlistRepo(db).create(
        wishlistInput('c', { finish: 'holo' }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('escape-hatch path requires note or specialVariant — bypass via raw input fails', async () => {
    await createCardsRepo(db).upsert(makeCard('c', { normal: { market: 1 } }));
    // A "devtools" bypass attempt: pick `unknown` without any marker.
    await expect(
      createHoldingsRepo(db).create(
        holdingInput('c', { finish: 'unknown' }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

