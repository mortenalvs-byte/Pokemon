// Pure rules engine for the dashboard's action-needed strip. Takes a
// `DashboardSnapshot` and returns an `ActionItem[]` sorted by severity
// (critical → warning → info → stable id).
//
// The function is pure: no DB reads, no clock reads (except for the
// time delta the snapshot already captures via `daysSinceLastBackup`).
// Tests can therefore drive every rule without IndexedDB.
//
// Severity contract:
//   - `critical` and `warning` items render in the action strip at the
//     top of the dashboard.
//   - `info` items are NOT shown in the strip; the section card surfaces
//     them as a count instead. They are still returned so the section
//     view (and tests) can read them from one place.

import type { SidebarRoute } from '../router';
import type { DashboardSnapshot } from '../services/dashboard-service';

export type ActionSeverity = 'info' | 'warning' | 'critical';

export interface ActionItem {
  readonly id: string;
  readonly severity: ActionSeverity;
  readonly title: string;
  readonly message: string;
  readonly goTo?: SidebarRoute;
}

/** Backup is "old" once it crosses this many days. KRAVSPEC §11. */
export const BACKUP_OLD_DAYS = 7;
/** Drives the "many holdings since last backup" warning. KRAVSPEC §11. */
export const HOLDINGS_SINCE_BACKUP_THRESHOLD = 50;

const SEVERITY_ORDER: Record<ActionSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

export function computeActionItems(
  snapshot: DashboardSnapshot,
): readonly ActionItem[] {
  const items: ActionItem[] = [];

  // Backup
  if (snapshot.backup.lastBackupAt === null) {
    items.push({
      id: 'backup_never',
      severity: 'critical',
      title: 'Aldri tatt backup',
      message: 'Eksporter en backup nå slik at samlingen din er trygg.',
      goTo: 'backup',
    });
  } else {
    const days = snapshot.backup.daysSinceLastBackup;
    if (days !== null && days > BACKUP_OLD_DAYS) {
      items.push({
        id: 'backup_old',
        severity: 'warning',
        title: `Backup er ${days} dager gammel`,
        message: `Siste backup ble tatt for ${days} dager siden. Eksporter en ny.`,
        goTo: 'backup',
      });
    }
    if (snapshot.backup.schemaMigratedSinceLastBackup) {
      items.push({
        id: 'backup_after_migration',
        severity: 'warning',
        title: 'Schema migrert siden siste backup',
        message:
          'Databaseskjemaet har blitt oppgradert etter at du sist tok backup. Ta en ny backup.',
        goTo: 'backup',
      });
    }
    if (
      snapshot.backup.holdingsSinceLastBackup >
      HOLDINGS_SINCE_BACKUP_THRESHOLD
    ) {
      items.push({
        id: 'backup_holdings_drift',
        severity: 'warning',
        title: `${snapshot.backup.holdingsSinceLastBackup} nye holdings siden siste backup`,
        message:
          'Du har lagt til mange holdings siden siste backup. Eksporter en ny så ingenting går tapt.',
        goTo: 'backup',
      });
    }
  }

  // Storage
  if (!snapshot.databaseHealth.persistentStorageGranted) {
    items.push({
      id: 'storage_not_persistent',
      severity: 'warning',
      title: 'Persistent storage er ikke innvilget',
      message:
        'Nettleseren kan slette databasen ved plassmangel. Innvilg persistent storage i Innstillinger.',
      goTo: 'settings',
    });
  }

  // Sync
  if (snapshot.sync.lastSyncStatus === 'failed') {
    items.push({
      id: 'sync_failed',
      severity: 'warning',
      title: 'Siste API-sync feilet',
      message:
        snapshot.sync.lastSyncError !== null
          ? `Feil: ${snapshot.sync.lastSyncError}`
          : 'Klikk for å se detaljer og prøve igjen.',
      goTo: 'settings',
    });
  }

  // Lots — partial / unallocated lots that have items
  if (snapshot.lots.unallocatedCount > 0) {
    items.push({
      id: 'lots_unallocated',
      severity: 'warning',
      title: `${snapshot.lots.unallocatedCount} lotter mangler allokering`,
      message:
        'Allokér kostnaden på items før du materialiserer holdings, ellers blir purchasePrice satt feil.',
      goTo: 'lots',
    });
  }

  // Collection-side info items (counts, not strip items)
  if (snapshot.collection.missingConditionCount > 0) {
    items.push({
      id: 'holdings_missing_condition',
      severity: 'info',
      title: `${snapshot.collection.missingConditionCount} holdings mangler tilstand`,
      message: 'Sett rawCondition på holdings som er merket UNKNOWN.',
      goTo: 'collection',
    });
  }
  if (snapshot.collection.missingValueCount > 0) {
    items.push({
      id: 'holdings_missing_value',
      severity: 'info',
      title: `${snapshot.collection.missingValueCount} holdings mangler manuell verdi`,
      message:
        'Legg inn estimatedValue på holdings som ikke har en verdikilde ennå.',
      goTo: 'collection',
    });
  }
  if (snapshot.collection.notInBinderCount > 0) {
    items.push({
      id: 'holdings_not_in_binder',
      severity: 'info',
      title: `${snapshot.collection.notInBinderCount} holdings er ikke tilordnet en perm`,
      message:
        'Vurder å tilordne disse i den relevante permens detalj-vy for bedre completion-tracking.',
      goTo: 'binders',
    });
  }
  if (snapshot.binders.totalMissingSlots > 0) {
    items.push({
      id: 'binder_slots_missing',
      severity: 'info',
      title: `${snapshot.binders.totalMissingSlots} binder-slots mangler kort`,
      message: 'Se detaljvyene for å se hva som gjenstår.',
      goTo: 'binders',
    });
  }

  items.sort((a, b) => {
    const sevDelta = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (sevDelta !== 0) return sevDelta;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return items;
}

/**
 * Strip filter — keeps only `warning` and `critical` items so the
 * dashboard's top strip stays focused on things that genuinely
 * require user attention.
 */
export function filterStripItems(
  actions: readonly ActionItem[],
): readonly ActionItem[] {
  return actions.filter((a) => a.severity !== 'info');
}
