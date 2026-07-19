import { PackageLoader, PackageError, type LoadedPackage } from './package-loader';
import {
  PackageStore,
  type PreparedFile,
  type StoredPackageInfo,
} from './store';
import { DnrRuleManager, type RuleSpec } from './dnr';
import { baseUrlForResource } from './html-rewrite';
import { parseDataUri, encodeBase64, decodeBase64 } from './base64';
import { mergedPathFor } from './layers';
import {
  authorizationHeaderSpec,
  buildCompositeRuleSpecs,
  buildOwnRuleSpecs,
  lockRuleSpecs,
  type InstalledDependencyView,
  type ServingFiles,
} from './serving';
import { verifyHtpasswd } from './auth/htpasswd';
import { DEFAULT_BASIC_REALM, type AuthenticationFile } from './model';
import type { HtmlRewriter, TabsPort } from './ports';
import type { RoutesFile, StorageFile } from './model';
import type {
  DependencyViewInfo,
  OpenCapResponse,
  PackageViewInfo,
  RouteView,
} from './messages';

export const DEFAULT_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes, as before
export const SWEEP_ALARM_NAME = 'capsium.sweep';

export interface CapsiumServiceDeps {
  loader: PackageLoader;
  store: PackageStore;
  rules: DnrRuleManager;
  rewriter: HtmlRewriter;
  tabs: TabsPort;
  now?: () => number;
  maxAgeMs?: number;
}

/**
 * Build DNR redirect specs from the (normalized) routes of a package
 * (single-package view; composite serving lives in lib/serving.ts).
 * Handler routes are accepted but not served (execution is deferred;
 * reactors respond 501). With layered storage, routes whose resource
 * resolves tombstoned/not-found are skipped (serving them would be a 404).
 */
export function buildRuleSpecs(
  routes: RoutesFile,
  files: Map<string, { contentType: string; base64: string }>,
  storage: StorageFile | null,
  tombstones: Record<string, string[]> = {},
): RuleSpec[] {
  return buildOwnRuleSpecs({ routes, storage, tombstones, files });
}

/**
 * Orchestrates the whole lifecycle: load -> rewrite HTML -> store -> install
 * DNR rules -> open the package tab; plus expiry sweeps and session-rule
 * recovery after a browser restart.
 */
export class CapsiumService {
  private readonly loader: PackageLoader;
  private readonly store: PackageStore;
  private readonly rules: DnrRuleManager;
  private readonly rewriter: HtmlRewriter;
  private readonly tabs: TabsPort;
  private readonly now: () => number;
  private readonly maxAgeMs: number;
  /** Verified basic-auth credentials per package (§4b) — session-only. */
  private readonly sessions = new Map<
    string,
    { username: string; password: string }
  >();

  constructor(deps: CapsiumServiceDeps) {
    this.loader = deps.loader;
    this.store = deps.store;
    this.rules = deps.rules;
    this.rewriter = deps.rewriter;
    this.tabs = deps.tabs;
    this.now = deps.now ?? Date.now;
    this.maxAgeMs = deps.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  }

  /** Popup entry point: open a .cap file handed over as a data: URI. */
  async openFromDataUri(
    dataUri: string,
    privateKey?: string,
  ): Promise<OpenCapResponse> {
    try {
      const { bytes } = parseDataUri(dataUri);
      const pkg = await this.loader.load(bytes, { privateKey });
      const capId = await this.installAndOpen(pkg);
      return { ok: true, info: this.toViewInfo(pkg, capId) };
    } catch (error) {
      if (error instanceof PackageError && error.code === 'encryption') {
        // Encrypted package without (or with a wrong) key: the popup shows
        // its private-key field and retries with the pasted PEM.
        return { ok: false, error: error.message, needsPrivateKey: true };
      }
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async installAndOpen(pkg: LoadedPackage): Promise<string> {
    const capId = crypto.randomUUID();
    const prepared = await this.prepareFiles(capId, pkg);

    await this.store.install(
      capId,
      {
        metadata: pkg.metadata,
        manifest: pkg.manifest,
        routes: pkg.routes,
        storage: pkg.storage,
        files: prepared.map((file) => file.path),
        validity: pkg.validity,
        checksums: pkg.checksums,
        signature: pkg.signature,
        tombstones: pkg.tombstones,
        dependencies: {},
        authentication: pkg.authentication,
      },
      prepared,
    );

    try {
      await this.rebuildRules(capId);
    } catch (error) {
      // Roll back storage so a half-installed package never leaks.
      await this.store.removePackage(capId);
      throw error;
    }

    await this.tabs.create({ url: `https://${capId}.cap/` });
    return capId;
  }

  /**
   * Popup entry point (§4a): install a dependency .cap for an already-open
   * composite package. The dependency's guid must be declared in the
   * dependent's metadata; its exported content then serves as a lower
   * read-only layer under the dependent's URL space.
   */
  async addDependencyFromDataUri(
    parentCapId: string,
    dataUri: string,
    privateKey?: string,
  ): Promise<OpenCapResponse> {
    try {
      const parentInfo = await this.store.getInfo(parentCapId);
      if (!parentInfo) {
        return {
          ok: false,
          error: 'The package is no longer installed — open it again first',
        };
      }
      const { bytes } = parseDataUri(dataUri);
      const pkg = await this.loader.load(bytes, { privateKey });
      const guid = pkg.metadata.guid;
      if (guid === undefined || !(guid in parentInfo.metadata.dependencies)) {
        return {
          ok: false,
          error: `"${pkg.metadata.name}" (guid ${guid ?? '—'}) is not a declared dependency of "${parentInfo.metadata.name}"`,
        };
      }

      const depCapId = crypto.randomUUID();
      // HTML is rewritten against the PARENT origin: the dependency's
      // content lives in the dependent's URL space.
      const prepared = await this.prepareFiles(parentCapId, pkg);
      await this.store.install(
        depCapId,
        {
          metadata: pkg.metadata,
          manifest: pkg.manifest,
          routes: pkg.routes,
          storage: pkg.storage,
          files: prepared.map((file) => file.path),
          validity: pkg.validity,
          checksums: pkg.checksums,
          signature: pkg.signature,
          tombstones: pkg.tombstones,
          dependencyOf: { parent: parentCapId, guid },
          authentication: pkg.authentication,
        },
        prepared,
      );

      const previous = parentInfo.dependencies ?? {};
      parentInfo.dependencies = { ...previous, [guid]: depCapId };
      await this.store.updateInfo(parentCapId, parentInfo);
      try {
        await this.rebuildRules(parentCapId);
      } catch (error) {
        // Roll back: drop the dependency and restore the parent record.
        await this.store.removePackage(depCapId);
        parentInfo.dependencies = previous;
        await this.store.updateInfo(parentCapId, parentInfo);
        throw error;
      }

      return { ok: true, info: await this.viewInfoFromStored(parentCapId) };
    } catch (error) {
      if (error instanceof PackageError && error.code === 'encryption') {
        return { ok: false, error: error.message, needsPrivateKey: true };
      }
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Rewrite HTML files against their own in-package directory, then base64-encode. */
  private async prepareFiles(
    capId: string,
    pkg: LoadedPackage,
  ): Promise<PreparedFile[]> {
    const prepared: PreparedFile[] = [];
    for (const file of pkg.files) {
      let bytes = file.bytes;
      if (file.isText && file.contentType === 'text/html') {
        const html = new TextDecoder().decode(file.bytes);
        // With layers the stored path is raw (<layer>/content/x.html) but
        // the served URL uses the merged view (content/x.html).
        const merged = mergedPathFor(pkg.storage, file.path) ?? file.path;
        const rewritten = await this.rewriter.rewrite(
          html,
          baseUrlForResource(capId, merged),
        );
        bytes = new TextEncoder().encode(rewritten);
      }
      prepared.push({
        path: file.path,
        contentType: file.contentType,
        base64: encodeBase64(bytes),
      });
    }
    return prepared;
  }

  /** Remove packages older than maxAgeMs — both their storage AND their DNR rules. */
  async sweepExpired(): Promise<string[]> {
    const now = this.now();
    const index = await this.store.listIndex();
    const expired: string[] = [];
    for (const entry of index) {
      if (now - entry.timeAdded <= this.maxAgeMs) continue;
      const info = await this.store.getInfo(entry.capId);
      // Dependencies expire only together with their dependent package.
      if (info?.dependencyOf !== undefined) continue;
      expired.push(entry.capId);
    }
    const removed = new Set<string>(expired);
    for (const capId of expired) {
      const info = await this.store.getInfo(capId);
      for (const depCapId of Object.values(info?.dependencies ?? {})) {
        removed.add(depCapId);
      }
    }
    for (const capId of removed) {
      this.sessions.delete(capId);
      await this.rules.removePackageRules(capId);
      await this.store.removePackage(capId);
    }
    return expired;
  }

  /**
   * Service-worker startup: sweep expired packages, prune orphaned rules,
   * and rebuild session rules that vanished (session rules do not survive a
   * browser restart; storage does).
   */
  async onStartup(): Promise<void> {
    await this.sweepExpired();
    const index = await this.store.listIndex();
    const missing = await this.rules.reconcile(
      index.map((entry) => entry.capId),
    );
    for (const capId of missing) {
      const info = await this.store.getInfo(capId);
      if (!info) {
        await this.rules.removePackageRules(capId);
        continue;
      }
      // Dependencies have no rules of their own; they serve under the
      // dependent's origin and are covered by its rebuild.
      if (info.dependencyOf !== undefined) continue;
      await this.rebuildRules(capId);
    }
  }

  /** Read all stored files of a package into a serving map. */
  private async loadFiles(
    capId: string,
    paths: string[],
  ): Promise<ServingFiles> {
    const files: ServingFiles = new Map();
    for (const path of paths) {
      const file = await this.store.getFile(capId, path);
      if (file) files.set(path, file);
    }
    return files;
  }

  /** Installed dependencies of a package as serving views (§4a). */
  private async dependencyServingViews(
    info: StoredPackageInfo,
  ): Promise<InstalledDependencyView[]> {
    const views: InstalledDependencyView[] = [];
    for (const [guid, depCapId] of Object.entries(info.dependencies ?? {})) {
      const depInfo = await this.store.getInfo(depCapId);
      if (!depInfo) continue;
      views.push({
        guid,
        manifest: depInfo.manifest ?? { resources: {} },
        routes: depInfo.routes,
        storage: depInfo.storage,
        tombstones: depInfo.tombstones ?? {},
        files: await this.loadFiles(depCapId, depInfo.files),
        filePaths: depInfo.files,
      });
    }
    return views;
  }

  /**
   * (Re)build a package's DNR rules: its own routes plus inherited
   * dependency routes (§4a), gated on basic auth (§4b) — locked (401 body
   * everywhere) until credentials verify in this session, afterwards the
   * Authorization header is attached package-wide.
   */
  private async rebuildRules(capId: string): Promise<void> {
    const info = await this.store.getInfo(capId);
    if (!info) throw new Error(`Package ${capId} is not installed`);
    let specs = buildCompositeRuleSpecs(
      {
        routes: info.routes,
        storage: info.storage,
        tombstones: info.tombstones ?? {},
        files: await this.loadFiles(capId, info.files),
      },
      await this.dependencyServingViews(info),
    );
    const basicAuth = info.authentication?.authentication.basicAuth;
    if (basicAuth?.enabled === true) {
      const credentials = this.sessions.get(capId);
      if (credentials === undefined) {
        specs = lockRuleSpecs(specs);
      } else {
        specs.push(authorizationHeaderSpec(credentials));
      }
    }
    await this.rules.installPackageRules(capId, specs);
  }

  /**
   * Popup entry point (§4b): verify basic-auth credentials against the
   * package's htpasswd file, once per session. On success the package's
   * rules unlock and its tab reopens; on failure the 401 body keeps being
   * served.
   */
  async authenticate(
    capId: string,
    username: string,
    password: string,
  ): Promise<OpenCapResponse> {
    try {
      const info = await this.store.getInfo(capId);
      const basicAuth = info?.authentication?.authentication.basicAuth;
      if (!info || basicAuth?.enabled !== true) {
        return { ok: false, error: 'This package does not require basic auth' };
      }
      const htpasswdFile = await this.store.getFile(capId, basicAuth.passwdFile);
      if (!htpasswdFile) {
        return {
          ok: false,
          error: `basicAuth passwdFile "${basicAuth.passwdFile}" is not stored`,
        };
      }
      const result = await verifyHtpasswd(
        new TextDecoder().decode(decodeBase64(htpasswdFile.base64)),
        username,
        password,
      );
      if (result.kind === 'unsupported-hash') {
        return {
          ok: false,
          error: `Unsupported htpasswd hash type "${result.hashType}" (supported: bcrypt, apr1)`,
        };
      }
      if (result.kind !== 'ok') {
        return { ok: false, error: 'Invalid username or password' };
      }
      this.sessions.set(capId, { username, password });
      await this.rebuildRules(capId);
      await this.tabs.create({ url: `https://${capId}.cap/` });
      return { ok: true, info: await this.viewInfoFromStored(capId) };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** View info rebuilt from storage (after dependency changes). */
  private async viewInfoFromStored(capId: string): Promise<PackageViewInfo> {
    const info = await this.store.getInfo(capId);
    if (!info) throw new Error(`Package ${capId} is not installed`);
    return {
      capId,
      name: info.metadata.name,
      version: info.metadata.version,
      ...(info.metadata.description !== undefined
        ? { description: info.metadata.description }
        : {}),
      ...(info.metadata.author !== undefined
        ? { author: info.metadata.author }
        : {}),
      entryUrl: `https://${capId}.cap/`,
      routes: info.routes.routes.map(toRouteView),
      validity: info.validity,
      checksums: info.checksums,
      signature: info.signature ?? 'absent',
      dependencies: await this.dependencyStatuses(info),
      ...authenticationSpread(info.authentication, this.sessions.has(capId)),
    };
  }

  /** Popup dependency list: every declared guid with its install status. */
  private async dependencyStatuses(
    info: StoredPackageInfo,
  ): Promise<DependencyViewInfo[]> {
    return Promise.all(
      Object.entries(info.metadata.dependencies).map(async ([guid, range]) => {
        const depCapId = info.dependencies?.[guid];
        const depInfo = depCapId
          ? await this.store.getInfo(depCapId)
          : null;
        return depInfo
          ? {
              guid,
              range,
              status: 'installed' as const,
              name: depInfo.metadata.name,
              version: depInfo.metadata.version,
            }
          : { guid, range, status: 'missing' as const };
      }),
    );
  }

  private toViewInfo(pkg: LoadedPackage, capId: string): PackageViewInfo {
    return {
      capId,
      name: pkg.metadata.name,
      version: pkg.metadata.version,
      ...(pkg.metadata.description !== undefined
        ? { description: pkg.metadata.description }
        : {}),
      ...(pkg.metadata.author !== undefined
        ? { author: pkg.metadata.author }
        : {}),
      entryUrl: `https://${capId}.cap/`,
      routes: pkg.routes.routes.map(toRouteView),
      validity: pkg.validity,
      checksums: pkg.checksums,
      signature: pkg.signature,
      // Just opened: declared dependencies are all still missing.
      dependencies: Object.entries(pkg.metadata.dependencies).map(
        ([guid, range]) => ({ guid, range, status: 'missing' as const }),
      ),
      ...authenticationSpread(pkg.authentication, false),
    };
  }
}

function toRouteView(route: RoutesFile['routes'][number]): RouteView {
  if ('resource' in route) return { path: route.path, target: route.resource };
  if ('dataset' in route)
    return { path: route.path, target: `dataset:${route.dataset}` };
  return { path: route.path, target: `${route.method} ${route.handler}` };
}

/** Popup auth view (§4b): present only when basicAuth is enabled. */
function authenticationSpread(
  authentication: AuthenticationFile | null | undefined,
  authenticated: boolean,
): Pick<PackageViewInfo, 'authentication'> {
  const basic = authentication?.authentication.basicAuth;
  if (basic?.enabled !== true) return {};
  return {
    authentication: {
      basicAuth: true,
      realm: basic.realm ?? DEFAULT_BASIC_REALM,
      authenticated,
    },
  };
}
