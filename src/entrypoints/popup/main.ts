import browser from 'webextension-polyfill';
import { OPEN_CAP_ACTION, isOpenCapResponse } from '../../lib/messages';
import {
  renderBusy,
  renderError,
  renderPackageInfo,
} from '../../lib/popup-view';

const input = document.getElementById('capFileInput');
const packageInfo = document.getElementById('packageInfo');

if (
  !(input instanceof HTMLInputElement) ||
  !(packageInfo instanceof HTMLElement)
) {
  throw new Error('popup DOM is missing its expected elements');
}

input.addEventListener('change', () => {
  const file = input.files?.[0];
  if (!file) return;

  if (!/\.(cap|zip)$/i.test(file.name)) {
    renderError(packageInfo, 'Please select a .cap file');
    return;
  }

  renderBusy(packageInfo);
  const reader = new FileReader();
  reader.onload = () => {
    // Message passing is JSON-based; a base64 data: URI is the safe carrier.
    const dataURI = String(reader.result);
    browser.runtime
      .sendMessage({ action: OPEN_CAP_ACTION, dataURI })
      .then((response: unknown) => {
        if (!isOpenCapResponse(response)) {
          renderError(packageInfo, 'No response from the background worker');
          return;
        }
        if (response.ok) {
          renderPackageInfo(packageInfo, response.info);
        } else {
          renderError(packageInfo, response.error);
        }
      })
      .catch((error: unknown) => {
        renderError(
          packageInfo,
          error instanceof Error
            ? error.message
            : 'Failed to contact the background worker',
        );
      });
  };
  reader.onerror = () => renderError(packageInfo, 'Failed to read the file');
  reader.readAsDataURL(file);
});
