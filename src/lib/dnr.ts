import type { DnrPort, DnrRule, StoragePort } from './ports';

/**
 * declarativeNetRequest session-rule management.
 *
 * Rule IDs are namespaced per package: a deterministic block of IDs is
 * derived from the capId (FNV-1a hash), so two packages can never clobber
 * each other's rules, and every package's rules are added/removed atomically
 * (one updateSessionRules call per package). The capId -> ruleIds mapping
 * persists in storage so rules can be removed when a package expires — the
 * original bug (IDs restarting at 1 + blanket removal) is gone.
 */

export const REGISTRY_KEY = 'capsium.dnr.registry';

const MAX_RULE_ID = 2_147_483_647; // 2^31 - 1 (Chrome rule IDs are int32 >= 1)
export const RULE_BLOCK_SIZE = 2048;
const BLOCK_COUNT = Math.floor(MAX_RULE_ID / RULE_BLOCK_SIZE);
const MAX_SALT = 32;

export const RULE_RESOURCE_TYPES = [
  'main_frame',
  'sub_frame',
  'stylesheet',
  'script',
  'image',
  'font',
  'media',
  'xmlhttprequest',
  'other',
] as const;

/** One served route: package URL path -> data: URI target (+ optional headers). */
export interface RuleSpec {
  path: string;
  dataUri: string;
  /** DNR priority (higher wins when several rules match); default 1. */
  priority?: number;
  /** Request headers attached via a companion modifyHeaders rule (§4a). */
  requestHeaders?: Record<string, string>;
  /** Response headers attached via a companion modifyHeaders rule (§4a). */
  responseHeaders?: Record<string, string>;
  /** Match every URL under `path` (default: exact anchored match). */
  prefixMatch?: boolean;
  /** Emit only the modifyHeaders companion, no redirect (§4b auth header). */
  headersOnly?: boolean;
}

/** 32-bit FNV-1a — stable across sessions, good enough for block placement. */
export function hashCapId(capId: string, salt: number): number {
  let hash = 0x811c9dc5;
  const text = `${capId}#${salt}`;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** First rule ID of the package's deterministic block. */
export function ruleBlockStart(capId: string, salt: number): number {
  return (hashCapId(capId, salt) % BLOCK_COUNT) * RULE_BLOCK_SIZE + 1;
}

export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build the session rules for a package. The regexFilter is fully anchored,
 * so `/index` can never shadow `/index.html` (the original substring
 * urlFilter over-matched). Specs carrying headers (§4a route inheritance)
 * additionally emit a companion modifyHeaders rule.
 */
export function buildRules(
  capId: string,
  specs: RuleSpec[],
  salt = 0,
): DnrRule[] {
  const rules: DnrRule[] = [];
  let nextId = ruleBlockStart(capId, salt);
  for (const spec of specs) {
    const condition = {
      regexFilter: spec.prefixMatch === true
        ? `^https://${escapeRegex(capId)}\\.cap${escapeRegex(spec.path)}`
        : `^https://${escapeRegex(capId)}\\.cap${escapeRegex(spec.path)}(\\?.*)?$`,
      resourceTypes: [...RULE_RESOURCE_TYPES],
    };
    if (spec.headersOnly !== true) {
      rules.push({
        id: nextId,
        priority: spec.priority ?? 1,
        action: { type: 'redirect', redirect: { url: spec.dataUri } },
        condition,
      });
      nextId += 1;
    }
    if (spec.requestHeaders !== undefined || spec.responseHeaders !== undefined) {
      rules.push({
        id: nextId,
        priority: spec.priority ?? 1,
        action: {
          type: 'modifyHeaders',
          ...(spec.requestHeaders === undefined
            ? {}
            : {
                requestHeaders: Object.entries(spec.requestHeaders).map(
                  ([header, value]) => ({ header, operation: 'set' as const, value }),
                ),
              }),
          ...(spec.responseHeaders === undefined
            ? {}
            : {
                responseHeaders: Object.entries(spec.responseHeaders).map(
                  ([header, value]) => ({ header, operation: 'set' as const, value }),
                ),
              }),
        },
        condition,
      });
      nextId += 1;
    }
  }
  if (rules.length > RULE_BLOCK_SIZE) {
    throw new Error(
      `Package needs ${rules.length} rules; the maximum is ${RULE_BLOCK_SIZE}`,
    );
  }
  return rules;
}

export class DnrRuleManager {
  constructor(
    private readonly dnr: DnrPort,
    private readonly storage: StoragePort,
  ) {}

  private async readRegistry(): Promise<Record<string, number[]>> {
    const data = await this.storage.get([REGISTRY_KEY]);
    const raw = data[REGISTRY_KEY];
    if (typeof raw !== 'object' || raw === null) return {};
    return raw as Record<string, number[]>;
  }

  private async writeRegistry(
    registry: Record<string, number[]>,
  ): Promise<void> {
    await this.storage.set({ [REGISTRY_KEY]: registry });
  }

  /**
   * Atomically replace a package's rules: any previous rules for this
   * package are removed and the new ones added in a single
   * updateSessionRules call. Other packages are never touched; if the
   * deterministic block collides with another installed package, the block
   * is re-salted until it is free.
   */
  async installPackageRules(
    capId: string,
    specs: RuleSpec[],
  ): Promise<number[]> {
    const registry = await this.readRegistry();
    const foreignIds = new Set(
      Object.entries(registry)
        .filter(([id]) => id !== capId)
        .flatMap(([, ids]) => ids),
    );

    let salt = 0;
    let rules = buildRules(capId, specs, salt);
    while (rules.some((rule) => foreignIds.has(rule.id))) {
      salt += 1;
      if (salt > MAX_SALT)
        throw new Error('Could not allocate a free DNR rule ID block');
      rules = buildRules(capId, specs, salt);
    }

    const ruleIds = rules.map((rule) => rule.id);
    const removeRuleIds = [
      ...new Set([...(registry[capId] ?? []), ...ruleIds]),
    ];
    await this.dnr.updateSessionRules({ removeRuleIds, addRules: rules });

    registry[capId] = ruleIds;
    await this.writeRegistry(registry);
    return ruleIds;
  }

  /** Remove all of a package's rules (e.g. when it expires). */
  async removePackageRules(capId: string): Promise<void> {
    const registry = await this.readRegistry();
    const ids = registry[capId] ?? [];
    if (ids.length > 0)
      await this.dnr.updateSessionRules({ removeRuleIds: ids });
    if (capId in registry) {
      delete registry[capId];
      await this.writeRegistry(registry);
    }
  }

  async ruleIdsFor(capId: string): Promise<number[]> {
    return (await this.readRegistry())[capId] ?? [];
  }

  /**
   * Prune rules of packages that are no longer installed, then return the
   * installed capIds whose session rules are (partially) missing — e.g.
   * after a browser restart cleared session rules but not storage.
   */
  async reconcile(validCapIds: string[]): Promise<string[]> {
    const registry = await this.readRegistry();
    const valid = new Set(validCapIds);

    let changed = false;
    for (const capId of Object.keys(registry)) {
      if (valid.has(capId)) continue;
      await this.dnr.updateSessionRules({
        removeRuleIds: registry[capId] ?? [],
      });
      delete registry[capId];
      changed = true;
    }
    if (changed) await this.writeRegistry(registry);

    const sessionIds = new Set(
      (await this.dnr.getSessionRules()).map((rule) => rule.id),
    );
    return validCapIds.filter((capId) => {
      const ids = registry[capId] ?? [];
      return ids.length === 0 || ids.some((id) => !sessionIds.has(id));
    });
  }
}
