// Binder checklist CSV export. Joins binder + live slots + cards +
// sets + (live) holdings, runs them through the generic CSV writer in
// `src/utils/csv.ts`, and surfaces a `{ filename, content, rowCount }`
// triple the view can hand straight to `downloadTextFile()`.
//
// `recordBinderCsvExported` is a separate small write — the view calls
// it AFTER the CSV has been generated and handed to the download
// helper, so the audit row reflects "content was generated and a
// download was started", not "the user definitely saved the file"
// (browsers can't reliably observe the latter). Keeping the audit
// write in its own narrow rw-transaction over `auditLog` only means a
// failed download attempt does not corrupt the audit log either way.
//
// The exporter never mutates user-owned stores. Even reading slots /
// holdings / cards is read-only.

import { appendAudit } from '../db/audit';
import type { PokemonTrackerDB } from '../db/database';
import { isReverseHoloTemplateSlot } from '../domain/card-variants';
import type {
  BinderRecord,
  BinderSlotRecord,
  CardRecord,
  HoldingRecord,
  SetRecord,
} from '../domain/types';
import type { BindersRepo } from '../repositories/binders-repo';
import type { BinderSlotsRepo } from '../repositories/binder-slots-repo';
import type { CardsRepo } from '../repositories/cards-repo';
import type { HoldingsRepo } from '../repositories/holdings-repo';
import type { SetsRepo } from '../repositories/sets-repo';
import { serializeCsv, slugifyForFilename, type CsvColumn } from '../utils/csv';

export interface BinderCsvExportResult {
  readonly filename: string;
  readonly content: string;
  readonly rowCount: number;
}

interface ChecklistRow {
  readonly slot: BinderSlotRecord;
  readonly targetCard: CardRecord | null;
  readonly targetSet: SetRecord | null;
  readonly holding: HoldingRecord | null;
  readonly holdingCard: CardRecord | null;
  readonly displayFinish: string;
  readonly displaySlotNote: string;
}

export interface BinderCsvExporter {
  build(binderId: string): Promise<BinderCsvExportResult | null>;
  recordExport(binder: BinderRecord, rowCount: number): Promise<void>;
}

export function createBinderCsvExporter(
  db: PokemonTrackerDB,
  bindersRepo: BindersRepo,
  slotsRepo: BinderSlotsRepo,
  holdingsRepo: HoldingsRepo,
  cardsRepo: CardsRepo,
  setsRepo: SetsRepo,
): BinderCsvExporter {
  return {
    async build(binderId) {
      const binder = await bindersRepo.get(binderId);
      if (binder === undefined || binder.deletedAt !== null) return null;

      const slots = (await slotsRepo.listByBinderId(binderId))
        .filter((s) => s.deletedAt === null)
        .sort(compareSlotOrder);

      const liveHoldings = await holdingsRepo.listLive();
      const holdingsById = new Map<string, HoldingRecord>();
      for (const h of liveHoldings) holdingsById.set(h.id, h);

      const referencedCardIds = new Set<string>();
      for (const slot of slots) {
        if (slot.targetCardId !== null) referencedCardIds.add(slot.targetCardId);
        if (slot.holdingId !== null) {
          const h = holdingsById.get(slot.holdingId);
          if (h !== undefined) referencedCardIds.add(h.cardId);
        }
      }
      const allCards = await cardsRepo.list();
      const cardsById = new Map<string, CardRecord>();
      for (const card of allCards) {
        if (referencedCardIds.has(card.id)) cardsById.set(card.id, card);
      }
      const allSets = await setsRepo.list();
      const setsById = new Map<string, SetRecord>();
      for (const set of allSets) setsById.set(set.id, set);

      const rows: ChecklistRow[] = slots.map((slot) => {
        const targetCard =
          slot.targetCardId !== null
            ? (cardsById.get(slot.targetCardId) ?? null)
            : null;
        const targetSet =
          targetCard !== null ? (setsById.get(targetCard.setId) ?? null) : null;
        const holding =
          slot.holdingId !== null
            ? (holdingsById.get(slot.holdingId) ?? null)
            : null;
        const holdingCard =
          holding !== null ? (cardsById.get(holding.cardId) ?? null) : null;
        const isReverseTemplate = isReverseHoloTemplateSlot(slot.note);
        const displayFinish = isReverseTemplate
          ? 'reverse_holo'
          : (holding?.finish ?? '');
        // Hide the internal reverse-holo marker from the
        // user-facing slot_note column — it is template metadata,
        // not an authored note.
        const displaySlotNote = isReverseTemplate ? '' : (slot.note ?? '');
        return {
          slot,
          targetCard,
          targetSet,
          holding,
          holdingCard,
          displayFinish,
          displaySlotNote,
        };
      });

      const columns: CsvColumn<ChecklistRow>[] = [
        { header: 'page', value: (r) => r.slot.pageNumber },
        { header: 'slot', value: (r) => r.slot.slotNumber },
        { header: 'target_card_id', value: (r) => r.targetCard?.id ?? r.slot.targetCardId ?? '' },
        { header: 'target_card_name', value: (r) => r.targetCard?.name ?? '' },
        { header: 'set_id', value: (r) => r.targetSet?.id ?? r.targetCard?.setId ?? '' },
        { header: 'set_name', value: (r) => r.targetSet?.name ?? '' },
        { header: 'set_number', value: (r) => r.targetCard?.number ?? '' },
        { header: 'finish', value: (r) => r.displayFinish },
        { header: 'status', value: (r) => r.slot.status },
        { header: 'holding_card_id', value: (r) => r.holding?.cardId ?? '' },
        { header: 'holding_card_name', value: (r) => r.holdingCard?.name ?? '' },
        { header: 'condition_type', value: (r) => r.holding?.conditionType ?? '' },
        { header: 'raw_condition', value: (r) => r.holding?.rawCondition ?? '' },
        { header: 'grading_company', value: (r) => r.holding?.gradingCompany ?? '' },
        { header: 'grade', value: (r) => r.holding?.grade ?? '' },
        { header: 'holding_note', value: (r) => r.holding?.note ?? '' },
        { header: 'slot_note', value: (r) => r.displaySlotNote },
        { header: 'updated_at', value: (r) => r.slot.updatedAt },
      ];

      const content = serializeCsv(rows, columns, { withBom: true });
      const filename = `binder-checklist-${slugifyForFilename(binder.name)}-${todayStamp()}.csv`;
      return { filename, content, rowCount: rows.length };
    },

    async recordExport(binder, rowCount) {
      // Audit-only write. Narrow rw-transaction over auditLog keeps it
      // unambiguous: this never touches binders, slots, holdings,
      // cards, sets, or appMeta.
      await db.transaction('rw', db.auditLog, async () => {
        await appendAudit(db, {
          action: 'binder_csv_exported',
          entityType: 'binder',
          entityId: binder.id,
          message: `exported checklist for binder "${binder.name}" (${rowCount} rows)`,
        });
      });
    },
  };
}

function compareSlotOrder(a: BinderSlotRecord, b: BinderSlotRecord): number {
  if (a.pageNumber !== b.pageNumber) return a.pageNumber - b.pageNumber;
  return a.slotNumber - b.slotNumber;
}

function todayStamp(): string {
  // YYYYMMDD in UTC for deterministic test output and timezone-safe
  // sorting. The exporter is filename-only; the file's `exportedAt`-like
  // field would belong elsewhere if we wanted local time.
  const now = new Date();
  const yyyy = now.getUTCFullYear().toString().padStart(4, '0');
  const mm = (now.getUTCMonth() + 1).toString().padStart(2, '0');
  const dd = now.getUTCDate().toString().padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}
