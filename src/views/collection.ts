// Collection view. The home for everything the user owns. Reads
// holdings via `collection-service` (joined with cards + sets) and
// drives Add/Edit/SoftDelete/Restore through the holding form.
//
// Mutations always go through `holdingsRepo` from PR 3 (validators +
// audit). The view never calls `db.holdings` directly.

import { openDialog } from '../components/dialog';
import { USER_DATA_CHANGED_EVENT } from '../components/events';
import { buildHoldingForm } from '../components/holding-form';
import { getDb } from '../db/database';
import { formatTags } from '../domain/tags';
import { navigateToCard } from '../router';
import { createCardsRepo } from '../repositories/cards-repo';
import { createHoldingsRepo } from '../repositories/holdings-repo';
import { createSetsRepo } from '../repositories/sets-repo';
import {
  createCollectionService,
  type CollectionCriteria,
  type CollectionFilters,
  type CollectionRow,
  type CollectionService,
  type CollectionPageSize,
  type CollectionSort,
  type SortDirection,
} from '../services/collection-service';
import { createLazyImage } from '../utils/lazy-image';
import type { HoldingRecord, RawCondition, HoldingStatus } from '../domain/types';

interface CollectionState {
  conditionType: '' | 'raw' | 'graded';
  rawCondition: '' | RawCondition;
  setId: string;
  status: '' | HoldingStatus;
  missingCondition: boolean;
  missingValue: boolean;
  showDeleted: boolean;
  search: string;
  sort: CollectionSort;
  sortDirection: SortDirection;
  page: number;
  pageSize: CollectionPageSize;
}

const SORT_OPTIONS: ReadonlyArray<{ readonly value: CollectionSort; readonly label: string }> = [
  { value: 'updated', label: 'Sist endret' },
  { value: 'name', label: 'Navn' },
  { value: 'set-release', label: 'Sett-utgivelse' },
  { value: 'condition', label: 'Tilstand' },
  { value: 'value', label: 'Manuell verdi' },
];

const STATUS_LABELS: Record<HoldingStatus, string> = {
  owned: 'Eid',
  duplicate: 'Duplikat',
  for_sale: 'Til salgs',
  for_trade: 'Bytte',
  upgrade_needed: 'Bør oppgraderes',
  ordered: 'Bestilt',
  wanted: 'Ønsket',
};

const RAW_CONDITIONS: readonly RawCondition[] = [
  'NM',
  'LP',
  'MP',
  'HP',
  'DMG',
  'UNKNOWN',
];

export function mountCollectionView(container: HTMLElement): void {
  container.innerHTML = `
    <section class="collection-view" aria-labelledby="collection-heading">
      <h1 id="collection-heading">Min samling</h1>
      <p class="collection-view__counts" data-region="counts"></p>
      <div class="collection-view__toolbar" data-region="toolbar">
        <label class="browse-view__field">
          <span>Søk</span>
          <input type="search" data-region="search" placeholder="Kortnavn…" />
        </label>
        <label class="browse-view__field">
          <span>Tilstandstype</span>
          <select data-region="condition-type">
            <option value="">Alle</option>
            <option value="raw">Raw</option>
            <option value="graded">Gradet</option>
          </select>
        </label>
        <label class="browse-view__field">
          <span>Raw-tilstand</span>
          <select data-region="raw-condition">
            <option value="">Alle</option>
          </select>
        </label>
        <label class="browse-view__field">
          <span>Sett</span>
          <select data-region="set-filter">
            <option value="">Alle sett</option>
          </select>
        </label>
        <label class="browse-view__field">
          <span>Status</span>
          <select data-region="status-filter">
            <option value="">Alle</option>
          </select>
        </label>
        <label class="browse-view__field">
          <span>Sorter etter</span>
          <select data-region="sort"></select>
        </label>
        <label class="browse-view__field">
          <span>Retning</span>
          <select data-region="sort-direction">
            <option value="desc">Synkende</option>
            <option value="asc">Stigende</option>
          </select>
        </label>
        <label class="browse-view__field">
          <span>Per side</span>
          <select data-region="page-size">
            <option value="25">25</option>
            <option value="50" selected>50</option>
            <option value="100">100</option>
          </select>
        </label>
        <label class="browse-view__field browse-view__field--checkbox">
          <input type="checkbox" data-region="missing-condition" />
          <span>Mangler tilstand</span>
        </label>
        <label class="browse-view__field browse-view__field--checkbox">
          <input type="checkbox" data-region="missing-value" />
          <span>Mangler verdi</span>
        </label>
        <label class="browse-view__field browse-view__field--checkbox">
          <input type="checkbox" data-region="show-deleted" />
          <span>Vis slettede</span>
        </label>
      </div>
      <table class="browse-table collection-table" data-region="table">
        <thead>
          <tr>
            <th class="browse-table__image-col"></th>
            <th>Navn</th>
            <th>Sett</th>
            <th>#</th>
            <th>Finish</th>
            <th>Edition</th>
            <th>Tilstand</th>
            <th>Antall</th>
            <th>Manuell verdi</th>
            <th>Status</th>
            <th>Tags</th>
            <th>Oppdatert</th>
            <th class="browse-table__actions-col">Handlinger</th>
          </tr>
        </thead>
        <tbody data-region="rows"></tbody>
      </table>
      <nav class="browse-view__pagination" data-region="pagination" aria-label="Sidenavigasjon">
        <button type="button" data-action="prev-page">Forrige</button>
        <span data-region="page-summary"></span>
        <button type="button" data-action="next-page">Neste</button>
      </nav>
    </section>
  `;

  const refs = collectRefs(container);
  if (refs === null) return;

  populateRawConditionOptions(refs.rawConditionFilter);
  populateStatusOptions(refs.statusFilter);
  populateSortOptions(refs.sortSelect);

  const state: CollectionState = {
    conditionType: '',
    rawCondition: '',
    setId: '',
    status: '',
    missingCondition: false,
    missingValue: false,
    showDeleted: false,
    search: '',
    sort: 'updated',
    sortDirection: 'desc',
    page: 0,
    pageSize: 50,
  };

  const db = getDb();
  const service = createCollectionService(
    createHoldingsRepo(db),
    createCardsRepo(db),
    createSetsRepo(db),
  );

  void initialize(refs, service, state);
  attachEventListeners(refs, service, state);
}

interface ViewRefs {
  readonly countsRegion: HTMLElement;
  readonly searchInput: HTMLInputElement;
  readonly conditionTypeFilter: HTMLSelectElement;
  readonly rawConditionFilter: HTMLSelectElement;
  readonly setFilter: HTMLSelectElement;
  readonly statusFilter: HTMLSelectElement;
  readonly sortSelect: HTMLSelectElement;
  readonly sortDirectionSelect: HTMLSelectElement;
  readonly pageSizeSelect: HTMLSelectElement;
  readonly missingConditionInput: HTMLInputElement;
  readonly missingValueInput: HTMLInputElement;
  readonly showDeletedInput: HTMLInputElement;
  readonly rowsRegion: HTMLElement;
  readonly pageSummary: HTMLElement;
  readonly prevButton: HTMLButtonElement;
  readonly nextButton: HTMLButtonElement;
}

function collectRefs(container: HTMLElement): ViewRefs | null {
  const get = <T extends HTMLElement>(s: string): T | null =>
    container.querySelector<T>(s);
  const countsRegion = get<HTMLElement>('[data-region="counts"]');
  const searchInput = get<HTMLInputElement>('[data-region="search"]');
  const conditionTypeFilter = get<HTMLSelectElement>(
    '[data-region="condition-type"]',
  );
  const rawConditionFilter = get<HTMLSelectElement>(
    '[data-region="raw-condition"]',
  );
  const setFilter = get<HTMLSelectElement>('[data-region="set-filter"]');
  const statusFilter = get<HTMLSelectElement>('[data-region="status-filter"]');
  const sortSelect = get<HTMLSelectElement>('[data-region="sort"]');
  const sortDirectionSelect = get<HTMLSelectElement>(
    '[data-region="sort-direction"]',
  );
  const pageSizeSelect = get<HTMLSelectElement>('[data-region="page-size"]');
  const missingConditionInput = get<HTMLInputElement>(
    '[data-region="missing-condition"]',
  );
  const missingValueInput = get<HTMLInputElement>('[data-region="missing-value"]');
  const showDeletedInput = get<HTMLInputElement>('[data-region="show-deleted"]');
  const rowsRegion = get<HTMLElement>('[data-region="rows"]');
  const pageSummary = get<HTMLElement>('[data-region="page-summary"]');
  const prevButton = get<HTMLButtonElement>('[data-action="prev-page"]');
  const nextButton = get<HTMLButtonElement>('[data-action="next-page"]');

  if (
    !countsRegion ||
    !searchInput ||
    !conditionTypeFilter ||
    !rawConditionFilter ||
    !setFilter ||
    !statusFilter ||
    !sortSelect ||
    !sortDirectionSelect ||
    !pageSizeSelect ||
    !missingConditionInput ||
    !missingValueInput ||
    !showDeletedInput ||
    !rowsRegion ||
    !pageSummary ||
    !prevButton ||
    !nextButton
  ) {
    return null;
  }

  return {
    countsRegion,
    searchInput,
    conditionTypeFilter,
    rawConditionFilter,
    setFilter,
    statusFilter,
    sortSelect,
    sortDirectionSelect,
    pageSizeSelect,
    missingConditionInput,
    missingValueInput,
    showDeletedInput,
    rowsRegion,
    pageSummary,
    prevButton,
    nextButton,
  };
}

function populateRawConditionOptions(select: HTMLSelectElement): void {
  for (const cond of RAW_CONDITIONS) {
    const opt = document.createElement('option');
    opt.value = cond;
    opt.textContent = cond;
    select.appendChild(opt);
  }
}

function populateStatusOptions(select: HTMLSelectElement): void {
  for (const status of Object.keys(STATUS_LABELS) as HoldingStatus[]) {
    const opt = document.createElement('option');
    opt.value = status;
    opt.textContent = STATUS_LABELS[status];
    select.appendChild(opt);
  }
}

function populateSortOptions(select: HTMLSelectElement): void {
  for (const opt of SORT_OPTIONS) {
    const el = document.createElement('option');
    el.value = opt.value;
    el.textContent = opt.label;
    select.appendChild(el);
  }
  select.value = 'updated';
}

async function initialize(
  refs: ViewRefs,
  service: CollectionService,
  state: CollectionState,
): Promise<void> {
  await populateSetFilter(refs);
  await rerender(refs, service, state);
  // Skip updates if our DOM tree has been detached. Same pattern as
  // Browse + Card Detail — leaked listeners cannot write to a stale
  // tree (or, in tests, against a closed DB).
  window.addEventListener(USER_DATA_CHANGED_EVENT, () => {
    if (!refs.rowsRegion.isConnected) return;
    void rerender(refs, service, state);
  });
}

async function populateSetFilter(refs: ViewRefs): Promise<void> {
  const sets = await createSetsRepo(getDb()).list();
  const placeholder = refs.setFilter.querySelector('option');
  refs.setFilter.replaceChildren();
  if (placeholder !== null) refs.setFilter.appendChild(placeholder);
  const sorted = [...sets].sort((a, b) =>
    a.releaseDate < b.releaseDate ? 1 : -1,
  );
  for (const set of sorted) {
    const option = document.createElement('option');
    option.value = set.id;
    option.textContent = set.name;
    refs.setFilter.appendChild(option);
  }
}

function buildCriteria(state: CollectionState): CollectionCriteria {
  const filters: CollectionFilters = {};
  if (state.conditionType !== '') {
    (filters as { conditionType: CollectionFilters['conditionType'] }).conditionType =
      state.conditionType;
  }
  if (state.rawCondition !== '') {
    (filters as { rawCondition: CollectionFilters['rawCondition'] }).rawCondition =
      state.rawCondition;
  }
  if (state.setId !== '') {
    (filters as { setId: string }).setId = state.setId;
  }
  if (state.status !== '') {
    (filters as { status: HoldingStatus }).status = state.status;
  }
  if (state.missingCondition) {
    (filters as { missingCondition: true }).missingCondition = true;
  }
  if (state.missingValue) {
    (filters as { missingValue: true }).missingValue = true;
  }
  if (state.showDeleted) {
    (filters as { showDeleted: true }).showDeleted = true;
  }
  if (state.search.length > 0) {
    (filters as { search: string }).search = state.search;
  }
  return {
    ...filters,
    sort: state.sort,
    sortDirection: state.sortDirection,
    page: state.page,
    pageSize: state.pageSize,
  };
}

async function rerender(
  refs: ViewRefs,
  service: CollectionService,
  state: CollectionState,
): Promise<void> {
  const result = await service.list(buildCriteria(state));

  refs.countsRegion.textContent = `${result.liveTotal} aktive · ${result.deletedTotal} slettede · ${result.total} matcher filteret`;

  refs.rowsRegion.replaceChildren();
  if (result.rows.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 13;
    td.className = 'browse-table__empty-row';
    td.textContent = state.showDeleted
      ? 'Ingen slettede holdings.'
      : 'Ingen holdings matcher filteret.';
    tr.appendChild(td);
    refs.rowsRegion.appendChild(tr);
  } else {
    for (const row of result.rows) {
      refs.rowsRegion.appendChild(buildRow(row));
    }
  }

  const totalPages = Math.max(1, Math.ceil(result.total / state.pageSize));
  refs.pageSummary.textContent = `Side ${state.page + 1} av ${totalPages} — ${result.total} rader`;
  refs.prevButton.disabled = state.page === 0;
  refs.nextButton.disabled = state.page + 1 >= totalPages;
}

function buildRow(row: CollectionRow): HTMLTableRowElement {
  const tr = document.createElement('tr');
  tr.className = 'browse-table__row collection-table__row';
  tr.dataset['holdingId'] = row.holding.id;
  if (row.holding.deletedAt !== null) {
    tr.classList.add('collection-table__row--deleted');
  }

  // Image
  const imgCell = document.createElement('td');
  imgCell.appendChild(
    createLazyImage({
      src: row.card?.imageSmall ?? null,
      alt: row.card?.name ?? row.holding.cardId,
      width: 32,
      height: 44,
      className: 'browse-table__thumb',
    }),
  );
  tr.appendChild(imgCell);

  // Name (clickable to card detail)
  const nameCell = document.createElement('td');
  if (row.card !== null) {
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'collection-table__card-link';
    link.textContent = row.card.name;
    link.addEventListener('click', () => {
      navigateToCard(row.holding.cardId);
    });
    nameCell.appendChild(link);
  } else {
    nameCell.textContent = row.holding.cardId;
  }
  tr.appendChild(nameCell);

  // Set
  const setCell = document.createElement('td');
  setCell.textContent = row.set?.name ?? row.card?.setId ?? '–';
  tr.appendChild(setCell);

  // Number
  const numberCell = document.createElement('td');
  numberCell.textContent = row.card?.number ?? '–';
  tr.appendChild(numberCell);

  // Finish
  const finishCell = document.createElement('td');
  finishCell.textContent = row.holding.finish;
  tr.appendChild(finishCell);

  // Edition
  const editionCell = document.createElement('td');
  editionCell.textContent = row.holding.edition;
  tr.appendChild(editionCell);

  // Condition / Grade
  const conditionCell = document.createElement('td');
  conditionCell.textContent = describeCondition(row.holding);
  tr.appendChild(conditionCell);

  // Quantity
  const qtyCell = document.createElement('td');
  qtyCell.textContent = String(row.holding.quantity);
  tr.appendChild(qtyCell);

  // Manual value
  const valueCell = document.createElement('td');
  if (row.holding.estimatedValue !== null && row.holding.valueCurrency !== null) {
    valueCell.textContent = `${row.holding.estimatedValue.toFixed(2)} ${row.holding.valueCurrency}`;
  } else {
    valueCell.textContent = '–';
  }
  tr.appendChild(valueCell);

  // Status
  const statusCell = document.createElement('td');
  statusCell.textContent = STATUS_LABELS[row.holding.status];
  tr.appendChild(statusCell);

  // Tags
  const tagsCell = document.createElement('td');
  tagsCell.textContent = row.holding.tags.length > 0
    ? formatTags(row.holding.tags)
    : '–';
  tr.appendChild(tagsCell);

  // Updated
  const updatedCell = document.createElement('td');
  updatedCell.textContent = formatTimestamp(row.holding.updatedAt);
  tr.appendChild(updatedCell);

  // Actions
  const actionsCell = document.createElement('td');
  actionsCell.className = 'browse-table__actions';
  if (row.holding.deletedAt !== null) {
    const restore = makeActionButton('Gjenopprett', 'restore');
    actionsCell.appendChild(restore);
  } else {
    const edit = makeActionButton('Rediger', 'edit');
    actionsCell.appendChild(edit);
    const del = makeActionButton('Slett', 'soft-delete');
    del.classList.add('browse-table__action--danger');
    actionsCell.appendChild(del);
  }
  tr.appendChild(actionsCell);

  return tr;
}

function makeActionButton(label: string, action: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'browse-table__action';
  btn.dataset['action'] = action;
  btn.textContent = label;
  return btn;
}

function describeCondition(holding: HoldingRecord): string {
  if (holding.conditionType === 'graded') {
    const company = holding.gradingCompany ?? '?';
    const grade = holding.grade !== null ? holding.grade.toFixed(1) : '?';
    return `${company} ${grade}`;
  }
  return holding.rawCondition ?? '–';
}

function formatTimestamp(iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  return new Date(parsed).toISOString().slice(0, 10);
}

function attachEventListeners(
  refs: ViewRefs,
  service: CollectionService,
  state: CollectionState,
): void {
  let searchTimeout: ReturnType<typeof setTimeout> | null = null;

  refs.searchInput.addEventListener('input', () => {
    if (searchTimeout !== null) clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      state.search = refs.searchInput.value;
      state.page = 0;
      void rerender(refs, service, state);
    }, 150);
  });

  refs.conditionTypeFilter.addEventListener('change', () => {
    state.conditionType = refs.conditionTypeFilter.value as CollectionState['conditionType'];
    state.page = 0;
    void rerender(refs, service, state);
  });

  refs.rawConditionFilter.addEventListener('change', () => {
    state.rawCondition = refs.rawConditionFilter.value as CollectionState['rawCondition'];
    state.page = 0;
    void rerender(refs, service, state);
  });

  refs.setFilter.addEventListener('change', () => {
    state.setId = refs.setFilter.value;
    state.page = 0;
    void rerender(refs, service, state);
  });

  refs.statusFilter.addEventListener('change', () => {
    state.status = refs.statusFilter.value as CollectionState['status'];
    state.page = 0;
    void rerender(refs, service, state);
  });

  refs.sortSelect.addEventListener('change', () => {
    state.sort = refs.sortSelect.value as CollectionSort;
    state.page = 0;
    void rerender(refs, service, state);
  });

  refs.sortDirectionSelect.addEventListener('change', () => {
    state.sortDirection = refs.sortDirectionSelect.value as SortDirection;
    state.page = 0;
    void rerender(refs, service, state);
  });

  refs.pageSizeSelect.addEventListener('change', () => {
    state.pageSize = Number.parseInt(
      refs.pageSizeSelect.value,
      10,
    ) as CollectionPageSize;
    state.page = 0;
    void rerender(refs, service, state);
  });

  refs.missingConditionInput.addEventListener('change', () => {
    state.missingCondition = refs.missingConditionInput.checked;
    state.page = 0;
    void rerender(refs, service, state);
  });

  refs.missingValueInput.addEventListener('change', () => {
    state.missingValue = refs.missingValueInput.checked;
    state.page = 0;
    void rerender(refs, service, state);
  });

  refs.showDeletedInput.addEventListener('change', () => {
    state.showDeleted = refs.showDeletedInput.checked;
    state.page = 0;
    void rerender(refs, service, state);
  });

  refs.prevButton.addEventListener('click', () => {
    if (state.page > 0) {
      state.page -= 1;
      void rerender(refs, service, state);
    }
  });

  refs.nextButton.addEventListener('click', () => {
    state.page += 1;
    void rerender(refs, service, state);
  });

  refs.rowsRegion.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    if (target === null) return;
    const button = target.closest<HTMLButtonElement>('button[data-action]');
    if (button === null) return;
    const row = target.closest<HTMLTableRowElement>('.collection-table__row');
    if (row === null) return;
    const holdingId = row.dataset['holdingId'];
    if (holdingId === undefined) return;
    const action = button.dataset['action'];
    if (action === 'edit') {
      void handleEdit(holdingId, service, refs, state);
    } else if (action === 'soft-delete') {
      void handleSoftDelete(holdingId, service, refs, state);
    } else if (action === 'restore') {
      void handleRestore(holdingId, service, refs, state);
    }
  });
}

async function handleEdit(
  holdingId: string,
  service: CollectionService,
  refs: ViewRefs,
  state: CollectionState,
): Promise<void> {
  const repo = createHoldingsRepo(getDb());
  const holding = await repo.get(holdingId);
  if (holding === undefined) return;
  const result = await openDialog(buildHoldingForm({ mode: 'edit', holding }));
  if (result === 'submitted') {
    await rerender(refs, service, state);
  }
}

async function handleSoftDelete(
  holdingId: string,
  service: CollectionService,
  refs: ViewRefs,
  state: CollectionState,
): Promise<void> {
  const confirmed = window.confirm(
    'Slett dette kortet fra samlingen?\n\n' +
      'Holdingen merkes som slettet og kan gjenopprettes senere via "Vis slettede".',
  );
  if (!confirmed) return;
  await createHoldingsRepo(getDb()).softDelete(
    holdingId,
    'Soft-deleted from Collection view',
  );
  window.dispatchEvent(new CustomEvent(USER_DATA_CHANGED_EVENT));
  await rerender(refs, service, state);
}

async function handleRestore(
  holdingId: string,
  service: CollectionService,
  refs: ViewRefs,
  state: CollectionState,
): Promise<void> {
  await createHoldingsRepo(getDb()).restore(
    holdingId,
    'Restored from Collection view',
  );
  window.dispatchEvent(new CustomEvent(USER_DATA_CHANGED_EVENT));
  await rerender(refs, service, state);
}
