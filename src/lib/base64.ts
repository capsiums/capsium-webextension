/**
 * Dependency-free base64 <-> bytes conversion and data: URI handling.
 * Works identically in the service worker, offscreen documents, popup and
 * Node (tests) — no atob/btoa/Buffer assumptions.
 */

const ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const REVERSE = new Map<string, number>(
  [...ALPHABET].map((char, index) => [char, index]),
);

export function encodeBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] as number;
    const b1 = i + 1 < bytes.length ? (bytes[i + 1] as number) : 0;
    const b2 = i + 2 < bytes.length ? (bytes[i + 2] as number) : 0;
    const triplet = (b0 << 16) | (b1 << 8) | b2;
    out += ALPHABET[(triplet >> 18) & 0x3f];
    out += ALPHABET[(triplet >> 12) & 0x3f];
    out += i + 1 < bytes.length ? ALPHABET[(triplet >> 6) & 0x3f] : '=';
    out += i + 2 < bytes.length ? ALPHABET[triplet & 0x3f] : '=';
  }
  return out;
}

export function decodeBase64(base64: string): Uint8Array {
  const clean = base64.replace(/[\r\n\s]/g, '');
  if (clean.length % 4 !== 0) throw new Error('Invalid base64 length');
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  const bytes = new Uint8Array((clean.length / 4) * 3 - padding);
  let out = 0;
  for (let i = 0; i < clean.length; i += 4) {
    let triplet = 0;
    for (let j = 0; j < 4; j += 1) {
      const char = clean[i + j] as string;
      const value =
        j >= 4 - padding && i + 4 >= clean.length ? 0 : REVERSE.get(char);
      if (value === undefined)
        throw new Error(`Invalid base64 character: ${char}`);
      triplet = (triplet << 6) | value;
    }
    if (out < bytes.length) bytes[out++] = (triplet >> 16) & 0xff;
    if (out < bytes.length) bytes[out++] = (triplet >> 8) & 0xff;
    if (out < bytes.length) bytes[out++] = triplet & 0xff;
  }
  return bytes;
}

export function toDataUri(contentType: string, bytes: Uint8Array): string {
  return `data:${contentType};base64,${encodeBase64(bytes)}`;
}

export interface ParsedDataUri {
  contentType: string;
  bytes: Uint8Array;
}

/** Parse a data: URI. Supports base64 payloads (FileReader output) and percent-encoded plain payloads. */
export function parseDataUri(uri: string): ParsedDataUri {
  const match = /^data:([^,]*?),(.*)$/s.exec(uri);
  if (!match) throw new Error('Not a data: URI');
  const meta = match[1] as string;
  const payload = match[2] as string;
  const contentType = meta.replace(/;base64$/i, '') || 'text/plain';
  if (/;base64$/i.test(meta))
    return { contentType, bytes: decodeBase64(payload) };
  return {
    contentType,
    bytes: new TextEncoder().encode(decodeURIComponent(payload)),
  };
}
