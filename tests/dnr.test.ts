import { describe, expect, it } from 'vitest';
import {
  DnrRuleManager,
  REGISTRY_KEY,
  basicAuthorizationHeader,
  buildPackageRules,
  escapeRegex,
} from '../src/lib/dnr';
import { decodeBase64 } from '../src/lib/base64';
import { FakeDnr, FakeStorage } from './helpers/fakes';

const CAP_A = '11111111-1111-4111-8111-111111111111';
const CAP_B = '22222222-2222-4222-8222-222222222222';
const ROUTER = 'chrome-extension://ext-id/router.html';

const options = (authorization?: string) => ({
  routerBaseUrl: ROUTER,
  ...(authorization === undefined ? {} : { authorization }),
});

describe('buildPackageRules', () => {
  it('emits exactly ONE redirect rule per package', () => {
    const rules = buildPackageRules(CAP_A, options(), 0);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.action.type).toBe('redirect');
  });

  it('redirects every package URL to the router page, path in the fragment', () => {
    const [rule] = buildPackageRules(CAP_A, options(), 0);
    if (rule?.action.type !== 'redirect') throw new Error('expected redirect');
    expect(rule.action.redirect.regexSubstitution).toBe(
      `${ROUTER}#/serve/${CAP_A}\\1`,
    );
    // The regex captures the URL path as group 1.
    const re = new RegExp(rule.condition.regexFilter);
    const match = re.exec(`https://${CAP_A}.cap/assets/app.js`);
    expect(match?.[1]).toBe('/assets/app.js');
    expect(re.exec(`https://${CAP_A}.cap/`)?.[1]).toBe('/');
    expect(re.exec(`https://${CAP_A}.cap`)?.[1]).toBeUndefined();
  });

  it('is deterministic per capId and namespaces rule IDs per package', () => {
    const a1 = buildPackageRules(CAP_A, options(), 0);
    const a2 = buildPackageRules(CAP_A, options(), 0);
    expect(a1.map((rule) => rule.id)).toEqual(a2.map((rule) => rule.id));

    const b = buildPackageRules(CAP_B, options(), 0);
    const aIds = new Set(a1.map((rule) => rule.id));
    expect(b.some((rule) => aIds.has(rule.id))).toBe(false);
    expect(a1.every((rule) => rule.id >= 1)).toBe(true);
  });

  it('does not match other packages’ origins', () => {
    const [rule] = buildPackageRules(CAP_A, options(), 0);
    const re = new RegExp(rule?.condition.regexFilter ?? '');
    expect(re.test(`https://${CAP_B}.cap/`)).toBe(false);
  });

  it('adds the Authorization modifyHeaders rule when authorized (§4b)', () => {
    const authorization = basicAuthorizationHeader({
      username: 'alice',
      password: 'swordfish',
    });
    const rules = buildPackageRules(CAP_A, options(authorization), 0);
    expect(rules).toHaveLength(2);
    const headerRule = rules[1];
    expect(headerRule?.action.type).toBe('modifyHeaders');
    if (headerRule?.action.type === 'modifyHeaders') {
      expect(headerRule.action.requestHeaders).toEqual([
        { header: 'Authorization', operation: 'set', value: authorization },
      ]);
    }
  });
});

describe('basicAuthorizationHeader (§4b)', () => {
  it('encodes credentials as a Basic token', () => {
    const header = basicAuthorizationHeader({
      username: 'alice',
      password: 'swordfish',
    });
    expect(header.startsWith('Basic ')).toBe(true);
    expect(new TextDecoder().decode(decodeBase64(header.slice(6)))).toBe(
      'alice:swordfish',
    );
  });
});

describe('DnrRuleManager', () => {
  it('two packages never clobber each other and are removed independently', async () => {
    const dnr = new FakeDnr();
    const manager = new DnrRuleManager(dnr, new FakeStorage());

    const aIds = await manager.installPackageRules(CAP_A, options());
    const bIds = await manager.installPackageRules(CAP_B, options());
    expect(aIds).toHaveLength(1);
    expect(bIds).toHaveLength(1);
    expect(aIds.some((id) => bIds.includes(id))).toBe(false);
    expect(dnr.rules.size).toBe(2);

    await manager.removePackageRules(CAP_A);
    expect([...dnr.rules.keys()]).toEqual(bIds);

    await manager.removePackageRules(CAP_B);
    expect(dnr.rules.size).toBe(0);
  });

  it('reinstall replaces a package’s rules atomically (old IDs removed first)', async () => {
    const dnr = new FakeDnr();
    const manager = new DnrRuleManager(dnr, new FakeStorage());
    const first = await manager.installPackageRules(CAP_A, options());
    const second = await manager.installPackageRules(
      CAP_A,
      options('Basic dGVzdA=='),
    );
    expect(second).not.toEqual(first); // auth rule added: 2 IDs now
    expect(second[0]).toBe(first[0]); // same deterministic block start
    expect(dnr.rules.size).toBe(2);
    const action = dnr.rules.get(second[0] ?? 0)?.action;
    expect(action?.type).toBe('redirect');
  });

  it('moves to a fresh block on collision with another installed package', async () => {
    const storage = new FakeStorage();
    const dnr = new FakeDnr();
    const manager = new DnrRuleManager(dnr, storage);
    const aIds = await manager.installPackageRules(CAP_A, options());

    // Forge a registry where CAP_B already owns CAP_A's deterministic block.
    await storage.set({ [REGISTRY_KEY]: { [CAP_B]: aIds } });
    const aIds2 = await manager.installPackageRules(CAP_A, options());
    expect(aIds2.some((id) => aIds.includes(id))).toBe(false);
    expect(dnr.rules.size).toBe(aIds.length + aIds2.length);
  });

  it('reconcile prunes uninstalled packages and reports missing session rules', async () => {
    const dnr = new FakeDnr();
    const manager = new DnrRuleManager(dnr, new FakeStorage());
    await manager.installPackageRules(CAP_A, options());
    await manager.installPackageRules(CAP_B, options());

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
