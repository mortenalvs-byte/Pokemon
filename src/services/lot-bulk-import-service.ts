// PR B1 — Lot bulk-import parser + resolver.
//
// Pure functions: parses pasted lines or CSV text into structured LotItem
// drafts, looks up cardIds via cardsRepo, returns the resolved items +
// per-line errors. The caller (lot-bulk-import-dialog.ts) writes the
// resolved items via the existing lot-items-repo so the audit + soft-delete
// + allocation paths from PR 22 / PR 18 / PR 33 stay intact.
//
// Accepted line formats (per operator requirement #7):
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
//   condition  = 'NM' (rawCondition; conditionType always 'raw' in B1)
//
// B1 imports raw lots only — graded materialization stays in the existing
// per-item form (lot-item-form.ts). Power-collectors typically buy a stack
// of raw cards in one lot; graded items are rare enough to use the slow
// form path.

import type { CardsRepo } from '../repositories/cards-repo';
import type {
  CardFinish,
  Edition,
  LotItemRecord,
  RawCondition,
  Uuid,
} from '../domain/types';

export type LotBulkImportInput = Omit<
  LotItemRecord,
  'id' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

export interface ParsedLine {
  readonly line: number;
  readonly raw: string;
  readonly input: LotBulkImportInput;
}

export interface ParseLineError {
  readonly line: number;
  readonly raw: string;
  readonly reason: string;
}

export interface ParseSummary {
  readonly resolved: readonly ParsedLine[];
  readonly errors: readonly ParseLineError[];
  readonly skippedBlank: number;
  readonly skippedComment: number;
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
 * Parse and resolve text input. Each input line is checked against the
 * cards table via cardsRepo. Resolution preserves order: line N in input
 * = item N in resolved (errors keep their own line numbers for the
 * summary UI).
 *
 * @param lotId — the lot to attach resolved items to
 * @param text — the pasted/CSV content (CR/LF normalised before parsing)
 * @param cardsRepo — used to verify cardId exists; unknown cards become errors
 */
export async function parseAndResolveBulkImport(
  lotId: Uuid,
  text: string,
  cardsRepo: CardsRepo,
): Promise<ParseSummary> {
  const normalised = text.replace(/\r\n/g, '\n');
  const lines = normalised.split('\n');

  let skippedBlank = 0;
  let skippedComment = 0;
  const resolved: ParsedLine[] = [];
  const errors: ParseLineError[] = [];

  // Cache card lookups so a repeated cardId in the input is only a single
  // repo round-trip — important when someone pastes "base1-4,4" three
  // times for separate finishes.
  const cardCache = new Map<string, boolean>();
  async function cardExists(cardId: string): Promise<boolean> {
    const cached = cardCache.get(cardId);
    if (cached !== undefined) return cached;
    const card = await cardsRepo.get(cardId);
    const exists = card !== undefined;
    cardCache.set(cardId, exists);
    return exists;
  }

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const raw = lines[i] ?? '';
    const trimmed = raw.trim();
    if (trimmed.length === 0) { skippedBlank++; continue; }
    if (trimmed.startsWith('#')) { skippedComment++; continue; }

    const parts = trimmed.split(',').map((p) => p.trim());
    const cardId = parts[0] ?? '';
    if (cardId.length === 0) {
      errors.push({ line: lineNo, raw, reason: 'tom cardId' });
      continue;
    }

    // quantity default 1. Strict base-10 positive integer only: rejects
    // decimals ("1.5"), trailing junk ("2x"), leading +/- signs, zero,
    // and anything Number.parseInt would lenient-parse. The blank/missing
    // case still gets the default of 1.
    let quantity = 1;
    if (parts.length >= 2 && parts[1] !== undefined && parts[1].length > 0) {
      const qStr = parts[1];
      if (!/^[1-9][0-9]*$/.test(qStr)) {
        errors.push({
          line: lineNo,
          raw,
          reason:
            `ugyldig quantity "${qStr}" (må være positivt heltall i base-10, ` +
            `f.eks. 1, 4, 25 — desimaler, tegn eller etterfølgende tekst er ikke tillatt)`,
        });
        continue;
      }
      quantity = Number.parseInt(qStr, 10);
    }

    // finish default 'normal'
    let finish: CardFinish = 'normal';
    if (parts.length >= 3 && parts[2] !== undefined && parts[2].length > 0) {
      const candidate = parts[2] as CardFinish;
      if (!ALLOWED_FINISHES.has(candidate)) {
        errors.push({ line: lineNo, raw, reason: `ugyldig finish "${parts[2]}" (tillatte: ${Array.from(ALLOWED_FINISHES).join(', ')})` });
        continue;
      }
      finish = candidate;
    }

    // edition default 'unlimited'
    let edition: Edition = 'unlimited';
    if (parts.length >= 4 && parts[3] !== undefined && parts[3].length > 0) {
      const candidate = parts[3] as Edition;
      if (!ALLOWED_EDITIONS.has(candidate)) {
        errors.push({ line: lineNo, raw, reason: `ugyldig edition "${parts[3]}" (tillatte: ${Array.from(ALLOWED_EDITIONS).join(', ')})` });
        continue;
      }
      edition = candidate;
    }

    // condition default 'NM'
    let rawCondition: RawCondition = 'NM';
    if (parts.length >= 5 && parts[4] !== undefined && parts[4].length > 0) {
      const candidate = parts[4] as RawCondition;
      if (!ALLOWED_RAW_CONDITIONS.has(candidate)) {
        errors.push({ line: lineNo, raw, reason: `ugyldig condition "${parts[4]}" (tillatte: ${Array.from(ALLOWED_RAW_CONDITIONS).join(', ')})` });
        continue;
      }
      rawCondition = candidate;
    }

    // Card existence check (the slowest step; cached above).
    if (!(await cardExists(cardId))) {
      errors.push({ line: lineNo, raw, reason: `cardId "${cardId}" finnes ikke i kort-databasen (kjør sync først hvis nylig sett)` });
      continue;
    }

    resolved.push({
      line: lineNo,
      raw,
      input: {
        lotId,
        cardId,
        finish,
        edition,
        conditionType: 'raw',
        rawCondition,
        gradingCompany: null,
        grade: null,
        quantity,
        manualPriceOverride: null,
        marketEstimate: null,
        allocatedCost: null,
        holdingId: null,
        note: null,
      },
    });
  }

  return { resolved, errors, skippedBlank, skippedComment };
}
