// PR 34 — pure helpers + types + label maps lifted from
// `src/views/binder-detail.ts`.
//
// Everything in this module is stateless: predicates / formatters /
// type aliases / DOM construction utilities that take their inputs
// as arguments and produce output without touching any closure
// state. The orchestrator (`binder-detail.ts`) and the render +
// action helpers import from here.
//
// Lift contract (PR 34):
//   - no UI text changes (same Norwegian labels, same
//     `data-region` / class names)
//   - no behavioural changes (predicates return the same boolean
//     for the same input; resolvers return the same card)
//   - no public API changes (consumers still import
//     `mountBinderDetailView` from `./views/binder-detail`)

import { cardMatchesQuery, isEmptyQuery } from '../domain/card-search';
import { isReverseHoloTemplateSlot } from '../domain/card-variants';
import type { BinderDetail } from '../services/binder-slot-service';
import type {
  BinderSlotRecord,
  BinderSlotStatus,
  CardFinish,
  CardRecord,
  HoldingRecord,
} from '../domain/types';

// ---------------------------------------------------------------------
// Label maps (Norwegian UI strings — never change without an explicit
// UX review).

export const STATUS_LABELS: Record<BinderSlotStatus, string> = {
  empty: 'Tom',
  wanted: 'Ønsket',
  owned: 'Eid',
  missing: 'Mangler',
  ordered: 'Bestilt',
  duplicate: 'Duplikat',
  upgrade_needed: 'Oppgrader',
};

export const FINISH_LABELS: Record<CardFinish, string> = {
  normal: 'Normal',
  holo: 'Holo',
  reverse_holo: 'Reverse holo',
  non_holo: 'Non-holo',
  stamped: 'Stamped',
  unknown: 'Ukjent',
};

// ---------------------------------------------------------------------
// View-state types (orchestrator owns the mutable instance; render
// + action helpers read it).

export type ViewMode = 'pages' | 'checklist';

export type SlotFilter =
  | 'all'
  | 'missing'
  | 'ordered'
  | 'duplicate'
  | 'completed'
  | 'empty';

export const CHECKLIST_PAGE_SIZE = 50;

export const FILTER_LABELS: ReadonlyArray<{
  readonly value: SlotFilter;
  readonly label: string;
}> = [
  { value: 'all', label: 'Alle' },
  { value: 'missing', label: 'Mangler' },
  { value: 'completed', label: 'Eid' },
  { value: 'empty', label: 'Tomme' },
  { value: 'ordered', label: 'Bestilt' },
  { value: 'duplicate', label: 'Duplikater' },
];

// ---------------------------------------------------------------------
// Auto-assign / "Plasser" eligibility lookup.

export interface AssignableSlotInfo {
  /** Count of live unassigned holdings that match this slot. */
  readonly count: number;
  /** When `count === 1`, the single eligible holding id (used by "Plasser"). */
  readonly eligibleHoldingId: string | null;
}

/**
 * PR 24 — compute assignable-holding info for every slot in the binder
 * via O(1) lookups. Avoids the 1088-Dexie-query trap on a Vault X
 * 16-pocket binder. Mirrors `autoAssignBinder`'s rules so the badges
 * match exactly what the auto-assign action would do.
 */
export function computeAssignableInfo(
  detail: BinderDetail,
  liveHoldings: readonly HoldingRecord[],
): Map<string, AssignableSlotInfo> {
  const holdingsByCardId = new Map<string, HoldingRecord[]>();
  for (const h of liveHoldings) {
    const arr = holdingsByCardId.get(h.cardId);
    if (arr === undefined) holdingsByCardId.set(h.cardId, [h]);
    else arr.push(h);
  }
  const assignedHoldingIds = new Set<string>();
  for (const slot of detail.slots) {
    if (slot.deletedAt !== null) continue;
    if (slot.holdingId !== null) assignedHoldingIds.add(slot.holdingId);
  }
  const out = new Map<string, AssignableSlotInfo>();
  for (const slot of detail.slots) {
    if (slot.deletedAt !== null) continue;
    if (slot.holdingId !== null && slot.status === 'owned') continue;
    if (slot.targetCardId === null) continue;
    const candidates = (holdingsByCardId.get(slot.targetCardId) ?? []).filter(
      (h) => !assignedHoldingIds.has(h.id),
    );
    const eligible = isReverseHoloTemplateSlot(slot.note)
      ? candidates.filter((h) => h.finish === 'reverse_holo')
      : candidates;
    if (eligible.length === 0) continue;
    out.set(slot.id, {
      count: eligible.length,
      eligibleHoldingId: eligible.length === 1 ? (eligible[0]?.id ?? null) : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------
// Filter / search predicates.

export function isSlotComplete(
  slot: BinderSlotRecord,
  detail: BinderDetail,
): boolean {
  if (slot.targetCardId === null) return false;
  if (slot.status !== 'owned') return false;
  if (slot.holdingId === null) return false;
  return detail.holdingsById.has(slot.holdingId);
}

export function slotMatchesFilter(
  slot: BinderSlotRecord,
  filter: SlotFilter,
  detail: BinderDetail,
): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'completed':
      return isSlotComplete(slot, detail);
    case 'missing':
      // Missing = target slot that is NOT complete. Slots without a
      // target (blank manual slots) are not part of the completion
      // denominator, so they are not "missing" either.
      return slot.targetCardId !== null && !isSlotComplete(slot, detail);
    case 'empty':
      // PR 17 — fully blank slot: no target card AND no assigned
      // holding. Useful when assigning an unassigned holding to a
      // free pocket without filtering by status.
      return slot.targetCardId === null && slot.holdingId === null;
    case 'ordered':
      return slot.status === 'ordered';
    case 'duplicate':
      return slot.status === 'duplicate';
  }
}

export function slotMatchesSearch(
  slot: BinderSlotRecord,
  detail: BinderDetail,
  search: string,
): boolean {
  if (isEmptyQuery(search)) return true;
  const card = resolveCardForSlot(detail, slot);
  if (card === null) return false;
  // Set-name search inside a binder is intentionally omitted —
  // binders have at most one source set anyway, so name / id /
  // number / setid coverage is enough.
  return cardMatchesQuery(card, search);
}

// ---------------------------------------------------------------------
// Slot → card resolution.

export function resolveCardForSlot(
  detail: BinderDetail,
  slot: BinderSlotRecord,
): CardRecord | null {
  if (slot.holdingId !== null) {
    const holding = detail.holdingsById.get(slot.holdingId);
    if (holding !== undefined) {
      return resolveCardFromHolding(detail, holding);
    }
  }
  if (slot.targetCardId !== null) {
    return detail.cardsById.get(slot.targetCardId) ?? null;
  }
  return null;
}

export function resolveCardFromHolding(
  detail: BinderDetail,
  holding: HoldingRecord,
): CardRecord | null {
  return detail.cardsById.get(holding.cardId) ?? null;
}

// ---------------------------------------------------------------------
// Format helpers.

export function describeCondition(holding: HoldingRecord | null): string {
  if (holding === null) return '–';
  if (holding.conditionType === 'graded') {
    const company = holding.gradingCompany ?? '?';
    const grade = holding.grade !== null ? holding.grade.toFixed(1) : '?';
    return `${company} ${grade}`;
  }
  return holding.rawCondition ?? '–';
}

export function displaySlotNote(slot: BinderSlotRecord): string {
  // Hide the internal reverse-holo template marker from the note
  // column. User-authored notes pass through unchanged.
  if (isReverseHoloTemplateSlot(slot.note)) return '';
  return slot.note ?? '';
}

// ---------------------------------------------------------------------
// DOM utilities.

/**
 * Find a slot tile in the rendered DOM by `data-slot-id`, scroll it
 * into view (in jsdom: a no-op), and add a transient
 * `binder-slot--focused` class for ~3 s. PR 17 deep-link helper.
 */
export function focusSlotInDom(root: HTMLElement, slotId: string): void {
  const target = root.querySelector<HTMLElement>(
    `[data-slot-id="${cssEscape(slotId)}"]`,
  );
  if (target === null) return;
  // jsdom does not implement scrollIntoView; guard so tests still
  // pass while the production browser scrolls as expected.
  if (typeof target.scrollIntoView === 'function') {
    target.scrollIntoView({ block: 'center', behavior: 'auto' });
  }
  target.classList.add('binder-slot--focused');
  // Drop the highlight after a few seconds so a subsequent navigation
  // to the same binder without the slot suffix doesn't keep the
  // highlight forever.
  setTimeout(() => {
    target.classList.remove('binder-slot--focused');
  }, 3000);
}

export function cssEscape(value: string): string {
  // CSS.escape is not in jsdom; this minimal escape covers the
  // characters our slot ids contain (UUIDs only — no quotes or
  // backslashes — but be defensive in case of future changes).
  return value.replace(/(["\\])/g, '\\$1');
}

export function appendMessage(root: HTMLElement, text: string): void {
  const p = document.createElement('p');
  p.className = 'binder-detail-view__message';
  p.textContent = text;
  root.appendChild(p);
}

export function appendCell(tr: HTMLTableRowElement, value: string): void {
  const td = document.createElement('td');
  td.textContent = value;
  tr.appendChild(td);
}

export function appendStat(
  dl: HTMLDListElement,
  label: string,
  value: string,
): void {
  const dt = document.createElement('dt');
  dt.textContent = label;
  dl.appendChild(dt);
  const dd = document.createElement('dd');
  dd.textContent = value;
  dl.appendChild(dd);
}

export function makeToggleButton(
  mode: ViewMode,
  label: string,
  active: boolean,
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.dataset['mode'] = mode;
  btn.className = active
    ? 'binder-detail-view__toggle-btn binder-detail-view__toggle-btn--active'
    : 'binder-detail-view__toggle-btn';
  btn.setAttribute('role', 'tab');
  btn.setAttribute('aria-selected', active ? 'true' : 'false');
  btn.textContent = label;
  return btn;
}
