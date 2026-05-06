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

// Includes `card-detail` so the view-mounter map can register it, but
// the router intentionally does not treat the bare string `card-detail`
// as a valid hash — it is only reachable via the `#card/<id>` form.
export type Route = SidebarRoute | 'card-detail';

// Existing tests import `ROUTES`; keep it pointing at the sidebar list
// so the canonical-routes assertion stays meaningful.
export const ROUTES = SIDEBAR_ROUTES;

export const DEFAULT_ROUTE: SidebarRoute = 'dashboard';

const CARD_PATH_PREFIX = 'card/';

export function isRoute(value: string): value is SidebarRoute {
  return (SIDEBAR_ROUTES as readonly string[]).includes(value);
}

export function getCurrentRoute(): Route {
  const hash = window.location.hash.slice(1);
  if (extractCardId(hash) !== null) {
    return 'card-detail';
  }
  return isRoute(hash) ? hash : DEFAULT_ROUTE;
}

export function getCurrentCardId(): string | null {
  return extractCardId(window.location.hash.slice(1));
}

export function navigate(route: SidebarRoute): void {
  window.location.hash = route;
}

export function navigateToCard(cardId: string): void {
  window.location.hash = `${CARD_PATH_PREFIX}${encodeURIComponent(cardId)}`;
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
  if (!hash.startsWith(CARD_PATH_PREFIX)) {
    return null;
  }
  const encoded = hash.slice(CARD_PATH_PREFIX.length);
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
