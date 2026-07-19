import { describe, expect, it } from 'vitest';
import {
  DnrRuleManager,
  REGISTRY_KEY,
  buildRules,
  escapeRegex,
  type RuleSpec,
} from '../src/lib/dnr';
import { FakeDnr, FakeStorage } from './helpers/fakes';

const CAP_A = '11111111-1111-4111-8111-111111111111';
const CAP_B = '22222222-2222-4222-8222-222222222222';

const specs = (prefix: string): RuleSpec[] => [
  { path: '/', dataUri: `data:text/html;base64,${prefix}0` },
  { path: '/index', dataUri: `data:text/html;base64,${prefix}1` },
  { path: '/assets/a.b+1.png', dataUri: `data:image/png;base64,${prefix}2` },
];

describe('buildRules', () => {
  it('is deterministic per capId and namespaces rule IDs per package', () => {
    const a1 = buildRules(CAP_A, specs('QQ'), 0);
    const a2 = buildRules(CAP_A, specs('QQ'), 0);
    expect(a1.map((rule) => rule.id)).toEqual(a2.map((rule) => rule.id));

    const b = buildRules(CAP_B, specs('Qg'), 0);
    const aIds = new Set(a1.map((rule) => rule.id));
    expect(b.some((rule) => aIds.has(rule.id))).toBe(false);
    expect(a1.every((rule) => rule.id >= 1)).toBe(true);
  });

  it('anchors the regexFilter so /index cannot shadow /index.html', () => {
    const [root, index, asset] = buildRules(CAP_A, specs('QQ'), 0);
    expect(root?.condition.regexFilter).toBe(
      `^https://${CAP_A}\\.cap/(\\?.*)?$`,
    );
    expect(index?.condition.regexFilter).toBe(
      `^https://${CAP_A}\\.cap/index(\\?.*)?$`,
    );
    // dots and pluses in paths are escaped
    expect(asset?.condition.regexFilter).toContain('/assets/a\\.b\\+1\\.png');
    const re = new RegExp(index?.condition.regexFilter ?? '');
    expect(re.test(`https://${CAP_A}.cap/index`)).toBe(true);
    expect(re.test(`https://${CAP_A}.cap/index.html`)).toBe(false);
    expect(re.test(`https://${CAP_A}.cap/index?x=1`)).toBe(true);
  });

  it('redirects to the data: URI', () => {
    const [root] = buildRules(CAP_A, specs('QQ'), 0);
    expect(root?.action.type).toBe('redirect');
    if (root?.action.type === 'redirect') {
      expect(root.action.redirect.url).toBe('data:text/html;base64,QQ0');
    }
  });
});

describe('DnrRuleManager', () => {
  it('two packages never clobber each other and are removed independently', async () => {
    const dnr = new FakeDnr();
    const manager = new DnrRuleManager(dnr, new FakeStorage());

    const aIds = await manager.installPackageRules(CAP_A, specs('QQ'));
    const bIds = await manager.installPackageRules(CAP_B, specs('Qg'));
    expect(aIds.some((id) => bIds.includes(id))).toBe(false);
    expect(dnr.rules.size).toBe(aIds.length + bIds.length);

    await manager.removePackageRules(CAP_A);
    expect([...dnr.rules.keys()].sort()).toEqual(
      [...bIds].sort((x, y) => x - y),
    );

    await manager.removePackageRules(CAP_B);
    expect(dnr.rules.size).toBe(0);
  });

  it('reinstall replaces a package’s rules atomically (old IDs removed first)', async () => {
    const dnr = new FakeDnr();
    const manager = new DnrRuleManager(dnr, new FakeStorage());
    const first = await manager.installPackageRules(CAP_A, specs('QQ'));
    const second = await manager.installPackageRules(CAP_A, specs('eQ'));
    expect(second).toEqual(first); // same deterministic block
    expect(dnr.rules.size).toBe(first.length);
    const action = dnr.rules.get(first[0] ?? 0)?.action;
    expect(action?.type).toBe('redirect');
    if (action?.type === 'redirect') {
      expect(action.redirect.url).toBe('data:text/html;base64,eQ0');
    }
  });

  it('moves to a fresh block on collision with another installed package', async () => {
    const storage = new FakeStorage();
    const dnr = new FakeDnr();
    const manager = new DnrRuleManager(dnr, storage);
    const aIds = await manager.installPackageRules(CAP_A, specs('QQ'));

    // Forge a registry where CAP_B already owns CAP_A's deterministic block.
    await storage.set({ [REGISTRY_KEY]: { [CAP_B]: aIds } });
    const aIds2 = await manager.installPackageRules(CAP_A, specs('QQ'));
    expect(aIds2.some((id) => aIds.includes(id))).toBe(false);
    expect(dnr.rules.size).toBe(aIds.length + aIds2.length);
  });

  it('reconcile prunes uninstalled packages and reports missing session rules', async () => {
    const dnr = new FakeDnr();
    const manager = new DnrRuleManager(dnr, new FakeStorage());
    await manager.installPackageRules(CAP_A, specs('QQ'));
    await manager.installPackageRules(CAP_B, specs('Qg'));

    // CAP_B uninstalled; CAP_A lost its session rules (browser restart).
    dnr.clear();
    const missing = await manager.reconcile([CAP_A]);
    expect(missing).toEqual([CAP_A]);
    expect(await manager.ruleIdsFor(CAP_B)).toEqual([]);
    expect(dnr.rules.size).toBe(0);
  });
});

describe('escapeRegex', () => {
  it('escapes all regex metacharacters', () => {
    expect(escapeRegex('a.b*c+d?e^f$g{h}i(j)k[l]m\\n|o')).toBe(
      'a\\.b\\*c\\+d\\?e\\^f\\$g\\{h\\}i\\(j\\)k\\[l\\]m\\\\n\\|o',
    );
  });
});
