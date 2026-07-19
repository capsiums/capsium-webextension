/**
 * HTML URL rewriting for package content.
 *
 * Relative and package-absolute URLs in served HTML must point at the
 * package's synthetic origin (https://<capId>.cap). Resolution happens
 * against the URL-space directory OF THE FILE BEING REWRITTEN — the baseUrl
 * argument — never against the parser document's own location.
 *
 * Pure apart from the global DOMParser: available in offscreen documents,
 * Firefox event pages, and happy-dom (tests).
 */

const REWRITE_TARGETS: ReadonlyArray<
  readonly [selector: string, attribute: string]
> = [
  ['link[rel="stylesheet"][href]', 'href'],
  ['script[src]', 'src'],
  ['img[src]', 'src'],
  ['a[href]', 'href'],
];

const ABSOLUTE_URL = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * Resolve an in-document reference against the package base URL.
 * Returns null when the reference must be left untouched (external URLs,
 * protocol-relative URLs, fragments, empty refs).
 */
export function resolvePackageUrl(ref: string, baseUrl: string): string | null {
  const trimmed = ref.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return null;
  if (ABSOLUTE_URL.test(trimmed) || trimmed.startsWith('//')) return null;
  return new URL(trimmed, baseUrl).href;
}

/**
 * Rewrite relative URLs in an HTML document. `baseUrl` is the URL-space
 * directory of the file, e.g. "https://<capId>.cap/documents/report/".
 */
export function rewriteHtmlUrls(html: string, baseUrl: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const [selector, attribute] of REWRITE_TARGETS) {
    for (const element of doc.querySelectorAll(selector)) {
      const ref = element.getAttribute(attribute);
      if (ref === null) continue;
      const resolved = resolvePackageUrl(ref, baseUrl);
      if (resolved !== null) element.setAttribute(attribute, resolved);
    }
  }
  return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`;
}

/** URL-space directory (with trailing slash) for a package-relative file path. */
export function baseUrlForResource(
  capId: string,
  resourcePath: string,
): string {
  const urlPath = resourcePath.startsWith('content/')
    ? `/${resourcePath.slice('content/'.length)}`
    : `/${resourcePath}`;
  const dir = urlPath.slice(0, urlPath.lastIndexOf('/') + 1);
  return `https://${capId}.cap${dir}`;
}
