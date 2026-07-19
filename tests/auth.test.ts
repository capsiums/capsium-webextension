import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { md5 } from '../src/lib/auth/md5';
import {
  apr1,
  verifyHtpasswd,
  htpasswdHashType,
} from '../src/lib/auth/htpasswd';
import { parseAuthentication } from '../src/lib/model';
import { PackageLoader } from '../src/lib/package-loader';
import { CapsiumService } from '../src/lib/background-service';
import { PackageStore } from '../src/lib/store';
import { DnrRuleManager, basicAuthorizationHeader } from '../src/lib/dnr';
import { UNAUTHORIZED_BODY } from '../src/lib/resolver';
import { decodeBase64, encodeBase64 } from '../src/lib/base64';
import { generatedFixtureBytes } from './helpers/fixtures';
import {
  AUTH_CAP,
  AUTH_USER,
  AUTH_PASSWORD,
  AUTH_BCRYPT_USER,
  AUTH_BCRYPT_PASSWORD,
} from './fixtures/global-setup';
import {
  FakeDnr,
  FakeFileStore,
  FakeRewriter,
  FakeStorage,
  FakeTabs,
} from './helpers/fakes';

const ROUTER = 'chrome-extension://ext-id/router.html';
const enc = new TextEncoder();
const dec = new TextDecoder();

const md5Hex = (text: string): string =>
  [...md5(enc.encode(text))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

describe('authentication model (§4b)', () => {
  it('parses basicAuth and oauth2 configs', () => {
    const auth = parseAuthentication({
      authentication: {
        basicAuth: { enabled: true, passwdFile: 'auth/.htpasswd', realm: 'x' },
        oauth2: {
          enabled: false,
          clientId: 'id',
          authorizationUrl: 'https://accounts.example.com/auth',
          tokenUrl: 'https://accounts.example.com/token',
          redirectPath: '/auth/callback',
          scopes: ['openid'],
        },
      },
    });
    expect(auth.authentication.basicAuth?.realm).toBe('x');
    expect(auth.authentication.oauth2?.clientId).toBe('id');
  });

  it('rejects an oauth2 config without clientId', () => {
    expect(() =>
      parseAuthentication({
        authentication: {
          oauth2: {
            enabled: true,
            authorizationUrl: 'https://a.example.com',
            tokenUrl: 'https://t.example.com',
            redirectPath: '/cb',
          },
        },
      }),
    ).toThrow(/Invalid authentication\.json/);
  });
});

describe('md5 / apr1 (RFC 1321 + Apache htpasswd)', () => {
  it('matches the RFC 1321 test vectors', () => {
    expect(md5Hex('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5Hex('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(md5Hex('The quick brown fox jumps over the lazy dog')).toBe(
      '9e107d9d372bb6826bd81d3542a419d6',
    );
  });

  it('reproduces the capsium-js apr1 fixture hash', () => {
    expect(apr1(AUTH_PASSWORD, 'eWvS2f3d')).toBe(
      '$apr1$eWvS2f3d$uvjLCQ9y6Om4aVryf5uSX.',
    );
  });
});

describe('verifyHtpasswd', () => {
  const file = `alice:$apr1$eWvS2f3d$uvjLCQ9y6Om4aVryf5uSX.\n# comment\n\n`;

  it('verifies apr1 credentials', async () => {
    expect(await verifyHtpasswd(file, 'alice', 'swordfish')).toEqual({
      kind: 'ok',
    });
    expect(await verifyHtpasswd(file, 'alice', 'wrong')).toEqual({
      kind: 'bad-credentials',
    });
    expect(await verifyHtpasswd(file, 'mallory', 'swordfish')).toEqual({
      kind: 'unknown-user',
    });
  });

  it('verifies bcrypt credentials (via bcryptjs)', async () => {
    const bcrypt = await import('bcryptjs');
    const hash = bcrypt.hashSync('hunter2', 10);
    expect(await verifyHtpasswd(`bob:${hash}\n`, 'bob', 'hunter2')).toEqual({
      kind: 'ok',
    });
    expect(await verifyHtpasswd(`bob:${hash}\n`, 'bob', 'nope')).toEqual({
      kind: 'bad-credentials',
    });
  });

  it('reports unsupported hash types precisely', async () => {
    expect(htpasswdHashType('$6$salt$hash')).toBe('sha-crypt');
    expect(await verifyHtpasswd('c:$6$salt$hash\n', 'c', 'x')).toEqual({
      kind: 'unsupported-hash',
      hashType: 'sha-crypt',
    });
  });
});

describe('PackageLoader — authentication.json', () => {
  const loader = new PackageLoader();

  it('parses authentication.json and extracts the htpasswd file', async () => {
    const pkg = await loader.load(generatedFixtureBytes(AUTH_CAP));
    expect(pkg.authentication?.authentication.basicAuth).toMatchObject({
      enabled: true,
      passwdFile: 'auth/.htpasswd',
      realm: 'capsium',
    });
    const htpasswd = pkg.files.find((file) => file.path === 'auth/.htpasswd');
    expect(htpasswd).toBeDefined();
    expect(dec.decode(htpasswd?.bytes)).toContain(`${AUTH_USER}:`);
    expect(pkg.checksums).toBe('verified');
  });

  it('rejects when the declared passwdFile is missing', async () => {
    const bytes = zipSync({
      'metadata.json': enc.encode(
        JSON.stringify({ name: 'x', version: '1.0.0' }),
      ),
      'authentication.json': enc.encode(
        JSON.stringify({
          authentication: {
            basicAuth: { enabled: true, passwdFile: 'auth/.htpasswd' },
          },
        }),
      ),
      'content/index.html': enc.encode('<p>x</p>'),
    });
    await expect(loader.load(bytes)).rejects.toMatchObject({
      name: 'PackageError',
      code: 'missing-resource',
    });
  });
});

describe('auth serving (§4b)', () => {
  it('the 401 body text is stable and the gate is dynamic (no rule rewrite)', () => {
    expect(UNAUTHORIZED_BODY).toBe('authentication required');
  });

  it('basicAuthorizationHeader attaches Basic credentials package-wide', () => {
    const header = basicAuthorizationHeader({
      username: 'alice',
      password: 'swordfish',
    });
    expect(header.startsWith('Basic ')).toBe(true);
    expect(dec.decode(decodeBase64(header.slice(6)))).toBe('alice:swordfish');
  });
});

describe('CapsiumService — basic auth flow', () => {
  function makeService(shared?: {
    storage: FakeStorage;
    fileStore: FakeFileStore;
    dnr: FakeDnr;
  }) {
    const storage = shared?.storage ?? new FakeStorage();
    const fileStore = shared?.fileStore ?? new FakeFileStore();
    const dnr = shared?.dnr ?? new FakeDnr();
    const tabs = new FakeTabs();
    const service = new CapsiumService({
      loader: new PackageLoader(),
      store: new PackageStore(storage, fileStore),
      rules: new DnrRuleManager(dnr, storage),
      rewriter: new FakeRewriter(),
      tabs,
      fileStore,
      routerBaseUrl: ROUTER,
    });
    return { service, storage, fileStore, dnr, tabs };
  }

  const dataUri = `data:application/vnd.capsium.package;base64,${encodeBase64(
    generatedFixtureBytes(AUTH_CAP),
  )}`;

  it('locks with the 401 gate until credentials verify (apr1)', async () => {
    const { service, fileStore, dnr, tabs } = makeService();
    const opened = await service.openFromDataUri(dataUri);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const capId = opened.info.capId;
    expect(opened.info.authentication).toEqual({
      basicAuth: true,
      realm: 'capsium',
      authenticated: false,
    });
    // Absent credentials → every package URL resolves locked (401 body).
    expect(await service.resolve(capId, ['/', '/style.css'])).toEqual([
      { path: '/', kind: 'locked' },
      { path: '/style.css', kind: 'locked' },
    ]);
    // Still just the one redirect rule — the gate is dynamic.
    expect(dnr.rules.size).toBe(1);

    // Wrong credentials → error, still locked.
    const wrong = await service.authenticate(
      capId,
      AUTH_USER,
      'wrong-password',
    );
    expect(wrong.ok).toBe(false);
    if (wrong.ok) return;
    expect(wrong.error).toMatch(/invalid username or password/i);
    expect((await service.resolve(capId, ['/']))[0]?.kind).toBe('locked');

    // Right credentials (apr1) → unlocked, Authorization rule attached, tab
    // reopens.
    const ok = await service.authenticate(capId, AUTH_USER, AUTH_PASSWORD);
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.info.authentication?.authenticated).toBe(true);

    const resolved = await service.resolve(capId, ['/']);
    const root = resolved[0];
    expect(root?.kind).toBe('found');
    if (root?.kind === 'found') {
      expect(root.contentType).toBe('text/html');
      const bytes = await fileStore.get(root.fileCapId, root.filePath);
      expect(dec.decode(bytes!)).toContain('SECRET auth content');
    }

    // The §4b Authorization rule rides alongside the redirect rule.
    expect(dnr.rules.size).toBe(2);
    const authRule = [...dnr.rules.values()].find(
      (rule) => rule.action.type === 'modifyHeaders',
    );
    expect(authRule).toBeDefined();
    if (authRule?.action.type === 'modifyHeaders') {
      const header = authRule.action.requestHeaders?.find(
        (op) => op.header === 'Authorization',
      );
      expect(header).toBeDefined();
      expect(dec.decode(decodeBase64(header?.value?.slice(6) ?? ''))).toBe(
        `${AUTH_USER}:${AUTH_PASSWORD}`,
      );
    }
    expect(tabs.created).toHaveLength(2); // opened + reopened after auth
  });

  it('verifies bcrypt credentials too', async () => {
    const { service } = makeService();
    const opened = await service.openFromDataUri(dataUri);
    if (!opened.ok) throw new Error('open failed');
    const ok = await service.authenticate(
      opened.info.capId,
      AUTH_BCRYPT_USER,
      AUTH_BCRYPT_PASSWORD,
    );
    expect(ok.ok).toBe(true);
  });

  it('locks again after a restart (session credentials are memory-only)', async () => {
    const shared = {
      storage: new FakeStorage(),
      fileStore: new FakeFileStore(),
      dnr: new FakeDnr(),
    };
    const first = makeService(shared);
    const opened = await first.service.openFromDataUri(dataUri);
    if (!opened.ok) throw new Error('open failed');
    const capId = opened.info.capId;
    await first.service.authenticate(capId, AUTH_USER, AUTH_PASSWORD);
    expect((await first.service.resolve(capId, ['/']))[0]?.kind).toBe('found');

    // Browser restart: session rules AND the in-memory session are gone.
    shared.dnr.clear();
    const second = makeService(shared);
    await second.service.onStartup();
    expect((await second.service.resolve(capId, ['/']))[0]?.kind).toBe(
      'locked',
    );
    // Rebuilt without the Authorization header rule.
    expect(
      [...shared.dnr.rules.values()].every(
        (rule) => rule.action.type === 'redirect',
      ),
    ).toBe(true);
  });
});
