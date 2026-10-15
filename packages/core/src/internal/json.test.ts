import { describe, expect, it } from 'vitest';
import {
  JsonNumber,
  integerEquals,
  isIntegerLexeme,
  numberValue,
  parseJsonObjectWithLexemes,
} from './json.js';

function parse(text: string): Record<string, unknown> | null {
  return parseJsonObjectWithLexemes(text);
}

describe('parseJsonObjectWithLexemes — values', () => {
  it('reads the JSON types a token uses', () => {
    const value = parse('{"s":"a","t":true,"f":false,"n":null,"a":[1,"x"],"o":{"k":"v"}}');
    expect(value?.['s']).toBe('a');
    expect(value?.['t']).toBe(true);
    expect(value?.['f']).toBe(false);
    expect(value?.['n']).toBeNull();
    expect(Array.isArray(value?.['a'])).toBe(true);
    expect((value?.['o'] as Record<string, unknown>)['k']).toBe('v');
  });

  it('keeps every number as its source text', () => {
    const value = parse('{"a":1,"b":-2.5,"c":1e3,"d":0}');
    expect(value?.['a']).toBeInstanceOf(JsonNumber);
    expect((value?.['a'] as JsonNumber).raw).toBe('1');
    expect((value?.['b'] as JsonNumber).raw).toBe('-2.5');
    expect((value?.['b'] as JsonNumber).value).toBe(-2.5);
    expect((value?.['c'] as JsonNumber).raw).toBe('1e3');
    expect((value?.['c'] as JsonNumber).value).toBe(1000);
    expect((value?.['d'] as JsonNumber).raw).toBe('0');
  });

  it('keeps the lexeme of a number JSON.parse would round', () => {
    // The whole reason this parser exists.
    expect(JSON.parse('{"id":1.00000000000000001}').id).toBe(1);
    expect((parse('{"id":1.00000000000000001}')?.['id'] as JsonNumber).raw).toBe(
      '1.00000000000000001',
    );
    expect((parse('{"id":9007199254740991.1}')?.['id'] as JsonNumber).raw).toBe(
      '9007199254740991.1',
    );
  });

  it('decodes string escapes', () => {
    const value = parse('{"s":"a\\"b\\\\c\\/d\\n\\t\\u0041"}');
    expect(value?.['s']).toBe('a"b\\c/d\n\tA');
  });

  it('handles whitespace and nesting', () => {
    const value = parse('  {  "a" : [ { "b" : 1 } ]  }  ');
    const outer = value?.['a'] as unknown[];
    expect((outer[0] as Record<string, unknown>)['b']).toBeInstanceOf(JsonNumber);
  });
});

describe('parseJsonObjectWithLexemes — rejections', () => {
  it.each([
    ['not an object', '[1,2]'],
    ['a bare value', '"a"'],
    ['trailing content', '{"a":1} extra'],
    ['a trailing comma', '{"a":1,}'],
    ['an unquoted key', '{a:1}'],
    ['a single-quoted string', "{'a':1}"],
    ['an unterminated string', '{"a":"b}'],
    ['an unterminated object', '{"a":1'],
    ['a leading-zero number', '{"a":01}'],
    ['a bare plus', '{"a":+1}'],
    ['a fraction with no digits', '{"a":1.}'],
    ['an exponent with no digits', '{"a":1e}'],
    ['a hex number', '{"a":0x10}'],
    ['NaN', '{"a":NaN}'],
    ['Infinity', '{"a":Infinity}'],
    ['undefined', '{"a":undefined}'],
    ['a bad escape', '{"a":"\\q"}'],
    ['a short unicode escape', '{"a":"\\u00"}'],
    ['empty input', ''],
  ])('refuses %s', (_label, text) => {
    expect(parse(text)).toBeNull();
  });

  it('refuses a raw control character inside a string', () => {
    expect(parse(`{"a":"b${String.fromCharCode(0x0a)}c"}`)).toBeNull();
  });

  it('refuses a duplicated key — two values for one claim is not a question this answers', () => {
    expect(parse('{"hayrat_ver":1,"hayrat_ver":2}')).toBeNull();
  });

  it('refuses input nested past its depth bound', () => {
    const deep = `{"a":${'['.repeat(200)}1${']'.repeat(200)}}`;
    expect(parse(deep)).toBeNull();
  });

  it('does not inherit anything from Object.prototype', () => {
    const value = parse('{"a":1}');
    expect(Object.getPrototypeOf(value)).toBeNull();
    expect(parse('{"__proto__":{"polluted":true}}')).not.toBeNull();
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});

describe('lexeme helpers', () => {
  it('recognises plain integer syntax only', () => {
    expect(isIntegerLexeme('1')).toBe(true);
    expect(isIntegerLexeme('0')).toBe(true);
    expect(isIntegerLexeme('-0')).toBe(true);
    expect(isIntegerLexeme('9007199254740991')).toBe(true);
    expect(isIntegerLexeme('1.0')).toBe(false);
    expect(isIntegerLexeme('1e2')).toBe(false);
    expect(isIntegerLexeme('1E2')).toBe(false);
    expect(isIntegerLexeme('01')).toBe(false);
    expect(isIntegerLexeme('')).toBe(false);
  });

  it('reads a finite value out of a parsed number and nothing else', () => {
    expect(numberValue(new JsonNumber('12', 12))).toBe(12);
    expect(numberValue(12)).toBeNull();
    expect(numberValue('12')).toBeNull();
    expect(numberValue(undefined)).toBeNull();
  });

  it('compares an integer-written number with an expected value', () => {
    expect(integerEquals(new JsonNumber('1', 1), 1)).toBe(true);
    expect(integerEquals(new JsonNumber('1.0', 1), 1)).toBe(false);
    expect(integerEquals(new JsonNumber('1e0', 1), 1)).toBe(false);
    expect(integerEquals(new JsonNumber('2', 2), 1)).toBe(false);
    expect(integerEquals(1, 1)).toBe(false);
  });
});
