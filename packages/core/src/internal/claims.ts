import type { HayratScope, HesabimUser } from '../types.js';
import { JsonNumber, integerEquals, isIntegerLexeme, numberValue } from './json.js';
import { parseJwt } from './jwt.js';
import { normalizeIssuer } from './url.js';

/**
 * The claim contract. Version 1 and nothing else: an unknown contract
 * version is a token this build cannot reason about, and guessing at
 * authorization is the one thing that must never happen.
 */
export const HAYRAT_CLAIM_VERSION = 1;
export const CLAIM_VER = 'hayrat_ver';
export const CLAIM_GRANTS = 'hayrat_grants';
export const CLAIM_PROFILE_VER = 'hayrat_profile_ver';

/** The largest integer a JSON number survives through `JSON.parse` unrounded. */
export const MAX_SAFE_SCOPE_ID = Number.MAX_SAFE_INTEGER;

export interface HayratGrant {
  role: string;
  /** Empty means project-wide FOR THIS ROLE. */
  scopes: HayratScope[];
}

export interface AccessClaims {
  grants: HayratGrant[];
  /** `hayrat_profile_ver`; undefined when the token carries none (older issuer). */
  profileVersion?: number;
}

/**
 * THE access-token decoder. `handleCallback`, the refresh path, `can` and
 * `getAccessToken` all come through here, so "what a valid access token is" has
 * exactly one definition and cannot drift between the write path and the read
 * path.
 *
 * Fail-closed throughout: null means the token is not usable, and every caller
 * treats null as "there is no authorization here" rather than as "assume yes".
 *
 * Deliberately NOT checked: `exp`. Expiry is the stored envelope's
 * `expires_at`'s job — folding it in here would make an expired-but-refreshable
 * session read as malformed, and `isAuthenticated()` would start answering
 * `false` for a user who is still signed in.
 *
 * Also not checked: `aud`'s VALUE. The audience of an access token is the API
 * resource (`api:<project-key>`), which a browser client is never configured
 * with; its SHAPE is checked instead — one audience, never a multi-element
 * array, because this issuer mints exactly one.
 *
 * The rest of the resource-server claim matrix — `jti`, `client_id`, `sid`,
 * `amr`, `iat`, `nbf` — is deliberately absent too. Enforcing it belongs to
 * the Go SDK, which verifies the signature and makes the authorization
 * decision; this decoder is UX-only ("can this button render"), and widening
 * it would only add ways for a signed-in user's UI to go blank without adding
 * any security. Do not "complete" it.
 */
export function decodeAccessClaims(token: unknown, issuer: string): AccessClaims | null {
  const parts = parseJwt(token);
  if (!parts) return null;
  const payload = parts.payload;

  // Byte-exact on the TOKEN's side; only the configured value is normalized.
  // The backend refuses to boot with a trailing-slash ISSUER_URL ("clients
  // match the iss claim exactly", cmd/public validateIssuer), and the Go SDK
  // compares the claim verbatim — normalizing the claim here would accept an
  // iss the reference implementation rejects.
  if (payload['iss'] !== normalizeIssuer(issuer)) return null;
  if (!isSingleAudience(payload['aud'])) return null;
  if (!isNonEmptyString(payload['sub'])) return null;

  if (!integerEquals(payload[CLAIM_VER], HAYRAT_CLAIM_VERSION)) return null;

  const grants = parseGrants(payload[CLAIM_GRANTS]);
  if (!grants) return null;

  const profileVersion = profileVersionOf(payload[CLAIM_PROFILE_VER]);
  return profileVersion === undefined ? { grants } : { grants, profileVersion };
}

/**
 * `hayrat_profile_ver`: a cache-staleness marker for the application's profile
 * copy, NOT authorization. So it never rejects a token: absent, null, a string,
 * a fraction, a negative or an unsafe integer all read as "no version"
 * (undefined) — which can at worst fail to trigger a refresh.
 */
function profileVersionOf(value: unknown): number | undefined {
  if (!(value instanceof JsonNumber)) return undefined;
  if (!isIntegerLexeme(value.raw)) return undefined;
  if (!Number.isSafeInteger(value.value) || value.value < 0) return undefined;
  return value.value;
}

/**
 * `hayrat_grants` shape validation.
 *
 * A duplicate role is rejected rather than merged or first-match-won: the mint
 * side merges, so two entries for one role cannot come from this issuer, and
 * "which one did the reader look at first" is not a question an authorization
 * check may have.
 *
 * An UNKNOWN scope type passes. The mint side does not validate types either
 * (the issuer decides what may exist), so rejecting one
 * here would turn "reference data gained a fifth scope type" into "everyone
 * granted it is locked out of every deployed SDK". An unknown type simply never
 * matches an exact check, which denies.
 */
function parseGrants(value: unknown): HayratGrant[] | null {
  if (!Array.isArray(value)) return null;

  const grants: HayratGrant[] = [];
  const seen = new Set<string>();

  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    const entry = raw as Record<string, unknown>;

    const role = entry['role'];
    if (!isNonEmptyString(role)) return null;
    if (seen.has(role)) return null;
    seen.add(role);

    const rawScopes = entry['scopes'];
    if (!Array.isArray(rawScopes)) return null;

    const scopes: HayratScope[] = [];
    for (const rawScope of rawScopes) {
      if (typeof rawScope !== 'object' || rawScope === null || Array.isArray(rawScope)) return null;
      const scope = rawScope as Record<string, unknown>;
      const type = scope['type'];
      if (!isNonEmptyString(type)) return null;
      const id = claimScopeId(scope['id']);
      if (id === null) return null;
      scopes.push({ type, id });
    }

    grants.push({ role, scopes });
  }

  return grants;
}

/**
 * A scope id AS IT APPEARS IN A TOKEN: judged on the lexeme first, then on the
 * value. Returns the id, or null.
 *
 * The lexeme is what makes this lossless. `1.00000000000000001` and
 * `9007199254740991.1` both survive `JSON.parse` as safe integers — the first as
 * `1`, the second as `2^53-1` — so a check that only ran on the parsed value
 * would accept an id nobody granted. Requiring plain integer SYNTAX (no
 * fraction, no exponent) removes the entire class. The range then rejects `-0`,
 * `0`, negatives, and everything at or above 2^53, where a decimal literal can
 * no longer name one integer.
 */
export function claimScopeId(value: unknown): number | null {
  if (!(value instanceof JsonNumber)) return null;
  if (!isIntegerLexeme(value.raw)) return null;
  if (value.value < 1 || value.value > MAX_SAFE_SCOPE_ID) return null;
  return value.value;
}

/**
 * A well-formed `can()` target: a non-empty type and a usable id.
 *
 * Targets come from application code as ordinary JavaScript values, so there is
 * no lexeme to inspect — `Number.isInteger` plus the range is all that can be
 * asked, and it is enough: an application that computed a fractional id has a
 * bug, and this denies rather than guesses.
 */
export function isValidScopeTarget(value: unknown): value is HayratScope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const scope = value as Record<string, unknown>;
  const id = scope['id'];
  return (
    isNonEmptyString(scope['type']) &&
    typeof id === 'number' &&
    Number.isInteger(id) &&
    id >= 1 &&
    id <= MAX_SAFE_SCOPE_ID
  );
}

export interface IdTokenValidationOptions {
  issuer: string;
  clientId: string;
  clockSkewSec: number;
  nowSec: number;
  /**
   * The nonce bound to this authorization request. Pass it for a code exchange;
   * OMIT it on refresh — a refreshed ID token deliberately carries no nonce
   * (OIDC Core 12.2), and requiring one there would break every refresh.
   */
  nonce?: string;
}

/**
 * Validates an ID token's claims and returns the profile it carries.
 *
 * No signature verification: see parseJwt and the README. `at_hash` is not
 * verified either — without a signature it binds nothing an attacker who can
 * substitute the ID token could not also substitute, and any XSS that can reach
 * one token can reach both.
 */
export function validateIdToken(
  token: unknown,
  opts: IdTokenValidationOptions,
): HesabimUser | null {
  const parts = parseJwt(token);
  if (!parts) return null;
  const payload = parts.payload;

  // Byte-exact, like the access-token decoder: see decodeAccessClaims.
  if (payload['iss'] !== normalizeIssuer(opts.issuer)) return null;

  if (!audienceEquals(payload['aud'], opts.clientId)) return null;

  // `azp` is optional in a single-audience token, but when it IS present it
  // names the party the token was issued to, and that party must be us.
  const azp = payload['azp'];
  if (azp !== undefined) {
    if (typeof azp !== 'string' || azp !== opts.clientId) return null;
  }

  const exp = numberValue(payload['exp']);
  if (exp === null) return null;
  // >= — expired AT the boundary instant, matching golang-jwt/v5, which
  // requires now to be strictly Before(exp + leeway).
  if (opts.nowSec >= exp + opts.clockSkewSec) return null;

  const iat = numberValue(payload['iat']);
  if (iat === null) return null;
  if (iat > opts.nowSec + opts.clockSkewSec) return null;

  const sub = payload['sub'];
  if (!isNonEmptyString(sub)) return null;

  if (opts.nonce !== undefined) {
    const nonce = payload['nonce'];
    if (typeof nonce !== 'string' || nonce !== opts.nonce) return null;
  }

  const user: HesabimUser = { sub };
  const name = payload['name'];
  if (isNonEmptyString(name)) user.name = name;
  const gender = payload['gender'];
  if (isNonEmptyString(gender)) user.gender = gender;
  const profileVersion = profileVersionOf(payload[CLAIM_PROFILE_VER]);
  if (profileVersion !== undefined) user.profileVersion = profileVersion;
  return user;
}

/** Reads the profile out of a stored ID token without re-running time checks. */
export function profileFromIdToken(token: unknown): HesabimUser | null {
  const parts = parseJwt(token);
  if (!parts) return null;
  const sub = parts.payload['sub'];
  if (!isNonEmptyString(sub)) return null;

  const user: HesabimUser = { sub };
  const name = parts.payload['name'];
  if (isNonEmptyString(name)) user.name = name;
  const gender = parts.payload['gender'];
  if (isNonEmptyString(gender)) user.gender = gender;
  const profileVersion = profileVersionOf(parts.payload[CLAIM_PROFILE_VER]);
  if (profileVersion !== undefined) user.profileVersion = profileVersion;
  return user;
}

/** One audience, as a bare string or as a one-element array. Never more. */
function isSingleAudience(value: unknown): boolean {
  if (isNonEmptyString(value)) return true;
  return Array.isArray(value) && value.length === 1 && isNonEmptyString(value[0]);
}

function audienceEquals(value: unknown, expected: string): boolean {
  if (typeof value === 'string') return value === expected;
  if (Array.isArray(value)) return value.length === 1 && value[0] === expected;
  return false;
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
