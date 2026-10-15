import { describe, expect, it } from 'vitest';
import { normalizeIssuer, parseEndpointUrl, parseIssuerUrl, sanitizeReturnTo } from './url.js';

const ORIGIN = 'https://app.example.com';

describe('normalizeIssuer', () => {
  it('drops exactly one trailing slash', () => {
    expect(normalizeIssuer('https://idp.example.com/')).toBe('https://idp.example.com');
    expect(normalizeIssuer('https://idp.example.com')).toBe('https://idp.example.com');
    expect(normalizeIssuer('https://idp.example.com/oidc/')).toBe('https://idp.example.com/oidc');
  });
});

describe('parseIssuerUrl', () => {
  it('accepts https', () => {
    expect(parseIssuerUrl('https://idp.example.com')?.href).toBe('https://idp.example.com/');
  });

  it('accepts http only on a loopback host', () => {
    expect(parseIssuerUrl('http://localhost:8080')).not.toBeNull();
    expect(parseIssuerUrl('http://127.0.0.1:8080')).not.toBeNull();
    expect(parseIssuerUrl('http://idp.example.com')).toBeNull();
    expect(parseIssuerUrl('http://localhost.evil.example')).toBeNull();
  });

  it('rejects relative, query-bearing and fragment-bearing issuers', () => {
    expect(parseIssuerUrl('/oidc')).toBeNull();
    expect(parseIssuerUrl('https://idp.example.com?x=1')).toBeNull();
    expect(parseIssuerUrl('https://idp.example.com#x')).toBeNull();
    expect(parseIssuerUrl('')).toBeNull();
    expect(parseIssuerUrl(undefined)).toBeNull();
  });
});

describe('parseEndpointUrl', () => {
  it('requires https unless the issuer is loopback', () => {
    expect(parseEndpointUrl('https://idp.example.com/token', false)).not.toBeNull();
    expect(parseEndpointUrl('http://idp.example.com/token', false)).toBeNull();
    expect(parseEndpointUrl('http://localhost:8080/token', false)).toBeNull();
    expect(parseEndpointUrl('http://localhost:8080/token', true)).not.toBeNull();
    // Even a loopback issuer may not point at a plaintext PUBLIC host.
    expect(parseEndpointUrl('http://idp.example.com/token', true)).toBeNull();
  });

  it('rejects a relative endpoint', () => {
    expect(parseEndpointUrl('/oauth/token', true)).toBeNull();
  });
});

describe('sanitizeReturnTo', () => {
  it('keeps a same-origin path with its query and hash', () => {
    expect(sanitizeReturnTo('/reports?page=2#top', ORIGIN)).toBe('/reports?page=2#top');
    expect(sanitizeReturnTo(`${ORIGIN}/reports`, ORIGIN)).toBe('/reports');
  });

  it('drops anything that resolves to another origin', () => {
    expect(sanitizeReturnTo('https://evil.example/x', ORIGIN)).toBeUndefined();
    expect(sanitizeReturnTo('//evil.example/x', ORIGIN)).toBeUndefined();
    expect(sanitizeReturnTo('http://app.example.com/x', ORIGIN)).toBeUndefined();
  });

  it('drops a path that normalises into a protocol-relative URL', () => {
    // `new URL('/.//evil.example/', origin)` is same-origin, but its pathname is
    // `//evil.example/` — handed to location.assign that IS another origin.
    expect(sanitizeReturnTo('/.//evil.example/', ORIGIN)).toBeUndefined();
    expect(sanitizeReturnTo('/..//evil.example', ORIGIN)).toBeUndefined();
    expect(sanitizeReturnTo('/%2e//evil.example', ORIGIN)).toBeUndefined();
    expect(sanitizeReturnTo('/a/..//evil.example', ORIGIN)).toBeUndefined();
  });

  it('keeps a same-origin path that merely contains a double slash later on', () => {
    expect(sanitizeReturnTo('/reports//2026', ORIGIN)).toBe('/reports//2026');
  });

  it('drops a backslash, encoded or not', () => {
    expect(sanitizeReturnTo('/\\evil.example', ORIGIN)).toBeUndefined();
    expect(sanitizeReturnTo('/%5Cevil.example', ORIGIN)).toBeUndefined();
    expect(sanitizeReturnTo('/%5cevil.example', ORIGIN)).toBeUndefined();
    expect(sanitizeReturnTo('\\\\evil.example', ORIGIN)).toBeUndefined();
  });

  it('drops control characters, encoded or not', () => {
    const ctl = (code: number): string => `/re${String.fromCharCode(code)}ports`;
    expect(sanitizeReturnTo(ctl(0x00), ORIGIN)).toBeUndefined();
    expect(sanitizeReturnTo(ctl(0x09), ORIGIN)).toBeUndefined();
    expect(sanitizeReturnTo(ctl(0x0a), ORIGIN)).toBeUndefined();
    expect(sanitizeReturnTo(ctl(0x7f), ORIGIN)).toBeUndefined();
    expect(sanitizeReturnTo('/re%00ports', ORIGIN)).toBeUndefined();
    expect(sanitizeReturnTo('/re%0Aports', ORIGIN)).toBeUndefined();
  });

  it('drops a malformed percent escape rather than guessing', () => {
    expect(sanitizeReturnTo('/reports%', ORIGIN)).toBeUndefined();
  });

  it('drops empty and non-string input', () => {
    expect(sanitizeReturnTo('', ORIGIN)).toBeUndefined();
    expect(sanitizeReturnTo(undefined, ORIGIN)).toBeUndefined();
    expect(sanitizeReturnTo(42, ORIGIN)).toBeUndefined();
  });

  it('never returns an authority component', () => {
    const value = sanitizeReturnTo('/x', ORIGIN);
    expect(value?.startsWith('/')).toBe(true);
    expect(value?.startsWith('//')).toBe(false);
  });
});
