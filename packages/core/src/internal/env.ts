/**
 * Guarded access to the browser globals the SDK touches.
 *
 * Every accessor here can fail in a real browser: reading `window.localStorage`
 * THROWS (not returns null) in a Safari private window and under a
 * third-party-storage block, and the same is true of `sessionStorage`. Storage
 * failures must degrade the SDK, never crash the host application, so every
 * entry point is wrapped.
 */

export function hasBrowserGlobals(): boolean {
  return typeof window !== 'undefined' && typeof window.location !== 'undefined';
}

export function getLocalStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function getSessionStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' && window.sessionStorage ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

/**
 * The slice of the Web Locks API the SDK uses.
 *
 * Declared locally rather than relying on the DOM lib so that a TypeScript
 * version without `Navigator.locks` still compiles, and so the fallback path is
 * a plain feature test instead of a type assertion at the call site.
 */
export interface LockManagerLike {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

export function getWebLocks(): LockManagerLike | null {
  try {
    const nav = globalThis.navigator as unknown as { locks?: LockManagerLike } | undefined;
    if (nav && nav.locks && typeof nav.locks.request === 'function') {
      return nav.locks;
    }
  } catch {
    /* fall through to the tab-local single-flight path */
  }
  return null;
}

/** WebCrypto, or null in a non-secure context where `subtle` is absent. */
export function getCrypto(): Crypto | null {
  try {
    const c = globalThis.crypto;
    if (c && typeof c.getRandomValues === 'function' && c.subtle) return c;
  } catch {
    /* ignore */
  }
  return null;
}

/** Navigates the current document. Callers treat this as a point of no return. */
export function navigateTo(url: string): Promise<never> {
  window.location.assign(url);
  // The document is going away; resolving would let callers run code that the
  // navigation is about to discard, and rejecting would look like a failure.
  return new Promise<never>(() => {});
}

/** Current wall clock in whole seconds — the unit every timestamp here uses. */
export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
