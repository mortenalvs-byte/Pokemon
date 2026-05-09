// Tiny helper for browser-native lazy image loading. Used by Browse rows
// and Card Detail. Pure DOM construction — no network, no IndexedDB.
//
// PR 28 review patch (Phase 5) — when an image is missing or fails to
// load we now render a visible "No image" placeholder instead of a
// near-invisible dot. The placeholder keeps the same width/height so
// the surrounding layout doesn't shift, and it carries a
// `data-lazy-image-fallback` attribute so the dev-only image-audit
// module can count failures across a real route walk.

export interface LazyImageOptions {
  readonly src: string | null;
  readonly alt: string;
  readonly width?: number;
  readonly height?: number;
  readonly className?: string;
}

export function createLazyImage(options: LazyImageOptions): HTMLElement {
  if (options.src === null || options.src.length === 0) {
    return createPlaceholder(options, 'missing');
  }

  const img = document.createElement('img');
  img.src = options.src;
  img.alt = options.alt;
  img.loading = 'lazy';
  img.decoding = 'async';
  if (options.width !== undefined) {
    img.width = options.width;
  }
  if (options.height !== undefined) {
    img.height = options.height;
  }
  if (options.className !== undefined) {
    img.className = options.className;
  }

  // On error, swap the failing <img> for a visible "No image"
  // placeholder so a broken thumbnail does not leave a crossed-out
  // icon (or, worse, an empty spot) in a table row.
  img.addEventListener('error', () => {
    const placeholder = createPlaceholder(options, 'load-error');
    img.replaceWith(placeholder);
    // Dev-only image audit hook — `installImageAudit()` listens for
    // this event so the QA harness can summarise broken images
    // without the user manually scrolling through every route.
    window.dispatchEvent(
      new CustomEvent('pokemon:image-load-error', {
        detail: {
          src: options.src,
          alt: options.alt,
          ts: new Date().toISOString(),
          route: window.location.hash.slice(1) || '<empty>',
        },
      }),
    );
  });

  return img;
}

function createPlaceholder(
  options: LazyImageOptions,
  reason: 'missing' | 'load-error',
): HTMLElement {
  const placeholder = document.createElement('span');
  placeholder.className = 'lazy-image lazy-image--placeholder';
  if (options.className !== undefined) {
    placeholder.classList.add(...options.className.split(/\s+/));
  }
  placeholder.setAttribute('role', 'img');
  placeholder.setAttribute('aria-label', options.alt);
  placeholder.setAttribute('data-lazy-image-fallback', reason);
  placeholder.textContent = 'No image';
  if (options.width !== undefined) {
    placeholder.style.width = `${options.width}px`;
  }
  if (options.height !== undefined) {
    placeholder.style.height = `${options.height}px`;
  }
  return placeholder;
}
