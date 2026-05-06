import { renderBackup } from './views/backup';
import { renderBinders } from './views/binders';
import { renderBrowse } from './views/browse';
import { renderCollection } from './views/collection';
import { renderDashboard } from './views/dashboard';
import { renderLots } from './views/lots';
import { renderSettings } from './views/settings';
import { renderWishlist } from './views/wishlist';
import { getCurrentRoute, onRouteChange, type Route } from './router';

const VIEW_RENDERERS: Record<Route, () => string> = {
  dashboard: renderDashboard,
  browse: renderBrowse,
  collection: renderCollection,
  binders: renderBinders,
  lots: renderLots,
  wishlist: renderWishlist,
  backup: renderBackup,
  settings: renderSettings,
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
        <span class="status-chip status-chip--info" title="Database og sync er ikke implementert ennå">
          App-skall (PR 2)
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
  const route = getCurrentRoute();
  const render = VIEW_RENDERERS[route];
  content.innerHTML = render();
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
