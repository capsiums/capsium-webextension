import browser from 'webextension-polyfill';
import {
  handleSandboxMessage,
  runRouter,
  UNAUTHORIZED_BODY,
  type RouterPorts,
} from '../../lib/router-page';
import {
  CacheFileStore,
  CACHE_NAME,
  OpfsFileStore,
  type OpfsDirectoryLike,
} from '../../lib/file-store';
import {
  isResolveResponse,
  OPEN_TAB_ACTION,
  RESOLVE_REQUEST_TYPE,
  type ResolveResult,
  type SandboxServeMessage,
} from '../../lib/messages';
import type { FileStorePort } from '../../lib/ports';

const ROUTER_BASE_URL = browser.runtime.getURL('/router.html');

const frame = document.getElementById('sandbox');
const statusDiv = document.getElementById('status');
if (!(frame instanceof HTMLIFrameElement) || statusDiv === null) {
  throw new Error('router DOM is missing its expected elements');
}
const sandboxFrame = frame;
const status = statusDiv;

function showStatus(kind: string, text: string): void {
  status.dataset['kind'] = kind;
  status.textContent = text;
  status.style.display = 'block';
  sandboxFrame.style.display = 'none';
}

function showFrame(): void {
  status.style.display = 'none';
  sandboxFrame.style.display = 'block';
}

function postToSandbox(message: unknown): void {
  sandboxFrame.contentWindow?.postMessage(message, '*');
}

/**
 * Each serve gets a FRESH sandbox page (its window listeners die with the
 * packaged document it document.writes itself into, and its blob: URLs are
 * released): reload the frame, then hand over the serve message.
 */
let serveSeq = 0;
function serveInFreshSandbox(message: SandboxServeMessage): void {
  showFrame();
  serveSeq += 1;
  const expected = serveSeq;
  sandboxFrame.addEventListener(
    'load',
    () => {
      if (expected === serveSeq) postToSandbox(message);
    },
    { once: true },
  );
  sandboxFrame.src = `/sandbox.html?serve=${expected}`;
}

/* File-store backends, created on first use (the resolution names which). */
const stores: Partial<Record<'opfs' | 'cache', FileStorePort>> = {};
async function storeFor(kind: 'opfs' | 'cache'): Promise<FileStorePort> {
  const existing = stores[kind];
  if (existing !== undefined) return existing;
  const created =
    kind === 'opfs'
      ? await OpfsFileStore.create(
          () =>
            navigator.storage.getDirectory() as unknown as Promise<OpfsDirectoryLike>,
        )
      : new CacheFileStore(await caches.open(CACHE_NAME));
  stores[kind] = created;
  return created;
}

const ports: RouterPorts = {
  async resolve(capId, paths): Promise<ResolveResult[]> {
    const response: unknown = await browser.runtime.sendMessage({
      type: RESOLVE_REQUEST_TYPE,
      capId,
      paths,
    });
    if (!isResolveResponse(response)) {
      throw new Error('No resolution from the background worker');
    }
    return response.results;
  },
  fileStoreFor: storeFor,
  async openTab(url) {
    await browser.runtime.sendMessage({ action: OPEN_TAB_ACTION, url });
  },
  serve: serveInFreshSandbox,
  answerAssets: postToSandbox,
  answerFetch: postToSandbox,
  renderLocked() {
    showStatus('locked', UNAUTHORIZED_BODY);
  },
  renderNotFound(capId, path) {
    showStatus(
      'not-found',
      `404 — no such package resource:\nhttps://${capId}.cap${path}`,
    );
  },
  renderError(message) {
    showStatus('error', message);
  },
  navigate(hash) {
    location.hash = hash; // the hashchange listener re-serves
  },
};

/*
 * Messages from the sandbox page: asset batches (pre-render) and, after the
 * page has document.written itself into the packaged document, fetch/XHR
 * bridge + navigation messages from the packaged shim — the window is the
 * same, so both arrive here.
 */
window.addEventListener('message', (event) => {
  if (event.source !== sandboxFrame.contentWindow) return;
  void handleSandboxMessage(ports, ROUTER_BASE_URL, event.data);
});

window.addEventListener('hashchange', () => void runRouter(ports, location.hash));
void runRouter(ports, location.hash);
