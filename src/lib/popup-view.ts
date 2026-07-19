import type { PackageViewInfo } from './messages';

/**
 * Popup rendering. Everything package-controlled is written via textContent
 * / createElement — never innerHTML — so a malicious package cannot inject
 * markup into the extension page (XSS fix).
 */

function el(doc: Document, tag: string, text?: string): HTMLElement {
  const element = doc.createElement(tag);
  if (text !== undefined) element.textContent = text;
  return element;
}

function field(
  doc: Document,
  list: HTMLElement,
  label: string,
  value: string,
): void {
  const dt = el(doc, 'dt', label);
  const dd = el(doc, 'dd', value);
  list.append(dt, dd);
}

export function renderBusy(container: HTMLElement): void {
  const doc = container.ownerDocument;
  container.replaceChildren(el(doc, 'p', 'Loading package…'));
}

export function renderError(container: HTMLElement, message: string): void {
  const doc = container.ownerDocument;
  const box = el(doc, 'div');
  box.className = 'error';
  box.append(el(doc, 'h2', 'Could not open package'), el(doc, 'p', message));
  container.replaceChildren(box);
}

/**
 * Private-key prompt for encrypted packages (§6b). The form is wired up by
 * the popup entrypoint (`#privateKeyForm` / `#privateKeyInput`); `message`
 * carries the background's explanation (key required, or wrong key).
 */
export function renderPrivateKeyPrompt(
  container: HTMLElement,
  message: string,
): void {
  const doc = container.ownerDocument;
  const box = el(doc, 'div');

  box.append(el(doc, 'h2', 'Encrypted package'));
  const note = el(doc, 'p', message);
  if (/wrong|match|corrupt/i.test(message)) note.className = 'error';
  box.append(note);

  const form = el(doc, 'form') as HTMLFormElement;
  form.id = 'privateKeyForm';
  const textarea = el(doc, 'textarea') as HTMLTextAreaElement;
  textarea.id = 'privateKeyInput';
  textarea.rows = 8;
  textarea.placeholder = '-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----';
  textarea.spellcheck = false;
  textarea.setAttribute('aria-label', 'Private key (PEM)');
  const submit = el(doc, 'button', 'Unlock package') as HTMLButtonElement;
  submit.type = 'submit';
  form.append(textarea, submit);
  box.append(form);

  container.replaceChildren(box);
}

export function renderPackageInfo(
  container: HTMLElement,
  info: PackageViewInfo,
  /** Optional problem to surface above the info (e.g. a failed dep add). */
  notice?: string,
): void {
  const doc = container.ownerDocument;
  const box = el(doc, 'div');

  if (notice !== undefined) {
    const alert = el(doc, 'p', notice);
    alert.className = 'error';
    box.append(alert);
  }

  box.append(el(doc, 'h2', 'Package loaded'));

  const summary = el(doc, 'dl');
  field(doc, summary, 'Name', info.name);
  field(doc, summary, 'Version', info.version);
  if (info.description !== undefined)
    field(doc, summary, 'Description', info.description);
  if (info.author !== undefined) field(doc, summary, 'Author', info.author);
  box.append(summary);

  // Mini content-validity view (ARCHITECTURE.md §7).
  const validity = el(doc, 'p');
  validity.className = info.validity.valid ? 'valid' : 'invalid';
  validity.append(
    el(doc, 'strong', info.validity.valid ? 'Valid: yes' : 'Valid: no'),
    doc.createTextNode(` (checked ${info.validity.lastChecked})`),
  );
  box.append(validity);
  if (info.validity.reason !== undefined) {
    box.append(el(doc, 'p', `Reason: ${info.validity.reason}`));
  }
  box.append(
    el(
      doc,
      'p',
      info.checksums === 'verified'
        ? 'Integrity: SHA-256 checksums verified'
        : 'Integrity: no security.json — checksums not available',
    ),
  );
  box.append(
    el(
      doc,
      'p',
      info.signature === 'verified'
        ? 'Signature: RSA-SHA256 verified'
        : 'Signature: package is not signed',
    ),
  );

  const link = el(doc, 'a', info.entryUrl) as HTMLAnchorElement;
  link.href = info.entryUrl;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  const openLine = el(doc, 'p', 'Open: ');
  openLine.append(link);
  box.append(openLine);

  box.append(el(doc, 'h3', `Routes (${info.routes.length})`));
  const list = el(doc, 'ul');
  for (const route of info.routes) {
    list.append(el(doc, 'li', `${route.path} → ${route.target}`));
  }
  box.append(list);

  // Composite packages (§4a): declared dependencies with install status,
  // plus a file input to add the missing ones in this session.
  if (info.dependencies.length > 0) {
    box.append(el(doc, 'h3', `Dependencies (${info.dependencies.length})`));
    const deps = el(doc, 'ul');
    for (const dep of info.dependencies) {
      const status =
        dep.status === 'installed'
          ? `installed (${dep.name ?? '—'}@${dep.version ?? '—'})`
          : 'missing';
      deps.append(el(doc, 'li', `${dep.guid} ${dep.range} — ${status}`));
    }
    box.append(deps);
    if (info.dependencies.some((dep) => dep.status === 'missing')) {
      const label = el(doc, 'label', 'Add dependency .cap: ');
      const depInput = el(doc, 'input') as HTMLInputElement;
      depInput.type = 'file';
      depInput.id = 'depFileInput';
      depInput.accept = '.cap,.zip';
      label.append(depInput);
      box.append(label);
    }
  }

  container.replaceChildren(box);
}
