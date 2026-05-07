// Lot CSV export. Same audit semantics as the binder CSV exporter
// (PR 8b): `build()` is read-only, the view hands the content to
// `downloadTextFile`, then `recordExport()` writes a single
// `lot_csv_exported` audit row in a narrow rw-transaction over
// `auditLog` only.
//
// Audit means "CSV content was generated and a download was started",
// not "user definitely saved the file" — the same caveat as the binder
// exporter. We never know whether the browser actually persisted the
// file, but writing the audit gives the user a sporable trail.

import { appendAudit } from '../db/audit';
import type { PokemonTrackerDB } from '../db/database';
import type {
  CardRecord,
  HoldingRecord,
  LotItemRecord,
  LotRecord,
} from '../domain/types';
import type { CardsRepo } from '../repositories/cards-repo';
import type { HoldingsRepo } from '../repositories/holdings-repo';
import type { LotItemsRepo } from '../repositories/lot-items-repo';
import type { LotsRepo } from '../repositories/lots-repo';
import {
  serializeCsv,
  slugifyForFilename,
  type CsvColumn,
} from '../utils/csv';

export interface LotCsvExportResult {
  readonly filename: string;
  readonly content: string;
  readonly rowCount: number;
}

interface LotItemRow {
  readonly item: LotItemRecord;
  readonly card: CardRecord | null;
  readonly holding: HoldingRecord | null;
}

export interface LotCsvExporter {
  build(lotId: string): Promise<LotCsvExportResult | null>;
  recordExport(lot: LotRecord, rowCount: number): Promise<void>;
}

export function createLotCsvExporter(
  db: PokemonTrackerDB,
  lotsRepo: LotsRepo,
  lotItemsRepo: LotItemsRepo,
  holdingsRepo: HoldingsRepo,
  cardsRepo: CardsRepo,
): LotCsvExporter {
  return {
    async build(lotId) {
      const lot = await lotsRepo.get(lotId);
      if (lot === undefined || lot.deletedAt !== null) return null;

      const items = (await lotItemsRepo.listByLotId(lotId))
        .filter((i) => i.deletedAt === null)
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));

      const cardIds = new Set<string>();
      const holdingIds = new Set<string>();
      for (const item of items) {
        cardIds.add(item.cardId);
        if (item.holdingId !== null) holdingIds.add(item.holdingId);
      }

      const cards = await cardsRepo.list();
      const cardsById = new Map<string, CardRecord>();
      for (const c of cards) {
        if (cardIds.has(c.id)) cardsById.set(c.id, c);
      }
      const allHoldings = await holdingsRepo.list();
      const holdingsById = new Map<string, HoldingRecord>();
      for (const h of allHoldings) {
        if (holdingIds.has(h.id)) holdingsById.set(h.id, h);
      }

      const rows: LotItemRow[] = items.map((item) => ({
        item,
        card: cardsById.get(item.cardId) ?? null,
        holding:
          item.holdingId !== null
            ? (holdingsById.get(item.holdingId) ?? null)
            : null,
      }));

      const columns: CsvColumn<LotItemRow>[] = [
        { header: 'lot_id', value: () => lot.id },
        { header: 'lot_name', value: () => lot.name },
        { header: 'lot_purchase_date', value: () => lot.purchaseDate },
        { header: 'lot_total_cost', value: () => lot.totalCost },
        { header: 'lot_currency', value: () => lot.currency },
        { header: 'lot_allocation_method', value: () => lot.allocationMethod },
        { header: 'item_id', value: (r) => r.item.id },
        { header: 'card_id', value: (r) => r.item.cardId },
        { header: 'card_name', value: (r) => r.card?.name ?? '' },
        { header: 'set_id', value: (r) => r.card?.setId ?? '' },
        { header: 'set_number', value: (r) => r.card?.number ?? '' },
        { header: 'finish', value: (r) => r.item.finish },
        { header: 'edition', value: (r) => r.item.edition },
        { header: 'condition_type', value: (r) => r.item.conditionType },
        { header: 'raw_condition', value: (r) => r.item.rawCondition ?? '' },
        { header: 'grading_company', value: (r) => r.item.gradingCompany ?? '' },
        { header: 'grade', value: (r) => r.item.grade ?? '' },
        { header: 'quantity', value: (r) => r.item.quantity },
        {
          header: 'manual_price_override',
          value: (r) => r.item.manualPriceOverride ?? '',
        },
        { header: 'market_estimate', value: (r) => r.item.marketEstimate ?? '' },
        { header: 'allocated_cost', value: (r) => r.item.allocatedCost ?? '' },
        { header: 'holding_id', value: (r) => r.item.holdingId ?? '' },
        { header: 'materialized', value: (r) => r.item.holdingId !== null },
        { header: 'note', value: (r) => r.item.note ?? '' },
        { header: 'updated_at', value: (r) => r.item.updatedAt },
      ];

      const content = serializeCsv(rows, columns, { withBom: true });
      const filename = `lot-${slugifyForFilename(lot.name, 'lot')}-${todayStamp()}.csv`;
      return { filename, content, rowCount: rows.length };
    },

    async recordExport(lot, rowCount) {
      await db.transaction('rw', db.auditLog, async () => {
        await appendAudit(db, {
          action: 'lot_csv_exported',
          entityType: 'lot',
          entityId: lot.id,
          message: `exported lot "${lot.name}" (${rowCount} rows)`,
        });
      });
    },
  };
}

function todayStamp(): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear().toString().padStart(4, '0');
  const mm = (now.getUTCMonth() + 1).toString().padStart(2, '0');
  const dd = now.getUTCDate().toString().padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}
