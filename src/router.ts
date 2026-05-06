export const ROUTES = [
  'dashboard',
  'browse',
  'collection',
  'binders',
  'lots',
  'wishlist',
  'backup',
  'settings',
] as const;

export type Route = (typeof ROUTES)[number];

export const DEFAULT_ROUTE: Route = 'dashboard';

export function isRoute(value: string): value is Route {
  return (ROUTES as readonly string[]).includes(value);
}

export function getCurrentRoute(): Route {
  const hash = window.location.hash.slice(1);
  return isRoute(hash) ? hash : DEFAULT_ROUTE;
}

export function navigate(route: Route): void {
  window.location.hash = route;
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
