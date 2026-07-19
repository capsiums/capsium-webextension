import { describe, expect, it } from 'vitest';
import {
  INDEX_KEY,
  PackageStore,
  type StoredPackageInfo,
} from '../src/lib/store';
import { FakeStorage } from './helpers/fakes';

const info: StoredPackageInfo = {
  metadata: { name: 'demo', version: '1.0.0', dependencies: {} },
  routes: { routes: [{ path: '/', resource: 'content/index.html' }] },
  storage: null,
  files: ['content/index.html', 'content/a.png'],
  validity: {
    package: 'demo@1.0.0',
    valid: true,
    lastChecked: '2026-07-18T00:00:00.000Z',
  },
  checksums: 'verified',
};

const files = [
  { path: 'content/index.html', contentType: 'text/html', base64: 'QQ' },
  { path: 'content/a.png', contentType: 'image/png', base64: 'Qg' },
];

describe('PackageStore', () => {
  it('installs files, info and index (index written last)', async () => {
    const storage = new FakeStorage();
    const store = new PackageStore(storage, () => 1234);
    await store.install('cap-1', info, files);

    expect(
      storage.data.get(PackageStore.fileKey('cap-1', 'content/index.html')),
    ).toEqual({
      contentType: 'text/html',
      base64: 'QQ',
    });
    expect(storage.data.get(PackageStore.infoKey('cap-1'))).toMatchObject({
      metadata: { name: 'demo' },
    });
    expect(storage.data.get(INDEX_KEY)).toEqual([
      { capId: 'cap-1', name: 'demo', version: '1.0.0', timeAdded: 1234 },
    ]);
    // The index must be the final write.
    expect(storage.setOrder.at(-1)).toEqual([INDEX_KEY]);
  });

  it('rolls back every written key when a write fails mid-install', async () => {
    const storage = new FakeStorage();
    storage.failOnSetCall = 2; // first file batch succeeds, info write fails
    const store = new PackageStore(storage);

    await expect(store.install('cap-1', info, files)).rejects.toThrow(
      /injected/,
    );
    expect(storage.keys()).toEqual([]); // no leaked storage
  });

  it('leaves the index untouched on failure', async () => {
    const storage = new FakeStorage();
    const store = new PackageStore(storage);
    await store.install('cap-good', info, files);

    storage.failOnSetCall = storage.setCalls + 1;
    await expect(store.install('cap-bad', info, files)).rejects.toThrow(
      /injected/,
    );
    expect(await store.listIndex()).toHaveLength(1);
    expect((await store.listIndex())[0]?.capId).toBe('cap-good');
  });

  it('removePackage deletes files, info and the index entry', async () => {
    const storage = new FakeStorage();
    const store = new PackageStore(storage);
    await store.install('cap-1', info, files);
    await store.install('cap-2', info, files);

    await store.removePackage('cap-1');
    expect(storage.keys().filter((key) => key.includes('cap-1'))).toEqual([]);
    expect((await store.listIndex()).map((entry) => entry.capId)).toEqual([
      'cap-2',
    ]);
    expect(await store.getInfo('cap-1')).toBeNull();
  });
});
