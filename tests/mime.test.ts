import { describe, expect, it } from 'vitest';
import { detectMimeType, isTextMime } from '../src/lib/mime';

describe('detectMimeType', () => {
  it.each([
    ['content/index.html', 'text/html'],
    ['content/app.JS', 'text/javascript'], // RFC 9239, case-insensitive
    ['content/styles.css', 'text/css'],
    ['data/animals.json', 'application/json'],
    ['content/a/pixel.png', 'image/png'],
    ['content/doc.pdf', 'application/pdf'],
    ['content/documents.xml', 'application/xml'],
    ['content/font.woff2', 'font/woff2'],
    ['content/blob.zip', 'application/zip'],
    ['content/file.unknownext', 'application/octet-stream'],
    ['content/noext', 'application/octet-stream'],
  ])('%s -> %s', (path, mime) => {
    expect(detectMimeType(path)).toBe(mime);
  });
});

describe('isTextMime', () => {
  it.each([
    'text/html',
    'text/css',
    'text/plain; charset=utf-8',
    'application/json',
    'application/ld+json',
    'application/javascript',
    'application/xml',
    'image/svg+xml',
    'application/yaml',
  ])('treats %s as text', (mime) => {
    expect(isTextMime(mime)).toBe(true);
  });

  it.each([
    'application/pdf',
    'image/png',
    'font/woff2',
    'application/octet-stream',
    'application/zip',
  ])('treats %s as binary', (mime) => {
    expect(isTextMime(mime)).toBe(false);
  });
});
