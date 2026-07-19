import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { md5 } from '../src/lib/auth/md5';
import { apr1, verifyHtpasswd, htpasswdHashType } from '../src/lib/auth/htpasswd';
import { parseAuthentication } from '../src/lib/model';
import { PackageLoader } from '../src/lib/package-loader';
import { CapsiumService } from '../src/lib/background-service';
import { PackageStore } from '../src/lib/store';
import { DnrRuleManager } from '../src/lib/dnr';
import { lockRuleSpecs, authorizationHeaderSpec, UNAUTHORIZED_BODY } from '../src/lib/serving';
import { decodeBase64, encodeBase64 } from '../src/lib/base64';
import { generatedFixtureBytes } from './helpers/fixtures';
import {
  AUTH_CAP,
  AUTH_USER,
  AUTH_PASSWORD,
  AUTH_BCRYPT_USER,
  AUTH_BCRYPT_PASSWORD,
} from './fixtures/global-setup';
import { FakeDnr, FakeRewriter, FakeStorage, FakeTabs } from './helpers/fakes';

const enc = new TextEncoder();
const dec = new TextDecoder();

const md5Hex = (text: string): string =>
  [...md5(enc.encode(text))].map((b) => b.toString(16).padStart(2, '0')).join('');

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

describe('auth serving specs (§4b)', () => {
  it('lockRuleSpecs serves the 401 body on every route', () => {
    const locked = lockRuleSpecs([
      { path: '/', dataUri: 'data:text/html;base64,QQ', priority: 2 },
    ]);
    expect(locked).toHaveLength(1);
    expect(dec.decode(decodeBase64(locked[0]!.dataUri.split(',')[1] ?? ''))).toBe(
      UNAUTHORIZED_BODY,
    );
    expect(locked[0]!.priority).toBe(2);
  });

  it('authorizationHeaderSpec attaches Basic credentials package-wide', () => {
    const spec = authorizationHeaderSpec({ username: 'alice', password: 'swordfish' });
    expect(spec.prefixMatch).toBe(true);
    expect(spec.headersOnly).toBe(true);
    const token = spec.requestHeaders?.['Authorization'] ?? '';
    expect(token.startsWith('Basic ')).toBe(true);
    expect(dec.decode(decodeBase64(token.slice(6)))).toBe('alice:swordfish');
  });
});

describe('CapsiumService — basic auth flow', () => {
  function makeService(shared?: { storage: FakeStorage; dnr: FakeDnr }) {
    const storage = shared?.storage ?? new FakeStorage();
    const dnr = shared?.dnr ?? new FakeDnr();
    const tabs = new FakeTabs();
    const service = new CapsiumService({
      loader: new PackageLoader(),
      store: new PackageStore(storage),
      rules: new DnrRuleManager(dnr, storage),
      rewriter: new FakeRewriter(),
      tabs,
    });
    return { service, storage, dnr, tabs };
  }

  const dataUri = `data:application/vnd.capsium.package;base64,${encodeBase64(
    generatedFixtureBytes(AUTH_CAP),
  )}`;

  function servedBody(dnr: FakeDnr, path: string): string | undefined {
    const marker = '\\.cap';
    for (const rule of dnr.rules.values()) {
      if (rule.action.type !== 'redirect') continue;
      const filter = rule.condition.regexFilter;
      const start = filter.indexOf(marker) + marker.length;
      const end = filter.indexOf('(\\?.*)?$');
      if (filter.slice(start, end).replace(/\\(.)/g, '$1') === path) {
        return dec.decode(
          decodeBase64(rule.action.redirect.url.split(',')[1] ?? ''),
        );
      }
    }
    return undefined;
  }

  it('locks with the 401 body until credentials verify (apr1)', async () => {
    const { service, dnr, tabs } = makeService();
    const opened = await service.openFromDataUri(dataUri);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.info.authentication).toEqual({
      basicAuth: true,
      realm: 'capsium',
      authenticated: false,
    });
    // Absent credentials → the 401 body is shown for package URLs.
    expect(servedBody(dnr, '/')).toBe(UNAUTHORIZED_BODY);

    // Wrong credentials → error, still locked.
    const wrong = await service.authenticate(
      opened.info.capId,
      AUTH_USER,
      'wrong-password',
    );
    expect(wrong.ok).toBe(false);
    if (wrong.ok) return;
    expect(wrong.error).toMatch(/invalid username or password/i);
    expect(servedBody(dnr, '/')).toBe(UNAUTHORIZED_BODY);

    // Right credentials (apr1) → unlocked, Authorization attached, tab reopens.
    const ok = await service.authenticate(
      opened.info.capId,
      AUTH_USER,
      AUTH_PASSWORD,
    );
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.info.authentication?.authenticated).toBe(true);
    expect(servedBody(dnr, '/')).toContain('SECRET auth content');
    const authRule = [...dnr.rules.values()].find(
      (rule) => rule.action.type === 'modifyHeaders',
    );
    expect(authRule).toBeDefined();
    if (authRule?.action.type === 'modifyHeaders') {
      const header = authRule.action.requestHeaders?.find(
        (op) => op.header === 'Authorization',
      );
      expect(header).toBeDefined();
      expect(
        dec.decode(decodeBase64(header?.value?.slice(6) ?? '')),
      ).toBe(`${AUTH_USER}:${AUTH_PASSWORD}`);
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
    const shared = { storage: new FakeStorage(), dnr: new FakeDnr() };
    const first = makeService(shared);
    const opened = await first.service.openFromDataUri(dataUri);
    if (!opened.ok) throw new Error('open failed');
    await first.service.authenticate(opened.info.capId, AUTH_USER, AUTH_PASSWORD);
    expect(servedBody(shared.dnr, '/')).toContain('SECRET auth content');

    // Browser restart: session rules AND the in-memory session are gone.
    shared.dnr.clear();
    const second = makeService(shared);
    await second.service.onStartup();
    expect(servedBody(shared.dnr, '/')).toBe(UNAUTHORIZED_BODY);
  });
});
