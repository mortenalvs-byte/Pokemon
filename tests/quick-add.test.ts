// PR 15B — unit tests for `decideQuickAdd`.
//
// The decision helper is pure: it inspects the cached card's
// tcgplayer.prices and returns either the verified default
// (finish + edition) for a one-click raw NM add, or a refusal with
// a Norwegian reason that the Browse view shows as the disabled
// button's tooltip.

import { describe, expect, it } from 'vitest';

import { decideQuickAdd } from '../src/components/quick-add';
import type { CardRecord } from '../src/domain/types';

const baseCard: CardRecord = {
  id: 'base1-4',
  setId: 'base1',
  name: 'Charizard',
  number: '4',
  rarity: 'Rare Holo',
  supertype: 'Pokémon',
  subtypes: ['Stage 2'],
  types: ['Fire'],
  imageSmall: null,
  imageLarge: null,
  tcgplayer: null,
  cardmarket: null,
  updatedAt: '2026-05-06T00:00:00.000Z',
};

function withPrices(prices: Record<string, unknown>): CardRecord {
  return {
    ...baseCard,
    tcgplayer: { prices },
  };
}

describe('decideQuickAdd', () => {
  it('refuses when tcgplayer.prices is null', () => {
    const decision = decideQuickAdd(baseCard);
    expect(decision.canQuickAdd).toBe(false);
    expect(decision.defaults).toBeNull();
    expect(decision.reason).toContain('Mangler API-verifisert variant');
  });

  it('refuses when prices is empty', () => {
    const decision = decideQuickAdd(withPrices({}));
    expect(decision.canQuickAdd).toBe(false);
    expect(decision.defaults).toBeNull();
  });

  it('refuses when prices only contains unrecognised keys (e.g. unlimitedHolofoil today)', () => {
    // PR 15A finding F-2 — unlimitedHolofoil keys are not yet mapped
    // by `availableVariants`. Quick Add must not silently invent a
    // finish/edition for those.
    const decision = decideQuickAdd(
      withPrices({ unlimitedHolofoil: { market: 1 } }),
    );
    expect(decision.canQuickAdd).toBe(false);
    expect(decision.reason).toContain('variant');
  });

  it('normal-only card → default normal + unlimited', () => {
    const decision = decideQuickAdd(withPrices({ normal: { market: 1 } }));
    expect(decision.canQuickAdd).toBe(true);
    expect(decision.defaults).toEqual({
      finish: 'normal',
      edition: 'unlimited',
    });
  });

  it('holofoil-only card → default holo + unlimited', () => {
    const decision = decideQuickAdd(withPrices({ holofoil: { market: 1 } }));
    expect(decision.canQuickAdd).toBe(true);
    expect(decision.defaults).toEqual({
      finish: 'holo',
      edition: 'unlimited',
    });
  });

  it('normal + reverseHolofoil prefers normal (lowest-friction default)', () => {
    const decision = decideQuickAdd(
      withPrices({
        normal: { market: 1 },
        reverseHolofoil: { market: 1 },
      }),
    );
    expect(decision.canQuickAdd).toBe(true);
    expect(decision.defaults).toEqual({
      finish: 'normal',
      edition: 'unlimited',
    });
  });

  it('holofoil + reverseHolofoil prefers holo over reverse_holo', () => {
    const decision = decideQuickAdd(
      withPrices({
        holofoil: { market: 1 },
        reverseHolofoil: { market: 1 },
      }),
    );
    expect(decision.canQuickAdd).toBe(true);
    expect(decision.defaults).toEqual({
      finish: 'holo',
      edition: 'unlimited',
    });
  });

  it('reverseHolofoil-only card → default reverse_holo + unlimited', () => {
    // Real cards exist in this state — see STRESS-1 cache profile in
    // QA report (43 such cards).
    const decision = decideQuickAdd(
      withPrices({ reverseHolofoil: { market: 1 } }),
    );
    expect(decision.canQuickAdd).toBe(true);
    expect(decision.defaults).toEqual({
      finish: 'reverse_holo',
      edition: 'unlimited',
    });
  });

  it('1stEditionHolofoil + holofoil prefers unlimited over first_edition', () => {
    // The map yields finishes={holo}, editions={unlimited, first_edition}.
    // Defaulting to first_edition would be wrong for the common bulk
    // case (most adds are unlimited).
    const decision = decideQuickAdd(
      withPrices({
        '1stEditionHolofoil': { market: 1 },
        holofoil: { market: 1 },
      }),
    );
    expect(decision.canQuickAdd).toBe(true);
    expect(decision.defaults).toEqual({
      finish: 'holo',
      edition: 'unlimited',
    });
  });

  it('only 1stEditionHolofoil → default holo + first_edition (no unlimited path available)', () => {
    const decision = decideQuickAdd(
      withPrices({ '1stEditionHolofoil': { market: 1 } }),
    );
    expect(decision.canQuickAdd).toBe(true);
    expect(decision.defaults).toEqual({
      finish: 'holo',
      edition: 'first_edition',
    });
  });

  it('refuses when the price entry is malformed (null value, scalar)', () => {
    const decision = decideQuickAdd(
      withPrices({ normal: null }) as CardRecord,
    );
    expect(decision.canQuickAdd).toBe(false);
  });
});
