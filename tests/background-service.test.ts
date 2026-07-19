import { describe, expect, it } from 'vitest';
import { CapsiumService, buildRuleSpecs } from '../src/lib/background-service';
import { PackageLoader } from '../src/lib/package-loader';
import { PackageStore } from '../src/lib/store';
import { DnrRuleManager } from '../src/lib/dnr';
import { encodeBase64 } from '../src/lib/base64';
import { fixtureBytes } from './helpers/fixtures';
import { FakeDnr, FakeRewriter, FakeStorage, FakeTabs } from './helpers/fakes';

function makeService(now: () => number = Date.now, maxAgeMs = 30 * 60 * 1000) {
  const storage = new FakeStorage();
  const dnr = new FakeDnr();
  const tabs = new FakeTabs();
  const rewriter = new FakeRewriter();
  const service = new CapsiumService({
    loader: new PackageLoader(),
    store: new PackageStore(storage, now),
    rules: new DnrRuleManager(dnr, storage),
    rewriter,
    tabs,
    now,
    maxAgeMs,
  });
  return { service, storage, dnr, tabs, rewriter };
}

function bareFixtureDataUri(): string {
  return `data:application/vnd.capsium.package;base64,${encodeBase64(fixtureBytes('bare_package-0.1.0.cap'))}`;
}

describe('buildRuleSpecs', () => {
  it('maps static and dataset routes to data: URIs, skipping handler routes', () => {
    const specs = buildRuleSpecs(
      {
        routes: [
          { path: '/', resource: 'content/index.html' },
          { path: '/api/v1/data/animals', dataset: 'animals' },
          { path: '/compute', method: 'POST', handler: 'h.js' },
        ],
      },
      new Map([
        ['content/index.html', { contentType: 'text/html', base64: 'QQ' }],
        [
          'data/animals.json',
          { contentType: 'application/json', base64: 'Qg' },
        ],
      ]),
      { storage: { dataSets: { animals: { source: 'data/animals.json' } } } },
    );
    expect(specs).toEqual([
      { path: '/', dataUri: 'data:text/html;base64,QQ' },
      {
        path: '/api/v1/data/animals',
        dataUri: 'data:application/json;base64,Qg',
      },
    ]);
  });

  it('throws on a route referencing a missing resource', () => {
    expect(() =>
      buildRuleSpecs(
        { routes: [{ path: '/', resource: 'content/ghost.html' }] },
        new Map(),
        null,
      ),
    ).toThrow(/missing resource/);
  });
});

describe('CapsiumService.openFromDataUri', () => {
  it('happy path: rewrites HTML, stores, installs rules, opens the tab', async () => {
    const { service, storage, dnr, tabs, rewriter } = makeService();
    const response = await service.openFromDataUri(bareFixtureDataUri());

    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.info.name).toBe('bare_package');
    expect(response.info.routes.length).toBe(5);
    expect(response.info.entryUrl).toMatch(/^https:\/\/[0-9a-f-]+\.cap\/$/);

    // HTML was rewritten with the file's own directory as base.
    expect(rewriter.calls).toHaveLength(1);
    expect(rewriter.calls[0]?.baseUrl).toBe(
      `https://${response.info.capId}.cap/`,
    );

    // One rule per route, all for this package only.
    expect(dnr.rules.size).toBe(5);
    expect(tabs.created).toEqual([response.info.entryUrl]);
    expect(
      (await new PackageStore(storage).listIndex()).map((e) => e.capId),
    ).toEqual([response.info.capId]);
  });

  it('two packages coexist without rule or storage clobbering', async () => {
    const { service, storage, dnr } = makeService();
    const first = await service.openFromDataUri(bareFixtureDataUri());
    const second = await service.openFromDataUri(bareFixtureDataUri());
    if (!first.ok || !second.ok) throw new Error('load failed');
    expect(first.info.capId).not.toBe(second.info.capId);
    expect(dnr.rules.size).toBe(10);
    expect(await new PackageStore(storage).listIndex()).toHaveLength(2);
  });

  it('rolls back storage when rule installation fails', async () => {
    const storage = new FakeStorage();
    const dnr = new FakeDnr();
    dnr.updateSessionRules = () => Promise.reject(new Error('dnr exploded'));
    const service = new CapsiumService({
      loader: new PackageLoader(),
      store: new PackageStore(storage),
      rules: new DnrRuleManager(dnr, storage),
      rewriter: new FakeRewriter(),
      tabs: new FakeTabs(),
    });
    const response = await service.openFromDataUri(bareFixtureDataUri());
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error).toMatch(/dnr exploded/);
    // No package data leaked; only an empty index may remain.
    expect(storage.keys().every((key) => !key.includes('.pkg.'))).toBe(true);
    expect(await new PackageStore(storage).listIndex()).toEqual([]);
  });

  it('surfaces integrity rejection to the popup', async () => {
    const { service } = makeService();
    const response = await service.openFromDataUri(
      'data:application/vnd.capsium.package;base64,bm90IGEgemlw',
    );
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.length).toBeGreaterThan(0);
  });
});

describe('CapsiumService.sweepExpired', () => {
  it('removes expired packages’ storage AND rules, keeps fresh ones', async () => {
    let now = 1_000_000;
    const { service, storage, dnr } = makeService(() => now);

    const first = await service.openFromDataUri(bareFixtureDataUri());
    if (!first.ok) throw new Error('load failed');

    now += 31 * 60 * 1000; // past maxAge
    const second = await service.openFromDataUri(bareFixtureDataUri());
    if (!second.ok) throw new Error('load failed');

    const swept = await service.sweepExpired();
    expect(swept).toEqual([first.info.capId]);
    expect(dnr.rules.size).toBe(5); // only the fresh package's rules
    expect(storage.keys().some((key) => key.includes(first.info.capId))).toBe(
      false,
    );
    expect(
      (await new PackageStore(storage).listIndex()).map((e) => e.capId),
    ).toEqual([second.info.capId]);
  });
});

describe('CapsiumService.onStartup', () => {
  it('rebuilds session rules lost to a browser restart', async () => {
    const { service, dnr } = makeService();
    const response = await service.openFromDataUri(bareFixtureDataUri());
    if (!response.ok) throw new Error('load failed');

    dnr.clear(); // session rules do not survive a browser restart; storage does
    await service.onStartup();
    expect(dnr.rules.size).toBe(5);
  });
});
