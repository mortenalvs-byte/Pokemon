// PR 30 finding F-CSV-1 — formula-injection regression tests.
//
// Pre-fix: `escapeCell` only quoted commas, quotes, newlines and CRs.
// A holding note like `=HYPERLINK("https://evil.test","click")` would
// land verbatim in the CSV. Excel / Sheets / Numbers / Calc would
// then evaluate the cell as a live formula on file open.
//
// Post-fix: `guardFormulaInjection` prefixes a single apostrophe (`'`)
// when the cell's first character is `=`, `+`, `-`, `@`, tab, CR, or
// LF. RFC 4180 quoting still composes on top so cells that ALSO need
// quoting (commas, quotes, newlines) are wrapped after the prefix.
//
// These tests pin both the new guard AND the pre-existing RFC 4180
// behaviour so a future regression of either one fails loud.

import { describe, expect, it } from 'vitest';

import { serializeCsv, type CsvColumn } from '../src/utils/csv';

interface CellRow {
  readonly note: string;
}

const cols: CsvColumn<CellRow>[] = [
  { header: 'note', value: (r) => r.note },
];

function bodyRows(out: string): string[] {
  // First line is the header. Trailing empty string is the trailing
  // CRLF. Body rows are everything between.
  const parts = out.split('\r\n');
  return parts.slice(1, -1);
}

describe('csv formula-injection guard (PR 30 — F-CSV-1)', () => {
  it('prefixes a leading `=` with apostrophe', () => {
    const out = serializeCsv(
      [{ note: '=HYPERLINK("https://evil.test","click")' }],
      cols,
      { withBom: false },
    );
    // The cell needs RFC 4180 quoting because of the embedded
    // commas, but the apostrophe goes inside the quotes so the
    // spreadsheet sees `'=HYPERLINK(…)`.
    expect(bodyRows(out)).toEqual([
      '"\'=HYPERLINK(""https://evil.test"",""click"")"',
    ]);
  });

  it('prefixes a leading `+` with apostrophe', () => {
    const out = serializeCsv(
      [{ note: "+cmd|' /C calc'!A0" }],
      cols,
      { withBom: false },
    );
    expect(bodyRows(out)).toEqual(["'+cmd|' /C calc'!A0"]);
  });

  it('prefixes a leading `-` with apostrophe', () => {
    const out = serializeCsv(
      [{ note: '-2+3+cmd' }],
      cols,
      { withBom: false },
    );
    expect(bodyRows(out)).toEqual(["'-2+3+cmd"]);
  });

  it('prefixes a leading `@` with apostrophe', () => {
    const out = serializeCsv(
      [{ note: '@SUM(1+1)*cmd|"" /C calc"!A0' }],
      cols,
      { withBom: false },
    );
    // Cell contains a quote so RFC 4180 wrapping kicks in too.
    expect(bodyRows(out)[0]).toContain("'@SUM");
    expect(bodyRows(out)[0]?.startsWith('"')).toBe(true);
  });

  it('prefixes a leading TAB (\\t)', () => {
    const out = serializeCsv(
      [{ note: '\t=cmd' }],
      cols,
      { withBom: false },
    );
    expect(bodyRows(out)).toEqual(["'\t=cmd"]);
  });

  it('prefixes a leading CR (\\r)', () => {
    const out = serializeCsv(
      [{ note: '\r=cmd' }],
      cols,
      { withBom: false },
    );
    // Embedded CR forces RFC 4180 quoting.
    expect(bodyRows(out)[0]).toBe('"\'\r=cmd"');
  });

  it('prefixes a leading LF (\\n)', () => {
    const out = serializeCsv(
      [{ note: '\nstart' }],
      cols,
      { withBom: false },
    );
    expect(bodyRows(out)[0]).toBe('"\'\nstart"');
  });

  it('does NOT prefix safe values (regression guard)', () => {
    const out = serializeCsv(
      [
        { note: 'normal text' },
        { note: 'Charizard #4' },
        { note: '123' },
        { note: 'price 5,00 USD' },
      ],
      cols,
      { withBom: false },
    );
    expect(bodyRows(out)).toEqual([
      'normal text',
      'Charizard #4',
      '123',
      '"price 5,00 USD"', // RFC 4180 quoting only, no apostrophe.
    ]);
  });

  it('preserves Norwegian characters (æøå) without prefix', () => {
    const out = serializeCsv(
      [{ note: 'gøy øvelse på æng' }],
      cols,
      { withBom: false },
    );
    expect(bodyRows(out)).toEqual(['gøy øvelse på æng']);
  });

  it('does NOT prefix when the dangerous character is mid-cell', () => {
    // Only the FIRST character matters; an `=` in the middle is fine.
    const out = serializeCsv(
      [{ note: 'price = 5' }],
      cols,
      { withBom: false },
    );
    expect(bodyRows(out)).toEqual(['price = 5']);
  });

  it('headers are NEVER prefixed even if they would collide with a guard char', () => {
    // No exporter ships a header starting with `=`/`+`/`-`/`@`, but
    // the guard explicitly skips headers because they are not user
    // data. This pins that contract.
    const out = serializeCsv<CellRow>(
      [],
      [{ header: '=meta', value: (r) => r.note }],
      { withBom: false },
    );
    expect(out).toBe('=meta\r\n');
  });

  it('preserves existing RFC 4180 path for commas + quotes (regression guard)', () => {
    const out = serializeCsv(
      [{ note: 'Charizard, Holo "Limited"' }],
      cols,
      { withBom: false },
    );
    expect(bodyRows(out)).toEqual(['"Charizard, Holo ""Limited"""']);
  });

  it('empty string passes through unchanged', () => {
    const out = serializeCsv([{ note: '' }], cols, { withBom: false });
    expect(bodyRows(out)).toEqual(['']);
  });

  it('combines guard + RFC quoting on a maximally-malicious cell', () => {
    // Real-world malicious holding note: leading =, embedded comma,
    // embedded quote, embedded newline.
    const out = serializeCsv(
      [{ note: '=HYPERLINK("evil.test","x"),"trick"\nfollow' }],
      cols,
      { withBom: false },
    );
    const row = bodyRows(out)[0] ?? '';
    // Must start with `"'=` — opening RFC quote, then guard
    // apostrophe, then the dangerous character.
    expect(row.startsWith('"\'=')).toBe(true);
    // Embedded quotes are doubled.
    expect(row).toContain('""evil.test""');
    // Trailing `"` closes the RFC wrap.
    expect(row.endsWith('"')).toBe(true);
  });
});
