// Safe extraction of price data from the `tcgplayer` and `cardmarket`
// fields of a CardRecord. Both fields are typed as `unknown` because
// they hold whatever the API returned — runtime narrowing is the only
// trustworthy way to read them.
//
// Each extractor returns a flat list of {label, price, currency} rows
// the Card Detail view can render with `textContent`. If the input
// shape is unfamiliar, the extractor returns an empty array and the
// view falls back to "Ingen prisdata".

export interface PriceRow {
  readonly label: string;
  readonly price: number;
  readonly currency: 'USD' | 'EUR';
}

export function extractTcgplayerPrices(raw: unknown): PriceRow[] {
  const prices = readObjectProperty(raw, 'prices');
  if (!isPlainObject(prices)) {
    return [];
  }
  const rows: PriceRow[] = [];
  for (const [variant, value] of Object.entries(prices)) {
    if (!isPlainObject(value)) continue;
    const market = readNumber(value['market']);
    const mid = readNumber(value['mid']);
    const low = readNumber(value['low']);
    // Prefer market; fall back to mid; fall back to low. Skip
    // entries with no usable number at all.
    const chosen = market ?? mid ?? low;
    if (chosen === null) continue;
    rows.push({
      label: humanizeVariant(variant),
      price: chosen,
      currency: 'USD',
    });
  }
  return rows;
}

export function extractCardmarketPrices(raw: unknown): PriceRow[] {
  const prices = readObjectProperty(raw, 'prices');
  if (!isPlainObject(prices)) {
    return [];
  }
  const rows: PriceRow[] = [];
  // Cardmarket exposes a flat `prices` object: averageSellPrice,
  // trendPrice, lowPrice, etc. Pick the most useful three if present.
  const trend = readNumber(prices['trendPrice']);
  const average = readNumber(prices['averageSellPrice']);
  const low = readNumber(prices['lowPrice']);
  if (trend !== null) rows.push({ label: 'Trend', price: trend, currency: 'EUR' });
  if (average !== null) rows.push({ label: 'Snitt', price: average, currency: 'EUR' });
  if (low !== null) rows.push({ label: 'Lav', price: low, currency: 'EUR' });
  return rows;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readObjectProperty(raw: unknown, key: string): unknown {
  if (!isPlainObject(raw)) return undefined;
  return raw[key];
}

function readNumber(value: unknown): number | null {
  if (typeof value !== 'number') return null;
  if (!Number.isFinite(value)) return null;
  if (value < 0) return null;
  return value;
}

function humanizeVariant(variant: string): string {
  // tcgplayer variants look like "normal", "holofoil", "reverseHolofoil",
  // "1stEditionHolofoil". Light touch, just enough to be readable.
  const spaced = variant.replace(/([a-z])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
