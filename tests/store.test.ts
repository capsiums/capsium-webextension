import { describe, expect, it } from 'vitest';
import {
  INDEX_KEY,
  PackageStore,
  type StoredPackageInfo,
} from '../src/lib/store';
import { FakeFileStore, FakeStorage } from './helpers/fakes';

const info: StoredPackageInfo = {
  metadata: { name: 'demo', version: '1.0.0', dependencies: {} },
  routes: { routes: [{ path: '/', resource: 'content/index.html' }] },
  storage: null,
  fileTypes: {
    'content/index.html': 'text/html',
    'content/a.png': 'image/png',
  },
  validity: {
    package: 'demo@1.0.0',
    valid: true,
    lastChecked: '2026-07-18T00:00:00.000Z',
  },
  checksums: 'verified',
};

const files = [
  {
    path: 'content/index.html',
    contentType: 'text/html',
    bytes: new Uint8Array([60, 104, 49, 62]),
  },
  {
    path: 'content/a.png',
    contentType: 'image/png',
    bytes: new Uint8Array([0, 1, 2, 255]),
  },
];

describe('PackageStore', () => {
  it('installs bytes into the file store, metadata + index into storage (index last)', async () => {
    const storage = new FakeStorage();
    const fileStore = new FakeFileStore();
    const store = new PackageStore(storage, fileStore, () => 1234);
    await store.install('cap-1', info, files);

    // Bytes live in the file store, byte-identical (binary-safe).
    expect(await fileStore.get('cap-1', 'content/a.png')).toEqual(
      new Uint8Array([0, 1, 2, 255]),
    );
    // chrome.storage.local holds ONLY metadata: no file payloads.
    expect(storage.keys().filter((key) => key.includes('.file.'))).toEqual([]);
    expect(storage.data.get(PackageStore.infoKey('cap-1'))).toMatchObject({
      metadata: { name: 'demo' },
      fileTypes: { 'content/a.png': 'image/png' },
    });
    expect(storage.data.get(INDEX_KEY)).toEqual([
      { capId: 'cap-1', name: 'demo', version: '1.0.0', timeAdded: 1234 },
    ]);
    // The index must be the final storage write.
    expect(storage.setOrder.at(-1)).toEqual([INDEX_KEY]);
  });

  it('rolls back the file tree when a storage write fails mid-install', async () => {
    const storage = new FakeStorage();
    const fileStore = new FakeFileStore();
    storage.failOnSetCall = 1; // info write fails
    const store = new PackageStore(storage, fileStore);

    await expect(store.install('cap-1', info, files)).rejects.toThrow(
      /injected/,
    );
    expect(fileStore.packages.has('cap-1')).toBe(false); // no leaked bytes
    expect(storage.keys()).toEqual([]); // no leaked metadata
  });

  it('rolls back metadata when a file-store write fails mid-install', async () => {
    const storage = new FakeStorage();
    const fileStore = new FakeFileStore();
    fileStore.failOnPutCall = 1; // first byte write fails (e.g. quota)
    const store = new PackageStore(storage, fileStore);

    await expect(store.install('cap-1', info, files)).rejects.toThrow(
      /injected/,
    );
    expect(fileStore.packages.has('cap-1')).toBe(false);
    expect(await store.listIndex()).toEqual([]);
  });

  it('leaves the index untouched on failure', async () => {
    const storage = new FakeStorage();
    const fileStore = new FakeFileStore();
    const store = new PackageStore(storage, fileStore);
    await store.install('cap-good', info, files);

    storage.failOnSetCall = storage.setCalls + 1;
    await expect(store.install('cap-bad', info, files)).rejects.toThrow(
      /injected/,
    );
    expect(await store.listIndex()).toHaveLength(1);
    expect((await store.listIndex())[0]?.capId).toBe('cap-good');
  });

  it('removePackage deletes the file tree, info and the index entry', async () => {
    const storage = new FakeStorage();
    const fileStore = new FakeFileStore();
    const store = new PackageStore(storage, fileStore);
    await store.install('cap-1', info, files);
    await store.install('cap-2', info, files);

    await store.removePackage('cap-1');
    expect(fileStore.packages.has('cap-1')).toBe(false);
    expect(storage.keys().filter((key) => key.includes('cap-1'))).toEqual([]);
    expect((await store.listIndex()).map((entry) => entry.capId)).toEqual([
      'cap-2',
    ]);
    expect(await store.getInfo('cap-1')).toBeNull();
  });
});
