import { AuthUnavailableError } from '../errors.js';
import { readCappedJsonObject } from './http.js';
import { isLoopbackHost, normalizeIssuer, parseEndpointUrl } from './url.js';

export interface Discovery {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  endSessionEndpoint: string;
  /**
   * Validated when the issuer advertises one, but never REQUIRED and never
   * fetched: this SDK does not verify signatures in the browser, and a field
   * it never reads must not be able to break sign-in (the
   * mirror of the Go SDK's rule, which requires only `jwks_uri` because that
   * is the one field a resource server reads).
   */
  jwksUri?: string;
}

/**
 * Fetches and validates `<issuer>/.well-known/openid-configuration`.
 *
 * No endpoint path is ever hardcoded, and the document is bound to the issuer
 * it claims to describe: its `issuer` member must equal the configured one
 * (trailing slash aside). Without that check a redirect or a misconfigured
 * proxy could hand this SDK a document pointing at somebody else's token
 * endpoint, which is where the refresh token goes.
 *
 * Redirects are NOT followed (`redirect: 'error'`) for the same reason.
 */
export async function fetchDiscovery(issuer: string): Promise<Discovery> {
  const normalized = normalizeIssuer(issuer);
  const url = `${normalized}/.well-known/openid-configuration`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
    });
  } catch (cause) {
    throw new AuthUnavailableError('the discovery document could not be fetched', { cause });
  }

  if (!response.ok) {
    throw new AuthUnavailableError(
      `the discovery document request failed with status ${response.status}`,
    );
  }

  let document: Record<string, unknown> | null;
  try {
    document = await readCappedJsonObject(response);
  } catch (cause) {
    throw new AuthUnavailableError('the discovery document could not be read', { cause });
  }
  if (!document) {
    throw new AuthUnavailableError('the discovery document was not a JSON object');
  }

  const declaredIssuer = document['issuer'];
  if (typeof declaredIssuer !== 'string' || normalizeIssuer(declaredIssuer) !== normalized) {
    throw new AuthUnavailableError(
      'the discovery document names a different issuer than the one configured',
    );
  }

  let issuerUrl: URL;
  try {
    issuerUrl = new URL(normalized);
  } catch (cause) {
    throw new AuthUnavailableError('the configured issuer is not a URL', { cause });
  }
  const allowHttp = issuerUrl.protocol === 'http:' && isLoopbackHost(issuerUrl.hostname);

  const discovery: Discovery = {
    authorizationEndpoint: requireEndpoint(document, 'authorization_endpoint', allowHttp),
    tokenEndpoint: requireEndpoint(document, 'token_endpoint', allowHttp),
    endSessionEndpoint: requireEndpoint(document, 'end_session_endpoint', allowHttp),
  };
  if (document['jwks_uri'] !== undefined) {
    discovery.jwksUri = requireEndpoint(document, 'jwks_uri', allowHttp);
  }
  return discovery;
}

function requireEndpoint(
  document: Record<string, unknown>,
  field: string,
  allowHttp: boolean,
): string {
  const url = parseEndpointUrl(document[field], allowHttp);
  if (!url) {
    throw new AuthUnavailableError(
      `the discovery document has no usable absolute https ${field}`,
    );
  }
  return url.toString();
}
