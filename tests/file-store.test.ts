import { describe, expect, it } from 'vitest';
import {
  CacheFileStore,
  OpfsFileStore,
  cacheKey,
  pathSegments,
  selectFileStore,
} from '../src/lib/file-store';
import { FakeCache, FakeOpfsDirectory } from './helpers/fakes';

const CAP = '11111111-1111-4111-8111-111111111111';

/** Every byte value 0..255 — binary-safety canaries. */
const ALL_BYTES = new Uint8Array(256).map((_, index) => index);

describe('pathSegments', () => {
  it('accepts nested POSIX paths', () => {
    expect(pathSegments('content/assets/a b.png')).toEqual([
      'content',
      'assets',
      'a b.png',
    ]);
  });

  it('rejects traversal and malformed paths', () => {
    for (const bad of [
      '',
      '/abs',
      'trailing/',
      '../escape',
      'a//b',
      'a/./b',
      'a/../b',
    ]) {
      expect(() => pathSegments(bad)).toThrow(/Invalid package path/);
    }
  });
});

describe('OpfsFileStore', () => {
  async function makeStore() {
    const originRoot = new FakeOpfsDirectory();
    const store = await OpfsFileStore.create(() => Promise.resolve(originRoot));
    return { store, originRoot };
  }

  it('round-trips binary files byte-identically', async () => {
    const { store } = await makeStore();
    await store.put(CAP, 'content/blob.bin', ALL_BYTES);
    expect(await store.get(CAP, 'content/blob.bin')).toEqual(ALL_BYTES);
  });

  it('stores nested paths and keeps packages apart', async () => {
    const { store } = await makeStore();
    await store.put(CAP, 'a/b/c.txt', new Uint8Array([1]));
    await store.put('other-cap', 'a/b/c.txt', new Uint8Array([2]));
    expect(await store.get(CAP, 'a/b/c.txt')).toEqual(new Uint8Array([1]));
    expect(await store.get('other-cap', 'a/b/c.txt')).toEqual(
      new Uint8Array([2]),
    );
  });

  it('returns null for absent files and packages', async () => {
    const { store } = await makeStore();
    expect(await store.get(CAP, 'nope.txt')).toBeNull();
    await store.put(CAP, 'there.txt', new Uint8Array([1]));
    expect(await store.get(CAP, 'not-there.txt')).toBeNull();
  });

  it('removePackage drops the whole tree and is idempotent', async () => {
    const { store } = await makeStore();
    await store.put(CAP, 'a/b.txt', new Uint8Array([1]));
    await store.put(CAP, 'c.txt', new Uint8Array([2]));
    await store.removePackage(CAP);
    expect(await store.get(CAP, 'a/b.txt')).toBeNull();
    expect(await store.get(CAP, 'c.txt')).toBeNull();
    await store.removePackage(CAP); // no throw
  });
});

describe('CacheFileStore', () => {
  it('round-trips binary files byte-identically', async () => {
    const store = new CacheFileStore(new FakeCache());
    await store.put(CAP, 'content/blob.bin', ALL_BYTES);
    expect(await store.get(CAP, 'content/blob.bin')).toEqual(ALL_BYTES);
  });

  it('encodes special characters in keys', async () => {
    const cache = new FakeCache();
    const store = new CacheFileStore(cache);
    await store.put(CAP, 'content/a b#c?.png', new Uint8Array([7]));
    expect(cacheKey(CAP, 'content/a b#c?.png')).toBe(
      `https://capsium.cache/${CAP}/content/a%20b%23c%3F.png`,
    );
    expect(await store.get(CAP, 'content/a b#c?.png')).toEqual(
      new Uint8Array([7]),
    );
  });

  it('removePackage deletes only that package’s keys', async () => {
    const store = new CacheFileStore(new FakeCache());
    await store.put(CAP, 'a.txt', new Uint8Array([1]));
    await store.put('other', 'a.txt', new Uint8Array([2]));
    await store.removePackage(CAP);
    expect(await store.get(CAP, 'a.txt')).toBeNull();
    expect(await store.get('other', 'a.txt')).toEqual(new Uint8Array([2]));
  });
});

describe('selectFileStore', () => {
  it('prefers OPFS when the probe write succeeds', async () => {
    const store = await selectFileStore({
      getOpfsRoot: () => Promise.resolve(new FakeOpfsDirectory()),
      openCache: () => Promise.resolve(new FakeCache()),
    });
    expect(store.kind).toBe('opfs');
    // The probe left no trace.
    expect(await store.get('capsium-probe', 'probe.bin')).toBeNull();
  });

  it('falls back to the Cache API when OPFS is missing', async () => {
    const store = await selectFileStore({
      openCache: () => Promise.resolve(new FakeCache()),
    });
    expect(store.kind).toBe('cache');
  });

  it('falls back to the Cache API when the OPFS probe fails (quota)', async () => {
    const store = await selectFileStore({
      getOpfsRoot: () => Promise.reject(new Error('QuotaExceededError')),
      openCache: () => Promise.resolve(new FakeCache()),
    });
    expect(store.kind).toBe('cache');
  });

  it('throws when neither backend is available', async () => {
    await expect(selectFileStore({})).rejects.toThrow(/Neither OPFS/);
  });
});
