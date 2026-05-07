// MVP-acceptance CSV exports. Closes the
// `MVP_ACCEPTANCE.md` requirement that the app exports collection,
// wishlist, duplicates, and missing-cards as CSV. Reuses the generic
// writer in `utils/csv.ts` (PR 8b) so format rules — UTF-8 BOM, CRLF
// line endings, RFC 4180 escaping, ISO 8601 dates, ISO currency
// columns alongside money columns — stay consistent with the binder
// and lot exports.
//
// Audit semantics mirror PR 8b/9: `build*()` is read-only and returns
// `{ filename, content, rowCount }`; the view hands the content to
// `downloadTextFile`, then `recordCsvExported()` writes a single
// audit row in a narrow rw-transaction over `auditLog` only. Audit
// means "content was generated and a download was started", not
// "the user saved the file" — browsers can't reliably observe disk
// writes.

import { appendAudit } from '../db/audit';
import type { PokemonTrackerDB } from '../db/database';
import { calculateBinderCompletion } from '../domain/binder-completion';
import { isReverseHoloTemplateSlot } from '../domain/card-variants';
import { formatTags } from '../domain/tags';
import type {
  BinderRecord,
  BinderSlotRecord,
  CardRecord,
  HoldingRecord,
  SetRecord,
  WishlistRecord,
} from '../domain/types';
import type { BindersRepo } from '../repositories/binders-repo';
import type { BinderSlotsRepo } from '../repositories/binder-slots-repo';
import type { CardsRepo } from '../repositories/cards-repo';
import type { HoldingsRepo } from '../repositories/holdings-repo';
import type { SetsRepo } from '../repositories/sets-repo';
import type { WishlistRepo } from '../repositories/wishlist-repo';
import {
  serializeCsv,
  type CsvColumn,
} from '../utils/csv';

export type MvpCsvKind =
  | 'collection'
  | 'wishlist'
  | 'duplicates'
  | 'missing-cards';

export interface MvpCsvResult {
  readonly filename: string;
  readonly content: string;
  readonly rowCount: number;
  readonly kind: MvpCsvKind;
}

export interface MvpCsvExporter {
  buildCollection(): Promise<MvpCsvResult>;
  buildWishlist(): Promise<MvpCsvResult>;
  buildDuplicates(): Promise<MvpCsvResult>;
  buildMissingCards(): Promise<MvpCsvResult>;
  recordCsvExported(kind: MvpCsvKind, rowCount: number): Promise<void>;
}

export interface MvpCsvExporterDeps {
  readonly db: PokemonTrackerDB;
  readonly holdingsRepo: HoldingsRepo;
  readonly bindersRepo: BindersRepo;
  readonly binderSlotsRepo: BinderSlotsRepo;
  readonly cardsRepo: CardsRepo;
  readonly setsRepo: SetsRepo;
  readonly wishlistRepo: WishlistRepo;
}

export function createMvpCsvExporter(
  deps: MvpCsvExporterDeps,
): MvpCsvExporter {
  return {
    async buildCollection() {
      const liveHoldings = await deps.holdingsRepo.listLive();
      const cardsById = await loadCardIndex(deps.cardsRepo, liveHoldings);
      const setsById = await loadSetIndex(deps.setsRepo, cardsById);
      const sorted = [...liveHoldings].sort(byUpdatedAtDesc);
      const rows = sorted.map((holding) => ({
        holding,
        card: cardsById.get(holding.cardId) ?? null,
        set: holdingSet(holding, cardsById, setsById),
      }));

      const columns: CsvColumn<{
        holding: HoldingRecord;
        card: CardRecord | null;
        set: SetRecord | null;
      }>[] = [
        { header: 'card_id', value: (r) => r.holding.cardId },
        { header: 'card_name', value: (r) => r.card?.name ?? '' },
        { header: 'set_id', value: (r) => r.card?.setId ?? '' },
        { header: 'set_name', value: (r) => r.set?.name ?? '' },
        { header: 'set_number', value: (r) => r.card?.number ?? '' },
        { header: 'finish', value: (r) => r.holding.finish },
        { header: 'edition', value: (r) => r.holding.edition },
        { header: 'condition_type', value: (r) => r.holding.conditionType },
        { header: 'raw_condition', value: (r) => r.holding.rawCondition ?? '' },
        { header: 'grading_company', value: (r) => r.holding.gradingCompany ?? '' },
        { header: 'grade', value: (r) => r.holding.grade ?? '' },
        { header: 'cert_number', value: (r) => r.holding.certNumber ?? '' },
        { header: 'language', value: (r) => r.holding.language },
        { header: 'quantity', value: (r) => r.holding.quantity },
        { header: 'purchase_price', value: (r) => r.holding.purchasePrice ?? '' },
        { header: 'purchase_currency', value: (r) => r.holding.purchaseCurrency ?? '' },
        { header: 'estimated_value', value: (r) => r.holding.estimatedValue ?? '' },
        { header: 'value_currency', value: (r) => r.holding.valueCurrency ?? '' },
        { header: 'value_source', value: (r) => r.holding.valueSource },
        { header: 'value_updated_at', value: (r) => r.holding.valueUpdatedAt ?? '' },
        { header: 'source', value: (r) => r.holding.source },
        { header: 'lot_id', value: (r) => r.holding.lotId ?? '' },
        { header: 'status', value: (r) => r.holding.status },
        { header: 'tags', value: (r) => formatTags(r.holding.tags) },
        { header: 'note', value: (r) => r.holding.note ?? '' },
        { header: 'special_variant', value: (r) => r.holding.specialVariant },
        { header: 'created_at', value: (r) => r.holding.createdAt },
        { header: 'updated_at', value: (r) => r.holding.updatedAt },
      ];
      return {
        kind: 'collection',
        rowCount: rows.length,
        content: serializeCsv(rows, columns, { withBom: true }),
        filename: `collection-${todayStamp()}.csv`,
      };
    },

    async buildWishlist() {
      const liveWishlist = (await deps.wishlistRepo.list()).filter(
        (w) => w.deletedAt === null,
      );
      const cardsById = await loadCardIndexForWishlist(
        deps.cardsRepo,
        liveWishlist,
      );
      const setsById = await loadSetIndex(deps.setsRepo, cardsById);
      const rows = [...liveWishlist].sort(byUpdatedAtDesc).map((entry) => ({
        entry,
        card: cardsById.get(entry.cardId) ?? null,
        set: wishlistSet(entry, cardsById, setsById),
      }));
      const columns: CsvColumn<{
        entry: WishlistRecord;
        card: CardRecord | null;
        set: SetRecord | null;
      }>[] = [
        { header: 'card_id', value: (r) => r.entry.cardId },
        { header: 'card_name', value: (r) => r.card?.name ?? '' },
        { header: 'set_id', value: (r) => r.card?.setId ?? '' },
        { header: 'set_name', value: (r) => r.set?.name ?? '' },
        { header: 'set_number', value: (r) => r.card?.number ?? '' },
        { header: 'finish', value: (r) => r.entry.finish },
        { header: 'priority', value: (r) => r.entry.priority },
        { header: 'target_condition', value: (r) => r.entry.targetCondition ?? '' },
        { header: 'target_price', value: (r) => r.entry.targetPrice ?? '' },
        { header: 'target_currency', value: (r) => r.entry.targetCurrency ?? '' },
        { header: 'status', value: (r) => r.entry.status },
        { header: 'note', value: (r) => r.entry.note ?? '' },
        { header: 'created_at', value: (r) => r.entry.createdAt },
        { header: 'updated_at', value: (r) => r.entry.updatedAt },
      ];
      return {
        kind: 'wishlist',
        rowCount: rows.length,
        content: serializeCsv(rows, columns, { withBom: true }),
        filename: `wishlist-${todayStamp()}.csv`,
      };
    },

    async buildDuplicates() {
      // "Duplicates" per BACKUP_FORMAT §8 = aggregated by
      // cardId + condition_key + (binder slot when assigned). We
      // surface holdings with `status='duplicate'` PLUS holdings whose
      // (cardId, conditionKey) appears more than once across the live
      // collection. Each row is one canonical group.
      const liveHoldings = await deps.holdingsRepo.listLive();
      const cardsById = await loadCardIndex(deps.cardsRepo, liveHoldings);
      const setsById = await loadSetIndex(deps.setsRepo, cardsById);

      const groups = new Map<string, HoldingRecord[]>();
      for (const h of liveHoldings) {
        const key = duplicateKey(h);
        let list = groups.get(key);
        if (list === undefined) {
          list = [];
          groups.set(key, list);
        }
        list.push(h);
      }

      const rows: Array<{
        readonly cardId: string;
        readonly cardName: string;
        readonly setName: string;
        readonly setNumber: string;
        readonly finish: string;
        readonly edition: string;
        readonly conditionLabel: string;
        readonly count: number;
        readonly totalQuantity: number;
        readonly statuses: string;
        readonly markedDuplicate: number;
        readonly markedUpgradeNeeded: number;
      }> = [];
      for (const [, holdings] of groups) {
        const markedDuplicate = holdings.filter(
          (h) => h.status === 'duplicate',
        ).length;
        // Group is reportable when there are 2+ holdings sharing the
        // canonical key, OR when at least one is explicitly marked
        // duplicate.
        if (holdings.length < 2 && markedDuplicate === 0) continue;
        const head = holdings[0];
        if (head === undefined) continue;
        const card = cardsById.get(head.cardId) ?? null;
        const set = card !== null ? (setsById.get(card.setId) ?? null) : null;
        const totalQuantity = holdings.reduce(
          (acc, h) => acc + h.quantity,
          0,
        );
        const statuses = Array.from(
          new Set(holdings.map((h) => h.status)),
        ).join(' | ');
        rows.push({
          cardId: head.cardId,
          cardName: card?.name ?? '',
          setName: set?.name ?? '',
          setNumber: card?.number ?? '',
          finish: head.finish,
          edition: head.edition,
          conditionLabel: describeCondition(head),
          count: holdings.length,
          totalQuantity,
          statuses,
          markedDuplicate,
          markedUpgradeNeeded: holdings.filter(
            (h) => h.status === 'upgrade_needed',
          ).length,
        });
      }
      rows.sort((a, b) =>
        b.count !== a.count
          ? b.count - a.count
          : a.cardId.localeCompare(b.cardId),
      );

      const columns: CsvColumn<(typeof rows)[number]>[] = [
        { header: 'card_id', value: (r) => r.cardId },
        { header: 'card_name', value: (r) => r.cardName },
        { header: 'set_name', value: (r) => r.setName },
        { header: 'set_number', value: (r) => r.setNumber },
        { header: 'finish', value: (r) => r.finish },
        { header: 'edition', value: (r) => r.edition },
        { header: 'condition', value: (r) => r.conditionLabel },
        { header: 'group_count', value: (r) => r.count },
        { header: 'total_quantity', value: (r) => r.totalQuantity },
        { header: 'statuses_observed', value: (r) => r.statuses },
        { header: 'marked_duplicate', value: (r) => r.markedDuplicate },
        { header: 'marked_upgrade_needed', value: (r) => r.markedUpgradeNeeded },
      ];

      return {
        kind: 'duplicates',
        rowCount: rows.length,
        content: serializeCsv(rows, columns, { withBom: true }),
        filename: `duplicates-${todayStamp()}.csv`,
      };
    },

    async buildMissingCards() {
      // Missing across all live binders: every live binder slot whose
      // target card is set AND that is NOT KRAVSPEC §6 complete.
      // This is the cross-binder shopping list.
      const liveBinders = await deps.bindersRepo.listLive();
      if (liveBinders.length === 0) {
        return emptyMissingResult();
      }
      const allSlots = await deps.binderSlotsRepo.list();
      const liveHoldings = await deps.holdingsRepo.listLive();
      const liveHoldingIds = new Set(liveHoldings.map((h) => h.id));
      const cardsById = await loadCardIndexForSlots(deps.cardsRepo, allSlots);
      const setsById = await loadSetIndex(deps.setsRepo, cardsById);

      const rows: Array<{
        readonly binder: BinderRecord;
        readonly slot: BinderSlotRecord;
        readonly card: CardRecord | null;
        readonly set: SetRecord | null;
      }> = [];
      for (const binder of liveBinders) {
        const liveSlots = allSlots.filter(
          (s) => s.binderId === binder.id && s.deletedAt === null,
        );
        // Use the same completion math as the binder views.
        const completion = calculateBinderCompletion(
          liveSlots,
          liveHoldingIds,
        );
        if (completion.missingSlots === 0) continue;
        const sortedSlots = [...liveSlots]
          .filter(
            (s) =>
              s.targetCardId !== null &&
              !(
                s.status === 'owned' &&
                s.holdingId !== null &&
                liveHoldingIds.has(s.holdingId)
              ),
          )
          .sort((a, b) =>
            a.pageNumber !== b.pageNumber
              ? a.pageNumber - b.pageNumber
              : a.slotNumber - b.slotNumber,
          );
        for (const slot of sortedSlots) {
          rows.push({
            binder,
            slot,
            card:
              slot.targetCardId !== null
                ? (cardsById.get(slot.targetCardId) ?? null)
                : null,
            set: slotSet(slot, cardsById, setsById),
          });
        }
      }

      const columns: CsvColumn<(typeof rows)[number]>[] = [
        { header: 'binder_id', value: (r) => r.binder.id },
        { header: 'binder_name', value: (r) => r.binder.name },
        { header: 'page', value: (r) => r.slot.pageNumber },
        { header: 'slot', value: (r) => r.slot.slotNumber },
        { header: 'card_id', value: (r) => r.slot.targetCardId ?? '' },
        { header: 'card_name', value: (r) => r.card?.name ?? '' },
        { header: 'set_id', value: (r) => r.card?.setId ?? '' },
        { header: 'set_name', value: (r) => r.set?.name ?? '' },
        { header: 'set_number', value: (r) => r.card?.number ?? '' },
        {
          header: 'finish_hint',
          value: (r) =>
            isReverseHoloTemplateSlot(r.slot.note) ? 'reverse_holo' : '',
        },
        { header: 'status', value: (r) => r.slot.status },
        { header: 'updated_at', value: (r) => r.slot.updatedAt },
      ];

      return {
        kind: 'missing-cards',
        rowCount: rows.length,
        content: serializeCsv(rows, columns, { withBom: true }),
        filename: `missing-cards-${todayStamp()}.csv`,
      };
    },

    async recordCsvExported(kind, rowCount) {
      await deps.db.transaction('rw', deps.db.auditLog, async () => {
        await appendAudit(deps.db, {
          action: `${kind.replaceAll('-', '_')}_csv_exported`,
          entityType: 'system',
          entityId: null,
          message: `exported ${kind} CSV (${rowCount} rows)`,
        });
      });
    },
  };
}

// ---------------------------------------------------------------------
// Helpers

function emptyMissingResult(): MvpCsvResult {
  // Always produce a valid CSV — even with zero rows, the header still
  // lands so a power user knows the export ran.
  const columns: CsvColumn<unknown>[] = [
    { header: 'binder_id', value: () => '' },
    { header: 'binder_name', value: () => '' },
    { header: 'page', value: () => '' },
    { header: 'slot', value: () => '' },
    { header: 'card_id', value: () => '' },
    { header: 'card_name', value: () => '' },
    { header: 'set_id', value: () => '' },
    { header: 'set_name', value: () => '' },
    { header: 'set_number', value: () => '' },
    { header: 'finish_hint', value: () => '' },
    { header: 'status', value: () => '' },
    { header: 'updated_at', value: () => '' },
  ];
  return {
    kind: 'missing-cards',
    rowCount: 0,
    content: serializeCsv([], columns, { withBom: true }),
    filename: `missing-cards-${todayStamp()}.csv`,
  };
}

async function loadCardIndex(
  cardsRepo: CardsRepo,
  holdings: readonly HoldingRecord[],
): Promise<Map<string, CardRecord>> {
  if (holdings.length === 0) return new Map();
  const all = await cardsRepo.list();
  const ids = new Set(holdings.map((h) => h.cardId));
  const out = new Map<string, CardRecord>();
  for (const card of all) {
    if (ids.has(card.id)) out.set(card.id, card);
  }
  return out;
}

async function loadCardIndexForWishlist(
  cardsRepo: CardsRepo,
  wishlist: readonly WishlistRecord[],
): Promise<Map<string, CardRecord>> {
  if (wishlist.length === 0) return new Map();
  const all = await cardsRepo.list();
  const ids = new Set(wishlist.map((w) => w.cardId));
  const out = new Map<string, CardRecord>();
  for (const card of all) {
    if (ids.has(card.id)) out.set(card.id, card);
  }
  return out;
}

async function loadCardIndexForSlots(
  cardsRepo: CardsRepo,
  slots: readonly BinderSlotRecord[],
): Promise<Map<string, CardRecord>> {
  const ids = new Set<string>();
  for (const slot of slots) {
    if (slot.targetCardId !== null) ids.add(slot.targetCardId);
  }
  if (ids.size === 0) return new Map();
  const all = await cardsRepo.list();
  const out = new Map<string, CardRecord>();
  for (const card of all) {
    if (ids.has(card.id)) out.set(card.id, card);
  }
  return out;
}

async function loadSetIndex(
  setsRepo: SetsRepo,
  cardsById: ReadonlyMap<string, CardRecord>,
): Promise<Map<string, SetRecord>> {
  if (cardsById.size === 0) return new Map();
  const setIds = new Set<string>();
  for (const card of cardsById.values()) setIds.add(card.setId);
  const all = await setsRepo.list();
  const out = new Map<string, SetRecord>();
  for (const set of all) {
    if (setIds.has(set.id)) out.set(set.id, set);
  }
  return out;
}

function holdingSet(
  holding: HoldingRecord,
  cardsById: ReadonlyMap<string, CardRecord>,
  setsById: ReadonlyMap<string, SetRecord>,
): SetRecord | null {
  const card = cardsById.get(holding.cardId);
  if (card === undefined) return null;
  return setsById.get(card.setId) ?? null;
}

function wishlistSet(
  entry: WishlistRecord,
  cardsById: ReadonlyMap<string, CardRecord>,
  setsById: ReadonlyMap<string, SetRecord>,
): SetRecord | null {
  const card = cardsById.get(entry.cardId);
  if (card === undefined) return null;
  return setsById.get(card.setId) ?? null;
}

function slotSet(
  slot: BinderSlotRecord,
  cardsById: ReadonlyMap<string, CardRecord>,
  setsById: ReadonlyMap<string, SetRecord>,
): SetRecord | null {
  if (slot.targetCardId === null) return null;
  const card = cardsById.get(slot.targetCardId);
  if (card === undefined) return null;
  return setsById.get(card.setId) ?? null;
}

function describeCondition(holding: HoldingRecord): string {
  if (holding.conditionType === 'graded') {
    const company = holding.gradingCompany ?? '?';
    const grade = holding.grade !== null ? holding.grade.toFixed(1) : '?';
    return `${company} ${grade}`;
  }
  return holding.rawCondition ?? '';
}

function duplicateKey(holding: HoldingRecord): string {
  const cond =
    holding.conditionType === 'graded'
      ? `graded:${holding.gradingCompany ?? '?'}:${
          holding.grade !== null ? holding.grade.toFixed(1) : '?'
        }`
      : `raw:${holding.rawCondition ?? '?'}`;
  return [
    holding.cardId,
    holding.finish,
    holding.edition,
    holding.language,
    cond,
  ].join('|');
}

function byUpdatedAtDesc<T extends { updatedAt: string }>(a: T, b: T): number {
  return a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0;
}

function todayStamp(): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear().toString().padStart(4, '0');
  const mm = (now.getUTCMonth() + 1).toString().padStart(2, '0');
  const dd = now.getUTCDate().toString().padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}
