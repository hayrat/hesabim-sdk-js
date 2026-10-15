import { describe, expect, it, vi } from 'vitest';
import { createHesabimClient } from './client.js';
import { AuthUnavailableError } from './errors.js';
import type { HesabimClient } from './types.js';
import {
  AUTHORIZATION_ENDPOINT,
  CLIENT_ID,
  FLOW_KEY_PREFIX,
  ISSUER,
  REDIRECT_URI,
  captureNavigation,
  installFetch,
  jsonResponse,
} from './test-support/harness.js';

function client(overrides: Record<string, unknown> = {}): HesabimClient {
  return createHesabimClient({
    issuer: ISSUER,
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    ...overrides,
  });
}

/** login() never settles on success, so tests wait for the navigation instead. */
async function startLogin(
  subject: HesabimClient,
  opts?: { returnTo?: string },
): Promise<URL> {
  const nav = captureNavigation();
  void subject.login(opts);
  await vi.waitFor(() => {
    expect(nav.url).toBeDefined();
  });
  return new URL(nav.url as string);
}

function storedFlow(state: string): Record<string, string> {
  const raw = window.sessionStorage.getItem(FLOW_KEY_PREFIX + state);
  expect(raw).not.toBeNull();
  return JSON.parse(raw as string) as Record<string, string>;
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  let binary = '';
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('login', () => {
  it('redirects to the authorization endpoint with exactly the agreed parameters', async () => {
    installFetch();
    const url = await startLogin(client());

    expect(`${url.origin}${url.pathname}`).toBe(AUTHORIZATION_ENDPOINT);
    expect([...url.searchParams.keys()].sort()).toEqual([
      'client_id',
      'code_challenge',
      'code_challenge_method',
      'nonce',
      'redirect_uri',
      'response_mode',
      'response_type',
      'scope',
      'state',
    ]);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('response_mode')).toBe('query');
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(url.searchParams.get('scope')).toBe('openid profile offline_access');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('honours a configured scope string', async () => {
    installFetch();
    const url = await startLogin(client({ scopes: 'openid profile' }));
    expect(url.searchParams.get('scope')).toBe('openid profile');
  });

  it('generates a fresh 256-bit state and nonce every time', async () => {
    installFetch();
    const first = await startLogin(client());
    const second = await startLogin(client());

    const state = first.searchParams.get('state') as string;
    const nonce = first.searchParams.get('nonce') as string;
    expect(state).not.toBe(second.searchParams.get('state'));
    expect(nonce).not.toBe(second.searchParams.get('nonce'));
    expect(state).not.toBe(nonce);
    // 32 bytes of base64url, unpadded.
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('sends a challenge that is the SHA-256 of the stored verifier', async () => {
    installFetch();
    const url = await startLogin(client());
    const state = url.searchParams.get('state') as string;
    const flow = storedFlow(state);

    expect(flow['code_verifier']).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('code_challenge')).toBe(
      await sha256Base64Url(flow['code_verifier'] as string),
    );
  });

  it('stores the flow under its own state, and the nonce with it', async () => {
    installFetch();
    const url = await startLogin(client());
    const state = url.searchParams.get('state') as string;
    const flow = storedFlow(state);

    expect(flow['state']).toBe(state);
    expect(flow['nonce']).toBe(url.searchParams.get('nonce'));
  });

  it('keeps a same-origin returnTo as a path only', async () => {
    installFetch();
    const url = await startLogin(client(), { returnTo: 'https://app.example.com/reports?p=2#top' });
    const flow = storedFlow(url.searchParams.get('state') as string);

    expect(flow['return_to']).toBe('/reports?p=2#top');
  });

  it.each([
    'https://evil.example/steal',
    '//evil.example/steal',
    '/\\evil.example',
    '/%5Cevil.example',
  ])('drops a returnTo that could leave this origin: %s', async (returnTo) => {
    installFetch();
    const url = await startLogin(client(), { returnTo });
    const flow = storedFlow(url.searchParams.get('state') as string);

    expect(flow['return_to']).toBeUndefined();
  });

  it('does not navigate when discovery fails', async () => {
    installFetch({ discovery: () => jsonResponse({}, 503) });
    const nav = captureNavigation();

    await expect(client().login()).rejects.toBeInstanceOf(AuthUnavailableError);
    expect(nav.url).toBeUndefined();
  });

  it('starts two parallel sign-ins without either clobbering the other', async () => {
    installFetch();
    const subject = client();
    const first = await startLogin(subject);
    const second = await startLogin(subject);

    const stateA = first.searchParams.get('state') as string;
    const stateB = second.searchParams.get('state') as string;
    expect(storedFlow(stateA)['state']).toBe(stateA);
    expect(storedFlow(stateB)['state']).toBe(stateB);
  });
});
