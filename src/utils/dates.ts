// ISO 8601 timestamp helpers. The whole app stores timestamps as strings
// to keep IndexedDB and JSON backups portable; `Date` objects are created
// only at the edges (UI rendering, sorting comparators, etc.).

export type IsoTimestamp = string;

export function nowIso(): IsoTimestamp {
  return new Date().toISOString();
}

export function isIsoTimestamp(value: unknown): value is IsoTimestamp {
  if (typeof value !== 'string') {
    return false;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}
