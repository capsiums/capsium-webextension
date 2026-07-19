/**
 * MIME type detection (by extension) and text/binary classification.
 * Used when auto-generating manifests (§3) and when deciding whether a
 * resource can be decoded as UTF-8 text. JavaScript is `text/javascript`
 * per RFC 9239.
 */

const EXTENSION_TO_MIME: Record<string, string> = {
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  json: 'application/json',
  map: 'application/json',
  txt: 'text/plain',
  md: 'text/markdown',
  adoc: 'text/plain',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  xml: 'application/xml',
  rxl: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
  webm: 'video/webm',
  wasm: 'application/wasm',
  zip: 'application/zip',
  cap: 'application/vnd.capsium.package',
  doc: 'application/msword',
  err: 'application/octet-stream',
};

export function detectMimeType(path: string): string {
  const name = path.split('/').pop() ?? path;
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return 'application/octet-stream';
  const ext = name.slice(dot + 1).toLowerCase();
  return EXTENSION_TO_MIME[ext] ?? 'application/octet-stream';
}

/**
 * True when the MIME type denotes UTF-8-decodable text content.
 * Everything else must be treated as opaque bytes.
 */
export function isTextMime(mime: string): boolean {
  const base = mime.split(';')[0]?.trim().toLowerCase() ?? '';
  return (
    base.startsWith('text/') ||
    base === 'application/json' ||
    base.endsWith('+json') ||
    base === 'application/javascript' ||
    base === 'application/x-javascript' ||
    base === 'application/xml' ||
    base.endsWith('+xml') ||
    base === 'application/yaml' ||
    base === 'image/svg+xml'
  );
}
