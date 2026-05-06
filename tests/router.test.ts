import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ROUTE,
  ROUTES,
  getCurrentRoute,
  isRoute,
  navigate,
  onRouteChange,
} from '../src/router';

function setHash(value: string): void {
  // Setting location.hash directly fires a hashchange event in jsdom.
  window.location.hash = value;
}

describe('router', () => {
  beforeEach(() => {
    setHash('');
  });

  afterEach(() => {
    setHash('');
  });

  it('exports the canonical list of MVP routes', () => {
    expect(ROUTES).toEqual([
      'dashboard',
      'browse',
      'collection',
      'binders',
      'lots',
      'wishlist',
      'backup',
      'settings',
    ]);
  });

  it('isRoute() narrows known routes', () => {
    expect(isRoute('dashboard')).toBe(true);
    expect(isRoute('binders')).toBe(true);
    expect(isRoute('settings')).toBe(true);
  });

  it('isRoute() rejects unknown routes', () => {
    expect(isRoute('foo')).toBe(false);
    expect(isRoute('')).toBe(false);
    expect(isRoute('Dashboard')).toBe(false);
  });

  it('getCurrentRoute() falls back to the default when hash is empty', () => {
    expect(getCurrentRoute()).toBe(DEFAULT_ROUTE);
  });

  it('getCurrentRoute() reads a valid hash', () => {
    setHash('browse');
    expect(getCurrentRoute()).toBe('browse');
  });

  it('getCurrentRoute() falls back to the default for an invalid hash', () => {
    setHash('not-a-route');
    expect(getCurrentRoute()).toBe(DEFAULT_ROUTE);
  });

  it('navigate() updates the hash', () => {
    navigate('lots');
    expect(window.location.hash).toBe('#lots');
    expect(getCurrentRoute()).toBe('lots');
  });

  it('onRouteChange() fires the handler on hashchange and can be unsubscribed', async () => {
    const handler = vi.fn();
    const unsubscribe = onRouteChange(handler);

    navigate('binders');
    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledWith('binders');
    });

    const callCountBeforeUnsubscribe = handler.mock.calls.length;
    unsubscribe();
    navigate('lots');
    // Allow any pending hashchange to flush, then assert the handler did not fire again.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(handler).toHaveBeenCalledTimes(callCountBeforeUnsubscribe);
  });
});
