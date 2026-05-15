// Apply a master-set binder plan: loops over each `MasterSetBinderPlan`
// and writes it via `BinderService.createMultiSetMasterBinder`. Each
// binder is its own Dexie transaction, so a failure midway through
// leaves the earlier binders committed; the operator can retry the
// remaining ones with a fresh apply call.
//
// This module performs I/O (Dexie writes via the injected service); the
// planner module that produced the input remains pure.

import type { BinderRecord, BinderSlotRecord } from '../domain/types';
import type { BinderService } from './binder-service';
import type {
  MasterSetBinderPlan,
  MasterSetPlanResult,
} from './master-set-binder-planner';

export interface ApplyMasterSetPlanOptions {
  /**
   * Prefix used for auto-generated binder names. The final name for the
   * Nth binder is `${namePrefix} ${binderIndex}/${totalBinders}`, e.g.
   * `Master perm 1/19`. Defaults to "Master perm".
   */
  readonly namePrefix?: string;
  /**
   * Optional explicit names. When provided, length must match
   * `plan.binders.length`. Overrides `namePrefix`.
   */
  readonly binderNames?: readonly string[];
  /**
   * Per-binder progress callback. Fires AFTER each binder is committed.
   * Use to update a "Oppretter binder K av N" status line.
   */
  readonly onProgress?: (event: ApplyProgressEvent) => void;
}

export interface ApplyProgressEvent {
  readonly index: number; // 1-based
  readonly total: number;
  readonly binderId: string;
  readonly binderName: string;
}

export interface ApplyMasterSetPlanResult {
  readonly created: ReadonlyArray<{
    readonly binder: BinderRecord;
    readonly slotCount: number;
  }>;
  readonly failedAt: ApplyFailure | null;
}

export interface ApplyFailure {
  readonly index: number; // 1-based binder position that failed
  readonly attemptedName: string;
  readonly error: string;
}

export async function applyMasterSetPlan(
  service: BinderService,
  plan: MasterSetPlanResult,
  options: ApplyMasterSetPlanOptions = {},
): Promise<ApplyMasterSetPlanResult> {
  const total = plan.binders.length;
  if (
    options.binderNames !== undefined &&
    options.binderNames.length !== total
  ) {
    throw new Error(
      `binderNames length (${options.binderNames.length}) must match plan.binders.length (${total})`,
    );
  }

  const created: Array<{ binder: BinderRecord; slotCount: number }> = [];

  for (let i = 0; i < total; i += 1) {
    const binderPlan = plan.binders[i];
    if (binderPlan === undefined) continue;
    const name =
      options.binderNames?.[i]
      ?? buildBinderName(binderPlan, i + 1, total, options.namePrefix);
    const description = describeBinder(binderPlan);
    try {
      const { binder, slots } = await service.createMultiSetMasterBinder({
        name,
        description,
        plan: binderPlan,
      });
      const targetSlots = countTargetSlots(slots);
      created.push({ binder, slotCount: targetSlots });
      options.onProgress?.({
        index: i + 1,
        total,
        binderId: binder.id,
        binderName: binder.name,
      });
    } catch (caught) {
      return {
        created,
        failedAt: {
          index: i + 1,
          attemptedName: name,
          error:
            caught instanceof Error ? caught.message : String(caught),
        },
      };
    }
  }

  return { created, failedAt: null };
}

/**
 * Build a binder name that gives the operator instant overview:
 *   - which era / series are inside
 *   - how many sets
 *   - the year range
 *
 * Output formats:
 *   - all-one-series:   `Master 14/36 · XY · 4 sett · 2014–2015`
 *   - few series:       `Master 1/36 · Base + Gym + Neo · 10 sett · 1999–2002`
 *   - many series:      `Master 2/36 · Base + Neo + EX +3 · 18 sett · 2001–2007`
 *   - split set:        `Master 1/2 · {setId} (del 1) · 1 sett · 2025`
 *
 * 60-char cap keeps the name single-line in the Permer list. Full set
 * detail lives in `description`, which the dialog/apply layer writes
 * alongside the name.
 */
export function buildBinderName(
  binder: MasterSetBinderPlan,
  index: number,
  total: number,
  namePrefix?: string,
): string {
  const prefix = namePrefix?.trim() || 'Master';
  const head = `${prefix} ${index}/${total}`;

  if (binder.sections.length === 0) return head;

  const yearRange = yearRangeOf(binder);
  const setCount = binder.sections.length;
  const setCountLabel = `${setCount} sett`;

  // Split-set case: one section, a slice of a >1088 set.
  if (
    binder.sections.length === 1 &&
    (binder.sections[0]?.continuedFromPreviousBinder === true ||
      binder.sections[0]?.continuesIntoNextBinder === true)
  ) {
    const sec = binder.sections[0];
    if (sec !== undefined) {
      const part = sec.continuedFromPreviousBinder ? 'del 2+' : 'del 1';
      return `${head} · ${sec.setId} (${part}) · 1 sett · ${yearRange}`;
    }
  }

  // Group sections by series, preserving plan order (insertion order in
  // a Map). The result is "Base + Gym + Neo" style — never set IDs.
  const seriesOrdered: string[] = [];
  const seriesSeen = new Set<string>();
  for (const sec of binder.sections) {
    if (!seriesSeen.has(sec.series)) {
      seriesSeen.add(sec.series);
      seriesOrdered.push(sec.series);
    }
  }

  // Try full series list, then progressively truncate.
  const trySeries = (list: readonly string[], tailNote: string): string =>
    `${head} · ${list.join(' + ')}${tailNote} · ${setCountLabel} · ${yearRange}`;

  let candidate = trySeries(seriesOrdered, '');
  if (candidate.length <= 60) return candidate;

  for (let kept = seriesOrdered.length - 1; kept >= 1; kept -= 1) {
    const remaining = seriesOrdered.length - kept;
    candidate = trySeries(seriesOrdered.slice(0, kept), ` +${remaining}`);
    if (candidate.length <= 60) return candidate;
  }

  // Fallback: the first series alone is too long. Truncate it.
  const first = seriesOrdered[0] ?? '?';
  const truncatedFirst = first.length > 18 ? `${first.slice(0, 18)}…` : first;
  return `${head} · ${truncatedFirst} +${seriesOrdered.length - 1} · ${setCountLabel} · ${yearRange}`;
}

function yearRangeOf(binder: MasterSetBinderPlan): string {
  let earliest: string | null = null;
  let latest: string | null = null;
  for (const sec of binder.sections) {
    const y = sec.releaseDate.slice(0, 4);
    if (earliest === null || y < earliest) earliest = y;
    if (latest === null || y > latest) latest = y;
  }
  if (earliest === null || latest === null) return '?';
  if (earliest === latest) return earliest;
  return `${earliest}–${latest}`;
}

function describeBinder(binder: MasterSetBinderPlan): string {
  const sections = binder.sections
    .map((s) => {
      const span = s.continuedFromPreviousBinder || s.continuesIntoNextBinder
        ? ' (delsett)'
        : '';
      return `${s.setName}${span}: ${s.totalSlotCount} slots`;
    })
    .join('\n');
  return (
    `${binder.sections.length} sett · ${binder.usedSlotCount} brukte slots · ` +
    `${binder.unusedSlotCount} tomme\n${sections}`
  );
}

function countTargetSlots(slots: readonly BinderSlotRecord[]): number {
  let n = 0;
  for (const s of slots) if (s.targetCardId !== null) n += 1;
  return n;
}
