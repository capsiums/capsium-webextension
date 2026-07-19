import { defineConfig } from 'wxt';

/**
 * Sandboxed rendering page for packaged content. MV3 forbids extra script
 * sources (blob:, 'unsafe-inline') in extension_pages CSP, but sandbox
 * pages may customize theirs — packaged scripts execute there, in an
 * opaque origin without extension APIs.
 */
const SANDBOX_CSP = [
  'sandbox allow-scripts allow-forms allow-popups allow-modals',
  "script-src 'self' 'unsafe-inline' blob:",
  "object-src 'self' blob:",
  "style-src 'self' 'unsafe-inline' blob:",
  "img-src 'self' blob: data: https: http:",
  "media-src 'self' blob: data: https: http:",
  "font-src 'self' blob: data:",
  "connect-src https: http:",
  "child-src 'self' blob:",
].join('; ');

/**
 * Firefox MV2 has no manifest sandbox pages (the sandbox.html iframe is
 * sandboxed via the sandbox attribute instead) and only the string CSP
 * form; blob: script sources are allowed but 'unsafe-inline' is not —
 * packaged external scripts run, packaged INLINE scripts are blocked on
 * Firefox (see README).
 */
const FIREFOX_CSP = "script-src 'self' blob:; object-src 'self'";

// See https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: 'src',
  outDir: '.output',
  manifest: ({ browser, manifestVersion }) => {
    const base = {
      name: 'Capsium Viewer',
      version: '0.2.0',
      description: 'Load a .cap Capsium package and render it in the browser.',
    };

    if (browser === 'firefox') {
      // WXT targets Firefox MV2 event pages, where DOMParser is available in
      // the background context (the offscreen document is a Chrome-only path).
      return {
        ...base,
        content_security_policy: FIREFOX_CSP,
        permissions: [
          'storage',
          'alarms',
          'declarativeNetRequest',
          'https://*.cap/*',
        ],
        // MV2 shape: flat resource list. The router page must be loadable
        // through DNR redirects from the synthetic .cap origins.
        web_accessible_resources: ['router.html'],
        browser_specific_settings: {
          gecko: {
            id: 'capsium-viewer@capsium.org',
            strict_min_version: '113.0',
          },
        },
      };
    }

    return {
      ...base,
      manifest_version: manifestVersion,
      minimum_chrome_version: '109',
      content_security_policy: {
        extension_pages: "script-src 'self'; object-src 'self'",
        sandbox: SANDBOX_CSP,
      },
      sandbox: { pages: ['sandbox.html'] },
      permissions: [
        'storage',
        'alarms',
        'declarativeNetRequest',
        'offscreen',
      ],
      host_permissions: ['https://*.cap/*'],
      // DNR redirects to extension resources are followed only when the
      // resource is web-accessible to the request's origin (the .cap host).
      web_accessible_resources: [
        { resources: ['router.html'], matches: ['https://*.cap/*'] },
      ],
    };
  },
});

