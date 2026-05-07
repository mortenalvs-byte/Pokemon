// Tiny CSV writer. Pure: takes columns + rows, returns a string. The
// shape matches BACKUP_FORMAT.md §8 exactly:
//
//   - Delimiter: comma
//   - Line ending: CRLF (`\r\n`) for Excel-on-Windows friendliness
//   - Encoding: UTF-8 with optional BOM (default ON for the binder
//     checklist export so Norwegian characters survive Excel's
//     auto-detection)
//   - Quoting: RFC 4180 — fields containing commas, quotes, or
//     newlines are wrapped in double quotes; embedded `"` becomes `""`
//   - Header row is always emitted (even when `rows.length === 0`)
//   - Empty / nullish field values become an empty string
//   - Booleans are written `true` / `false`
//   - Numbers are written with the JS default decimal point; callers
//     are responsible for any locale-specific rounding before passing
//     a value
//
// This file is reused by future CSV exports (collection, wishlist,
// duplicates) and intentionally knows nothing about binders.

const CRLF = '\r\n';
const UTF8_BOM = '﻿';

export type CsvCellValue = string | number | boolean | null | undefined;

export interface CsvColumn<TRow> {
  /** Stable header label written to row 0. */
  readonly header: string;
  /** Pure projection from row → cell value. */
  readonly value: (row: TRow) => CsvCellValue;
}

export interface SerializeCsvOptions {
  /** Whether to prepend a UTF-8 byte-order mark. Default: true. */
  readonly withBom?: boolean;
}

export function serializeCsv<TRow>(
  rows: readonly TRow[],
  columns: readonly CsvColumn<TRow>[],
  options: SerializeCsvOptions = {},
): string {
  if (columns.length === 0) {
    throw new Error('serializeCsv requires at least one column');
  }
  const withBom = options.withBom ?? true;

  const lines: string[] = [];
  lines.push(columns.map((c) => escapeCell(c.header)).join(','));
  for (const row of rows) {
    const cells = columns.map((c) => escapeCell(formatCell(c.value(row))));
    lines.push(cells.join(','));
  }

  return (withBom ? UTF8_BOM : '') + lines.join(CRLF) + CRLF;
}

/**
 * Slugify a free-text label into a filename-safe segment.
 *
 * Rules:
 *   - Trim, lowercase
 *   - Replace any run of non-alnum characters with a single `-`
 *   - Strip leading and trailing `-`
 *   - Fall back to the supplied `fallback` when the result is empty
 *
 * Used by the binder CSV exporter to turn a binder name like
 * `"S&V 151 (master)"` into `"s-v-151-master"`.
 */
export function slugifyForFilename(
  input: string,
  fallback: string = 'binder',
): string {
  const slug = input
    // NFKD decomposes accented characters into base + combining mark;
    // we then drop the combining marks so `é` collapses to `e`.
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : fallback;
}

// ---------------------------------------------------------------------
// Internals

function formatCell(value: CsvCellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    return String(value);
  }
  return value;
}

function escapeCell(value: string): string {
  if (
    value.includes(',') ||
    value.includes('"') ||
    value.includes('\n') ||
    value.includes('\r')
  ) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
