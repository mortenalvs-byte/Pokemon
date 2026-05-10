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

import { USER_DATA_CHANGED_EVENT, onUserDataChanged } from '../components/events';
import { getDb } from '../db/database';
import {
  getCurrentBinderId,
  getCurrentBinderSlotFocus,
  navigate,
  navigateToMasterGapBinder,
} from '../router';
import { createBindersRepo } from '../repositories/binders-repo';
import { createBinderSlotsRepo } from '../repositories/binder-slots-repo';
import { createCardsRepo } from '../repositories/cards-repo';
import { createHoldingsRepo } from '../repositories/holdings-repo';
import {
  autoAssignBinder,
  buildAutoPlacementPlan,
  type AutoAssignResult,
  type AutoPlacementPlan,
} from '../services/binder-assignment-service';
import {
  createBinderSlotService,
  type BinderDetail,
} from '../services/binder-slot-service';
import type { BinderSlotRecord } from '../domain/types';
// PR 34 — async dialog/handler routines lifted to a sibling module.
import {
  handleExportCsv,
  populateGapBanner,
} from './binder-detail-actions';
// PR 34 — pure helpers / label maps / types lifted to a sibling
// module so this orchestrator stays focused on mount + state +
// async actions.
import {
  CHECKLIST_PAGE_SIZE,
  FILTER_LABELS,
  appendMessage,
  computeAssignableInfo,
  focusSlotInDom,
  makeToggleButton,
  slotMatchesFilter,
  slotMatchesSearch,
} from './binder-detail-helpers';
import type {
  AssignableSlotInfo,
  SlotFilter,
  ViewMode,
} from './binder-detail-helpers';
// PR 34 — pure render builders (state-coupled wrappers stay below).
import {
  buildChecklistRow,
  buildGapBannerSkeleton,
  buildPage,
  buildSummary,
} from './binder-detail-render';

interface ViewState {
  mode: ViewMode;
  filter: SlotFilter;
  /**
   * PR 17 — free-text search inside the binder. Uses the shared
   * `cardMatchesQuery` predicate (PR 15A — F-6) against the card
   * resolved for each slot via `resolveCardForSlot`. Empty string
   * matches everything.
   */
  search: string;
  /**
   * PR 20 — Sider mode currently-rendered page (1-indexed). The
   * physical-binder model already pages by sheet, so we render only
   * the current page's slots instead of the whole 1088-slot DOM
   * tree. Filter / search still operate across all pages — when the
   * filter excludes the current page entirely, we jump to the first
   * page that has matching slots.
   *
   * Sjekkliste mode does not use this — it is a flat table sorted
   * by physical slot order. PR 20 paginates Sjekkliste at 50 rows
   * per page via `checklistPage`.
   */
  pagesPage: number;
  /**
   * PR 20 — Sjekkliste mode currently-rendered page (0-indexed),
   * 50 rows per page.
   */
  checklistPage: number;
  /**
   * PR 20 — cached `BinderDetail` for the current binder. Pagination
   * clicks (Forrige / Neste / mode toggle / filter / search) reuse
   * this instead of re-fetching the entire 20k-card cards repo via
   * `binder-slot-service.getDetail`. `null` means "needs fetch on
   * next render". `USER_DATA_CHANGED_EVENT` invalidates by setting
   * this back to `null`, so user-data writes still see fresh data.
   */
  cachedDetail: BinderDetail | null;
  /**
   * PR 24 — per-slot assignable-holding info, computed once per
   * `BinderDetail` load. Keys are slot ids; values describe how many
   * unassigned live holdings could fill the slot under the v1 rules
   * (cardId match, finish-aware reverse template). The single
   * `eligibleHoldingId` is set only when `count === 1` so the per-row
   * "Plasser" action knows which holding to assign without re-asking
   * the service.
   */
  assignableInfo: Map<string, AssignableSlotInfo> | null;
  /**
   * PR 24 — last auto-assign result banner. Cleared when the user
   * dismisses or re-runs auto-assign.
   */
  autoAssignSummary: AutoAssignResult | null;
  /**
   * PR 29 review patch — single source of truth for auto-placement.
   * The plan classifies every slot into safe / ambiguous / wrongVariant /
   * noHolding / alreadyOwned / noTarget. The auto-button label reads
   * `plan.safe.length` directly so it matches the gap-banner
   * `canPlaceDirectly` and the actual `autoAssignBinder` result.
   * `null` means "needs (re)build on next render".
   */
  placementPlan: AutoPlacementPlan | null;
  /**
   * PR 20 review patch — consume-once deep-link guard. The URL hash
   * `#binder/<id>/slot/<slotId>` is read on every render, but the
   * page-jump should fire ONLY the first time we see a given
   * slotId. Without this, the user could not click Forrige / Neste
   * to leave the deep-link's page (every render would force
   * `pagesPage` back to the slot's page).
   *
   * `null` means "no deep-link has been consumed yet (or hash has
   * no slot suffix)". Set to the active slotId on first render that
   * sees it; reset to `null` when the hash drops the slot suffix.
   */
  consumedSlotFocusId: string | null;
}

export function mountBinderDetailView(
  container: HTMLElement,
  signal?: AbortSignal,
): void {
  // Per-mount view state so toggles survive USER_DATA_CHANGED_EVENT
  // refreshes but reset when the route is unmounted.
  const state: ViewState = {
    mode: 'pages',
    filter: 'all',
    search: '',
    pagesPage: 1,
    checklistPage: 0,
    cachedDetail: null,
    assignableInfo: null,
    autoAssignSummary: null,
    placementPlan: null,
    consumedSlotFocusId: null,
  };

  void renderInto(container, state);

  // PR 15A — F-3: router signal drops this listener on next route.
  // PR 20: a user-data change must invalidate the cached BinderDetail
  // so the next render sees fresh holdings/slots. Pagination /
  // filter / search clicks reuse the cache; only writes punch
  // through.
  const refresh = (): void => {
    if (!container.isConnected) return;
    state.cachedDetail = null;
    state.assignableInfo = null;
    state.placementPlan = null;
    void renderInto(container, state);
  };
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

  // PR 20 — reuse the cached BinderDetail when available. Pagination
  // / filter / search / mode-toggle hit this path; only the initial
  // mount and `USER_DATA_CHANGED_EVENT` (which sets cachedDetail to
  // null) trigger the slow `getDetail` call. For a 1088-slot binder
  // with 20k cards in cache, the difference is roughly ~1 s vs
  // ~10 ms per click.
  let detail: BinderDetail | null = state.cachedDetail;
  if (detail === null) {
    const db = getDb();
    const service = createBinderSlotService(
      createBindersRepo(db),
      createBinderSlotsRepo(db),
      createHoldingsRepo(db),
      createCardsRepo(db),
    );
    detail = await service.getDetail(binderId);
    if (detail === null) {
      appendMessage(
        root,
        'Permen finnes ikke (eller er slettet). Gå tilbake til Permer-listen.',
      );
      return;
    }
    state.cachedDetail = detail;
    // PR 24 — assignable info recomputed alongside the cached detail.
    // Uses live holdings (one Dexie call) + the slot data we already
    // have, no per-slot queries.
    const liveHoldings = await createHoldingsRepo(getDb()).listLive();
    state.assignableInfo = computeAssignableInfo(detail, liveHoldings);
    // PR 29 review patch — placement plan is the single source of truth
    // for the auto-button label (and matches gap-banner canPlaceDirectly
    // and what `autoAssignBinder` actually places). Cross-binder aware
    // unlike `computeAssignableInfo`, which is intentionally local to
    // this binder (used only by per-tile badges).
    const planDb = getDb();
    state.placementPlan = await buildAutoPlacementPlan(
      {
        bindersRepo: createBindersRepo(planDb),
        binderSlotsRepo: createBinderSlotsRepo(planDb),
        holdingsRepo: createHoldingsRepo(planDb),
        cardsRepo: createCardsRepo(planDb),
      },
      binderId,
    );
  }
  // Always have a non-null assignableInfo at render time. This handles
  // the case where the detail was cached but assignableInfo was reset
  // by a USER_DATA_CHANGED_EVENT path that didn't re-run the compute.
  if (state.assignableInfo === null) {
    state.assignableInfo = new Map();
  }
  const assignableInfo = state.assignableInfo;
  const placementPlan = state.placementPlan;

  root.appendChild(buildSummary(detail));
  // PR 25 — gap summary banner. Lazy-loaded so the heavy
  // master-set-gap service doesn't block the existing binder render.
  // A `<USER_DATA_CHANGED_EVENT>` invalidation reaches us via the
  // outer `refresh` handler which clears `cachedDetail`, so the next
  // render will rebuild the banner too.
  const gapBanner = buildGapBannerSkeleton(detail.binder.id);
  root.appendChild(gapBanner);
  void populateGapBanner(gapBanner, detail.binder.id);
  root.appendChild(
    buildToolbar(detail, state, container, assignableInfo, placementPlan),
  );
  if (state.autoAssignSummary !== null) {
    root.appendChild(buildAutoAssignSummary(detail, state, container));
  }

  // PR 17 — combine the slot-status filter with the free-text search
  // into a single predicate so the page-grid and checklist views stay
  // in sync. Empty search → only the filter applies.
  const slotPredicate = (slot: BinderSlotRecord): boolean =>
    slotMatchesFilter(slot, state.filter, detail) &&
    slotMatchesSearch(slot, detail, state.search);

  // PR 20 — deep-link via `#binder/<id>/slot/<slotId>` should jump
  // straight to the page containing that slot. PR 20 review patch:
  // consume-once. Without this guard, every render (paginate /
  // filter / search) would re-read the hash and force `pagesPage`
  // back to the deep-link's slot page — the user could not navigate
  // away. We consume the focus exactly once per slotId; subsequent
  // renders skip the page jump even though the hash still carries
  // the slot suffix.
  const slotFocusId = getCurrentBinderSlotFocus();
  if (slotFocusId === null) {
    // Hash dropped the slot suffix — release the consume guard so a
    // future deep-link to the same slotId works again.
    state.consumedSlotFocusId = null;
  }
  const isFreshDeepLink =
    slotFocusId !== null && slotFocusId !== state.consumedSlotFocusId;
  if (isFreshDeepLink) {
    const targetSlot = detail.slots.find((s) => s.id === slotFocusId);
    if (targetSlot !== undefined) {
      if (state.mode === 'pages') {
        // Pages mode: pagesPage is 1-indexed by physical page number.
        // The slot's pageNumber IS the page index in the sorted list
        // (pages are 1..N contiguous in our schema).
        state.pagesPage = targetSlot.pageNumber;
      } else {
        // Checklist mode: find the slot's index in the filtered list
        // and translate to its 0-indexed page.
        const filteredOrdered = detail.slots
          .filter((s) => slotPredicate(s))
          .slice()
          .sort((a, b) => {
            if (a.pageNumber !== b.pageNumber) return a.pageNumber - b.pageNumber;
            return a.slotNumber - b.slotNumber;
          });
        const idx = filteredOrdered.findIndex((s) => s.id === slotFocusId);
        if (idx >= 0) {
          state.checklistPage = Math.floor(idx / CHECKLIST_PAGE_SIZE);
        }
      }
    }
    // Mark consumed even if the slot wasn't found — the URL is the
    // user's intent; if it points at a non-existent slot we don't
    // want to keep retrying the page-jump on every render either.
    state.consumedSlotFocusId = slotFocusId;
  } else if (slotFocusId === null) {
    // Pages-mode auto-jump: when an active filter / search hides every
    // slot on the currently-selected page but matches exist elsewhere,
    // jump to the first page with a match. Skipped when a deep-link
    // is in effect — the user explicitly asked for a specific page.
    if (state.mode === 'pages') {
      const hasMatch = (slot: BinderSlotRecord): boolean => slotPredicate(slot);
      const anyMatch = detail.slots.some(hasMatch);
      if (anyMatch) {
        const slotsOnCurrentPage = detail.slots.filter(
          (s) => s.pageNumber === state.pagesPage,
        );
        const currentPageHasMatch = slotsOnCurrentPage.some(hasMatch);
        if (!currentPageHasMatch) {
          const firstMatchPage = detail.slots.find(hasMatch)?.pageNumber;
          if (firstMatchPage !== undefined) {
            state.pagesPage = firstMatchPage;
          }
        }
      }
    }
  }

  if (state.mode === 'checklist') {
    root.appendChild(
      buildChecklist(detail, slotPredicate, state, container, assignableInfo),
    );
  } else {
    root.appendChild(
      buildPagesGrid(detail, slotPredicate, state, container, assignableInfo),
    );
  }

  // PR 17 — deep-link from card-detail's "Binder-lokasjoner". When
  // the URL hash is `#binder/<id>/slot/<slotId>`, scroll to the slot
  // and add a transient highlight. PR 20 review patch: consume-once
  // — only pulse on the FIRST render that sees a given slotId, so
  // subsequent renders (Forrige / Neste / filter changes) don't
  // keep re-applying the highlight.
  if (isFreshDeepLink && slotFocusId !== null) {
    queueMicrotask(() => {
      focusSlotInDom(root, slotFocusId);
    });
  }
}

function buildToolbar(
  detail: BinderDetail,
  state: ViewState,
  container: HTMLElement,
  assignableInfo: Map<string, AssignableSlotInfo>,
  placementPlan: AutoPlacementPlan | null,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'binder-detail-view__toolbar';

  // PR 26 — view controls (mode toggle + search + filter) live in
  // their own group; primary workflow actions (Auto-plasser, Gap-
  // analyse, Eksport) live in a separate group on the right. The
  // grouping is purely visual; behaviour is unchanged.
  const viewGroup = document.createElement('div');
  viewGroup.className = 'binder-detail-view__toolbar-group binder-detail-view__toolbar-group--view';
  viewGroup.dataset['region'] = 'toolbar-view-controls';
  const actionsGroup = document.createElement('div');
  actionsGroup.className = 'binder-detail-view__toolbar-group binder-detail-view__toolbar-group--actions';
  actionsGroup.dataset['region'] = 'toolbar-primary-actions';

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
  viewGroup.appendChild(toggleGroup);

  // PR 17 — free-text search inside the binder. Uses the same
  // `cardMatchesQuery` predicate as Browse / Collection / Wishlist
  // (PR 15A — F-6) so a query like "Charizard 4" resolves the same
  // way everywhere.
  const searchLabel = document.createElement('label');
  searchLabel.className = 'binder-detail-view__search';
  const searchText = document.createElement('span');
  searchText.textContent = 'Søk';
  searchLabel.appendChild(searchText);
  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.dataset['region'] = 'search-input';
  searchInput.placeholder = 'Kortnavn, id, nummer…';
  searchInput.value = state.search;
  // Debounce so each keystroke doesn't re-render an entire 1088-slot
  // binder.
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  searchInput.addEventListener('input', () => {
    if (searchTimer !== null) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.search = searchInput.value;
      void renderInto(container, state);
    }, 200);
  });
  searchLabel.appendChild(searchInput);
  viewGroup.appendChild(searchLabel);

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
  viewGroup.appendChild(filterLabel);

  // PR 24 — Auto-plasser matching holdings.
  // PR 29 review patch — the count shown is `placementPlan.safe.length`,
  // i.e. exactly the number of safe 1:1 placements that will run when
  // the user clicks. It MUST equal the gap-banner's `canPlaceDirectly`
  // count and `autoAssignBinder`'s assigned count by construction.
  // Ambiguous slots are NOT folded into the main number — they appear
  // in a secondary chip so the user knows they need a manual choice.
  void assignableInfo;
  const autoBtn = document.createElement('button');
  autoBtn.type = 'button';
  autoBtn.className = 'binder-detail-view__auto-assign';
  autoBtn.dataset['action'] = 'auto-assign';
  const safeCount = placementPlan?.safe.length ?? 0;
  const ambiguousCount = placementPlan?.ambiguous.length ?? 0;
  const hasUnfilledTargetSlots = detail.slots.some(
    (s) =>
      s.deletedAt === null &&
      s.targetCardId !== null &&
      !(s.holdingId !== null && s.status === 'owned'),
  );
  autoBtn.textContent = `Auto-plasser matching holdings${safeCount > 0 ? ` (${safeCount})` : ''}`;
  autoBtn.dataset['safeCount'] = String(safeCount);
  autoBtn.dataset['ambiguousCount'] = String(ambiguousCount);
  // Disabled only when there is literally nothing the action could do.
  // We keep it enabled when only ambiguous candidates exist so clicking
  // surfaces the "krever manuelt valg" feedback instead of being silently
  // unreachable.
  autoBtn.disabled = !hasUnfilledTargetSlots;
  if (!hasUnfilledTargetSlots) {
    autoBtn.title = 'Permen har ingen tomme target-slots akkurat nå.';
  } else if (safeCount === 0 && ambiguousCount > 0) {
    autoBtn.title = `${ambiguousCount} slot(s) krever manuelt valg — ingen trygge 1:1 plasseringer.`;
  } else if (safeCount === 0) {
    autoBtn.title =
      'Ingen 1:1 matching holdings — auto-plasser viser hvorfor (mangler holding, feil variant).';
  }
  autoBtn.addEventListener('click', () => {
    void handleAutoAssign(detail.binder.id, state, container);
  });
  actionsGroup.appendChild(autoBtn);
  // PR 29 review patch — secondary chip with the manual-required count.
  // Renders only when the operator's "125 trygge · 41 krever manuelt valg"
  // shape applies (both buckets non-empty). Keeps the auto-button label
  // unambiguous while still surfacing the ambiguous bucket the gap view
  // exists to resolve.
  if (safeCount > 0 && ambiguousCount > 0) {
    const breakdown = document.createElement('span');
    breakdown.className = 'binder-detail-view__auto-assign-breakdown';
    breakdown.dataset['region'] = 'auto-assign-breakdown';
    breakdown.textContent = `${safeCount} trygge · ${ambiguousCount} krever manuelt valg`;
    actionsGroup.appendChild(breakdown);
  }

  // PR 25 — open the per-binder master gap report. Workflow action,
  // grouped with Auto-plasser per PR 26.
  const gapBtn = document.createElement('button');
  gapBtn.type = 'button';
  gapBtn.className = 'binder-detail-view__gap-analysis';
  gapBtn.dataset['action'] = 'open-gap-analysis';
  gapBtn.textContent = 'Gap-analyse';
  gapBtn.addEventListener('click', () => {
    navigateToMasterGapBinder(detail.binder.id);
  });
  actionsGroup.appendChild(gapBtn);

  // Export button — also a workflow action.
  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.className = 'binder-detail-view__export';
  exportBtn.dataset['action'] = 'export-csv';
  exportBtn.textContent = 'Eksporter sjekkliste (CSV)';
  exportBtn.addEventListener('click', () => {
    void handleExportCsv(detail.binder.id);
  });
  actionsGroup.appendChild(exportBtn);

  wrap.appendChild(viewGroup);
  wrap.appendChild(actionsGroup);
  return wrap;
}

// PR 25 — gap summary banner above the toolbar. Skeleton paints first;
// the master-set-gap service then populates the chips. Errors render
// inline rather than failing the binder render.
//
// PR 26 — added `data-region="binder-gap-summary"` so desktop tests
// and integration tools can target the banner deterministically. The
// PR 25 region (`data-region="gap-summary"`) is kept too for callers
// that already depend on it.
function buildAutoAssignSummary(
  detail: BinderDetail,
  state: ViewState,
  container: HTMLElement,
): HTMLElement {
  const summary = state.autoAssignSummary;
  const wrap = document.createElement('div');
  wrap.className = 'binder-detail-view__auto-summary';
  wrap.dataset['region'] = 'auto-assign-summary';
  if (summary === null) return wrap;
  const headline = document.createElement('p');
  headline.className = 'binder-detail-view__auto-summary-headline';
  headline.textContent =
    `Auto-plassering fullført: ` +
    `${summary.assigned.length} plassert, ` +
    `${summary.skippedNoHolding} mangler holding, ` +
    `${summary.skippedAlreadyOwned} allerede fylt, ` +
    `${summary.skippedAmbiguous} tvetydige` +
    (summary.skippedWrongVariant > 0
      ? `, ${summary.skippedWrongVariant} feil variant`
      : '') +
    '.';
  wrap.appendChild(headline);
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'binder-detail-view__auto-summary-dismiss';
  dismiss.dataset['action'] = 'auto-summary-dismiss';
  dismiss.textContent = 'Lukk';
  dismiss.addEventListener('click', () => {
    state.autoAssignSummary = null;
    void renderInto(container, state);
  });
  wrap.appendChild(dismiss);
  void detail;
  return wrap;
}

async function handleAutoAssign(
  binderId: string,
  state: ViewState,
  container: HTMLElement,
): Promise<void> {
  const db = getDb();
  const result = await autoAssignBinder(
    {
      bindersRepo: createBindersRepo(db),
      binderSlotsRepo: createBinderSlotsRepo(db),
      holdingsRepo: createHoldingsRepo(db),
      cardsRepo: createCardsRepo(db),
    },
    { binderId },
  );
  state.autoAssignSummary = result;
  // The service intentionally does NOT dispatch USER_DATA_CHANGED_EVENT.
  // We dispatch once here so other open views (Card detail, Global
  // search panel, Dashboard) refresh.
  if (result.assigned.length > 0) {
    state.cachedDetail = null;
    state.assignableInfo = null;
    state.placementPlan = null;
    window.dispatchEvent(new CustomEvent(USER_DATA_CHANGED_EVENT));
  }
  // Re-render even if no assignments happened so the summary banner
  // shows up.
  void renderInto(container, state);
}

// ---------------------------------------------------------------------
// Pages mode

function buildPagesGrid(
  detail: BinderDetail,
  matches: (slot: BinderSlotRecord) => boolean,
  state: ViewState,
  container: HTMLElement,
  assignableInfo: Map<string, AssignableSlotInfo>,
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

  // PR 20 — render only the current page. Vault X 16-pocket binders
  // have 68 pages × 16 slots = 1088 slot tiles, and rendering them
  // all blew ~1 s per render in QA. Page-at-a-time keeps the DOM
  // around 16 tiles plus the nav strip.
  const totalPages = sortedPageNumbers.length;
  // Clamp the page index in case the user just toggled a filter.
  if (state.pagesPage < 1) state.pagesPage = 1;
  if (state.pagesPage > totalPages) state.pagesPage = totalPages;
  const currentPageNumber = sortedPageNumbers[state.pagesPage - 1] ?? 1;
  const slotsForPage = slotsByPage.get(currentPageNumber);
  if (slotsForPage !== undefined) {
    wrap.appendChild(
      buildPage(detail, currentPageNumber, slotsForPage, matches, assignableInfo),
    );
  }

  // Filter feedback: if the visible page has no matching slots, tell
  // the user that the filter is still in effect — they can use the
  // nav buttons to scan or clear the filter.
  const hasMatchOnPage = (slotsForPage ?? []).some((s) => matches(s));
  if (!hasMatchOnPage && totalPages > 0) {
    const note = document.createElement('p');
    note.className = 'binder-detail-view__filter-note';
    note.textContent =
      'Ingen slots på denne siden matcher filteret. Bruk Forrige / Neste for å bla.';
    wrap.appendChild(note);
  }

  if (totalPages > 1) {
    wrap.appendChild(
      buildPagesNav(state, totalPages, container),
    );
  }

  return wrap;
}

function buildPagesNav(
  state: ViewState,
  totalPages: number,
  container: HTMLElement,
): HTMLElement {
  const nav = document.createElement('nav');
  nav.className = 'binder-detail-view__pages-nav';
  nav.setAttribute('aria-label', 'Bla mellom permsider');

  const prev = document.createElement('button');
  prev.type = 'button';
  prev.dataset['action'] = 'pages-prev';
  prev.textContent = 'Forrige';
  prev.disabled = state.pagesPage <= 1;
  prev.addEventListener('click', () => {
    if (state.pagesPage > 1) {
      state.pagesPage -= 1;
      void renderInto(container, state);
    }
  });
  nav.appendChild(prev);

  const summary = document.createElement('span');
  summary.dataset['region'] = 'pages-summary';
  summary.textContent = `Side ${state.pagesPage} av ${totalPages}`;
  nav.appendChild(summary);

  const next = document.createElement('button');
  next.type = 'button';
  next.dataset['action'] = 'pages-next';
  next.textContent = 'Neste';
  next.disabled = state.pagesPage >= totalPages;
  next.addEventListener('click', () => {
    if (state.pagesPage < totalPages) {
      state.pagesPage += 1;
      void renderInto(container, state);
    }
  });
  nav.appendChild(next);

  return nav;
}

// ---------------------------------------------------------------------
// Checklist mode

function buildChecklist(
  detail: BinderDetail,
  matches: (slot: BinderSlotRecord) => boolean,
  state: ViewState,
  container: HTMLElement,
  assignableInfo: Map<string, AssignableSlotInfo>,
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

  // PR 17 — checklist is now sorted by physical slot order
  // (page asc, slot asc) so set-based binders render in
  // set-release / card-number order. The from-set wizard places
  // drafts in card-number order already, but explicit sort keeps
  // legacy data + manually-rearranged binders predictable.
  const filteredSlots = detail.slots
    .filter((s) => matches(s))
    .slice()
    .sort((a, b) => {
      if (a.pageNumber !== b.pageNumber) return a.pageNumber - b.pageNumber;
      return a.slotNumber - b.slotNumber;
    });

  if (filteredSlots.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'binder-detail-view__empty';
    empty.textContent = 'Ingen slots matcher filteret.';
    wrap.appendChild(empty);
    return wrap;
  }

  // PR 20 — paginate checklist mode at 50 rows per page. A 1088-slot
  // binder with all slots passing the filter previously rendered a
  // 1088-row table; now we render at most 50 rows + a nav strip.
  const totalPages = Math.max(
    1,
    Math.ceil(filteredSlots.length / CHECKLIST_PAGE_SIZE),
  );
  if (state.checklistPage < 0) state.checklistPage = 0;
  if (state.checklistPage >= totalPages) state.checklistPage = totalPages - 1;
  const start = state.checklistPage * CHECKLIST_PAGE_SIZE;
  const end = Math.min(filteredSlots.length, start + CHECKLIST_PAGE_SIZE);
  const visibleSlots = filteredSlots.slice(start, end);

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
    for (const slot of visibleSlots) {
      body.appendChild(
        buildChecklistRow(detail, slot, assignableInfo.get(slot.id) ?? null),
      );
    }
  }
  wrap.appendChild(table);

  if (totalPages > 1) {
    wrap.appendChild(
      buildChecklistNav(state, totalPages, filteredSlots.length, container),
    );
  }

  return wrap;
}

function buildChecklistNav(
  state: ViewState,
  totalPages: number,
  totalRows: number,
  container: HTMLElement,
): HTMLElement {
  const nav = document.createElement('nav');
  nav.className = 'binder-detail-view__checklist-nav';
  nav.setAttribute('aria-label', 'Sjekkliste-paginering');

  const prev = document.createElement('button');
  prev.type = 'button';
  prev.dataset['action'] = 'checklist-prev';
  prev.textContent = 'Forrige';
  prev.disabled = state.checklistPage === 0;
  prev.addEventListener('click', () => {
    if (state.checklistPage > 0) {
      state.checklistPage -= 1;
      void renderInto(container, state);
    }
  });
  nav.appendChild(prev);

  const summary = document.createElement('span');
  summary.dataset['region'] = 'checklist-summary';
  const startIdx = state.checklistPage * CHECKLIST_PAGE_SIZE + 1;
  const endIdx = Math.min(
    totalRows,
    (state.checklistPage + 1) * CHECKLIST_PAGE_SIZE,
  );
  summary.textContent = `Side ${state.checklistPage + 1} av ${totalPages} — viser ${startIdx}–${endIdx} av ${totalRows}`;
  nav.appendChild(summary);

  const next = document.createElement('button');
  next.type = 'button';
  next.dataset['action'] = 'checklist-next';
  next.textContent = 'Neste';
  next.disabled = state.checklistPage + 1 >= totalPages;
  next.addEventListener('click', () => {
    if (state.checklistPage + 1 < totalPages) {
      state.checklistPage += 1;
      void renderInto(container, state);
    }
  });
  nav.appendChild(next);

  return nav;
}

// PR 34 — async openers + handleExportCsv + populateGapBanner now
// live in `./binder-detail-actions`. All are stateless; they take
// their slot + slotsPerPage (or banner + binderId) and run against
// the live DB and global services.
//
// Pure render helpers (`buildSummary`, `buildGapBannerSkeleton`,
// `buildPage`, `buildSlot`, `buildChecklistRow`) live in
// `./binder-detail-render`. State-coupled wrappers
// (`buildToolbar`, `buildAutoAssignSummary`, `buildPagesGrid`,
// `buildPagesNav`, `buildChecklist`, `buildChecklistNav`) stay in
// this file because they wire callbacks back to `renderInto`.
