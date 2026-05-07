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

/**
 * PR 17 — deep-link to a specific slot inside a binder. The hash
 * encodes the slot id after the binder id with a `/slot/` separator
 * so URLs like `#binder/abc/slot/xyz` are bookmarkable. Binder-detail
 * reads the slot id via `getCurrentBinderSlotFocus()` on mount and
 * scrolls that slot into view.
 */
export function navigateToBinderSlot(
  binderId: string,
  slotId: string,
): void {
  window.location.hash = `${BINDER_PATH_PREFIX}${encodeURIComponent(binderId)}/slot/${encodeURIComponent(slotId)}`;
}

/**
 * Returns the slot id from a `#binder/<id>/slot/<slotId>` hash, or
 * `null` for a plain `#binder/<id>` (or any other route).
 */
export function getCurrentBinderSlotFocus(): string | null {
  return extractBinderSlotId(window.location.hash.slice(1));
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
  // `#binder/<id>` AND `#binder/<id>/slot/<slotId>` both yield the
  // binder id. The slot suffix is parsed separately by
  // `extractBinderSlotId` (PR 17 deep-link).
  if (!hash.startsWith(BINDER_PATH_PREFIX)) return null;
  const rest = hash.slice(BINDER_PATH_PREFIX.length);
  if (rest.length === 0) return null;
  const slotMarker = '/slot/';
  const slotAt = rest.indexOf(slotMarker);
  const encoded = slotAt === -1 ? rest : rest.slice(0, slotAt);
  if (encoded.length === 0) return null;
  try {
    const decoded = decodeURIComponent(encoded);
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

function extractBinderSlotId(hash: string): string | null {
  if (!hash.startsWith(BINDER_PATH_PREFIX)) return null;
  const rest = hash.slice(BINDER_PATH_PREFIX.length);
  const slotMarker = '/slot/';
  const slotAt = rest.indexOf(slotMarker);
  if (slotAt === -1) return null;
  const encoded = rest.slice(slotAt + slotMarker.length);
  if (encoded.length === 0) return null;
  try {
    const decoded = decodeURIComponent(encoded);
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
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
