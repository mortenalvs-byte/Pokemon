// Bulk-add holdings: parse CSV/pasted lines into holding drafts, then
// upsert each via `holdingsRepo.upsertByVariant` so identical variants
// merge instead of duplicating.
//
// Direct-to-collection path. Unlike the lot bulk-import (which creates
// LotItem rows that have to be materialised later), this service writes
// holdings straight into `db.holdings` — the natural fit when the user
// has a stack of cards and just wants them in the collection.
//
// Accepted line formats:
//   cardId
//   cardId,quantity
//   cardId,quantity,finish
//   cardId,quantity,finish,edition
//   cardId,quantity,finish,edition,condition
//
// Blank lines and lines starting with '#' are ignored. Defaults:
//   quantity   = 1
//   finish     = 'normal'
//   edition    = 'unlimited'
//   condition  = 'NM' (rawCondition; conditionType always 'raw' here)
//
// Graded imports go through the per-card form. Power-collectors with
// hundreds of raw cards from sealed-product opening use this path.

import { appendAudit } from '../db/audit';
import type { PokemonTrackerDB } from '../db/database';
import { createCardsRepo, type CardsRepo } from '../repositories/cards-repo';
import { createHoldingsRepo, type HoldingsRepo } from '../repositories/holdings-repo';
import type {
  CardFinish,
  Edition,
  HoldingRecord,
  RawCondition,
} from '../domain/types';
import type { HoldingInput } from '../domain/validators';

export interface ParsedHoldingLine {
  readonly line: number;
  readonly raw: string;
  readonly input: HoldingInput;
}

export interface ParseHoldingError {
  readonly line: number;
  readonly raw: string;
  readonly reason: string;
}

export interface BulkAddHoldingsParseSummary {
  readonly resolved: readonly ParsedHoldingLine[];
  readonly errors: readonly ParseHoldingError[];
  readonly skippedBlank: number;
  readonly skippedComment: number;
}

export interface BulkAddHoldingsApplyResult {
  readonly created: readonly HoldingRecord[];
  readonly merged: readonly HoldingRecord[];
  readonly failed: readonly { readonly line: number; readonly cardId: string; readonly error: string }[];
}

const ALLOWED_FINISHES: ReadonlySet<CardFinish> = new Set<CardFinish>([
  'normal',
  'holo',
  'reverse_holo',
  'non_holo',
  'stamped',
  'unknown',
]);

const ALLOWED_EDITIONS: ReadonlySet<Edition> = new Set<Edition>([
  'unlimited',
  'first_edition',
  'shadowless',
  'unknown',
]);

const ALLOWED_RAW_CONDITIONS: ReadonlySet<RawCondition> = new Set<RawCondition>([
  'NM',
  'LP',
  'MP',
  'HP',
  'DMG',
  'UNKNOWN',
]);

/**
 * Parse and resolve text → holding drafts. Pure aside from cardId
 * lookups; results preserve input order. Unknown cardIds become errors
 * (not silently skipped) so the user can see what the cache did not
 * recognise and either fix the line or run a sync.
 */
export async function parseBulkAddHoldings(
  text: string,
  cardsRepo: CardsRepo,
): Promise<BulkAddHoldingsParseSummary> {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let skippedBlank = 0;
  let skippedComment = 0;
  const resolved: ParsedHoldingLine[] = [];
  const errors: ParseHoldingError[] = [];

  // Cache so repeated cardIds (e.g. same card different conditions on
  // separate lines) cost one repo round-trip.
  const cardCache = new Map<string, boolean>();
  async function cardExists(cardId: string): Promise<boolean> {
    const cached = cardCache.get(cardId);
    if (cached !== undefined) return cached;
    const exists = (await cardsRepo.get(cardId)) !== undefined;
    cardCache.set(cardId, exists);
    return exists;
  }

  for (let i = 0; i < lines.length; i += 1) {
    const lineNo = i + 1;
    const raw = lines[i] ?? '';
    const trimmed = raw.trim();
    if (trimmed.length === 0) { skippedBlank += 1; continue; }
    if (trimmed.startsWith('#')) { skippedComment += 1; continue; }

    const parts = trimmed.split(',').map((p) => p.trim());
    // CodeRabbit feedback: reject 6+ fields explicitly so a malformed
    // line cannot silently import truncated/wrong data.
    if (parts.length > 5) {
      errors.push({
        line: lineNo, raw,
        reason: `for mange felter (${parts.length}); forventet maks 5 (cardId,quantity,finish,edition,condition)`,
      });
      continue;
    }
    const cardId = parts[0] ?? '';
    if (cardId.length === 0) {
      errors.push({ line: lineNo, raw, reason: 'tom cardId' });
      continue;
    }

    let quantity = 1;
    if (parts.length >= 2 && parts[1] !== undefined && parts[1].length > 0) {
      const qStr = parts[1];
      if (!/^[1-9][0-9]*$/.test(qStr)) {
        errors.push({
          line: lineNo, raw,
          reason: `ugyldig quantity "${qStr}" (må være positivt heltall)`,
        });
        continue;
      }
      quantity = Number.parseInt(qStr, 10);
    }

    let finish: CardFinish = 'normal';
    if (parts.length >= 3 && parts[2] !== undefined && parts[2].length > 0) {
      const candidate = parts[2] as CardFinish;
      if (!ALLOWED_FINISHES.has(candidate)) {
        errors.push({ line: lineNo, raw, reason: `ugyldig finish "${parts[2]}" (tillatte: ${Array.from(ALLOWED_FINISHES).join(', ')})` });
        continue;
      }
      finish = candidate;
    }

    let edition: Edition = 'unlimited';
    if (parts.length >= 4 && parts[3] !== undefined && parts[3].length > 0) {
      const candidate = parts[3] as Edition;
      if (!ALLOWED_EDITIONS.has(candidate)) {
        errors.push({ line: lineNo, raw, reason: `ugyldig edition "${parts[3]}" (tillatte: ${Array.from(ALLOWED_EDITIONS).join(', ')})` });
        continue;
      }
      edition = candidate;
    }

    let rawCondition: RawCondition = 'NM';
    if (parts.length >= 5 && parts[4] !== undefined && parts[4].length > 0) {
      const candidate = parts[4] as RawCondition;
      if (!ALLOWED_RAW_CONDITIONS.has(candidate)) {
        errors.push({ line: lineNo, raw, reason: `ugyldig condition "${parts[4]}" (tillatte: ${Array.from(ALLOWED_RAW_CONDITIONS).join(', ')})` });
        continue;
      }
      rawCondition = candidate;
    }

    if (!(await cardExists(cardId))) {
      errors.push({ line: lineNo, raw, reason: `ukjent cardId "${cardId}" (ikke i cache; har du synket?)` });
      continue;
    }

    const input: HoldingInput = {
      cardId,
      quantity,
      conditionType: 'raw',
      rawCondition,
      gradingCompany: null,
      grade: null,
      certNumber: null,
      certUrl: null,
      gradedDate: null,
      finish,
      edition,
      language: 'en',
      purchasePrice: null,
      purchaseCurrency: null,
      estimatedValue: null,
      valueCurrency: null,
      valueSource: 'unknown',
      valueNote: null,
      valueUpdatedAt: null,
      source: 'manual',
      note: null,
      specialVariant: false,
      tags: [],
      lotId: null,
      status: 'owned',
    };
    resolved.push({ line: lineNo, raw, input });
  }

  return { resolved, errors, skippedBlank, skippedComment };
}

export interface ApplyBulkAddOptions {
  readonly onProgress?: (event: { readonly index: number; readonly total: number; readonly action: 'created' | 'merged' }) => void;
}

/**
 * Write the parsed holding drafts via `upsertByVariant`. Each call is
 * its own Dexie operation (the repo handles transactions); a single
 * failed line does NOT roll back the previous ones. One summary audit
 * row is appended at the end.
 */
export async function applyBulkAddHoldings(
  db: PokemonTrackerDB,
  summary: BulkAddHoldingsParseSummary,
  options: ApplyBulkAddOptions = {},
): Promise<BulkAddHoldingsApplyResult> {
  const holdingsRepo: HoldingsRepo = createHoldingsRepo(db);
  const created: HoldingRecord[] = [];
  const merged: HoldingRecord[] = [];
  const failed: Array<{ line: number; cardId: string; error: string }> = [];
  const total = summary.resolved.length;

  for (let i = 0; i < total; i += 1) {
    const item = summary.resolved[i];
    if (item === undefined) continue;
    try {
      const result = await holdingsRepo.upsertByVariant(item.input);
      if (result.action === 'merged') merged.push(result.holding);
      else created.push(result.holding);
      options.onProgress?.({ index: i + 1, total, action: result.action });
    } catch (caught) {
      failed.push({
        line: item.line,
        cardId: item.input.cardId,
        error: caught instanceof Error ? caught.message : String(caught),
      });
    }
  }

  // Single summary audit row instead of N rows — keeps audit log clean
  // when the user dumps a 500-line CSV.
  await appendAudit(db, {
    action: 'holdings_bulk_added',
    entityType: 'holding',
    entityId: null,
    message:
      `Bulk-add: ${created.length} opprettet, ${merged.length} merget, ` +
      `${failed.length} feilet (av ${total} parsede linjer; ` +
      `${summary.errors.length} parse-feil + ${summary.skippedBlank + summary.skippedComment} hoppet over)`,
  });

  return { created, merged, failed };
}

// Re-export the cards-repo factory for the dialog's convenience.
export { createCardsRepo };
