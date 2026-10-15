import { bytesToBase64Url } from './base64url.js';
import { getCrypto } from './env.js';

/** 32 bytes of CSPRNG output, base64url encoded. Used for state, nonce and the
 * PKCE verifier — all three are unguessability values, all three get the same
 * 256 bits, and none of them is ever derived from the others. */
export function randomToken(): string {
  const crypto = requireCrypto();
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

/** S256, the only challenge method this IdP accepts. */
export async function codeChallengeS256(verifier: string): Promise<string> {
  const crypto = requireCrypto();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return bytesToBase64Url(new Uint8Array(digest));
}

function requireCrypto(): Crypto {
  const crypto = getCrypto();
  if (!crypto) {
    // `crypto.subtle` is absent outside a secure context, and there is no
    // acceptable fallback: a PKCE verifier from Math.random is not a PKCE
    // verifier.
    throw new Error(
      'WebCrypto is unavailable — this SDK requires a secure context (https, or localhost)',
    );
  }
  return crypto;
}
