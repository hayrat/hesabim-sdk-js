import { beforeEach, vi } from 'vitest';

/**
 * Vitest's happy-dom environment copies the window's `localStorage` and
 * `sessionStorage` accessors onto the test global, where — detached from the
 * window they belong to — they answer `undefined`. Installing real happy-dom
 * Storage instances (a fresh pair per test) restores the API the core SDK is
 * written against.
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
 * Installing the plugin creates a core client, which starts discovery at once.
 * Nothing here should reach the network: a test that needs a real answer stubs
 * fetch itself.
 */
function refuseUnroutedFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new TypeError('fetch was not routed by this test'))),
  );
}

installStorage();
beforeEach(() => {
  installStorage();
  refuseUnroutedFetch();
});
