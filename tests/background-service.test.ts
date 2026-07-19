import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { CapsiumService } from '../src/lib/background-service';
import { PackageLoader } from '../src/lib/package-loader';
import { PackageStore } from '../src/lib/store';
import { DnrRuleManager } from '../src/lib/dnr';
import { encodeBase64 } from '../src/lib/base64';
import { fixtureBytes } from './helpers/fixtures';
import {
  FakeDnr,
  FakeFileStore,
  FakeRewriter,
  FakeStorage,
  FakeTabs,
} from './helpers/fakes';

const ROUTER = 'chrome-extension://ext-id/router.html';
const enc = new TextEncoder();

function makeService(now: () => number = Date.now, maxAgeMs = 30 * 60 * 1000) {
  const storage = new FakeStorage();
  const fileStore = new FakeFileStore();
  const dnr = new FakeDnr();
  const tabs = new FakeTabs();
  const rewriter = new FakeRewriter();
  const service = new CapsiumService({
    loader: new PackageLoader(),
    store: new PackageStore(storage, fileStore, now),
    rules: new DnrRuleManager(dnr, storage),
    rewriter,
    tabs,
    fileStore,
    routerBaseUrl: ROUTER,
    now,
    maxAgeMs,
  });
  return { service, storage, fileStore, dnr, tabs, rewriter };
}

function bareFixtureDataUri(): string {
  return `data:application/vnd.capsium.package;base64,${encodeBase64(fixtureBytes('bare_package-0.1.0.cap'))}`;
}

describe('CapsiumService.openFromDataUri', () => {
  it('happy path: rewrites HTML, stores bytes, installs ONE rule, opens the tab', async () => {
    const { service, storage, fileStore, dnr, tabs, rewriter } = makeService();
    const response = await service.openFromDataUri(bareFixtureDataUri());

    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.info.name).toBe('bare_package');
    expect(response.info.routes.length).toBe(5);
    expect(response.info.entryUrl).toMatch(/^https:\/\/[0-9a-f-]+\.cap\/$/);
    const capId = response.info.capId;

    // HTML was rewritten with the file's own directory as base.
    expect(rewriter.calls).toHaveLength(1);
    expect(rewriter.calls[0]?.baseUrl).toBe(`https://${capId}.cap/`);

    // ONE redirect rule per package (route matching is dynamic now).
    expect(dnr.rules.size).toBe(1);
    expect(tabs.created).toEqual([response.info.entryUrl]);
    expect(
      (await new PackageStore(storage, fileStore).listIndex()).map(
        (e) => e.capId,
      ),
    ).toEqual([capId]);

    // Bytes landed in the file store; chrome.storage.local holds no payloads.
    expect(storage.keys().filter((key) => key.includes('.file.'))).toEqual([]);
    expect(await fileStore.get(capId, 'content/example.css')).toEqual(
      enc.encode('body { color: red; }'),
    );
  });

  it('two packages coexist without rule or storage clobbering', async () => {
    const { service, storage, fileStore, dnr } = makeService();
    const first = await service.openFromDataUri(bareFixtureDataUri());
    const second = await service.openFromDataUri(bareFixtureDataUri());
    if (!first.ok || !second.ok) throw new Error('load failed');
    expect(first.info.capId).not.toBe(second.info.capId);
    expect(dnr.rules.size).toBe(2);
    expect(await new PackageStore(storage, fileStore).listIndex()).toHaveLength(
      2,
    );
  });

  it('rolls back storage when rule installation fails', async () => {
    const storage = new FakeStorage();
    const fileStore = new FakeFileStore();
    const dnr = new FakeDnr();
    dnr.updateSessionRules = () => Promise.reject(new Error('dnr exploded'));
    const service = new CapsiumService({
      loader: new PackageLoader(),
      store: new PackageStore(storage, fileStore),
      rules: new DnrRuleManager(dnr, storage),
      rewriter: new FakeRewriter(),
      tabs: new FakeTabs(),
      fileStore,
      routerBaseUrl: ROUTER,
    });
    const response = await service.openFromDataUri(bareFixtureDataUri());
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error).toMatch(/dnr exploded/);
    // No package data leaked; only an empty index may remain.
    expect(storage.keys().every((key) => !key.includes('.pkg.'))).toBe(true);
    expect(await new PackageStore(storage, fileStore).listIndex()).toEqual([]);
    expect(fileStore.packages.size).toBe(0);
  });

  it('rejects a package whose routes reference a missing resource', async () => {
    const { service } = makeService();
    const bytes = zipSync({
      'metadata.json': enc.encode(
        JSON.stringify({ name: 'broken', version: '1.0.0' }),
      ),
      'manifest.json': enc.encode(
        JSON.stringify({
          resources: { 'content/index.html': { type: 'text/html' } },
        }),
      ),
      'routes.json': enc.encode(
        JSON.stringify({
          routes: [{ path: '/', resource: 'content/ghost.html' }],
        }),
      ),
      'content/index.html': enc.encode('<p>x</p>'),
    });
    const response = await service.openFromDataUri(
      `data:application/vnd.capsium.package;base64,${encodeBase64(bytes)}`,
    );
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error).toMatch(/missing resource/);
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

describe('CapsiumService.resolve (router-page entry point)', () => {
  it('resolves routes to stored files with MIME types, 404s unknown paths', async () => {
    const { service } = makeService();
    const opened = await service.openFromDataUri(bareFixtureDataUri());
    if (!opened.ok) throw new Error('open failed');
    const capId = opened.info.capId;

    const results = await service.resolve(capId, [
      '/',
      '/example.css',
      '/nope',
    ]);
    expect(results).toEqual([
      {
        path: '/',
        kind: 'found',
        store: 'opfs',
        fileCapId: capId,
        filePath: 'content/index.html',
        contentType: 'text/html',
      },
      {
        path: '/example.css',
        kind: 'found',
        store: 'opfs',
        fileCapId: capId,
        filePath: 'content/example.css',
        contentType: 'text/css',
      },
      { path: '/nope', kind: 'not-found' },
    ]);
  });

  it('resolves not-found for packages that are not installed', async () => {
    const { service } = makeService();
    expect(await service.resolve('no-such-cap', ['/'])).toEqual([
      { path: '/', kind: 'not-found' },
    ]);
  });
});

describe('CapsiumService.sweepExpired', () => {
  it('removes expired packages’ bytes, metadata AND rules, keeps fresh ones', async () => {
    let now = 1_000_000;
    const { service, storage, fileStore, dnr } = makeService(() => now);

    const first = await service.openFromDataUri(bareFixtureDataUri());
    if (!first.ok) throw new Error('load failed');

    now += 31 * 60 * 1000; // past maxAge
    const second = await service.openFromDataUri(bareFixtureDataUri());
    if (!second.ok) throw new Error('load failed');

    const swept = await service.sweepExpired();
    expect(swept).toEqual([first.info.capId]);
    expect(dnr.rules.size).toBe(1); // only the fresh package's rule
    expect(fileStore.packages.has(first.info.capId)).toBe(false);
    expect(fileStore.packages.has(second.info.capId)).toBe(true);
    expect(storage.keys().some((key) => key.includes(first.info.capId))).toBe(
      false,
    );
    expect(
      (await new PackageStore(storage, fileStore).listIndex()).map(
        (e) => e.capId,
      ),
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
    expect(dnr.rules.size).toBe(1);
  });
});
