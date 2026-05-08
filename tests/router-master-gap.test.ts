// PR 25 — router additions for the master-gap view.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getCurrentMasterGapBinderId,
  getCurrentRoute,
  navigateToMasterGap,
  navigateToMasterGapBinder,
} from '../src/router';

function setHash(value: string): void {
  window.location.hash = value;
}

describe('router master-gap (PR 25)', () => {
  beforeEach(() => {
    setHash('');
  });
  afterEach(() => {
    setHash('');
  });

  it('#master-gap resolves to master-gap route, no binder id', () => {
    setHash('master-gap');
    expect(getCurrentRoute()).toBe('master-gap');
    expect(getCurrentMasterGapBinderId()).toBeNull();
  });

  it('#master-gap/<id> resolves to master-gap with binder id', () => {
    setHash('master-gap/binder-1');
    expect(getCurrentRoute()).toBe('master-gap');
    expect(getCurrentMasterGapBinderId()).toBe('binder-1');
  });

  it('getCurrentMasterGapBinderId decodes URL-encoded ids', () => {
    setHash('master-gap/' + encodeURIComponent('weird id with spaces'));
    expect(getCurrentMasterGapBinderId()).toBe('weird id with spaces');
  });

  it('malformed master-gap binder hash returns null', () => {
    // A bare prefix with no id falls back to null and the route is
    // still master-gap (the binder selector view handles "no id").
    setHash('master-gap/');
    expect(getCurrentRoute()).toBe('master-gap');
    expect(getCurrentMasterGapBinderId()).toBeNull();

    // An invalid percent-encoded id throws inside decodeURIComponent;
    // the helper catches it and returns null.
    setHash('master-gap/%E0%A4%A');
    expect(getCurrentMasterGapBinderId()).toBeNull();
  });

  it('navigateToMasterGap() and navigateToMasterGapBinder() set the hash', () => {
    navigateToMasterGap();
    expect(window.location.hash).toBe('#master-gap');
    navigateToMasterGapBinder('abc-123');
    expect(window.location.hash).toBe('#master-gap/abc-123');
    expect(getCurrentMasterGapBinderId()).toBe('abc-123');
  });
});
