// Binder detail view. Renders the binder reached via `#binder/<id>` in
// one of two modes:
//
//   - "Sider" — page/slot grid; mirrors the physical binder. Filtered
//     slots remain in their grid cell as muted placeholders so cell
//     positions never shift; this matters because users navigate the
//     view by physical slot index.
//
//   - "Sjekkliste" — flat table sorted by physical slot order. Useful
//     for quickly finding what's missing or eyeballing condition.
//
// A single filter strip applies to both modes
// (`alle | mangler | bestilt | duplikater | ferdig`). "Mangler" is the
// inverse of KRAVSPEC §6 completion; "ferdig" is the §6-complete set.
//
// Master-mode reverse-holo template slots are flagged in the data via
// `slot.note === REVERSE_HOLO_TEMPLATE_MARKER` (see
// `domain/card-variants.ts`). The view derives a "Reverse holo" finish
// label from that marker but never shows the raw token to the user;
// the slot-note display drops the marker entirely.
//
// Reads via `binder-slot-service`. CSV export goes through
// `createBinderCsvExporter`. All slot mutations still flow through
// `slot-action-menu` and `assign-holding-modal`, both unchanged from
// PR 8a.

import { openDialog } from '../components/dialog';
import { onUserDataChanged } from '../components/events';
import { buildAssignHoldingModal } from '../components/assign-holding-modal';
import { buildSlotActionMenu } from '../components/slot-action-menu';
import { getDb } from '../db/database';
import { isReverseHoloTemplateSlot } from '../domain/card-variants';
import { getCurrentBinderId, navigate, navigateToCard } from '../router';
import { createBindersRepo } from '../repositories/binders-repo';
import { createBinderSlotsRepo } from '../repositories/binder-slots-repo';
import { createCardsRepo } from '../repositories/cards-repo';
import { createHoldingsRepo } from '../repositories/holdings-repo';
import { createSetsRepo } from '../repositories/sets-repo';
import { createBinderCsvExporter } from '../services/binder-csv-export';
import {
  createBinderSlotService,
  type BinderDetail,
} from '../services/binder-slot-service';
import { createLazyImage } from '../utils/lazy-image';
import { downloadTextFile } from '../utils/download';
import type {
  BinderSlotRecord,
  BinderSlotStatus,
  CardFinish,
  CardRecord,
  HoldingRecord,
  SlotsPerPage,
} from '../domain/types';

const STATUS_LABELS: Record<BinderSlotStatus, string> = {
  empty: 'Tom',
  wanted: 'Ønsket',
  owned: 'Eid',
  missing: 'Mangler',
  ordered: 'Bestilt',
  duplicate: 'Duplikat',
  upgrade_needed: 'Oppgrader',
};

const FINISH_LABELS: Record<CardFinish, string> = {
  normal: 'Normal',
  holo: 'Holo',
  reverse_holo: 'Reverse holo',
  non_holo: 'Non-holo',
  stamped: 'Stamped',
  unknown: 'Ukjent',
};

type ViewMode = 'pages' | 'checklist';

type SlotFilter =
  | 'all'
  | 'missing'
  | 'ordered'
  | 'duplicate'
  | 'completed';

interface ViewState {
  mode: ViewMode;
  filter: SlotFilter;
}

const FILTER_LABELS: ReadonlyArray<{ readonly value: SlotFilter; readonly label: string }> = [
  { value: 'all', label: 'Alle' },
  { value: 'missing', label: 'Mangler' },
  { value: 'ordered', label: 'Bestilt' },
  { value: 'duplicate', label: 'Duplikater' },
  { value: 'completed', label: 'Ferdig' },
];

export function mountBinderDetailView(
  container: HTMLElement,
  signal?: AbortSignal,
): void {
  // Per-mount view state so toggles survive USER_DATA_CHANGED_EVENT
  // refreshes but reset when the route is unmounted.
  const state: ViewState = { mode: 'pages', filter: 'all' };

  void renderInto(container, state);

  const refresh = (): void => {
    if (!container.isConnected) return;
    void renderInto(container, state);
  };
  // PR 15A — F-3: router signal drops this listener on next route.
  onUserDataChanged(refresh, signal);
}

async function renderInto(
  container: HTMLElement,
  state: ViewState,
): Promise<void> {
  container.innerHTML = '';
  const binderId = getCurrentBinderId();

  const root = document.createElement('section');
  root.className = 'binder-detail-view';
  container.appendChild(root);

  const header = document.createElement('div');
  header.className = 'binder-detail-view__header';
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'binder-detail-view__back';
  back.dataset['action'] = 'back';
  back.textContent = '← Tilbake til Permer';
  back.addEventListener('click', () => {
    navigate('binders');
  });
  header.appendChild(back);
  root.appendChild(header);

  if (binderId === null) {
    appendMessage(root, 'Ingen perm valgt. Gå tilbake til Permer-listen.');
    return;
  }

  const db = getDb();
  const service = createBinderSlotService(
    createBindersRepo(db),
    createBinderSlotsRepo(db),
    createHoldingsRepo(db),
    createCardsRepo(db),
  );
  const detail = await service.getDetail(binderId);
  if (detail === null) {
    appendMessage(
      root,
      'Permen finnes ikke (eller er slettet). Gå tilbake til Permer-listen.',
    );
    return;
  }

  root.appendChild(buildSummary(detail));
  root.appendChild(buildToolbar(detail, state, container));

  if (state.mode === 'checklist') {
    root.appendChild(buildChecklist(detail, state.filter));
  } else {
    root.appendChild(buildPagesGrid(detail, state.filter));
  }
}

function appendMessage(root: HTMLElement, text: string): void {
  const p = document.createElement('p');
  p.className = 'binder-detail-view__message';
  p.textContent = text;
  root.appendChild(p);
}

function buildSummary(detail: BinderDetail): HTMLElement {
  const summary = document.createElement('header');
  summary.className = 'binder-detail-view__summary';

  const title = document.createElement('h1');
  title.className = 'binder-detail-view__title';
  title.textContent = detail.binder.name;
  summary.appendChild(title);

  if (detail.binder.binderType !== null) {
    const t = document.createElement('p');
    t.className = 'binder-detail-view__type';
    t.textContent = detail.binder.binderType;
    summary.appendChild(t);
  }
  if (detail.binder.description !== null) {
    const d = document.createElement('p');
    d.className = 'binder-detail-view__description';
    d.textContent = detail.binder.description;
    summary.appendChild(d);
  }

  const stats = document.createElement('dl');
  stats.className = 'binder-detail-view__stats';
  appendStat(stats, 'Sider', String(detail.binder.totalPages));
  appendStat(stats, 'Slots/side', String(detail.binder.slotsPerPage));
  appendStat(
    stats,
    'Mål-slots',
    String(detail.completion.totalTargetSlots),
  );
  appendStat(
    stats,
    'Fullført',
    `${detail.completion.completedSlots} (${detail.completion.percentage}%)`,
  );
  appendStat(stats, 'Mangler', String(detail.completion.missingSlots));
  summary.appendChild(stats);

  const progress = document.createElement('div');
  progress.className = 'binder-detail-view__progress';
  progress.setAttribute('role', 'progressbar');
  progress.setAttribute('aria-valuemin', '0');
  progress.setAttribute('aria-valuemax', '100');
  progress.setAttribute('aria-valuenow', String(detail.completion.percentage));
  const fill = document.createElement('span');
  fill.className = 'binder-detail-view__progress-fill';
  fill.style.width = `${detail.completion.percentage}%`;
  progress.appendChild(fill);
  summary.appendChild(progress);

  return summary;
}

function buildToolbar(
  detail: BinderDetail,
  state: ViewState,
  container: HTMLElement,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'binder-detail-view__toolbar';

  // View-mode toggle
  const toggleGroup = document.createElement('div');
  toggleGroup.className = 'binder-detail-view__toggle';
  toggleGroup.setAttribute('role', 'tablist');

  const pagesBtn = makeToggleButton('pages', 'Sider', state.mode === 'pages');
  pagesBtn.addEventListener('click', () => {
    if (state.mode === 'pages') return;
    state.mode = 'pages';
    void renderInto(container, state);
  });
  toggleGroup.appendChild(pagesBtn);

  const checklistBtn = makeToggleButton(
    'checklist',
    'Sjekkliste',
    state.mode === 'checklist',
  );
  checklistBtn.addEventListener('click', () => {
    if (state.mode === 'checklist') return;
    state.mode = 'checklist';
    void renderInto(container, state);
  });
  toggleGroup.appendChild(checklistBtn);
  wrap.appendChild(toggleGroup);

  // Filter
  const filterLabel = document.createElement('label');
  filterLabel.className = 'binder-detail-view__filter';
  const filterText = document.createElement('span');
  filterText.textContent = 'Filter';
  filterLabel.appendChild(filterText);
  const filterSelect = document.createElement('select');
  filterSelect.dataset['region'] = 'filter-select';
  for (const opt of FILTER_LABELS) {
    const o = document.createElement('option');
    o.value = opt.value;
    o.textContent = opt.label;
    filterSelect.appendChild(o);
  }
  filterSelect.value = state.filter;
  filterSelect.addEventListener('change', () => {
    state.filter = filterSelect.value as SlotFilter;
    void renderInto(container, state);
  });
  filterLabel.appendChild(filterSelect);
  wrap.appendChild(filterLabel);

  // Export button
  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.className = 'binder-detail-view__export';
  exportBtn.dataset['action'] = 'export-csv';
  exportBtn.textContent = 'Eksporter sjekkliste (CSV)';
  exportBtn.addEventListener('click', () => {
    void handleExportCsv(detail.binder.id);
  });
  wrap.appendChild(exportBtn);

  return wrap;
}

function makeToggleButton(
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

async function handleExportCsv(binderId: string): Promise<void> {
  const db = getDb();
  const exporter = createBinderCsvExporter(
    db,
    createBindersRepo(db),
    createBinderSlotsRepo(db),
    createHoldingsRepo(db),
    createCardsRepo(db),
    createSetsRepo(db),
  );
  const result = await exporter.build(binderId);
  if (result === null) return;
  // Hand the content to the download helper FIRST. The audit row says
  // "the CSV was generated and a download was started" — write it
  // after the call so a thrown error in download still leaves an
  // audit-correct trail (or no trail at all on failure).
  downloadTextFile(result.filename, result.content, { mimeType: 'text/csv' });
  const binder = await createBindersRepo(db).get(binderId);
  if (binder === undefined) return;
  await exporter.recordExport(binder, result.rowCount);
}

function appendStat(dl: HTMLDListElement, label: string, value: string): void {
  const dt = document.createElement('dt');
  dt.textContent = label;
  dl.appendChild(dt);
  const dd = document.createElement('dd');
  dd.textContent = value;
  dl.appendChild(dd);
}

// ---------------------------------------------------------------------
// Filter math (KRAVSPEC §6)

function isSlotComplete(
  slot: BinderSlotRecord,
  detail: BinderDetail,
): boolean {
  if (slot.targetCardId === null) return false;
  if (slot.status !== 'owned') return false;
  if (slot.holdingId === null) return false;
  return detail.holdingsById.has(slot.holdingId);
}

function slotMatchesFilter(
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
    case 'ordered':
      return slot.status === 'ordered';
    case 'duplicate':
      return slot.status === 'duplicate';
  }
}

// ---------------------------------------------------------------------
// Pages mode

function buildPagesGrid(
  detail: BinderDetail,
  filter: SlotFilter,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'binder-detail-view__pages';

  if (detail.slots.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'binder-detail-view__empty';
    empty.textContent =
      'Permen har ingen slots ennå. Hvis dette er en ny perm, prøv å rendre på nytt eller opprett en ny perm.';
    wrap.appendChild(empty);
    return wrap;
  }

  const slotsByPage = new Map<number, BinderSlotRecord[]>();
  for (const slot of detail.slots) {
    let page = slotsByPage.get(slot.pageNumber);
    if (page === undefined) {
      page = [];
      slotsByPage.set(slot.pageNumber, page);
    }
    page.push(slot);
  }

  const sortedPageNumbers = [...slotsByPage.keys()].sort((a, b) => a - b);
  for (const pageNumber of sortedPageNumbers) {
    const slotsForPage = slotsByPage.get(pageNumber);
    if (slotsForPage === undefined) continue;
    wrap.appendChild(buildPage(detail, pageNumber, slotsForPage, filter));
  }

  return wrap;
}

function buildPage(
  detail: BinderDetail,
  pageNumber: number,
  slots: readonly BinderSlotRecord[],
  filter: SlotFilter,
): HTMLElement {
  const page = document.createElement('section');
  page.className = 'binder-page';
  page.dataset['pageNumber'] = String(pageNumber);

  const heading = document.createElement('h2');
  heading.className = 'binder-page__heading';
  heading.textContent = `Side ${pageNumber}`;
  page.appendChild(heading);

  const grid = document.createElement('div');
  grid.className = `binder-page__grid binder-page__grid--${detail.binder.slotsPerPage}`;
  for (const slot of slots) {
    const matches = slotMatchesFilter(slot, filter, detail);
    grid.appendChild(buildSlot(detail, slot, matches));
  }
  page.appendChild(grid);
  return page;
}

function buildSlot(
  detail: BinderDetail,
  slot: BinderSlotRecord,
  matchesFilter: boolean,
): HTMLElement {
  const tile = document.createElement('article');
  const isReverseTemplate = isReverseHoloTemplateSlot(slot.note);
  tile.className = `binder-slot binder-slot--${slot.status}${
    !matchesFilter ? ' binder-slot--filtered-out' : ''
  }${isReverseTemplate ? ' binder-slot--reverse-template' : ''}`;
  tile.dataset['slotId'] = slot.id;
  tile.dataset['status'] = slot.status;
  tile.dataset['pageNumber'] = String(slot.pageNumber);
  tile.dataset['slotNumber'] = String(slot.slotNumber);
  tile.dataset['matchesFilter'] = matchesFilter ? 'true' : 'false';
  if (isReverseTemplate) {
    tile.dataset['reverseHoloTemplate'] = 'true';
  }
  if (!matchesFilter) {
    tile.setAttribute('aria-hidden', 'true');
  }

  const indexLabel = document.createElement('span');
  indexLabel.className = 'binder-slot__index';
  indexLabel.textContent = `${slot.pageNumber}.${slot.slotNumber}`;
  tile.appendChild(indexLabel);

  const statusBadge = document.createElement('span');
  statusBadge.className = `status-chip status-chip--${slot.status}`;
  statusBadge.dataset['region'] = 'status-badge';
  statusBadge.textContent = STATUS_LABELS[slot.status];
  tile.appendChild(statusBadge);

  if (isReverseTemplate) {
    const finishBadge = document.createElement('span');
    finishBadge.className = 'binder-slot__finish-badge';
    finishBadge.textContent = 'Reverse holo';
    tile.appendChild(finishBadge);
  }

  const card = resolveCardForSlot(detail, slot);
  if (card !== null) {
    const thumb = createLazyImage({
      src: card.imageSmall,
      alt: card.name,
      width: 80,
      height: 112,
      className: 'binder-slot__thumb',
    });
    tile.appendChild(thumb);

    // Filtered-out tiles must have no focusable children (the tile is
    // `aria-hidden`). Render the card name as plain text instead of a
    // button so screen readers + keyboard users skip it cleanly.
    if (matchesFilter) {
      const nameButton = document.createElement('button');
      nameButton.type = 'button';
      nameButton.className = 'binder-slot__card-link';
      nameButton.dataset['action'] = 'open-card';
      nameButton.textContent = card.name;
      nameButton.addEventListener('click', (event) => {
        event.stopPropagation();
        navigateToCard(card.id);
      });
      tile.appendChild(nameButton);
    } else {
      const nameText = document.createElement('p');
      nameText.className = 'binder-slot__card-link binder-slot__card-link--inert';
      nameText.textContent = card.name;
      tile.appendChild(nameText);
    }

    const meta = document.createElement('p');
    meta.className = 'binder-slot__meta';
    meta.textContent = `${card.id}`;
    tile.appendChild(meta);
  } else {
    const placeholder = document.createElement('p');
    placeholder.className = 'binder-slot__empty';
    placeholder.textContent =
      slot.targetCardId !== null
        ? `Mål: ${slot.targetCardId}`
        : 'Tom slot';
    tile.appendChild(placeholder);
  }

  // Action buttons are the only mutation surface in the grid view. We
  // never render them for a filtered-out tile so:
  //   1) The filter contract holds (filtered slots cannot be mutated).
  //   2) `aria-hidden` content has no focusable descendants.
  //   3) There is no accidental scroll/tab landing on an opaque tile
  //      the user filtered away.
  if (matchesFilter) {
    const actions = document.createElement('div');
    actions.className = 'binder-slot__actions';

    const assignBtn = document.createElement('button');
    assignBtn.type = 'button';
    assignBtn.className = 'binder-slot__action';
    assignBtn.dataset['action'] = 'assign';
    assignBtn.textContent =
      slot.holdingId === null ? 'Tilordne holding' : 'Bytt holding';
    assignBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      void openAssign(slot, detail.binder.slotsPerPage);
    });
    actions.appendChild(assignBtn);

    const menuBtn = document.createElement('button');
    menuBtn.type = 'button';
    menuBtn.className = 'binder-slot__action';
    menuBtn.dataset['action'] = 'open-menu';
    menuBtn.textContent = 'Endre status';
    menuBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      void openMenu(slot, detail.binder.slotsPerPage);
    });
    actions.appendChild(menuBtn);

    tile.appendChild(actions);
  }
  return tile;
}

// ---------------------------------------------------------------------
// Checklist mode

function buildChecklist(
  detail: BinderDetail,
  filter: SlotFilter,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'binder-detail-view__checklist';

  if (detail.slots.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'binder-detail-view__empty';
    empty.textContent = 'Permen har ingen slots ennå.';
    wrap.appendChild(empty);
    return wrap;
  }

  const filteredSlots = detail.slots.filter((s) =>
    slotMatchesFilter(s, filter, detail),
  );

  if (filteredSlots.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'binder-detail-view__empty';
    empty.textContent = 'Ingen slots matcher filteret.';
    wrap.appendChild(empty);
    return wrap;
  }

  const table = document.createElement('table');
  table.className = 'checklist-table';
  table.innerHTML = `
    <thead>
      <tr>
        <th>#</th>
        <th>Kortnavn</th>
        <th>Sett #</th>
        <th>Finish</th>
        <th>Mål-status</th>
        <th>Eid</th>
        <th>Side.Slot</th>
        <th>Tilstand</th>
        <th>Notat</th>
        <th>Handlinger</th>
      </tr>
    </thead>
    <tbody data-region="checklist-body"></tbody>
  `;
  const body = table.querySelector<HTMLElement>('[data-region="checklist-body"]');
  if (body !== null) {
    for (const slot of filteredSlots) {
      body.appendChild(buildChecklistRow(detail, slot));
    }
  }
  wrap.appendChild(table);
  return wrap;
}

function buildChecklistRow(
  detail: BinderDetail,
  slot: BinderSlotRecord,
): HTMLTableRowElement {
  const tr = document.createElement('tr');
  const isReverseTemplate = isReverseHoloTemplateSlot(slot.note);
  tr.className = 'checklist-table__row';
  tr.dataset['slotId'] = slot.id;
  tr.dataset['status'] = slot.status;
  if (isReverseTemplate) {
    tr.dataset['reverseHoloTemplate'] = 'true';
  }

  const card = resolveCardForSlot(detail, slot);
  const holding =
    slot.holdingId !== null
      ? (detail.holdingsById.get(slot.holdingId) ?? null)
      : null;

  appendCell(tr, card?.number ?? '');
  appendCell(tr, card?.name ?? slot.targetCardId ?? '–');
  appendCell(tr, card?.id ?? '');

  const finishLabel = isReverseTemplate
    ? 'Reverse holo'
    : (holding !== null ? FINISH_LABELS[holding.finish] : '–');
  appendCell(tr, finishLabel);

  appendCell(tr, STATUS_LABELS[slot.status]);
  appendCell(tr, isSlotComplete(slot, detail) ? '✓' : '–');
  appendCell(tr, `${slot.pageNumber}.${slot.slotNumber}`);
  appendCell(tr, describeCondition(holding));
  appendCell(tr, displaySlotNote(slot));

  const actions = document.createElement('td');
  actions.className = 'checklist-table__actions';
  const assign = document.createElement('button');
  assign.type = 'button';
  assign.className = 'checklist-table__action';
  assign.dataset['action'] = 'assign';
  assign.textContent = slot.holdingId === null ? 'Tilordne' : 'Bytt';
  assign.addEventListener('click', (event) => {
    event.stopPropagation();
    void openAssign(slot, detail.binder.slotsPerPage);
  });
  actions.appendChild(assign);
  const menu = document.createElement('button');
  menu.type = 'button';
  menu.className = 'checklist-table__action';
  menu.dataset['action'] = 'open-menu';
  menu.textContent = 'Status';
  menu.addEventListener('click', (event) => {
    event.stopPropagation();
    void openMenu(slot, detail.binder.slotsPerPage);
  });
  actions.appendChild(menu);
  tr.appendChild(actions);

  return tr;
}

function describeCondition(holding: HoldingRecord | null): string {
  if (holding === null) return '–';
  if (holding.conditionType === 'graded') {
    const company = holding.gradingCompany ?? '?';
    const grade = holding.grade !== null ? holding.grade.toFixed(1) : '?';
    return `${company} ${grade}`;
  }
  return holding.rawCondition ?? '–';
}

function displaySlotNote(slot: BinderSlotRecord): string {
  // Hide the internal reverse-holo template marker from the note
  // column. User-authored notes pass through unchanged.
  if (isReverseHoloTemplateSlot(slot.note)) return '';
  return slot.note ?? '';
}

function appendCell(tr: HTMLTableRowElement, value: string): void {
  const td = document.createElement('td');
  td.textContent = value;
  tr.appendChild(td);
}

// ---------------------------------------------------------------------
// Shared helpers (slot → card resolution, dialog openers)

function resolveCardForSlot(
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

function resolveCardFromHolding(
  detail: BinderDetail,
  holding: HoldingRecord,
): CardRecord | null {
  return detail.cardsById.get(holding.cardId) ?? null;
}

async function openAssign(
  slot: BinderSlotRecord,
  slotsPerPage: SlotsPerPage,
): Promise<void> {
  await openDialog(buildAssignHoldingModal({ slot, slotsPerPage }));
}

async function openMenu(
  slot: BinderSlotRecord,
  slotsPerPage: SlotsPerPage,
): Promise<void> {
  await openDialog(buildSlotActionMenu({ slot, slotsPerPage }));
}
