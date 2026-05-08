// Dashboard MVP. Read-only control panel over the existing database.
// Renders the seven sections from DASHBOARD_SPEC plus an action strip
// at the top for warning + critical items. Refreshes on
// USER_DATA_CHANGED_EVENT and SYNC_STATUS_CHANGED_EVENT (the same
// events the rest of the app already dispatches), with the standard
// `isConnected` guard.
//
// The dashboard never writes to user-owned stores. The "Eksporter"
// buttons trigger CSV builds via `mvp-csv-export`, hand the content
// to `downloadTextFile`, then write a single audit row through the
// exporter's `recordCsvExported` (audit-only rw-transaction). All
// other actions are pure navigation links.

import { onUserDataChanged } from '../components/events';
import { buildPersonalWorkspaceSummary } from '../components/personal-workspace-summary';
import { getDb } from '../db/database';
import {
  filterStripItems,
  type ActionItem,
  type ActionSeverity,
} from '../domain/dashboard-actions';
import type { MasterGapDashboardSummary } from '../domain/master-set-gap';
import {
  DEFAULT_PERSONAL_PREFERENCES,
  type PersonalPreferences,
} from '../domain/personal-preferences';
import { createAppMetaRepo } from '../repositories/app-meta-repo';
import { createBindersRepo } from '../repositories/binders-repo';
import { createBinderSlotsRepo } from '../repositories/binder-slots-repo';
import { createCardsRepo } from '../repositories/cards-repo';
import { createHoldingsRepo } from '../repositories/holdings-repo';
import { createLotItemsRepo } from '../repositories/lot-items-repo';
import { createLotsRepo } from '../repositories/lots-repo';
import { createSetsRepo } from '../repositories/sets-repo';
import { createSettingsRepo } from '../repositories/settings-repo';
import { createWishlistRepo } from '../repositories/wishlist-repo';
import {
  navigate,
  navigateToBinder,
  navigateToCard,
  navigateToMasterGap,
  navigateToMasterGapBinder,
} from '../router';
import {
  buildCommandCenterItems,
  type CommandCenterItem,
  type CommandCenterItemSeverity,
} from '../services/command-center-service';
import { createMasterSetGapService } from '../services/master-set-gap-service';
import { createPersonalPreferencesService } from '../services/personal-preferences-service';
import {
  createDashboardService,
  type BindersSection,
  type DashboardSnapshot,
} from '../services/dashboard-service';
import {
  createMvpCsvExporter,
  type MvpCsvKind,
} from '../services/mvp-csv-export';
import { downloadTextFile } from '../utils/download';
import { SYNC_STATUS_CHANGED_EVENT } from './settings';
import type { SidebarRoute } from '../router';

const SEVERITY_CHIP_CLASS: Record<ActionSeverity, string> = {
  critical: 'status-chip status-chip--danger',
  warning: 'status-chip status-chip--warning',
  info: 'status-chip status-chip--info',
};

export function mountDashboardView(
  container: HTMLElement,
  signal?: AbortSignal,
): void {
  void renderInto(container);
  const refresh = (): void => {
    if (!container.isConnected) return;
    void renderInto(container);
  };
  // PR 15A — F-3: pass `signal` so the router can drop these listeners
  // when the route changes. Without this they accumulated on `window`
  // and re-rendered into the shared `<main>` after the next view took
  // over.
  onUserDataChanged(refresh, signal);
  if (signal !== undefined) {
    window.addEventListener(SYNC_STATUS_CHANGED_EVENT, refresh, { signal });
  } else {
    window.addEventListener(SYNC_STATUS_CHANGED_EVENT, refresh);
  }
}

async function renderInto(container: HTMLElement): Promise<void> {
  container.innerHTML = '';
  const root = document.createElement('section');
  root.className = 'dashboard-view';
  container.appendChild(root);

  const heading = document.createElement('h1');
  heading.className = 'dashboard-view__heading';
  heading.textContent = 'Dashboard';
  root.appendChild(heading);

  // PR 26 — workspace header. Short, no marketing language; just
  // tells the user what this dashboard is so the eye knows where to
  // look next.
  const workspace = document.createElement('p');
  workspace.className = 'dashboard-view__workspace';
  workspace.dataset['region'] = 'dashboard-workspace';
  workspace.textContent =
    'Kontrollrom for samling, permer, master set og backup.';
  root.appendChild(workspace);

  const loading = document.createElement('p');
  loading.className = 'dashboard-view__loading';
  loading.dataset['region'] = 'loading';
  loading.textContent = 'Laster …';
  root.appendChild(loading);

  let snapshot: DashboardSnapshot;
  try {
    snapshot = await buildSnapshot();
  } catch (caught) {
    loading.remove();
    root.appendChild(buildErrorPanel(caught));
    return;
  }
  loading.remove();

  root.appendChild(buildActionStrip(snapshot));

  // PR 27 — command center + personal workspace summary. Both are
  // lazy-fed: scaffold paints first, the master-gap summary populates
  // them when it resolves so the main dashboard render stays fast.
  const commandCenter = buildCommandCenterSkeleton();
  root.appendChild(commandCenter);
  const personalSummarySlot = document.createElement('div');
  personalSummarySlot.dataset['region'] = 'personal-workspace-summary-slot';
  root.appendChild(personalSummarySlot);

  const grid = document.createElement('div');
  grid.className = 'dashboard-view__grid';
  grid.appendChild(buildDatabaseHealthCard(snapshot));
  grid.appendChild(buildSyncCard(snapshot));
  grid.appendChild(buildBackupCard(snapshot));
  grid.appendChild(buildCollectionCard(snapshot));
  grid.appendChild(buildBindersCard(snapshot));
  // PR 25 — Master Set Progress card. Lazy-loaded so the main snapshot
  // (which only walks `count()` for cards/sets) stays light. The card
  // renders a skeleton, then runs the gap service in the background.
  const masterGapCard = buildMasterGapCardSkeleton();
  grid.appendChild(masterGapCard);
  void populateMasterGapCard(masterGapCard, {
    snapshot,
    commandCenter,
    personalSummarySlot,
  });
  grid.appendChild(buildLotsCard(snapshot));
  grid.appendChild(buildWishlistCard(snapshot));
  root.appendChild(grid);
}

async function buildSnapshot(): Promise<DashboardSnapshot> {
  const db = getDb();
  const service = createDashboardService({
    appMetaRepo: createAppMetaRepo(db),
    cardsRepo: createCardsRepo(db),
    setsRepo: createSetsRepo(db),
    holdingsRepo: createHoldingsRepo(db),
    bindersRepo: createBindersRepo(db),
    binderSlotsRepo: createBinderSlotsRepo(db),
    lotsRepo: createLotsRepo(db),
    lotItemsRepo: createLotItemsRepo(db),
    wishlistRepo: createWishlistRepo(db),
  });
  return service.buildSnapshot();
}

function buildErrorPanel(caught: unknown): HTMLElement {
  const wrap = document.createElement('section');
  wrap.className = 'dashboard-view__error';
  wrap.dataset['region'] = 'error';
  const heading = document.createElement('h2');
  heading.textContent = 'Kunne ikke laste dashboard';
  wrap.appendChild(heading);
  const message = document.createElement('p');
  message.textContent =
    caught instanceof Error
      ? `Feil: ${caught.message}`
      : 'En ukjent feil hindret innhenting av data.';
  wrap.appendChild(message);
  const recovery = document.createElement('p');
  recovery.textContent =
    'Samlingen din er trygg. Gå til Backup og eksporter en sikkerhetskopi, deretter til Innstillinger for å sjekke databasestatus.';
  wrap.appendChild(recovery);
  const actions = document.createElement('div');
  actions.className = 'dashboard-view__error-actions';
  actions.appendChild(navButton('Til Backup', 'backup'));
  actions.appendChild(navButton('Til Innstillinger', 'settings'));
  wrap.appendChild(actions);
  return wrap;
}

// ---------------------------------------------------------------------
// Action strip

function buildActionStrip(snapshot: DashboardSnapshot): HTMLElement {
  const strip = document.createElement('section');
  strip.className = 'dashboard-strip';
  strip.dataset['region'] = 'action-strip';

  const items = filterStripItems(snapshot.actions);
  if (items.length === 0) {
    strip.classList.add('dashboard-strip--empty');
    const ok = document.createElement('p');
    ok.className = 'dashboard-strip__ok';
    ok.textContent = 'Ingenting krever oppmerksomhet akkurat nå.';
    strip.appendChild(ok);
    return strip;
  }

  const heading = document.createElement('h2');
  heading.className = 'dashboard-strip__heading';
  heading.textContent = `${items.length} sak${items.length === 1 ? '' : 'er'} krever oppmerksomhet`;
  strip.appendChild(heading);

  const list = document.createElement('ul');
  list.className = 'dashboard-strip__list';
  for (const item of items) {
    list.appendChild(buildActionItem(item));
  }
  strip.appendChild(list);
  return strip;
}

function buildActionItem(item: ActionItem): HTMLElement {
  const li = document.createElement('li');
  li.className = `dashboard-strip__item dashboard-strip__item--${item.severity}`;
  li.dataset['actionId'] = item.id;
  li.dataset['severity'] = item.severity;

  const chip = document.createElement('span');
  chip.className = SEVERITY_CHIP_CLASS[item.severity];
  chip.textContent = item.severity === 'critical' ? 'critical' : 'warning';
  li.appendChild(chip);

  const body = document.createElement('div');
  body.className = 'dashboard-strip__item-body';
  const title = document.createElement('p');
  title.className = 'dashboard-strip__item-title';
  title.textContent = item.title;
  body.appendChild(title);
  const message = document.createElement('p');
  message.className = 'dashboard-strip__item-message';
  message.textContent = item.message;
  body.appendChild(message);
  li.appendChild(body);

  if (item.goTo !== undefined) {
    li.appendChild(navButton('Gå til', item.goTo));
  }
  return li;
}

// ---------------------------------------------------------------------
// Section cards

function buildDatabaseHealthCard(snapshot: DashboardSnapshot): HTMLElement {
  const card = sectionCard('Database Health', 'database-health', 'settings');
  const stats = document.createElement('dl');
  stats.className = 'dashboard-card__stats';
  appendStat(stats, 'Schema version', snapshot.databaseHealth.schemaVersion === null ? '–' : `v${snapshot.databaseHealth.schemaVersion}`);
  appendStat(
    stats,
    'Persistent storage',
    snapshot.databaseHealth.persistentStorageGranted ? 'innvilget' : 'ikke innvilget',
  );
  appendStat(stats, 'Card cache', String(snapshot.databaseHealth.cardCacheCount));
  appendStat(stats, 'Set cache', String(snapshot.databaseHealth.setCacheCount));
  appendStat(stats, 'Live holdings', String(snapshot.databaseHealth.liveHoldingsCount));
  appendStat(stats, 'Live binders', String(snapshot.databaseHealth.liveBindersCount));
  appendStat(stats, 'Live lots', String(snapshot.databaseHealth.liveLotsCount));
  card.appendChild(stats);
  return card;
}

function buildSyncCard(snapshot: DashboardSnapshot): HTMLElement {
  const card = sectionCard('Sync', 'sync', 'settings');
  const stats = document.createElement('dl');
  stats.className = 'dashboard-card__stats';
  appendStat(
    stats,
    'Siste sync',
    snapshot.sync.lastSyncAt === null
      ? 'aldri'
      : snapshot.sync.lastSyncAt.slice(0, 10),
  );
  appendStat(
    stats,
    'Status',
    snapshot.sync.lastSyncStatus === null ? '–' : snapshot.sync.lastSyncStatus,
  );
  appendStat(stats, 'Cards', String(snapshot.sync.cardCacheCount));
  appendStat(stats, 'Sets', String(snapshot.sync.setCacheCount));
  card.appendChild(stats);
  if (snapshot.sync.lastSyncError !== null) {
    const err = document.createElement('p');
    err.className = 'dashboard-card__warning';
    err.textContent = `Feil: ${snapshot.sync.lastSyncError}`;
    card.appendChild(err);
  }
  return card;
}

function buildBackupCard(snapshot: DashboardSnapshot): HTMLElement {
  const card = sectionCard('Backup', 'backup', 'backup');
  const stats = document.createElement('dl');
  stats.className = 'dashboard-card__stats';
  appendStat(
    stats,
    'Siste backup',
    snapshot.backup.lastBackupAt === null
      ? 'aldri'
      : snapshot.backup.lastBackupAt.slice(0, 10),
  );
  appendStat(
    stats,
    'Holdings ved siste backup',
    snapshot.backup.lastBackupHoldingCount === null
      ? '–'
      : String(snapshot.backup.lastBackupHoldingCount),
  );
  appendStat(
    stats,
    'Holdings nå',
    String(snapshot.backup.liveHoldingsCount),
  );
  appendStat(
    stats,
    'Endring',
    snapshot.backup.holdingsSinceLastBackup === 0
      ? '0'
      : snapshot.backup.holdingsSinceLastBackup > 0
        ? `+${snapshot.backup.holdingsSinceLastBackup}`
        : String(snapshot.backup.holdingsSinceLastBackup),
  );
  if (snapshot.backup.daysSinceLastBackup !== null) {
    appendStat(
      stats,
      'Dager siden',
      String(snapshot.backup.daysSinceLastBackup),
    );
  }
  card.appendChild(stats);
  return card;
}

function buildCollectionCard(snapshot: DashboardSnapshot): HTMLElement {
  const card = sectionCard('Collection', 'collection', 'collection');
  const stats = document.createElement('dl');
  stats.className = 'dashboard-card__stats';
  const c = snapshot.collection;
  appendStat(stats, 'Live holdings', String(c.liveCount));
  appendStat(stats, 'Slettede', String(c.deletedCount));
  appendStat(stats, 'Unike kort', String(c.uniqueCardIds));
  appendStat(stats, 'Raw / Graded', `${c.rawCount} / ${c.gradedCount}`);
  appendStat(stats, 'Mangler tilstand', String(c.missingConditionCount));
  appendStat(stats, 'Mangler verdi', String(c.missingValueCount));
  appendStat(stats, 'Ikke i perm', String(c.notInBinderCount));
  appendStat(stats, 'Duplikater', String(c.duplicateStatusCount));
  appendStat(stats, 'Trenger oppgradering', String(c.upgradeNeededCount));
  card.appendChild(stats);
  card.appendChild(
    csvButton('Eksporter collection.csv', 'collection'),
  );
  card.appendChild(
    csvButton('Eksporter duplicates.csv', 'duplicates'),
  );
  return card;
}

function buildBindersCard(snapshot: DashboardSnapshot): HTMLElement {
  const card = sectionCard('Binders', 'binders', 'binders');
  const stats = document.createElement('dl');
  stats.className = 'dashboard-card__stats';
  appendStat(stats, 'Antall', String(snapshot.binders.count));
  appendStat(
    stats,
    'Snitt completion',
    `${snapshot.binders.averageCompletionPercent}%`,
  );
  appendStat(
    stats,
    'Mål-slots',
    String(snapshot.binders.totalTargetSlots),
  );
  appendStat(
    stats,
    'Fullført',
    String(snapshot.binders.totalCompletedSlots),
  );
  appendStat(
    stats,
    'Mangler',
    String(snapshot.binders.totalMissingSlots),
  );
  card.appendChild(stats);

  if (snapshot.binders.topByCompletion.length > 0) {
    const topHeading = document.createElement('h3');
    topHeading.className = 'dashboard-card__sub-heading';
    topHeading.textContent = 'Top 3 binders';
    card.appendChild(topHeading);
    card.appendChild(buildTopBindersList(snapshot.binders));
  }
  card.appendChild(csvButton('Eksporter missing-cards.csv', 'missing-cards'));
  return card;
}

function buildTopBindersList(binders: BindersSection): HTMLElement {
  const list = document.createElement('ul');
  list.className = 'dashboard-card__top-list';
  for (const summary of binders.topByCompletion) {
    const li = document.createElement('li');
    li.className = 'dashboard-card__top-item';
    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'dashboard-card__top-name';
    name.textContent = summary.binder.name;
    name.addEventListener('click', () => navigateToBinder(summary.binder.id));
    li.appendChild(name);
    const pct = document.createElement('span');
    pct.className = 'dashboard-card__top-percent';
    pct.textContent = `${summary.completion.percentage}%`;
    li.appendChild(pct);
    list.appendChild(li);
  }
  return list;
}

// ---------------------------------------------------------------------
// PR 26 — next-best-action helper. Picks the most useful single
// sentence to surface in the dashboard's Master Set Progress card,
// driven by the same summary the chips already show. Order is
// intentional: invalid > can-place > owned-unplaced > ordered >
// wanted > missing > all-clear. Pure function so it's easy to test.
export function getMasterGapNextAction(
  summary: MasterGapDashboardSummary,
): string {
  if (summary.invalidCount > 0) {
    return 'Rett feilplasserte kort eller feil variant først.';
  }
  if (summary.canPlaceDirectlyCount > 0) {
    return 'Start med kortene som kan plasseres direkte i perm.';
  }
  if (summary.ownedUnplaced > 0) {
    return 'Du eier kort som ikke er plassert i perm.';
  }
  if (summary.wishlistOrdered > 0) {
    return 'Følg opp bestilte kort og marker dem mottatt når de kommer.';
  }
  if (summary.wishlistWanted > 0) {
    return 'Følg ønskelisten og prioriter manglende master set-kort.';
  }
  if (summary.missing > 0) {
    return 'Legg manglende kort i ønskeliste eller lot.';
  }
  return 'Alle registrerte master set-slots ser ryddige ut.';
}

// ---------------------------------------------------------------------
// PR 25 — Master Set Progress card (lazy-loaded)

function buildMasterGapCardSkeleton(): HTMLElement {
  const card = document.createElement('article');
  card.className = 'dashboard-card';
  card.dataset['region'] = 'card-master-gap';

  const header = document.createElement('header');
  header.className = 'dashboard-card__header';
  const heading = document.createElement('h2');
  heading.className = 'dashboard-card__title';
  heading.textContent = 'Master Set Progress';
  header.appendChild(heading);
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'dashboard-card__nav';
  open.dataset['action'] = 'open-master-gap';
  open.textContent = 'Åpne gap-rapport';
  open.addEventListener('click', () => navigateToMasterGap());
  header.appendChild(open);
  card.appendChild(header);

  const skeleton = document.createElement('p');
  skeleton.className = 'dashboard-card__loading';
  skeleton.dataset['region'] = 'master-gap-loading';
  skeleton.textContent = 'Laster gap-analyse …';
  card.appendChild(skeleton);
  return card;
}

async function populateMasterGapCard(
  card: HTMLElement,
  hooks: {
    snapshot: DashboardSnapshot;
    commandCenter: HTMLElement;
    personalSummarySlot: HTMLElement;
  },
): Promise<void> {
  let summary: MasterGapDashboardSummary;
  let prefs: PersonalPreferences = DEFAULT_PERSONAL_PREFERENCES;
  try {
    const db = getDb();
    prefs = await createPersonalPreferencesService(
      createSettingsRepo(db),
    ).getPreferences();
    summary = await createMasterSetGapService({
      bindersRepo: createBindersRepo(db),
      binderSlotsRepo: createBinderSlotsRepo(db),
      cardsRepo: createCardsRepo(db),
      setsRepo: createSetsRepo(db),
      holdingsRepo: createHoldingsRepo(db),
      wishlistRepo: createWishlistRepo(db),
      lotItemsRepo: createLotItemsRepo(db),
    }).buildDashboardSummary();
  } catch (caught) {
    if (card.isConnected) {
      const loading = card.querySelector<HTMLElement>(
        '[data-region="master-gap-loading"]',
      );
      loading?.remove();
      const err = document.createElement('p');
      err.className = 'dashboard-card__warning';
      err.dataset['region'] = 'master-gap-error';
      err.textContent =
        caught instanceof Error
          ? `Kunne ikke laste master gap: ${caught.message}`
          : 'Kunne ikke laste master gap.';
      card.appendChild(err);
    }
    // PR 27 — even when master gap failed we can still surface a
    // dashboard-only command center (collection / backup / sync).
    populateCommandCenter(hooks.commandCenter, {
      masterGap: null,
      dashboard: hooks.snapshot,
      preferences: prefs,
    });
    populatePersonalWorkspaceSummary(hooks.personalSummarySlot, {
      preferences: prefs,
      dashboard: hooks.snapshot,
      masterGap: null,
      commandCenter: buildCommandCenterItems({
        masterGap: null,
        dashboard: hooks.snapshot,
        preferences: prefs,
      }),
    });
    return;
  }
  if (!card.isConnected) return;
  const loading = card.querySelector<HTMLElement>(
    '[data-region="master-gap-loading"]',
  );
  loading?.remove();

  if (summary.binderCount === 0) {
    const empty = document.createElement('p');
    empty.className = 'dashboard-card__empty';
    empty.dataset['region'] = 'master-gap-empty';
    empty.textContent =
      'Ingen permer ennå. Lag en perm for å se master gap-analyse.';
    card.appendChild(empty);
    // PR 27 — even with no binders the rest of the dashboard
    // (command center + workspace summary) should still render so
    // the user sees their app name and any non-master-gap signals.
    populateCommandCenter(hooks.commandCenter, {
      masterGap: summary,
      dashboard: hooks.snapshot,
      preferences: prefs,
    });
    populatePersonalWorkspaceSummary(hooks.personalSummarySlot, {
      preferences: prefs,
      dashboard: hooks.snapshot,
      masterGap: summary,
      commandCenter: buildCommandCenterItems({
        masterGap: summary,
        dashboard: hooks.snapshot,
        preferences: prefs,
      }),
    });
    return;
  }

  const stats = document.createElement('dl');
  stats.className = 'dashboard-card__stats';
  appendStat(stats, 'Snitt fullført', `${summary.averageCompletionPercent}%`);
  appendStat(stats, 'Mål-slots', String(summary.totalTargetSlots));
  appendStat(stats, 'Fullført', String(summary.complete));
  appendStat(stats, 'Mangler', String(summary.missing));
  appendStat(stats, 'Eier, ikke plassert', String(summary.ownedUnplaced));
  appendStat(stats, 'Ønsket', String(summary.wishlistWanted));
  appendStat(stats, 'Bestilt', String(summary.wishlistOrdered));
  appendStat(stats, 'I lot', String(summary.inLotUnmaterialized));
  appendStat(stats, 'Feil', String(summary.invalidCount));
  appendStat(
    stats,
    'Kan plasseres direkte',
    String(summary.canPlaceDirectlyCount),
  );
  card.appendChild(stats);

  // PR 26 — single-sentence "next best action" so the user has a
  // direction without scanning every chip. Driven by the pure helper
  // above so the priority order is testable in isolation.
  const next = document.createElement('p');
  next.className = 'dashboard-card__next-action';
  next.dataset['region'] = 'master-gap-next-action';
  next.textContent = `Neste beste handling: ${getMasterGapNextAction(summary)}`;
  card.appendChild(next);

  if (summary.closestBinder !== null) {
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'dashboard-card__nav';
    close.dataset['action'] = 'open-closest-binder';
    close.textContent = `Nærmest komplett: ${summary.closestBinder.binderName} (${summary.closestBinder.completionPercent}%)`;
    const closestId = summary.closestBinder.binderId;
    close.addEventListener('click', () =>
      navigateToMasterGapBinder(closestId),
    );
    card.appendChild(close);
  }
  if (summary.weakestBinder !== null) {
    const weak = document.createElement('button');
    weak.type = 'button';
    weak.className = 'dashboard-card__nav';
    weak.dataset['action'] = 'open-weakest-binder';
    weak.textContent = `Svakeste: ${summary.weakestBinder.binderName} (${summary.weakestBinder.completionPercent}%)`;
    const weakestId = summary.weakestBinder.binderId;
    weak.addEventListener('click', () => navigateToMasterGapBinder(weakestId));
    card.appendChild(weak);
  }

  // PR 27 — feed the (already rendered) command center + personal
  // workspace summary now that we have the full master-gap summary.
  const items = buildCommandCenterItems({
    masterGap: summary,
    dashboard: hooks.snapshot,
    preferences: prefs,
  });
  populateCommandCenter(hooks.commandCenter, {
    masterGap: summary,
    dashboard: hooks.snapshot,
    preferences: prefs,
  });
  populatePersonalWorkspaceSummary(hooks.personalSummarySlot, {
    preferences: prefs,
    dashboard: hooks.snapshot,
    masterGap: summary,
    commandCenter: items,
  });
}

// ---------------------------------------------------------------------
// PR 27 — command center skeleton + populate.

const COMMAND_CENTER_SEVERITY_CLASS: Record<
  CommandCenterItemSeverity,
  string
> = {
  critical: 'status-chip status-chip--danger',
  warning: 'status-chip status-chip--warning',
  info: 'status-chip status-chip--info',
  success: 'status-chip status-chip--success',
};

function buildCommandCenterSkeleton(): HTMLElement {
  const wrap = document.createElement('section');
  wrap.className = 'dashboard-command-center';
  wrap.dataset['region'] = 'command-center';

  const heading = document.createElement('h2');
  heading.className = 'dashboard-command-center__heading';
  heading.textContent = 'Arbeidskø';
  wrap.appendChild(heading);

  const subtitle = document.createElement('p');
  subtitle.className = 'dashboard-command-center__subtitle';
  subtitle.textContent =
    'Personlig prioritert liste over det som bør ryddes først.';
  wrap.appendChild(subtitle);

  const list = document.createElement('ul');
  list.className = 'dashboard-command-center__list';
  list.dataset['region'] = 'command-center-list';
  wrap.appendChild(list);

  const loading = document.createElement('p');
  loading.className = 'dashboard-command-center__loading';
  loading.dataset['region'] = 'command-center-loading';
  loading.textContent = 'Bygger arbeidskø …';
  wrap.appendChild(loading);

  return wrap;
}

function populateCommandCenter(
  wrap: HTMLElement,
  input: Parameters<typeof buildCommandCenterItems>[0],
): void {
  if (!wrap.isConnected) return;
  const list = wrap.querySelector<HTMLElement>(
    '[data-region="command-center-list"]',
  );
  const loading = wrap.querySelector<HTMLElement>(
    '[data-region="command-center-loading"]',
  );
  loading?.remove();
  if (list === null) return;
  list.replaceChildren();
  const items = buildCommandCenterItems(input);
  if (items.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'dashboard-command-center__empty';
    empty.textContent = 'Ingen ventende oppgaver akkurat nå.';
    list.appendChild(empty);
    return;
  }
  for (const item of items) {
    list.appendChild(buildCommandCenterItem(item));
  }
}

function buildCommandCenterItem(item: CommandCenterItem): HTMLElement {
  const li = document.createElement('li');
  li.className = `dashboard-command-center__item dashboard-command-center__item--${item.severity}`;
  li.dataset['kind'] = item.kind;
  li.dataset['severity'] = item.severity;

  const chip = document.createElement('span');
  chip.className = COMMAND_CENTER_SEVERITY_CLASS[item.severity];
  chip.textContent = item.severity;
  li.appendChild(chip);

  const body = document.createElement('div');
  body.className = 'dashboard-command-center__body';
  const title = document.createElement('p');
  title.className = 'dashboard-command-center__title';
  title.textContent = item.title;
  body.appendChild(title);
  const message = document.createElement('p');
  message.className = 'dashboard-command-center__message';
  message.textContent = item.message;
  body.appendChild(message);
  li.appendChild(body);

  if (item.target.type === 'hash') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'dashboard-command-center__action';
    button.dataset['action'] = 'command-center-action';
    button.dataset['hash'] = item.target.hash;
    button.textContent = item.actionLabel;
    const targetHash = item.target.hash;
    button.addEventListener('click', () => {
      window.location.hash = targetHash;
    });
    li.appendChild(button);
  }
  return li;
}

function populatePersonalWorkspaceSummary(
  slot: HTMLElement,
  input: Parameters<typeof buildPersonalWorkspaceSummary>[0],
): void {
  if (!slot.isConnected) return;
  slot.replaceChildren();
  if (!input.preferences.showPersonalWorkspaceSummary) return;
  slot.appendChild(buildPersonalWorkspaceSummary(input));
}

function buildLotsCard(snapshot: DashboardSnapshot): HTMLElement {
  const card = sectionCard('Lots / Bulk', 'lots', 'lots');
  const stats = document.createElement('dl');
  stats.className = 'dashboard-card__stats';
  appendStat(stats, 'Antall', String(snapshot.lots.count));
  appendStat(
    stats,
    'Ufordelte',
    String(snapshot.lots.unallocatedCount),
  );
  appendStat(
    stats,
    'Materialiserte',
    String(snapshot.lots.materializedCount),
  );
  appendStat(
    stats,
    'Ubalanserte',
    String(snapshot.lots.imbalancedCount),
  );
  card.appendChild(stats);
  if (snapshot.lots.totalsByCurrency.length > 0) {
    const totals = document.createElement('p');
    totals.className = 'dashboard-card__totals';
    totals.textContent =
      'Total kjøpsverdi: ' +
      snapshot.lots.totalsByCurrency
        .map((row) => `${row.total.toFixed(2)} ${row.currency}`)
        .join(' · ');
    card.appendChild(totals);
  }
  return card;
}

function buildWishlistCard(snapshot: DashboardSnapshot): HTMLElement {
  const card = sectionCard(
    'Wishlist / Action Needed',
    'wishlist',
    'wishlist',
  );
  const stats = document.createElement('dl');
  stats.className = 'dashboard-card__stats';
  appendStat(stats, 'Wanted', String(snapshot.wishlist.wantedCount));
  appendStat(stats, 'Ordered', String(snapshot.wishlist.orderedCount));
  appendStat(stats, 'Received', String(snapshot.wishlist.receivedCount));
  appendStat(stats, 'Cancelled', String(snapshot.wishlist.cancelledCount));
  card.appendChild(stats);

  if (snapshot.wishlist.grailItems.length > 0) {
    const heading = document.createElement('h3');
    heading.className = 'dashboard-card__sub-heading';
    heading.textContent = 'Grail-items';
    card.appendChild(heading);
    const list = document.createElement('ul');
    list.className = 'dashboard-card__top-list';
    for (const entry of snapshot.wishlist.grailItems) {
      const li = document.createElement('li');
      li.className = 'dashboard-card__top-item';
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'dashboard-card__top-name';
      link.textContent = entry.cardId;
      link.addEventListener('click', () => navigateToCard(entry.cardId));
      li.appendChild(link);
      const status = document.createElement('span');
      status.className = 'dashboard-card__top-percent';
      status.textContent = entry.status;
      li.appendChild(status);
      list.appendChild(li);
    }
    card.appendChild(list);
  }
  card.appendChild(csvButton('Eksporter wishlist.csv', 'wishlist'));
  return card;
}

// ---------------------------------------------------------------------
// Reusable bits

function sectionCard(
  title: string,
  region: string,
  goTo: SidebarRoute,
): HTMLElement {
  const card = document.createElement('article');
  card.className = 'dashboard-card';
  card.dataset['region'] = `card-${region}`;

  const header = document.createElement('header');
  header.className = 'dashboard-card__header';
  const heading = document.createElement('h2');
  heading.className = 'dashboard-card__title';
  heading.textContent = title;
  header.appendChild(heading);
  header.appendChild(navButton('Åpne', goTo));
  card.appendChild(header);
  return card;
}

function navButton(label: string, route: SidebarRoute): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'dashboard-card__nav';
  btn.dataset['action'] = 'nav';
  btn.dataset['route'] = route;
  btn.textContent = label;
  btn.addEventListener('click', () => navigate(route));
  return btn;
}

function csvButton(label: string, kind: MvpCsvKind): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'dashboard-card__csv';
  btn.dataset['action'] = 'export-csv';
  btn.dataset['kind'] = kind;
  btn.textContent = label;
  btn.addEventListener('click', () => {
    void handleCsvExport(kind);
  });
  return btn;
}

function appendStat(dl: HTMLDListElement, label: string, value: string): void {
  const dt = document.createElement('dt');
  dt.textContent = label;
  dl.appendChild(dt);
  const dd = document.createElement('dd');
  dd.textContent = value;
  dl.appendChild(dd);
}

async function handleCsvExport(kind: MvpCsvKind): Promise<void> {
  const db = getDb();
  const exporter = createMvpCsvExporter({
    db,
    holdingsRepo: createHoldingsRepo(db),
    bindersRepo: createBindersRepo(db),
    binderSlotsRepo: createBinderSlotsRepo(db),
    cardsRepo: createCardsRepo(db),
    setsRepo: createSetsRepo(db),
    wishlistRepo: createWishlistRepo(db),
  });
  let result;
  switch (kind) {
    case 'collection':
      result = await exporter.buildCollection();
      break;
    case 'wishlist':
      result = await exporter.buildWishlist();
      break;
    case 'duplicates':
      result = await exporter.buildDuplicates();
      break;
    case 'missing-cards':
      result = await exporter.buildMissingCards();
      break;
  }
  downloadTextFile(result.filename, result.content, {
    mimeType: 'text/csv',
  });
  await exporter.recordCsvExported(kind, result.rowCount);
}
