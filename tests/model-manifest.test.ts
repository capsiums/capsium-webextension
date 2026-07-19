import { describe, expect, it } from 'vitest';
import { generateManifest, parseManifest, ModelError } from '../src/lib/model';

describe('parseManifest', () => {
  it('parses the canonical object form (§3)', () => {
    const manifest = parseManifest({
      resources: {
        'content/index.html': { type: 'text/html', visibility: 'private' },
        'content/styles.css': { type: 'text/css' },
      },
    });
    expect(manifest.resources['content/index.html']).toEqual({
      type: 'text/html',
      visibility: 'private',
    });
    // visibility defaults to exported
    expect(manifest.resources['content/styles.css']?.visibility).toBe(
      'exported',
    );
  });

  it('normalizes the legacy gem form, prefixing content/', () => {
    const manifest = parseManifest({
      content: [
        { file: 'example.css', mime: 'text/css' },
        { file: 'documents/a/doc.pdf', mime: 'application/pdf' },
      ],
    });
    expect(Object.keys(manifest.resources).sort()).toEqual([
      'content/documents/a/doc.pdf',
      'content/example.css',
    ]);
    expect(manifest.resources['content/example.css']?.type).toBe('text/css');
  });

  it('does not double-prefix legacy files already under content/', () => {
    const manifest = parseManifest({
      content: [{ file: 'content/x.html', mime: 'text/html' }],
    });
    expect(Object.keys(manifest.resources)).toEqual(['content/x.html']);
  });

  it('rejects garbage', () => {
    expect(() => parseManifest({ nope: true })).toThrow(ModelError);
  });
});

describe('generateManifest', () => {
  it('scans content/ paths with MIME detection, sorted, exported', () => {
    const manifest = generateManifest([
      'content/b.css',
      'content/a/index.html',
      'content/x.pdf',
    ]);
    expect(Object.keys(manifest.resources)).toEqual([
      'content/a/index.html',
      'content/b.css',
      'content/x.pdf',
    ]);
    expect(manifest.resources['content/a/index.html']).toEqual({
      type: 'text/html',
      visibility: 'exported',
    });
    expect(manifest.resources['content/x.pdf']?.type).toBe('application/pdf');
  });
});
