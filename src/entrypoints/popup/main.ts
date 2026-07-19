import browser from 'webextension-polyfill';
import { OPEN_CAP_ACTION, isOpenCapResponse } from '../../lib/messages';
import {
  renderBusy,
  renderError,
  renderPackageInfo,
  renderPrivateKeyPrompt,
} from '../../lib/popup-view';

const input = document.getElementById('capFileInput');
const packageInfo = document.getElementById('packageInfo');

if (
  !(input instanceof HTMLInputElement) ||
  !(packageInfo instanceof HTMLElement)
) {
  throw new Error('popup DOM is missing its expected elements');
}

/** data: URI of the package being opened (kept for the key-prompt retry). */
let pendingDataUri: string | null = null;

function openPackage(dataURI: string, privateKey?: string): void {
  browser.runtime
    .sendMessage({ action: OPEN_CAP_ACTION, dataURI, privateKey })
    .then((response: unknown) => handleResponse(response))
    .catch((error: unknown) => {
      renderError(
        packageInfo as HTMLElement,
        error instanceof Error
          ? error.message
          : 'Failed to contact the background worker',
      );
    });
}

function handleResponse(response: unknown): void {
  const container = packageInfo as HTMLElement;
  if (!isOpenCapResponse(response)) {
    renderError(container, 'No response from the background worker');
    return;
  }
  if (response.ok) {
    pendingDataUri = null;
    renderPackageInfo(container, response.info);
    return;
  }
  if (response.needsPrivateKey === true) {
    // Encrypted package: show the private-key field and resubmit with it.
    renderPrivateKeyPrompt(container, response.error);
    wirePrivateKeyForm();
    return;
  }
  renderError(container, response.error);
}

function wirePrivateKeyForm(): void {
  const form = document.getElementById('privateKeyForm');
  const keyInput = document.getElementById('privateKeyInput');
  if (
    !(form instanceof HTMLFormElement) ||
    !(keyInput instanceof HTMLTextAreaElement)
  ) {
    return;
  }
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (pendingDataUri === null) return;
    renderBusy(packageInfo as HTMLElement);
    openPackage(pendingDataUri, keyInput.value);
  });
}

input.addEventListener('change', () => {
  const file = input.files?.[0];
  if (!file) return;

  if (!/\.(cap|zip)$/i.test(file.name)) {
    renderError(packageInfo as HTMLElement, 'Please select a .cap file');
    return;
  }

  renderBusy(packageInfo as HTMLElement);
  const reader = new FileReader();
  reader.onload = () => {
    // Message passing is JSON-based; a base64 data: URI is the safe carrier.
    pendingDataUri = String(reader.result);
    openPackage(pendingDataUri);
  };
  reader.onerror = () =>
    renderError(packageInfo as HTMLElement, 'Failed to read the file');
  reader.readAsDataURL(file);
});
