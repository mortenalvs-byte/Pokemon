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
import type { AuditInput } from '../db/audit';
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
  /**
   * PR A2 — Optional audit emitter. When provided, the service
   * appends a `binder_legacy_unscoped` row each time
   * `assignHoldingToSlot` succeeds against a binder whose
   * `sourceSetId` is null. Consumers that don't provide it
   * (existing tests, `recommended-placement-service`, any other
   * legacy caller) skip the audit silently — the assignment itself
   * still runs unchanged. This is append-only: never updates or
   * deletes audit rows (DATA_MODEL §4).
   */
  readonly appendAudit?: (entry: AuditInput) => Promise<unknown>;
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

  // PR A2: when the binder is set-scoped (sourceSetId !== null),
  // additionally exclude any holdings whose card belongs to a different
  // set. The check is performed PER HOLDING (not just on the slot's
  // targetCardId) so it remains correct even if data integrity drifts
  // (e.g. a holding whose card was retroactively re-classified to a
  // different set). Defence in depth on top of slot.targetCardId
  // matching — the typical case where holding.cardId === slot.targetCardId
  // resolves to the same answer.
  const binder = await deps.bindersRepo.get(slot.binderId);
  const requiredSetId =
    binder !== undefined && binder.sourceSetId !== null
      ? binder.sourceSetId
      : null;

  const out: AssignableHolding[] = [];
  for (const holding of holdings) {
    if (holding.deletedAt !== null) continue;
    if (assignedHoldingIds.has(holding.id)) continue;
    if (reverseTemplate && holding.finish !== 'reverse_holo') continue;
    if (requiredSetId !== null) {
      // Look up the holding's OWN card.setId, not the slot's target.
      const holdingCard =
        holding.cardId === slot.targetCardId
          ? card
          : (await deps.cardsRepo.get(holding.cardId)) ?? null;
      if (holdingCard === null || holdingCard.setId !== requiredSetId) {
        continue;
      }
    }
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
 * PR A2 — Cross-set guard for assignHoldingToSlot. **Pure validation
 * with NO side-effects.** Returns whether the binder is in the legacy
 * unscoped state so the caller can decide what to do AFTER the write
 * succeeds (the audit emission has to wait until after the slot
 * update — emitting it from inside this guard would leave a false
 * audit row when a later validation, like one-holding-one-slot,
 * rejects the assignment).
 *
 * Throws SlotAssignmentError when the holding's card belongs to a
 * different set than the binder it's being placed into — but ONLY
 * when the binder has a non-null `sourceSetId`. Legacy binders
 * (`sourceSetId === null`, pre-A1) keep their previous lenient
 * behaviour to preserve existing user data.
 *
 * Resolution failures (binder gone, card not in cache) fall through
 * silently as "can't verify, allow" rather than blocking the user
 * for a defensive read; the cardId-match check above already catches
 * the common wrong-card case. This is consistent with PR 24's "single
 * writer" being the authority on assignment correctness.
 *
 * Returns: `{ legacyBinderId }` — the binder id when it's a legacy
 * null-sourceSetId binder (the caller emits `binder_legacy_unscoped`
 * after the write); `null` for scoped binders, unknown binders, and
 * unresolvable card lookups.
 */
async function assertSetMatchForAssignment(
  deps: BinderAssignmentDeps,
  slot: BinderSlotRecord,
  holding: HoldingRecord,
): Promise<{ legacyBinderId: string | null }> {
  const binder = await deps.bindersRepo.get(slot.binderId);
  if (binder === undefined) return { legacyBinderId: null };
  if (binder.sourceSetId === null) {
    // Legacy binder — preserve pre-A1 lenient assignment. Report the
    // legacy state to the caller; do NOT emit the audit row here
    // because later checks (one-holding-one-slot, repo.update
    // failure) may still reject the assignment, and the audit log is
    // append-only — a falsely-emitted row cannot be retracted.
    return { legacyBinderId: binder.id };
  }

  const card = await deps.cardsRepo.get(holding.cardId);
  if (card === undefined) return { legacyBinderId: null };  // unknown card — defer to cardId match
  if (card.setId === binder.sourceSetId) return { legacyBinderId: null };  // happy path

  throw new SlotAssignmentError(
    `Holdingen er fra sett ${card.setId}, men permen er bundet til sett ${binder.sourceSetId}. ` +
    `Velg en holding fra riktig sett, eller plasser kortet i en annen perm.`,
  );
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

/**
 * PR 38a — Pre-load a snapshot of every holdingId currently bound to a
 * live binder slot. Callers running a bulk loop of `assignHoldingToSlot`
 * (e.g. `placeRecommendedForReport`) pass this snapshot via the
 * `context.assignedHoldingIds` argument so each call skips its own
 * `binderSlotsRepo.listLive()` round-trip. The caller is responsible
 * for keeping the snapshot current after each successful assignment:
 * remove the slot's previous holdingId (if any, and not equal to the
 * new one), then add the new holdingId. The one-holding-one-slot
 * invariant from PR 24 stays enforced — the snapshot just moves the
 * O(slots) walk from per-call to per-batch.
 */
export async function loadAssignedHoldingIdsSnapshot(
  deps: BinderAssignmentDeps,
): Promise<Set<string>> {
  return getAssignedHoldingIds(deps, null);
}

/**
 * PR 38a — Optional context for `assignHoldingToSlot`. When provided
 * with a pre-loaded `assignedHoldingIds` snapshot, the function skips
 * its own `listLive()` call and trusts the snapshot for the
 * one-holding-one-slot check. See `loadAssignedHoldingIdsSnapshot`.
 */
export interface AssignHoldingContext {
  /**
   * FULL set of holdingIds bound to live slots (no slot-id exclusion).
   * The function adapts the check to allow re-assigning the same
   * holding back to its current slot.
   */
  readonly assignedHoldingIds: Set<string>;
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
  context?: AssignHoldingContext,
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
  // PR A2: cross-set assignment guard. When the binder is bound to a
  // specific set (binder.sourceSetId !== null), reject any holding
  // whose card belongs to a different set. Legacy binders with
  // sourceSetId === null preserve their pre-A1 behaviour (no rejection)
  // — the v1->v2 schema kept the field optional and existing user data
  // must keep loading without forcing migration.
  //
  // The guard is PURE: it returns the legacy-binder context so the
  // `binder_legacy_unscoped` audit row can be appended AFTER all later
  // validations + the slot update succeed. Emitting from inside the
  // guard would leak a false audit row if a subsequent check (e.g. the
  // one-holding-one-slot check below) rejects the assignment — the
  // audit log is append-only (DATA_MODEL §4) and cannot retract.
  const setGuard = await assertSetMatchForAssignment(deps, slot, holding);
  // One-holding-one-slot enforcement. PR 38a: when the caller passes a
  // pre-loaded `context.assignedHoldingIds` snapshot, skip the
  // `listLive()` round-trip and check the snapshot in O(1). The
  // snapshot is the FULL set (no slot-id exclusion), so a re-assignment
  // of the same holding to its current slot — `slot.holdingId ===
  // holding.id` — must still be allowed: in that case the holdingId is
  // in the set, but it's not "elsewhere". Without context, the original
  // per-call listLive() path (excluding slot.id) is preserved verbatim.
  let isAssignedElsewhere: boolean;
  if (context !== undefined) {
    isAssignedElsewhere =
      context.assignedHoldingIds.has(holding.id) &&
      slot.holdingId !== holding.id;
  } else {
    const otherAssignedHoldingIds = await getAssignedHoldingIds(deps, slot.id);
    isAssignedElsewhere = otherAssignedHoldingIds.has(holding.id);
  }
  if (isAssignedElsewhere) {
    throw new SlotAssignmentError(
      'Holdingen er allerede plassert i en annen slot.',
    );
  }
  const updated = await deps.binderSlotsRepo.update(
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

  // PR A2: post-write audit emission for legacy null-sourceSetId
  // binders. The update succeeded, so the audit row now accurately
  // records the touch. If `appendAudit` itself throws (which would be
  // a rare audit-store failure), the slot is already updated — we
  // swallow the audit error rather than re-throwing because rolling
  // back the slot update without `binder_slot_unassigned` semantics
  // would muddy the action history. The operator-facing failure mode
  // is "assignment succeeded but audit was lost", which is preferable
  // to "slot update succeeded then partial rollback."
  if (setGuard.legacyBinderId !== null && deps.appendAudit !== undefined) {
    try {
      await deps.appendAudit({
        action: 'binder_legacy_unscoped',
        entityType: 'binder',
        entityId: setGuard.legacyBinderId,
        message:
          `legacy unscoped binder ${setGuard.legacyBinderId} ` +
          `(page ${slot.pageNumber}/slot ${slot.slotNumber}) ` +
          `received holding ${holding.id} (card ${holding.cardId})`,
      });
    } catch { /* best-effort; slot update already succeeded */ }
  }

  return updated;
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
