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
import { USER_DATA_CHANGED_EVENT, onUserDataChanged } from '../components/events';
import { buildAssignHoldingModal } from '../components/assign-holding-modal';
import { buildSlotActionMenu } from '../components/slot-action-menu';
import { buildSlotDirectAddForm } from '../components/slot-direct-add-form';
import { openWishlistReceivePrompt } from '../components/wishlist-receive-prompt';
import { getDb } from '../db/database';
import { cardMatchesQuery, isEmptyQuery } from '../domain/card-search';
import { isReverseHoloTemplateSlot } from '../domain/card-variants';
import type { MasterGapBinderSummary } from '../domain/master-set-gap';
import {
  getCurrentBinderId,
  getCurrentBinderSlotFocus,
  navigate,
  navigateToCard,
  navigateToMasterGapBinder,
} from '../router';
import { createBindersRepo } from '../repositories/binders-repo';
import { createBinderSlotsRepo } from '../repositories/binder-slots-repo';
import { createCardsRepo } from '../repositories/cards-repo';
import { createHoldingsRepo } from '../repositories/holdings-repo';
import { createLotItemsRepo } from '../repositories/lot-items-repo';
import { createSetsRepo } from '../repositories/sets-repo';
import { createWishlistRepo } from '../repositories/wishlist-repo';
import { createBinderCsvExporter } from '../services/binder-csv-export';
import {
  assignHoldingToSlot,
  autoAssignBinder,
  buildAutoPlacementPlan,
  type AutoAssignResult,
  type AutoPlacementPlan,
} from '../services/binder-assignment-service';
import {
  createBinderSlotService,
  type BinderDetail,
} from '../services/binder-slot-service';
import { createMasterSetGapService } from '../services/master-set-gap-service';
import { findWishlistReceiveCandidates } from '../services/wishlist-receive-service';
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
  | 'completed'
  | 'empty';

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

const CHECKLIST_PAGE_SIZE = 50;

const FILTER_LABELS: ReadonlyArray<{ readonly value: SlotFilter; readonly label: string }> = [
  { value: 'all', label: 'Alle' },
  { value: 'missing', label: 'Mangler' },
  { value: 'completed', label: 'Eid' },
  { value: 'empty', label: 'Tomme' },
  { value: 'ordered', label: 'Bestilt' },
  { value: 'duplicate', label: 'Duplikater' },
];

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

interface AssignableSlotInfo {
  /** Count of live unassigned holdings that match this slot. */
  readonly count: number;
  /** When `count === 1`, the single eligible holding id (used by "Plasser"). */
  readonly eligibleHoldingId: string | null;
}

/**
 * PR 24 — compute assignable-holding info for every slot in the binder
 * via O(1) lookups. Avoids the 1088-Dexie-query trap on a Vault X
 * 16-pocket binder. Mirrors `autoAssignBinder`'s rules so the badges
 * match exactly what the auto-assign action would do.
 */
function computeAssignableInfo(
  detail: BinderDetail,
  liveHoldings: readonly HoldingRecord[],
): Map<string, AssignableSlotInfo> {
  const holdingsByCardId = new Map<string, HoldingRecord[]>();
  for (const h of liveHoldings) {
    const arr = holdingsByCardId.get(h.cardId);
    if (arr === undefined) holdingsByCardId.set(h.cardId, [h]);
    else arr.push(h);
  }
  const assignedHoldingIds = new Set<string>();
  for (const slot of detail.slots) {
    if (slot.deletedAt !== null) continue;
    if (slot.holdingId !== null) assignedHoldingIds.add(slot.holdingId);
  }
  const out = new Map<string, AssignableSlotInfo>();
  for (const slot of detail.slots) {
    if (slot.deletedAt !== null) continue;
    if (slot.holdingId !== null && slot.status === 'owned') continue;
    if (slot.targetCardId === null) continue;
    const candidates = (holdingsByCardId.get(slot.targetCardId) ?? []).filter(
      (h) => !assignedHoldingIds.has(h.id),
    );
    const eligible = isReverseHoloTemplateSlot(slot.note)
      ? candidates.filter((h) => h.finish === 'reverse_holo')
      : candidates;
    if (eligible.length === 0) continue;
    out.set(slot.id, {
      count: eligible.length,
      eligibleHoldingId: eligible.length === 1 ? (eligible[0]?.id ?? null) : null,
    });
  }
  return out;
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

function focusSlotInDom(root: HTMLElement, slotId: string): void {
  const target = root.querySelector<HTMLElement>(
    `[data-slot-id="${cssEscape(slotId)}"]`,
  );
  if (target === null) return;
  // jsdom does not implement scrollIntoView; guard so tests still
  // pass while the production browser scrolls as expected.
  if (typeof target.scrollIntoView === 'function') {
    target.scrollIntoView({ block: 'center', behavior: 'auto' });
  }
  target.classList.add('binder-slot--focused');
  // Drop the highlight after a few seconds so a subsequent navigation
  // to the same binder without the slot suffix doesn't keep the
  // highlight forever.
  setTimeout(() => {
    target.classList.remove('binder-slot--focused');
  }, 3000);
}

function cssEscape(value: string): string {
  // CSS.escape is not in jsdom; this minimal escape covers the
  // characters our slot ids contain (UUIDs only — no quotes or
  // backslashes — but be defensive in case of future changes).
  return value.replace(/(["\\])/g, '\\$1');
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
function buildGapBannerSkeleton(binderId: string): HTMLElement {
  const banner = document.createElement('section');
  banner.className = 'binder-detail-view__gap-summary';
  banner.dataset['region'] = 'binder-gap-summary';
  banner.dataset['binderId'] = binderId;
  const loading = document.createElement('p');
  loading.className = 'binder-detail-view__gap-summary-loading';
  loading.dataset['region'] = 'gap-summary-loading';
  loading.textContent = 'Laster gap-analyse …';
  banner.appendChild(loading);
  return banner;
}

async function populateGapBanner(
  banner: HTMLElement,
  binderId: string,
): Promise<void> {
  let summary: MasterGapBinderSummary | null;
  try {
    const db = getDb();
    const report = await createMasterSetGapService({
      bindersRepo: createBindersRepo(db),
      binderSlotsRepo: createBinderSlotsRepo(db),
      cardsRepo: createCardsRepo(db),
      setsRepo: createSetsRepo(db),
      holdingsRepo: createHoldingsRepo(db),
      wishlistRepo: createWishlistRepo(db),
      lotItemsRepo: createLotItemsRepo(db),
    }).buildBinderReport(binderId);
    summary = report?.binder ?? null;
  } catch {
    if (!banner.isConnected) return;
    banner.replaceChildren();
    const err = document.createElement('p');
    err.className = 'binder-detail-view__gap-summary-error';
    err.textContent = 'Kunne ikke laste gap-analyse.';
    banner.appendChild(err);
    return;
  }
  if (!banner.isConnected) return;
  if (summary === null) {
    banner.replaceChildren();
    return;
  }

  banner.replaceChildren();
  const fragment = `Master gap: ${summary.complete} / ${summary.totalTargetSlots} fullført · ${summary.missing} mangler · ${summary.ownedUnplaced} eies men ikke plassert · ${summary.wishlistWanted} ønsket · ${summary.wishlistOrdered} bestilt · ${summary.invalidAssignment + summary.invalidVariant} feil`;
  const main = document.createElement('p');
  main.className = 'binder-detail-view__gap-summary-line';
  main.textContent = fragment;
  banner.appendChild(main);

  if (summary.canPlaceDirectlyCount > 0) {
    const directly = document.createElement('p');
    directly.className =
      'binder-detail-view__gap-summary-line binder-detail-view__gap-summary-line--quickwin';
    directly.textContent = `${summary.canPlaceDirectlyCount} kan plasseres direkte`;
    banner.appendChild(directly);
  }

  const showBtn = document.createElement('button');
  showBtn.type = 'button';
  showBtn.className = 'binder-detail-view__gap-summary-action';
  showBtn.dataset['action'] = 'show-gap';
  showBtn.textContent = 'Vis gap';
  showBtn.addEventListener('click', () => {
    navigateToMasterGapBinder(binderId);
  });
  banner.appendChild(showBtn);
}

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
    case 'empty':
      // PR 17 — fully blank slot: no target card AND no assigned
      // holding. Useful when assigning an unassigned holding to a
      // free pocket without filtering by status.
      return slot.targetCardId === null && slot.holdingId === null;
    case 'ordered':
      return slot.status === 'ordered';
    case 'duplicate':
      return slot.status === 'duplicate';
  }
}

function slotMatchesSearch(
  slot: BinderSlotRecord,
  detail: BinderDetail,
  search: string,
): boolean {
  if (isEmptyQuery(search)) return true;
  const card = resolveCardForSlot(detail, slot);
  if (card === null) return false;
  // Set-name search inside a binder is intentionally omitted —
  // binders have at most one source set anyway, so name / id /
  // number / setid coverage is enough.
  return cardMatchesQuery(card, search);
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

function buildPage(
  detail: BinderDetail,
  pageNumber: number,
  slots: readonly BinderSlotRecord[],
  matches: (slot: BinderSlotRecord) => boolean,
  assignableInfo: Map<string, AssignableSlotInfo>,
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
    grid.appendChild(
      buildSlot(detail, slot, matches(slot), assignableInfo.get(slot.id) ?? null),
    );
  }
  page.appendChild(grid);
  return page;
}

function buildSlot(
  detail: BinderDetail,
  slot: BinderSlotRecord,
  matchesFilter: boolean,
  assignable: AssignableSlotInfo | null,
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

  // PR 24 — assignable badge. Visible on missing target slots that
  // have at least one matching unassigned holding.
  if (assignable !== null && matchesFilter) {
    const badge = document.createElement('span');
    badge.className = 'binder-slot__assignable-badge';
    badge.dataset['region'] = 'assignable-badge';
    badge.textContent =
      assignable.count === 1
        ? 'Kan plasseres'
        : `Kan plasseres (${assignable.count})`;
    tile.appendChild(badge);
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

    // PR 24 — single-click "Plasser" only renders when there is exactly
    // one eligible holding for this slot. Multi-candidate / wrong-finish
    // / blank slots fall back to the existing assign modal.
    if (
      assignable !== null &&
      assignable.count === 1 &&
      assignable.eligibleHoldingId !== null
    ) {
      const placeBtn = document.createElement('button');
      placeBtn.type = 'button';
      placeBtn.className = 'binder-slot__action binder-slot__action--success';
      placeBtn.dataset['action'] = 'place-eligible';
      placeBtn.textContent = 'Plasser';
      const eligibleHoldingId = assignable.eligibleHoldingId;
      placeBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        void handlePlaceEligible(slot, detail.binder.slotsPerPage, eligibleHoldingId);
      });
      actions.appendChild(placeBtn);
    }

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

    // PR 24 — direct add for target slots only. Blank slots route
    // through "Tilordne holding" (the existing modal) where the user
    // can search/pick from existing holdings.
    if (slot.targetCardId !== null && slot.holdingId === null) {
      const directAddBtn = document.createElement('button');
      directAddBtn.type = 'button';
      directAddBtn.className = 'binder-slot__action';
      directAddBtn.dataset['action'] = 'direct-add';
      directAddBtn.textContent = 'Legg til her';
      directAddBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        void openDirectAdd(slot, detail.binder.slotsPerPage);
      });
      actions.appendChild(directAddBtn);
    }

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

function buildChecklistRow(
  detail: BinderDetail,
  slot: BinderSlotRecord,
  assignable: AssignableSlotInfo | null,
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

  // PR 24 — append a "Kan plasseres" indicator inline with the status
  // cell so the checklist surfaces the same affordance as the grid
  // tile. Empty cell when no candidate.
  const statusCell = document.createElement('td');
  const statusLabel = document.createElement('span');
  statusLabel.textContent = STATUS_LABELS[slot.status];
  statusCell.appendChild(statusLabel);
  if (assignable !== null) {
    const badge = document.createElement('span');
    badge.className = 'checklist-table__assignable-badge';
    badge.dataset['region'] = 'assignable-badge';
    badge.textContent =
      assignable.count === 1
        ? 'Kan plasseres'
        : `Kan plasseres (${assignable.count})`;
    statusCell.appendChild(badge);
  }
  tr.appendChild(statusCell);

  appendCell(tr, isSlotComplete(slot, detail) ? '✓' : '–');
  appendCell(tr, `${slot.pageNumber}.${slot.slotNumber}`);
  appendCell(tr, describeCondition(holding));
  appendCell(tr, displaySlotNote(slot));

  const actions = document.createElement('td');
  actions.className = 'checklist-table__actions';
  // PR 24 — single-click "Plasser" mirrors the grid action.
  if (
    assignable !== null &&
    assignable.count === 1 &&
    assignable.eligibleHoldingId !== null
  ) {
    const place = document.createElement('button');
    place.type = 'button';
    place.className = 'checklist-table__action checklist-table__action--success';
    place.dataset['action'] = 'place-eligible';
    place.textContent = 'Plasser';
    const eligibleHoldingId = assignable.eligibleHoldingId;
    place.addEventListener('click', (event) => {
      event.stopPropagation();
      void handlePlaceEligible(slot, detail.binder.slotsPerPage, eligibleHoldingId);
    });
    actions.appendChild(place);
  }
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
  if (slot.targetCardId !== null && slot.holdingId === null) {
    const directAdd = document.createElement('button');
    directAdd.type = 'button';
    directAdd.className = 'checklist-table__action';
    directAdd.dataset['action'] = 'direct-add';
    directAdd.textContent = 'Legg til her';
    directAdd.addEventListener('click', (event) => {
      event.stopPropagation();
      void openDirectAdd(slot, detail.binder.slotsPerPage);
    });
    actions.appendChild(directAdd);
  }
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

// PR 24 — single-click "Plasser" handler. Looks up the eligible
// holding by id and calls assignHoldingToSlot. We do NOT re-open the
// assign modal because the candidate is unambiguous (count === 1 was
// the badge condition).
async function handlePlaceEligible(
  slot: BinderSlotRecord,
  slotsPerPage: SlotsPerPage,
  holdingId: string,
): Promise<void> {
  const db = getDb();
  const holdingsRepo = createHoldingsRepo(db);
  const holding = await holdingsRepo.get(holdingId);
  if (holding === undefined || holding.deletedAt !== null) {
    window.alert('Holding finnes ikke lenger. Last inn permen på nytt.');
    return;
  }
  try {
    await assignHoldingToSlot(
      {
        bindersRepo: createBindersRepo(db),
        binderSlotsRepo: createBinderSlotsRepo(db),
        holdingsRepo,
        cardsRepo: createCardsRepo(db),
      },
      slot,
      holding,
      slotsPerPage,
    );
    window.dispatchEvent(new CustomEvent(USER_DATA_CHANGED_EVENT));
  } catch (caught) {
    window.alert(
      caught instanceof Error
        ? `Plassering feilet: ${caught.message}`
        : 'Plassering feilet av en ukjent grunn.',
    );
  }
}

// PR 24 — direct-add for target slots. Opens the smaller slot form
// from `slot-direct-add-form.ts`; on success we run the wishlist
// receive prompt for the freshly-created holding so the receive flow
// stays consistent across all write-paths.
async function openDirectAdd(
  slot: BinderSlotRecord,
  slotsPerPage: SlotsPerPage,
): Promise<void> {
  let createdHoldingId: string | null = null;
  await openDialog(
    buildSlotDirectAddForm({
      slot,
      slotsPerPage,
      onCreated: (holding) => {
        createdHoldingId = holding.id;
      },
    }),
  );
  if (createdHoldingId === null) return;
  try {
    const db = getDb();
    const holding = await createHoldingsRepo(db).get(createdHoldingId);
    if (holding === undefined) return;
    const candidates = await findWishlistReceiveCandidates(
      createWishlistRepo(db),
      holding,
    );
    if (candidates.length === 0) return;
    await openWishlistReceivePrompt({
      candidates,
      heading:
        candidates.length === 1
          ? 'Legg til i slot: 1 match på aktiv ønskeliste.'
          : `Legg til i slot: ${candidates.length} matcher på aktiv ønskeliste.`,
    });
  } catch {
    // Receive flow is non-blocking. Holding + slot are already saved.
  }
}
