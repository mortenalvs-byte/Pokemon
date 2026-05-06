// UUID generation. Wrapped so tests and future code paths can stub or
// audit it without reaching for the global `crypto` directly.

export type Uuid = string;

export function newId(): Uuid {
  // Node 20+ and modern browsers expose `crypto.randomUUID` on the global
  // object. The cast keeps strict mode happy when `globalThis.crypto` is
  // typed as the Web Crypto interface.
  return crypto.randomUUID();
}
