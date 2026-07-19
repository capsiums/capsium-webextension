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

export function renderPackageInfo(
  container: HTMLElement,
  info: PackageViewInfo,
): void {
  const doc = container.ownerDocument;
  const box = el(doc, 'div');

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

  container.replaceChildren(box);
}
