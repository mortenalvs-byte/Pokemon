// PR 25 — Master gap report view.
//
// Two display modes:
//   - No binder selected (#master-gap)        → binder selector +
//                                                dashboard summary chips
//   - Binder selected (#master-gap/<binderId>) → full per-binder report
//                                                with filter strip + table
//
// All writes go through PR 24's `assignHoldingToSlot` for the
// "Plasser" action; the existing assign modal handles "Velg holding"
// for ambiguous rows. The view itself never mutates user data outside
// those user-clicked actions.

import { buildAssignHoldingModal } from '../components/assign-holding-modal';
import { DIALOG_SUBMITTED_EVENT, openDialog } from '../components/dialog';
import {
  USER_DATA_CHANGED_EVENT,
  onUserDataChanged,
} from '../components/events';
import { buildWishlistForm } from '../components/wishlist-form';
import { getDb } from '../db/database';
import { STATUS_LABEL_NB } from '../domain/master-set-gap';
import type {
  MasterGapBinderSummary,
  MasterGapDashboardSummary,
  MasterGapReport,
  MasterGapRow,
  MasterGapStatus,
} from '../domain/master-set-gap';
import {
  nextViewDensity,
  viewDensityLabel,
  type ViewDensity,
} from '../domain/view-density';
import {
  getCurrentMasterGapBinderId,
  navigate,
  navigateToBinder,
  navigateToBinderSlot,
  navigateToCard,
  navigateToLot,
  navigateToMasterGapBinder,
} from '../router';
import { createBindersRepo } from '../repositories/binders-repo';
import { createBinderSlotsRepo } from '../repositories/binder-slots-repo';
import { createCardsRepo } from '../repositories/cards-repo';
import { createHoldingsRepo } from '../repositories/holdings-repo';
import { createLotItemsRepo } from '../repositories/lot-items-repo';
import { createSetsRepo } from '../repositories/sets-repo';
import { createWishlistRepo } from '../repositories/wishlist-repo';
import { assignHoldingToSlot } from '../services/binder-assignment-service';
import { createMasterSetGapService } from '../services/master-set-gap-service';
import { placeRecommendedForReport } from '../services/recommended-placement-service';
import { createPersonalPreferencesService } from '../services/personal-preferences-service';
import { createSettingsRepo } from '../repositories/settings-repo';
import type { CardFinish, SlotsPerPage } from '../domain/types';

// PR 25 row count cap per page in the report table. Same scale as
// Browse / Collection / Wishlist (default 50). Pagination state is
// kept on `state.tablePage` so pagination clicks reuse the cached
// report instead of re-fetching.
const TABLE_PAGE_SIZE = 50;

type RowFilter =
  | 'all'
  | 'missing'
  | 'owned_unplaced'
  | 'wishlist'
  | 'in_lot'
  | 'invalid';

const FILTER_LABELS: ReadonlyArray<{
  readonly value: RowFilter;
  readonly label: string;
}> = [
  { value: 'all', label: 'Alle' },
  { value: 'missing', label: 'Mangler' },
  { value: 'owned_unplaced', label: 'Eier, ikke plassert' },
  { value: 'wishlist', label: 'Ønsket / bestilt' },
  { value: 'in_lot', label: 'Lot' },
  { value: 'invalid', label: 'Feil' },
];

const FINISH_LABEL: Record<CardFinish, string> = {
  normal: 'Normal',
  holo: 'Holo',
  reverse_holo: 'Reverse holo',
  non_holo: 'Non-holo',
  stamped: 'Stamped',
  unknown: 'Ukjent',
};

interface ViewState {
  filter: RowFilter;
  tablePage: number;
  cachedReport: MasterGapReport | null;
  cachedBinderId: string | null;
  cachedDashboard: MasterGapDashboardSummary | null;
  // PR 26 — desktop polish toggles. PR 27 — values seed from
  // PersonalPreferences on mount and persist async on user change.
  density: ViewDensity;
  hideComplete: boolean;
  onlyActionable: boolean;
  // PR 27 — flips to true after the first preferences read so the
  // first render can display the user's saved choices instead of
  // hardcoded defaults.
  preferencesLoaded: boolean;
  /**
   * PR 28 — bulk-place-recommended summary line that survives the
   * re-render that follows a successful placement run. Cleared when
   * the user opens a new binder report.
   */
  lastBulkSummary: string | null;
}

// PR 26 — actionable predicate. Hides `complete` (already done) and
// `blank_slot` (no work owed). Used by the "Kun handling" toggle.
export function isActionableRow(row: MasterGapRow): boolean {
  return row.status !== 'complete' && row.status !== 'blank_slot';
}

export function mountMasterGapView(
  container: HTMLElement,
  signal?: AbortSignal,
): void {
  const state: ViewState = {
    filter: 'all',
    tablePage: 0,
    cachedReport: null,
    cachedBinderId: null,
    cachedDashboard: null,
    density: 'compact',
    hideComplete: false,
    onlyActionable: false,
    preferencesLoaded: false,
    lastBulkSummary: null,
  };
  // PR 27 — load persisted view preferences. We seed the state and
  // re-render so the first paint reflects the user's saved density /
  // hide-complete / only-actionable / default filter choices. The
  // load is best-effort: if it throws, the hardcoded defaults stand.
  void loadPersistedPreferences(state).then(() => {
    if (container.isConnected) void renderInto(container, state);
  });
  void renderInto(container, state);
  onUserDataChanged(() => {
    if (!container.isConnected) return;
    state.cachedReport = null;
    state.cachedDashboard = null;
    void renderInto(container, state);
  }, signal);
}

async function renderInto(
  container: HTMLElement,
  state: ViewState,
): Promise<void> {
  container.innerHTML = '';
  const root = document.createElement('section');
  root.className = 'master-gap-view';
  container.appendChild(root);

  const header = document.createElement('div');
  header.className = 'master-gap-view__header';
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'master-gap-view__back';
  back.dataset['action'] = 'back';
  back.textContent = '← Tilbake til Dashboard';
  back.addEventListener('click', () => navigate('dashboard'));
  header.appendChild(back);
  const title = document.createElement('h1');
  title.className = 'master-gap-view__title';
  title.textContent = 'Master gap report';
  header.appendChild(title);
  root.appendChild(header);

  const binderId = getCurrentMasterGapBinderId();
  if (binderId === null) {
    await renderSelectorMode(root, state);
    return;
  }
  await renderReportMode(root, state, container, binderId);
}

// ---------------------------------------------------------------------
// No binder selected — render binder selector + dashboard summary.

async function renderSelectorMode(
  root: HTMLElement,
  state: ViewState,
): Promise<void> {
  const loading = document.createElement('p');
  loading.className = 'master-gap-view__loading';
  loading.textContent = 'Laster master gap-oversikt …';
  root.appendChild(loading);

  let dashboard = state.cachedDashboard;
  if (dashboard === null) {
    try {
      dashboard = await buildDashboard();
      state.cachedDashboard = dashboard;
    } catch (caught) {
      loading.remove();
      root.appendChild(buildErrorPanel(caught));
      return;
    }
  }
  loading.remove();

  if (dashboard.binderCount === 0) {
    const empty = document.createElement('p');
    empty.className = 'master-gap-view__empty';
    empty.textContent =
      'Ingen permer ennå. Lag en perm under Permer for å se mangler.';
    root.appendChild(empty);
    return;
  }

  root.appendChild(buildDashboardSummaryStrip(dashboard));

  const selectorSection = document.createElement('section');
  selectorSection.className = 'master-gap-view__binders';
  const heading = document.createElement('h2');
  heading.className = 'master-gap-view__sub-heading';
  heading.textContent = 'Velg perm for full rapport';
  selectorSection.appendChild(heading);

  const list = document.createElement('ul');
  list.className = 'master-gap-view__binder-list';
  for (const summary of dashboard.binders) {
    list.appendChild(buildBinderRow(summary));
  }
  selectorSection.appendChild(list);
  root.appendChild(selectorSection);
}

function buildDashboardSummaryStrip(
  dashboard: MasterGapDashboardSummary,
): HTMLElement {
  const wrap = document.createElement('section');
  wrap.className = 'master-gap-view__summary-strip';
  wrap.dataset['region'] = 'dashboard-summary';

  const stats = document.createElement('dl');
  stats.className = 'master-gap-view__summary-stats';
  appendStat(stats, 'Snitt fullført', `${dashboard.averageCompletionPercent}%`);
  appendStat(stats, 'Mål-slots', String(dashboard.totalTargetSlots));
  appendStat(stats, 'Fullført', String(dashboard.complete));
  appendStat(stats, 'Mangler', String(dashboard.missing));
  appendStat(
    stats,
    'Eier, ikke plassert',
    String(dashboard.ownedUnplaced),
  );
  appendStat(stats, 'Ønsket', String(dashboard.wishlistWanted));
  appendStat(stats, 'Bestilt', String(dashboard.wishlistOrdered));
  appendStat(stats, 'I lot', String(dashboard.inLotUnmaterialized));
  appendStat(stats, 'Feil', String(dashboard.invalidCount));
  appendStat(
    stats,
    'Kan plasseres direkte',
    String(dashboard.canPlaceDirectlyCount),
  );
  wrap.appendChild(stats);

  if (dashboard.closestBinder !== null) {
    const close = document.createElement('p');
    close.className = 'master-gap-view__closest';
    close.textContent = `Nærmest komplett: ${dashboard.closestBinder.binderName} — ${dashboard.closestBinder.completionPercent}%`;
    wrap.appendChild(close);
  }
  if (dashboard.weakestBinder !== null) {
    const weak = document.createElement('p');
    weak.className = 'master-gap-view__weakest';
    weak.textContent = `Svakeste: ${dashboard.weakestBinder.binderName} — ${dashboard.weakestBinder.completionPercent}%`;
    wrap.appendChild(weak);
  }
  return wrap;
}

function buildBinderRow(summary: MasterGapBinderSummary): HTMLElement {
  const li = document.createElement('li');
  li.className = 'master-gap-view__binder-row';
  li.dataset['binderId'] = summary.binderId;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'master-gap-view__binder-name';
  button.textContent = summary.binderName;
  button.addEventListener('click', () =>
    navigateToMasterGapBinder(summary.binderId),
  );
  li.appendChild(button);

  const meta = document.createElement('span');
  meta.className = 'master-gap-view__binder-meta';
  const fragment = `${summary.complete} / ${summary.totalTargetSlots} fullført · ${summary.completionPercent}%`;
  const extras: string[] = [];
  if (summary.canPlaceDirectlyCount > 0) {
    extras.push(`${summary.canPlaceDirectlyCount} kan plasseres`);
  }
  if (summary.invalidAssignment + summary.invalidVariant > 0) {
    extras.push(
      `${summary.invalidAssignment + summary.invalidVariant} feil`,
    );
  }
  meta.textContent =
    extras.length > 0 ? `${fragment} · ${extras.join(' · ')}` : fragment;
  li.appendChild(meta);
  return li;
}

// ---------------------------------------------------------------------
// Binder selected — render full report.

async function renderReportMode(
  root: HTMLElement,
  state: ViewState,
  container: HTMLElement,
  binderId: string,
): Promise<void> {
  const loading = document.createElement('p');
  loading.className = 'master-gap-view__loading';
  loading.textContent = 'Bygger gap-rapport …';
  root.appendChild(loading);

  // PR 28 — opening a new binder clears the previous binder's bulk
  // summary so it doesn't bleed across reports.
  if (state.cachedBinderId !== null && state.cachedBinderId !== binderId) {
    state.lastBulkSummary = null;
  }
  let report =
    state.cachedReport !== null && state.cachedBinderId === binderId
      ? state.cachedReport
      : null;
  if (report === null) {
    try {
      report = await buildReport(binderId);
    } catch (caught) {
      loading.remove();
      root.appendChild(buildErrorPanel(caught));
      return;
    }
    state.cachedReport = report;
    state.cachedBinderId = binderId;
    state.tablePage = 0;
  }
  loading.remove();

  if (report === null) {
    const empty = document.createElement('p');
    empty.className = 'master-gap-view__empty';
    empty.textContent = 'Permen finnes ikke (eller er slettet).';
    root.appendChild(empty);
    return;
  }

  root.appendChild(buildBinderHeader(report.binder));
  // PR 28 — bulk-place button lives between the binder header and
  // the toolbar so it sits next to the per-binder counts but stays
  // above the filter strip.
  const bulkBar = document.createElement('div');
  bulkBar.className = 'master-gap-view__bulk-bar';
  bulkBar.dataset['region'] = 'bulk-recommended-bar';
  bulkBar.appendChild(buildBulkRecommendedButton(report, state, container));
  // Result summary slot (populated after bulk placement). The text
  // is stashed on `state.lastBulkSummary` so it survives the
  // re-render that follows a successful run.
  const summarySlot = document.createElement('div');
  summarySlot.dataset['region'] = 'bulk-recommended-summary';
  summarySlot.className = 'master-gap-view__bulk-summary';
  if (state.lastBulkSummary !== null) {
    const line = document.createElement('p');
    line.className = 'master-gap-view__bulk-summary-line';
    line.dataset['region'] = 'bulk-recommended-summary-line';
    line.textContent = state.lastBulkSummary;
    summarySlot.appendChild(line);
  }
  bulkBar.appendChild(summarySlot);
  root.appendChild(bulkBar);
  // PR 26 — sticky table toolbar wraps filter strip + density /
  // hide-complete / only-actionable toggles so they all live in one
  // visually-grouped strip above the table.
  root.appendChild(buildTableToolbar(state, container));
  root.appendChild(buildTable(report, state, container));
}

function buildBinderHeader(summary: MasterGapBinderSummary): HTMLElement {
  const header = document.createElement('header');
  header.className = 'master-gap-view__binder-header';
  const title = document.createElement('h2');
  title.className = 'master-gap-view__binder-title';
  title.textContent = summary.binderName;
  header.appendChild(title);

  const stats = document.createElement('dl');
  stats.className = 'master-gap-view__summary-stats';
  appendStat(
    stats,
    'Fullført',
    `${summary.complete} / ${summary.totalTargetSlots} (${summary.completionPercent}%)`,
  );
  appendStat(stats, 'Mangler', String(summary.missing));
  appendStat(
    stats,
    'Eier, ikke plassert',
    String(summary.ownedUnplaced),
  );
  appendStat(stats, 'Ønsket', String(summary.wishlistWanted));
  appendStat(stats, 'Bestilt', String(summary.wishlistOrdered));
  appendStat(stats, 'I lot', String(summary.inLotUnmaterialized));
  appendStat(
    stats,
    'Feil',
    String(summary.invalidAssignment + summary.invalidVariant),
  );
  appendStat(
    stats,
    'Kan plasseres',
    String(summary.canPlaceDirectlyCount),
  );
  header.appendChild(stats);

  const openBinder = document.createElement('button');
  openBinder.type = 'button';
  openBinder.className = 'master-gap-view__open-binder';
  openBinder.dataset['action'] = 'open-binder';
  openBinder.textContent = 'Åpne perm';
  openBinder.addEventListener('click', () => navigateToBinder(summary.binderId));
  header.appendChild(openBinder);
  return header;
}

// PR 28 — bulk-place-all-recommended button. Lives in the binder
// header strip alongside `Åpne perm`. Disabled (rendered as a
// disabled chip) when the current report has no safe
// recommendations, but always rendered so the test/UI surface is
// stable.
function buildBulkRecommendedButton(
  report: MasterGapReport,
  state: ViewState,
  container: HTMLElement,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'master-gap-view__bulk-recommended';
  button.dataset['action'] = 'place-all-recommended';
  const count = report.binder.recommendedAmbiguousCount;
  button.textContent =
    count > 0
      ? `Plasser alle anbefalte (${count})`
      : 'Plasser alle anbefalte';
  button.disabled = count === 0;
  if (count === 0) {
    button.title =
      'Ingen ambiguous_owned-rader har en deterministisk anbefaling akkurat nå.';
  }
  button.addEventListener('click', () => {
    void handleBulkPlaceRecommended(report, state, container);
  });
  return button;
}

function buildFilterStrip(
  state: ViewState,
  container: HTMLElement,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'master-gap-view__filter-strip';
  wrap.setAttribute('role', 'tablist');
  for (const opt of FILTER_LABELS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className =
      state.filter === opt.value
        ? 'master-gap-view__filter master-gap-view__filter--active'
        : 'master-gap-view__filter';
    btn.dataset['filter'] = opt.value;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', state.filter === opt.value ? 'true' : 'false');
    btn.textContent = opt.label;
    btn.addEventListener('click', () => {
      if (state.filter === opt.value) return;
      state.filter = opt.value;
      state.tablePage = 0;
      // PR 27 — only persist filter choices that map to a stored
      // PersonalPreferences default-filter value. Internal filters
      // beyond the documented set are skipped.
      void persistMasterGapPreference({ masterGapDefaultFilter: opt.value });
      void renderInto(container, state);
    });
    wrap.appendChild(btn);
  }
  return wrap;
}

// PR 27 — load + persist helpers. Both are best-effort: a settings
// store hiccup must NEVER break the master-gap view. The view falls
// back to the existing in-memory defaults if loading fails, and a
// failed persist surfaces in `data-region="master-gap-preferences-feedback"`
// when present (the dashboard doesn't render that region; the master
// gap report does).
async function loadPersistedPreferences(state: ViewState): Promise<void> {
  try {
    const svc = createPersonalPreferencesService(
      createSettingsRepo(getDb()),
    );
    const prefs = await svc.getPreferences();
    state.density = prefs.masterGapDensity;
    state.hideComplete = prefs.masterGapHideComplete;
    state.onlyActionable = prefs.masterGapOnlyActionable;
    state.filter = prefs.masterGapDefaultFilter;
  } catch {
    // Defaults stand.
  } finally {
    state.preferencesLoaded = true;
  }
}

async function persistMasterGapPreference(
  patch: Partial<{
    masterGapDensity: ViewDensity;
    masterGapHideComplete: boolean;
    masterGapOnlyActionable: boolean;
    masterGapDefaultFilter: RowFilter;
  }>,
): Promise<void> {
  try {
    const svc = createPersonalPreferencesService(
      createSettingsRepo(getDb()),
    );
    await svc.updatePreferences(patch);
  } catch {
    // Surface in feedback if the master-gap view exposes one; never
    // throw out of a click handler.
    const feedback = document.querySelector<HTMLElement>(
      '[data-region="master-gap-preferences-feedback"]',
    );
    if (feedback !== null) {
      feedback.textContent = 'Kunne ikke lagre personlig valg.';
      feedback.classList.add('master-gap-view__feedback--error');
    }
  }
}

// PR 26 — sticky table toolbar. Hosts the existing filter strip plus
// the new density / hide-complete / only-actionable toggles. None of
// these touch the cached report — they only flip view state and
// re-render. `tablePage` resets to 0 on filter / hide-complete /
// only-actionable changes so the user lands on the new first page.
// Density is purely cosmetic (padding/font-size) so it preserves
// the page.
function buildTableToolbar(
  state: ViewState,
  container: HTMLElement,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'master-gap-view__table-toolbar';
  wrap.dataset['region'] = 'table-toolbar';

  wrap.appendChild(buildFilterStrip(state, container));

  const toggles = document.createElement('div');
  toggles.className = 'master-gap-view__toggles';

  // Density toggle.
  const density = document.createElement('button');
  density.type = 'button';
  density.className = 'master-gap-view__density-toggle';
  density.dataset['action'] = 'toggle-density';
  density.dataset['density'] = state.density;
  density.textContent = `Tetthet: ${viewDensityLabel(state.density)}`;
  density.addEventListener('click', () => {
    state.density = nextViewDensity(state.density);
    void persistMasterGapPreference({ masterGapDensity: state.density });
    void renderInto(container, state);
  });
  toggles.appendChild(density);

  // Hide complete toggle.
  const hideComplete = document.createElement('button');
  hideComplete.type = 'button';
  hideComplete.className = state.hideComplete
    ? 'master-gap-view__toggle master-gap-view__toggle--active'
    : 'master-gap-view__toggle';
  hideComplete.dataset['action'] = 'toggle-hide-complete';
  hideComplete.setAttribute(
    'aria-pressed',
    state.hideComplete ? 'true' : 'false',
  );
  hideComplete.textContent = 'Skjul fullførte';
  hideComplete.addEventListener('click', () => {
    state.hideComplete = !state.hideComplete;
    state.tablePage = 0;
    void persistMasterGapPreference({
      masterGapHideComplete: state.hideComplete,
    });
    void renderInto(container, state);
  });
  toggles.appendChild(hideComplete);

  // Only actionable toggle.
  const onlyActionable = document.createElement('button');
  onlyActionable.type = 'button';
  onlyActionable.className = state.onlyActionable
    ? 'master-gap-view__toggle master-gap-view__toggle--active'
    : 'master-gap-view__toggle';
  onlyActionable.dataset['action'] = 'toggle-only-actionable';
  onlyActionable.setAttribute(
    'aria-pressed',
    state.onlyActionable ? 'true' : 'false',
  );
  onlyActionable.textContent = 'Kun handling';
  onlyActionable.addEventListener('click', () => {
    state.onlyActionable = !state.onlyActionable;
    state.tablePage = 0;
    void persistMasterGapPreference({
      masterGapOnlyActionable: state.onlyActionable,
    });
    void renderInto(container, state);
  });
  toggles.appendChild(onlyActionable);

  wrap.appendChild(toggles);

  // Optional feedback line for failed prefs persists.
  const feedback = document.createElement('p');
  feedback.className = 'master-gap-view__feedback';
  feedback.dataset['region'] = 'master-gap-preferences-feedback';
  feedback.setAttribute('aria-live', 'polite');
  wrap.appendChild(feedback);

  return wrap;
}

function buildTable(
  report: MasterGapReport,
  state: ViewState,
  container: HTMLElement,
): HTMLElement {
  const wrap = document.createElement('section');
  wrap.className = 'master-gap-view__table-wrap';
  wrap.dataset['region'] = 'gap-table';

  // PR 26 — filtering order:
  //   1. base status filter (PR 25)
  //   2. hideComplete (drop only `complete`)
  //   3. onlyActionable (drop `complete` + `blank_slot`)
  //   4. pagination
  // hideComplete and onlyActionable compose: `onlyActionable` is the
  // stricter of the two, so they coexist without contradiction.
  const filtered = report.rows
    .filter((row) => rowMatchesFilter(row, state.filter))
    .filter((row) => (state.hideComplete ? row.status !== 'complete' : true))
    .filter((row) => (state.onlyActionable ? isActionableRow(row) : true));
  if (filtered.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'master-gap-view__empty';
    empty.textContent =
      state.filter === 'all'
        ? 'Ingen rader. Permen har ingen target-slots.'
        : 'Ingen rader matcher filteret.';
    wrap.appendChild(empty);
    return wrap;
  }

  const totalPages = Math.max(1, Math.ceil(filtered.length / TABLE_PAGE_SIZE));
  if (state.tablePage >= totalPages) {
    state.tablePage = totalPages - 1;
  }
  const start = state.tablePage * TABLE_PAGE_SIZE;
  const end = Math.min(start + TABLE_PAGE_SIZE, filtered.length);
  const pageRows = filtered.slice(start, end);

  const counts = document.createElement('p');
  counts.className = 'master-gap-view__counts';
  counts.textContent = `Side ${state.tablePage + 1} av ${totalPages} · ${filtered.length} rader`;
  wrap.appendChild(counts);

  const table = document.createElement('table');
  // PR 26 — density class drives compact vs comfortable padding /
  // font-size in CSS. Always emit one of the two so the styles are
  // deterministic.
  table.className =
    state.density === 'compact'
      ? 'master-gap-table master-gap-table--compact'
      : 'master-gap-table master-gap-table--comfortable';
  const thead = document.createElement('thead');
  thead.innerHTML = `
    <tr>
      <th>Side</th>
      <th>Kort</th>
      <th>Set</th>
      <th>Finish</th>
      <th>Status</th>
      <th>Reason</th>
      <th>Handlinger</th>
    </tr>
  `;
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  for (const row of pageRows) {
    tbody.appendChild(buildRow(row, container, state));
  }
  table.appendChild(tbody);
  wrap.appendChild(table);

  if (totalPages > 1) {
    wrap.appendChild(buildPagination(totalPages, state, container));
  }
  return wrap;
}

function buildPagination(
  totalPages: number,
  state: ViewState,
  container: HTMLElement,
): HTMLElement {
  const nav = document.createElement('nav');
  nav.className = 'master-gap-view__pagination';
  const prev = document.createElement('button');
  prev.type = 'button';
  prev.dataset['action'] = 'prev-page';
  prev.textContent = '← Forrige';
  prev.disabled = state.tablePage === 0;
  prev.addEventListener('click', () => {
    if (state.tablePage === 0) return;
    state.tablePage -= 1;
    void renderInto(container, state);
  });
  nav.appendChild(prev);
  const next = document.createElement('button');
  next.type = 'button';
  next.dataset['action'] = 'next-page';
  next.textContent = 'Neste →';
  next.disabled = state.tablePage >= totalPages - 1;
  next.addEventListener('click', () => {
    if (state.tablePage >= totalPages - 1) return;
    state.tablePage += 1;
    void renderInto(container, state);
  });
  nav.appendChild(next);
  return nav;
}

function buildRow(
  row: MasterGapRow,
  container: HTMLElement,
  state: ViewState,
): HTMLTableRowElement {
  const tr = document.createElement('tr');
  tr.className = `master-gap-row master-gap-row--${row.severity}`;
  tr.dataset['slotId'] = row.slotId;
  tr.dataset['status'] = row.status;

  const slotCell = document.createElement('td');
  slotCell.textContent = `${row.pageNumber}.${row.slotNumber}`;
  tr.appendChild(slotCell);

  const cardCell = document.createElement('td');
  if (row.cardName !== null && row.cardId !== null) {
    cardCell.textContent = `${row.cardName}${row.cardNumber !== null ? ` #${row.cardNumber}` : ''}`;
  } else if (row.cardId !== null) {
    cardCell.textContent = row.cardId;
  } else {
    cardCell.textContent = '–';
  }
  tr.appendChild(cardCell);

  const setCell = document.createElement('td');
  setCell.textContent = row.setName ?? row.setId ?? '–';
  tr.appendChild(setCell);

  const finishCell = document.createElement('td');
  finishCell.textContent =
    row.required.finish !== null ? FINISH_LABEL[row.required.finish] : '–';
  tr.appendChild(finishCell);

  const statusCell = document.createElement('td');
  const chip = document.createElement('span');
  chip.className = `status-chip status-chip--${severityChipClass(row.severity)}`;
  chip.textContent = STATUS_LABEL_NB[row.status];
  statusCell.appendChild(chip);
  tr.appendChild(statusCell);

  const reasonCell = document.createElement('td');
  reasonCell.textContent = row.reason;
  // PR 28 — best-copy recommendation overlay. Only shown for
  // ambiguous rows; otherwise the reason cell stays untouched.
  if (row.status === 'ambiguous_owned') {
    reasonCell.appendChild(buildRecommendationOverlay(row));
  }
  tr.appendChild(reasonCell);

  const actionsCell = document.createElement('td');
  actionsCell.className = 'master-gap-row__actions';
  for (const action of buildActions(row, container, state)) {
    actionsCell.appendChild(action);
  }
  tr.appendChild(actionsCell);
  return tr;
}

function buildActions(
  row: MasterGapRow,
  container: HTMLElement,
  state: ViewState,
): HTMLElement[] {
  const out: HTMLElement[] = [];
  if (row.cardId !== null) {
    const openCard = makeAction('Åpne kort', 'open-card', () =>
      navigateToCard(row.cardId as string),
    );
    out.push(openCard);
  }
  out.push(
    makeAction('Gå til slot', 'go-to-slot', () =>
      navigateToBinderSlot(row.binderId, row.slotId),
    ),
  );
  if (row.status === 'missing' && row.cardId !== null) {
    out.push(
      makeAction('Legg i ønskeliste', 'add-wishlist', () => {
        void openDialog(buildWishlistForm({ mode: 'add', cardId: row.cardId as string }));
      }),
    );
  }
  if (row.status === 'owned_unplaced' && row.canPlaceDirectly) {
    out.push(
      makeAction(
        'Plasser',
        'place-direct',
        () => {
          void handlePlaceDirect(row, container, state);
        },
        true,
      ),
    );
  }
  if (row.status === 'ambiguous_owned') {
    // PR 28 — recommend the best copy when scoring picks a unique
    // winner; otherwise the row stays manual-only. The button uses
    // PR 24's `assignHoldingToSlot` via handlePlaceRecommended; we
    // never go around it.
    if (
      row.bestCopyRecommendation?.status === 'recommended' &&
      row.bestCopyRecommendation.recommendedHoldingId !== null
    ) {
      out.push(
        makeAction(
          'Plasser anbefalt',
          'place-recommended',
          () => {
            void handlePlaceRecommended(row, container, state);
          },
          true,
        ),
      );
    }
    out.push(
      makeAction('Velg holding', 'choose-holding', () => {
        void handleChooseHolding(row, container, state);
      }),
    );
  }
  if (
    (row.status === 'wishlist_wanted' || row.status === 'wishlist_ordered') &&
    row.cardId !== null
  ) {
    out.push(
      makeAction('Åpne wishlist', 'open-wishlist', () => navigate('wishlist')),
    );
  }
  if (
    row.status === 'in_lot_unmaterialized' &&
    row.unmaterializedLotItemIds.length > 0
  ) {
    const itemId = row.unmaterializedLotItemIds[0];
    if (itemId !== undefined) {
      out.push(
        makeAction('Åpne lot', 'open-lot', () => {
          void openLotForItem(itemId);
        }),
      );
    }
  }
  return out;
}

function makeAction(
  label: string,
  actionName: string,
  onClick: () => void,
  isPrimary = false,
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = isPrimary
    ? 'master-gap-row__action master-gap-row__action--primary'
    : 'master-gap-row__action';
  btn.dataset['action'] = actionName;
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}

async function handlePlaceDirect(
  row: MasterGapRow,
  container: HTMLElement,
  state: ViewState,
): Promise<void> {
  const holdingId = row.matchingUnplacedHoldingIds[0];
  if (holdingId === undefined) return;
  const db = getDb();
  const slotsRepo = createBinderSlotsRepo(db);
  const bindersRepo = createBindersRepo(db);
  const holdingsRepo = createHoldingsRepo(db);
  const cardsRepo = createCardsRepo(db);
  const slot = await slotsRepo.get(row.slotId);
  if (slot === undefined) return;
  const holding = await holdingsRepo.get(holdingId);
  if (holding === undefined) return;
  const binder = await bindersRepo.get(row.binderId);
  if (binder === undefined) return;
  try {
    await assignHoldingToSlot(
      { bindersRepo, binderSlotsRepo: slotsRepo, holdingsRepo, cardsRepo },
      slot,
      holding,
      binder.slotsPerPage as SlotsPerPage,
    );
  } catch (caught) {
    // Surface the error inline; the cached report stays so the user can
    // see what went wrong.
    const message =
      caught instanceof Error
        ? caught.message
        : 'Plassering feilet uten melding.';
    alert(`Kunne ikke plassere holdingen: ${message}`);
    return;
  }
  state.cachedReport = null;
  state.cachedDashboard = null;
  window.dispatchEvent(new CustomEvent(USER_DATA_CHANGED_EVENT));
  void renderInto(container, state);
}

// PR 28 — recommendation overlay rendered inside the reason cell of
// ambiguous rows. The text is purely informational; the actual
// "Plasser anbefalt" button is built in `buildActions`.
function buildRecommendationOverlay(row: MasterGapRow): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'master-gap-row__recommendation';
  wrap.dataset['region'] = 'best-copy-recommendation';
  const rec = row.bestCopyRecommendation;
  if (rec === null) {
    wrap.classList.add('master-gap-row__recommendation--missing');
    wrap.textContent = 'Ingen anbefaling tilgjengelig.';
    return wrap;
  }
  if (rec.status === 'no_candidates') {
    wrap.classList.add('master-gap-row__recommendation--no-candidates');
    wrap.textContent = 'Ingen kandidat funnet — oppdater eller velg manuelt.';
    return wrap;
  }
  if (rec.status === 'manual_required') {
    wrap.classList.add('master-gap-row__recommendation--manual');
    wrap.textContent = 'Ingen trygg anbefaling — velg manuelt.';
    return wrap;
  }
  // recommended
  wrap.classList.add('master-gap-row__recommendation--recommended');
  const heading = document.createElement('p');
  heading.className = 'master-gap-row__recommendation-heading';
  heading.textContent =
    rec.score !== null
      ? `Anbefalt kopi · score ${rec.score}`
      : 'Anbefalt kopi';
  wrap.appendChild(heading);
  if (rec.reasons.length > 0) {
    const list = document.createElement('ul');
    list.className = 'master-gap-row__recommendation-reasons';
    for (const reason of rec.reasons.slice(0, 4)) {
      const li = document.createElement('li');
      li.textContent = reason;
      list.appendChild(li);
    }
    wrap.appendChild(list);
  }
  return wrap;
}

async function handleBulkPlaceRecommended(
  report: MasterGapReport,
  state: ViewState,
  container: HTMLElement,
): Promise<void> {
  const safeCount = report.binder.recommendedAmbiguousCount;
  if (safeCount === 0) return;

  const confirmed = await openDialog({
    mount(host, close) {
      const wrap = document.createElement('section');
      wrap.className = 'master-gap-bulk-confirm';
      const heading = document.createElement('h2');
      heading.textContent = 'Plasser anbefalte';
      wrap.appendChild(heading);
      const body = document.createElement('p');
      body.textContent = `${safeCount} rader har én trygg anbefaling og blir plassert. Uklare valg hoppes over.`;
      wrap.appendChild(body);
      const actions = document.createElement('div');
      actions.className = 'master-gap-bulk-confirm__actions';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.dataset['action'] = 'bulk-cancel';
      cancel.textContent = 'Avbryt';
      cancel.addEventListener('click', () => close());
      const confirm = document.createElement('button');
      confirm.type = 'button';
      confirm.className = 'master-gap-bulk-confirm__confirm';
      confirm.dataset['action'] = 'bulk-confirm';
      confirm.textContent = 'Plasser anbefalte';
      confirm.addEventListener('click', () => {
        // PR 32 — was the inline string `'dialog:submitted'`, now uses
        // the registry constant. Same dispatched event, same listeners.
        wrap.dispatchEvent(
          new CustomEvent(DIALOG_SUBMITTED_EVENT, { bubbles: true }),
        );
      });
      actions.appendChild(cancel);
      actions.appendChild(confirm);
      wrap.appendChild(actions);
      host.appendChild(wrap);
    },
  });
  if (confirmed !== 'submitted') return;

  const db = getDb();
  const result = await placeRecommendedForReport({
    report,
    deps: {
      bindersRepo: createBindersRepo(db),
      binderSlotsRepo: createBinderSlotsRepo(db),
      holdingsRepo: createHoldingsRepo(db),
      cardsRepo: createCardsRepo(db),
    },
  });

  // Stash the summary on view state so it survives the re-render
  // triggered by `state.cachedReport = null` below.
  const skipped =
    result.skippedManualRequired + result.skippedNoRecommendation;
  state.lastBulkSummary =
    `${result.placed.length} plassert · ` +
    `${skipped} hoppet over — manuell vurdering kreves · ` +
    `${result.failed.length} feilet`;

  if (result.placed.length > 0) {
    state.cachedReport = null;
    state.cachedDashboard = null;
    window.dispatchEvent(new CustomEvent(USER_DATA_CHANGED_EVENT));
  }
  void renderInto(container, state);
}

async function handlePlaceRecommended(
  row: MasterGapRow,
  container: HTMLElement,
  state: ViewState,
): Promise<void> {
  const rec = row.bestCopyRecommendation;
  if (rec === null || rec.status !== 'recommended' || rec.recommendedHoldingId === null) {
    return;
  }
  const db = getDb();
  const slotsRepo = createBinderSlotsRepo(db);
  const bindersRepo = createBindersRepo(db);
  const holdingsRepo = createHoldingsRepo(db);
  const cardsRepo = createCardsRepo(db);
  const slot = await slotsRepo.get(row.slotId);
  if (slot === undefined) return;
  const holding = await holdingsRepo.get(rec.recommendedHoldingId);
  if (holding === undefined) return;
  const binder = await bindersRepo.get(row.binderId);
  if (binder === undefined) return;
  try {
    await assignHoldingToSlot(
      { bindersRepo, binderSlotsRepo: slotsRepo, holdingsRepo, cardsRepo },
      slot,
      holding,
      binder.slotsPerPage as SlotsPerPage,
    );
  } catch (caught) {
    const message =
      caught instanceof Error
        ? caught.message
        : 'Plassering feilet uten melding.';
    alert(`Kunne ikke plassere anbefalt holding: ${message}`);
    return;
  }
  state.cachedReport = null;
  state.cachedDashboard = null;
  window.dispatchEvent(new CustomEvent(USER_DATA_CHANGED_EVENT));
  void renderInto(container, state);
}

async function handleChooseHolding(
  row: MasterGapRow,
  container: HTMLElement,
  state: ViewState,
): Promise<void> {
  const db = getDb();
  const slotsRepo = createBinderSlotsRepo(db);
  const bindersRepo = createBindersRepo(db);
  const slot = await slotsRepo.get(row.slotId);
  if (slot === undefined) return;
  const binder = await bindersRepo.get(row.binderId);
  if (binder === undefined) return;
  const modal = buildAssignHoldingModal({
    slot,
    slotsPerPage: binder.slotsPerPage as SlotsPerPage,
  });
  void openDialog(modal).then(() => {
    state.cachedReport = null;
    state.cachedDashboard = null;
    void renderInto(container, state);
  });
}

async function openLotForItem(lotItemId: string): Promise<void> {
  const db = getDb();
  const lotItem = await createLotItemsRepo(db).get(lotItemId);
  if (lotItem === undefined) return;
  navigateToLot(lotItem.lotId);
}

function rowMatchesFilter(row: MasterGapRow, filter: RowFilter): boolean {
  if (filter === 'all') return row.status !== 'blank_slot';
  if (filter === 'missing') {
    return row.status === 'missing' || row.status === 'unverified_variant_data';
  }
  if (filter === 'owned_unplaced') {
    return row.status === 'owned_unplaced' || row.status === 'ambiguous_owned';
  }
  if (filter === 'wishlist') {
    return (
      row.status === 'wishlist_wanted' || row.status === 'wishlist_ordered'
    );
  }
  if (filter === 'in_lot') return row.status === 'in_lot_unmaterialized';
  if (filter === 'invalid') {
    return (
      row.status === 'invalid_assignment' || row.status === 'invalid_variant'
    );
  }
  return true;
}

function severityChipClass(
  severity: MasterGapRow['severity'],
): 'success' | 'info' | 'warning' | 'danger' {
  switch (severity) {
    case 'ok':
      return 'success';
    case 'info':
      return 'info';
    case 'warning':
      return 'warning';
    case 'critical':
      return 'danger';
  }
}

function appendStat(
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

function buildErrorPanel(caught: unknown): HTMLElement {
  const wrap = document.createElement('section');
  wrap.className = 'master-gap-view__error';
  const heading = document.createElement('h2');
  heading.textContent = 'Kunne ikke laste gap-rapport';
  wrap.appendChild(heading);
  const message = document.createElement('p');
  message.textContent =
    caught instanceof Error
      ? `Feil: ${caught.message}`
      : 'En ukjent feil hindret innhenting av data.';
  wrap.appendChild(message);
  return wrap;
}

// ---------------------------------------------------------------------
// Service builders

async function buildDashboard(): Promise<MasterGapDashboardSummary> {
  const db = getDb();
  return createMasterSetGapService({
    bindersRepo: createBindersRepo(db),
    binderSlotsRepo: createBinderSlotsRepo(db),
    cardsRepo: createCardsRepo(db),
    setsRepo: createSetsRepo(db),
    holdingsRepo: createHoldingsRepo(db),
    wishlistRepo: createWishlistRepo(db),
    lotItemsRepo: createLotItemsRepo(db),
  }).buildDashboardSummary();
}

async function buildReport(
  binderId: string,
): Promise<MasterGapReport | null> {
  const db = getDb();
  return createMasterSetGapService({
    bindersRepo: createBindersRepo(db),
    binderSlotsRepo: createBinderSlotsRepo(db),
    cardsRepo: createCardsRepo(db),
    setsRepo: createSetsRepo(db),
    holdingsRepo: createHoldingsRepo(db),
    wishlistRepo: createWishlistRepo(db),
    lotItemsRepo: createLotItemsRepo(db),
  }).buildBinderReport(binderId);
}

// Re-export the canonical filter type for tests.
export type { RowFilter };

// Re-export Master gap statuses for use in the Card Status panel etc.
export type { MasterGapStatus };
