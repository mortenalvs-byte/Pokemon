import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mountApp } from '../src/app';

function freshRoot(): HTMLElement {
  document.body.innerHTML = '<div id="app"></div>';
  const root = document.getElementById('app');
  if (!root) {
    throw new Error('test bootstrap failed: missing #app');
  }
  return root;
}

describe('app shell', () => {
  beforeEach(() => {
    window.location.hash = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
    window.location.hash = '';
  });

  it('renders topbar, sidebar, and main content area', () => {
    const root = freshRoot();
    mountApp(root);

    expect(root.querySelector('.topbar')).not.toBeNull();
    expect(root.querySelector('.sidebar')).not.toBeNull();
    expect(root.querySelector('#content')).not.toBeNull();
  });

  it('renders all eight navigation links', () => {
    const root = freshRoot();
    mountApp(root);

    const links = root.querySelectorAll<HTMLAnchorElement>('[data-route]');
    const routes = Array.from(links).map((link) => link.dataset['route']);
    expect(routes).toEqual([
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

  it('renders the dashboard view by default', () => {
    const root = freshRoot();
    mountApp(root);

    const content = root.querySelector('#content');
    expect(content?.textContent).toContain('Dashboard');
  });

  it('marks the active route in the sidebar', () => {
    const root = freshRoot();
    mountApp(root);

    const dashboardLink = root.querySelector<HTMLAnchorElement>(
      '[data-route="dashboard"]',
    );
    expect(dashboardLink?.classList.contains('sidebar__link--active')).toBe(true);
    expect(dashboardLink?.getAttribute('aria-current')).toBe('page');
  });
});
