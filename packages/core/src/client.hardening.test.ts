import { describe, expect, it, vi } from 'vitest';
import { createHesabimClient } from './client.js';
import { AuthRequiredError, AuthUnavailableError } from './errors.js';
import type { HesabimClient } from './types.js';
import {
  CLIENT_ID,
  DISCOVERY_URL,
  END_SESSION_ENDPOINT,
  ISSUER,
  REDIRECT_URI,
  captureNavigation,
  deferred,
  installFetch,
  jsonResponse,
  nowSec,
  otherTabWrites,
  readStored,
  seedSession,
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

describe('a refresh answer that arrives after the session it rotated is gone', () => {
  it('does not resurrect a session the user signed out of while the POST was in flight', async () => {
    seedSession({ expires_at: nowSec() - 10 });
    const answer = deferred<Response>();
    const calls = installFetch({ token: () => answer.promise });
    captureNavigation();
    const subject = client();

    const pending = subject.getAccessToken();
    await vi.waitFor(() => {
      expect(calls.tokenCalls).toHaveLength(1);
    });

    void subject.logout();
    await vi.waitFor(() => {
      expect(readStored()).toBeNull();
    });

    answer.resolve(jsonResponse(tokenResponse()));

    await expect(pending).rejects.toBeInstanceOf(AuthRequiredError);
    expect(readStored()).toBeNull();
    expect(subject.isAuthenticated()).toBe(false);
  });

  it('does not overwrite a newer session another tab stored while the POST was in flight', async () => {
    seedSession({ expires_at: nowSec() - 10 });
    const answer = deferred<Response>();
    const calls = installFetch({ token: () => answer.promise });
    const subject = client();

    const pending = subject.getAccessToken();
    await vi.waitFor(() => {
      expect(calls.tokenCalls).toHaveLength(1);
    });

    const newer = storedRecord({ refresh_token: 'refresh-from-new-login' });
    otherTabWrites(newer);

    answer.resolve(jsonResponse(tokenResponse()));

    await expect(pending).resolves.toBe(newer.access_token);
    expect(readStored()?.refresh_token).toBe('refresh-from-new-login');
  });

  it('does not clear a newer session when the stale refresh is answered with invalid_grant', async () => {
    seedSession({ expires_at: nowSec() - 10 });
    const answer = deferred<Response>();
    const calls = installFetch({ token: () => answer.promise });
    const subject = client();

    const pending = subject.getAccessToken();
    await vi.waitFor(() => {
      expect(calls.tokenCalls).toHaveLength(1);
    });

    const newer = storedRecord({ refresh_token: 'refresh-from-new-login' });
    otherTabWrites(newer);
    answer.resolve(jsonResponse({ error: 'invalid_grant' }, 400));

    await expect(pending).resolves.toBe(newer.access_token);
    expect(readStored()?.refresh_token).toBe('refresh-from-new-login');
  });
});

describe('logout without a stored ID token', () => {
  it('does not send a hint-less request to the IdP; it returns to the post-logout URI', async () => {
    const calls = installFetch();
    const nav = captureNavigation();

    void client({ postLogoutRedirectUri: 'https://app.example.com/bye' }).logout();
    await vi.waitFor(() => {
      expect(nav.url).toBeDefined();
    });

    expect(nav.url).toBe('https://app.example.com/bye');
    expect(nav.url?.startsWith(END_SESSION_ENDPOINT)).toBe(false);
    expect(calls.calls.filter((c) => c.url !== DISCOVERY_URL)).toHaveLength(0);
  });

  it('falls back to the application origin when no post-logout URI is configured', async () => {
    installFetch();
    const nav = captureNavigation();

    void client().logout();
    await vi.waitFor(() => {
      expect(nav.url).toBeDefined();
    });

    expect(nav.url).toBe(`${window.location.origin}/`);
  });
});

describe('login when the flow cannot be stored', () => {
  it('fails before redirecting, because the callback could never complete', async () => {
    installFetch();
    const nav = captureNavigation();
    vi.spyOn(window.sessionStorage, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });

    await expect(client().login()).rejects.toBeInstanceOf(AuthUnavailableError);
    expect(nav.url).toBeUndefined();
  });
});
