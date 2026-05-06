import { mountBackupView } from './views/backup';
import { renderBinders } from './views/binders';
import { renderBrowse } from './views/browse';
import { renderCollection } from './views/collection';
import { renderDashboard } from './views/dashboard';
import { renderLots } from './views/lots';
import { mountSettingsView, SYNC_COMPLETED_EVENT } from './views/settings';
import { renderWishlist } from './views/wishlist';
import { getCurrentRoute, onRouteChange, type Route } from './router';
import { APP_META_KEYS } from './domain/types';
import { getDb } from './db/database';

type ViewMounter = (container: HTMLElement) => void;

const VIEW_MOUNTERS: Record<Route, ViewMounter> = {
  dashboard: (container) => {
    container.innerHTML = renderDashboard();
  },
  browse: (container) => {
    container.innerHTML = renderBrowse();
  },
  collection: (container) => {
    container.innerHTML = renderCollection();
  },
  binders: (container) => {
    container.innerHTML = renderBinders();
  },
  lots: (container) => {
    container.innerHTML = renderLots();
  },
  wishlist: (container) => {
    container.innerHTML = renderWishlist();
  },
  backup: mountBackupView,
  settings: mountSettingsView,
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
  onRouteChange(() => {
    renderActiveView();
    updateNavActive();
  });
}

function renderShell(): string {
  const navItems = NAV_LINKS.map(
    (link) => `
      <li>
        <a class="sidebar__link" href="#${link.route}" data-route="${link.route}">
          ${link.label}
        </a>
      </li>
    `,
  ).join('');

  return `
    <header class="topbar" role="banner">
      <div class="topbar__brand">Pokemon TCG Tracker</div>
      <div class="topbar__status" data-region="topbar-status" aria-live="polite"></div>
    </header>
    <div class="layout">
      <nav class="sidebar" aria-label="Hovednavigasjon">
        <ul class="sidebar__list">${navItems}</ul>
      </nav>
      <main class="content" id="content" role="main"></main>
    </div>
  `;
}

function renderActiveView(): void {
  const content = document.getElementById('content');
  if (!content) {
    return;
  }
  content.innerHTML = '';
  VIEW_MOUNTERS[getCurrentRoute()](content);
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
// database and renders a small status chip. Listens for the
// `pokemon:sync-completed` custom event the Settings view dispatches
// after a successful sync, so the chip refreshes without a global
// state framework.

function setupTopbar(): void {
  void renderTopbarStatus();
  window.addEventListener(SYNC_COMPLETED_EVENT, () => {
    void renderTopbarStatus();
  });
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
