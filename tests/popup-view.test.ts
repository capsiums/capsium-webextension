// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
  renderError,
  renderPackageInfo,
  renderPrivateKeyPrompt,
} from '../src/lib/popup-view';
import type { PackageViewInfo } from '../src/lib/messages';

const XSS =
  '<img src=x onerror="globalThis.__pwned = 1"><script>globalThis.__pwned2 = 1</script>';

function makeInfo(overrides: Partial<PackageViewInfo> = {}): PackageViewInfo {
  return {
    capId: 'cap-1',
    name: XSS,
    version: '1.0.0',
    description: XSS,
    author: 'Mallory',
    entryUrl: 'https://cap-1.cap/',
    routes: [{ path: '/', target: XSS }],
    validity: {
      package: `${XSS}@1.0.0`,
      valid: true,
      lastChecked: '2026-07-18T00:00:00.000Z',
    },
    checksums: 'verified',
    signature: 'verified',
    ...overrides,
  };
}

describe('popup rendering (XSS fix, bug #5)', () => {
  it('renders package-controlled strings as text, never markup', () => {
    const container = document.createElement('div');
    renderPackageInfo(container, makeInfo());

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain(XSS); // escaped, visible as text
    expect((globalThis as Record<string, unknown>)['__pwned']).toBeUndefined();
    expect((globalThis as Record<string, unknown>)['__pwned2']).toBeUndefined();
  });

  it('shows the mini content-validity view (§7)', () => {
    const container = document.createElement('div');
    renderPackageInfo(container, makeInfo());
    expect(container.textContent).toContain('Valid: yes');
    expect(container.textContent).toContain('checked 2026-07-18T00:00:00.000Z');
    expect(container.textContent).toContain('SHA-256 checksums verified');

    const absent = document.createElement('div');
    renderPackageInfo(absent, makeInfo({ checksums: 'absent' }));
    expect(absent.textContent).toContain('no security.json');
  });

  it('shows the signature verification status (§6a)', () => {
    const signed = document.createElement('div');
    renderPackageInfo(signed, makeInfo({ signature: 'verified' }));
    expect(signed.textContent).toContain('RSA-SHA256 verified');

    const unsigned = document.createElement('div');
    renderPackageInfo(unsigned, makeInfo({ signature: 'absent' }));
    expect(unsigned.textContent).toContain('not signed');
  });

  it('renderError escapes too', () => {
    const container = document.createElement('div');
    renderError(container, XSS);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain(XSS);
  });

  it('renderPrivateKeyPrompt shows the key form with the message, XSS-safe', () => {
    const container = document.createElement('div');
    renderPrivateKeyPrompt(container, `Encrypted — key needed ${XSS}`);
    expect(container.querySelector('form')).not.toBeNull();
    expect(container.querySelector('textarea')).not.toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('Encrypted — key needed');
  });
});
