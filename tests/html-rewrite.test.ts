// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
  baseUrlForResource,
  resolvePackageUrl,
  rewriteHtmlUrls,
} from '../src/lib/html-rewrite';
import { DirectHtmlRewriter } from '../src/lib/offscreen-rewriter';

const CAP = 'abc-123';
const NESTED_BASE = `https://${CAP}.cap/documents/report/`;

describe('baseUrlForResource', () => {
  it('maps package paths to the URL-space directory of the file', () => {
    expect(baseUrlForResource(CAP, 'content/documents/report/doc.html')).toBe(
      NESTED_BASE,
    );
    expect(baseUrlForResource(CAP, 'content/index.html')).toBe(
      `https://${CAP}.cap/`,
    );
  });
});

describe('resolvePackageUrl', () => {
  it('resolves relative refs against the file’s own directory (bug #4)', () => {
    expect(resolvePackageUrl('image.png', NESTED_BASE)).toBe(
      `https://${CAP}.cap/documents/report/image.png`,
    );
    expect(resolvePackageUrl('../shared/x.css', NESTED_BASE)).toBe(
      `https://${CAP}.cap/documents/shared/x.css`,
    );
  });

  it('resolves package-absolute refs against the origin', () => {
    expect(resolvePackageUrl('/styles.css', NESTED_BASE)).toBe(
      `https://${CAP}.cap/styles.css`,
    );
  });

  it.each([
    '#fragment',
    '',
    'https://cdn.example.com/x.js',
    'http://example.com/x',
    'data:image/png;base64,AA',
    'mailto:a@b.c',
    '//cdn.example.com/x.js',
  ])('leaves %s untouched', (ref) => {
    expect(resolvePackageUrl(ref, NESTED_BASE)).toBeNull();
  });
});

describe('rewriteHtmlUrls', () => {
  it('rewrites link/script/img/a against the file’s directory, not the parser document', () => {
    const html =
      '<html><head><link rel="stylesheet" href="styles.css" />' +
      '<script src="js/app.js"></script></head>' +
      '<body><img src="./img/p.png" /><a href="other.html">go</a>' +
      '<a href="#local">frag</a><a href="https://example.com/x">ext</a></body></html>';
    const out = rewriteHtmlUrls(html, NESTED_BASE);
    expect(out).toContain(
      `href="https://${CAP}.cap/documents/report/styles.css"`,
    );
    expect(out).toContain(
      `src="https://${CAP}.cap/documents/report/js/app.js"`,
    );
    expect(out).toContain(
      `src="https://${CAP}.cap/documents/report/img/p.png"`,
    );
    expect(out).toContain(
      `href="https://${CAP}.cap/documents/report/other.html"`,
    );
    expect(out).toContain('href="#local"');
    expect(out).toContain('href="https://example.com/x"');
    expect(out.startsWith('<!DOCTYPE html>')).toBe(true);
  });

  it('DirectHtmlRewriter rewrites synchronously where DOMParser exists', async () => {
    const out = await new DirectHtmlRewriter().rewrite(
      '<html><body><a href="a.html">a</a></body></html>',
      NESTED_BASE,
    );
    expect(out).toContain(`href="https://${CAP}.cap/documents/report/a.html"`);
  });
});
