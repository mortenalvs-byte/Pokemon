import { mountApp } from './app';
import { initializeDataLayer } from './db/init';

// PR 28 review patch — dev-only console + route-walk audit constants
// declared up front so the IIFE below has them available without
// running into the TDZ. Tree-shaken from production via
// `import.meta.env.DEV`.
const CONSOLE_HISTORY_KEY = 'pokemon.consoleAuditHistory';
const CONSOLE_HISTORY_LIMIT = 200;
const ROUTE_WALK_KEY = 'pokemon.routeWalkHistory';
const ROUTE_WALK_DELAY_MS = 1500;
const ROUTE_WALK_INITIAL_DELAY_MS = 5000;
const AUDIT_ROUTES: ReadonlyArray<string> = [
  'dashboard',
  'browse',
  'collection',
  'binders',
  'lots',
  'wishlist',
  'backup',
  'settings',
  'master-gap',
  'qa',
];

if (import.meta.env.DEV) {
  installConsoleAudit();
}

const root = document.getElementById('app');
if (!root) {
  throw new Error('Root element #app not found');
}

// Render the app shell first. Data layer initialization is async and may
// fail (corrupted DB, denied storage, browser quota); the shell stays
// usable either way. PR 4+ wires the result into a UI status chip.
mountApp(root);

initializeDataLayer().catch((error: unknown) => {
  // eslint-disable-next-line no-console -- intentional: surface init
  // failures during development. UI escalation comes in a later PR.
  console.error('[data-layer] initialization failed', error);
});

// PR 28 review patch — console audit + auto route walk.
//
// `installConsoleAudit` hooks the four error channels (console.error,
// console.warn, window.onerror, unhandledrejection) and persists each
// event to `localStorage[pokemon.consoleAuditHistory]`. Each entry is
// `{ ts, route, level, message }`. Capped at 200 entries so a noisy
// run can't overflow.
//
// `kickOffAutoRouteWalk` runs ~5 s after boot (so the data layer has
// settled), then walks every documented route with a short delay
// between hash changes. The audit is read after the walk by the
// Node-side reader in `.local/read-webview-localstorage.mjs`, which
// also dumps `pokemon.consoleAuditHistory`.
//
// Both are no-ops in production builds.

function installConsoleAudit(): void {
  if (typeof window === 'undefined') return;
  const origError = console.error;
  const origWarn = console.warn;
  const stringify = (args: unknown[]): string => {
    return args
      .map((a) => {
        if (a instanceof Error) return `${a.name}: ${a.message}`;
        if (typeof a === 'string') return a;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(' ');
  };
  const push = (level: string, message: string): void => {
    try {
      const raw = localStorage.getItem(CONSOLE_HISTORY_KEY);
      const arr: Array<{
        ts: string;
        route: string;
        level: string;
        message: string;
      }> = raw === null ? [] : (JSON.parse(raw) as never);
      arr.push({
        ts: new Date().toISOString(),
        route: window.location.hash.slice(1) || '<empty>',
        level,
        message,
      });
      while (arr.length > CONSOLE_HISTORY_LIMIT) arr.shift();
      localStorage.setItem(CONSOLE_HISTORY_KEY, JSON.stringify(arr));
    } catch {
      // best-effort
    }
  };
  console.error = (...args: unknown[]): void => {
    push('error', stringify(args));
    origError.apply(console, args);
  };
  console.warn = (...args: unknown[]): void => {
    push('warn', stringify(args));
    origWarn.apply(console, args);
  };
  window.addEventListener('error', (event) => {
    push(
      'window.error',
      `${event.message} (${event.filename}:${event.lineno}:${event.colno})`,
    );
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const msg =
      reason instanceof Error
        ? `${reason.name}: ${reason.message}`
        : String(reason);
    push('unhandledrejection', msg);
  });
  kickOffAutoRouteWalk();
}

function kickOffAutoRouteWalk(): void {
  if (typeof window === 'undefined') return;
  // Skip the walk on subsequent refreshes — each tauri-dev cold boot
  // gets exactly one walk, so the localStorage history stays diffable.
  // The Node reader resets the flag between runs.
  const existing = localStorage.getItem(ROUTE_WALK_KEY);
  if (existing !== null) {
    // Already walked — boot-audit history captures what we need.
    return;
  }
  const walk: Array<{ ts: string; route: string }> = [];
  const startHash = window.location.hash;
  setTimeout(() => {
    let i = 0;
    const step = (): void => {
      if (i >= AUDIT_ROUTES.length) {
        // Restore original hash and persist the walk record.
        window.location.hash = startHash || 'dashboard';
        try {
          localStorage.setItem(ROUTE_WALK_KEY, JSON.stringify(walk));
        } catch {
          // best-effort
        }
        return;
      }
      const route = AUDIT_ROUTES[i]!;
      window.location.hash = route;
      walk.push({ ts: new Date().toISOString(), route });
      i += 1;
      setTimeout(step, ROUTE_WALK_DELAY_MS);
    };
    step();
  }, ROUTE_WALK_INITIAL_DELAY_MS);
}
