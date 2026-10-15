import { describe, expect, it } from 'vitest';
import { createHesabimClient } from './client.js';
import { CLIENT_ID, ISSUER, REDIRECT_URI, STORAGE_KEY, seedSession } from './test-support/harness.js';

const base = { issuer: ISSUER, clientId: CLIENT_ID, redirectUri: REDIRECT_URI };

describe('createHesabimClient — configuration', () => {
  it('accepts a well-formed configuration', () => {
    expect(() => createHesabimClient({ ...base })).not.toThrow();
  });

  it('rejects an issuer that is not an absolute https URL', () => {
    expect(() => createHesabimClient({ ...base, issuer: 'idp.example.com' })).toThrow(/issuer/);
    expect(() => createHesabimClient({ ...base, issuer: 'http://idp.example.com' })).toThrow(
      /issuer/,
    );
    expect(() => createHesabimClient({ ...base, issuer: '' })).toThrow(/issuer/);
  });

  it('accepts a loopback issuer over http', () => {
    expect(() => createHesabimClient({ ...base, issuer: 'http://localhost:8080' })).not.toThrow();
  });

  it('requires a client id', () => {
    expect(() => createHesabimClient({ ...base, clientId: '' })).toThrow(/clientId/);
  });

  it('requires an absolute redirect URI', () => {
    expect(() => createHesabimClient({ ...base, redirectUri: '/callback' })).toThrow(/redirectUri/);
  });

  it('refuses a redirect URI on another origin', () => {
    // A callback landing elsewhere could not read the sessionStorage this SDK
    // put the PKCE verifier in, so it could never complete.
    expect(() =>
      createHesabimClient({ ...base, redirectUri: 'https://other.example/callback' }),
    ).toThrow(/origin/);
  });

  it('validates the optional fields', () => {
    expect(() => createHesabimClient({ ...base, scopes: '' })).toThrow(/scopes/);
    expect(() => createHesabimClient({ ...base, clockSkewSec: -1 })).toThrow(/clockSkewSec/);
    expect(() =>
      createHesabimClient({ ...base, clockSkewSec: Number.NaN }),
    ).toThrow(/clockSkewSec/);
    expect(() =>
      createHesabimClient({ ...base, postLogoutRedirectUri: '/bye' }),
    ).toThrow(/postLogoutRedirectUri/);
    expect(() =>
      createHesabimClient({ ...base, scopeResolver: 'nope' as unknown as () => boolean }),
    ).toThrow(/scopeResolver/);
  });

  it('leaves a mid-refresh marker untouched at construction time', () => {
    // A marker at startup is ambiguous: a tab that died mid-rotation — or
    // another tab's HEALTHY refresh in flight right now. Only the refresh lock
    // resolves the ambiguity (holding it proves nobody is mid-POST), so the
    // constructor must not act on it; the first getAccessToken() reaches the
    // verdict under the lock. Until then the record is a session, as every
    // passive reader already treats it.
    const record = seedSession({ refresh_pending: { at: Math.floor(Date.now() / 1000) - 5 } });

    const client = createHesabimClient({ ...base });

    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify(record));
    expect(client.isAuthenticated()).toBe(true);
  });

  it('leaves a healthy session alone', () => {
    const record = seedSession();
    const client = createHesabimClient({ ...base });

    expect(client.isAuthenticated()).toBe(true);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify(record));
  });
});
