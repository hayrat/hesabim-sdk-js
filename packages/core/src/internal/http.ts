/** Bounded response reading. Shared by discovery and by the token endpoint. */

/** 1 MiB. A discovery document or a token response is kilobytes; anything past
 * this is either a misconfigured endpoint or an attempt to exhaust the tab. */
export const MAX_BODY_BYTES = 1024 * 1024;

export class BodyTooLargeError extends Error {
  constructor() {
    super('the response body exceeded the size this SDK will read');
    this.name = 'BodyTooLargeError';
  }
}

/**
 * Reads a response body as text, refusing to buffer more than MAX_BODY_BYTES.
 *
 * Streams when the environment gives a readable body (so the cap stops the
 * transfer rather than measuring it afterwards) and falls back to `text()` plus
 * a byte-length check where it does not.
 */
export async function readCappedText(response: Response): Promise<string> {
  const body = (response as { body?: ReadableStream<Uint8Array> | null }).body;

  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > MAX_BODY_BYTES) throw new BodyTooLargeError();
        chunks.push(value);
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* the stream is already done or already errored */
      }
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder('utf-8').decode(merged);
  }

  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new BodyTooLargeError();
  }
  return text;
}

/** Reads a capped body and parses it as a JSON object. Null when it is not one. */
export async function readCappedJsonObject(
  response: Response,
): Promise<Record<string, unknown> | null> {
  const text = await readCappedText(response);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}
