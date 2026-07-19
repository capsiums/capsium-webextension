import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: 'src',
  outDir: '.output',
  manifest: ({ browser, manifestVersion }) => {
    const base = {
      name: 'Capsium Viewer',
      version: '1.0.0',
      description: 'Load a .cap Capsium package and render it in the browser.',
      content_security_policy: {
        extension_pages: "script-src 'self'; object-src 'self'",
      },
    };

    if (browser === 'firefox') {
      // WXT targets Firefox MV2 event pages, where DOMParser is available in
      // the background context (the offscreen document is a Chrome-only path).
      return {
        ...base,
        permissions: [
          'storage',
          'unlimitedStorage',
          'alarms',
          'declarativeNetRequest',
          'https://*.cap/*',
        ],
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
      permissions: [
        'storage',
        'unlimitedStorage',
        'alarms',
        'declarativeNetRequest',
        'offscreen',
      ],
      host_permissions: ['https://*.cap/*'],
    };
  },
});
