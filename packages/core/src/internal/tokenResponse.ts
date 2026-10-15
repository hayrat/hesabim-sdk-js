import type { HesabimUser } from '../types.js';
import type { AccessClaims } from './claims.js';
import { decodeAccessClaims, isNonEmptyString, validateIdToken } from './claims.js';

export interface ValidatedTokens {
  accessToken: string;
  refreshToken?: string;
  idToken: string;
  expiresAt: number;
  user: HesabimUser;
  claims: AccessClaims;
}

export interface TokenValidationOptions {
  issuer: string;
  clientId: string;
  clockSkewSec: number;
  nowSec: number;
  /** Required on refresh (rotation), optional on the code exchange. */
  requireRefreshToken: boolean;
  /** Present for a code exchange, absent for a refresh. */
  nonce?: string;
}

/**
 * Validates a token endpoint response COMPLETELY before anything of it is
 * persisted.
 *
 * A 2xx that fails any of this is not written over the record that is already
 * there and is not retried: on the refresh path that leaves the in-flight marker
 * unresolved, which forces a fresh sign-in rather than a replay of a refresh
 * token the server may already have rotated.
 */
export function validateTokenResponse(
  body: Record<string, unknown> | null,
  opts: TokenValidationOptions,
): ValidatedTokens | null {
  if (!body) return null;

  const accessToken = body['access_token'];
  const idToken = body['id_token'];
  const tokenType = body['token_type'];
  const expiresIn = body['expires_in'];
  const refreshToken = body['refresh_token'];

  if (!isNonEmptyString(accessToken)) return null;
  if (!isNonEmptyString(idToken)) return null;
  if (!isNonEmptyString(tokenType) || tokenType.toLowerCase() !== 'bearer') return null;
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) return null;

  if (opts.requireRefreshToken) {
    // Rotation is mandatory on this issuer. A refresh answer without a
    // successor would leave the record holding a token that has just been
    // spent, and presenting that again is what reuse detection revokes families
    // for.
    if (!isNonEmptyString(refreshToken)) return null;
  } else if (refreshToken !== undefined && !isNonEmptyString(refreshToken)) {
    return null;
  }

  const idOpts =
    opts.nonce === undefined
      ? {
          issuer: opts.issuer,
          clientId: opts.clientId,
          clockSkewSec: opts.clockSkewSec,
          nowSec: opts.nowSec,
        }
      : {
          issuer: opts.issuer,
          clientId: opts.clientId,
          clockSkewSec: opts.clockSkewSec,
          nowSec: opts.nowSec,
          nonce: opts.nonce,
        };
  const user = validateIdToken(idToken, idOpts);
  if (!user) return null;

  const claims = decodeAccessClaims(accessToken, opts.issuer);
  if (!claims) return null;

  const validated: ValidatedTokens = {
    accessToken,
    idToken,
    expiresAt: opts.nowSec + Math.floor(expiresIn),
    user,
    claims,
  };
  if (isNonEmptyString(refreshToken)) validated.refreshToken = refreshToken;
  return validated;
}

/**
 * The OAuth error code of a well-formed error response, or null.
 *
 * "Well-formed" is narrow on purpose: a JSON object carrying a non-empty string
 * `error`. Everything else — an HTML error page from a proxy, a truncated body,
 * a 500 with no body — is NOT an OAuth error and must not be allowed to look
 * like `invalid_grant`, which is the one answer that destroys a session.
 */
export function oauthErrorCode(body: Record<string, unknown> | null): string | null {
  if (!body) return null;
  const error = body['error'];
  return isNonEmptyString(error) ? error : null;
}
