// Pure tests for the CSV serializer + slug helper.

import { describe, expect, it } from 'vitest';

import {
  serializeCsv,
  slugifyForFilename,
  type CsvColumn,
} from '../src/utils/csv';

interface SimpleRow {
  readonly name: string;
  readonly count: number | null;
  readonly note: string | null;
  readonly active?: boolean;
}

const cols: CsvColumn<SimpleRow>[] = [
  { header: 'name', value: (r) => r.name },
  { header: 'count', value: (r) => r.count },
  { header: 'note', value: (r) => r.note },
  { header: 'active', value: (r) => r.active },
];

describe('serializeCsv', () => {
  it('emits a header row even when there are no data rows', () => {
    const out = serializeCsv<SimpleRow>([], cols, { withBom: false });
    expect(out).toBe('name,count,note,active\r\n');
  });

  it('uses CRLF line endings', () => {
    const out = serializeCsv(
      [{ name: 'a', count: 1, note: null }],
      cols,
      { withBom: false },
    );
    expect(out.split('\r\n')).toEqual(['name,count,note,active', 'a,1,,', '']);
  });

  it('emits UTF-8 BOM by default', () => {
    const out = serializeCsv([], cols);
    expect(out.charCodeAt(0)).toBe(0xfeff);
  });

  it('omits BOM when withBom: false', () => {
    const out = serializeCsv([], cols, { withBom: false });
    expect(out.charCodeAt(0)).not.toBe(0xfeff);
  });

  it('escapes commas and quotes per RFC 4180', () => {
    const out = serializeCsv(
      [
        { name: 'Charizard, Holo', count: 1, note: 'He said "hi"' },
      ],
      cols,
      { withBom: false },
    );
    expect(out).toContain('"Charizard, Holo"');
    expect(out).toContain('"He said ""hi"""');
  });

  it('quotes fields with embedded newlines', () => {
    const out = serializeCsv(
      [{ name: 'multi\nline', count: 1, note: null }],
      cols,
      { withBom: false },
    );
    expect(out).toContain('"multi\nline"');
  });

  it('renders booleans as lowercase', () => {
    const out = serializeCsv(
      [
        { name: 'a', count: 1, note: null, active: true },
        { name: 'b', count: 1, note: null, active: false },
      ],
      cols,
      { withBom: false },
    );
    expect(out).toMatch(/a,1,,true/);
    expect(out).toMatch(/b,1,,false/);
  });

  it('renders null and undefined as empty', () => {
    const out = serializeCsv<SimpleRow>(
      [{ name: 'c', count: null, note: null }],
      cols,
      { withBom: false },
    );
    const row = out.split('\r\n')[1] ?? '';
    // name=c, count=, note=, active=
    expect(row).toBe('c,,,');
  });

  it('throws when columns is empty', () => {
    expect(() =>
      serializeCsv([], [] as readonly CsvColumn<SimpleRow>[], {
        withBom: false,
      }),
    ).toThrow();
  });

  it('renders non-finite numbers as empty', () => {
    const out = serializeCsv<SimpleRow>(
      [{ name: 'd', count: NaN, note: null }],
      cols,
      { withBom: false },
    );
    const row = out.split('\r\n')[1] ?? '';
    expect(row).toBe('d,,,');
  });
});

describe('slugifyForFilename', () => {
  it('lowercases and replaces non-alnum with hyphens', () => {
    expect(slugifyForFilename('S&V 151 (master)')).toBe('s-v-151-master');
  });

  it('collapses runs of hyphens', () => {
    expect(slugifyForFilename('a---b__c')).toBe('a-b-c');
  });

  it('trims leading and trailing hyphens', () => {
    expect(slugifyForFilename('---wow---')).toBe('wow');
  });

  it('uses fallback when result is empty', () => {
    expect(slugifyForFilename('!!!', 'fallback')).toBe('fallback');
    expect(slugifyForFilename('   ')).toBe('binder');
  });

  it('handles diacritics by stripping them via NFKD', () => {
    expect(slugifyForFilename('Pokémon')).toBe('pokemon');
  });
});
