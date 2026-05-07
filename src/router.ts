// Hash-based router.
//
// Sidebar destinations are listed in `SIDEBAR_ROUTES`. The card-detail
// page is a separate route that lives at `#card/<encodedCardId>` and is
// not part of the sidebar — it is only reached by clicking a card row
// from Browse (or by an explicit `navigateToCard()` call).
//
// `getCurrentRoute()` returns `'card-detail'` only when the hash is a
// well-formed `#card/<id>` *and* the decoded id is non-empty. A bare
// `#card/` or a malformed encoded id falls back to the default route,
// so there is no "empty card" page.

export const SIDEBAR_ROUTES = [
  'dashboard',
  'browse',
  'collection',
  'binders',
  'lots',
  'wishlist',
  'backup',
  'settings',
] as const;

export type SidebarRoute = (typeof SIDEBAR_ROUTES)[number];

// Includes `card-detail`, `binder-detail`, and `lot-detail` so the
// view-mounter map can register them, but the router intentionally
// does not treat the bare strings as valid hashes — they are only
// reachable via their `#card/<id>`, `#binder/<id>`, and `#lot/<id>`
// forms.
export type Route =
  | SidebarRoute
  | 'card-detail'
  | 'binder-detail'
  | 'lot-detail';

// Existing tests import `ROUTES`; keep it pointing at the sidebar list
// so the canonical-routes assertion stays meaningful.
export const ROUTES = SIDEBAR_ROUTES;

export const DEFAULT_ROUTE: SidebarRoute = 'dashboard';

const CARD_PATH_PREFIX = 'card/';
const BINDER_PATH_PREFIX = 'binder/';
const LOT_PATH_PREFIX = 'lot/';

export function isRoute(value: string): value is SidebarRoute {
  return (SIDEBAR_ROUTES as readonly string[]).includes(value);
}

export function getCurrentRoute(): Route {
  const hash = window.location.hash.slice(1);
  if (extractCardId(hash) !== null) {
    return 'card-detail';
  }
  if (extractBinderId(hash) !== null) {
    return 'binder-detail';
  }
  if (extractLotId(hash) !== null) {
    return 'lot-detail';
  }
  return isRoute(hash) ? hash : DEFAULT_ROUTE;
}

export function getCurrentCardId(): string | null {
  return extractCardId(window.location.hash.slice(1));
}

export function getCurrentBinderId(): string | null {
  return extractBinderId(window.location.hash.slice(1));
}

export function getCurrentLotId(): string | null {
  return extractLotId(window.location.hash.slice(1));
}

export function navigate(route: SidebarRoute): void {
  window.location.hash = route;
}

export function navigateToCard(cardId: string): void {
  window.location.hash = `${CARD_PATH_PREFIX}${encodeURIComponent(cardId)}`;
}

export function navigateToBinder(binderId: string): void {
  window.location.hash = `${BINDER_PATH_PREFIX}${encodeURIComponent(binderId)}`;
}

export function navigateToLot(lotId: string): void {
  window.location.hash = `${LOT_PATH_PREFIX}${encodeURIComponent(lotId)}`;
}

export function onRouteChange(handler: (route: Route) => void): () => void {
  const listener = (): void => {
    handler(getCurrentRoute());
  };
  window.addEventListener('hashchange', listener);
  return () => {
    window.removeEventListener('hashchange', listener);
  };
}

function extractCardId(hash: string): string | null {
  return extractIdAfterPrefix(hash, CARD_PATH_PREFIX);
}

function extractBinderId(hash: string): string | null {
  return extractIdAfterPrefix(hash, BINDER_PATH_PREFIX);
}

function extractLotId(hash: string): string | null {
  return extractIdAfterPrefix(hash, LOT_PATH_PREFIX);
}

function extractIdAfterPrefix(hash: string, prefix: string): string | null {
  if (!hash.startsWith(prefix)) {
    return null;
  }
  const encoded = hash.slice(prefix.length);
  if (encoded.length === 0) {
    return null;
  }
  try {
    const decoded = decodeURIComponent(encoded);
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}
