import { describe, expect, it, vi } from 'vitest';
import { createHesabimClient } from './client.js';
import { AuthRequiredError, AuthUnavailableError } from './errors.js';
import type { HesabimClient } from './types.js';
import {
  CLIENT_ID,
  DISCOVERY_DOCUMENT,
  ISSUER,
  LOCK_NAME,
  REDIRECT_URI,
  STORAGE_KEY,
  accessToken,
  deferred,
  idToken,
  installFetch,
  installWebLocks,
  jsonResponse,
  nowSec,
  otherTabWrites,
  readStored,
  seedFlow,
  seedSession,
  setUrl,
  storedRecord,
  tokenResponse,
} from './test-support/harness.js';

function client(overrides: Record<string, unknown> = {}): HesabimClient {
  return createHesabimClient({
    issuer: ISSUER,
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    ...overrides,
  });
}

/** A lock manager double is installed only by the tests that are about locking. */
function locks(): { request: <T>(name: string, cb: () => Promise<T>) => Promise<T> } {
  return (navigator as unknown as {
    locks: { request: <T>(name: string, cb: () => Promise<T>) => Promise<T> };
  }).locks;
}

describe('getAccessToken — when no refresh is needed', () => {
  it('returns the stored token without touching the network', async () => {
    const record = seedSession();
    const calls = installFetch();

    await expect(client().getAccessToken()).resolves.toBe(record.access_token);
    expect(calls.tokenCalls).toHaveLength(0);
  });

  it('throws when there is no session at all', async () => {
    installFetch();
    await expect(client().getAccessToken()).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it('refreshes rather than hand out a token inside the 30 second margin', async () => {
    seedSession({ expires_at: nowSec() + 20 });
    const calls = installFetch({ token: () => jsonResponse(tokenResponse()) });

    await client().getAccessToken();

    expect(calls.tokenCalls).toHaveLength(1);
  });

  it('refreshes rather than hand out a token the decoder rejects', async () => {
    // Fail-closed: a stored access token that does not pass the shape rules is
    // treated as no token at all, whatever its expiry says.
    seedSession({ access_token: accessToken({ hayrat_ver: 2 }) });
    const calls = installFetch({ token: () => jsonResponse(tokenResponse()) });

    const token = await client().getAccessToken();

    expect(calls.tokenCalls).toHaveLength(1);
    expect(token).not.toBe('');
  });

  it('gives up when the token is unusable and there is no refresh token', async () => {
    seedSession({ expires_at: nowSec() - 10, refresh_token: undefined });
    installFetch();

    await expect(client().getAccessToken()).rejects.toBeInstanceOf(AuthRequiredError);
    expect(readStored()).toBeNull();
  });
});

describe('refresh — the successful rotation', () => {
  it('sends the refresh grant and stores the rotated set', async () => {
    seedSession({ expires_at: nowSec() - 10, refresh_token: 'refresh-1' });
    const body = tokenResponse({ access_token: accessToken(), refresh_token: 'refresh-2' });
    const calls = installFetch({ token: () => jsonResponse(body) });

    const token = await client().getAccessToken();

    expect(token).toBe(body['access_token']);
    const sent = calls.tokenCalls[0];
    expect(sent?.get('grant_type')).toBe('refresh_token');
    expect(sent?.get('refresh_token')).toBe('refresh-1');
    expect(sent?.get('client_id')).toBe(CLIENT_ID);

    const stored = readStored();
    expect(stored?.refresh_token).toBe('refresh-2');
    expect(stored?.access_token).toBe(body['access_token']);
    expect(stored?.refresh_pending).toBeUndefined();
  });

  it('accepts a refreshed ID token that carries no nonce', async () => {
    // The IdP deliberately omits it on refresh; requiring one would break every
    // rotation.
    seedSession({ expires_at: nowSec() - 10 });
    installFetch({ token: () => jsonResponse(tokenResponse({ id_token: idToken() })) });

    await expect(client().getAccessToken()).resolves.toBeTruthy();
  });

  it('still validates the rest of the refreshed ID token', async () => {
    seedSession({ expires_at: nowSec() - 10 });
    installFetch({
      token: () => jsonResponse(tokenResponse({ id_token: idToken({ azp: 'other-client' }) })),
    });

    await expect(client().getAccessToken()).rejects.toBeInstanceOf(AuthUnavailableError);
    expect(readStored()?.access_token).toBeTruthy();
  });

  it('notifies subscribers of the new record', async () => {
    seedSession({ expires_at: nowSec() - 10 });
    const body = tokenResponse();
    installFetch({ token: () => jsonResponse(body) });
    const subject = client();
    const seen: boolean[] = [];
    subject.onAuthStateChanged((authenticated) => seen.push(authenticated));

    await subject.getAccessToken();

    // The marker write and the token write are both record changes.
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen.at(-1)).toBe(true);
    expect(readStored()?.access_token).toBe(body['access_token']);
  });
});

describe('refresh — the in-flight marker', () => {
  it('writes the marker before the POST and clears it with the answer', async () => {
    seedSession({ expires_at: nowSec() - 10 });
    let markerDuringPost: unknown;
    installFetch({
      token: () => {
        markerDuringPost = readStored()?.refresh_pending;
        return jsonResponse(tokenResponse());
      },
    });

    await client().getAccessToken();

    expect(markerDuringPost).toMatchObject({ at: expect.any(Number) });
    expect(readStored()?.refresh_pending).toBeUndefined();
  });

  it('never replays a refresh token behind a marker found under the lock', async () => {
    installWebLocks();
    const subject = client();
    // The marker appears after this client started, as a tab that died
    // mid-rotation would have left it — and the access token is past its
    // margin, so the lock is actually taken.
    otherTabWrites(storedRecord({ expires_at: nowSec() - 10, refresh_pending: { at: nowSec() - 30 } }));
    const calls = installFetch();

    await expect(subject.getAccessToken()).rejects.toBeInstanceOf(AuthRequiredError);
    expect(calls.tokenCalls).toHaveLength(0);
    expect(readStored()).toBeNull();
  });

  it('hands out a still-fresh access token without touching the lock or the marker', async () => {
    // Only the lock holder may read the marker. Another tab
    // rotating is not a reason to make this tab wait, let alone sign it out.
    const requested: string[] = [];
    Object.defineProperty(navigator, 'locks', {
      value: {
        request: async <T>(name: string, cb: () => Promise<T>): Promise<T> => {
          requested.push(name);
          return cb();
        },
      },
      configurable: true,
      writable: true,
    });
    const subject = client();
    const record = storedRecord({ refresh_pending: { at: nowSec() } });
    otherTabWrites(record);
    const calls = installFetch();

    await expect(subject.getAccessToken()).resolves.toBe(record.access_token);
    expect(requested).toEqual([]);
    expect(calls.tokenCalls).toHaveLength(0);
    // The other tab's rotation is left exactly as it was found.
    expect(readStored()?.refresh_pending).toEqual(record.refresh_pending);
  });

  it('catches a marker that appeared while this call was queued on the lock', async () => {
    installWebLocks();
    seedSession({ expires_at: nowSec() - 10 });
    const calls = installFetch();
    const subject = client();

    const gate = deferred<void>();
    const holder = locks().request(LOCK_NAME, async () => {
      await gate.promise;
      // The tab that held the lock died between its POST and its write.
      otherTabWrites(storedRecord({ refresh_pending: { at: nowSec() } }));
    });

    const pending = subject.getAccessToken();
    gate.resolve();
    await holder;

    await expect(pending).rejects.toBeInstanceOf(AuthRequiredError);
    expect(calls.tokenCalls).toHaveLength(0);
    expect(readStored()).toBeNull();
  });

  it('keeps every passive reader signed in while another tab rotates', () => {
    // The marker is bookkeeping for the refresh path, not a session state. When
    // it flipped isAuthenticated to false, every other tab flashed through
    // "signed out" once per rotation and route guards bounced.
    const subject = client();
    const record = storedRecord({
      refresh_pending: { at: nowSec() },
      access_token: accessToken({ hayrat_grants: [{ role: 'viewer', scopes: [] }] }),
    });
    otherTabWrites(record);

    expect(subject.isAuthenticated()).toBe(true);
    expect(subject.getUser()).toMatchObject({ sub: 'user-1' });
    expect(subject.can('viewer')).toBe(true);
  });

  it('does not flash signed-out when the marker arrives by storage event', () => {
    seedSession();
    const subject = client();
    const seen: boolean[] = [];
    subject.onAuthStateChanged((authenticated) => seen.push(authenticated));

    otherTabWrites(storedRecord({ refresh_pending: { at: nowSec() } }));

    // The record changed, so subscribers hear about it — but the answer
    // they get is still "signed in".
    expect(seen).toEqual([true]);
  });

  it('lets a second client instance wait for the first one s refresh instead of killing it', async () => {
    installWebLocks();
    seedSession({ expires_at: nowSec() - 10 });
    const gate = deferred<Response>();
    const calls = installFetch({ token: () => gate.promise });

    const first = client();

    const firstCall = first.getAccessToken();
    await vi.waitFor(() => {
      expect(calls.tokenCalls).toHaveLength(1);
    });
    // The first instance is mid-POST and its marker is on the record.
    expect(readStored()?.refresh_pending).toMatchObject({ at: expect.any(Number) });

    // Constructed AFTER the marker is durably on the record — the one
    // interleaving where a startup sweep would have destroyed the live
    // rotation. Construction must leave the marker exactly where
    // it found it.
    const second = client();
    expect(readStored()?.refresh_pending).toMatchObject({ at: expect.any(Number) });

    const secondCall = second.getAccessToken();
    await Promise.resolve();
    // The second instance did NOT clear the first one's rotation.
    expect(readStored()?.refresh_pending).toMatchObject({ at: expect.any(Number) });
    expect(second.isAuthenticated()).toBe(true);

    const body = tokenResponse();
    gate.resolve(jsonResponse(body));

    await expect(firstCall).resolves.toBe(body['access_token']);
    await expect(secondCall).resolves.toBe(body['access_token']);
    expect(calls.tokenCalls).toHaveLength(1);
    expect(readStored()?.refresh_pending).toBeUndefined();
  });
});

describe('refresh — error taxonomy', () => {
  it('clears the session ONLY for a well-formed invalid_grant', async () => {
    seedSession({ expires_at: nowSec() - 10 });
    const calls = installFetch({
      token: () => jsonResponse({ error: 'invalid_grant', error_description: 'reuse' }, 400),
    });

    await expect(client().getAccessToken()).rejects.toBeInstanceOf(AuthRequiredError);
    expect(readStored()).toBeNull();
    expect(calls.tokenCalls).toHaveLength(1);
  });

  it.each([
    ['a 500 with server_error', () => jsonResponse({ error: 'server_error' }, 500)],
    ['a 503 with temporarily_unavailable', () => jsonResponse({ error: 'temporarily_unavailable' }, 503)],
    ['a 400 that is not invalid_grant', () => jsonResponse({ error: 'invalid_request' }, 400)],
    ['a proxy error page', () => new Response('<html>502</html>', { status: 502 })],
    ['a 500 whose body says invalid_grant', () => jsonResponse({ error: 'invalid_grant' }, 500)],
  ])('keeps the session on %s', async (_label, respond) => {
    const record = seedSession({ expires_at: nowSec() - 10 });
    installFetch({ token: respond });

    await expect(client().getAccessToken()).rejects.toBeInstanceOf(AuthUnavailableError);
    expect(readStored()?.refresh_token).toBe(record.refresh_token);
  });

  it('keeps the session when the network is down', async () => {
    const record = seedSession({ expires_at: nowSec() - 10 });
    installFetch({
      token: () => {
        throw new TypeError('Failed to fetch');
      },
    });

    await expect(client().getAccessToken()).rejects.toBeInstanceOf(AuthUnavailableError);
    expect(readStored()?.refresh_token).toBe(record.refresh_token);
  });

  it.each([
    ['no rotated refresh token', { refresh_token: undefined }],
    ['an empty access token', { access_token: '' }],
    ['a token type that is not Bearer', { token_type: 'mac' }],
    ['a negative lifetime', { expires_in: -1 }],
    ['an access token from another issuer', { access_token: accessToken({ iss: 'https://evil.example' }) }],
  ])('refuses to overwrite the record on a 2xx with %s', async (_label, overrides) => {
    const record = seedSession({ expires_at: nowSec() - 10 });
    installFetch({ token: () => jsonResponse(tokenResponse(overrides)) });

    await expect(client().getAccessToken()).rejects.toBeInstanceOf(AuthUnavailableError);
    expect(readStored()?.access_token).toBe(record.access_token);
    expect(readStored()?.refresh_token).toBe(record.refresh_token);
  });

  it('leaves the marker unresolved after a failure and never retries by itself', async () => {
    seedSession({ expires_at: nowSec() - 10 });
    const calls = installFetch({ token: () => jsonResponse({ error: 'server_error' }, 500) });
    const subject = client();

    await expect(subject.getAccessToken()).rejects.toBeInstanceOf(AuthUnavailableError);
    expect(readStored()?.refresh_pending).toMatchObject({ at: expect.any(Number) });
    expect(calls.tokenCalls).toHaveLength(1);

    // The second attempt does NOT present the refresh token again.
    await expect(subject.getAccessToken()).rejects.toBeInstanceOf(AuthRequiredError);
    expect(calls.tokenCalls).toHaveLength(1);
    expect(readStored()).toBeNull();
  });
});

describe('refresh — one POST per rotation', () => {
  it('collapses concurrent callers into a single POST under Web Locks', async () => {
    installWebLocks();
    seedSession({ expires_at: nowSec() - 10 });
    const gate = deferred<Response>();
    const calls = installFetch({ token: () => gate.promise });
    const subject = client();

    const first = subject.getAccessToken();
    const second = subject.getAccessToken();
    gate.resolve(jsonResponse(tokenResponse()));

    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(calls.tokenCalls).toHaveLength(1);
  });

  it('collapses concurrent callers with no Web Locks at all', async () => {
    // The documented degradation: the guarantee shrinks to this tab.
    expect((navigator as unknown as { locks?: unknown }).locks).toBeUndefined();
    seedSession({ expires_at: nowSec() - 10 });
    const gate = deferred<Response>();
    const calls = installFetch({ token: () => gate.promise });
    const subject = client();

    const first = subject.getAccessToken();
    const second = subject.getAccessToken();
    gate.resolve(jsonResponse(tokenResponse()));

    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(calls.tokenCalls).toHaveLength(1);
  });

  it('falls back to the tab-local path when the lock MANAGER itself refuses', async () => {
    // Sandboxed and opaque-origin documents have a navigator.locks whose
    // request() rejects with SecurityError before the callback ever runs.
    // That document is simply one without Web Locks — the raw DOMException
    // must not escape the documented error taxonomy.
    Object.defineProperty(navigator, 'locks', {
      value: { request: () => Promise.reject(new Error('SecurityError: denied')) },
      configurable: true,
      writable: true,
    });
    seedSession({ expires_at: nowSec() - 10 });
    const body = tokenResponse();
    const calls = installFetch({ token: () => jsonResponse(body) });

    await expect(client().getAccessToken()).resolves.toBe(body['access_token']);
    expect(calls.tokenCalls).toHaveLength(1);
  });

  it('rethrows a failure from INSIDE the lock instead of retrying it on the fallback path', async () => {
    // The fallback is only for a manager that refused service. Once the
    // callback has run, its rejection IS the refresh's outcome — running the
    // refresh again would replay the failure (or worse, a spent token).
    installWebLocks();
    seedSession({ expires_at: nowSec() - 10 });
    const calls = installFetch({
      token: () => jsonResponse({ error: 'invalid_grant' }, 400),
    });

    await expect(client().getAccessToken()).rejects.toBeInstanceOf(AuthRequiredError);
    expect(calls.tokenCalls).toHaveLength(1);
  });

  it('starts a new flight once the previous one has finished', async () => {
    seedSession({ expires_at: nowSec() - 10 });
    const calls = installFetch({
      token: () => jsonResponse(tokenResponse({ expires_in: 1 })),
    });
    const subject = client();

    await subject.getAccessToken();
    await subject.getAccessToken();

    expect(calls.tokenCalls).toHaveLength(2);
  });

  it('re-reads inside the lock and skips the POST when another tab already rotated', async () => {
    installWebLocks();
    seedSession({ expires_at: nowSec() - 10 });
    const calls = installFetch();
    const subject = client();

    const fresh = storedRecord({
      access_token: accessToken({ hayrat_grants: [{ role: 'viewer', scopes: [] }] }),
      refresh_token: 'refresh-from-other-tab',
    });
    const gate = deferred<void>();
    const holder = locks().request(LOCK_NAME, async () => {
      await gate.promise;
      otherTabWrites(fresh);
    });

    const pending = subject.getAccessToken();
    gate.resolve();
    await holder;

    await expect(pending).resolves.toBe(fresh.access_token);
    expect(calls.tokenCalls).toHaveLength(0);
  });

  it('re-reads after the discovery await and never re-persists a stale snapshot', async () => {
    // The refresh lock does not cover handleCallback, which writes a
    // brand-new session without taking it. A record read BEFORE the discovery
    // await, stamped with the marker and written back AFTER it, would clobber
    // that session with the pre-await snapshot — and then POST its spent
    // refresh token. The marker must be stamped onto what storage holds after
    // every await has settled.
    installWebLocks();
    seedSession({ expires_at: nowSec() - 10 });
    const discoveryGate = deferred<Response>();
    const calls = installFetch({ discovery: () => discoveryGate.promise });
    const subject = client();

    const pending = subject.getAccessToken();
    // A macrotask lets every pending microtask chain run to completion: the
    // refresh path is now inside the lock, its FIRST read already taken,
    // suspended on the discovery gate — the only pending promise.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Another document completes a sign-in while discovery is slow.
    const replacement = storedRecord({
      access_token: accessToken({ hayrat_grants: [{ role: 'viewer', scopes: [] }] }),
      refresh_token: 'refresh-from-callback',
      expires_at: nowSec() + 600,
    });
    otherTabWrites(replacement);

    discoveryGate.resolve(jsonResponse(DISCOVERY_DOCUMENT));

    // The live replacement answers the caller; nothing is POSTed, and the
    // replacement — marker-less, with its own refresh token — stays exactly
    // as the other document wrote it.
    await expect(pending).resolves.toBe(replacement.access_token);
    expect(calls.tokenCalls).toHaveLength(0);
    expect(readStored()?.refresh_token).toBe('refresh-from-callback');
    expect(readStored()?.refresh_pending).toBeUndefined();
  });

  it('uses the refresh lock name that is scoped to this issuer and client', async () => {
    const requested: string[] = [];
    Object.defineProperty(navigator, 'locks', {
      value: {
        request: async <T>(name: string, cb: () => Promise<T>): Promise<T> => {
          requested.push(name);
          return cb();
        },
      },
      configurable: true,
      writable: true,
    });
    seedSession({ expires_at: nowSec() - 10 });
    installFetch({ token: () => jsonResponse(tokenResponse()) });

    await client().getAccessToken();

    expect(requested).toEqual([LOCK_NAME]);
  });
});

describe('refresh — storage failure', () => {
  it('withdraws the persisted predecessor before rotating in memory', async () => {
    // The marker cannot be persisted, so the record another tab can still see
    // holds a refresh token this page is about to spend. It has to go BEFORE
    // the POST — a tab that later presents it would trip reuse detection and
    // cost everyone the whole family.
    seedSession({ expires_at: nowSec() - 10 });
    const body = tokenResponse();
    const calls = installFetch({
      token: () => {
        expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
        return jsonResponse(body);
      },
    });
    const subject = client();
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });

    await expect(subject.getAccessToken()).resolves.toBe(body['access_token']);
    expect(readStored()).toBeNull();
    // This page keeps working with the rotated set, and does not rotate again.
    await expect(subject.getAccessToken()).resolves.toBe(body['access_token']);
    expect(calls.tokenCalls).toHaveLength(1);
  });

  it('refuses to POST when neither the marker nor the withdrawal can be confirmed', async () => {
    const record = seedSession({ expires_at: nowSec() - 10 });
    const calls = installFetch({ token: () => jsonResponse(tokenResponse()) });
    const subject = client();
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    vi.spyOn(window.localStorage, 'removeItem').mockImplementation(() => {
      throw new Error('storage is blocked');
    });

    await expect(subject.getAccessToken()).rejects.toBeInstanceOf(AuthUnavailableError);
    expect(calls.tokenCalls).toHaveLength(0);
    // The session is untouched: it simply cannot refresh in this browser.
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify(record));
    expect(subject.isAuthenticated()).toBe(true);
  });

  it('puts its own in-memory record back when it refuses, marker and all', async () => {
    // The refusal happens AFTER `write` has already marked the in-process
    // record — that is the only way to learn the write will not persist. Left
    // there, the marker would describe a POST that never happened: the next
    // refresh would read it under the lock, conclude a predecessor had been
    // spent, and sign the user out while the untouched record sat durably in
    // localStorage the whole time.
    const record = seedSession({ expires_at: nowSec() - 10 });
    const rotated = tokenResponse();
    const calls = installFetch({ token: () => jsonResponse(rotated) });
    const subject = client();

    const setItem = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    const removeItem = vi.spyOn(window.localStorage, 'removeItem').mockImplementation(() => {
      throw new Error('storage is blocked');
    });

    await expect(subject.getAccessToken()).rejects.toBeInstanceOf(AuthUnavailableError);
    expect(calls.tokenCalls).toHaveLength(0);

    // (a) the user is still signed in, and (c) nothing anywhere is marked.
    expect(subject.isAuthenticated()).toBe(true);
    expect(subject.getUser()).toMatchObject({ sub: 'user-1' });
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify(record));

    // (b) storage recovers. The next attempt must rotate from the intact
    // predecessor — not read a marker, and not clear the session.
    setItem.mockRestore();
    removeItem.mockRestore();

    await expect(subject.getAccessToken()).resolves.toBe(rotated['access_token']);
    expect(calls.tokenCalls).toHaveLength(1);
    expect(calls.tokenCalls[0]?.get('refresh_token')).toBe(record.refresh_token);

    // The rotation landed durably, which also shows the memory-only fallback
    // was rolled back with the record: a client still degraded from the failed
    // attempt would have kept this to itself.
    expect(readStored()?.refresh_token).toBe(rotated['refresh_token']);
    expect(readStored()?.refresh_pending).toBeUndefined();
  });

  it('refuses to POST when a removal silently keeps the record', async () => {
    seedSession({ expires_at: nowSec() - 10 });
    const calls = installFetch({ token: () => jsonResponse(tokenResponse()) });
    const subject = client();
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    vi.spyOn(window.localStorage, 'removeItem').mockImplementation(() => {
      /* accepted, and ignored */
    });

    await expect(subject.getAccessToken()).rejects.toBeInstanceOf(AuthUnavailableError);
    expect(calls.tokenCalls).toHaveLength(0);
  });

  it('refuses to POST when a write is accepted but not retained', async () => {
    seedSession({ expires_at: nowSec() - 10 });
    const calls = installFetch({ token: () => jsonResponse(tokenResponse()) });
    const subject = client();
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      /* accepted, and ignored */
    });
    vi.spyOn(window.localStorage, 'removeItem').mockImplementation(() => {
      /* accepted, and ignored */
    });

    await expect(subject.getAccessToken()).rejects.toBeInstanceOf(AuthUnavailableError);
    expect(calls.tokenCalls).toHaveLength(0);
  });

  it('rotates in memory for a session that was never persisted at all', async () => {
    // A page that has been memory-only since sign-in has no predecessor for
    // anyone else to find, so the rotation is safe without any durable write.
    // This is the Safari-private-window case the degradation exists for.
    const flow = seedFlow();
    const signIn = tokenResponse({ id_token: idToken({ nonce: flow.nonce }), expires_in: 1 });
    const rotated = tokenResponse();
    let call = 0;
    const calls = installFetch({
      token: () => jsonResponse(call++ === 0 ? signIn : rotated),
    });
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    setUrl(`/callback?code=abc&state=${flow.state}`);
    const subject = client();

    await subject.handleCallback();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();

    await expect(subject.getAccessToken()).resolves.toBe(rotated['access_token']);
    expect(calls.tokenCalls).toHaveLength(2);
  });
});
