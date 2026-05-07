// Pure card-search predicate. Used by Browse / Collection / Wishlist /
// the lot-item card picker so all of them search the same way (PR 15A
// — fixes F-6).
//
// Match rules, all case-insensitive and tolerant of leading / trailing
// / repeated whitespace:
//   - empty / whitespace query → match everything
//   - substring of `card.name`
//   - substring of `card.id`
//   - exact match against `card.number` (the printed number can be
//     numeric ("4") or alphanumeric ("TG01", "SWSH050"))
//   - `"<n>/<total>"` form ("4/102") matches any card whose `number`
//     equals the part before the slash
//   - exact match against `card.setId`
//   - substring of `set.name` when a set lookup is provided
//   - compound `"<rest> <number>"` where the LAST whitespace-separated
//     token is a number / number-with-slash and the rest matches the
//     `name` substring, set id, or set name. Supports queries like
//     "Charizard 4", "base1 4", "Base Set 4".
//
// No regex matching. No fuzzy / Levenshtein. No accent-folding. The
// predicate is pure — no DOM, no IO. Tests live in
// `tests/card-search.test.ts`.

import type { CardRecord, SetRecord } from './types';

export interface CardSearchContext {
  /** Optional lookup so set-name / set-id queries work. */
  readonly setsById?: ReadonlyMap<string, SetRecord>;
}

export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** True when the query is effectively empty (no actual characters). */
export function isEmptyQuery(query: string): boolean {
  return normalizeQuery(query).length === 0;
}

/**
 * `true` when the card matches the query under the rules above. An
 * empty / whitespace-only query matches every card.
 */
export function cardMatchesQuery(
  card: CardRecord,
  query: string,
  ctx: CardSearchContext = {},
): boolean {
  const normalized = normalizeQuery(query);
  if (normalized.length === 0) return true;

  // Compound query: "<rest> <number>" — only applied when the LAST
  // token is a card number. We do this BEFORE the simple substring
  // checks because "Charizard 4" should not silently fall back to the
  // (admittedly true) substring match on names containing "4".
  if (matchesCompound(card, normalized, ctx)) return true;

  if (matchesSimple(card, normalized, ctx)) return true;

  return false;
}

function matchesSimple(
  card: CardRecord,
  normalized: string,
  ctx: CardSearchContext,
): boolean {
  if (card.name.toLowerCase().includes(normalized)) return true;
  if (card.id.toLowerCase().includes(normalized)) return true;
  if (card.number.toLowerCase() === normalized) return true;
  // "4/102" → match any card with number === "4". The trailing portion
  // (set total) is informational; we don't enforce it.
  const numberFromSlash = parseNumberSlashTotal(normalized);
  if (
    numberFromSlash !== null &&
    card.number.toLowerCase() === numberFromSlash
  ) {
    return true;
  }
  if (card.setId.toLowerCase() === normalized) return true;
  if (ctx.setsById !== undefined) {
    const set = ctx.setsById.get(card.setId);
    if (set !== undefined && set.name.toLowerCase().includes(normalized)) {
      return true;
    }
  }
  return false;
}

function matchesCompound(
  card: CardRecord,
  normalized: string,
  ctx: CardSearchContext,
): boolean {
  const tokens = normalized.split(' ');
  if (tokens.length < 2) return false;
  const last = tokens[tokens.length - 1];
  if (last === undefined) return false;
  if (!looksLikeCardNumber(last)) return false;
  const numberPart = parseNumberSlashTotal(last) ?? last;
  if (card.number.toLowerCase() !== numberPart) return false;
  // The remaining tokens together must match name / set id / set name.
  const rest = tokens.slice(0, -1).join(' ');
  if (rest.length === 0) return false;
  if (card.name.toLowerCase().includes(rest)) return true;
  if (card.setId.toLowerCase() === rest) return true;
  if (ctx.setsById !== undefined) {
    const set = ctx.setsById.get(card.setId);
    if (set !== undefined && set.name.toLowerCase().includes(rest)) {
      return true;
    }
  }
  return false;
}

function looksLikeCardNumber(token: string): boolean {
  // Numeric ("4"), numeric/total ("4/102"), or alphanumeric like
  // "tg01" / "swsh050". A bare alphabetic token like "ex" is
  // ambiguous — we reject those so "Mega ex" doesn't get hijacked.
  if (/^\d+(\/\d+)?$/.test(token)) return true;
  if (/^[a-z]+\d+$/.test(token)) return true;
  return false;
}

function parseNumberSlashTotal(token: string): string | null {
  const slashAt = token.indexOf('/');
  if (slashAt === -1) return null;
  const before = token.slice(0, slashAt);
  const after = token.slice(slashAt + 1);
  if (before.length === 0 || after.length === 0) return null;
  if (!/^\d+$/.test(before) || !/^\d+$/.test(after)) return null;
  return before;
}
