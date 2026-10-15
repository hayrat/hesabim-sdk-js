import { createApp } from 'vue';
import type { App } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import { AuthRequiredError } from '@hayrat/hesabim-core';
import { createHesabim, useHesabim } from './index.js';
import type { HesabimVue } from './index.js';

const ISSUER = 'https://idp.example.com';
const CLIENT_ID = 'spa-client';
const REDIRECT_URI = 'https://app.example.com/callback';
const STORAGE_KEY = `hayrat.hesabim.${ISSUER}.${CLIENT_ID}`;

const config = { issuer: ISSUER, clientId: CLIENT_ID, redirectUri: REDIRECT_URI };

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function b64url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function jwt(payload: Record<string, unknown>): string {
  return `${b64url(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: 'k1' }))}.${b64url(
    JSON.stringify(payload),
  )}.c2ln`;
}

function accessToken(grants: unknown = []): string {
  const iat = nowSec();
  return jwt({
    iss: ISSUER,
    sub: 'user-1',
    aud: 'api:proje',
    exp: iat + 600,
    iat,
    hayrat_ver: 1,
    hayrat_grants: grants,
  });
}

function idToken(overrides: Record<string, unknown> = {}): string {
  const iat = nowSec();
  return jwt({
    iss: ISSUER,
    sub: 'user-1',
    aud: CLIENT_ID,
    exp: iat + 600,
    iat,
    name: 'Test User',
    gender: 'female',
    ...overrides,
  });
}

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    issuer: ISSUER,
    client_id: CLIENT_ID,
    access_token: accessToken(),
    refresh_token: 'refresh-1',
    id_token: idToken(),
    expires_at: nowSec() + 600,
    ...overrides,
  };
}

function seed(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const value = record(overrides);
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  return value;
}

function otherTabWrites(value: Record<string, unknown>): void {
  const serialized = JSON.stringify(value);
  window.localStorage.setItem(STORAGE_KEY, serialized);
  window.dispatchEvent(
    new StorageEvent('storage', { key: STORAGE_KEY, newValue: serialized }),
  );
}

function mount(overrides: Record<string, unknown> = {}): { app: App; api: HesabimVue } {
  const app = createApp({ render: () => null });
  app.use(createHesabim({ ...config, ...overrides }));
  const api = app.runWithContext(() => useHesabim());
  return { app, api };
}

describe('useHesabim', () => {
  it('refuses to work without the plugin', () => {
    const app = createApp({ render: () => null });
    expect(() => app.runWithContext(() => useHesabim())).toThrow(/createHesabim/);
  });

  it('seeds its state from the stored session at install time', () => {
    seed();
    const { api } = mount();

    expect(api.isAuthenticated.value).toBe(true);
    expect(api.user.value).toEqual({ sub: 'user-1', name: 'Test User', gender: 'female' });
  });

  it('starts signed out when there is no session', () => {
    const { api } = mount();

    expect(api.isAuthenticated.value).toBe(false);
    expect(api.user.value).toBeNull();
  });

  it('follows another tab signing out', () => {
    seed();
    const { api } = mount();

    window.localStorage.removeItem(STORAGE_KEY);
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY, newValue: null }));

    expect(api.isAuthenticated.value).toBe(false);
    expect(api.user.value).toBeNull();
  });

  it('re-reads the profile when the record changes but the boolean does not', () => {
    seed();
    const { api } = mount();
    expect(api.user.value?.name).toBe('Test User');

    otherTabWrites(record({ id_token: idToken({ name: 'Renamed' }) }));

    expect(api.isAuthenticated.value).toBe(true);
    expect(api.user.value?.name).toBe('Renamed');
  });

  it('exposes state that a component cannot write to', () => {
    seed();
    const { api } = mount();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    (api.isAuthenticated as { value: boolean }).value = false;

    expect(api.isAuthenticated.value).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  it('delegates the authorization check to the core client', () => {
    seed({
      access_token: accessToken([
        { role: 'moderator', scopes: [{ type: 'province', id: 6 }] },
        { role: 'viewer', scopes: [{ type: 'province', id: 35 }] },
      ]),
    });
    const { api } = mount();

    expect(api.can('moderator', { type: 'province', id: 6 })).toBe(true);
    // The cross product stays closed through the adapter too.
    expect(api.can('moderator', { type: 'province', id: 35 })).toBe(false);
    expect(api.can('viewer', { type: 'province', id: 35 })).toBe(true);
  });

  it('delegates getAccessToken to the core client', async () => {
    const stored = seed();
    const { api } = mount();

    await expect(api.getAccessToken()).resolves.toBe(stored['access_token']);
  });

  it('delegates login to the core client', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              issuer: ISSUER,
              authorization_endpoint: `${ISSUER}/oauth/authorize`,
              token_endpoint: `${ISSUER}/oauth/token`,
              end_session_endpoint: `${ISSUER}/oauth/logout`,
              jwks_uri: `${ISSUER}/oauth/jwks`,
            }),
            { status: 200 },
          ),
        ),
      ),
    );
    let target: string | undefined;
    vi.spyOn(window.location, 'assign').mockImplementation((url: string | URL) => {
      target = String(url);
    });
    const { api } = mount();

    void api.login({ returnTo: '/reports' });

    await vi.waitFor(() => {
      expect(target).toBeDefined();
    });
    expect(target).toContain(`${ISSUER}/oauth/authorize?`);
    expect(target).toContain('code_challenge_method=S256');
  });

  it('delegates handleCallback to the core client', async () => {
    const { api } = mount();
    // No state in the URL: the core client rejects, and the adapter surfaces it.
    await expect(api.handleCallback()).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it('gives every app instance its own client state', () => {
    seed();
    const first = mount();
    const second = mount();

    window.localStorage.removeItem(STORAGE_KEY);
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY, newValue: null }));

    expect(first.api.isAuthenticated.value).toBe(false);
    expect(second.api.isAuthenticated.value).toBe(false);
  });
});
