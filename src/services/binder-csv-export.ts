// Binder checklist CSV export.
//
// PR 29 review patch — operator-approved column set (2026-05-09). The
// CSV must be usable as a real-world physical-binder checklist:
//
//   binderName, pageNumber, slotNumber, physicalPosition, slotStatus,
//   targetCardId, targetCardName, setId, setName, cardNumber, rarity,
//   requiredFinish, holdingId, holdingCardName, holdingFinish,
//   holdingCondition, holdingStatus, language, note, issue
//
// `requiredFinish` is derived from `availableVariants(card)` plus the
// reverse-holo template marker. `holdingCondition` is one human-readable
// string ("NM" for raw, "PSA 10" for graded). `issue` is a contextual
// reason — "Mangler", "Feil holding", "Feil variant", "" for complete —
// so the printed checklist tells the user what to do per row.
//
// `recordBinderCsvExported` is a separate small write — the view calls
// it AFTER the CSV has been generated and handed to the download helper,
// so the audit row reflects "content was generated and a download was
// started", not "the user definitely saved the file" (browsers can't
// reliably observe the latter). Keeping the audit write in its own
// narrow rw-transaction over `auditLog` only means a failed download
// attempt does not corrupt the audit log either way.
//
// The exporter never mutates user-owned stores. Even reading slots /
// holdings / cards is read-only.

import { appendAudit } from '../db/audit';
import type { PokemonTrackerDB } from '../db/database';
import {
  availableVariants,
  isReverseHoloTemplateSlot,
} from '../domain/card-variants';
import type {
  BinderRecord,
  BinderSlotRecord,
  CardFinish,
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
  readonly binder: BinderRecord;
  readonly slot: BinderSlotRecord;
  readonly targetCard: CardRecord | null;
  readonly targetSet: SetRecord | null;
  readonly holding: HoldingRecord | null;
  readonly holdingCard: CardRecord | null;
  readonly requiredFinish: string;
  readonly holdingFinish: string;
  readonly holdingCondition: string;
  readonly displaySlotNote: string;
  readonly issue: string;
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
        const requiredFinish = deriveRequiredFinish(slot, targetCard);
        const holdingFinish = holding?.finish ?? '';
        const holdingCondition = formatHoldingCondition(holding);
        // Hide the internal reverse-holo marker from the user-facing
        // slot_note column — it is template metadata, not an authored
        // note.
        const displaySlotNote = isReverseTemplate ? '' : (slot.note ?? '');
        const issue = deriveIssue({
          slot,
          targetCard,
          holding,
          requiredFinish,
        });
        return {
          binder,
          slot,
          targetCard,
          targetSet,
          holding,
          holdingCard,
          requiredFinish,
          holdingFinish,
          holdingCondition,
          displaySlotNote,
          issue,
        };
      });

      const columns: CsvColumn<ChecklistRow>[] = [
        { header: 'binderName', value: (r) => r.binder.name },
        { header: 'pageNumber', value: (r) => r.slot.pageNumber },
        { header: 'slotNumber', value: (r) => r.slot.slotNumber },
        {
          header: 'physicalPosition',
          value: (r) => `${r.slot.pageNumber}.${r.slot.slotNumber}`,
        },
        { header: 'slotStatus', value: (r) => r.slot.status },
        {
          header: 'targetCardId',
          value: (r) => r.targetCard?.id ?? r.slot.targetCardId ?? '',
        },
        { header: 'targetCardName', value: (r) => r.targetCard?.name ?? '' },
        {
          header: 'setId',
          value: (r) => r.targetSet?.id ?? r.targetCard?.setId ?? '',
        },
        { header: 'setName', value: (r) => r.targetSet?.name ?? '' },
        { header: 'cardNumber', value: (r) => r.targetCard?.number ?? '' },
        { header: 'rarity', value: (r) => r.targetCard?.rarity ?? '' },
        { header: 'requiredFinish', value: (r) => r.requiredFinish },
        { header: 'holdingId', value: (r) => r.holding?.id ?? '' },
        { header: 'holdingCardName', value: (r) => r.holdingCard?.name ?? '' },
        { header: 'holdingFinish', value: (r) => r.holdingFinish },
        { header: 'holdingCondition', value: (r) => r.holdingCondition },
        { header: 'holdingStatus', value: (r) => r.holding?.status ?? '' },
        { header: 'language', value: (r) => r.holding?.language ?? '' },
        { header: 'note', value: (r) => r.displaySlotNote },
        { header: 'issue', value: (r) => r.issue },
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

/**
 * PR 29 review patch — derive the required variant finish for a slot
 * the same way the master-set-gap classifier does. Reverse-holo
 * template slots always require `reverse_holo`; other target slots use
 * `availableVariants(card)` and prefer normal → holo → reverse_holo.
 * Returns '' when the slot is blank (no `targetCardId`) or the card
 * has no verified variant data.
 */
function deriveRequiredFinish(
  slot: BinderSlotRecord,
  card: CardRecord | null,
): string {
  if (slot.targetCardId === null) return '';
  if (isReverseHoloTemplateSlot(slot.note)) return 'reverse_holo';
  if (card === null) return '';
  const variants = availableVariants(card);
  if (!variants.verified) return '';
  if (variants.finishes.has('normal')) return 'normal';
  if (variants.finishes.has('holo')) return 'holo';
  if (variants.finishes.has('reverse_holo')) return 'reverse_holo';
  return '';
}

/**
 * PR 29 review patch — render a holding's condition as a single
 * human-readable string. Raw NM holdings render as `NM`; graded
 * holdings render as `PSA 10` (gradingCompany + grade). Empty when
 * there is no holding bound to the slot.
 */
function formatHoldingCondition(holding: HoldingRecord | null): string {
  if (holding === null) return '';
  if (holding.conditionType === 'graded') {
    const company = holding.gradingCompany ?? '';
    const grade = holding.grade !== null ? String(holding.grade) : '';
    return [company, grade].filter((p) => p.length > 0).join(' ');
  }
  return holding.rawCondition ?? '';
}

/**
 * PR 29 review patch — contextual issue/reason per row. Operator
 * approved 2026-05-09: the printed checklist must say what's blocking
 * each row at a glance.
 */
function deriveIssue(input: {
  readonly slot: BinderSlotRecord;
  readonly targetCard: CardRecord | null;
  readonly holding: HoldingRecord | null;
  readonly requiredFinish: string;
}): string {
  const { slot, holding, requiredFinish } = input;
  void input.targetCard;
  if (slot.targetCardId === null) return '';
  if (holding === null) {
    if (slot.status === 'owned') {
      // Slot says owned but holding link is broken — surface as critical.
      return 'Mangler holding (slot markert som owned)';
    }
    return `Mangler — trenger ${requiredFinish.length > 0 ? requiredFinish : 'ukjent variant'}`;
  }
  if (holding.cardId !== slot.targetCardId) {
    return `Feil holding — slot venter ${slot.targetCardId}, holding er ${holding.cardId}`;
  }
  if (
    requiredFinish.length > 0 &&
    (holding.finish as CardFinish) !== requiredFinish
  ) {
    return `Feil variant — krever ${requiredFinish}, holding er ${holding.finish}`;
  }
  return '';
}
