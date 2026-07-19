/**
 * Conformance serve harness — the node bridge between the Capsium
 * conformance kit (capsium-conformance) and this extension's reactor core.
 *
 * The kit speaks HTTP to a reactor under test. A user-side (browser)
 * reactor cannot bind a port, so this harness proves the same conformance
 * logic the service worker executes — package loading, SHA-256 integrity,
 * §6a signature and §6b decryption verification, route resolution with
 * §5a layers and §4a composites — by running the REAL CapsiumService from
 * src/lib with in-memory DI ports (the same shape the vitest fakes use)
 * and serving its resolutions over node:http. The browser-only glue (DNR
 * redirect rules, tabs, HTML rewriting, OPFS) is replaced by no-op or
 * in-memory ports and is not what the kit measures.
 *
 * Serving semantics mirror the reference Ruby reactor:
 *  - every route of routes.json answers GET/HEAD (own routes win over
 *    inherited dependency routes), anything else is 404;
 *  - handler routes answer 501 (this reactor does not claim handler-routes);
 *  - dataset routes serve the materialized dataset as application/json
 *    (JSON sources as-is, YAML sources converted);
 *  - non-GET/HEAD methods on a known route or introspection endpoint are 405;
 *  - the §7 monitoring API answers under /api/v1/introspect/*.
 *
 * A package that fails its activation gates (checksum mismatch, bad
 * signature, encrypted without the key, an unsatisfiable declared
 * dependency) exits the process with a non-zero status BEFORE the port
 * opens — the conformance adapter turns that into a StartError.
 *
 * Build with `npm run harness:build` (esbuild bundle -> harness/serve.mjs):
 *
 *   node harness/serve.mjs <package.cap> [--port N] [--store DIR] \
 *     [--decryption-key KEY.pem]
 */
import { createServer, type Server } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

import { CapsiumService } from '../src/lib/background-service';
import { PackageLoader } from '../src/lib/package-loader';
import { PackageStore, type StoredPackageInfo } from '../src/lib/store';
import { DnrRuleManager } from '../src/lib/dnr';
import { isEncryptedPackage } from '../src/lib/encryption';
import { unzipPackage } from '../src/lib/zip';
import { sha256Hex } from '../src/lib/checksums';
import { encodeBase64 } from '../src/lib/base64';
import { parseMetadata } from '../src/lib/model';
import type { Route } from '../src/lib/model';
import type {
  DnrPort,
  FileStorePort,
  HtmlRewriter,
  StorageData,
  StoragePort,
  TabsPort,
} from '../src/lib/ports';

const USAGE =
  'Usage: serve.mjs <package.cap> [--port N] [--store DIR] [--decryption-key KEY.pem]';

const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

const INTROSPECT_METADATA = '/api/v1/introspect/metadata';
const INTROSPECT_ROUTES = '/api/v1/introspect/routes';
const INTROSPECT_CONTENT_HASHES = '/api/v1/introspect/content-hashes';
const INTROSPECT_CONTENT_VALIDITY = '/api/v1/introspect/content-validity';
const INTROSPECTION_PATHS: ReadonlySet<string> = new Set([
  INTROSPECT_METADATA,
  INTROSPECT_ROUTES,
  INTROSPECT_CONTENT_HASHES,
  INTROSPECT_CONTENT_VALIDITY,
]);

/* ------------------------------------------------------------------ */
/* In-memory DI ports (the vitest fakes' shape, browser APIs removed)  */
/* ------------------------------------------------------------------ */

class MemoryStorage implements StoragePort {
  private readonly data = new Map<string, unknown>();

  get(keys: string[]): Promise<StorageData> {
    const out: StorageData = {};
    for (const key of keys) {
      if (this.data.has(key)) out[key] = this.data.get(key);
    }
    return Promise.resolve(out);
  }

  set(items: StorageData): Promise<void> {
    for (const [key, value] of Object.entries(items)) this.data.set(key, value);
    return Promise.resolve();
  }

  remove(keys: string[]): Promise<void> {
    for (const key of keys) this.data.delete(key);
    return Promise.resolve();
  }
}

class MemoryFileStore implements FileStorePort {
  readonly kind = 'opfs' as const;
  private readonly packages = new Map<string, Map<string, Uint8Array>>();

  put(capId: string, path: string, bytes: Uint8Array): Promise<void> {
    let tree = this.packages.get(capId);
    if (tree === undefined) {
      tree = new Map();
      this.packages.set(capId, tree);
    }
    tree.set(path, bytes);
    return Promise.resolve();
  }

  get(capId: string, path: string): Promise<Uint8Array | null> {
    return Promise.resolve(this.packages.get(capId)?.get(path) ?? null);
  }

  removePackage(capId: string): Promise<void> {
    this.packages.delete(capId);
    return Promise.resolve();
  }
}

const noopDnr: DnrPort = {
  updateSessionRules: () => Promise.resolve(),
  getSessionRules: () => Promise.resolve([]),
};

const noopTabs: TabsPort = {
  create: () => Promise.resolve(),
};

/** The kit fetches resources directly; HTML rewriting is browser glue. */
const identityRewriter: HtmlRewriter = {
  rewrite: (html) => Promise.resolve(html),
};

/* ------------------------------------------------------------------ */
/* Minimal semver ranges (dependency resolution from the store)        */
/* ------------------------------------------------------------------ */

type Semver = [number, number, number];

function parseSemver(version: string): Semver | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemver(a: Semver, b: Semver): number {
  for (let index = 0; index < 3; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (left !== right) return left - right;
  }
  return 0;
}

function satisfiesPart(version: Semver, part: string): boolean {
  if (part.startsWith('^')) {
    const base = parseSemver(part.slice(1));
    if (base === null || compareSemver(version, base) < 0) return false;
    if (base[0] > 0) return version[0] === base[0];
    if (base[1] > 0) return version[0] === 0 && version[1] === base[1];
    return version[0] === 0 && version[1] === 0 && version[2] === base[2];
  }
  if (part.startsWith('~')) {
    const base = parseSemver(part.slice(1));
    return (
      base !== null &&
      compareSemver(version, base) >= 0 &&
      version[0] === base[0] &&
      version[1] === base[1]
    );
  }
  const op = /^(>=|<=|>|<|=)?/.exec(part)?.[1] ?? '';
  const base = parseSemver(part.slice(op.length));
  if (base === null) return false;
  const cmp = compareSemver(version, base);
  switch (op) {
    case '>=':
      return cmp >= 0;
    case '<=':
      return cmp <= 0;
    case '>':
      return cmp > 0;
    case '<':
      return cmp < 0;
    default:
      return cmp === 0;
  }
}

/** `*`, exact versions and space/comma-separated comparator conjunctions. */
function satisfiesRange(version: string, range: string): boolean {
  const parsed = parseSemver(version);
  if (parsed === null) return false;
  const trimmed = range.trim();
  if (trimmed === '' || trimmed === '*') return true;
  return trimmed
    .split(/[\s,]+/)
    .filter((part) => part.length > 0)
    .every((part) => satisfiesPart(parsed, part));
}

/* ------------------------------------------------------------------ */
/* Mounted packages (the reactor's view for introspection/routing)     */
/* ------------------------------------------------------------------ */

interface MountedPackage {
  capId: string;
  info: StoredPackageInfo;
  /** SHA-256 of the .cap blob the package was activated from. */
  blobHash: string;
  encrypted: boolean;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function dataUriOf(bytes: Uint8Array): string {
  return `data:application/vnd.capsium.package;base64,${encodeBase64(bytes)}`;
}

/** The URL path a route answers on (remap wins), mirroring the resolver. */
function matchedPath(route: Route): string {
  if ('dataset' in route) return route.path;
  return ('remap' in route ? route.remap : undefined) ?? route.path;
}

function isPrivateRoute(route: Route): boolean {
  return 'visibility' in route && route.visibility === 'private';
}

/** One store candidate: metadata read cheaply straight from the archive. */
interface StoreCandidate {
  path: string;
  guid: string | undefined;
  version: string;
  bytes: Uint8Array;
}

async function readStoreCandidates(
  storeDir: string,
): Promise<StoreCandidate[]> {
  const entries = await readdir(storeDir);
  const candidates: StoreCandidate[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.cap')) continue;
    const path = join(storeDir, entry);
    const bytes = new Uint8Array(await readFile(path));
    try {
      const metadataBytes = unzipPackage(bytes).get('metadata.json');
      if (metadataBytes === undefined) continue;
      const metadata = parseMetadata(JSON.parse(decoder.decode(metadataBytes)));
      candidates.push({
        path,
        guid: metadata.guid,
        version: metadata.version,
        bytes,
      });
    } catch {
      // An unreadable store entry is simply not a candidate.
    }
  }
  return candidates;
}

/** Highest satisfying version first. */
function pickCandidate(
  candidates: StoreCandidate[],
  guid: string,
  range: string,
): StoreCandidate | undefined {
  return candidates
    .filter(
      (candidate) =>
        candidate.guid === guid && satisfiesRange(candidate.version, range),
    )
    .sort((a, b) =>
      compareSemver(
        parseSemver(b.version) ?? [0, 0, 0],
        parseSemver(a.version) ?? [0, 0, 0],
      ),
    )[0];
}

/* ------------------------------------------------------------------ */
/* Dataset materialization (dataset routes serve application/json)     */
/* ------------------------------------------------------------------ */

function materializeDataset(sourcePath: string, bytes: Uint8Array): Uint8Array {
  if (/\.ya?ml$/i.test(sourcePath)) {
    return encoder.encode(JSON.stringify(parseYaml(decoder.decode(bytes))));
  }
  // JSON sources are served as stored.
  return bytes;
}

/* ------------------------------------------------------------------ */
/* The harness itself                                                  */
/* ------------------------------------------------------------------ */

interface HarnessOptions {
  packagePath: string;
  port: number;
  store?: string;
  decryptionKey?: string;
}

function parseArgs(argv: string[]): HarnessOptions {
  const options: HarnessOptions = { packagePath: '', port: 0 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    const value = (): string => {
      const candidate = argv[index + 1];
      if (candidate === undefined || candidate.startsWith('--')) {
        throw new Error(`${arg} requires a value`);
      }
      index += 1;
      return candidate;
    };
    if (arg === '--port') {
      options.port = Number(value());
      if (
        !Number.isInteger(options.port) ||
        options.port < 0 ||
        options.port > 65535
      ) {
        throw new Error('--port must be an integer between 0 and 65535');
      }
    } else if (arg === '--store') {
      options.store = value();
    } else if (arg === '--decryption-key') {
      options.decryptionKey = value();
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option: ${arg}`);
    } else if (options.packagePath !== '') {
      throw new Error(`unexpected extra argument: ${arg}`);
    } else {
      options.packagePath = arg;
    }
  }
  if (options.packagePath === '') {
    throw new Error('missing package path (a .cap archive)');
  }
  return options;
}

class Harness {
  private readonly service: CapsiumService;
  private readonly store: PackageStore;
  private readonly fileStore: MemoryFileStore;
  private capId = '';
  private mounted: MountedPackage[] = [];

  constructor() {
    this.fileStore = new MemoryFileStore();
    const storage = new MemoryStorage();
    this.store = new PackageStore(storage, this.fileStore);
    this.service = new CapsiumService({
      loader: new PackageLoader(),
      store: this.store,
      rules: new DnrRuleManager(noopDnr, storage),
      rewriter: identityRewriter,
      tabs: noopTabs,
      fileStore: this.fileStore,
      routerBaseUrl: 'http://harness.invalid/router.html',
    });
  }

  /**
   * Activate the fixture through the real load/verify/install pipeline;
   * throws (the process exits non-zero) when the reactor rejects it.
   */
  async activate(options: HarnessOptions): Promise<void> {
    const bytes = new Uint8Array(await readFile(options.packagePath));
    const privateKey =
      options.decryptionKey === undefined
        ? undefined
        : await readFile(options.decryptionKey, 'utf8');
    const opened = await this.service.openFromDataUri(
      dataUriOf(bytes),
      privateKey,
    );
    if (!opened.ok) {
      throw new Error(`reactor rejected the package: ${opened.error}`);
    }
    this.capId = opened.info.capId;

    const mounted: MountedPackage[] = [
      {
        capId: this.capId,
        info: await this.mustGetInfo(this.capId),
        blobHash: await sha256Hex(bytes),
        encrypted: isEncryptedPackage(unzipPackage(bytes)),
      },
    ];

    // §4a: declared dependencies resolve from the store and install through
    // the same in-session dependency flow the popup uses.
    const depBlobs = new Map<string, Uint8Array>();
    const declared = opened.info.dependencies;
    if (declared.length > 0 && options.store !== undefined) {
      const candidates = await readStoreCandidates(options.store);
      for (const dependency of declared) {
        const candidate = pickCandidate(
          candidates,
          dependency.guid,
          dependency.range,
        );
        if (candidate === undefined) {
          throw new Error(
            `dependency ${dependency.guid} (${dependency.range}) is not satisfied by the store ${options.store}`,
          );
        }
        const added = await this.service.addDependencyFromDataUri(
          this.capId,
          dataUriOf(candidate.bytes),
        );
        if (!added.ok) {
          throw new Error(
            `dependency ${dependency.guid} rejected: ${added.error}`,
          );
        }
        depBlobs.set(dependency.guid, candidate.bytes);
      }
    }

    // Refresh the mounted set after dependency installs.
    const parentInfo = await this.mustGetInfo(this.capId);
    mounted[0] = { ...mounted[0]!, info: parentInfo };
    for (const [guid, depCapId] of Object.entries(
      parentInfo.dependencies ?? {},
    )) {
      const depInfo = await this.store.getInfo(depCapId);
      const depBytes = depBlobs.get(guid);
      if (depInfo === null || depBytes === undefined) continue;
      mounted.push({
        capId: depCapId,
        info: depInfo,
        blobHash: await sha256Hex(depBytes),
        encrypted: isEncryptedPackage(unzipPackage(depBytes)),
      });
    }
    this.mounted = mounted;
  }

  private async mustGetInfo(capId: string): Promise<StoredPackageInfo> {
    const info = await this.store.getInfo(capId);
    if (info === null) throw new Error(`package ${capId} is not installed`);
    return info;
  }

  /** The route answering a path (own routes first), mirroring the resolver. */
  private matchRoute(pathname: string): Route | null {
    for (const pkg of this.mounted) {
      for (const route of pkg.info.routes.routes) {
        if (pkg !== this.mounted[0] && isPrivateRoute(route)) continue;
        if (matchedPath(route) === pathname) return route;
      }
    }
    return null;
  }

  private introspectionReport(pathname: string): unknown {
    switch (pathname) {
      case INTROSPECT_METADATA:
        return {
          packages: this.mounted.map((pkg) => ({
            name: pkg.info.metadata.name,
            version: pkg.info.metadata.version,
            ...(pkg.info.metadata.author === undefined
              ? {}
              : { author: pkg.info.metadata.author }),
            ...(pkg.info.metadata.description === undefined
              ? {}
              : { description: pkg.info.metadata.description }),
          })),
        };
      case INTROSPECT_ROUTES:
        return {
          routes: this.mounted.map((pkg) => ({
            package: pkg.info.metadata.name,
            routes: pkg.info.routes.routes.map((route) => ({
              method: 'handler' in route ? route.method : 'GET',
              path: route.path,
            })),
          })),
        };
      case INTROSPECT_CONTENT_HASHES:
        return {
          contentHashes: this.mounted.map((pkg) => ({
            package: pkg.info.metadata.name,
            hash: pkg.blobHash,
          })),
        };
      case INTROSPECT_CONTENT_VALIDITY:
        return {
          contentValidity: this.mounted.map((pkg) => {
            const signed = pkg.info.signature === 'verified';
            return {
              package: pkg.info.metadata.name,
              valid: pkg.info.validity.valid,
              lastChecked: pkg.info.validity.lastChecked,
              signed,
              encrypted: pkg.encrypted,
              ...(signed ? { signatureValid: true } : {}),
            };
          }),
        };
      default:
        return null;
    }
  }

  /** node:http request handler. */
  readonly handle = async (
    req: { method?: string; url?: string },
    res: {
      writeHead(status: number, headers: Record<string, string>): void;
      end(body?: Uint8Array | string): void;
    },
  ): Promise<void> => {
    const method = req.method ?? 'GET';
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;

    if (INTROSPECTION_PATHS.has(pathname)) {
      if (!READ_METHODS.has(method)) {
        return this.sendJson(res, 405, {
          error: `method ${method} not allowed for ${pathname}`,
        });
      }
      return this.sendJson(res, 200, this.introspectionReport(pathname));
    }

    const route = this.matchRoute(pathname);
    if (route !== null && !READ_METHODS.has(method)) {
      return this.sendJson(res, 405, {
        error: `method ${method} not allowed for ${pathname}`,
      });
    }
    if (route !== null && 'handler' in route) {
      return this.sendJson(res, 501, {
        error: `handler route not executable by this reactor: ${route.handler}`,
      });
    }

    const [result] = await this.service.resolve(this.capId, [pathname]);
    if (result === undefined || result.kind === 'not-found') {
      return this.sendJson(res, 404, { error: `no route for ${pathname}` });
    }
    if (result.kind === 'locked') {
      return this.sendJson(res, 401, { error: 'authentication required' });
    }

    let body: Uint8Array | null;
    if (result.bodyOverride !== undefined) {
      body = encoder.encode(result.bodyOverride);
    } else {
      body = await this.fileStore.get(result.fileCapId, result.filePath);
    }
    if (body === null) {
      return this.sendJson(res, 404, {
        error: `resource missing from package: ${pathname}`,
      });
    }

    let contentType = result.contentType;
    if (route !== null && 'dataset' in route) {
      body = materializeDataset(result.filePath, body);
      contentType = 'application/json';
    }

    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'Content-Length': String(body.byteLength),
      ...result.responseHeaders,
    };
    res.writeHead(200, headers);
    res.end(method === 'HEAD' ? undefined : body);
  };

  private sendJson(
    res: {
      writeHead(status: number, headers: Record<string, string>): void;
      end(body?: string): void;
    },
    status: number,
    value: unknown,
  ): void {
    const body = JSON.stringify(value);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': String(encoder.encode(body).byteLength),
    });
    res.end(body);
  }
}

async function main(): Promise<Server | null> {
  let options: HarnessOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    process.exitCode = 2;
    return null;
  }

  const harness = new Harness();
  try {
    await harness.activate(options);
  } catch (error) {
    // A conformant rejection (tampered, bad signature, missing key, an
    // unsatisfiable dependency) exits before the port opens; the
    // conformance adapter turns that into a StartError.
    console.error(
      `failed to start: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
    return null;
  }

  const server = createServer((req, res) => {
    harness.handle(req, res).catch((error: unknown) => {
      console.error(
        `request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({ error: 'internal harness error' }));
    });
  });
  server.once('error', (error) => {
    console.error(`failed to start: ${error.message}`);
    process.exitCode = 1;
  });
  await new Promise<void>((resolve) => {
    server.listen(options.port, '127.0.0.1', resolve);
  });

  const address = server.address();
  const port =
    typeof address === 'object' && address !== null ? address.port : 0;
  console.log(`listening on http://127.0.0.1:${port}`);

  const shutdown = (): void => {
    server.close(() => process.exit(0));
    // Do not linger on keep-alive connections when asked to stop.
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return server;
}

await main();
