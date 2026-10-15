import { vi } from 'vitest';

/** Fixtures and doubles shared by the test files. Never imported by src/index.ts. */

export const ISSUER = 'https://idp.example.com';
export const CLIENT_ID = 'spa-client';
export const REDIRECT_URI = 'https://app.example.com/callback';
export const STORAGE_KEY = `hayrat.hesabim.${ISSUER}.${CLIENT_ID}`;
export const FLOW_KEY_PREFIX = `${STORAGE_KEY}.flow.`;
export const LOCK_NAME = `${STORAGE_KEY}.refresh`;

export const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
export const TOKEN_ENDPOINT = `${ISSUER}/oauth/token`;
export const AUTHORIZATION_ENDPOINT = `${ISSUER}/oauth/authorize`;
export const END_SESSION_ENDPOINT = `${ISSUER}/oauth/logout`;

export const DISCOVERY_DOCUMENT: Record<string, unknown> = {
  issuer: ISSUER,
  authorization_endpoint: AUTHORIZATION_ENDPOINT,
  token_endpoint: TOKEN_ENDPOINT,
  end_session_endpoint: END_SESSION_ENDPOINT,
  jwks_uri: `${ISSUER}/oauth/jwks`,
};

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** base64url, written independently of the SDK's own encoder. */
function b64url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Builds an unsigned-but-well-formed compact JWS. Nothing verifies signatures. */
export function jwt(
  payload: Record<string, unknown>,
  header: Record<string, unknown> = {},
): string {
  const head = b64url(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: 'k1', ...header }));
  const body = b64url(JSON.stringify(payload));
  return `${head}.${body}.c2lnbmF0dXJl`;
}

/**
 * Same, but with the payload given as raw JSON — the only way to put a number
 * in a token that `JSON.stringify` would round on the way out (2^53+1).
 */
export function jwtWithRawPayload(payloadJson: string, header: Record<string, unknown> = {}): string {
  const head = b64url(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: 'k1', ...header }));
  return `${head}.${b64url(payloadJson)}.c2lnbmF0dXJl`;
}

export interface Grant {
  role: string;
  scopes: Array<{ type: string; id: number }>;
}

export function accessToken(overrides: Record<string, unknown> = {}): string {
  const iat = nowSec();
  return jwt({
    iss: ISSUER,
    sub: 'user-1',
    aud: 'api:proje',
    exp: iat + 600,
    iat,
    nbf: iat,
    jti: 'jti-1',
    client_id: CLIENT_ID,
    sid: 'sid-1',
    amr: ['otp'],
    hayrat_ver: 1,
    hayrat_grants: [],
    ...overrides,
  });
}

export function idToken(overrides: Record<string, unknown> = {}): string {
  const iat = nowSec();
  return jwt({
    iss: ISSUER,
    sub: 'user-1',
    aud: CLIENT_ID,
    azp: CLIENT_ID,
    exp: iat + 600,
    iat,
    sid: 'sid-1',
    auth_time: iat,
    amr: ['otp'],
    name: 'Test User',
    gender: 'female',
    ...overrides,
  });
}

export interface StoredRecord {
  v: number;
  issuer: string;
  client_id: string;
  access_token: string;
  refresh_token?: string;
  id_token: string;
  expires_at: number;
  refresh_pending?: { at: number };
}

export function storedRecord(overrides: Partial<StoredRecord> = {}): StoredRecord {
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

export function seedSession(record: Partial<StoredRecord> = {}): StoredRecord {
  const full = storedRecord(record);
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(full));
  return full;
}

export function readStored(): StoredRecord | null {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  return raw === null ? null : (JSON.parse(raw) as StoredRecord);
}

export interface SeededFlow {
  state: string;
  nonce: string;
  code_verifier: string;
  return_to?: string;
  created_at?: number;
}

/** Writes the sessionStorage record `login()` would have left behind. */
export function seedFlow(overrides: Partial<SeededFlow> = {}): SeededFlow {
  const flow: SeededFlow = {
    state: 'state-1',
    nonce: 'nonce-1',
    code_verifier: 'verifier-1',
    ...overrides,
  };
  window.sessionStorage.setItem(
    FLOW_KEY_PREFIX + flow.state,
    JSON.stringify({ v: 1, created_at: nowSec(), ...flow }),
  );
  return flow;
}

export function flowExists(state: string): boolean {
  return window.sessionStorage.getItem(FLOW_KEY_PREFIX + state) !== null;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function tokenResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    access_token: accessToken(),
    refresh_token: 'refresh-2',
    id_token: idToken(),
    token_type: 'Bearer',
    expires_in: 600,
    ...overrides,
  };
}

export interface FetchRoutes {
  discovery?: () => Response | Promise<Response>;
  token?: (body: URLSearchParams, init: RequestInit) => Response | Promise<Response>;
}

export interface FetchMock {
  calls: Array<{ url: string; init: RequestInit }>;
  tokenCalls: URLSearchParams[];
}

/**
 * Routes fetch by URL. An unrouted request throws, so a test that triggers an
 * unexpected network call fails instead of silently passing.
 */
export function installFetch(routes: FetchRoutes = {}): FetchMock {
  const record: FetchMock = { calls: [], tokenCalls: [] };

  const impl = async (input: unknown, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    record.calls.push({ url, init });

    if (url === DISCOVERY_URL) {
      return routes.discovery ? routes.discovery() : jsonResponse(DISCOVERY_DOCUMENT);
    }
    if (url === TOKEN_ENDPOINT) {
      const body = new URLSearchParams(String(init.body ?? ''));
      record.tokenCalls.push(body);
      if (!routes.token) throw new Error(`unexpected token request`);
      return routes.token(body, init);
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  vi.stubGlobal('fetch', vi.fn(impl));
  return record;
}

/**
 * A Web Locks double that actually serialises: requests for the same name run
 * one after another, which is the property the refresh path depends on.
 */
export function installWebLocks(): { held: string[] } {
  const chains = new Map<string, Promise<unknown>>();
  const held: string[] = [];

  const manager = {
    request: async <T>(name: string, callback: () => Promise<T>): Promise<T> => {
      const previous = chains.get(name) ?? Promise.resolve();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      chains.set(
        name,
        previous.then(
          () => gate,
          () => gate,
        ),
      );
      await previous.catch(() => undefined);
      held.push(name);
      try {
        return await callback();
      } finally {
        release();
      }
    },
  };

  Object.defineProperty(navigator, 'locks', {
    value: manager,
    configurable: true,
    writable: true,
  });
  return { held };
}

export function removeWebLocks(): void {
  Object.defineProperty(navigator, 'locks', {
    value: undefined,
    configurable: true,
    writable: true,
  });
}

/** Points the document at a URL without a real navigation. */
export function setUrl(pathAndQuery: string): void {
  window.history.replaceState(null, '', pathAndQuery);
}

/** Captures `location.assign` so redirect targets can be asserted. */
export function captureNavigation(): { url: string | undefined } {
  const captured: { url: string | undefined } = { url: undefined };
  vi.spyOn(window.location, 'assign').mockImplementation((target: string | URL) => {
    captured.url = String(target);
  });
  return captured;
}

/** Simulates another tab's write: mutate storage, then fire the event a browser would. */
export function dispatchStorageEvent(key: string | null, newValue: string | null): void {
  window.dispatchEvent(new StorageEvent('storage', { key, newValue }));
}

export function otherTabWrites(record: StoredRecord): void {
  const serialized = JSON.stringify(record);
  window.localStorage.setItem(STORAGE_KEY, serialized);
  dispatchStorageEvent(STORAGE_KEY, serialized);
}

export function otherTabClears(): void {
  window.localStorage.removeItem(STORAGE_KEY);
  dispatchStorageEvent(STORAGE_KEY, null);
}

/** A deferred, for holding a fetch open while a second call races it. */
export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
