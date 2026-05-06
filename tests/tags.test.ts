import { describe, expect, it } from 'vitest';

import { formatTags, parseTags } from '../src/domain/tags';

describe('parseTags', () => {
  it('returns an empty array for an empty string', () => {
    expect(parseTags('')).toEqual([]);
  });

  it('splits on commas, trims, and lowercases', () => {
    expect(parseTags('favorite, to_grade,  HIGH_VALUE,favorite')).toEqual([
      'favorite',
      'to_grade',
      'high_value',
    ]);
  });

  it('drops empty tokens', () => {
    expect(parseTags('a, ,b,,, c')).toEqual(['a', 'b', 'c']);
  });

  it('preserves first-occurrence order', () => {
    expect(parseTags('Z, a, A, b, z')).toEqual(['z', 'a', 'b']);
  });

  it('handles tab and newline whitespace inside tokens', () => {
    expect(parseTags('  hello\tworld , foo\nbar ')).toEqual([
      'hello\tworld',
      'foo\nbar',
    ]);
  });
});

describe('formatTags', () => {
  it('joins with ", "', () => {
    expect(formatTags(['favorite', 'to_grade'])).toBe('favorite, to_grade');
  });

  it('round-trips through parseTags', () => {
    const original = ['high_value', 'favorite', 'check_condition'];
    expect(parseTags(formatTags(original))).toEqual(original);
  });
});
