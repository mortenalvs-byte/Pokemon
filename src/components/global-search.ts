// PR 23 — Global search component. Lives in the app topbar; provides
// a search input + live dropdown + a lightweight Card Status panel
// invoked when the user clicks a result.
//
// Design rules (locked in PR 23):
//   - Topbar input + Ctrl+K / Cmd+K focus. No modal.
//   - Live dropdown of up to 20 hits; "Vis flere treff" expands to 100.
//   - Click a hit → status panel as an overlay (NOT a route). The
//     panel has explicit `Åpne kort` to navigate to Card Detail.
//   - Quick actions go through shared services only:
//       quick-add-service.quickAddRawCard,
//       wishlist-receive-service.findReceiveCandidatesForHoldings,
//       openWishlistReceivePrompt,
//       navigateToCard / navigateToBinderSlot,
//       buildWishlistForm.
//   - No imports from view-internals.
//   - Escape / click-outside / route change closes both dropdown and
//     panel.

import { openDialog } from './dialog';
import { USER_DATA_CHANGED_EVENT, onUserDataChanged } from './events';
import { buildWishlistForm } from './wishlist-form';
import { openWishlistReceivePrompt } from './wishlist-receive-prompt';
import { getDb } from '../db/database';
import { wishlistStatusLabel } from '../domain/wishlist-status';
import {
  navigateToBinderSlot,
  navigateToCard,
  navigateToLot,
  onRouteChange,
} from '../router';
import { createBindersRepo } from '../repositories/binders-repo';
import { createBinderSlotsRepo } from '../repositories/binder-slots-repo';
import { createCardsRepo } from '../repositories/cards-repo';
import { createHoldingsRepo } from '../repositories/holdings-repo';
import { createLotsRepo } from '../repositories/lots-repo';
import { createLotItemsRepo } from '../repositories/lot-items-repo';
import { createSetsRepo } from '../repositories/sets-repo';
import { createWishlistRepo } from '../repositories/wishlist-repo';
import { createBinderSlotService } from '../services/binder-slot-service';
import {
  getCardStatus,
  type CardStatus,
} from '../services/card-status-service';
import {
  DEFAULT_GLOBAL_SEARCH_LIMIT,
  EXPANDED_GLOBAL_SEARCH_LIMIT,
  searchGlobalCards,
  type GlobalSearchResult,
} from '../services/global-search-service';
import {
  QuickAddNotEligibleError,
  quickAddRawCard,
} from '../services/quick-add-service';
import {
  findReceiveCandidatesForHoldings,
  type WishlistReceiveCandidate,
} from '../services/wishlist-receive-service';
import { decideQuickAdd } from './quick-add';
import { createLazyImage } from '../utils/lazy-image';
import { ValidationError } from '../domain/validators';
import type { HoldingRecord } from '../domain/types';

const DEBOUNCE_MS = 150;

interface SearchState {
  query: string;
  expanded: boolean;
  results: GlobalSearchResult[];
  panelCardId: string | null;
  /**
   * Monotonically incremented per `runSearch` call. Each search
   * captures its id at start; if a later search has bumped the
   * counter by the time this one's `await` resolves, we drop the
   * stale result instead of rendering it. Same idea as a request
   * cancellation token — protects against out-of-order resolution
   * when an old slow search returns after a newer fast one.
   */
  searchRequestSeq: number;
}

interface SearchRefs {
  readonly slot: HTMLElement;
  readonly form: HTMLFormElement;
  readonly input: HTMLInputElement;
  readonly dropdown: HTMLElement;
  readonly panel: HTMLElement;
}

let detachListeners: (() => void) | null = null;

/**
 * Mount the global search component into the topbar slot. Idempotent
 * per slot — calling it twice on the same already-mounted slot is a
 * no-op. Tests that recreate the topbar between runs reset the slot
 * via `_resetGlobalSearchForTests()`.
 */
export function mountGlobalSearch(slot: HTMLElement): void {
  if (slot.dataset['globalSearchMounted'] === 'true') return;
  slot.dataset['globalSearchMounted'] = 'true';

  slot.classList.add('global-search');
  slot.innerHTML = `
    <form class="global-search__form" role="search" autocomplete="off">
      <input
        type="search"
        class="global-search__input"
        data-region="global-search-input"
        placeholder="Søk kort, set, nummer… (Ctrl/Cmd+K)"
        aria-label="Globalt søk"
      />
      <button type="button" class="global-search__clear" data-action="clear" hidden aria-label="Tøm søk">×</button>
    </form>
    <div class="global-search__dropdown" data-region="global-search-dropdown" hidden></div>
    <div class="global-search__panel" data-region="global-search-panel" hidden></div>
  `;

  const refs = collectRefs(slot);
  if (refs === null) return;

  const state: SearchState = {
    query: '',
    expanded: false,
    results: [],
    panelCardId: null,
    searchRequestSeq: 0,
  };

  attachEventListeners(refs, state);
}

/**
 * Test helper. Detaches global listeners (window keydown, document
 * click) so subsequent `mountGlobalSearch` in another test starts
 * fresh. Production code never calls this.
 */
export function _resetGlobalSearchForTests(): void {
  detachListeners?.();
  detachListeners = null;
}

function collectRefs(slot: HTMLElement): SearchRefs | null {
  const form = slot.querySelector<HTMLFormElement>('form.global-search__form');
  const input = slot.querySelector<HTMLInputElement>(
    '[data-region="global-search-input"]',
  );
  const dropdown = slot.querySelector<HTMLElement>(
    '[data-region="global-search-dropdown"]',
  );
  const panel = slot.querySelector<HTMLElement>(
    '[data-region="global-search-panel"]',
  );
  if (!form || !input || !dropdown || !panel) return null;
  return { slot, form, input, dropdown, panel };
}

function attachEventListeners(refs: SearchRefs, state: SearchState): void {
  detachListeners?.();
  const cleanups: Array<() => void> = [];
  // Single AbortController gates all global listeners (window keydown,
  // document click, USER_DATA_CHANGED_EVENT, route change). Calling
  // `controller.abort()` from `_resetGlobalSearchForTests()` or a
  // future re-mount drops every one in one go — no
  // page-lifetime listener leaks (PR 15A — F-3 still applies).
  const controller = new AbortController();
  cleanups.push(() => controller.abort());

  // Cmd+K / Ctrl+K focuses the input from anywhere.
  const onKeydown = (event: KeyboardEvent): void => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      refs.input.focus();
      refs.input.select();
    } else if (event.key === 'Escape') {
      if (state.panelCardId !== null) {
        closePanel(refs, state);
      } else if (!refs.dropdown.hidden) {
        hideDropdown(refs);
      }
    }
  };
  window.addEventListener('keydown', onKeydown, { signal: controller.signal });

  // Live debounced search.
  let searchTimeout: ReturnType<typeof setTimeout> | null = null;
  refs.input.addEventListener('input', () => {
    state.query = refs.input.value;
    state.expanded = false;
    const clearBtn = refs.form.querySelector<HTMLButtonElement>(
      '[data-action="clear"]',
    );
    if (clearBtn !== null) clearBtn.hidden = state.query.length === 0;
    if (searchTimeout !== null) clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      void runSearch(refs, state);
    }, DEBOUNCE_MS);
  });

  refs.form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (searchTimeout !== null) clearTimeout(searchTimeout);
    void runSearch(refs, state);
  });

  refs.form
    .querySelector<HTMLButtonElement>('[data-action="clear"]')
    ?.addEventListener('click', () => {
      refs.input.value = '';
      state.query = '';
      state.results = [];
      hideDropdown(refs);
      const clearBtn = refs.form.querySelector<HTMLButtonElement>(
        '[data-action="clear"]',
      );
      if (clearBtn !== null) clearBtn.hidden = true;
      refs.input.focus();
    });

  // Click delegation: pick a result, expand, or fire a panel action.
  // `stopPropagation` keeps the document-level outside-click handler
  // from racing the row click — without it, `hideDropdown` removes the
  // clicked row from the DOM before the bubbling click reaches the
  // document, so `slot.contains(target)` returns false and the panel
  // closes immediately.
  refs.dropdown.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    if (target === null) return;
    const expand = target.closest<HTMLButtonElement>(
      '[data-action="expand"]',
    );
    if (expand !== null) {
      event.stopPropagation();
      state.expanded = true;
      void runSearch(refs, state);
      return;
    }
    const row = target.closest<HTMLElement>('[data-card-id]');
    if (row !== null) {
      const cardId = row.dataset['cardId'];
      if (cardId !== undefined && cardId.length > 0) {
        event.stopPropagation();
        void openPanel(refs, state, cardId);
      }
    }
  });

  refs.panel.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    if (target === null) return;
    // Same race protection as the dropdown — clicks on panel actions
    // can mutate the panel content; the document handler should not
    // see those bubbling clicks.
    event.stopPropagation();
    if (target.closest<HTMLButtonElement>('[data-action="close-panel"]')) {
      closePanel(refs, state);
      return;
    }
    if (target.closest<HTMLButtonElement>('[data-action="open-card"]')) {
      const cardId = state.panelCardId;
      if (cardId !== null) {
        navigateToCard(cardId);
        closeAll(refs, state);
      }
      return;
    }
    if (target.closest<HTMLButtonElement>('[data-action="add-wishlist"]')) {
      const cardId = state.panelCardId;
      if (cardId !== null) {
        void openDialog(buildWishlistForm({ mode: 'add', cardId }));
      }
      return;
    }
    if (target.closest<HTMLButtonElement>('[data-action="quick-add"]')) {
      const cardId = state.panelCardId;
      if (cardId !== null) {
        void runPanelQuickAdd(refs, state, cardId);
      }
      return;
    }
    if (target.closest<HTMLButtonElement>('[data-action="receive"]')) {
      const cardId = state.panelCardId;
      if (cardId !== null) {
        void runPanelReceive(refs, state, cardId);
      }
      return;
    }
    const slotBtn = target.closest<HTMLButtonElement>(
      '[data-action="goto-slot"]',
    );
    if (slotBtn !== null) {
      const binderId = slotBtn.dataset['binderId'];
      const slotId = slotBtn.dataset['slotId'];
      if (binderId !== undefined && slotId !== undefined) {
        navigateToBinderSlot(binderId, slotId);
        closeAll(refs, state);
      }
      return;
    }
    const lotBtn = target.closest<HTMLButtonElement>('[data-action="goto-lot"]');
    if (lotBtn !== null) {
      const lotId = lotBtn.dataset['lotId'];
      if (lotId !== undefined) {
        navigateToLot(lotId);
        closeAll(refs, state);
      }
      return;
    }
  });

  // Click outside the search slot closes the dropdown / panel.
  const onDocClick = (event: MouseEvent): void => {
    const target = event.target as Node | null;
    if (target === null) return;
    if (refs.slot.contains(target)) return;
    // Don't auto-close when an open dialog (wishlist form, receive
    // prompt) is on top of the panel — those eat clicks themselves.
    if (document.querySelector('dialog[open]') !== null) return;
    if (state.panelCardId !== null) closePanel(refs, state);
    if (!refs.dropdown.hidden) hideDropdown(refs);
  };
  document.addEventListener('click', onDocClick, { signal: controller.signal });

  // Refresh open panel after any user-data write. Use the AbortSignal
  // path so the listener dies with the rest of the global listeners.
  onUserDataChanged(() => {
    if (state.panelCardId !== null) {
      void renderPanelStatus(refs, state, state.panelCardId);
    }
    // Also re-run the dropdown search so badges reflect new state.
    if (state.query.length > 0 && !refs.dropdown.hidden) {
      void runSearch(refs, state);
    }
  }, controller.signal);

  // Route changes close everything (the user just navigated away).
  // `onRouteChange` returns its own removeEventListener cleanup; queue
  // it alongside the AbortController so a single `detachListeners()`
  // call tears the whole graph down.
  const detachRoute = onRouteChange(() => closeAll(refs, state));
  cleanups.push(detachRoute);

  detachListeners = () => {
    for (const fn of cleanups) fn();
    detachListeners = null;
  };
}

async function runSearch(refs: SearchRefs, state: SearchState): Promise<void> {
  if (state.query.trim().length === 0) {
    state.results = [];
    state.searchRequestSeq += 1; // invalidate any in-flight search
    hideDropdown(refs);
    return;
  }
  // Stale-result guard: capture the seq + query at start; on resolve,
  // drop the result if a newer search has run or the query string has
  // moved on. Without this, an old slow search resolving after a
  // newer one would overwrite the dropdown with stale matches (typing
  // "charizard" then immediately "pikachu" with a slow first call).
  state.searchRequestSeq += 1;
  const requestId = state.searchRequestSeq;
  const queryAtStart = state.query;
  const limit = state.expanded
    ? EXPANDED_GLOBAL_SEARCH_LIMIT
    : DEFAULT_GLOBAL_SEARCH_LIMIT;
  let results: GlobalSearchResult[];
  try {
    results = await searchGlobalCards(getDb(), queryAtStart, { limit });
  } catch {
    results = [];
  }
  if (
    requestId !== state.searchRequestSeq ||
    queryAtStart !== state.query
  ) {
    return; // stale — a newer runSearch has taken over.
  }
  state.results = results;
  renderDropdown(refs, state);
}

function renderDropdown(refs: SearchRefs, state: SearchState): void {
  refs.dropdown.replaceChildren();
  if (state.query.trim().length === 0) {
    refs.dropdown.hidden = true;
    return;
  }
  refs.dropdown.hidden = false;
  if (state.results.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'global-search__empty';
    empty.textContent = 'Ingen treff.';
    refs.dropdown.appendChild(empty);
    return;
  }
  const list = document.createElement('ul');
  list.className = 'global-search__list';
  for (const result of state.results) {
    list.appendChild(buildResultRow(result));
  }
  refs.dropdown.appendChild(list);
  if (
    !state.expanded &&
    state.results.length === DEFAULT_GLOBAL_SEARCH_LIMIT
  ) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'global-search__more';
    more.dataset['action'] = 'expand';
    more.textContent = 'Vis flere treff';
    refs.dropdown.appendChild(more);
  }
}

function buildResultRow(result: GlobalSearchResult): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'global-search__row';
  li.dataset['cardId'] = result.card.id;
  li.tabIndex = 0;
  li.setAttribute('role', 'button');

  const thumb = document.createElement('div');
  thumb.className = 'global-search__thumb';
  thumb.appendChild(
    createLazyImage({
      src: result.card.imageSmall,
      alt: result.card.name,
      width: 32,
      height: 44,
      className: 'global-search__thumb-img',
    }),
  );
  li.appendChild(thumb);

  const main = document.createElement('div');
  main.className = 'global-search__main';
  const title = document.createElement('div');
  title.className = 'global-search__title';
  title.textContent = `${result.card.name} · ${result.card.number}`;
  main.appendChild(title);
  const sub = document.createElement('div');
  sub.className = 'global-search__sub';
  sub.textContent = `${result.set?.name ?? result.card.setId} · ${result.card.id}`;
  main.appendChild(sub);
  li.appendChild(main);

  const badges = document.createElement('div');
  badges.className = 'global-search__badges';
  if (result.badges.owned) badges.appendChild(buildBadge('Eid', 'success'));
  if (result.badges.activeWishlist)
    badges.appendChild(buildBadge('Ønskeliste', 'info'));
  if (result.badges.inBinder) badges.appendChild(buildBadge('Perm', 'info'));
  if (result.badges.inLot) badges.appendChild(buildBadge('Lot', 'warning'));
  li.appendChild(badges);

  return li;
}

function buildBadge(text: string, kind: 'success' | 'info' | 'warning'): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = `status-chip status-chip--${kind} global-search__badge`;
  span.textContent = text;
  return span;
}

function hideDropdown(refs: SearchRefs): void {
  refs.dropdown.hidden = true;
  refs.dropdown.replaceChildren();
}

function closePanel(refs: SearchRefs, state: SearchState): void {
  state.panelCardId = null;
  refs.panel.hidden = true;
  refs.panel.replaceChildren();
}

function closeAll(refs: SearchRefs, state: SearchState): void {
  closePanel(refs, state);
  hideDropdown(refs);
}

async function openPanel(
  refs: SearchRefs,
  state: SearchState,
  cardId: string,
): Promise<void> {
  state.panelCardId = cardId;
  refs.panel.hidden = false;
  refs.panel.replaceChildren();
  const loading = document.createElement('p');
  loading.className = 'global-search__panel-loading';
  loading.textContent = 'Henter status…';
  refs.panel.appendChild(loading);
  hideDropdown(refs);
  await renderPanelStatus(refs, state, cardId);
}

async function renderPanelStatus(
  refs: SearchRefs,
  state: SearchState,
  cardId: string,
): Promise<void> {
  if (state.panelCardId !== cardId) return; // user moved on
  let status: CardStatus;
  try {
    status = await loadStatus(cardId);
  } catch {
    refs.panel.replaceChildren();
    const error = document.createElement('p');
    error.className = 'global-search__panel-error';
    error.textContent = 'Kortet finnes ikke i lokal cache.';
    refs.panel.appendChild(error);
    return;
  }
  if (state.panelCardId !== cardId) return;
  refs.panel.replaceChildren(buildPanelDom(status));
}

function buildPanelDom(status: CardStatus): HTMLElement {
  const root = document.createElement('article');
  root.className = 'global-search__panel-content';
  root.appendChild(buildPanelHeader(status));
  root.appendChild(buildPanelActions(status));
  root.appendChild(buildPanelHoldings(status));
  root.appendChild(buildPanelBinders(status));
  root.appendChild(buildPanelWishlist(status));
  root.appendChild(buildPanelLots(status));
  return root;
}

function buildPanelHeader(status: CardStatus): HTMLElement {
  const header = document.createElement('header');
  header.className = 'global-search__panel-header';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'global-search__panel-close';
  close.dataset['action'] = 'close-panel';
  close.setAttribute('aria-label', 'Lukk');
  close.textContent = '×';
  header.appendChild(close);

  const image = createLazyImage({
    src: status.card.imageSmall,
    alt: status.card.name,
    width: 60,
    height: 84,
    className: 'global-search__panel-image',
  });
  header.appendChild(image);

  const meta = document.createElement('div');
  meta.className = 'global-search__panel-meta';
  const title = document.createElement('h3');
  title.textContent = status.card.name;
  meta.appendChild(title);
  const sub = document.createElement('p');
  sub.className = 'global-search__panel-sub';
  sub.textContent = `${status.set?.name ?? status.card.setId} #${status.card.number} · ${status.card.id}`;
  meta.appendChild(sub);
  if (status.card.rarity !== null) {
    const rarity = document.createElement('p');
    rarity.className = 'global-search__panel-rarity';
    rarity.textContent = status.card.rarity;
    meta.appendChild(rarity);
  }
  header.appendChild(meta);
  return header;
}

function buildPanelActions(status: CardStatus): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'global-search__panel-actions';

  const open = document.createElement('button');
  open.type = 'button';
  open.dataset['action'] = 'open-card';
  open.textContent = 'Åpne kort';
  wrap.appendChild(open);

  const decision = decideQuickAdd(status.card);
  const quick = document.createElement('button');
  quick.type = 'button';
  quick.dataset['action'] = 'quick-add';
  quick.textContent = '+1 raw';
  if (!decision.canQuickAdd) {
    quick.disabled = true;
    quick.title = decision.reason;
  }
  wrap.appendChild(quick);

  const wishlist = document.createElement('button');
  wishlist.type = 'button';
  wishlist.dataset['action'] = 'add-wishlist';
  wishlist.textContent = 'Legg i ønskeliste';
  wrap.appendChild(wishlist);

  // PR 23 review patch — only show the button when there are actual
  // matching candidates (cardId + finish), not just "anything active
  // exists". Prevents dead-end clicks that would only show the
  // "ingen matchende oppføringer" alert.
  if (status.summary.receiveCandidateCount > 0) {
    const receive = document.createElement('button');
    receive.type = 'button';
    receive.dataset['action'] = 'receive';
    receive.className = 'browse-table__action--success';
    receive.textContent = 'Marker mottatt';
    wrap.appendChild(receive);
  }

  return wrap;
}

function buildPanelHoldings(status: CardStatus): HTMLElement {
  const section = document.createElement('section');
  section.className = 'global-search__panel-section';
  const heading = document.createElement('h4');
  heading.textContent = `Dine kort (${status.summary.totalQuantityOwned})`;
  section.appendChild(heading);
  if (status.holdings.length === 0) {
    section.appendChild(emptyP('Ikke eid.'));
    return section;
  }
  const list = document.createElement('ul');
  list.className = 'global-search__panel-list';
  for (const h of status.holdings) {
    const li = document.createElement('li');
    li.textContent = formatHolding(h);
    list.appendChild(li);
  }
  section.appendChild(list);
  return section;
}

function formatHolding(h: HoldingRecord): string {
  const condition =
    h.conditionType === 'graded'
      ? `${h.gradingCompany ?? '?'} ${h.grade !== null ? h.grade.toFixed(1) : '?'}`
      : (h.rawCondition ?? '?');
  return `${condition} · ${h.finish} · ${h.edition} · antall ${h.quantity}`;
}

function buildPanelBinders(status: CardStatus): HTMLElement {
  const section = document.createElement('section');
  section.className = 'global-search__panel-section';
  const heading = document.createElement('h4');
  heading.textContent = `Permer (${status.summary.binderSlotCount})`;
  section.appendChild(heading);
  if (status.binderSlots.length === 0) {
    section.appendChild(emptyP('Ikke i noen perm.'));
    return section;
  }
  const list = document.createElement('ul');
  list.className = 'global-search__panel-list';
  for (const m of status.binderSlots) {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = `${m.binder.name} · side ${m.slot.pageNumber} slot ${m.slot.slotNumber} · ${m.matchedBy === 'target' ? 'mål' : 'tilordnet'}`;
    li.appendChild(label);
    const goto = document.createElement('button');
    goto.type = 'button';
    goto.className = 'global-search__panel-action';
    goto.dataset['action'] = 'goto-slot';
    goto.dataset['binderId'] = m.binder.id;
    goto.dataset['slotId'] = m.slot.id;
    goto.textContent = 'Gå til side';
    li.appendChild(goto);
    list.appendChild(li);
  }
  section.appendChild(list);
  return section;
}

function buildPanelWishlist(status: CardStatus): HTMLElement {
  const section = document.createElement('section');
  section.className = 'global-search__panel-section';
  const heading = document.createElement('h4');
  heading.textContent = `Ønskeliste (${status.summary.activeWishlistCount} aktive)`;
  section.appendChild(heading);
  if (status.activeWishlist.length === 0) {
    section.appendChild(emptyP('Ingen aktive ønskeliste-oppføringer.'));
    return section;
  }
  const list = document.createElement('ul');
  list.className = 'global-search__panel-list';
  for (const w of status.activeWishlist) {
    const li = document.createElement('li');
    li.textContent = `${wishlistStatusLabel(w.status)} · ${w.priority} · ${w.finish}${w.note !== null ? ` · ${w.note}` : ''}`;
    list.appendChild(li);
  }
  section.appendChild(list);
  return section;
}

function buildPanelLots(status: CardStatus): HTMLElement {
  const section = document.createElement('section');
  section.className = 'global-search__panel-section';
  const heading = document.createElement('h4');
  heading.textContent = `Ufordelte lot-items (${status.summary.unmaterialisedLotCount})`;
  section.appendChild(heading);
  if (status.unmaterialisedLotItems.length === 0) {
    section.appendChild(emptyP('Ingen ufordelte lot-items for dette kortet.'));
    return section;
  }
  const list = document.createElement('ul');
  list.className = 'global-search__panel-list';
  for (const e of status.unmaterialisedLotItems) {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = `${e.lot.name} · ${e.item.quantity} stk · ${e.item.finish}/${e.item.edition}`;
    li.appendChild(label);
    const goto = document.createElement('button');
    goto.type = 'button';
    goto.className = 'global-search__panel-action';
    goto.dataset['action'] = 'goto-lot';
    goto.dataset['lotId'] = e.lot.id;
    goto.textContent = 'Åpne lot';
    li.appendChild(goto);
    list.appendChild(li);
  }
  section.appendChild(list);
  return section;
}

function emptyP(text: string): HTMLParagraphElement {
  const p = document.createElement('p');
  p.className = 'global-search__panel-empty';
  p.textContent = text;
  return p;
}

async function loadStatus(cardId: string): Promise<CardStatus> {
  const db = getDb();
  const cardsRepo = createCardsRepo(db);
  const setsRepo = createSetsRepo(db);
  const holdingsRepo = createHoldingsRepo(db);
  const wishlistRepo = createWishlistRepo(db);
  const bindersRepo = createBindersRepo(db);
  const binderSlotsRepo = createBinderSlotsRepo(db);
  const lotsRepo = createLotsRepo(db);
  const lotItemsRepo = createLotItemsRepo(db);
  const binderSlotService = createBinderSlotService(
    bindersRepo,
    binderSlotsRepo,
    holdingsRepo,
    cardsRepo,
  );
  return getCardStatus(
    {
      cardsRepo,
      setsRepo,
      holdingsRepo,
      wishlistRepo,
      lotsRepo,
      lotItemsRepo,
      binderSlotService,
    },
    cardId,
  );
}

async function runPanelQuickAdd(
  refs: SearchRefs,
  state: SearchState,
  cardId: string,
): Promise<void> {
  const cardsRepo = createCardsRepo(getDb());
  const card = await cardsRepo.get(cardId);
  if (card === undefined) return;
  try {
    const { result, receiveCandidates } = await quickAddRawCard(
      {
        holdingsRepo: createHoldingsRepo(getDb()),
        wishlistRepo: createWishlistRepo(getDb()),
      },
      card,
    );
    void result;
    window.dispatchEvent(new CustomEvent(USER_DATA_CHANGED_EVENT));
    await renderPanelStatus(refs, state, cardId);
    if (receiveCandidates.length > 0) {
      await openWishlistReceivePrompt({
        candidates: receiveCandidates,
        heading:
          receiveCandidates.length === 1
            ? 'Quick Add: 1 match på aktiv ønskeliste.'
            : `Quick Add: ${receiveCandidates.length} matcher på aktiv ønskeliste.`,
      });
    }
  } catch (caught) {
    if (caught instanceof QuickAddNotEligibleError) {
      window.alert(`Quick Add ikke tilgjengelig: ${caught.reason}`);
      return;
    }
    if (caught instanceof ValidationError) {
      window.alert(`Quick Add avvist: ${caught.message}`);
      return;
    }
    if (caught instanceof Error) {
      window.alert(`Quick Add feilet: ${caught.message}`);
      return;
    }
    window.alert('Quick Add feilet av en ukjent grunn.');
  }
}

async function runPanelReceive(
  refs: SearchRefs,
  state: SearchState,
  cardId: string,
): Promise<void> {
  let candidates: WishlistReceiveCandidate[];
  try {
    const status = await loadStatus(cardId);
    candidates = await findReceiveCandidatesForHoldings(
      createWishlistRepo(getDb()),
      status.holdings,
    );
  } catch {
    candidates = [];
  }
  if (candidates.length === 0) {
    window.alert('Ingen matchende aktive wishlist-oppføringer.');
    return;
  }
  await openWishlistReceivePrompt({
    candidates,
    heading:
      candidates.length === 1
        ? 'Eid + aktiv ønskeliste — én match på samme kort + finish.'
        : `Eid + aktiv ønskeliste — ${candidates.length} matcher på samme kort + finish.`,
  });
  await renderPanelStatus(refs, state, cardId);
}
