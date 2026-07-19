# Chrome Web Store listing — Capsium Viewer

Draft listing content for the Chrome Web Store / Firefox AMO submission.
(Submission itself is a one-click manual step from the developer account.)

## Name

Capsium Viewer

## Summary (132 chars max)

Open and browse Capsium packages (.cap) right in your browser — verified,
self-contained websites and webservices, no server needed.

## Description

Capsium Viewer is a user-side Capsium reactor: it opens `.cap` packages —
the standardized, self-contained, integrity-verified capsules for websites
and simple webservices (CC 62001) — directly in your browser.

- Open any `.cap` file from the toolbar popup; the extension unpacks it,
  verifies every byte against the package's SHA-256 checksums (and its
  RSA-SHA256 signature when present), and serves it locally.
- Encrypted packages supported (AES-256-GCM) — paste the recipient private
  key (PEM) to unlock.
- Multilayer capsules and composite packages (dependencies) supported.
- Basic-auth protected packages supported.
- Everything runs locally. No content is uploaded anywhere.

Capsium is the standardized contract between people who package content and
people who deploy it. Learn more at https://www.capsium.org and try a package
live at https://www.capsium.org/playground/.

## Category

Developer Tools

## Language

English

## Permission justifications (for the review form)

- `storage`: persists package index/metadata so installed packages survive
  browser restarts.
- `declarativeNetRequest`: redirects the synthetic `https://<package>.cap`
  URL space to locally stored, integrity-verified package content.
- `offscreen`: parses and rewrites packaged HTML (relative link resolution)
  in an isolated document.
- `alarms`: expires stored packages after 30 minutes of inactivity.
- `unlimitedStorage`: not requested (binary content is kept in OPFS/Cache,
  not in chrome.storage).
- Host permission `https://*.cap/*`: the extension's serving works by
  intercepting navigation to the synthetic `.cap` host used for installed
  packages; no real hosts are contacted.

## Privacy practices

The extension collects nothing. All processing happens locally; no analytics,
no remote calls, no accounts. Privacy policy: https://www.capsium.org (site
footer) — or state "Does not collect user data" in the dashboard.

## Screenshots (capture before submitting)

1. Popup with a package installed (metadata + integrity badge).
2. A packaged site rendered in the tab (`https://<package>.cap/`).
3. The integrity verification view (per-file checksum results).
4. The encrypted-package unlock (PEM paste) flow.
