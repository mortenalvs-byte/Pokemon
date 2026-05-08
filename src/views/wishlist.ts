// Wishlist view. Shows everything the user wants to buy, organize, or
// stop tracking. Reads via `wishlist-service` (joined with cards +
// sets) and drives Add/Edit/Remove/Restore through the wishlist form.
//
// Mutations always go through `wishlistRepo` from PR 3 (validators +
// audit). The view never calls `db.wishlist` directly.

import { openDialog } from '../components/dialog';
import { USER_DATA_CHANGED_EVENT, onUserDataChanged } from '../components/events';
import { buildWishlistForm } from '../components/wishlist-form';
import { getDb } from '../db/database';
import { navigateToCard } from '../router';
import { createCardsRepo } from '../repositories/cards-repo';
import { createSetsRepo } from '../repositories/sets-repo';
import { createWishlistRepo } from '../repositories/wishlist-repo';
import { isActiveWishlistStatus } from '../domain/wishlist-status';
import { markWishlistCandidatesReceived } from '../services/wishlist-receive-service';
import {
  createWishlistService,
  type WishlistCriteria,
  type WishlistFilters,
  type WishlistPageSize,
  type WishlistRow,
  type WishlistService,
  type WishlistSort,
  type SortDirection,
} from '../services/wishlist-service';
import { createLazyImage } from '../utils/lazy-image';
import type {
  WishlistPriority,
  WishlistStatus,
} from '../domain/types';

interface WishlistState {
  status: '' | WishlistStatus;
  priority: '' | WishlistPriority;
  setId: string;
  search: string;
  showDeleted: boolean;
  sort: WishlistSort;
  sortDirection: SortDirection;
  page: number;
  pageSize: WishlistPageSize;
}

const SORT_OPTIONS: ReadonlyArray<{
  readonly value: WishlistSort;
  readonly label: string;
}> = [
  { value: 'priority', label: 'Prioritet' },
  { value: 'name', label: 'Navn' },
  { value: 'set-release', label: 'Sett-utgivelse' },
  { value: 'updated', label: 'Sist endret' },
];

export const PRIORITY_LABELS: Record<WishlistPriority, string> = {
  grail: 'Grail',
  high: 'Høy',
  medium: 'Medium',
  low: 'Lav',
};

export const STATUS_LABELS: Record<WishlistStatus, string> = {
  wanted: 'Ønsket',
  ordered: 'Bestilt',
  received: 'Mottatt',
  cancelled: 'Avbrutt',
};

export function mountWishlistView(
  container: HTMLElement,
  signal?: AbortSignal,
): void {
  container.innerHTML = `
    <section class="wishlist-view" aria-labelledby="wishlist-heading">
      <h1 id="wishlist-heading">Ønskeliste</h1>
      <p class="wishlist-view__counts" data-region="counts"></p>
      <div class="wishlist-view__toolbar">
        <label class="browse-view__field">
          <span>Søk</span>
          <input type="search" data-region="search" placeholder="Kortnavn…" />
        </label>
        <label class="browse-view__field">
          <span>Status</span>
          <select data-region="status-filter">
            <option value="">Alle</option>
          </select>
        </label>
        <label class="browse-view__field">
          <span>Prioritet</span>
          <select data-region="priority-filter">
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
          <input type="checkbox" data-region="show-deleted" />
          <span>Vis slettede</span>
        </label>
      </div>
      <table class="browse-table wishlist-table" data-region="table">
        <thead>
          <tr>
            <th class="browse-table__image-col"></th>
            <th>Navn</th>
            <th>Sett</th>
            <th>#</th>
            <th>Finish</th>
            <th>Prioritet</th>
            <th>Måltilstand</th>
            <th>Målpris</th>
            <th>Status</th>
            <th>Notat</th>
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

  populateStatusOptions(refs.statusFilter);
  populatePriorityOptions(refs.priorityFilter);
  populateSortOptions(refs.sortSelect);

  const state: WishlistState = {
    status: '',
    priority: '',
    setId: '',
    search: '',
    showDeleted: false,
    sort: 'priority',
    sortDirection: 'desc',
    page: 0,
    pageSize: 50,
  };

  const db = getDb();
  const service = createWishlistService(
    createWishlistRepo(db),
    createCardsRepo(db),
    createSetsRepo(db),
  );

  void initialize(refs, service, state, signal);
  attachEventListeners(refs, service, state);
}

interface ViewRefs {
  readonly countsRegion: HTMLElement;
  readonly searchInput: HTMLInputElement;
  readonly statusFilter: HTMLSelectElement;
  readonly priorityFilter: HTMLSelectElement;
  readonly setFilter: HTMLSelectElement;
  readonly sortSelect: HTMLSelectElement;
  readonly sortDirectionSelect: HTMLSelectElement;
  readonly pageSizeSelect: HTMLSelectElement;
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
  const statusFilter = get<HTMLSelectElement>('[data-region="status-filter"]');
  const priorityFilter = get<HTMLSelectElement>(
    '[data-region="priority-filter"]',
  );
  const setFilter = get<HTMLSelectElement>('[data-region="set-filter"]');
  const sortSelect = get<HTMLSelectElement>('[data-region="sort"]');
  const sortDirectionSelect = get<HTMLSelectElement>(
    '[data-region="sort-direction"]',
  );
  const pageSizeSelect = get<HTMLSelectElement>('[data-region="page-size"]');
  const showDeletedInput = get<HTMLInputElement>('[data-region="show-deleted"]');
  const rowsRegion = get<HTMLElement>('[data-region="rows"]');
  const pageSummary = get<HTMLElement>('[data-region="page-summary"]');
  const prevButton = get<HTMLButtonElement>('[data-action="prev-page"]');
  const nextButton = get<HTMLButtonElement>('[data-action="next-page"]');

  if (
    !countsRegion ||
    !searchInput ||
    !statusFilter ||
    !priorityFilter ||
    !setFilter ||
    !sortSelect ||
    !sortDirectionSelect ||
    !pageSizeSelect ||
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
    statusFilter,
    priorityFilter,
    setFilter,
    sortSelect,
    sortDirectionSelect,
    pageSizeSelect,
    showDeletedInput,
    rowsRegion,
    pageSummary,
    prevButton,
    nextButton,
  };
}

function populateStatusOptions(select: HTMLSelectElement): void {
  for (const status of Object.keys(STATUS_LABELS) as WishlistStatus[]) {
    const opt = document.createElement('option');
    opt.value = status;
    opt.textContent = STATUS_LABELS[status];
    select.appendChild(opt);
  }
}

function populatePriorityOptions(select: HTMLSelectElement): void {
  for (const priority of Object.keys(PRIORITY_LABELS) as WishlistPriority[]) {
    const opt = document.createElement('option');
    opt.value = priority;
    opt.textContent = PRIORITY_LABELS[priority];
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
  select.value = 'priority';
}

async function initialize(
  refs: ViewRefs,
  service: WishlistService,
  state: WishlistState,
  signal: AbortSignal | undefined,
): Promise<void> {
  await populateSetFilter(refs);
  await rerender(refs, service, state);
  // PR 15A — F-3: router signal drops this listener on next route.
  onUserDataChanged(() => {
    if (!refs.rowsRegion.isConnected) return;
    void rerender(refs, service, state);
  }, signal);
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

function buildCriteria(state: WishlistState): WishlistCriteria {
  const filters: WishlistFilters = {};
  if (state.status !== '') {
    (filters as { status: WishlistStatus }).status = state.status;
  }
  if (state.priority !== '') {
    (filters as { priority: WishlistPriority }).priority = state.priority;
  }
  if (state.setId !== '') {
    (filters as { setId: string }).setId = state.setId;
  }
  if (state.search.length > 0) {
    (filters as { search: string }).search = state.search;
  }
  if (state.showDeleted) {
    (filters as { showDeleted: true }).showDeleted = true;
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
  service: WishlistService,
  state: WishlistState,
): Promise<void> {
  const result = await service.list(buildCriteria(state));

  // PR 22 — split counts so the user can see active (wanted/ordered)
  // vs closed (received/cancelled) at a glance.
  refs.countsRegion.textContent =
    `Aktive: ${result.activeTotal} ` +
    `(Ønsket: ${result.statusCounts.wanted} · Bestilt: ${result.statusCounts.ordered}) · ` +
    `Mottatt: ${result.statusCounts.received} · ` +
    `Avbrutt: ${result.statusCounts.cancelled} · ` +
    `Slettede: ${result.deletedTotal} · ` +
    `Matcher filteret: ${result.total}`;

  refs.rowsRegion.replaceChildren();
  if (result.rows.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 12;
    td.className = 'browse-table__empty-row';
    td.textContent = state.showDeleted
      ? 'Ingen slettede ønskeliste-oppføringer.'
      : result.liveTotal === 0
        ? 'Ønskelisten er tom. Bruk "Legg til i ønskeliste" fra Browse eller Card Detail.'
        : 'Ingen oppføringer matcher filteret.';
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

function buildRow(row: WishlistRow): HTMLTableRowElement {
  const tr = document.createElement('tr');
  tr.className = 'browse-table__row wishlist-table__row';
  tr.dataset['wishlistId'] = row.wishlist.id;
  if (row.wishlist.deletedAt !== null) {
    tr.classList.add('wishlist-table__row--deleted');
  }

  const imgCell = document.createElement('td');
  imgCell.appendChild(
    createLazyImage({
      src: row.card?.imageSmall ?? null,
      alt: row.card?.name ?? row.wishlist.cardId,
      width: 32,
      height: 44,
      className: 'browse-table__thumb',
    }),
  );
  tr.appendChild(imgCell);

  const nameCell = document.createElement('td');
  if (row.card !== null) {
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'collection-table__card-link';
    link.textContent = row.card.name;
    link.addEventListener('click', () => {
      navigateToCard(row.wishlist.cardId);
    });
    nameCell.appendChild(link);
  } else {
    nameCell.textContent = row.wishlist.cardId;
  }
  tr.appendChild(nameCell);

  appendCell(tr, row.set?.name ?? row.card?.setId ?? '–');
  appendCell(tr, row.card?.number ?? '–');
  appendCell(tr, row.wishlist.finish);
  appendCell(tr, PRIORITY_LABELS[row.wishlist.priority]);
  appendCell(tr, row.wishlist.targetCondition ?? '–');
  appendCell(
    tr,
    row.wishlist.targetPrice !== null && row.wishlist.targetCurrency !== null
      ? `${row.wishlist.targetPrice.toFixed(2)} ${row.wishlist.targetCurrency}`
      : '–',
  );
  appendCell(tr, STATUS_LABELS[row.wishlist.status]);
  appendCell(tr, row.wishlist.note ?? '–');
  appendCell(tr, formatTimestamp(row.wishlist.updatedAt));

  const actionsCell = document.createElement('td');
  actionsCell.className = 'browse-table__actions';
  if (row.wishlist.deletedAt !== null) {
    const restore = makeActionButton('Gjenopprett', 'restore');
    actionsCell.appendChild(restore);
  } else {
    const edit = makeActionButton('Rediger', 'edit');
    actionsCell.appendChild(edit);
    // PR 22 — Marker mottatt only for active rows (wanted/ordered).
    // Received/cancelled rows already closed; restore via edit if
    // needed.
    if (isActiveWishlistStatus(row.wishlist.status)) {
      const received = makeActionButton('Marker mottatt', 'mark-received');
      received.classList.add('browse-table__action--success');
      actionsCell.appendChild(received);
    }
    const remove = makeActionButton('Fjern', 'soft-delete');
    remove.classList.add('browse-table__action--danger');
    actionsCell.appendChild(remove);
  }
  tr.appendChild(actionsCell);

  return tr;
}

function appendCell(tr: HTMLTableRowElement, value: string): void {
  const td = document.createElement('td');
  td.textContent = value;
  tr.appendChild(td);
}

function makeActionButton(label: string, action: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'browse-table__action';
  btn.dataset['action'] = action;
  btn.textContent = label;
  return btn;
}

function formatTimestamp(iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  return new Date(parsed).toISOString().slice(0, 10);
}

function attachEventListeners(
  refs: ViewRefs,
  service: WishlistService,
  state: WishlistState,
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

  refs.statusFilter.addEventListener('change', () => {
    state.status = refs.statusFilter.value as WishlistState['status'];
    state.page = 0;
    void rerender(refs, service, state);
  });

  refs.priorityFilter.addEventListener('change', () => {
    state.priority = refs.priorityFilter.value as WishlistState['priority'];
    state.page = 0;
    void rerender(refs, service, state);
  });

  refs.setFilter.addEventListener('change', () => {
    state.setId = refs.setFilter.value;
    state.page = 0;
    void rerender(refs, service, state);
  });

  refs.sortSelect.addEventListener('change', () => {
    state.sort = refs.sortSelect.value as WishlistSort;
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
    ) as WishlistPageSize;
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
    const row = target.closest<HTMLTableRowElement>('.wishlist-table__row');
    if (row === null) return;
    const wishlistId = row.dataset['wishlistId'];
    if (wishlistId === undefined) return;
    const action = button.dataset['action'];
    if (action === 'edit') {
      void handleEdit(wishlistId, refs, service, state);
    } else if (action === 'soft-delete') {
      void handleSoftDelete(wishlistId, refs, service, state);
    } else if (action === 'restore') {
      void handleRestore(wishlistId, refs, service, state);
    } else if (action === 'mark-received') {
      void handleMarkReceived(wishlistId, refs, service, state);
    }
  });
}

async function handleEdit(
  wishlistId: string,
  refs: ViewRefs,
  service: WishlistService,
  state: WishlistState,
): Promise<void> {
  const repo = createWishlistRepo(getDb());
  const entry = await repo.get(wishlistId);
  if (entry === undefined) return;
  const result = await openDialog(buildWishlistForm({ mode: 'edit', entry }));
  if (result === 'submitted') {
    await rerender(refs, service, state);
  }
}

async function handleSoftDelete(
  wishlistId: string,
  refs: ViewRefs,
  service: WishlistService,
  state: WishlistState,
): Promise<void> {
  const confirmed = window.confirm(
    'Fjern denne oppføringen fra ønskelisten?\n\n' +
      'Oppføringen merkes som slettet og kan gjenopprettes via "Vis slettede".',
  );
  if (!confirmed) return;
  await createWishlistRepo(getDb()).softDelete(
    wishlistId,
    'Soft-deleted from Wishlist view',
  );
  window.dispatchEvent(new CustomEvent(USER_DATA_CHANGED_EVENT));
  await rerender(refs, service, state);
}

async function handleRestore(
  wishlistId: string,
  refs: ViewRefs,
  service: WishlistService,
  state: WishlistState,
): Promise<void> {
  await createWishlistRepo(getDb()).restore(
    wishlistId,
    'Restored from Wishlist view',
  );
  window.dispatchEvent(new CustomEvent(USER_DATA_CHANGED_EVENT));
  await rerender(refs, service, state);
}

// PR 22 — flip a single active wishlist row to `received`. Goes
// through the same `markWishlistCandidatesReceived` helper as the
// post-create receive prompt so audit + validators stay consistent.
async function handleMarkReceived(
  wishlistId: string,
  refs: ViewRefs,
  service: WishlistService,
  state: WishlistState,
): Promise<void> {
  await markWishlistCandidatesReceived(
    createWishlistRepo(getDb()),
    [wishlistId],
    'Marked received from Wishlist view',
  );
  window.dispatchEvent(new CustomEvent(USER_DATA_CHANGED_EVENT));
  await rerender(refs, service, state);
}
