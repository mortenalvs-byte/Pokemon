// Tiny helper for browser-native lazy image loading. Used by Browse rows
// and Card Detail. Pure DOM construction — no network, no IndexedDB.

export interface LazyImageOptions {
  readonly src: string | null;
  readonly alt: string;
  readonly width?: number;
  readonly height?: number;
  readonly className?: string;
}

export function createLazyImage(options: LazyImageOptions): HTMLElement {
  if (options.src === null || options.src.length === 0) {
    return createPlaceholder(options);
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

  // On error, swap the failing <img> for a neutral placeholder so a
  // broken thumbnail does not leave a crossed-out icon in a tabell row.
  img.addEventListener('error', () => {
    const placeholder = createPlaceholder(options);
    img.replaceWith(placeholder);
  });

  return img;
}

function createPlaceholder(options: LazyImageOptions): HTMLElement {
  const placeholder = document.createElement('span');
  placeholder.className = 'lazy-image lazy-image--placeholder';
  if (options.className !== undefined) {
    placeholder.classList.add(...options.className.split(/\s+/));
  }
  placeholder.setAttribute('role', 'img');
  placeholder.setAttribute('aria-label', options.alt);
  placeholder.textContent = '·';
  if (options.width !== undefined) {
    placeholder.style.width = `${options.width}px`;
  }
  if (options.height !== undefined) {
    placeholder.style.height = `${options.height}px`;
  }
  return placeholder;
}
