// PR 15A — F-6 unit tests for the shared card-search predicate.

import { describe, expect, it } from 'vitest';

import {
  cardMatchesQuery,
  isEmptyQuery,
  normalizeQuery,
} from '../src/domain/card-search';
import type { CardRecord, SetRecord } from '../src/domain/types';

const charizardBase: CardRecord = {
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

const tgCard: CardRecord = {
  ...charizardBase,
  id: 'crz-TG01',
  setId: 'crz',
  name: 'Comfey',
  number: 'TG01',
};

const swshCard: CardRecord = {
  ...charizardBase,
  id: 'swshp-SWSH050',
  setId: 'swshp',
  name: 'Charizard V',
  number: 'SWSH050',
};

const mewEx: CardRecord = {
  ...charizardBase,
  id: 'sv6-232',
  setId: 'sv6',
  name: 'Mew ex',
  number: '232',
};

const baseSet: SetRecord = {
  id: 'base1',
  name: 'Base',
  series: 'Base',
  printedTotal: 102,
  total: 102,
  releaseDate: '1999/01/09',
  symbolUrl: null,
  logoUrl: null,
  updatedAt: '2026-05-06T00:00:00.000Z',
};

const setsById = new Map<string, SetRecord>([
  [baseSet.id, baseSet],
  [
    'crz',
    {
      ...baseSet,
      id: 'crz',
      name: 'Crown Zenith',
      releaseDate: '2023/01/20',
    },
  ],
  [
    'swshp',
    {
      ...baseSet,
      id: 'swshp',
      name: 'SWSH Black Star Promos',
      releaseDate: '2020/01/01',
    },
  ],
  [
    'sv6',
    {
      ...baseSet,
      id: 'sv6',
      name: 'Twilight Masquerade',
      releaseDate: '2024/05/24',
    },
  ],
]);

describe('normalizeQuery', () => {
  it('lowercases', () => {
    expect(normalizeQuery('CharIZArd')).toBe('charizard');
  });
  it('trims', () => {
    expect(normalizeQuery('   Mew ex   ')).toBe('mew ex');
  });
  it('collapses inner whitespace', () => {
    expect(normalizeQuery('base1     4')).toBe('base1 4');
  });
});

describe('isEmptyQuery', () => {
  it('empty string is empty', () => expect(isEmptyQuery('')).toBe(true));
  it('whitespace is empty', () => expect(isEmptyQuery('   ')).toBe(true));
  it('non-empty is not empty', () =>
    expect(isEmptyQuery('Charizard')).toBe(false));
});

describe('cardMatchesQuery — empty query matches everything', () => {
  it('empty', () => expect(cardMatchesQuery(charizardBase, '')).toBe(true));
  it('whitespace', () =>
    expect(cardMatchesQuery(charizardBase, '   ')).toBe(true));
});

describe('cardMatchesQuery — name match', () => {
  it('exact name', () =>
    expect(cardMatchesQuery(charizardBase, 'Charizard')).toBe(true));
  it('case-insensitive', () =>
    expect(cardMatchesQuery(charizardBase, 'charizard')).toBe(true));
  it('substring', () =>
    expect(cardMatchesQuery(charizardBase, 'chari')).toBe(true));
  it('does not match unrelated', () =>
    expect(cardMatchesQuery(charizardBase, 'Pikachu')).toBe(false));
  it('whitespace is trimmed', () =>
    expect(cardMatchesQuery(charizardBase, '  Charizard  ')).toBe(true));
});

describe('cardMatchesQuery — id match', () => {
  it('exact id', () =>
    expect(cardMatchesQuery(charizardBase, 'base1-4')).toBe(true));
  it('id substring', () =>
    expect(cardMatchesQuery(charizardBase, 'base1-')).toBe(true));
  it('id case-insensitive', () =>
    expect(cardMatchesQuery(swshCard, 'swshp-swsh050')).toBe(true));
  it('does not match different id', () =>
    expect(cardMatchesQuery(charizardBase, 'base2-4')).toBe(false));
});

describe('cardMatchesQuery — set id', () => {
  it('exact set id matches every card in that set', () => {
    expect(cardMatchesQuery(charizardBase, 'base1')).toBe(true);
    expect(cardMatchesQuery(mewEx, 'base1')).toBe(false);
    expect(cardMatchesQuery(mewEx, 'sv6')).toBe(true);
  });
  it('set id is case-insensitive', () =>
    expect(cardMatchesQuery(charizardBase, 'BASE1')).toBe(true));
});

describe('cardMatchesQuery — set name (requires setsById)', () => {
  it('matches by set name substring', () =>
    expect(cardMatchesQuery(charizardBase, 'Base', { setsById })).toBe(true));
  it('matches by set name longer substring', () =>
    expect(
      cardMatchesQuery(swshCard, 'Black Star', { setsById }),
    ).toBe(true));
  it('does not match without setsById context', () =>
    expect(cardMatchesQuery(swshCard, 'Crown Zenith')).toBe(false));
});

describe('cardMatchesQuery — card number', () => {
  it('numeric exact', () =>
    expect(cardMatchesQuery(charizardBase, '4')).toBe(true));
  it('"4/102" matches card number "4"', () =>
    expect(cardMatchesQuery(charizardBase, '4/102')).toBe(true));
  it('alphanumeric exact', () =>
    expect(cardMatchesQuery(tgCard, 'TG01')).toBe(true));
  it('alphanumeric case-insensitive', () =>
    expect(cardMatchesQuery(tgCard, 'tg01')).toBe(true));
  it('SWSH-style number', () =>
    expect(cardMatchesQuery(swshCard, 'SWSH050')).toBe(true));
  it('does not match wrong number', () =>
    expect(cardMatchesQuery(charizardBase, '232')).toBe(false));
});

describe('cardMatchesQuery — compound queries', () => {
  it('"Charizard 4" matches name + number', () =>
    expect(cardMatchesQuery(charizardBase, 'Charizard 4')).toBe(true));
  it('"chari 4" matches partial name + number', () =>
    expect(cardMatchesQuery(charizardBase, 'chari 4')).toBe(true));
  it('"Charizard 5" does NOT match (name OK but wrong number)', () =>
    expect(cardMatchesQuery(charizardBase, 'Charizard 5')).toBe(false));
  it('"base1 4" matches set id + number', () =>
    expect(cardMatchesQuery(charizardBase, 'base1 4')).toBe(true));
  it('"base1 5" does NOT match (set OK but wrong number)', () =>
    expect(cardMatchesQuery(charizardBase, 'base1 5')).toBe(false));
  it('"Base 4" matches set name + number', () =>
    expect(cardMatchesQuery(charizardBase, 'Base 4', { setsById })).toBe(true));
  it('"Base Set 4" matches set name (multi-word) + number', () => {
    // "Base Set" is not the exact set name in our fixture — it's "Base"
    // — so this should be false unless we change the fixture. Confirm
    // graceful behaviour:
    expect(cardMatchesQuery(charizardBase, 'Base Set 4', { setsById })).toBe(
      false,
    );
  });
  it('"Mew ex 232" matches set sv6 by number with multi-word name', () =>
    expect(cardMatchesQuery(mewEx, 'Mew ex 232')).toBe(true));
  it('"Mew ex 233" does NOT match (wrong number)', () =>
    expect(cardMatchesQuery(mewEx, 'Mew ex 233')).toBe(false));
  it('compound "Charizard 4/102" still works', () =>
    expect(cardMatchesQuery(charizardBase, 'Charizard 4/102')).toBe(true));
});

describe('cardMatchesQuery — gracefully ignores ambiguous compound', () => {
  it('"Mega ex" is treated as plain name search (not compound)', () => {
    // "ex" is alphabetic-only; not parsed as a card number.
    // So the predicate falls back to plain name substring match.
    const megaEx = { ...charizardBase, name: 'Mega Charizard ex' };
    expect(cardMatchesQuery(megaEx, 'Mega ex')).toBe(false); // not contiguous
    expect(cardMatchesQuery(megaEx, 'Mega Charizard ex')).toBe(true);
  });
});

describe('cardMatchesQuery — negative cases', () => {
  it('unrelated query', () =>
    expect(cardMatchesQuery(charizardBase, 'xyz123notreal')).toBe(false));
  it('wrong set id + valid number', () =>
    expect(cardMatchesQuery(charizardBase, 'sv6 4')).toBe(false));
});
