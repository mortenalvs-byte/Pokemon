// Pure tests for card-variants helpers. No DB.

import { describe, expect, it } from 'vitest';

import {
  ESCAPE_HATCH_EDITIONS,
  ESCAPE_HATCH_FINISHES,
  REVERSE_HOLO_TEMPLATE_MARKER,
  availableVariants,
  cardHasReverseHolo,
  isReverseHoloTemplateSlot,
} from '../src/domain/card-variants';
import type { CardRecord } from '../src/domain/types';

function makeCard(overrides: Partial<CardRecord> = {}): CardRecord {
  return {
    id: 'base1-1',
    setId: 'base1',
    name: 'Test card',
    number: '1',
    rarity: 'Common',
    supertype: 'Pokémon',
    subtypes: [],
    types: [],
    imageSmall: null,
    imageLarge: null,
    tcgplayer: { prices: { normal: { market: 1 }, holofoil: { market: 1 }, reverseHolofoil: { market: 1 }, "1stEditionNormal": { market: 1 }, "1stEditionHolofoil": { market: 1 } } },
    cardmarket: null,
    updatedAt: '2026-05-06T00:00:00.000Z',
    ...overrides,
  };
}

describe('cardHasReverseHolo', () => {
  it('returns true when tcgplayer.prices.reverseHolofoil is an object', () => {
    const card = makeCard({
      tcgplayer: {
        prices: {
          reverseHolofoil: { market: 4.99, mid: 4.5, low: 3.0 },
        },
      },
    });
    expect(cardHasReverseHolo(card)).toBe(true);
  });

  it('returns false when tcgplayer is null', () => {
    expect(cardHasReverseHolo(makeCard({ tcgplayer: null }))).toBe(false);
  });

  it('returns false when tcgplayer.prices is missing or not an object', () => {
    expect(cardHasReverseHolo(makeCard({ tcgplayer: {} }))).toBe(false);
    expect(
      cardHasReverseHolo(makeCard({ tcgplayer: { prices: null } })),
    ).toBe(false);
    expect(
      cardHasReverseHolo(makeCard({ tcgplayer: { prices: 'oops' } })),
    ).toBe(false);
  });

  it('returns false when reverseHolofoil entry is not an object', () => {
    expect(
      cardHasReverseHolo(
        makeCard({ tcgplayer: { prices: { reverseHolofoil: null } } }),
      ),
    ).toBe(false);
    expect(
      cardHasReverseHolo(
        makeCard({ tcgplayer: { prices: { reverseHolofoil: 4.99 } } }),
      ),
    ).toBe(false);
  });

  it('does not consult cardmarket', () => {
    // Even with cardmarket data showing reverse-holo-like info, the
    // helper relies only on tcgplayer.
    const card = makeCard({
      tcgplayer: null,
      cardmarket: { prices: { trendPrice: 5, lowPrice: 1 } },
    });
    expect(cardHasReverseHolo(card)).toBe(false);
  });

  it('returns false for non-object tcgplayer values (defensive)', () => {
    expect(cardHasReverseHolo(makeCard({ tcgplayer: 'not an object' }))).toBe(
      false,
    );
    expect(cardHasReverseHolo(makeCard({ tcgplayer: 42 }))).toBe(false);
    expect(cardHasReverseHolo(makeCard({ tcgplayer: [] }))).toBe(false);
  });
});

describe('availableVariants', () => {
  it('maps `normal` → finish=normal + edition=unlimited', () => {
    const v = availableVariants(makeCard({ tcgplayer: { prices: { normal: { market: 1 } } } }));
    expect(v.verified).toBe(true);
    expect([...v.finishes]).toEqual(['normal']);
    expect([...v.editions]).toEqual(['unlimited']);
  });

  it('maps `holofoil` → finish=holo + edition=unlimited', () => {
    const v = availableVariants(makeCard({ tcgplayer: { prices: { holofoil: { market: 1 } } } }));
    expect([...v.finishes]).toEqual(['holo']);
    expect([...v.editions]).toEqual(['unlimited']);
  });

  it('maps `reverseHolofoil` → finish=reverse_holo + edition=unlimited', () => {
    const v = availableVariants(
      makeCard({ tcgplayer: { prices: { reverseHolofoil: { market: 1 } } } }),
    );
    expect([...v.finishes]).toEqual(['reverse_holo']);
    expect([...v.editions]).toEqual(['unlimited']);
  });

  it('maps `1stEditionNormal` → finish=normal + edition=first_edition', () => {
    const v = availableVariants(
      makeCard({ tcgplayer: { prices: { '1stEditionNormal': { market: 1 } } } }),
    );
    expect([...v.finishes]).toEqual(['normal']);
    expect([...v.editions]).toEqual(['first_edition']);
  });

  it('maps `1stEditionHolofoil` → finish=holo + edition=first_edition', () => {
    const v = availableVariants(
      makeCard({ tcgplayer: { prices: { '1stEditionHolofoil': { market: 1 } } } }),
    );
    expect([...v.finishes]).toEqual(['holo']);
    expect([...v.editions]).toEqual(['first_edition']);
  });

  it('combines multiple keys into the union', () => {
    const v = availableVariants(
      makeCard({
        tcgplayer: {
          prices: {
            normal: { market: 1 },
            holofoil: { market: 1 },
            reverseHolofoil: { market: 1 },
            '1stEditionHolofoil': { market: 1 },
          },
        },
      }),
    );
    expect([...v.finishes].sort()).toEqual(['holo', 'normal', 'reverse_holo']);
    expect([...v.editions].sort()).toEqual(['first_edition', 'unlimited']);
  });

  it('returns verified=false when tcgplayer is null', () => {
    const v = availableVariants(makeCard({ tcgplayer: null }));
    expect(v.verified).toBe(false);
    expect(v.finishes.size).toBe(0);
    expect(v.editions.size).toBe(0);
  });

  it('returns verified=false when prices contains only unrecognised keys', () => {
    const v = availableVariants(
      makeCard({ tcgplayer: { prices: { someFutureKey: { market: 1 } } } }),
    );
    expect(v.verified).toBe(false);
  });

  it('rejects entries whose value is not a plain object (defensive)', () => {
    const v = availableVariants(
      makeCard({ tcgplayer: { prices: { normal: null, holofoil: 5 } } }),
    );
    expect(v.verified).toBe(false);
  });

  it('does not guess from rarity', () => {
    const v = availableVariants(
      makeCard({ rarity: 'Rare Holo', tcgplayer: null }),
    );
    expect(v.verified).toBe(false);
    expect(v.finishes.has('holo')).toBe(false);
  });

  it('does not consult cardmarket', () => {
    const v = availableVariants(
      makeCard({
        tcgplayer: null,
        cardmarket: { prices: { trendPrice: 5 } },
      }),
    );
    expect(v.verified).toBe(false);
  });

  it('escape-hatch sets are exposed for the form layer', () => {
    expect([...ESCAPE_HATCH_FINISHES].sort()).toEqual(['stamped', 'unknown']);
    expect([...ESCAPE_HATCH_EDITIONS].sort()).toEqual(['shadowless', 'unknown']);
  });
});

describe('REVERSE_HOLO_TEMPLATE_MARKER + isReverseHoloTemplateSlot', () => {
  it('marker is the documented internal token', () => {
    expect(REVERSE_HOLO_TEMPLATE_MARKER).toBe('template:reverse_holo');
  });

  it('isReverseHoloTemplateSlot only matches exact marker', () => {
    expect(isReverseHoloTemplateSlot('template:reverse_holo')).toBe(true);
    expect(isReverseHoloTemplateSlot(null)).toBe(false);
    expect(isReverseHoloTemplateSlot('')).toBe(false);
    expect(isReverseHoloTemplateSlot('reverse holo')).toBe(false);
    expect(isReverseHoloTemplateSlot('template:reverse_holo ')).toBe(false);
  });
});
