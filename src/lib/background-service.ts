import { PackageLoader, PackageError, type LoadedPackage } from './package-loader';
import { PackageStore, type PreparedFile } from './store';
import { DnrRuleManager, type RuleSpec } from './dnr';
import { baseUrlForResource } from './html-rewrite';
import { parseDataUri, encodeBase64 } from './base64';
import type { HtmlRewriter, TabsPort } from './ports';
import type { RoutesFile, StorageFile } from './model';
import type { OpenCapResponse, PackageViewInfo, RouteView } from './messages';

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
 * Build DNR redirect specs from the (normalized) routes of a package.
 * Handler routes are accepted but not served (execution is deferred;
 * reactors respond 501).
 */
export function buildRuleSpecs(
  routes: RoutesFile,
  files: Map<string, { contentType: string; base64: string }>,
  storage: StorageFile | null,
): RuleSpec[] {
  const specs: RuleSpec[] = [];
  for (const route of routes.routes) {
    if ('resource' in route) {
      const file = files.get(route.resource);
      if (!file) {
        throw new Error(
          `Route ${route.path} references missing resource ${route.resource}`,
        );
      }
      specs.push({
        path: route.path,
        dataUri: `data:${file.contentType};base64,${file.base64}`,
      });
    } else if ('dataset' in route) {
      const dataSet = storage?.storage.dataSets[route.dataset];
      const source = dataSet?.source ?? dataSet?.databaseFile;
      if (source === undefined) {
        throw new Error(
          `Route ${route.path} references unknown dataset "${route.dataset}"`,
        );
      }
      const file = files.get(source);
      if (!file) {
        throw new Error(
          `Dataset "${route.dataset}" source file ${source} not found`,
        );
      }
      specs.push({
        path: route.path,
        dataUri: `data:${file.contentType};base64,${file.base64}`,
      });
    }
  }
  return specs;
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
        routes: pkg.routes,
        storage: pkg.storage,
        files: prepared.map((file) => file.path),
        validity: pkg.validity,
        checksums: pkg.checksums,
      },
      prepared,
    );

    try {
      const specs = buildRuleSpecs(
        pkg.routes,
        new Map(prepared.map((file) => [file.path, file])),
        pkg.storage,
      );
      await this.rules.installPackageRules(capId, specs);
    } catch (error) {
      // Roll back storage so a half-installed package never leaks.
      await this.store.removePackage(capId);
      throw error;
    }

    await this.tabs.create({ url: `https://${capId}.cap/` });
    return capId;
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
        const rewritten = await this.rewriter.rewrite(
          html,
          baseUrlForResource(capId, file.path),
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
    const expired = index
      .filter((entry) => now - entry.timeAdded > this.maxAgeMs)
      .map((entry) => entry.capId);
    for (const capId of expired) {
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
      const files = new Map<string, { contentType: string; base64: string }>();
      for (const path of info.files) {
        const file = await this.store.getFile(capId, path);
        if (file) files.set(path, file);
      }
      const specs = buildRuleSpecs(info.routes, files, info.storage);
      await this.rules.installPackageRules(capId, specs);
    }
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
    };
  }
}

function toRouteView(route: RoutesFile['routes'][number]): RouteView {
  if ('resource' in route) return { path: route.path, target: route.resource };
  if ('dataset' in route)
    return { path: route.path, target: `dataset:${route.dataset}` };
  return { path: route.path, target: `${route.method} ${route.handler}` };
}
