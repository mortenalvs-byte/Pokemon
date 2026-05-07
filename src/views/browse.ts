// Browse view. Reads the cached `cards` and `sets` stores. Now also
// reads `holdings` and `wishlist` (live only) for the
// owned/not-owned and on-wishlist filters, and can WRITE holdings or
// wishlist via the Add buttons — but only via explicit user clicks
// that go through `holdingsRepo` / `wishlistRepo`. Filter / sort /
// pagination / navigation paths still never write.

import { openDialog } from '../components/dialog';
import { onUserDataChanged, USER_DATA_CHANGED_EVENT } from '../components/events';
import { buildHoldingForm } from '../components/holding-form';
import { buildWishlistForm } from '../components/wishlist-form';
import { decideQuickAdd, type QuickAddDefault } from '../components/quick-add';
import { getDb } from '../db/database';
import { ValidationError } from '../domain/validators';
import { createCardsRepo } from '../repositories/cards-repo';
import { createHoldingsRepo } from '../repositories/holdings-repo';
import { createSetsRepo } from '../repositories/sets-repo';
import { createWishlistRepo } from '../repositories/wishlist-repo';
import {
  createBrowseService,
  type BrowseCardRow,
  type BrowsePageSize,
  type BrowseService,
  type BrowseSort,
  type OwnershipFilter,
  type SortDirection,
  type WishlistFilter,
} from '../services/browse-service';
import { navigate, navigateToCard } from '../router';
import { createLazyImage } from '../utils/lazy-image';

interface QuickAddFeedback {
  readonly kind: 'created' | 'merged' | 'error';
  readonly text: string;
}

interface BrowseState {
  search: string;
  setId: string;
  rarity: string;
  ownership: '' | OwnershipFilter;
  wishlist: '' | WishlistFilter;
  sort: BrowseSort;
  sortDirection: SortDirection;
  page: number;
  pageSize: BrowsePageSize;
  /**
   * PR 15B — per-card feedback chip state for Quick Add. Held on the
   * view state (not on the DOM) so a `USER_DATA_CHANGED_EVENT`
   * rerender re-applies it to the freshly built row instead of
   * wiping it.
   */
  quickAddFeedback: Map<string, QuickAddFeedback>;
}

const SEARCH_DEBOUNCE_MS = 150;

const SORT_OPTIONS: ReadonlyArray<{ readonly value: BrowseSort; readonly label: string }> = [
  { value: 'set-release', label: 'Sett-utgivelse' },
  { value: 'name', label: 'Navn' },
  { value: 'rarity', label: 'Rarity' },
  { value: 'set-number', label: 'Kortnummer' },
];

export function mountBrowseView(
  container: HTMLElement,
  signal?: AbortSignal,
): void {
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
          <span>Eier</span>
          <select data-region="ownership-filter">
            <option value="">Alle</option>
            <option value="owned">Eid</option>
            <option value="not-owned">Ikke eid</option>
          </select>
        </label>
        <label class="browse-view__field">
          <span>Ønskeliste</span>
          <select data-region="wishlist-filter">
            <option value="">Alle</option>
            <option value="on-wishlist">På ønskelisten</option>
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
    ownership: '',
    wishlist: '',
    sort: 'set-release',
    sortDirection: 'desc',
    page: 0,
    pageSize: 50,
    quickAddFeedback: new Map(),
  };

  const service = createBrowseService(
    createCardsRepo(getDb()),
    createSetsRepo(getDb()),
    createHoldingsRepo(getDb()),
    createWishlistRepo(getDb()),
  );

  void boot(refs, service, state);
  attachEventListeners(refs, service, state);
  // PR 15A — F-3: the router aborts `signal` on next route change, so
  // the listener is dropped automatically. The `isConnected` guard
  // remains as a belt-and-braces check for tests that don't pass a
  // signal.
  onUserDataChanged(() => {
    if (!container.isConnected) return;
    void rerenderRows(refs, service, state);
  }, signal);
}

interface ViewRefs {
  readonly emptyStateRegion: HTMLElement;
  readonly toolbar: HTMLElement;
  readonly searchInput: HTMLInputElement;
  readonly setFilter: HTMLSelectElement;
  readonly rarityFilter: HTMLSelectElement;
  readonly ownershipFilter: HTMLSelectElement;
  readonly wishlistFilter: HTMLSelectElement;
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
  const ownershipFilter = get<HTMLSelectElement>(
    '[data-region="ownership-filter"]',
  );
  const wishlistFilter = get<HTMLSelectElement>(
    '[data-region="wishlist-filter"]',
  );
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
    !ownershipFilter ||
    !wishlistFilter ||
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
    ownershipFilter,
    wishlistFilter,
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
    ...(state.ownership !== ''
      ? { ownership: state.ownership }
      : {}),
    ...(state.wishlist !== ''
      ? { wishlist: state.wishlist }
      : {}),
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
      refs.rowsRegion.appendChild(buildRow(row, state));
    }
  }

  const totalPages = Math.max(1, Math.ceil(result.total / state.pageSize));
  refs.pageSummary.textContent = `Side ${state.page + 1} av ${totalPages} — ${result.total} kort`;
  refs.prevButton.disabled = state.page === 0;
  refs.nextButton.disabled = state.page + 1 >= totalPages;
}

function buildRow(row: BrowseCardRow, state: BrowseState): HTMLTableRowElement {
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

  // PR 15B — Quick Add Raw. Single click adds a raw NM holding for
  // the row's verified default finish/edition via
  // `holdingsRepo.upsertByVariant`, so a second click on the same
  // card increments the quantity instead of creating a duplicate
  // row. Disabled when the card has no API-verified variant — the
  // user is sent to the full form for those.
  const quickAddDecision = decideQuickAdd(row.card);
  const quickAdd = document.createElement('button');
  quickAdd.type = 'button';
  quickAdd.dataset['action'] = 'quick-add-raw';
  quickAdd.className = 'browse-table__action browse-table__action--quick-add';
  quickAdd.textContent = '+1 raw';
  if (quickAddDecision.canQuickAdd && quickAddDecision.defaults !== null) {
    quickAdd.dataset['finish'] = quickAddDecision.defaults.finish;
    quickAdd.dataset['edition'] = quickAddDecision.defaults.edition;
    quickAdd.title = `Legg til 1 raw NM (${quickAddDecision.defaults.finish}, ${quickAddDecision.defaults.edition}). Klikk igjen for å øke antall.`;
  } else {
    quickAdd.disabled = true;
    quickAdd.title = quickAddDecision.reason;
  }
  actionsCell.appendChild(quickAdd);

  // Feedback chip rendered next to Quick Add. Empty until the first
  // click fires; cleared on a timeout. Persists across rerenders by
  // reading from `state.quickAddFeedback` so a USER_DATA_CHANGED_EVENT
  // refresh does not wipe the chip mid-animation.
  const feedback = document.createElement('span');
  feedback.className = 'browse-table__quick-add-feedback';
  feedback.dataset['region'] = 'quick-add-feedback';
  feedback.setAttribute('role', 'status');
  feedback.setAttribute('aria-live', 'polite');
  const persisted = state.quickAddFeedback.get(row.card.id);
  if (persisted !== undefined) {
    feedback.textContent = persisted.text;
    feedback.classList.add(`browse-table__quick-add-feedback--${persisted.kind}`);
  }
  actionsCell.appendChild(feedback);

  const addCollection = document.createElement('button');
  addCollection.type = 'button';
  addCollection.dataset['action'] = 'add-to-collection';
  addCollection.className = 'browse-table__action';
  addCollection.textContent = 'Legg til i samling';
  actionsCell.appendChild(addCollection);

  const addWishlist = document.createElement('button');
  addWishlist.type = 'button';
  addWishlist.dataset['action'] = 'add-to-wishlist';
  addWishlist.className = 'browse-table__action';
  addWishlist.textContent = 'Legg til i ønskeliste';
  actionsCell.appendChild(addWishlist);

  const detailButton = document.createElement('button');
  detailButton.type = 'button';
  detailButton.dataset['action'] = 'view-details';
  detailButton.className = 'browse-table__action';
  detailButton.textContent = 'Vis detaljer';
  actionsCell.appendChild(detailButton);
  tr.appendChild(actionsCell);

  return tr;
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

  refs.ownershipFilter.addEventListener('change', () => {
    const value = refs.ownershipFilter.value;
    state.ownership = value === 'owned' || value === 'not-owned' ? value : '';
    state.page = 0;
    void rerenderRows(refs, service, state);
  });

  refs.wishlistFilter.addEventListener('change', () => {
    const value = refs.wishlistFilter.value;
    state.wishlist = value === 'on-wishlist' ? value : '';
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

  // Row click → card detail. Disabled buttons stop early without
  // navigating. Action buttons handle their own behaviour:
  //   view-details → navigate to card detail
  //   add-to-collection → open holding form modal
  refs.rowsRegion.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    if (target === null) return;
    const button = target.closest<HTMLElement>('button');
    const row = target.closest<HTMLTableRowElement>('tr.browse-table__row');
    if (row === null) return;
    const cardId = row.dataset['cardId'];
    if (cardId === undefined || cardId.length === 0) return;

    if (button !== null) {
      if (button.matches(':disabled')) return;
      const action = button.dataset['action'];
      if (action === 'view-details') {
        navigateToCard(cardId);
        return;
      }
      if (action === 'add-to-collection') {
        void openAddToCollection(cardId);
        return;
      }
      if (action === 'add-to-wishlist') {
        void openAddToWishlist(cardId);
        return;
      }
      if (action === 'quick-add-raw') {
        const finish = button.dataset['finish'];
        const edition = button.dataset['edition'];
        if (finish === undefined || edition === undefined) return;
        void runQuickAddRaw(
          cardId,
          button,
          {
            finish: finish as QuickAddDefault['finish'],
            edition: edition as QuickAddDefault['edition'],
          },
          state,
          refs,
          service,
        );
        return;
      }
      // Unknown enabled button: do not navigate.
      return;
    }

    navigateToCard(cardId);
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

async function openAddToCollection(cardId: string): Promise<void> {
  await openDialog(buildHoldingForm({ mode: 'add', cardId }));
}

async function openAddToWishlist(cardId: string): Promise<void> {
  await openDialog(buildWishlistForm({ mode: 'add', cardId }));
}

const QUICK_ADD_FEEDBACK_TIMEOUT_MS = 2500;

/**
 * PR 15B Quick Add Raw. Builds a minimal raw-NM `HoldingInput` from
 * the row's verified defaults and calls `holdingsRepo.upsertByVariant`.
 * The repo runs the full variant validator at submit time, so a user
 * who tampered with the data attribute via devtools is rejected the
 * same way the holding form's repo bypass test in PR 13 confirms.
 *
 * The feedback chip next to the button shows:
 *   - "Lagt til" when a fresh holding row was created
 *   - "+N → M" (e.g. "+1 → 4") when an existing row's quantity grew
 *   - "Feil" when the repo throws (typically a `ValidationError`).
 *     The button's tooltip carries the message.
 */
async function runQuickAddRaw(
  cardId: string,
  button: HTMLElement,
  defaults: QuickAddDefault,
  state: BrowseState,
  refs: ViewRefs,
  service: BrowseService,
): Promise<void> {
  // Disable the button for the duration of the write so a double-tap
  // can't fire two requests against the same row.
  if (button instanceof HTMLButtonElement) button.disabled = true;
  try {
    const repo = createHoldingsRepo(getDb());
    const result = await repo.upsertByVariant({
      cardId,
      quantity: 1,
      conditionType: 'raw',
      rawCondition: 'NM',
      gradingCompany: null,
      grade: null,
      certNumber: null,
      certUrl: null,
      gradedDate: null,
      finish: defaults.finish,
      edition: defaults.edition,
      language: 'en',
      purchasePrice: null,
      purchaseCurrency: null,
      estimatedValue: null,
      valueCurrency: null,
      valueSource: 'unknown',
      valueNote: null,
      valueUpdatedAt: null,
      source: 'manual',
      note: null,
      specialVariant: false,
      tags: [],
      lotId: null,
      status: 'owned',
    });
    if (result.action === 'merged') {
      const previous = result.previousQuantity ?? 0;
      state.quickAddFeedback.set(cardId, {
        kind: 'merged',
        text: `+1 → ${result.holding.quantity} (var ${previous})`,
      });
    } else {
      state.quickAddFeedback.set(cardId, {
        kind: 'created',
        text: 'Lagt til',
      });
    }
    // Cross-view refresh: Card detail / Collection / Dashboard listen
    // for this. PR 15A's AbortController contract ensures only the
    // currently-mounted view re-renders. Browse's own listener also
    // fires — `buildRow` reads `state.quickAddFeedback` so the chip
    // survives the rerender.
    window.dispatchEvent(new CustomEvent(USER_DATA_CHANGED_EVENT));
  } catch (caught) {
    state.quickAddFeedback.set(cardId, { kind: 'error', text: 'Feil' });
    if (button instanceof HTMLButtonElement) {
      button.title =
        caught instanceof ValidationError
          ? `Quick Add avvist: ${caught.message}`
          : caught instanceof Error
            ? `Quick Add feilet: ${caught.message}`
            : 'Quick Add feilet av en ukjent grunn.';
    }
    // Trigger a Browse-only rerender to surface the chip even when
    // we did not dispatch USER_DATA_CHANGED_EVENT (no data was
    // written, so other views shouldn't refresh).
    void rerenderRows(refs, service, state);
  } finally {
    if (button instanceof HTMLButtonElement) button.disabled = false;
  }

  setTimeout(() => {
    state.quickAddFeedback.delete(cardId);
    // Only rerender if the Browse view is still mounted.
    if (refs.rowsRegion.isConnected) {
      void rerenderRows(refs, service, state);
    }
  }, QUICK_ADD_FEEDBACK_TIMEOUT_MS);
}
