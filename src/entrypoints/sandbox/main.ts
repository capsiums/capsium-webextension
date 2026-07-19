import { SandboxRenderer } from '../../lib/sandbox-page';
import {
  isSandboxAssetsResultMessage,
  isSandboxServeMessage,
  SANDBOX_ASSETS_TYPE,
  type ResolvedAssetBody,
} from '../../lib/messages';

let requestSeq = 0;
const pendingAssets = new Map<
  string,
  (assets: ResolvedAssetBody[]) => void
>();

const renderer = new SandboxRenderer({
  requestAssets: (capId, urls) =>
    new Promise((resolve) => {
      const requestId = `assets-${++requestSeq}`;
      pendingAssets.set(requestId, resolve);
      window.parent.postMessage(
        { type: SANDBOX_ASSETS_TYPE, requestId, capId, urls },
        '*',
      );
    }),
  blobUrls: {
    create: (blob) => URL.createObjectURL(blob),
    revoke: (url) => URL.revokeObjectURL(url),
  },
  renderDocument: (html) => {
    // Replace the sandbox page's own document: the packaged content runs in
    // this opaque origin, same origin as the minted blob: asset URLs.
    document.open();
    document.write(html);
    document.close();
  },
  renderBlobUrl: (url) => {
    // Non-HTML bytes render natively (images, PDFs, JSON, text, media).
    window.location.href = url;
  },
});

// One serve per page load: the router swaps in a fresh sandbox page for
// every navigation, so this listener is only needed until document.write.
window.addEventListener('message', (event) => {
  if (event.source !== window.parent) return;
  const data: unknown = event.data;
  if (isSandboxServeMessage(data)) {
    void renderer.serve(data);
    return;
  }
  if (isSandboxAssetsResultMessage(data)) {
    pendingAssets.get(data.requestId)?.(data.assets);
    pendingAssets.delete(data.requestId);
  }
});

// Revoke live blob URLs when the sandbox page itself goes away (best
// effort; iframe removal releases the rest).
window.addEventListener('pagehide', () => renderer.dispose());
