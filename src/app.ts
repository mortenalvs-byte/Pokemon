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
import {
  mountSettingsView,
  SETTINGS_CHANGED_EVENT,
  SYNC_STATUS_CHANGED_EVENT,
} from './views/settings';
import { mountWishlistView } from './views/wishlist';
import { mountGlobalSearch } from './components/global-search';
import { mountKeyboardShortcuts } from './components/keyboard-shortcuts';
import { mountKeyboardShortcutsHelp } from './components/keyboard-shortcuts-help';
import { getCurrentRoute, onRouteChange, type Route } from './router';
import { APP_META_KEYS } from './domain/types';
import {
  DEFAULT_PERSONAL_PREFERENCES,
  type PersonalStartRoute,
} from './domain/personal-preferences';
import { getDb } from './db/database';
import { createSettingsRepo } from './repositories/settings-repo';
import { createPersonalPreferencesService } from './services/personal-preferences-service';

// Each view receives an AbortSignal that the router aborts before
// mounting the next view. Mounts use the signal on `addEventListener`
// so leftover listeners stop re-rendering into the shared `<main>`
// after the route has changed (PR 15A — fixes F-3 router race).
type ViewMounter = (container: HTMLElement, signal: AbortSignal) => void;

// PR 28 review patch — dev-only QA harness mounter. In production
// builds the route exists in the type union but maps to the
// dashboard so `#qa` does nothing; in dev it mounts the harness UI.
// Vite injects `import.meta.env.DEV` at build time so the production
// chunk never carries the QA module bundled in.
const qaViewMounter: ViewMounter = import.meta.env.DEV
  ? (container, signal): void => {
      void import('./views/qa').then((mod) => mod.mountQaView(container, signal));
    }
  : mountDashboardView;

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
  qa: qaViewMounter,
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
  // PR 28 review patch — dev-only QA nav link. Vite tree-shakes this
  // out of production / Tauri release builds because
  // `import.meta.env.DEV` is statically replaced at build time.
  ...(import.meta.env.DEV
    ? ([{ route: 'qa', label: 'QA harness (dev)' }] as const)
    : []),
];

export function mountApp(root: HTMLElement): void {
  root.innerHTML = renderShell();
  // PR 28 review patch — dev-only boot-time persistence auto-audit.
  // Runs once on every app boot in dev/preview builds, captures a
  // full `PersistenceDiagnostic`, and appends it to a localStorage
  // history (`pokemon.persistenceDiagBootHistory`). This lets us
  // observe Launch A → B → C across cold restarts WITHOUT any UI
  // navigation — the data is dumped to localStorage which survives
  // the same way `pokemon.desktopPersistenceSentinel` does. We
  // tree-shake the entire path out of production builds via the
  // `import.meta.env.DEV` guard.
  if (import.meta.env.DEV) {
    void runBootTimePersistenceAudit();
  }
  // PR 27 — apply personal preferences AFTER the shell is in place so
  // the brand text/href reflect the user's choices on first paint.
  // Default-start-route runs before `renderActiveView()` so the empty
  // hash case lands on the right view immediately, not after a
  // re-render. Both paths are async + best-effort; the app keeps
  // working with the shipped fallback brand if the settings read
  // throws.
  void applyPersonalPreferencesToShell();
  applyDefaultStartRouteIfEmpty();
  renderActiveView();
  updateNavActive();
  setupTopbar();
  // PR 26 — desktop keyboard navigation. Idempotent so a second
  // mountApp() call (test re-mount) doesn't double-register the
  // global keydown listener.
  mountKeyboardShortcuts();
  // PR 27 — Snarveier-knapp i topbar (gated on showShortcutHints).
  void mountKeyboardShortcutsHelp();
  // PR 27 — refresh brand + shortcut-help visibility when the user
  // saves personal preferences. We never re-mount the whole app.
  window.addEventListener(SETTINGS_CHANGED_EVENT, () => {
    void applyPersonalPreferencesToShell();
    void mountKeyboardShortcutsHelp();
  });
  onRouteChange(() => {
    renderActiveView();
    updateNavActive();
  });
}

// ---------------------------------------------------------------------
// PR 28 review patch — dev-only boot-time persistence audit.

const BOOT_AUDIT_HISTORY_KEY = 'pokemon.persistenceDiagBootHistory';
const BOOT_AUDIT_HISTORY_LIMIT = 5;

async function runBootTimePersistenceAudit(): Promise<void> {
  try {
    const { buildPersistenceDiagnostic } = await import(
      './qa/desktop-persistence-diagnostic'
    );
    const diagnostic = await buildPersistenceDiagnostic(getDb());
    const history = readBootAuditHistory();
    history.push({
      capturedAt: diagnostic.capturedAt,
      origin: diagnostic.location.origin,
      runtime: diagnostic.runtime,
      dexie: diagnostic.dexie,
      storeCounts: diagnostic.storeCounts,
      firstHoldingIds: diagnostic.firstHoldingIds,
      firstAppMetaKeys: diagnostic.firstAppMetaKeys,
      storage: diagnostic.storage,
      indexedDbDatabases: diagnostic.indexedDbDatabases,
      localStorageSentinel: diagnostic.localStorageSentinel,
      appMetaSentinel: diagnostic.appMetaSentinel,
      notes: diagnostic.notes,
    });
    while (history.length > BOOT_AUDIT_HISTORY_LIMIT) history.shift();
    writeBootAuditHistory(history);
    // eslint-disable-next-line no-console -- dev-only diagnostic
    console.log('[boot-audit]', diagnostic);
  } catch (caught) {
    // eslint-disable-next-line no-console -- dev-only diagnostic
    console.error('[boot-audit] failed', caught);
  }
}

function readBootAuditHistory(): unknown[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(BOOT_AUDIT_HISTORY_KEY);
    if (raw === null) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

function writeBootAuditHistory(history: unknown[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(BOOT_AUDIT_HISTORY_KEY, JSON.stringify(history));
  } catch {
    // best-effort; storage may be full
  }
}

// ---------------------------------------------------------------------
// PR 27 — personal preferences glue for the shell.

async function applyPersonalPreferencesToShell(): Promise<void> {
  const fallbackName = DEFAULT_PERSONAL_PREFERENCES.appDisplayName;
  const fallbackRoute: PersonalStartRoute =
    DEFAULT_PERSONAL_PREFERENCES.defaultStartRoute;
  let displayName = fallbackName;
  let startRoute: PersonalStartRoute = fallbackRoute;
  try {
    const svc = createPersonalPreferencesService(
      createSettingsRepo(getDb()),
    );
    const prefs = await svc.getPreferences();
    displayName = prefs.appDisplayName;
    startRoute = prefs.defaultStartRoute;
  } catch {
    // Fall back; brand stays on its shipped default.
  }
  const brand = document.querySelector<HTMLAnchorElement>(
    '[data-region="topbar-brand"]',
  );
  if (brand !== null) {
    brand.textContent = displayName;
    brand.setAttribute('href', `#${startRoute}`);
  }
}

const DEEP_LINK_PREFIXES = [
  'card/',
  'binder/',
  'lot/',
  'master-gap/',
] as const;

function applyDefaultStartRouteIfEmpty(): void {
  // We only intervene when the user opens the app with NO hash. A
  // bare `#dashboard` or any deep link is left alone. Reading the
  // setting synchronously is not possible (settingsRepo is async),
  // so we read it best-effort and patch the hash if the route
  // changed by the time we resolve. The patched hash is itself a
  // sidebar route, never a deep link.
  const initialHash = window.location.hash.slice(1);
  if (initialHash !== '') return; // user picked a route already
  // Kick off async resolution; if it succeeds AND the user hasn't
  // navigated in the meantime, navigate.
  void (async () => {
    try {
      const svc = createPersonalPreferencesService(
        createSettingsRepo(getDb()),
      );
      const prefs = await svc.getPreferences();
      // Re-check current hash before navigating — a deep link may
      // have arrived between our read kick-off and resolve.
      const live = window.location.hash.slice(1);
      if (live !== '') return;
      if (DEEP_LINK_PREFIXES.some((p) => live.startsWith(p))) return;
      if (prefs.defaultStartRoute === 'dashboard') return; // no-op
      window.location.hash = prefs.defaultStartRoute;
    } catch {
      // Fall back: dashboard is the default route already.
    }
  })();
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

// PR 28 — runtime detection. Tauri v2 injects `window.__TAURI_INTERNALS__`
// before the app boots, which is the documented signal Tauri itself
// uses. We never import a Tauri JS API — this is a pure feature flag,
// safe in browser tests (where the property is absent) and safe in
// the desktop shell (where it is present).
export function isTauriRuntime(): boolean {
  return (
    typeof window !== 'undefined' &&
    Object.prototype.hasOwnProperty.call(window, '__TAURI_INTERNALS__')
  );
}

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
        ${isTauriRuntime() ? '<span class="topbar__runtime-badge" data-region="runtime-badge" title="Kjører i Tauri desktop-shell">Desktop</span>' : ''}
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
