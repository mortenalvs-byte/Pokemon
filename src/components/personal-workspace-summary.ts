// PR 27 — personal workspace summary. Small read-only banner above the
// dashboard command center showing app name, holdings, binders, master
// set %, command center item count, and the top-priority action.
//
// Pure-ish: takes everything as inputs, returns an HTMLElement. The
// dashboard view owns when to mount it (gated on
// `personalPrefs.showPersonalWorkspaceSummary`).

import type {
  CommandCenterItem,
} from '../services/command-center-service';
import type {
  MasterGapDashboardSummary,
} from '../domain/master-set-gap';
import type { DashboardSnapshot } from '../services/dashboard-service';
import type { PersonalPreferences } from '../domain/personal-preferences';

export interface PersonalWorkspaceSummaryInput {
  readonly preferences: PersonalPreferences;
  readonly dashboard: DashboardSnapshot | null;
  readonly masterGap: MasterGapDashboardSummary | null;
  readonly commandCenter: readonly CommandCenterItem[];
}

export function buildPersonalWorkspaceSummary(
  input: PersonalWorkspaceSummaryInput,
): HTMLElement {
  const root = document.createElement('section');
  root.className = 'personal-workspace-summary';
  root.dataset['region'] = 'personal-workspace-summary';

  const heading = document.createElement('h2');
  heading.className = 'personal-workspace-summary__heading';
  heading.textContent = input.preferences.appDisplayName;
  root.appendChild(heading);

  const stats = document.createElement('dl');
  stats.className = 'personal-workspace-summary__stats';

  const liveHoldings = input.dashboard?.databaseHealth.liveHoldingsCount ?? 0;
  const binderCount = input.dashboard?.databaseHealth.liveBindersCount ?? 0;
  const masterPercent = input.masterGap?.averageCompletionPercent ?? 0;
  const items = input.commandCenter.length;
  const top = input.commandCenter[0];

  appendStat(stats, 'Live holdings', String(liveHoldings));
  appendStat(stats, 'Permer', String(binderCount));
  appendStat(stats, 'Master set fullført', `${masterPercent}%`);
  appendStat(stats, 'Arbeidskø', String(items));
  root.appendChild(stats);

  const next = document.createElement('p');
  next.className = 'personal-workspace-summary__next';
  next.dataset['region'] = 'personal-workspace-summary-next';
  next.textContent =
    top !== undefined
      ? `Topp prioritet: ${top.title}`
      : 'Ingen oppgaver i kø.';
  root.appendChild(next);

  return root;
}

function appendStat(dl: HTMLDListElement, label: string, value: string): void {
  const dt = document.createElement('dt');
  dt.textContent = label;
  dl.appendChild(dt);
  const dd = document.createElement('dd');
  dd.textContent = value;
  dl.appendChild(dd);
}
