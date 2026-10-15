import { describe, expect, it, vi } from 'vitest';
import { AuthUnavailableError } from '../errors.js';
import {
  DISCOVERY_DOCUMENT,
  DISCOVERY_URL,
  ISSUER,
  installFetch,
  jsonResponse,
} from '../test-support/harness.js';
import { MAX_BODY_BYTES } from './http.js';
import { fetchDiscovery } from './discovery.js';

describe('fetchDiscovery', () => {
  it('reads the endpoints from the well-known document', async () => {
    const calls = installFetch();

    const discovery = await fetchDiscovery(ISSUER);

    expect(discovery).toEqual({
      authorizationEndpoint: `${ISSUER}/oauth/authorize`,
      tokenEndpoint: `${ISSUER}/oauth/token`,
      endSessionEndpoint: `${ISSUER}/oauth/logout`,
      jwksUri: `${ISSUER}/oauth/jwks`,
    });
    expect(calls.calls[0]?.url).toBe(DISCOVERY_URL);
  });

  it('normalises a trailing slash on the configured issuer', async () => {
    installFetch();
    await expect(fetchDiscovery(`${ISSUER}/`)).resolves.toBeTruthy();
  });

  it('does not follow redirects and sends no credentials', async () => {
    const calls = installFetch();
    await fetchDiscovery(ISSUER);
    expect(calls.calls[0]?.init.redirect).toBe('error');
    expect(calls.calls[0]?.init.credentials).toBe('omit');
  });

  it('refuses a document that names a different issuer', async () => {
    installFetch({
      discovery: () => jsonResponse({ ...DISCOVERY_DOCUMENT, issuer: 'https://evil.example' }),
    });
    await expect(fetchDiscovery(ISSUER)).rejects.toBeInstanceOf(AuthUnavailableError);
  });

  it('refuses anything but a 2xx', async () => {
    installFetch({ discovery: () => jsonResponse(DISCOVERY_DOCUMENT, 404) });
    await expect(fetchDiscovery(ISSUER)).rejects.toBeInstanceOf(AuthUnavailableError);
  });

  it('refuses a body that is not a JSON object', async () => {
    installFetch({ discovery: () => new Response('<html>nope</html>', { status: 200 }) });
    await expect(fetchDiscovery(ISSUER)).rejects.toBeInstanceOf(AuthUnavailableError);
  });

  it('refuses a body past the size cap', async () => {
    installFetch({
      discovery: () =>
        new Response('x'.repeat(MAX_BODY_BYTES + 1), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    });
    await expect(fetchDiscovery(ISSUER)).rejects.toBeInstanceOf(AuthUnavailableError);
  });

  it('turns a network failure into AuthUnavailableError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    await expect(fetchDiscovery(ISSUER)).rejects.toBeInstanceOf(AuthUnavailableError);
  });

  it.each([
    'authorization_endpoint',
    'token_endpoint',
    'end_session_endpoint',
  ])('refuses a document with no usable %s', async (field) => {
    installFetch({
      discovery: () => jsonResponse({ ...DISCOVERY_DOCUMENT, [field]: undefined }),
    });
    await expect(fetchDiscovery(ISSUER)).rejects.toBeInstanceOf(AuthUnavailableError);
  });

  it('does not require jwks_uri — the one field this client never reads', async () => {
    // The mirror of the Go SDK's rule, which requires ONLY jwks_uri: each SDK
    // requires what it reads, and a field it never reads must not break boot.
    installFetch({
      discovery: () => jsonResponse({ ...DISCOVERY_DOCUMENT, jwks_uri: undefined }),
    });
    const doc = await fetchDiscovery(ISSUER);
    expect(doc.jwksUri).toBeUndefined();
    expect(doc.tokenEndpoint).toBe(`${ISSUER}/oauth/token`);
  });

  it('still validates a jwks_uri the issuer DOES advertise', async () => {
    installFetch({
      discovery: () => jsonResponse({ ...DISCOVERY_DOCUMENT, jwks_uri: '/oauth/jwks' }),
    });
    await expect(fetchDiscovery(ISSUER)).rejects.toBeInstanceOf(AuthUnavailableError);
  });

  it('refuses a plaintext endpoint under an https issuer', async () => {
    installFetch({
      discovery: () =>
        jsonResponse({ ...DISCOVERY_DOCUMENT, token_endpoint: 'http://idp.example.com/token' }),
    });
    await expect(fetchDiscovery(ISSUER)).rejects.toBeInstanceOf(AuthUnavailableError);
  });

  it('refuses a relative endpoint', async () => {
    installFetch({
      discovery: () => jsonResponse({ ...DISCOVERY_DOCUMENT, token_endpoint: '/oauth/token' }),
    });
    await expect(fetchDiscovery(ISSUER)).rejects.toBeInstanceOf(AuthUnavailableError);
  });

  it('allows plaintext endpoints for a loopback issuer, which is the dev case', async () => {
    const local = 'http://localhost:8080';
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          jsonResponse({
            issuer: local,
            authorization_endpoint: `${local}/oauth/authorize`,
            token_endpoint: `${local}/oauth/token`,
            end_session_endpoint: `${local}/oauth/logout`,
            jwks_uri: `${local}/oauth/jwks`,
          }),
        ),
      ),
    );

    await expect(fetchDiscovery(local)).resolves.toMatchObject({
      tokenEndpoint: `${local}/oauth/token`,
    });
  });
});
