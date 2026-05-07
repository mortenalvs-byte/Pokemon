import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ROUTE,
  ROUTES,
  getCurrentBinderId,
  getCurrentCardId,
  getCurrentLotId,
  getCurrentRoute,
  isRoute,
  navigate,
  navigateToBinder,
  navigateToCard,
  navigateToLot,
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

  it('getCurrentCardId() returns null for normal routes', () => {
    setHash('browse');
    expect(getCurrentCardId()).toBeNull();
    setHash('settings');
    expect(getCurrentCardId()).toBeNull();
  });

  it('getCurrentCardId() returns the decoded id for #card/<id>', () => {
    setHash('card/base1-4');
    expect(getCurrentCardId()).toBe('base1-4');
  });

  it('navigateToCard() encodes the id in the hash', () => {
    navigateToCard('base1-4');
    expect(window.location.hash).toBe('#card/base1-4');
    expect(getCurrentCardId()).toBe('base1-4');
  });

  it('navigateToCard() handles ids with characters that need URL encoding', () => {
    navigateToCard('weird id with spaces & =');
    // The hash is URL-encoded.
    expect(window.location.hash).toBe(
      `#card/${encodeURIComponent('weird id with spaces & =')}`,
    );
    expect(getCurrentCardId()).toBe('weird id with spaces & =');
  });

  it('getCurrentRoute() returns card-detail only for valid #card/<id>', () => {
    setHash('card/base1-4');
    expect(getCurrentRoute()).toBe('card-detail');
  });

  it('getCurrentRoute() falls back to default when #card/ has no id', () => {
    setHash('card/');
    expect(getCurrentRoute()).toBe(DEFAULT_ROUTE);
    expect(getCurrentCardId()).toBeNull();
  });

  it('getCurrentRoute() falls back when #card/ has only an empty encoded id', () => {
    setHash('card/%20'); // decodes to a single space — non-empty, valid
    expect(getCurrentRoute()).toBe('card-detail');
    expect(getCurrentCardId()).toBe(' ');
  });

  it('getCurrentRoute() falls back safely when the encoded id is malformed', () => {
    setHash('card/%E0%A4%A'); // truncated UTF-8 percent escape
    expect(getCurrentRoute()).toBe(DEFAULT_ROUTE);
    expect(getCurrentCardId()).toBeNull();
  });

  it('isRoute() does not classify "card-detail" as a sidebar route', () => {
    // The `Route` type union includes 'card-detail', but it must not
    // be a valid plain hash — bare '#card-detail' falls back.
    setHash('card-detail');
    expect(getCurrentRoute()).toBe(DEFAULT_ROUTE);
  });

  it('getCurrentBinderId() returns null for normal routes', () => {
    setHash('binders');
    expect(getCurrentBinderId()).toBeNull();
    setHash('card/base1-4');
    expect(getCurrentBinderId()).toBeNull();
  });

  it('getCurrentBinderId() returns the decoded id for #binder/<id>', () => {
    setHash('binder/some-uuid');
    expect(getCurrentBinderId()).toBe('some-uuid');
  });

  it('navigateToBinder() encodes the id in the hash', () => {
    navigateToBinder('weird id with spaces & =');
    expect(window.location.hash).toBe(
      `#binder/${encodeURIComponent('weird id with spaces & =')}`,
    );
    expect(getCurrentBinderId()).toBe('weird id with spaces & =');
  });

  it('getCurrentRoute() returns binder-detail only for valid #binder/<id>', () => {
    setHash('binder/some-uuid');
    expect(getCurrentRoute()).toBe('binder-detail');
  });

  it('getCurrentRoute() falls back when #binder/ has no id', () => {
    setHash('binder/');
    expect(getCurrentRoute()).toBe(DEFAULT_ROUTE);
    expect(getCurrentBinderId()).toBeNull();
  });

  it('getCurrentRoute() falls back when #binder/ has malformed id', () => {
    setHash('binder/%E0%A4%A'); // truncated UTF-8 percent escape
    expect(getCurrentRoute()).toBe(DEFAULT_ROUTE);
    expect(getCurrentBinderId()).toBeNull();
  });

  it('isRoute() does not classify "binder-detail" as a sidebar route', () => {
    setHash('binder-detail');
    expect(getCurrentRoute()).toBe(DEFAULT_ROUTE);
  });

  it('getCurrentLotId() returns null for normal routes', () => {
    setHash('lots');
    expect(getCurrentLotId()).toBeNull();
    setHash('binder/some-id');
    expect(getCurrentLotId()).toBeNull();
  });

  it('getCurrentLotId() returns the decoded id for #lot/<id>', () => {
    setHash('lot/some-uuid');
    expect(getCurrentLotId()).toBe('some-uuid');
  });

  it('navigateToLot() encodes the id', () => {
    navigateToLot('weird id with spaces & =');
    expect(window.location.hash).toBe(
      `#lot/${encodeURIComponent('weird id with spaces & =')}`,
    );
    expect(getCurrentLotId()).toBe('weird id with spaces & =');
  });

  it('getCurrentRoute() returns lot-detail only for valid #lot/<id>', () => {
    setHash('lot/some-uuid');
    expect(getCurrentRoute()).toBe('lot-detail');
  });

  it('getCurrentRoute() falls back when #lot/ has no id', () => {
    setHash('lot/');
    expect(getCurrentRoute()).toBe(DEFAULT_ROUTE);
    expect(getCurrentLotId()).toBeNull();
  });

  it('getCurrentRoute() falls back when #lot/ has malformed id', () => {
    setHash('lot/%E0%A4%A');
    expect(getCurrentRoute()).toBe(DEFAULT_ROUTE);
    expect(getCurrentLotId()).toBeNull();
  });

  it('isRoute() does not classify "lot-detail" as a sidebar route', () => {
    setHash('lot-detail');
    expect(getCurrentRoute()).toBe(DEFAULT_ROUTE);
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
