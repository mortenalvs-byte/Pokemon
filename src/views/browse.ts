// Browse view. Read-only over the cached `cards` and `sets` stores —
// never reads or writes any user-owned store. Every dynamic field is
// rendered with `textContent` / `createElement`, so card names that
// contain HTML metacharacters cannot affect the DOM.
//
// Quick-action buttons for "Add to collection" / "Add to wishlist" are
// rendered disabled with a "kommer i PR 7" tooltip; clicking them does
// nothing and crucially does not navigate to card detail.

import { getDb } from '../db/database';
import { createCardsRepo } from '../repositories/cards-repo';
import { createSetsRepo } from '../repositories/sets-repo';
import {
  createBrowseService,
  type BrowseCardRow,
  type BrowsePageSize,
  type BrowseService,
  type BrowseSort,
  type SortDirection,
} from '../services/browse-service';
import { navigate, navigateToCard } from '../router';
import { createLazyImage } from '../utils/lazy-image';

interface BrowseState {
  search: string;
  setId: string;
  rarity: string;
  sort: BrowseSort;
  sortDirection: SortDirection;
  page: number;
  pageSize: BrowsePageSize;
}

const SEARCH_DEBOUNCE_MS = 150;

const SORT_OPTIONS: ReadonlyArray<{ readonly value: BrowseSort; readonly label: string }> = [
  { value: 'set-release', label: 'Sett-utgivelse' },
  { value: 'name', label: 'Navn' },
  { value: 'rarity', label: 'Rarity' },
  { value: 'set-number', label: 'Kortnummer' },
];

export function mountBrowseView(container: HTMLElement): void {
  container.innerHTML = `
    <section class="browse-view" aria-labelledby="browse-heading">
      <h1 id="browse-heading">Browse</h1>
      <div data-region="empty-state"></div>
      <div class="browse-view__toolbar" data-region="toolbar" hidden>
        <label class="browse-view__field">
          <span>Søk</span>
          <input type="search" data-region="search" placeholder="Kortnavn…" />
        </label>
        <label class="browse-view__field">
          <span>Sett</span>
          <select data-region="set-filter">
            <option value="">Alle sett</option>
          </select>
        </label>
        <label class="browse-view__field">
          <span>Rarity</span>
          <select data-region="rarity-filter">
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
      </div>
      <table class="browse-table" data-region="table" hidden>
        <thead>
          <tr>
            <th scope="col" class="browse-table__image-col"></th>
            <th scope="col">Navn</th>
            <th scope="col">Sett</th>
            <th scope="col">Nummer</th>
            <th scope="col">Rarity</th>
            <th scope="col" class="browse-table__actions-col">Handlinger</th>
          </tr>
        </thead>
        <tbody data-region="rows"></tbody>
      </table>
      <nav class="browse-view__pagination" data-region="pagination" aria-label="Sidenavigasjon" hidden>
        <button type="button" data-action="prev-page">Forrige</button>
        <span data-region="page-summary"></span>
        <button type="button" data-action="next-page">Neste</button>
      </nav>
    </section>
  `;

  const refs = collectRefs(container);
  if (refs === null) return;
  populateSortOptions(refs.sortSelect);

  const state: BrowseState = {
    search: '',
    setId: '',
    rarity: '',
    sort: 'set-release',
    sortDirection: 'desc',
    page: 0,
    pageSize: 50,
  };

  const service = createBrowseService(
    createCardsRepo(getDb()),
    createSetsRepo(getDb()),
  );

  void boot(refs, service, state);
  attachEventListeners(refs, service, state);
}

interface ViewRefs {
  readonly emptyStateRegion: HTMLElement;
  readonly toolbar: HTMLElement;
  readonly searchInput: HTMLInputElement;
  readonly setFilter: HTMLSelectElement;
  readonly rarityFilter: HTMLSelectElement;
  readonly sortSelect: HTMLSelectElement;
  readonly sortDirectionSelect: HTMLSelectElement;
  readonly pageSizeSelect: HTMLSelectElement;
  readonly tableRegion: HTMLElement;
  readonly rowsRegion: HTMLElement;
  readonly paginationRegion: HTMLElement;
  readonly pageSummary: HTMLElement;
  readonly prevButton: HTMLButtonElement;
  readonly nextButton: HTMLButtonElement;
}

function collectRefs(container: HTMLElement): ViewRefs | null {
  const get = <T extends HTMLElement>(selector: string): T | null =>
    container.querySelector<T>(selector);

  const emptyStateRegion = get<HTMLElement>('[data-region="empty-state"]');
  const toolbar = get<HTMLElement>('[data-region="toolbar"]');
  const searchInput = get<HTMLInputElement>('[data-region="search"]');
  const setFilter = get<HTMLSelectElement>('[data-region="set-filter"]');
  const rarityFilter = get<HTMLSelectElement>('[data-region="rarity-filter"]');
  const sortSelect = get<HTMLSelectElement>('[data-region="sort"]');
  const sortDirectionSelect = get<HTMLSelectElement>('[data-region="sort-direction"]');
  const pageSizeSelect = get<HTMLSelectElement>('[data-region="page-size"]');
  const tableRegion = get<HTMLElement>('[data-region="table"]');
  const rowsRegion = get<HTMLElement>('[data-region="rows"]');
  const paginationRegion = get<HTMLElement>('[data-region="pagination"]');
  const pageSummary = get<HTMLElement>('[data-region="page-summary"]');
  const prevButton = get<HTMLButtonElement>('[data-action="prev-page"]');
  const nextButton = get<HTMLButtonElement>('[data-action="next-page"]');

  if (
    !emptyStateRegion ||
    !toolbar ||
    !searchInput ||
    !setFilter ||
    !rarityFilter ||
    !sortSelect ||
    !sortDirectionSelect ||
    !pageSizeSelect ||
    !tableRegion ||
    !rowsRegion ||
    !paginationRegion ||
    !pageSummary ||
    !prevButton ||
    !nextButton
  ) {
    return null;
  }

  return {
    emptyStateRegion,
    toolbar,
    searchInput,
    setFilter,
    rarityFilter,
    sortSelect,
    sortDirectionSelect,
    pageSizeSelect,
    tableRegion,
    rowsRegion,
    paginationRegion,
    pageSummary,
    prevButton,
    nextButton,
  };
}

function populateSortOptions(select: HTMLSelectElement): void {
  for (const option of SORT_OPTIONS) {
    const el = document.createElement('option');
    el.value = option.value;
    el.textContent = option.label;
    select.appendChild(el);
  }
  select.value = 'set-release';
}

async function boot(
  refs: ViewRefs,
  service: BrowseService,
  state: BrowseState,
): Promise<void> {
  const totalCards = await service.countTotalCards();
  if (totalCards === 0) {
    showEmptyState(refs);
    return;
  }
  showWorkspace(refs);
  await Promise.all([
    populateSetFilter(refs, service),
    populateRarityFilter(refs, service),
  ]);
  await rerenderRows(refs, service, state);
}

function showEmptyState(refs: ViewRefs): void {
  refs.emptyStateRegion.replaceChildren();
  const wrap = document.createElement('div');
  wrap.className = 'browse-view__empty';

  const message = document.createElement('p');
  message.textContent =
    'Ingen kort synket ennå. Gå til Innstillinger og kjør første synk.';
  wrap.appendChild(message);

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'browse-view__empty-action';
  button.textContent = 'Til Innstillinger';
  button.addEventListener('click', () => {
    navigate('settings');
  });
  wrap.appendChild(button);

  refs.emptyStateRegion.appendChild(wrap);
  refs.toolbar.hidden = true;
  refs.tableRegion.hidden = true;
  refs.paginationRegion.hidden = true;
}

function showWorkspace(refs: ViewRefs): void {
  refs.emptyStateRegion.replaceChildren();
  refs.toolbar.hidden = false;
  refs.tableRegion.hidden = false;
  refs.paginationRegion.hidden = false;
}

async function populateSetFilter(
  refs: ViewRefs,
  service: BrowseService,
): Promise<void> {
  const sets = await service.listSetsForFilter();
  const placeholder = refs.setFilter.querySelector('option');
  refs.setFilter.replaceChildren();
  if (placeholder !== null) {
    refs.setFilter.appendChild(placeholder);
  }
  for (const set of sets) {
    const option = document.createElement('option');
    option.value = set.id;
    option.textContent = set.name;
    refs.setFilter.appendChild(option);
  }
}

async function populateRarityFilter(
  refs: ViewRefs,
  service: BrowseService,
): Promise<void> {
  const rarities = await service.listRaritiesForFilter();
  const placeholder = refs.rarityFilter.querySelector('option');
  refs.rarityFilter.replaceChildren();
  if (placeholder !== null) {
    refs.rarityFilter.appendChild(placeholder);
  }
  for (const rarity of rarities) {
    const option = document.createElement('option');
    option.value = rarity;
    option.textContent = rarity;
    refs.rarityFilter.appendChild(option);
  }
}

async function rerenderRows(
  refs: ViewRefs,
  service: BrowseService,
  state: BrowseState,
): Promise<void> {
  const result = await service.browse({
    search: state.search,
    setId: state.setId,
    rarity: state.rarity,
    sort: state.sort,
    sortDirection: state.sortDirection,
    page: state.page,
    pageSize: state.pageSize,
  });

  refs.rowsRegion.replaceChildren();
  if (result.rows.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 6;
    td.className = 'browse-table__empty-row';
    td.textContent = 'Ingen kort matcher filtrene.';
    tr.appendChild(td);
    refs.rowsRegion.appendChild(tr);
  } else {
    for (const row of result.rows) {
      refs.rowsRegion.appendChild(buildRow(row));
    }
  }

  const totalPages = Math.max(1, Math.ceil(result.total / state.pageSize));
  refs.pageSummary.textContent = `Side ${state.page + 1} av ${totalPages} — ${result.total} kort`;
  refs.prevButton.disabled = state.page === 0;
  refs.nextButton.disabled = state.page + 1 >= totalPages;
}

function buildRow(row: BrowseCardRow): HTMLTableRowElement {
  const tr = document.createElement('tr');
  tr.className = 'browse-table__row';
  tr.dataset['cardId'] = row.card.id;
  tr.tabIndex = 0;
  tr.setAttribute('role', 'button');
  tr.setAttribute('aria-label', `Vis detaljer for ${row.card.name}`);

  // Image cell
  const imageCell = document.createElement('td');
  const image = createLazyImage({
    src: row.card.imageSmall,
    alt: row.card.name,
    width: 32,
    height: 44,
    className: 'browse-table__thumb',
  });
  imageCell.appendChild(image);
  tr.appendChild(imageCell);

  // Name
  const nameCell = document.createElement('td');
  nameCell.textContent = row.card.name;
  tr.appendChild(nameCell);

  // Set
  const setCell = document.createElement('td');
  setCell.textContent = row.set?.name ?? row.card.setId;
  tr.appendChild(setCell);

  // Number
  const numberCell = document.createElement('td');
  numberCell.textContent = row.card.number;
  tr.appendChild(numberCell);

  // Rarity
  const rarityCell = document.createElement('td');
  rarityCell.textContent = row.card.rarity ?? '–';
  tr.appendChild(rarityCell);

  // Actions
  const actionsCell = document.createElement('td');
  actionsCell.className = 'browse-table__actions';
  actionsCell.appendChild(buildDisabledQuickAction('Legg til i samling'));
  actionsCell.appendChild(buildDisabledQuickAction('Legg til i ønskeliste'));
  const detailButton = document.createElement('button');
  detailButton.type = 'button';
  detailButton.dataset['action'] = 'view-details';
  detailButton.className = 'browse-table__action';
  detailButton.textContent = 'Vis detaljer';
  actionsCell.appendChild(detailButton);
  tr.appendChild(actionsCell);

  return tr;
}

function buildDisabledQuickAction(label: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'browse-table__action browse-table__action--disabled';
  btn.disabled = true;
  btn.title = `${label} — kommer i PR 7`;
  btn.textContent = label;
  return btn;
}

function attachEventListeners(
  refs: ViewRefs,
  service: BrowseService,
  state: BrowseState,
): void {
  let searchTimeout: ReturnType<typeof setTimeout> | null = null;

  refs.searchInput.addEventListener('input', () => {
    if (searchTimeout !== null) {
      clearTimeout(searchTimeout);
    }
    searchTimeout = setTimeout(() => {
      state.search = refs.searchInput.value;
      state.page = 0;
      void rerenderRows(refs, service, state);
    }, SEARCH_DEBOUNCE_MS);
  });

  refs.setFilter.addEventListener('change', () => {
    state.setId = refs.setFilter.value;
    state.page = 0;
    void rerenderRows(refs, service, state);
  });

  refs.rarityFilter.addEventListener('change', () => {
    state.rarity = refs.rarityFilter.value;
    state.page = 0;
    void rerenderRows(refs, service, state);
  });

  refs.sortSelect.addEventListener('change', () => {
    state.sort = refs.sortSelect.value as BrowseSort;
    state.page = 0;
    void rerenderRows(refs, service, state);
  });

  refs.sortDirectionSelect.addEventListener('change', () => {
    state.sortDirection = refs.sortDirectionSelect.value as SortDirection;
    state.page = 0;
    void rerenderRows(refs, service, state);
  });

  refs.pageSizeSelect.addEventListener('change', () => {
    state.pageSize = Number.parseInt(refs.pageSizeSelect.value, 10) as BrowsePageSize;
    state.page = 0;
    void rerenderRows(refs, service, state);
  });

  refs.prevButton.addEventListener('click', () => {
    if (state.page > 0) {
      state.page -= 1;
      void rerenderRows(refs, service, state);
    }
  });

  refs.nextButton.addEventListener('click', () => {
    state.page += 1;
    void rerenderRows(refs, service, state);
  });

  // Row click → card detail. Disabled buttons inside the row stop
  // propagation, so they do not navigate. The View details button has
  // a non-disabled handler that also navigates.
  refs.rowsRegion.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    if (target === null) return;
    const button = target.closest<HTMLElement>('button');
    if (button !== null) {
      const isDisabled = button.matches(':disabled');
      if (isDisabled) {
        return;
      }
      const action = button.dataset['action'];
      if (action !== 'view-details') {
        return;
      }
    }
    const row = target.closest<HTMLTableRowElement>('tr.browse-table__row');
    if (row === null) return;
    const cardId = row.dataset['cardId'];
    if (cardId !== undefined && cardId.length > 0) {
      navigateToCard(cardId);
    }
  });

  refs.rowsRegion.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const target = event.target as HTMLElement | null;
    if (target === null) return;
    const row = target.closest<HTMLTableRowElement>('tr.browse-table__row');
    if (row === null) return;
    if (row !== target) return; // only fire when the row itself is focused
    event.preventDefault();
    const cardId = row.dataset['cardId'];
    if (cardId !== undefined && cardId.length > 0) {
      navigateToCard(cardId);
    }
  });
}
