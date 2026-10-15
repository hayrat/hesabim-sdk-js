import { describe, expect, it, vi } from 'vitest';
import { createHesabimClient } from './client.js';
import { AuthUnavailableError } from './errors.js';
import type { HayratScope, HesabimClient } from './types.js';
import {
  CLIENT_ID,
  DISCOVERY_URL,
  END_SESSION_ENDPOINT,
  ISSUER,
  REDIRECT_URI,
  STORAGE_KEY,
  accessToken,
  captureNavigation,
  deferred,
  idToken,
  installFetch,
  jsonResponse,
  nowSec,
  otherTabClears,
  otherTabWrites,
  readStored,
  seedSession,
  storedRecord,
} from './test-support/harness.js';

function client(overrides: Record<string, unknown> = {}): HesabimClient {
  return createHesabimClient({
    issuer: ISSUER,
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    ...overrides,
  });
}

const ANKARA: HayratScope = { type: 'province', id: 6 };
const IZMIR: HayratScope = { type: 'province', id: 35 };
const CANKAYA: HayratScope = { type: 'district', id: 601 };

interface Grant {
  role: string;
  scopes: Array<{ type: string; id: number }>;
}

function withGrants(grants: Grant[], overrides: Record<string, unknown> = {}): HesabimClient {
  seedSession({ access_token: accessToken({ hayrat_grants: grants }) });
  return client(overrides);
}

describe('can — grant semantics', () => {
  it('is false with no session at all', () => {
    expect(client().can('viewer')).toBe(false);
  });

  it('is false for a role the user does not hold', () => {
    expect(withGrants([{ role: 'viewer', scopes: [] }]).can('moderator')).toBe(false);
  });

  it('treats an empty scope list as project-wide for that role', () => {
    const subject = withGrants([{ role: 'viewer', scopes: [] }]);
    expect(subject.can('viewer')).toBe(true);
    expect(subject.can('viewer', ANKARA)).toBe(true);
    expect(subject.can('viewer', ANKARA, IZMIR)).toBe(true);
  });

  it('refuses a project-wide action to a scoped grant', () => {
    // No target means "anywhere in the project", and holding Ankara is not that.
    expect(withGrants([{ role: 'moderator', scopes: [ANKARA] }]).can('moderator')).toBe(false);
  });

  it('matches a target exactly', () => {
    const subject = withGrants([{ role: 'moderator', scopes: [ANKARA] }]);
    expect(subject.can('moderator', ANKARA)).toBe(true);
    expect(subject.can('moderator', IZMIR)).toBe(false);
    expect(subject.can('moderator', { type: 'district', id: 6 })).toBe(false);
  });

  it('requires every target to be covered', () => {
    const subject = withGrants([{ role: 'moderator', scopes: [ANKARA, IZMIR] }]);
    expect(subject.can('moderator', ANKARA, IZMIR)).toBe(true);
    expect(subject.can('moderator', ANKARA, { type: 'province', id: 34 })).toBe(false);
  });

  it('does not let one role borrow another role s scopes', () => {
    // The cross-product vulnerability the flat contract had: moderator in
    // Ankara plus viewer in İzmir must never read as moderator in İzmir.
    const subject = withGrants([
      { role: 'moderator', scopes: [ANKARA] },
      { role: 'viewer', scopes: [IZMIR] },
    ]);
    expect(subject.can('moderator', ANKARA)).toBe(true);
    expect(subject.can('viewer', IZMIR)).toBe(true);
    expect(subject.can('moderator', IZMIR)).toBe(false);
    expect(subject.can('viewer', ANKARA)).toBe(false);
  });

  it('does not let a project-wide grant widen another role', () => {
    const subject = withGrants([
      { role: 'moderator', scopes: [ANKARA] },
      { role: 'viewer', scopes: [] },
    ]);
    expect(subject.can('moderator', IZMIR)).toBe(false);
    expect(subject.can('viewer', IZMIR)).toBe(true);
  });

  it('denies a malformed target without consulting the resolver', () => {
    const resolver = vi.fn(() => true);
    const subject = withGrants([{ role: 'moderator', scopes: [ANKARA] }], {
      scopeResolver: resolver,
    });

    expect(subject.can('moderator', { type: '', id: 6 } as unknown as HayratScope)).toBe(false);
    expect(subject.can('moderator', { type: 'province', id: 0 } as HayratScope)).toBe(false);
    expect(subject.can('moderator', { type: 'province', id: 1.5 } as HayratScope)).toBe(false);
    expect(subject.can('moderator', undefined as unknown as HayratScope)).toBe(false);
    expect(resolver).not.toHaveBeenCalled();
  });

  it('denies a malformed target even against a project-wide grant', () => {
    const subject = withGrants([{ role: 'viewer', scopes: [] }]);
    expect(subject.can('viewer', { type: 'province', id: -1 } as HayratScope)).toBe(false);
  });

  it('denies an empty role name', () => {
    expect(withGrants([{ role: 'viewer', scopes: [] }]).can('')).toBe(false);
  });

  it('keeps a grant whose scope type it does not know, and matches it only exactly', () => {
    // A scope type this build has never heard of must not cost the user the
    // whole token (the mint side does not validate types either). It simply
    // matches nothing but itself, so every check against a known type denies.
    const subject = withGrants([{ role: 'viewer', scopes: [{ type: 'galaxy', id: 6 }] }]);
    expect(subject.can('viewer', ANKARA)).toBe(false);
    expect(subject.can('viewer', { type: 'district', id: 6 })).toBe(false);
    expect(subject.can('viewer')).toBe(false);
    // No cast: the HayratScope type is deliberately open, so an
    // unknown type is expressible exactly as it is in Go.
    expect(subject.can('viewer', { type: 'galaxy', id: 6 })).toBe(true);
  });
});

describe('can — the optional resolver', () => {
  it('is consulted only after an exact match fails', () => {
    const resolver = vi.fn(() => true);
    const subject = withGrants([{ role: 'moderator', scopes: [ANKARA] }], {
      scopeResolver: resolver,
    });

    expect(subject.can('moderator', ANKARA)).toBe(true);
    expect(resolver).not.toHaveBeenCalled();

    expect(subject.can('moderator', CANKAYA)).toBe(true);
    expect(resolver).toHaveBeenCalledWith(ANKARA, CANKAYA);
  });

  it('can express the province-contains-district rule the SDK refuses to know', () => {
    const subject = withGrants([{ role: 'moderator', scopes: [ANKARA] }], {
      scopeResolver: (granted: HayratScope, target: HayratScope) =>
        granted.type === 'province' && target.type === 'district' && granted.id === 6 && target.id === 601,
    });

    expect(subject.can('moderator', CANKAYA)).toBe(true);
    expect(subject.can('moderator', { type: 'district', id: 999 })).toBe(false);
  });

  it('denies when the resolver throws', () => {
    const subject = withGrants([{ role: 'moderator', scopes: [ANKARA] }], {
      scopeResolver: () => {
        throw new Error('application bug');
      },
    });

    expect(subject.can('moderator', CANKAYA)).toBe(false);
  });
});

describe('can — fail-closed decoding', () => {
  it.each([
    ['an unknown contract version', accessToken({ hayrat_ver: 2 })],
    ['a duplicated role', accessToken({ hayrat_grants: [{ role: 'v', scopes: [] }, { role: 'v', scopes: [] }] })],
    ['a scope id past the safe range', accessToken({ hayrat_grants: [{ role: 'v', scopes: [{ type: 'province', id: 0 }] }] })],
    ['a token that is not a JWT', 'garbage'],
  ])('is false for %s', (_label, token) => {
    seedSession({ access_token: token });
    expect(client().can('v')).toBe(false);
  });
});

describe('getUser', () => {
  it('reads the profile from the ID token', () => {
    seedSession({ id_token: idToken({ name: 'Ayşe Yılmaz', gender: 'female' }) });
    expect(client().getUser()).toEqual({
      sub: 'user-1',
      name: 'Ayşe Yılmaz',
      gender: 'female',
    });
  });

  it('is null with no session, and null for an unreadable ID token', () => {
    expect(client().getUser()).toBeNull();
    seedSession({ id_token: 'not-a-jwt' });
    expect(client().getUser()).toBeNull();
  });
});

describe('isAuthenticated', () => {
  it('is true for a live session', () => {
    seedSession();
    expect(client().isAuthenticated()).toBe(true);
  });

  it('is true when the access token has expired but a refresh token remains', () => {
    seedSession({ expires_at: nowSec() - 60 });
    expect(client().isAuthenticated()).toBe(true);
  });

  it('is true when the access token is unreadable but a refresh token remains', () => {
    seedSession({ access_token: accessToken({ hayrat_ver: 9 }) });
    expect(client().isAuthenticated()).toBe(true);
  });

  it('is false when the access token has expired and nothing can renew it', () => {
    seedSession({ expires_at: nowSec() - 60, refresh_token: undefined });
    expect(client().isAuthenticated()).toBe(false);
  });

  it('is false for a malformed record', () => {
    window.localStorage.setItem(STORAGE_KEY, '{broken');
    expect(client().isAuthenticated()).toBe(false);
  });
});

describe('onAuthStateChanged', () => {
  it('fires when this document signs out', async () => {
    seedSession();
    installFetch();
    const subject = client();
    const seen: boolean[] = [];
    subject.onAuthStateChanged((authenticated) => seen.push(authenticated));
    captureNavigation();

    void subject.logout();
    await vi.waitFor(() => {
      expect(seen).toEqual([false]);
    });
  });

  it('fires when another tab signs out', () => {
    seedSession();
    const subject = client();
    const seen: boolean[] = [];
    subject.onAuthStateChanged((authenticated) => seen.push(authenticated));

    otherTabClears();

    expect(seen).toEqual([false]);
  });

  it('fires when another tab stores a new token set, even though the boolean is unchanged', () => {
    seedSession();
    const subject = client();
    const seen: boolean[] = [];
    subject.onAuthStateChanged((authenticated) => seen.push(authenticated));

    otherTabWrites(storedRecord({ id_token: idToken({ name: 'Renamed' }) }));

    expect(seen).toEqual([true]);
    expect(subject.getUser()?.name).toBe('Renamed');
  });

  it('stops firing after the returned function is called', () => {
    seedSession();
    const subject = client();
    const listener = vi.fn();
    const unsubscribe = subject.onAuthStateChanged(listener);

    unsubscribe();
    otherTabClears();

    expect(listener).not.toHaveBeenCalled();
  });
});

describe('logout', () => {
  it('clears local state BEFORE redirecting, and hints the ID token', async () => {
    const record = seedSession();
    installFetch();
    const subject = client({ postLogoutRedirectUri: 'https://app.example.com/bye' });
    let storedAtNavigation: string | null = 'unset';
    vi.spyOn(window.location, 'assign').mockImplementation(() => {
      storedAtNavigation = window.localStorage.getItem(STORAGE_KEY);
    });

    void subject.logout();
    await vi.waitFor(() => {
      expect(storedAtNavigation).not.toBe('unset');
    });

    expect(storedAtNavigation).toBeNull();
    expect(subject.isAuthenticated()).toBe(false);
    expect(record.id_token).toBeTruthy();
  });

  it('sends id_token_hint and the registered post-logout URI', async () => {
    const record = seedSession();
    installFetch();
    const nav = captureNavigation();

    void client({ postLogoutRedirectUri: 'https://app.example.com/bye' }).logout();
    await vi.waitFor(() => {
      expect(nav.url).toBeDefined();
    });

    const url = new URL(nav.url as string);
    expect(`${url.origin}${url.pathname}`).toBe(END_SESSION_ENDPOINT);
    expect(url.searchParams.get('id_token_hint')).toBe(record.id_token);
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe('https://app.example.com/bye');
  });

  it('omits the post-logout URI when none is configured', async () => {
    seedSession();
    installFetch();
    const nav = captureNavigation();

    void client().logout();
    await vi.waitFor(() => {
      expect(nav.url).toBeDefined();
    });

    expect(new URL(nav.url as string).searchParams.has('post_logout_redirect_uri')).toBe(false);
  });

  it('signs this browser out even when discovery fails', async () => {
    // "Sign out" must never silently keep the tokens: on a shared machine
    // that is a session the next user inherits. The IdP-side session survives
    // this failure; a retry lands on the hint-less end-session path, which
    // answers with a confirmation page rather than refusing.
    seedSession();
    installFetch({ discovery: () => jsonResponse({}, 500) });
    const nav = captureNavigation();

    await expect(client().logout()).rejects.toBeInstanceOf(AuthUnavailableError);
    expect(nav.url).toBeUndefined();
    expect(readStored()).toBeNull();
  });
});

describe('discovery lifecycle', () => {
  function discoveryCalls(calls: { calls: Array<{ url: string }> }): number {
    return calls.calls.filter((call) => call.url === DISCOVERY_URL).length;
  }

  /** Lets an in-flight attempt finish settling before the next call is made. */
  function settle(): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }

  it('starts exactly one fetch when the client is created', async () => {
    const calls = installFetch({ token: () => jsonResponse(tokenBody()) });

    client();

    await vi.waitFor(() => {
      expect(discoveryCalls(calls)).toBe(1);
    });
  });

  it('never fetches again once a document has been accepted', async () => {
    seedSession({ expires_at: nowSec() - 10 });
    const calls = installFetch({ token: () => jsonResponse(tokenBody({ expires_in: 1 })) });
    const subject = client();
    captureNavigation();

    await subject.getAccessToken();
    await subject.getAccessToken();
    void subject.logout();
    await vi.waitFor(() => {
      expect(readStored()).toBeNull();
    });

    // Two rotations and a logout later, the page is still using the document it
    // accepted first: re-fetching would let the token endpoint move under a
    // session that already holds a refresh token.
    expect(discoveryCalls(calls)).toBe(1);
    expect(calls.tokenCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('retries after a failure, because nothing was accepted yet', async () => {
    seedSession({ expires_at: nowSec() - 10 });
    let attempt = 0;
    const calls = installFetch({
      discovery: () => {
        attempt += 1;
        return attempt === 1 ? jsonResponse({}, 500) : jsonResponse(discoveryBody());
      },
      token: () => jsonResponse(tokenBody()),
    });
    const subject = client();

    // The eager attempt fails; a network blip at page load must not kill the
    // client for the life of the page.
    await vi.waitFor(() => {
      expect(discoveryCalls(calls)).toBe(1);
    });
    await settle();

    await expect(subject.getAccessToken()).resolves.toBeTruthy();
    expect(discoveryCalls(calls)).toBe(2);

    // ...and the retry that succeeded is now the final document.
    seedSession({ expires_at: nowSec() - 10 });
    await subject.getAccessToken();
    expect(discoveryCalls(calls)).toBe(2);
  });

  it('shares one in-flight attempt between concurrent callers', async () => {
    seedSession({ expires_at: nowSec() - 10 });
    const gate = deferred<Response>();
    const calls = installFetch({
      discovery: () => gate.promise,
      token: () => jsonResponse(tokenBody()),
    });
    const subject = client();

    const first = subject.getAccessToken();
    const second = subject.getAccessToken();
    gate.resolve(jsonResponse(discoveryBody()));

    await Promise.all([first, second]);
    expect(discoveryCalls(calls)).toBe(1);
  });
});

function tokenBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    access_token: accessToken(),
    refresh_token: 'refresh-2',
    id_token: idToken(),
    token_type: 'Bearer',
    expires_in: 600,
    ...overrides,
  };
}

function discoveryBody(): Record<string, unknown> {
  return {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/oauth/authorize`,
    token_endpoint: `${ISSUER}/oauth/token`,
    end_session_endpoint: END_SESSION_ENDPOINT,
    jwks_uri: `${ISSUER}/oauth/jwks`,
  };
}
