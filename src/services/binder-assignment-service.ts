// PR 24 — binder assignment service. Single home for the rules that
// decide which holdings can land in which slots, runs the assignment
// write through `binderSlotsRepo.update`, and powers the new
// auto-assign + direct-add flows in Binder Detail.
//
// Locked rules (PR 24 v1):
//   - `owned` only via real holding. The repo writes `holdingId` and
//     flips `status` to `owned`; clearing preserves `targetCardId` and
//     `note` (PR 8a). This service never invents ownership.
//   - One physical holding → one physical slot. Even when
//     `holding.quantity > 1`, the holding can only be auto-assigned to
//     a single slot. Splitting into per-unit placements is a future
//     PR; we do not silently let one quantity-10 holding fill 10 slots.
//   - Target slots filter to `holding.cardId === slot.targetCardId`.
//   - Reverse-holo template slots only accept `finish === 'reverse_holo'`.
//   - Blank slots (`targetCardId === null`) are NEVER auto-assigned.
//     The user picks via the existing assign modal.
//   - Already-owned slots are NEVER overwritten by auto-assign.
//   - Multiple eligible candidates → skipped as ambiguous. Best-copy
//     logic (NM > LP, ungraded vs graded, etc.) is a future PR.
//
// Writes:
//   - Slot updates go through `binderSlotsRepo.update` so the existing
//     audit (`binder_slot_assigned`) and validators run unchanged.
//   - Direct-add creates the holding via `holdingsRepo.create` first,
//     then assigns. If the assign step fails, we attempt to rollback
//     the holding via `softDelete` so we don't leak orphan inventory.
//   - This service NEVER dispatches `USER_DATA_CHANGED_EVENT`. The UI
//     fires it once after the call returns.

import {
  REVERSE_HOLO_TEMPLATE_MARKER,
  isReverseHoloTemplateSlot,
} from '../domain/card-variants';
import type {
  BinderSlotRecord,
  CardRecord,
  HoldingRecord,
  SlotsPerPage,
} from '../domain/types';
import type {
  HoldingInput,
} from '../domain/validators';
import type { BindersRepo } from '../repositories/binders-repo';
import type { BinderSlotsRepo } from '../repositories/binder-slots-repo';
import type { CardsRepo } from '../repositories/cards-repo';
import type { HoldingsRepo } from '../repositories/holdings-repo';

export interface AssignableHolding {
  readonly holding: HoldingRecord;
  readonly card: CardRecord | null;
  /** Higher = better candidate. Reserved for future best-copy logic; v1 always uses 0. */
  readonly score: number;
  readonly reason: string;
}

export interface AutoAssignResult {
  readonly assigned: ReadonlyArray<{
    readonly slotId: string;
    readonly holdingId: string;
    readonly cardId: string;
  }>;
  readonly skippedAlreadyOwned: number;
  readonly skippedNoTarget: number;
  readonly skippedNoHolding: number;
  readonly skippedAmbiguous: number;
  readonly skippedWrongVariant: number;
}

export interface BinderAssignmentDeps {
  readonly bindersRepo: BindersRepo;
  readonly binderSlotsRepo: BinderSlotsRepo;
  readonly holdingsRepo: HoldingsRepo;
  readonly cardsRepo: CardsRepo;
}

export class SlotAssignmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlotAssignmentError';
  }
}

// ---------------------------------------------------------------------
// Per-slot candidate lookup

/**
 * Returns live holdings that CAN be assigned to `slot` according to the
 * v1 rules:
 *   - holding is live (not soft-deleted)
 *   - cardId matches the slot's targetCardId
 *   - finish matches when the slot is a reverse-holo template
 *   - holding is NOT already assigned to a different live binder slot
 *     (one physical holding → one physical slot, PR 24 §10)
 *
 * Returns `[]` when:
 *   - the slot is already owned (no point reassigning silently)
 *   - the slot has no `targetCardId` (blank slot — pick via modal)
 *   - the slot is soft-deleted
 *   - no live unassigned holdings exist for the target cardId
 */
export async function findAssignableHoldingsForSlot(
  deps: BinderAssignmentDeps,
  slot: BinderSlotRecord,
): Promise<AssignableHolding[]> {
  if (slot.deletedAt !== null) return [];
  if (slot.holdingId !== null && slot.status === 'owned') return [];
  if (slot.targetCardId === null) return [];

  const holdings = await deps.holdingsRepo.listByCardId(slot.targetCardId);
  const card = (await deps.cardsRepo.get(slot.targetCardId)) ?? null;
  const reverseTemplate = isReverseHoloTemplateSlot(slot.note);
  const assignedHoldingIds = await getAssignedHoldingIds(deps, slot.id);

  const out: AssignableHolding[] = [];
  for (const holding of holdings) {
    if (holding.deletedAt !== null) continue;
    if (assignedHoldingIds.has(holding.id)) continue;
    if (reverseTemplate && holding.finish !== 'reverse_holo') continue;
    out.push({
      holding,
      card,
      score: 0,
      reason: reverseTemplate ? 'reverse holo template match' : 'cardId match',
    });
  }
  return out;
}

/**
 * PR 24 review patch — set of holding ids already assigned to a live
 * binder slot OTHER than the one we're checking. Used to enforce
 * "one physical holding → one physical slot" globally.
 *
 * Pass `excludeSlotId` so reassigning the same holding to its current
 * slot is allowed (no-op style update), but moving it to a different
 * slot while it's still bound elsewhere is rejected.
 */
async function getAssignedHoldingIds(
  deps: BinderAssignmentDeps,
  excludeSlotId: string | null,
): Promise<Set<string>> {
  const liveSlots = await deps.binderSlotsRepo.listLive();
  const out = new Set<string>();
  for (const s of liveSlots) {
    if (s.id === excludeSlotId) continue;
    if (s.holdingId !== null) out.add(s.holdingId);
  }
  return out;
}

// ---------------------------------------------------------------------
// Single-slot assignment write

/**
 * Assign a specific holding to a slot. Wraps `binderSlotsRepo.update`
 * with the v1 contract checks so the UI doesn't have to repeat them:
 *   - target slot rejects holdings for a different cardId
 *   - blank slot back-fills `targetCardId` from the holding
 *   - reverse-holo template rejects non-reverse_holo finishes
 *   - one physical holding → one physical slot (PR 24 §10): the same
 *     holding cannot be bound to two live slots at once. Reassigning
 *     to the same slot is a no-op-style update and is allowed.
 */
export async function assignHoldingToSlot(
  deps: BinderAssignmentDeps,
  slot: BinderSlotRecord,
  holding: HoldingRecord,
  slotsPerPage: SlotsPerPage,
): Promise<BinderSlotRecord> {
  if (holding.deletedAt !== null) {
    throw new SlotAssignmentError('Holdingen er slettet.');
  }
  if (
    slot.targetCardId !== null &&
    slot.targetCardId !== holding.cardId
  ) {
    throw new SlotAssignmentError(
      `Slot venter ${slot.targetCardId}, holdingen er ${holding.cardId}.`,
    );
  }
  if (
    isReverseHoloTemplateSlot(slot.note) &&
    holding.finish !== 'reverse_holo'
  ) {
    throw new SlotAssignmentError(
      `Reverse-holo template-slot tar bare reverse_holo-finish (holding er ${holding.finish}).`,
    );
  }
  // One-holding-one-slot enforcement. Pass `slot.id` as the exclude so
  // reassigning the same holding to its current slot stays a legal
  // no-op-style update (matches the existing assign-modal "Bytt
  // holding" UX).
  const otherAssignedHoldingIds = await getAssignedHoldingIds(deps, slot.id);
  if (otherAssignedHoldingIds.has(holding.id)) {
    throw new SlotAssignmentError(
      'Holdingen er allerede plassert i en annen slot.',
    );
  }
  return deps.binderSlotsRepo.update(
    slot.id,
    {
      holdingId: holding.id,
      // Backfill targetCardId for blank manual slots so the completion
      // denominator is well-defined. Same rule as the assign-holding
      // modal in PR 17.
      targetCardId: slot.targetCardId ?? holding.cardId,
      status: 'owned',
    },
    slotsPerPage,
  );
}

// ---------------------------------------------------------------------
// Auto-assign matching holdings across the whole binder

export interface AutoAssignOptions {
  readonly binderId: string;
}

/**
 * PR 29 review patch — single source of truth for "what would auto-place
 * do?". Both the binder-detail UI (auto-button label, gap-banner
 * `canPlaceDirectly` count, per-tile badges) AND the `autoAssignBinder`
 * service consume this plan. There is no second classifier; if a future
 * change drifts the two apart, `tests/binder-detail-action-audit.test.ts`
 * fails immediately.
 *
 * Buckets correspond to the `AutoAssignResult.skipped*` counters one-to-one,
 * so the post-click summary still reads clean.
 *
 * Cross-binder semantics (matches `master-set-gap-service`): a holding
 * already assigned to a live slot in ANY binder is excluded from
 * candidates here. The UI's auto-button label was previously off by 41
 * because it only checked this binder's assignments; the plan fixes that.
 */
export interface AutoPlacementPlanEntrySafe {
  readonly slot: BinderSlotRecord;
  readonly holding: HoldingRecord;
}
export interface AutoPlacementPlanEntryAmbiguous {
  readonly slot: BinderSlotRecord;
  readonly candidates: ReadonlyArray<HoldingRecord>;
}
export interface AutoPlacementPlanEntryBlocked {
  readonly slot: BinderSlotRecord;
  /** Candidates that exist but failed a rule (finish, etc.). May be empty. */
  readonly candidates: ReadonlyArray<HoldingRecord>;
}
export interface AutoPlacementPlan {
  readonly binderId: string;
  /** Slot has exactly one eligible candidate — safe to auto-place. */
  readonly safe: ReadonlyArray<AutoPlacementPlanEntrySafe>;
  /** Slot has 2+ eligible candidates — needs the user to pick. */
  readonly ambiguous: ReadonlyArray<AutoPlacementPlanEntryAmbiguous>;
  /** Slot has candidates by cardId but none match finish (reverse-holo template etc.). */
  readonly wrongVariant: ReadonlyArray<AutoPlacementPlanEntryBlocked>;
  /** Slot has no live unassigned holdings for the target card at all. */
  readonly noHolding: ReadonlyArray<AutoPlacementPlanEntryBlocked>;
  /** Slot is already filled (owned). */
  readonly alreadyOwned: ReadonlyArray<{ readonly slot: BinderSlotRecord }>;
  /** Slot has no target card (blank slot — use the assign modal). */
  readonly noTarget: ReadonlyArray<{ readonly slot: BinderSlotRecord }>;
}

/**
 * Build the placement plan for one binder. Read-only; never writes.
 * Performs at most one Dexie call per store regardless of slot count.
 */
export async function buildAutoPlacementPlan(
  deps: BinderAssignmentDeps,
  binderId: string,
): Promise<AutoPlacementPlan | null> {
  const binder = await deps.bindersRepo.get(binderId);
  if (binder === undefined || binder.deletedAt !== null) return null;

  const allSlots = await deps.binderSlotsRepo.listByBinderId(binderId);
  const liveSlots = allSlots.filter((s) => s.deletedAt === null);

  const allHoldings = await deps.holdingsRepo.listLive();
  const holdingsByCardId = new Map<string, HoldingRecord[]>();
  for (const h of allHoldings) {
    const arr = holdingsByCardId.get(h.cardId);
    if (arr === undefined) holdingsByCardId.set(h.cardId, [h]);
    else arr.push(h);
  }

  // Cross-binder: a holding already bound to a live slot in ANY binder
  // is not a candidate here. Matches `master-set-gap-service` so the
  // banner's `canPlaceDirectly` and the auto-button label agree.
  const allLiveSlotsAcrossBinders = await deps.binderSlotsRepo.listLive();
  const initialConsumed = new Set<string>();
  for (const s of allLiveSlotsAcrossBinders) {
    if (s.holdingId !== null) initialConsumed.add(s.holdingId);
  }

  const safe: AutoPlacementPlanEntrySafe[] = [];
  const ambiguous: AutoPlacementPlanEntryAmbiguous[] = [];
  const wrongVariant: AutoPlacementPlanEntryBlocked[] = [];
  const noHolding: AutoPlacementPlanEntryBlocked[] = [];
  const alreadyOwned: Array<{ slot: BinderSlotRecord }> = [];
  const noTarget: Array<{ slot: BinderSlotRecord }> = [];

  // Mid-walk reservation: when a slot is classified as `safe`, its
  // holding is reserved against later slots so we never put the same
  // physical holding into two safe entries in the same plan. This
  // mirrors the old serialised auto-assign loop and means
  // `plan.safe.length` is exactly the number of placements
  // `autoAssignBinder` will perform.
  const consumedInRun = new Set<string>(initialConsumed);

  for (const slot of liveSlots) {
    if (slot.holdingId !== null && slot.status === 'owned') {
      alreadyOwned.push({ slot });
      continue;
    }
    if (slot.targetCardId === null) {
      noTarget.push({ slot });
      continue;
    }
    const allCandidates = (holdingsByCardId.get(slot.targetCardId) ?? []).filter(
      (h) => h.deletedAt === null && !consumedInRun.has(h.id),
    );
    const reverseTemplate = isReverseHoloTemplateSlot(slot.note);
    const eligible = reverseTemplate
      ? allCandidates.filter((h) => h.finish === 'reverse_holo')
      : allCandidates;

    if (eligible.length === 0) {
      if (allCandidates.length > 0) {
        wrongVariant.push({ slot, candidates: allCandidates });
      } else {
        noHolding.push({ slot, candidates: [] });
      }
      continue;
    }
    if (eligible.length === 1) {
      const holding = eligible[0];
      if (holding === undefined) continue;
      safe.push({ slot, holding });
      consumedInRun.add(holding.id);
    } else {
      ambiguous.push({ slot, candidates: eligible });
    }
  }

  return {
    binderId,
    safe,
    ambiguous,
    wrongVariant,
    noHolding,
    alreadyOwned,
    noTarget,
  };
}

/**
 * Walks every live target slot in the binder and tries to assign one
 * eligible unassigned holding per slot. Conservative: ambiguous slots
 * (multiple eligible candidates) are skipped, NOT silently disambiguated.
 *
 * PR 29 review patch — now derived from `buildAutoPlacementPlan` so the
 * UI auto-button count, the gap-banner `canPlaceDirectly`, and the
 * actual placements performed by THIS function are guaranteed to be the
 * same set.
 */
export async function autoAssignBinder(
  deps: BinderAssignmentDeps,
  options: AutoAssignOptions,
): Promise<AutoAssignResult> {
  const binder = await deps.bindersRepo.get(options.binderId);
  if (binder === undefined || binder.deletedAt !== null) {
    return emptyResult();
  }
  const plan = await buildAutoPlacementPlan(deps, options.binderId);
  if (plan === null) return emptyResult();

  const assigned: Array<{
    slotId: string;
    holdingId: string;
    cardId: string;
  }> = [];
  let skippedWrongVariant = plan.wrongVariant.length;
  // Track holdings we just placed so a single physical holding we
  // somehow encounter twice in a single run does not double-place.
  const placedHoldingIds = new Set<string>();

  for (const entry of plan.safe) {
    if (placedHoldingIds.has(entry.holding.id)) {
      // Defensive: should not happen since the plan dedupes by
      // cross-binder assignment, but keeps the contract stable.
      skippedWrongVariant += 1;
      continue;
    }
    try {
      await assignHoldingToSlot(deps, entry.slot, entry.holding, binder.slotsPerPage);
    } catch {
      // The repo / our pre-checks rejected — record under the
      // closest-fit bucket so the UI summary stays informative.
      skippedWrongVariant += 1;
      continue;
    }
    placedHoldingIds.add(entry.holding.id);
    if (entry.slot.targetCardId !== null) {
      assigned.push({
        slotId: entry.slot.id,
        holdingId: entry.holding.id,
        cardId: entry.slot.targetCardId,
      });
    }
  }

  return {
    assigned,
    skippedAlreadyOwned: plan.alreadyOwned.length,
    skippedNoTarget: plan.noTarget.length,
    skippedNoHolding: plan.noHolding.length,
    skippedAmbiguous: plan.ambiguous.length,
    skippedWrongVariant,
  };
}

// ---------------------------------------------------------------------
// Direct-add: create a holding for a target slot and assign it

export interface DirectAddInputBase {
  readonly conditionType: HoldingInput['conditionType'];
  readonly rawCondition: HoldingInput['rawCondition'];
  readonly gradingCompany: HoldingInput['gradingCompany'];
  readonly grade: HoldingInput['grade'];
  readonly certNumber: HoldingInput['certNumber'];
  readonly certUrl: HoldingInput['certUrl'];
  readonly gradedDate: HoldingInput['gradedDate'];
  readonly finish: HoldingInput['finish'];
  readonly edition: HoldingInput['edition'];
  readonly language: HoldingInput['language'];
  readonly quantity: HoldingInput['quantity'];
  readonly purchasePrice: HoldingInput['purchasePrice'];
  readonly purchaseCurrency: HoldingInput['purchaseCurrency'];
  readonly note: HoldingInput['note'];
  readonly specialVariant: HoldingInput['specialVariant'];
  readonly tags: HoldingInput['tags'];
}

export interface CreateHoldingForSlotResult {
  readonly holding: HoldingRecord;
  readonly slot: BinderSlotRecord;
}

/**
 * Two-step: create a holding for the slot's target card, then assign
 * it. The holding write is final once committed (Dexie audit + repo
 * validators); if the slot assignment fails afterwards, we soft-delete
 * the freshly created holding so we don't leak orphan inventory in
 * the user's collection. The repos do not currently expose a single
 * cross-table transaction; this rollback is the next-best contract.
 */
export async function createHoldingForSlotAndAssign(
  deps: BinderAssignmentDeps,
  slot: BinderSlotRecord,
  slotsPerPage: SlotsPerPage,
  input: DirectAddInputBase,
): Promise<CreateHoldingForSlotResult> {
  if (slot.targetCardId === null) {
    throw new SlotAssignmentError(
      'Direct-add krever at slotten har et målkort.',
    );
  }
  if (
    isReverseHoloTemplateSlot(slot.note) &&
    input.finish !== 'reverse_holo'
  ) {
    throw new SlotAssignmentError(
      'Reverse-holo template-slot krever finish=reverse_holo.',
    );
  }
  const holdingInput: HoldingInput = {
    cardId: slot.targetCardId,
    quantity: input.quantity,
    conditionType: input.conditionType,
    rawCondition: input.rawCondition,
    gradingCompany: input.gradingCompany,
    grade: input.grade,
    certNumber: input.certNumber,
    certUrl: input.certUrl,
    gradedDate: input.gradedDate,
    finish: input.finish,
    edition: input.edition,
    language: input.language,
    purchasePrice: input.purchasePrice,
    purchaseCurrency: input.purchaseCurrency,
    estimatedValue: null,
    valueCurrency: null,
    valueSource: 'unknown',
    valueNote: null,
    valueUpdatedAt: null,
    source: 'manual',
    note: input.note,
    specialVariant: input.specialVariant,
    tags: input.tags,
    lotId: null,
    status: 'owned',
  };
  const holding = await deps.holdingsRepo.create(holdingInput);
  let updatedSlot: BinderSlotRecord;
  try {
    updatedSlot = await assignHoldingToSlot(
      deps,
      slot,
      holding,
      slotsPerPage,
    );
  } catch (caught) {
    // Rollback: the slot assign failed but the holding is already in
    // the collection. Soft-delete it so the user doesn't end up with
    // a phantom holding they have to clean up manually.
    try {
      await deps.holdingsRepo.softDelete(
        holding.id,
        'PR24 direct-add rollback: slot assign failed',
      );
    } catch {
      // Best effort. If even the rollback fails, surface the original
      // error to the caller — the holding is still soft-deletable
      // from the Collection view if needed.
    }
    throw caught;
  }
  return { holding, slot: updatedSlot };
}

// ---------------------------------------------------------------------
// Internals

function emptyResult(): AutoAssignResult {
  return {
    assigned: [],
    skippedAlreadyOwned: 0,
    skippedNoTarget: 0,
    skippedNoHolding: 0,
    skippedAmbiguous: 0,
    skippedWrongVariant: 0,
  };
}

// Re-export so the UI can detect reverse-holo intent without depending
// on the domain module directly. Same string the binder-template uses
// when it generates reverse-holo template rows.
export { REVERSE_HOLO_TEMPLATE_MARKER };
