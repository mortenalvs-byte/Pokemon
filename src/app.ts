import { mountBackupView } from './views/backup';
import { mountBinderDetailView } from './views/binder-detail';
import { mountBindersView } from './views/binders';
import { mountBrowseView } from './views/browse';
import { mountCardDetailView } from './views/card-detail';
import { mountCollectionView } from './views/collection';
import { mountDashboardView } from './views/dashboard';
import { mountLotDetailView } from './views/lot-detail';
import { mountLotsView } from './views/lots';
import { mountMasterGapView } from './views/master-gap';
import { mountSettingsView, SYNC_STATUS_CHANGED_EVENT } from './views/settings';
import { mountWishlistView } from './views/wishlist';
import { mountGlobalSearch } from './components/global-search';
import { mountKeyboardShortcuts } from './components/keyboard-shortcuts';
import { getCurrentRoute, onRouteChange, type Route } from './router';
import { APP_META_KEYS } from './domain/types';
import { getDb } from './db/database';

// Each view receives an AbortSignal that the router aborts before
// mounting the next view. Mounts use the signal on `addEventListener`
// so leftover listeners stop re-rendering into the shared `<main>`
// after the route has changed (PR 15A — fixes F-3 router race).
type ViewMounter = (container: HTMLElement, signal: AbortSignal) => void;

const VIEW_MOUNTERS: Record<Route, ViewMounter> = {
  dashboard: mountDashboardView,
  browse: mountBrowseView,
  collection: mountCollectionView,
  binders: mountBindersView,
  lots: mountLotsView,
  wishlist: mountWishlistView,
  backup: mountBackupView,
  settings: mountSettingsView,
  'card-detail': mountCardDetailView,
  'binder-detail': mountBinderDetailView,
  'lot-detail': mountLotDetailView,
  'master-gap': mountMasterGapView,
};

interface NavLink {
  readonly route: Route;
  readonly label: string;
}

const NAV_LINKS: readonly NavLink[] = [
  { route: 'dashboard', label: 'Dashboard' },
  { route: 'browse', label: 'Browse' },
  { route: 'collection', label: 'Min samling' },
  { route: 'binders', label: 'Permer' },
  { route: 'lots', label: 'Lotter' },
  { route: 'wishlist', label: 'Ønskeliste' },
  { route: 'backup', label: 'Backup' },
  { route: 'settings', label: 'Innstillinger' },
];

export function mountApp(root: HTMLElement): void {
  root.innerHTML = renderShell();
  renderActiveView();
  updateNavActive();
  setupTopbar();
  // PR 26 — desktop keyboard navigation. Idempotent so a second
  // mountApp() call (test re-mount) doesn't double-register the
  // global keydown listener.
  mountKeyboardShortcuts();
  onRouteChange(() => {
    renderActiveView();
    updateNavActive();
  });
}

// PR 26 — sidebar nav links advertise their keyboard shortcut via
// `aria-keyshortcuts` so screen readers and devtools can surface them.
// The actual key handling lives in `components/keyboard-shortcuts.ts`.
const SIDEBAR_KEYSHORTCUT: Partial<Record<Route, string>> = {
  dashboard: 'g d',
  browse: 'g b',
  collection: 'g c',
  binders: 'g p',
  lots: 'g l',
  wishlist: 'g w',
};

function renderShell(): string {
  const navItems = NAV_LINKS.map((link) => {
    const shortcut = SIDEBAR_KEYSHORTCUT[link.route];
    const ariaShortcut =
      shortcut !== undefined ? ` aria-keyshortcuts="${shortcut}"` : '';
    return `
      <li>
        <a class="sidebar__link" href="#${link.route}" data-route="${link.route}"${ariaShortcut}>
          ${link.label}
        </a>
      </li>
    `;
  }).join('');

  // PR 26 — wrap topbar + layout in `app-shell` and tag every shell
  // region with stable `data-region` attributes so desktop layout CSS
  // and tests can target them deterministically. The brand is now an
  // anchor to `#dashboard` so clicking the title works like a typical
  // desktop app's logo. The `topbar-search` slot is preserved verbatim
  // — global search (PR 23) mounts there.
  return `
    <div class="app-shell" data-region="app-shell">
      <header class="topbar" role="banner" data-region="topbar">
        <a class="topbar__brand" href="#dashboard" data-region="topbar-brand">Pokemon TCG Tracker</a>
        <div class="topbar__search" data-region="topbar-search"></div>
        <div class="topbar__status" data-region="topbar-status" aria-live="polite"></div>
      </header>
      <div class="layout">
        <nav class="sidebar" aria-label="Hovednavigasjon" data-region="sidebar">
          <ul class="sidebar__list">${navItems}</ul>
        </nav>
        <main class="content" id="content" role="main" data-region="content"></main>
      </div>
    </div>
  `;
}

// Tracks the AbortController for the currently mounted view. Before
// every new mount we abort the previous one — that drops every
// `addEventListener(..., { signal })` the previous view registered, so
// stale listeners cannot re-render into the (now reused) `<main>`
// element. Reproduced as F-3 in QA: saving in `#lots` flipped main to
// the card-detail empty state because a leftover card-detail handler
// fired into the same shared container.
let currentMountController: AbortController | null = null;

function renderActiveView(): void {
  const content = document.getElementById('content');
  if (!content) {
    return;
  }
  if (currentMountController !== null) {
    currentMountController.abort();
  }
  currentMountController = new AbortController();
  content.innerHTML = '';
  VIEW_MOUNTERS[getCurrentRoute()](content, currentMountController.signal);
}

function updateNavActive(): void {
  const current = getCurrentRoute();
  const links = document.querySelectorAll<HTMLAnchorElement>('[data-route]');
  links.forEach((link) => {
    if (link.dataset['route'] === current) {
      link.classList.add('sidebar__link--active');
      link.setAttribute('aria-current', 'page');
    } else {
      link.classList.remove('sidebar__link--active');
      link.removeAttribute('aria-current');
    }
  });
}

// ---------------------------------------------------------------------
// Topbar sync chip
//
// Reads `appMeta.lastSyncAt` and `appMeta.lastSyncStatus` from the live
// database and renders a small status chip. Listens for
// `pokemon:sync-status-changed`, dispatched by the Settings view after
// every sync attempt — successful or failed — so the chip never gets
// stuck on stale "ok" state after a subsequent failure.

function setupTopbar(): void {
  void renderTopbarStatus();
  window.addEventListener(SYNC_STATUS_CHANGED_EVENT, () => {
    void renderTopbarStatus();
  });
  // PR 23 — global search lives next to the brand. The component is
  // idempotent; one mount per app session.
  const searchSlot = document.querySelector<HTMLElement>(
    '[data-region="topbar-search"]',
  );
  if (searchSlot !== null) {
    mountGlobalSearch(searchSlot);
  }
}

async function renderTopbarStatus(): Promise<void> {
  const region = document.querySelector<HTMLElement>(
    '[data-region="topbar-status"]',
  );
  if (!region) {
    return;
  }

  let lastSyncAt: string | null = null;
  let lastSyncStatus: string | null = null;
  try {
    const db = getDb();
    const lastSyncRow = await db.appMeta.get(APP_META_KEYS.lastSyncAt);
    const lastStatusRow = await db.appMeta.get(APP_META_KEYS.lastSyncStatus);
    if (typeof lastSyncRow?.value === 'string') {
      lastSyncAt = lastSyncRow.value;
    }
    if (typeof lastStatusRow?.value === 'string') {
      lastSyncStatus = lastStatusRow.value;
    }
  } catch {
    // Database not yet initialized; show a neutral chip.
  }

  region.replaceChildren();
  const chip = document.createElement('span');
  if (lastSyncStatus === 'failed') {
    chip.className = 'status-chip status-chip--warning';
    chip.textContent = 'sync_failed';
  } else if (lastSyncAt === null) {
    chip.className = 'status-chip status-chip--info';
    chip.textContent = 'Aldri synket';
  } else {
    chip.className = 'status-chip status-chip--success';
    chip.textContent = `Sist synket ${formatRelativeTimestamp(lastSyncAt)}`;
  }
  region.appendChild(chip);
}

function formatRelativeTimestamp(iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) {
    return iso;
  }
  // Show the calendar date in the user's locale; relative-time
  // formatting can come later if needed.
  return new Date(parsed).toISOString().slice(0, 10);
}
