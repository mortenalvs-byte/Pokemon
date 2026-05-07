// Pure tests for card-variants helpers. No DB.

import { describe, expect, it } from 'vitest';

import {
  REVERSE_HOLO_TEMPLATE_MARKER,
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
    tcgplayer: null,
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
