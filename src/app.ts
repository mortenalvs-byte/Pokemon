import { mountBackupView } from './views/backup';
import { renderBinders } from './views/binders';
import { renderBrowse } from './views/browse';
import { renderCollection } from './views/collection';
import { renderDashboard } from './views/dashboard';
import { renderLots } from './views/lots';
import { renderSettings } from './views/settings';
import { renderWishlist } from './views/wishlist';
import { getCurrentRoute, onRouteChange, type Route } from './router';

type ViewMounter = (container: HTMLElement) => void;

// Most views are still pure HTML strings (PR 2 placeholders). The
// Backup view is interactive, so it owns its own container and attaches
// listeners directly. Future feature views will follow the mount-style
// pattern.
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
  settings: (container) => {
    container.innerHTML = renderSettings();
  },
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
      <div class="topbar__status" aria-live="polite">
        <span class="status-chip status-chip--info" title="Database, backup og sync er under arbeid">
          MVP under bygging
        </span>
      </div>
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
  // Reset content. Removing the old elements detaches any listeners the
  // previous view attached, so views never need explicit cleanup.
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
