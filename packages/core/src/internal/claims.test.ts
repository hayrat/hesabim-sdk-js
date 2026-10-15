import { describe, expect, it } from 'vitest';
import {
  CLIENT_ID,
  ISSUER,
  accessToken,
  idToken,
  jwt,
  jwtWithRawPayload,
  nowSec,
} from '../test-support/harness.js';
import { decodeAccessClaims, profileFromIdToken, validateIdToken } from './claims.js';

const idOpts = {
  issuer: ISSUER,
  clientId: CLIENT_ID,
  clockSkewSec: 30,
  nowSec: nowSec(),
};

describe('decodeAccessClaims — token envelope', () => {
  it('accepts a token this issuer would mint', () => {
    const claims = decodeAccessClaims(
      accessToken({ hayrat_grants: [{ role: 'viewer', scopes: [] }] }),
      ISSUER,
    );
    expect(claims?.grants).toEqual([{ role: 'viewer', scopes: [] }]);
  });

  it('normalizes only the CONFIGURED issuer: a trailing slash there still matches', () => {
    expect(decodeAccessClaims(accessToken(), `${ISSUER}/`)).not.toBeNull();
  });

  it('compares the token iss byte-exactly — a trailing slash IN THE TOKEN is another issuer', () => {
    // The backend refuses to boot with a trailing-slash ISSUER_URL ("clients
    // match the iss claim exactly"), and the Go SDK compares the claim
    // verbatim. Normalizing the claim here would accept a token the reference
    // implementation rejects.
    expect(decodeAccessClaims(accessToken({ iss: `${ISSUER}/` }), ISSUER)).toBeNull();
  });

  it('rejects any algorithm other than ES256', () => {
    expect(decodeAccessClaims(accessToken(), ISSUER)).not.toBeNull();
    const hs = jwt(
      { iss: ISSUER, sub: 'u', aud: 'api:p', hayrat_ver: 1, hayrat_grants: [] },
      { alg: 'HS256' },
    );
    expect(decodeAccessClaims(hs, ISSUER)).toBeNull();
  });

  it('rejects alg:none, signature segment and all', () => {
    const header = btoa(JSON.stringify({ alg: 'none', typ: 'JWT' }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const payload = btoa(JSON.stringify({ iss: ISSUER, sub: 'u', aud: 'a', hayrat_ver: 1, hayrat_grants: [] }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(decodeAccessClaims(`${header}.${payload}.`, ISSUER)).toBeNull();
    expect(decodeAccessClaims(`${header}.${payload}`, ISSUER)).toBeNull();
  });

  it('rejects a token from another issuer', () => {
    expect(decodeAccessClaims(accessToken({ iss: 'https://evil.example' }), ISSUER)).toBeNull();
  });

  it('rejects a multi-element audience but accepts one element', () => {
    expect(decodeAccessClaims(accessToken({ aud: ['api:p'] }), ISSUER)).not.toBeNull();
    expect(decodeAccessClaims(accessToken({ aud: ['api:p', 'api:q'] }), ISSUER)).toBeNull();
    expect(decodeAccessClaims(accessToken({ aud: [] }), ISSUER)).toBeNull();
    expect(decodeAccessClaims(accessToken({ aud: '' }), ISSUER)).toBeNull();
  });

  it('rejects a contract version it does not know', () => {
    expect(decodeAccessClaims(accessToken({ hayrat_ver: 2 }), ISSUER)).toBeNull();
    expect(decodeAccessClaims(accessToken({ hayrat_ver: '1' }), ISSUER)).toBeNull();
    expect(decodeAccessClaims(accessToken({ hayrat_ver: undefined }), ISSUER)).toBeNull();
  });

  it('rejects a token with no grants claim at all', () => {
    expect(decodeAccessClaims(accessToken({ hayrat_grants: undefined }), ISSUER)).toBeNull();
    expect(decodeAccessClaims(accessToken({ hayrat_grants: null }), ISSUER)).toBeNull();
    expect(decodeAccessClaims(accessToken({ hayrat_grants: {} }), ISSUER)).toBeNull();
  });

  it('rejects a token with no subject', () => {
    expect(decodeAccessClaims(accessToken({ sub: '' }), ISSUER)).toBeNull();
  });

  it('rejects garbage that is not a JWT', () => {
    expect(decodeAccessClaims('not-a-token', ISSUER)).toBeNull();
    expect(decodeAccessClaims('', ISSUER)).toBeNull();
    expect(decodeAccessClaims(undefined, ISSUER)).toBeNull();
    expect(decodeAccessClaims('a.b.c', ISSUER)).toBeNull();
  });
});

describe('decodeAccessClaims — grant shape', () => {
  const withGrants = (grants: unknown): unknown =>
    decodeAccessClaims(accessToken({ hayrat_grants: grants }), ISSUER);

  it('rejects a grant with no role', () => {
    expect(withGrants([{ role: '', scopes: [] }])).toBeNull();
    expect(withGrants([{ scopes: [] }])).toBeNull();
  });

  it('rejects a grant whose scopes are missing or null', () => {
    expect(withGrants([{ role: 'viewer' }])).toBeNull();
    expect(withGrants([{ role: 'viewer', scopes: null }])).toBeNull();
  });

  it('rejects the same role twice', () => {
    expect(
      withGrants([
        { role: 'viewer', scopes: [] },
        { role: 'viewer', scopes: [{ type: 'province', id: 6 }] },
      ]),
    ).toBeNull();
  });

  it('keeps the same scope under two different roles', () => {
    const claims = decodeAccessClaims(
      accessToken({
        hayrat_grants: [
          { role: 'moderator', scopes: [{ type: 'district', id: 9 }] },
          { role: 'viewer', scopes: [{ type: 'district', id: 9 }] },
        ],
      }),
      ISSUER,
    );
    expect(claims?.grants).toHaveLength(2);
  });

  it('walks the scope id boundary table', () => {
    const cases: Array<[unknown, boolean]> = [
      [1, true],
      [6, true],
      [Number.MAX_SAFE_INTEGER, true],
      [0, false],
      [-1, false],
      [1.5, false],
      ['6', false],
      [null, false],
      [Number.NaN, false],
      [Number.POSITIVE_INFINITY, false],
    ];
    for (const [id, accepted] of cases) {
      const claims = withGrants([{ role: 'viewer', scopes: [{ type: 'province', id }] }]);
      expect(claims === null, `scope id ${String(id)}`).toBe(!accepted);
    }
  });

  it('judges a scope id on its LEXEME, so nothing arrives pre-rounded', () => {
    // Every rejected case below survives JSON.parse as a plausible integer.
    // Reading the source text is the only way to tell them apart.
    const raw = (id: string): string =>
      jwtWithRawPayload(
        `{"iss":"${ISSUER}","sub":"u","aud":"api:p","hayrat_ver":1,` +
          `"hayrat_grants":[{"role":"viewer","scopes":[{"type":"province","id":${id}}]}]}`,
      );
    const decoded = (id: string): number | undefined =>
      decodeAccessClaims(raw(id), ISSUER)?.grants[0]?.scopes[0]?.id;

    // Accepted: plain integer syntax inside the safe range.
    expect(decoded('1')).toBe(1);
    expect(decoded('6')).toBe(6);
    expect(decoded('9007199254740991')).toBe(9007199254740991);

    // Rejected: at or above 2^53, where a literal no longer names one integer.
    expect(decoded('9007199254740992')).toBeUndefined();
    expect(decoded('9007199254740993')).toBeUndefined();
    expect(decoded('99999999999999999999')).toBeUndefined();

    // Rejected: fractions that JSON.parse rounds to an in-range integer.
    expect(JSON.parse('{"id":1.00000000000000001}').id).toBe(1);
    expect(decoded('1.00000000000000001')).toBeUndefined();
    expect(JSON.parse('{"id":9007199254740991.1}').id).toBe(Number.MAX_SAFE_INTEGER);
    expect(decoded('9007199254740991.1')).toBeUndefined();
    expect(decoded('6.0')).toBeUndefined();
    expect(decoded('6.5')).toBeUndefined();

    // Rejected: exponent forms, however innocent the value.
    expect(decoded('1e2')).toBeUndefined();
    expect(decoded('6E0')).toBeUndefined();
    expect(decoded('6e-0')).toBeUndefined();

    // Rejected: everything at or below zero, `-0` included.
    expect(decoded('0')).toBeUndefined();
    expect(decoded('-0')).toBeUndefined();
    expect(decoded('-1')).toBeUndefined();

    // Rejected: not a number at all.
    expect(decoded('"6"')).toBeUndefined();
    expect(decoded('null')).toBeUndefined();
  });

  it('judges the contract version on its lexeme too', () => {
    const raw = (ver: string): string =>
      jwtWithRawPayload(
        `{"iss":"${ISSUER}","sub":"u","aud":"api:p","hayrat_ver":${ver},"hayrat_grants":[]}`,
      );
    expect(decodeAccessClaims(raw('1'), ISSUER)).not.toBeNull();
    expect(decodeAccessClaims(raw('1.0'), ISSUER)).toBeNull();
    expect(decodeAccessClaims(raw('1e0'), ISSUER)).toBeNull();
    expect(decodeAccessClaims(raw('"1"'), ISSUER)).toBeNull();
  });

  it('refuses a payload that repeats a claim', () => {
    const raw = jwtWithRawPayload(
      `{"iss":"${ISSUER}","sub":"u","aud":"api:p","hayrat_ver":1,` +
        `"hayrat_grants":[],"hayrat_grants":[{"role":"admin","scopes":[]}]}`,
    );
    expect(decodeAccessClaims(raw, ISSUER)).toBeNull();
  });

  it('rejects a scope with no type', () => {
    expect(withGrants([{ role: 'viewer', scopes: [{ type: '', id: 6 }] }])).toBeNull();
    expect(withGrants([{ role: 'viewer', scopes: [{ id: 6 }] }])).toBeNull();
  });

  it('accepts an unknown scope type — the mint side does not validate types either', () => {
    const claims = decodeAccessClaims(
      accessToken({ hayrat_grants: [{ role: 'viewer', scopes: [{ type: 'galaxy', id: 6 }] }] }),
      ISSUER,
    );
    expect(claims?.grants[0]?.scopes[0]).toEqual({ type: 'galaxy', id: 6 });
  });
});

describe('validateIdToken', () => {
  it('returns the profile of a valid token', () => {
    expect(validateIdToken(idToken(), idOpts)).toEqual({
      sub: 'user-1',
      name: 'Test User',
      gender: 'female',
    });
  });

  it('rejects another issuer and another audience', () => {
    expect(validateIdToken(idToken({ iss: 'https://evil.example' }), idOpts)).toBeNull();
    expect(validateIdToken(idToken({ aud: 'other-client' }), idOpts)).toBeNull();
  });

  it('accepts a single-element audience array and rejects a longer one', () => {
    expect(validateIdToken(idToken({ aud: [CLIENT_ID] }), idOpts)).not.toBeNull();
    expect(validateIdToken(idToken({ aud: [CLIENT_ID, 'other'] }), idOpts)).toBeNull();
  });

  it('requires azp to name this client WHEN PRESENT, and tolerates its absence', () => {
    expect(validateIdToken(idToken({ azp: 'other-client' }), idOpts)).toBeNull();
    expect(validateIdToken(idToken({ azp: undefined }), idOpts)).not.toBeNull();
    expect(validateIdToken(idToken({ azp: 42 }), idOpts)).toBeNull();
  });

  it('applies the clock skew to exp', () => {
    const now = nowSec();
    expect(validateIdToken(idToken({ exp: now - 10 }), { ...idOpts, nowSec: now })).not.toBeNull();
    expect(validateIdToken(idToken({ exp: now - 31 }), { ...idOpts, nowSec: now })).toBeNull();
  });

  it('rejects AT the skew boundary, matching golang-jwt/v5', () => {
    const now = nowSec();
    // exp + skew == now: expired. jwt/v5 requires now to be strictly
    // Before(exp + leeway); accepting equality here would be a one-second
    // parity drift between the two SDKs.
    expect(validateIdToken(idToken({ exp: now - 30 }), { ...idOpts, nowSec: now })).toBeNull();
    expect(validateIdToken(idToken({ exp: now - 29 }), { ...idOpts, nowSec: now })).not.toBeNull();
  });

  it('requires an iat that is not in the future beyond the skew', () => {
    const now = nowSec();
    expect(validateIdToken(idToken({ iat: now + 10 }), { ...idOpts, nowSec: now })).not.toBeNull();
    expect(validateIdToken(idToken({ iat: now + 31 }), { ...idOpts, nowSec: now })).toBeNull();
    expect(validateIdToken(idToken({ iat: undefined }), idOpts)).toBeNull();
    expect(validateIdToken(idToken({ exp: undefined }), idOpts)).toBeNull();
  });

  it('requires a subject', () => {
    expect(validateIdToken(idToken({ sub: '' }), idOpts)).toBeNull();
    expect(validateIdToken(idToken({ sub: undefined }), idOpts)).toBeNull();
  });

  it('checks the nonce when one is expected', () => {
    expect(validateIdToken(idToken({ nonce: 'n1' }), { ...idOpts, nonce: 'n1' })).not.toBeNull();
    expect(validateIdToken(idToken({ nonce: 'n2' }), { ...idOpts, nonce: 'n1' })).toBeNull();
    expect(validateIdToken(idToken(), { ...idOpts, nonce: 'n1' })).toBeNull();
  });

  it('does not look for a nonce when none is expected — refreshed ID tokens carry none', () => {
    expect(validateIdToken(idToken(), idOpts)).not.toBeNull();
    expect(validateIdToken(idToken({ nonce: 'stale' }), idOpts)).not.toBeNull();
  });

  it('drops profile fields that are not non-empty strings', () => {
    expect(validateIdToken(idToken({ name: '', gender: 7 }), idOpts)).toEqual({ sub: 'user-1' });
  });
});

describe('profileFromIdToken', () => {
  it('reads the profile without re-checking time', () => {
    expect(profileFromIdToken(idToken({ exp: nowSec() - 10_000 }))).toEqual({
      sub: 'user-1',
      name: 'Test User',
      gender: 'female',
    });
  });

  it('returns null for a token it cannot parse or one with no subject', () => {
    expect(profileFromIdToken('nope')).toBeNull();
    expect(profileFromIdToken(idToken({ sub: undefined }))).toBeNull();
  });
});

describe('hayrat_profile_ver', () => {
  it('is read from the ID token and from the access token', () => {
    expect(validateIdToken(idToken({ hayrat_profile_ver: 7 }), idOpts)?.profileVersion).toBe(7);
    expect(profileFromIdToken(idToken({ hayrat_profile_ver: 7 }))?.profileVersion).toBe(7);
    expect(decodeAccessClaims(accessToken({ hayrat_profile_ver: 7 }), ISSUER)?.profileVersion).toBe(
      7,
    );
  });

  it('is simply absent when the token carries none (an issuer that predates it)', () => {
    expect(validateIdToken(idToken(), idOpts)).not.toHaveProperty('profileVersion');
    expect(profileFromIdToken(idToken())).not.toHaveProperty('profileVersion');
    expect(decodeAccessClaims(accessToken(), ISSUER)).not.toHaveProperty('profileVersion');
  });

  it('never rejects a token over a malformed value, it just reads as absent', () => {
    for (const bad of ['7', 7.5, -3, null, true, 9007199254740993, [7]]) {
      const id = validateIdToken(idToken({ hayrat_profile_ver: bad }), idOpts);
      expect(id).not.toBeNull();
      expect(id).not.toHaveProperty('profileVersion');
      const access = decodeAccessClaims(accessToken({ hayrat_profile_ver: bad }), ISSUER);
      expect(access).not.toBeNull();
      expect(access).not.toHaveProperty('profileVersion');
    }
  });

  it('accepts zero as a number but not 1.0 spelled as a fraction', () => {
    expect(profileFromIdToken(idToken({ hayrat_profile_ver: 0 }))?.profileVersion).toBe(0);
    expect(
      profileFromIdToken(jwtWithRawPayload('{"sub":"user-1","hayrat_profile_ver":1.0}')),
    ).not.toHaveProperty('profileVersion');
  });
});
