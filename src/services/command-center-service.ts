// PR 27 — command center service. Pure: no DB, no DOM. Takes the
// dashboard snapshot + master-gap dashboard summary + personal
// preferences and produces a sorted list of action items the
// dashboard's "Arbeidskø" panel renders.
//
// Sorting contract:
//   1. critical items always come first, in stable order
//   2. focus mode boosts the items that match the user's current
//      attention (see FOCUS_BOOSTS)
//   3. severity within a group: warning > info > success
//   4. trim to commandCenterMaxItems but NEVER drop critical items
//   5. only emit `all_clear` if commandCenterShowAllClear is true AND
//      no other items remain

import type {
  ActionItem,
} from '../domain/dashboard-actions';
import type {
  MasterGapDashboardSummary,
} from '../domain/master-set-gap';
import type {
  DashboardFocusMode,
  PersonalPreferences,
} from '../domain/personal-preferences';
import type { DashboardSnapshot } from './dashboard-service';

export type CommandCenterItemSeverity =
  | 'critical'
  | 'warning'
  | 'info'
  | 'success';

export type CommandCenterItemKind =
  | 'fix_invalid_slots'
  | 'place_owned_cards'
  | 'resolve_ambiguous_owned'
  // PR 28 — split of `resolve_ambiguous_owned`. The recommended item
  // covers ambiguous rows where best-copy picks a single trygg vinner
  // (one click via the master-gap "Plasser anbefalt" button); the
  // manual item covers rows that still need user judgement.
  | 'place_recommended_copies'
  | 'resolve_manual_ambiguous'
  | 'follow_up_ordered'
  | 'wishlist_missing'
  | 'materialize_lots'
  | 'collection_missing_condition'
  | 'collection_missing_value'
  | 'collection_not_in_binder'
  | 'collection_duplicates'
  | 'backup_needed'
  | 'sync_needed'
  | 'all_clear';

export interface CommandCenterItem {
  readonly kind: CommandCenterItemKind;
  readonly severity: CommandCenterItemSeverity;
  readonly title: string;
  readonly message: string;
  readonly count: number;
  readonly actionLabel: string;
  readonly target:
    | { type: 'hash'; hash: string }
    | { type: 'none' };
}

const SEVERITY_ORDER: Record<CommandCenterItemSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
  success: 3,
};

// Maps user focus to the kinds that rise to the top within their
// severity bucket. We don't change severity (critical stays critical),
// just nudge the user toward the things they explicitly asked to
// focus on.
const FOCUS_BOOSTS: Record<DashboardFocusMode, ReadonlySet<CommandCenterItemKind>> = {
  balanced: new Set(),
  master_set: new Set([
    'fix_invalid_slots',
    'place_owned_cards',
    'place_recommended_copies',
    'resolve_manual_ambiguous',
    'resolve_ambiguous_owned',
    'wishlist_missing',
  ]),
  binder_work: new Set([
    'place_owned_cards',
    'place_recommended_copies',
    'resolve_manual_ambiguous',
    'resolve_ambiguous_owned',
    'collection_not_in_binder',
  ]),
  wishlist: new Set(['follow_up_ordered', 'wishlist_missing']),
  lots: new Set(['materialize_lots']),
  collection_health: new Set([
    'collection_missing_condition',
    'collection_missing_value',
    'collection_duplicates',
    'backup_needed',
    'sync_needed',
  ]),
};

interface BuildCommandCenterInput {
  readonly masterGap: MasterGapDashboardSummary | null;
  readonly dashboard: DashboardSnapshot | null;
  readonly preferences: PersonalPreferences;
}

/**
 * Build the prioritised command-center item list. Pure function.
 * Order of operations:
 *   1. Generate every candidate item from the master-gap + dashboard
 *      data. Items with count = 0 are dropped here.
 *   2. Sort by (severity ASC, focusBoost DESC, kindOrder ASC).
 *   3. Trim to `preferences.commandCenterMaxItems`, never dropping
 *      critical items.
 *   4. Append a single `all_clear` item if the trimmed list is empty
 *      AND `preferences.commandCenterShowAllClear === true`.
 */
export function buildCommandCenterItems(
  input: BuildCommandCenterInput,
): CommandCenterItem[] {
  const masterGap = input.masterGap;
  const dashboard = input.dashboard;
  const prefs = input.preferences;

  const candidates: CommandCenterItem[] = [];

  if (masterGap !== null) {
    if (masterGap.invalidCount > 0) {
      candidates.push({
        kind: 'fix_invalid_slots',
        severity: 'critical',
        title: 'Rett feil først',
        message:
          `${masterGap.invalidCount} permslot har feilplassert holding eller feil variant.`,
        count: masterGap.invalidCount,
        actionLabel: 'Åpne master gap',
        target: { type: 'hash', hash: '#master-gap' },
      });
    }
    // Review patch: `canPlaceDirectlyCount` is a strict subset of
    // `ownedUnplaced` (it counts owned-unplaced slots that ALSO have
    // exactly one safe candidate). If we surface both as raw counts
    // we get two near-duplicate "place owned" items in Arbeidskø.
    // Subtract so the remaining-owned card only counts slots that
    // still need manual judgement.
    const remainingOwnedUnplaced = Math.max(
      0,
      masterGap.ownedUnplaced - masterGap.canPlaceDirectlyCount,
    );
    if (masterGap.canPlaceDirectlyCount > 0) {
      candidates.push({
        kind: 'place_owned_cards',
        severity: 'warning',
        title: 'Plasser kort du allerede eier',
        message:
          `${masterGap.canPlaceDirectlyCount} slot kan fylles direkte fra eksisterende holdings.`,
        count: masterGap.canPlaceDirectlyCount,
        actionLabel: 'Åpne master gap',
        target: { type: 'hash', hash: '#master-gap' },
      });
    }
    if (remainingOwnedUnplaced > 0) {
      candidates.push({
        kind: 'place_owned_cards', // documented in spec; same kind reused
        severity: 'warning',
        title: 'Rydd eide kort inn i permer',
        message:
          `${remainingOwnedUnplaced} eide kort krever manuell vurdering før plassering.`,
        count: remainingOwnedUnplaced,
        actionLabel: 'Åpne master gap',
        target: { type: 'hash', hash: '#master-gap' },
      });
    }
    // PR 28 — split ambiguous_owned into "safe to bulk-place" and
    // "still manual". Falls back to the legacy single chip when the
    // master-gap summary doesn't carry the new aggregate fields
    // (defensive — older snapshots, third-party callers).
    const recommended = masterGap.recommendedAmbiguousCount ?? 0;
    const manual = masterGap.manualAmbiguousCount ?? 0;
    if (recommended === 0 && manual === 0 && masterGap.ambiguousOwned > 0) {
      // Legacy fallback (e.g. an older summary feeding the service).
      candidates.push({
        kind: 'resolve_ambiguous_owned',
        severity: 'warning',
        title: 'Velg riktig kopi',
        message:
          `${masterGap.ambiguousOwned} slot har flere mulige kopier — velg manuelt.`,
        count: masterGap.ambiguousOwned,
        actionLabel: 'Åpne master gap',
        target: { type: 'hash', hash: '#master-gap' },
      });
    } else {
      if (recommended > 0) {
        candidates.push({
          kind: 'place_recommended_copies',
          severity: 'warning',
          title: 'Plasser anbefalte kopier',
          message: `${recommended} slot har trygg anbefaling.`,
          count: recommended,
          actionLabel: 'Åpne master gap',
          target: { type: 'hash', hash: '#master-gap' },
        });
      }
      if (manual > 0) {
        candidates.push({
          kind: 'resolve_manual_ambiguous',
          severity: 'warning',
          title: 'Velg manuelt',
          message: `${manual} slot trenger manuell vurdering.`,
          count: manual,
          actionLabel: 'Åpne master gap',
          target: { type: 'hash', hash: '#master-gap' },
        });
      }
    }
    if (masterGap.wishlistOrdered > 0) {
      candidates.push({
        kind: 'follow_up_ordered',
        severity: 'info',
        title: 'Følg opp bestilte kort',
        message:
          `${masterGap.wishlistOrdered} bestilte kort venter på å bli mottatt.`,
        count: masterGap.wishlistOrdered,
        actionLabel: 'Åpne ønskeliste',
        target: { type: 'hash', hash: '#wishlist' },
      });
    }
    if (masterGap.missing > 0) {
      candidates.push({
        kind: 'wishlist_missing',
        severity: 'warning',
        title: 'Legg manglende kort i ønskeliste',
        message:
          `${masterGap.missing} permslot mangler holding og dekkes ikke av lot eller ønskeliste.`,
        count: masterGap.missing,
        actionLabel: 'Åpne master gap',
        target: { type: 'hash', hash: '#master-gap' },
      });
    }
    if (masterGap.inLotUnmaterialized > 0) {
      candidates.push({
        kind: 'materialize_lots',
        severity: 'info',
        title: 'Materialiser kort fra lotter',
        message:
          `${masterGap.inLotUnmaterialized} lot-items kan flyttes inn i samlingen.`,
        count: masterGap.inLotUnmaterialized,
        actionLabel: 'Åpne lotter',
        target: { type: 'hash', hash: '#lots' },
      });
    }
  }

  if (dashboard !== null) {
    if (dashboard.collection.missingConditionCount > 0) {
      candidates.push({
        kind: 'collection_missing_condition',
        severity: 'info',
        title: 'Rydd manglende tilstand',
        message:
          `${dashboard.collection.missingConditionCount} holdings mangler tilstand.`,
        count: dashboard.collection.missingConditionCount,
        actionLabel: 'Åpne min samling',
        target: { type: 'hash', hash: '#collection' },
      });
    }
    if (dashboard.collection.missingValueCount > 0) {
      candidates.push({
        kind: 'collection_missing_value',
        severity: 'info',
        title: 'Rydd manglende verdi',
        message:
          `${dashboard.collection.missingValueCount} holdings mangler verdi.`,
        count: dashboard.collection.missingValueCount,
        actionLabel: 'Åpne min samling',
        target: { type: 'hash', hash: '#collection' },
      });
    }
    if (dashboard.collection.notInBinderCount > 0) {
      candidates.push({
        kind: 'collection_not_in_binder',
        severity: 'warning',
        title: 'Kort uten permplassering',
        message:
          `${dashboard.collection.notInBinderCount} holdings har ingen permslot.`,
        count: dashboard.collection.notInBinderCount,
        actionLabel: 'Åpne min samling',
        target: { type: 'hash', hash: '#collection' },
      });
    }
    if (dashboard.collection.duplicateStatusCount > 0) {
      candidates.push({
        kind: 'collection_duplicates',
        severity: 'info',
        title: 'Gå gjennom duplikater',
        message:
          `${dashboard.collection.duplicateStatusCount} holdings er markert som duplikater.`,
        count: dashboard.collection.duplicateStatusCount,
        actionLabel: 'Åpne min samling',
        target: { type: 'hash', hash: '#collection' },
      });
    }
    // Backup / sync are derived from the dashboard's own action strip
    // so we don't duplicate the threshold logic here.
    const backupAction = findActionByPrefix(dashboard.actions, 'backup_');
    if (backupAction !== null) {
      candidates.push(actionToCommandItem('backup_needed', backupAction));
    }
    const syncAction = findActionByPrefix(dashboard.actions, 'sync_');
    if (syncAction !== null) {
      candidates.push(actionToCommandItem('sync_needed', syncAction));
    }
  }

  // Sort: critical first; then focus boost (boosted items rise within
  // their severity); then severity order; then a stable per-kind order.
  const focusBoosts = FOCUS_BOOSTS[prefs.dashboardFocusMode];
  const kindOrder = KIND_ORDER;
  const sorted = candidates.slice().sort((a, b) => {
    const sevDelta = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (sevDelta !== 0) return sevDelta;
    const aBoost = focusBoosts.has(a.kind) ? 0 : 1;
    const bBoost = focusBoosts.has(b.kind) ? 0 : 1;
    if (aBoost !== bBoost) return aBoost - bBoost;
    return (kindOrder.get(a.kind) ?? 100) - (kindOrder.get(b.kind) ?? 100);
  });

  // Trim to max items, but always keep critical items even if they
  // exceed the cap.
  const maxItems = Math.max(prefs.commandCenterMaxItems, 1);
  const criticals = sorted.filter((i) => i.severity === 'critical');
  const rest = sorted.filter((i) => i.severity !== 'critical');
  const restBudget = Math.max(0, maxItems - criticals.length);
  const trimmed = [...criticals, ...rest.slice(0, restBudget)];

  if (trimmed.length === 0 && prefs.commandCenterShowAllClear) {
    trimmed.push({
      kind: 'all_clear',
      severity: 'success',
      title: 'Arbeidskøen er tom',
      message: 'Alt ser ryddig ut akkurat nå. Ta en pust i bakken.',
      count: 0,
      actionLabel: 'OK',
      target: { type: 'none' },
    });
  }
  return trimmed;
}

const KIND_ORDER: ReadonlyMap<CommandCenterItemKind, number> = new Map<
  CommandCenterItemKind,
  number
>([
  ['fix_invalid_slots', 0],
  ['place_owned_cards', 1],
  // PR 28 — recommended copies sit BEFORE the manual ambiguous chip
  // so the safe one-click bulk action is always closer to the top
  // when both are present.
  ['place_recommended_copies', 2],
  ['resolve_manual_ambiguous', 3],
  ['resolve_ambiguous_owned', 3],
  ['wishlist_missing', 4],
  ['follow_up_ordered', 5],
  ['materialize_lots', 6],
  ['collection_not_in_binder', 7],
  ['collection_duplicates', 8],
  ['collection_missing_condition', 9],
  ['collection_missing_value', 10],
  ['backup_needed', 11],
  ['sync_needed', 12],
  ['all_clear', 99],
]);

function findActionByPrefix(
  actions: readonly ActionItem[],
  prefix: string,
): ActionItem | null {
  for (const a of actions) {
    if (a.id.startsWith(prefix)) return a;
  }
  return null;
}

function actionToCommandItem(
  kind: CommandCenterItemKind,
  action: ActionItem,
): CommandCenterItem {
  const severity: CommandCenterItemSeverity =
    action.severity === 'critical'
      ? 'critical'
      : action.severity === 'warning'
        ? 'warning'
        : 'info';
  const target =
    action.goTo !== undefined
      ? ({ type: 'hash', hash: `#${action.goTo}` } as const)
      : ({ type: 'none' } as const);
  return {
    kind,
    severity,
    title: action.title,
    message: action.message,
    count: 1,
    actionLabel: action.goTo !== undefined ? `Åpne ${action.goTo}` : 'Detaljer',
    target,
  };
}
