import browser from 'webextension-polyfill';
import {
  OPEN_CAP_ACTION,
  ADD_DEPENDENCY_ACTION,
  AUTHENTICATE_ACTION,
  isOpenCapResponse,
  type PackageViewInfo,
} from '../../lib/messages';
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
/** capId of the currently displayed package (for dependency adds, §4a). */
let currentCapId: string | null = null;
/** Last rendered view info (re-rendered with a notice on dep-add errors). */
let lastInfo: PackageViewInfo | null = null;

function container(): HTMLElement {
  return packageInfo as HTMLElement;
}

function openPackage(dataURI: string, privateKey?: string): void {
  browser.runtime
    .sendMessage({ action: OPEN_CAP_ACTION, dataURI, privateKey })
    .then((response: unknown) => handleOpenResponse(response))
    .catch((error: unknown) => {
      renderError(
        container(),
        error instanceof Error
          ? error.message
          : 'Failed to contact the background worker',
      );
    });
}

function showInfo(info: PackageViewInfo): void {
  currentCapId = info.capId;
  lastInfo = info;
  renderPackageInfo(container(), info);
}

function handleOpenResponse(response: unknown): void {
  if (!isOpenCapResponse(response)) {
    renderError(container(), 'No response from the background worker');
    return;
  }
  if (response.ok) {
    pendingDataUri = null;
    showInfo(response.info);
    return;
  }
  if (response.needsPrivateKey === true) {
    // Encrypted package: show the private-key field and resubmit with it.
    renderPrivateKeyPrompt(container(), response.error);
    wirePrivateKeyForm();
    return;
  }
  renderError(container(), response.error);
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
    renderBusy(container());
    openPackage(pendingDataUri, keyInput.value);
  });
}

input.addEventListener('change', () => {
  const file = input.files?.[0];
  if (!file) return;

  if (!/\.(cap|zip)$/i.test(file.name)) {
    renderError(container(), 'Please select a .cap file');
    return;
  }

  renderBusy(container());
  const reader = new FileReader();
  reader.onload = () => {
    // Message passing is JSON-based; a base64 data: URI is the safe carrier.
    pendingDataUri = String(reader.result);
    openPackage(pendingDataUri);
  };
  reader.onerror = () => renderError(container(), 'Failed to read the file');
  reader.readAsDataURL(file);
});

// Basic-auth form is rendered dynamically (§4b) — delegate the submit event.
packageInfo.addEventListener('submit', (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || form.id !== 'authForm') return;
  event.preventDefault();
  if (currentCapId === null) return;

  const user = document.getElementById('authUser');
  const pass = document.getElementById('authPass');
  if (
    !(user instanceof HTMLInputElement) ||
    !(pass instanceof HTMLInputElement)
  ) {
    return;
  }

  const capId = currentCapId;
  renderBusy(container());
  browser.runtime
    .sendMessage({
      action: AUTHENTICATE_ACTION,
      capId,
      username: user.value,
      password: pass.value,
    })
    .then((response: unknown) => {
      if (!isOpenCapResponse(response)) {
        renderError(container(), 'No response from the background worker');
        return;
      }
      if (response.ok) {
        showInfo(response.info);
      } else if (lastInfo !== null) {
        renderPackageInfo(container(), lastInfo, response.error);
      } else {
        renderError(container(), response.error);
      }
    })
    .catch((error: unknown) => {
      renderError(
        container(),
        error instanceof Error
          ? error.message
          : 'Failed to contact the background worker',
      );
    });
});

// Dependency file input is rendered dynamically (§4a) — delegate the event.
packageInfo.addEventListener('change', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || target.id !== 'depFileInput') {
    return;
  }
  const file = target.files?.[0];
  if (!file || currentCapId === null) return;
  if (!/\.(cap|zip)$/i.test(file.name)) {
    if (lastInfo !== null) {
      renderPackageInfo(container(), lastInfo, 'Please select a .cap file');
    }
    return;
  }

  const parentCapId = currentCapId;
  renderBusy(container());
  const reader = new FileReader();
  reader.onload = () => {
    browser.runtime
      .sendMessage({
        action: ADD_DEPENDENCY_ACTION,
        parentCapId,
        dataURI: String(reader.result),
      })
      .then((response: unknown) => {
        if (!isOpenCapResponse(response)) {
          renderError(container(), 'No response from the background worker');
          return;
        }
        if (response.ok) {
          showInfo(response.info);
        } else if (lastInfo !== null) {
          renderPackageInfo(container(), lastInfo, response.error);
        } else {
          renderError(container(), response.error);
        }
      })
      .catch((error: unknown) => {
        renderError(
          container(),
          error instanceof Error
            ? error.message
            : 'Failed to contact the background worker',
        );
      });
  };
  reader.onerror = () => {
    if (lastInfo !== null) {
      renderPackageInfo(container(), lastInfo, 'Failed to read the file');
    }
  };
  reader.readAsDataURL(file);
});
