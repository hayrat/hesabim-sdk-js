/**
 * A JSON reader that keeps every number's ORIGINAL TEXT.
 *
 * # Why not JSON.parse
 *
 * `JSON.parse` converts a number to a double before anything can inspect it,
 * and the conversion is lossy in exactly the direction that matters here:
 *
 *   JSON.parse('{"id":1.00000000000000001}').id  // 1
 *   JSON.parse('{"id":9007199254740991.1}').id   // 9007199254740991
 *
 * Both then satisfy `Number.isInteger` and both land inside the safe range, so
 * a validator that runs after the parse cannot tell them from the integers they
 * were rounded to — and a scope id that was rounded is an authorization check
 * against a place nobody granted. The Go SDK reads its numbers through
 * `json.Number` for the same reason; this is the browser half of that parity.
 *
 * So the parser hands back a JsonNumber carrying the lexeme, and the claim
 * decoder decides on the TEXT: a scope id must be written as a plain integer,
 * with no fraction and no exponent, and must fall in [1, 2^53-1].
 *
 * The scope is deliberately small — JWT payloads are a few hundred bytes — so
 * this is a straightforward recursive-descent reader with a depth bound, not a
 * general-purpose JSON library.
 */

/** A number, with the source text it was written as. */
export class JsonNumber {
  readonly raw: string;
  readonly value: number;

  constructor(raw: string, value: number) {
    this.raw = raw;
    this.value = value;
  }
}

/** Nesting bound. A token this issuer mints is two levels deep; 64 is slack. */
const MAX_DEPTH = 64;

const NUMBER_PATTERN = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;

/** Integer syntax and nothing else: no fraction, no exponent, no leading zero. */
const INTEGER_LEXEME = /^-?(?:0|[1-9][0-9]*)$/;

class JsonSyntaxError extends Error {}

/**
 * Parses a JSON object, preserving number lexemes. Returns null for anything
 * that is not a syntactically valid JSON object — this is the outermost gate on
 * a token payload, so it never throws at its caller.
 */
export function parseJsonObjectWithLexemes(text: string): Record<string, unknown> | null {
  try {
    const reader = new Reader(text);
    const value = reader.readValue(0);
    reader.skipWhitespace();
    if (!reader.atEnd()) throw new JsonSyntaxError('trailing content');
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** True when the text is plain integer syntax (`-0` included; the range rejects it). */
export function isIntegerLexeme(raw: string): boolean {
  return INTEGER_LEXEME.test(raw);
}

/** The finite value of a parsed number, or null for anything that is not one. */
export function numberValue(value: unknown): number | null {
  if (!(value instanceof JsonNumber)) return null;
  return Number.isFinite(value.value) ? value.value : null;
}

/** True when the value is an integer-written number equal to `expected`. */
export function integerEquals(value: unknown, expected: number): boolean {
  if (!(value instanceof JsonNumber)) return false;
  return isIntegerLexeme(value.raw) && value.value === expected;
}

class Reader {
  private readonly src: string;
  private index = 0;

  constructor(src: string) {
    this.src = src;
  }

  atEnd(): boolean {
    return this.index >= this.src.length;
  }

  skipWhitespace(): void {
    while (this.index < this.src.length) {
      const code = this.src.charCodeAt(this.index);
      // The four JSON whitespace characters: space, tab, LF, CR.
      if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) this.index += 1;
      else break;
    }
  }

  readValue(depth: number): unknown {
    if (depth > MAX_DEPTH) throw new JsonSyntaxError('too deeply nested');
    this.skipWhitespace();
    if (this.atEnd()) throw new JsonSyntaxError('unexpected end of input');

    const char = this.src[this.index] as string;
    switch (char) {
      case '{':
        return this.readObject(depth);
      case '[':
        return this.readArray(depth);
      case '"':
        return this.readString();
      case 't':
        this.expect('true');
        return true;
      case 'f':
        this.expect('false');
        return false;
      case 'n':
        this.expect('null');
        return null;
      default:
        return this.readNumber();
    }
  }

  private readObject(depth: number): Record<string, unknown> {
    this.index += 1; // '{'
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    this.skipWhitespace();
    if (this.peek() === '}') {
      this.index += 1;
      return result;
    }
    for (;;) {
      this.skipWhitespace();
      if (this.peek() !== '"') throw new JsonSyntaxError('object key must be a string');
      const key = this.readString();
      // A duplicated key means two values for one claim, and "which one wins"
      // is not a question an authorization decision may depend on.
      if (Object.prototype.hasOwnProperty.call(result, key)) {
        throw new JsonSyntaxError('duplicate object key');
      }
      this.skipWhitespace();
      if (this.peek() !== ':') throw new JsonSyntaxError('expected :');
      this.index += 1;
      result[key] = this.readValue(depth + 1);
      this.skipWhitespace();
      const next = this.peek();
      if (next === ',') {
        this.index += 1;
        continue;
      }
      if (next === '}') {
        this.index += 1;
        return result;
      }
      throw new JsonSyntaxError('expected , or }');
    }
  }

  private readArray(depth: number): unknown[] {
    this.index += 1; // '['
    const result: unknown[] = [];
    this.skipWhitespace();
    if (this.peek() === ']') {
      this.index += 1;
      return result;
    }
    for (;;) {
      result.push(this.readValue(depth + 1));
      this.skipWhitespace();
      const next = this.peek();
      if (next === ',') {
        this.index += 1;
        continue;
      }
      if (next === ']') {
        this.index += 1;
        return result;
      }
      throw new JsonSyntaxError('expected , or ]');
    }
  }

  private readString(): string {
    this.index += 1; // opening quote
    let out = '';
    for (;;) {
      if (this.atEnd()) throw new JsonSyntaxError('unterminated string');
      const char = this.src[this.index] as string;
      const code = char.charCodeAt(0);
      if (char === '"') {
        this.index += 1;
        return out;
      }
      if (char === '\\') {
        this.index += 1;
        out += this.readEscape();
        continue;
      }
      // JSON forbids raw control characters inside a string.
      if (code < 0x20) throw new JsonSyntaxError('control character in string');
      out += char;
      this.index += 1;
    }
  }

  private readEscape(): string {
    if (this.atEnd()) throw new JsonSyntaxError('unterminated escape');
    const char = this.src[this.index] as string;
    this.index += 1;
    switch (char) {
      case '"':
        return '"';
      case '\\':
        return '\\';
      case '/':
        return '/';
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      case 'u': {
        const hex = this.src.slice(this.index, this.index + 4);
        if (hex.length !== 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) {
          throw new JsonSyntaxError('bad unicode escape');
        }
        this.index += 4;
        return String.fromCharCode(Number.parseInt(hex, 16));
      }
      default:
        throw new JsonSyntaxError('bad escape');
    }
  }

  private readNumber(): JsonNumber {
    NUMBER_PATTERN.lastIndex = this.index;
    const match = NUMBER_PATTERN.exec(this.src);
    if (!match || match.index !== this.index) throw new JsonSyntaxError('bad number');
    const raw = match[0];
    this.index += raw.length;
    return new JsonNumber(raw, Number(raw));
  }

  private peek(): string | undefined {
    return this.src[this.index];
  }

  private expect(literal: string): void {
    if (this.src.startsWith(literal, this.index)) {
      this.index += literal.length;
      return;
    }
    throw new JsonSyntaxError(`expected ${literal}`);
  }
}
