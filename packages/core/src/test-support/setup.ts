import { beforeEach, vi } from 'vitest';

/**
 * Restores Web Storage in the test environment.
 *
 * Vitest's happy-dom environment copies the window's `localStorage` and
 * `sessionStorage` ACCESSORS onto the test global. Detached from the window
 * they were defined on, those getters answer `undefined`, so `window.localStorage`
 * is unusable out of the box. Installing real happy-dom `Storage` instances
 * gives the SDK the same API a browser does — and a fresh pair per test keeps
 * one test's session out of the next one's.
 */
function installStorage(): void {
  const StorageCtor = (window as unknown as { Storage: new () => Storage }).Storage;
  for (const name of ['localStorage', 'sessionStorage'] as const) {
    Object.defineProperty(window, name, {
      value: new StorageCtor(),
      configurable: true,
      writable: true,
    });
  }
}

/**
 * Web Locks are OFF by default so that every test states which path it is
 * exercising: the tests that care about cross-tab serialisation install the
 * lock double themselves, and the fallback path is what the rest run through.
 */
function removeWebLocks(): void {
  Object.defineProperty(navigator, 'locks', {
    value: undefined,
    configurable: true,
    writable: true,
  });
}

/**
 * Creating a client starts discovery immediately, so a test that never routes
 * fetch would otherwise reach for the real network. This default refuses every
 * request; `installFetch()` replaces it for the tests that do route.
 */
function refuseUnroutedFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new TypeError('fetch was not routed by this test'))),
  );
}

installStorage();
removeWebLocks();
beforeEach(() => {
  installStorage();
  removeWebLocks();
  refuseUnroutedFetch();
});
