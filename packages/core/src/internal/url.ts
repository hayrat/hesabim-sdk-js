/** URL rules: issuer normalisation, endpoint acceptance, and the returnTo guard. */

/**
 * The one normalisation this SDK applies to an issuer: a single trailing slash
 * is dropped. Used for the storage key, for the discovery `issuer` comparison
 * and for every `iss` claim comparison, so all three agree on what "equal" is.
 */
export function normalizeIssuer(issuer: string): string {
  return issuer.endsWith('/') ? issuer.slice(0, -1) : issuer;
}

/**
 * The plaintext exemption is two host names and no more. `[::1]` is left out
 * deliberately, matching the Go SDK's ruling: the exemption
 * exists for the local development setup, and every additional spelling of
 * "local" is another string a deployment could get wrong.
 */
export function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

/** Parses an absolute URL, or null. Relative input is rejected (no base is passed). */
export function parseAbsoluteUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * An issuer must be an absolute `https` URL with no query and no fragment.
 * `http` is allowed ONLY on a loopback host, which is the local development
 * case and nothing else.
 */
export function parseIssuerUrl(value: unknown): URL | null {
  const url = parseAbsoluteUrl(value);
  if (!url) return null;
  if (url.search !== '' || url.hash !== '') return null;
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) return url;
  return null;
}

/**
 * An endpoint from the discovery document must be absolute and `https` — with
 * the same loopback exemption, and only when the issuer itself is a loopback
 * URL, so a production issuer can never hand out a plaintext endpoint.
 */
export function parseEndpointUrl(value: unknown, allowHttp: boolean): URL | null {
  const url = parseAbsoluteUrl(value);
  if (!url) return null;
  if (url.protocol === 'https:') return url;
  if (allowHttp && url.protocol === 'http:' && isLoopbackHost(url.hostname)) return url;
  return null;
}

/**
 * Reduces a caller-supplied `returnTo` to something that cannot leave this
 * origin, or drops it.
 *
 * Rejected: anything that resolves to another origin (`https://evil.example`,
 * `//evil.example`), anything containing a backslash or a control character,
 * and anything whose percent-decoding contains one — browsers have historically
 * disagreed about backslashes in URLs, and `/\evil.example` is read as a
 * protocol-relative URL by several of them.
 *
 * What survives is only `pathname + search + hash` — and that reduction is not
 * safe on its own: dot segments normalise `/.//evil.example/` (same-origin as
 * written) to the pathname `//evil.example/`, which `location.assign` reads as
 * protocol-relative. So the reduced value must not start with two slashes, and
 * it is resolved once more and must still land on this origin.
 */
export function sanitizeReturnTo(input: unknown, origin: string): string | undefined {
  if (typeof input !== 'string' || input.length === 0) return undefined;
  if (carriesForbiddenChars(input)) return undefined;

  let url: URL;
  try {
    url = new URL(input, origin);
  } catch {
    return undefined;
  }
  if (url.origin !== origin) return undefined;

  const reduced = `${url.pathname}${url.search}${url.hash}`;
  if (reduced.startsWith('//') || reduced.startsWith('/\\')) return undefined;
  try {
    if (new URL(reduced, origin).origin !== origin) return undefined;
  } catch {
    return undefined;
  }
  return reduced;
}

const CHAR_BACKSLASH = 0x5c;
const CHAR_DEL = 0x7f;
const CHAR_SPACE = 0x20;

/**
 * True when the value — or its percent-decoding — contains a backslash, a C0
 * control character or DEL.
 *
 * The decoded form is checked because `%5C` is a backslash to anything that
 * unescapes the value later, and a rule that only looked at the raw text would
 * be one `encodeURIComponent` away from useless. A malformed escape sequence
 * counts as forbidden: there is nothing to guess about.
 */
function carriesForbiddenChars(value: string): boolean {
  if (hasForbiddenChar(value)) return true;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return true;
  }
  return hasForbiddenChar(decoded);
}

function hasForbiddenChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < CHAR_SPACE || code === CHAR_DEL || code === CHAR_BACKSLASH) return true;
  }
  return false;
}
