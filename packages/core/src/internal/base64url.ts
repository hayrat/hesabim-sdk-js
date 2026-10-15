/** base64url helpers. Strict on the way in — a JWT segment is attacker-shaped input. */

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i] as number);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Decodes an unpadded base64url segment to UTF-8 text, or null.
 *
 * Rejects anything outside the base64url alphabet (so `+`, `/` and `=` from
 * plain base64 do not sneak through), rejects an impossible length, and rejects
 * bytes that are not valid UTF-8 — a JWT segment that needs replacement
 * characters to render is not a JWT segment this SDK should act on.
 */
export function base64UrlToString(value: string): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;

  let padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const remainder = padded.length % 4;
  if (remainder === 1) return null;
  if (remainder === 2) padded += '==';
  else if (remainder === 3) padded += '=';

  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }

  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
