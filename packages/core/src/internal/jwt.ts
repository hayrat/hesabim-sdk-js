import { base64UrlToString } from './base64url.js';
import { parseJsonObjectWithLexemes } from './json.js';

export interface JwtParts {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
}

/**
 * Both segments are read with the lexeme-preserving parser rather than
 * `JSON.parse`, so that a claim's numeric value can be judged on how it was
 * WRITTEN. See internal/json.ts — a rounded scope id is an authorization answer
 * about the wrong place. Every number in the returned objects is a JsonNumber.
 */

/**
 * Splits a compact JWS and returns its header and payload — WITHOUT verifying
 * the signature. See the README: the browser never verifies, because every
 * token this SDK reads came out of the token endpoint over TLS in this same
 * page. That exemption covers exactly those tokens and nothing else.
 *
 * The one cryptographic assertion made here is the algorithm: `ES256` is the
 * only value this issuer signs with, so anything else — `alg: none` above all —
 * is rejected at PARSE time, before any claim is read.
 */
export function parseJwt(token: unknown): JwtParts | null {
  if (typeof token !== 'string' || token.length === 0) return null;

  const segments = token.split('.');
  if (segments.length !== 3) return null;

  const [rawHeader, rawPayload, rawSignature] = segments as [string, string, string];
  // `alg: none` is a JWS with an empty signature segment. Rejecting the empty
  // segment as well as the algorithm means both halves of that trick fail.
  if (rawSignature.length === 0) return null;

  const header = parseJsonObjectSegment(rawHeader);
  const payload = parseJsonObjectSegment(rawPayload);
  if (!header || !payload) return null;

  if (header['alg'] !== 'ES256') return null;
  // `typ` is deliberately NOT checked: this issuer stamps "JWT" on access
  // tokens rather than RFC 9068's "at+jwt", and the header segment is pinned by
  // a backend test, so asserting on it here would only add a second place to
  // change when that pin moves.

  return { header, payload };
}

function parseJsonObjectSegment(segment: string): Record<string, unknown> | null {
  const json = base64UrlToString(segment);
  if (json === null) return null;
  return parseJsonObjectWithLexemes(json);
}
