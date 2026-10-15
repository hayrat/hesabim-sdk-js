import { beforeEach, describe, expect, it } from 'vitest';
import { createHesabimClient } from './client.js';
import { AuthRequiredError, AuthUnavailableError, CallbackError } from './errors.js';
import type { HesabimClient } from './types.js';
import {
  CLIENT_ID,
  ISSUER,
  REDIRECT_URI,
  TOKEN_ENDPOINT,
  accessToken,
  flowExists,
  idToken,
  installFetch,
  jsonResponse,
  nowSec,
  readStored,
  seedFlow,
  setUrl,
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

beforeEach(() => {
  setUrl('/callback');
});

describe('handleCallback — the happy path', () => {
  it('exchanges the code and stores the token set', async () => {
    const flow = seedFlow({ return_to: '/reports' });
    const body = tokenResponse({ id_token: idToken({ nonce: flow.nonce }) });
    const calls = installFetch({ token: () => jsonResponse(body) });
    setUrl(`/callback?code=abc&state=${flow.state}`);

    const result = await client().handleCallback();

    expect(result).toEqual({ returnTo: '/reports' });
    const stored = readStored();
    expect(stored?.access_token).toBe(body['access_token']);
    expect(stored?.refresh_token).toBe(body['refresh_token']);
    expect(stored?.id_token).toBe(body['id_token']);
    expect(stored?.issuer).toBe(ISSUER);
    expect(stored?.client_id).toBe(CLIENT_ID);
    expect(stored?.refresh_pending).toBeUndefined();
    expect(stored?.expires_at).toBeGreaterThan(nowSec());

    const sent = calls.tokenCalls[0];
    expect(calls.calls.at(-1)?.url).toBe(TOKEN_ENDPOINT);
    expect(sent?.get('grant_type')).toBe('authorization_code');
    expect(sent?.get('code')).toBe('abc');
    expect(sent?.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(sent?.get('client_id')).toBe(CLIENT_ID);
    expect(sent?.get('code_verifier')).toBe(flow.code_verifier);
  });

  it('scrubs the response parameters out of the address bar', async () => {
    const flow = seedFlow();
    installFetch({ token: () => jsonResponse(tokenResponse({ id_token: idToken({ nonce: flow.nonce }) })) });
    setUrl(`/callback?code=abc&state=${flow.state}&iss=${encodeURIComponent(ISSUER)}&keep=1`);

    await client().handleCallback();

    expect(window.location.search).toBe('?keep=1');
    expect(window.location.pathname).toBe('/callback');
  });

  it('returns no returnTo when none was stored', async () => {
    const flow = seedFlow();
    installFetch({ token: () => jsonResponse(tokenResponse({ id_token: idToken({ nonce: flow.nonce }) })) });
    setUrl(`/callback?code=abc&state=${flow.state}`);

    await expect(client().handleCallback()).resolves.toEqual({});
  });

  it('accepts a response with no refresh token (offline_access was not requested)', async () => {
    const flow = seedFlow();
    installFetch({
      token: () =>
        jsonResponse(
          tokenResponse({ id_token: idToken({ nonce: flow.nonce }), refresh_token: undefined }),
        ),
    });
    setUrl(`/callback?code=abc&state=${flow.state}`);

    await client().handleCallback();

    expect(readStored()?.refresh_token).toBeUndefined();
  });

  it('cannot be replayed: the flow record is single use', async () => {
    const flow = seedFlow();
    installFetch({ token: () => jsonResponse(tokenResponse({ id_token: idToken({ nonce: flow.nonce }) })) });
    setUrl(`/callback?code=abc&state=${flow.state}`);
    const subject = client();
    await subject.handleCallback();

    setUrl(`/callback?code=abc&state=${flow.state}`);
    await expect(subject.handleCallback()).rejects.toBeInstanceOf(AuthRequiredError);
  });
});

describe('handleCallback — state comes first', () => {
  it('refuses a callback with no state', async () => {
    seedFlow();
    const calls = installFetch();
    setUrl('/callback?code=abc');

    await expect(client().handleCallback()).rejects.toBeInstanceOf(AuthRequiredError);
    expect(calls.tokenCalls).toHaveLength(0);
  });

  it('refuses a callback carrying two state parameters', async () => {
    const flow = seedFlow();
    installFetch();
    setUrl(`/callback?code=abc&state=${flow.state}&state=other`);

    await expect(client().handleCallback()).rejects.toBeInstanceOf(AuthRequiredError);
    // The pending flow survives: a duplicated parameter must not consume it.
    expect(flowExists(flow.state)).toBe(true);
  });

  it('refuses a state that never started here', async () => {
    seedFlow();
    installFetch();
    setUrl('/callback?code=abc&state=forged');

    await expect(client().handleCallback()).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it('refuses a state whose flow has expired', async () => {
    const flow = seedFlow({ created_at: nowSec() - 16 * 60 });
    installFetch();
    setUrl(`/callback?code=abc&state=${flow.state}`);

    await expect(client().handleCallback()).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it('does NOT let an unbound error parameter tear down a pending sign-in', async () => {
    // Anyone can send a user to /callback?error=access_denied. Because the state
    // is read and matched first, that request cannot consume the flow record
    // the real sign-in is waiting on.
    const flow = seedFlow();
    installFetch();
    setUrl('/callback?error=access_denied');

    const rejection = await client()
      .handleCallback()
      .catch((err: unknown) => err);

    expect(rejection).toBeInstanceOf(AuthRequiredError);
    expect(rejection).not.toBeInstanceOf(CallbackError);
    expect(flowExists(flow.state)).toBe(true);
  });
});

describe('handleCallback — server errors', () => {
  it('surfaces the error code and nothing else', async () => {
    const flow = seedFlow();
    installFetch();
    setUrl(
      `/callback?state=${flow.state}&error=access_denied` +
        `&error_description=${encodeURIComponent('user Ali rejected the consent for project X')}`,
    );

    const rejection = (await client()
      .handleCallback()
      .catch((err: unknown) => err)) as CallbackError;

    expect(rejection).toBeInstanceOf(CallbackError);
    expect(rejection.code).toBe('access_denied');
    expect(rejection.message).not.toContain('Ali');
    expect(JSON.stringify(rejection.message)).not.toContain('rejected the consent');
    expect(readStored()).toBeNull();
  });

  it('refuses a callback carrying a code AND an error', async () => {
    const flow = seedFlow();
    installFetch();
    setUrl(`/callback?state=${flow.state}&code=abc&error=access_denied`);

    const rejection = await client()
      .handleCallback()
      .catch((err: unknown) => err);

    expect(rejection).toBeInstanceOf(AuthRequiredError);
    expect(rejection).not.toBeInstanceOf(CallbackError);
  });

  it('refuses duplicated code or error parameters', async () => {
    const flow = seedFlow();
    installFetch();
    setUrl(`/callback?state=${flow.state}&code=abc&code=def`);
    await expect(client().handleCallback()).rejects.toBeInstanceOf(AuthRequiredError);

    const second = seedFlow({ state: 'state-2' });
    setUrl(`/callback?state=${second.state}&error=a&error=b`);
    await expect(client().handleCallback()).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it('refuses a callback with a state but no code', async () => {
    const flow = seedFlow();
    const calls = installFetch();
    setUrl(`/callback?state=${flow.state}`);

    await expect(client().handleCallback()).rejects.toBeInstanceOf(AuthRequiredError);
    expect(calls.tokenCalls).toHaveLength(0);
  });

  it('turns a well-formed OAuth error from the token endpoint into a CallbackError', async () => {
    const flow = seedFlow();
    installFetch({
      token: () =>
        jsonResponse({ error: 'invalid_grant', error_description: 'code already used' }, 400),
    });
    setUrl(`/callback?code=abc&state=${flow.state}`);

    const rejection = (await client()
      .handleCallback()
      .catch((err: unknown) => err)) as CallbackError;

    expect(rejection).toBeInstanceOf(CallbackError);
    expect(rejection.code).toBe('invalid_grant');
    expect(rejection.message).not.toContain('already used');
  });

  it('turns an unreachable token endpoint into AuthUnavailableError', async () => {
    const flow = seedFlow();
    installFetch({
      token: () => {
        throw new TypeError('Failed to fetch');
      },
    });
    setUrl(`/callback?code=abc&state=${flow.state}`);

    await expect(client().handleCallback()).rejects.toBeInstanceOf(AuthUnavailableError);
    expect(readStored()).toBeNull();
  });
});

describe('handleCallback — token validation', () => {
  async function attempt(response: Record<string, unknown>): Promise<unknown> {
    const flow = seedFlow();
    installFetch({ token: () => jsonResponse(response) });
    setUrl(`/callback?code=abc&state=${flow.state}`);
    return client()
      .handleCallback()
      .catch((err: unknown) => err);
  }

  it('rejects an ID token whose nonce does not match the one this browser sent', async () => {
    const rejection = await attempt(tokenResponse({ id_token: idToken({ nonce: 'someone-elses' }) }));
    expect(rejection).toBeInstanceOf(AuthRequiredError);
    expect(readStored()).toBeNull();
  });

  it('rejects an ID token with no nonce at all on the code exchange', async () => {
    const rejection = await attempt(tokenResponse({ id_token: idToken() }));
    expect(rejection).toBeInstanceOf(AuthRequiredError);
    expect(readStored()).toBeNull();
  });

  it('rejects an ID token with more than one audience', async () => {
    const rejection = await attempt(
      tokenResponse({ id_token: idToken({ nonce: 'nonce-1', aud: [CLIENT_ID, 'other'] }) }),
    );
    expect(rejection).toBeInstanceOf(AuthRequiredError);
  });

  it('rejects an ID token whose azp names another client', async () => {
    const rejection = await attempt(
      tokenResponse({ id_token: idToken({ nonce: 'nonce-1', azp: 'other-client' }) }),
    );
    expect(rejection).toBeInstanceOf(AuthRequiredError);
  });

  it.each([
    ['a token type that is not Bearer', { token_type: 'mac' }],
    ['a non-positive lifetime', { expires_in: 0 }],
    ['a negative lifetime', { expires_in: -600 }],
    ['a lifetime that is not a number', { expires_in: '600' }],
    ['an infinite lifetime', { expires_in: null }],
    ['a missing access token', { access_token: undefined }],
    ['an empty access token', { access_token: '' }],
    ['a missing ID token', { id_token: undefined }],
    ['an empty refresh token', { refresh_token: '' }],
    ['a missing token type', { token_type: undefined }],
  ])('rejects a 2xx response with %s', async (_label, overrides) => {
    // A malformed token set is an SDK-side protocol failure: the remedy
    // is a fresh sign-in, not a retry, and nothing is stored either way.
    const rejection = await attempt(
      tokenResponse({ id_token: idToken({ nonce: 'nonce-1' }), ...overrides }),
    );
    expect(rejection).toBeInstanceOf(AuthRequiredError);
    expect(rejection).not.toBeInstanceOf(CallbackError);
    expect(readStored()).toBeNull();
  });

  it.each([
    ['a body that is not JSON', () => new Response('<html>hi</html>', { status: 200 })],
    ['a JSON array', () => jsonResponse([1, 2], 200)],
    ['an empty body', () => new Response('', { status: 200 })],
  ])('rejects a 2xx whose body is %s', async (_label, respond) => {
    const flow = seedFlow();
    installFetch({ token: respond });
    setUrl(`/callback?code=abc&state=${flow.state}`);

    const rejection = await client()
      .handleCallback()
      .catch((err: unknown) => err);

    expect(rejection).toBeInstanceOf(AuthRequiredError);
    expect(readStored()).toBeNull();
  });

  it.each([
    [500, 'a 5xx with no OAuth body', () => new Response('boom', { status: 500 })],
    [400, 'a 4xx with no OAuth body', () => new Response('nope', { status: 400 })],
    [400, 'a 4xx whose error field is empty', () => jsonResponse({ error: '' }, 400)],
  ])('reports %s (%s) as transport, not as an IdP error', async (_status, _label, respond) => {
    const flow = seedFlow();
    installFetch({ token: respond });
    setUrl(`/callback?code=abc&state=${flow.state}`);

    const rejection = await client()
      .handleCallback()
      .catch((err: unknown) => err);

    expect(rejection).toBeInstanceOf(AuthUnavailableError);
    expect(readStored()).toBeNull();
  });

  it('accepts a lower-case token_type', async () => {
    const flow = seedFlow();
    installFetch({
      token: () =>
        jsonResponse(
          tokenResponse({ id_token: idToken({ nonce: flow.nonce }), token_type: 'bearer' }),
        ),
    });
    setUrl(`/callback?code=abc&state=${flow.state}`);

    await expect(client().handleCallback()).resolves.toEqual({});
  });

  it.each([
    ['an unknown contract version', { hayrat_ver: 2 }],
    ['no grants claim', { hayrat_grants: undefined }],
    ['a duplicated role', { hayrat_grants: [{ role: 'v', scopes: [] }, { role: 'v', scopes: [] }] }],
    ['an out-of-range scope id', { hayrat_grants: [{ role: 'v', scopes: [{ type: 'province', id: 0 }] }] }],
    ['another issuer', { iss: 'https://evil.example' }],
  ])('rejects an access token with %s — the same decoder guards every path', async (_label, overrides) => {
    const rejection = await attempt(
      tokenResponse({ id_token: idToken({ nonce: 'nonce-1' }), access_token: accessToken(overrides) }),
    );
    expect(rejection).toBeInstanceOf(AuthRequiredError);
    expect(readStored()).toBeNull();
  });
});
