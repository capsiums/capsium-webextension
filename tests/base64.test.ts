import { describe, expect, it } from 'vitest';
import {
  decodeBase64,
  encodeBase64,
  parseDataUri,
  toDataUri,
} from '../src/lib/base64';

describe('base64', () => {
  it('round-trips every byte value', () => {
    const bytes = new Uint8Array(256).map((_, i) => i);
    expect(decodeBase64(encodeBase64(bytes))).toEqual(bytes);
  });

  it('round-trips lengths 0..7 (padding branches)', () => {
    for (let len = 0; len <= 7; len += 1) {
      const bytes = new Uint8Array(len).map((_, i) => i * 37 + 11);
      expect(decodeBase64(encodeBase64(bytes))).toEqual(bytes);
    }
  });

  it('matches known vectors', () => {
    expect(encodeBase64(new TextEncoder().encode('hello world'))).toBe(
      'aGVsbG8gd29ybGQ=',
    );
    expect([...decodeBase64('aGVsbG8=')]).toEqual([
      ...new TextEncoder().encode('hello'),
    ]);
  });

  it('rejects invalid characters', () => {
    expect(() => decodeBase64('aGVs!G8=')).toThrow(/Invalid base64/);
  });

  it('round-trips data: URIs', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252]);
    const uri = toDataUri('application/pdf', bytes);
    expect(uri.startsWith('data:application/pdf;base64,')).toBe(true);
    const parsed = parseDataUri(uri);
    expect(parsed.contentType).toBe('application/pdf');
    expect(parsed.bytes).toEqual(bytes);
  });

  it('parses percent-encoded plain data: URIs', () => {
    const parsed = parseDataUri('data:text/plain,hello%20world');
    expect(new TextDecoder().decode(parsed.bytes)).toBe('hello world');
  });

  it('rejects non-data URIs', () => {
    expect(() => parseDataUri('https://example.com/x')).toThrow(/data: URI/);
  });
});
