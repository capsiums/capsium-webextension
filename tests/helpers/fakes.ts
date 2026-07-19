import type {
  DnrPort,
  DnrRule,
  FileStorePort,
  HtmlRewriter,
  OffscreenPort,
  StorageData,
  StoragePort,
  TabsPort,
} from '../../src/lib/ports';
import type {
  CacheLike,
  OpfsDirectoryLike,
  OpfsFileHandleLike,
} from '../../src/lib/file-store';

/** In-memory StoragePort with optional write-failure injection. */
export class FakeStorage implements StoragePort {
  readonly data = new Map<string, unknown>();
  /** 1-based: the Nth set() call rejects. */
  failOnSetCall: number | null = null;
  setCalls = 0;
  /** Keys per successful set() call, in order. */
  readonly setOrder: string[][] = [];

  get(keys: string[]): Promise<StorageData> {
    const out: StorageData = {};
    for (const key of keys) {
      if (this.data.has(key)) out[key] = this.data.get(key);
    }
    return Promise.resolve(out);
  }

  set(items: StorageData): Promise<void> {
    this.setCalls += 1;
    if (this.failOnSetCall === this.setCalls) {
      return Promise.reject(new Error('storage write failed (injected)'));
    }
    for (const [key, value] of Object.entries(items)) this.data.set(key, value);
    this.setOrder.push(Object.keys(items));
    return Promise.resolve();
  }

  remove(keys: string[]): Promise<void> {
    for (const key of keys) this.data.delete(key);
    return Promise.resolve();
  }

  keys(): string[] {
    return [...this.data.keys()];
  }
}

export class FakeDnr implements DnrPort {
  readonly rules = new Map<number, DnrRule>();

  updateSessionRules(options: {
    removeRuleIds?: number[];
    addRules?: DnrRule[];
  }): Promise<void> {
    for (const id of options.removeRuleIds ?? []) this.rules.delete(id);
    for (const rule of options.addRules ?? []) {
      if (this.rules.has(rule.id)) {
        return Promise.reject(
          new Error(`DNR rule id ${rule.id} already exists`),
        );
      }
      this.rules.set(rule.id, rule);
    }
    return Promise.resolve();
  }

  getSessionRules(): Promise<Array<{ id: number }>> {
    return Promise.resolve(
      [...this.rules.values()].map((rule) => ({ id: rule.id })),
    );
  }

  clear(): void {
    this.rules.clear();
  }
}

export class FakeTabs implements TabsPort {
  readonly created: string[] = [];

  create(options: { url: string }): Promise<void> {
    this.created.push(options.url);
    return Promise.resolve();
  }
}

export class FakeOffscreen implements OffscreenPort {
  documents = 0;
  readonly urls: string[] = [];

  hasDocument(): Promise<boolean> {
    return Promise.resolve(this.documents > 0);
  }

  createDocument(url: string): Promise<void> {
    this.documents += 1;
    this.urls.push(url);
    return Promise.resolve();
  }
}

export class FakeMessaging {
  handler: (message: unknown) => Promise<unknown> | unknown = () => undefined;
  readonly sent: unknown[] = [];

  sendMessage(message: unknown): Promise<unknown> {
    this.sent.push(message);
    return Promise.resolve(this.handler(message));
  }
}

/** Records rewrite calls and returns recognizable output. */
export class FakeRewriter implements HtmlRewriter {
  readonly calls: Array<{ html: string; baseUrl: string }> = [];

  rewrite(html: string, baseUrl: string): Promise<string> {
    this.calls.push({ html, baseUrl });
    return Promise.resolve(`<!-- base:${baseUrl} -->${html}`);
  }
}

/** In-memory FileStorePort (service-level tests). */
export class FakeFileStore implements FileStorePort {
  readonly kind = 'opfs' as const;
  /** capId -> path -> bytes. */
  readonly packages = new Map<string, Map<string, Uint8Array>>();
  /** 1-based: the Nth put() call rejects (quota/IO injection). */
  failOnPutCall: number | null = null;
  putCalls = 0;

  put(capId: string, path: string, bytes: Uint8Array): Promise<void> {
    this.putCalls += 1;
    if (this.failOnPutCall === this.putCalls) {
      return Promise.reject(new Error('file store write failed (injected)'));
    }
    let tree = this.packages.get(capId);
    if (tree === undefined) {
      tree = new Map();
      this.packages.set(capId, tree);
    }
    tree.set(path, bytes);
    return Promise.resolve();
  }

  get(capId: string, path: string): Promise<Uint8Array | null> {
    return Promise.resolve(this.packages.get(capId)?.get(path) ?? null);
  }

  removePackage(capId: string): Promise<void> {
    this.packages.delete(capId);
    return Promise.resolve();
  }
}

class FakeOpfsFileHandle implements OpfsFileHandleLike {
  bytes: Uint8Array | null = null;

  async createWritable(): Promise<{
    write(data: Uint8Array): Promise<void>;
    close(): Promise<void>;
  }> {
    return {
      write: (data) => {
        this.bytes = data;
        return Promise.resolve();
      },
      close: () => Promise.resolve(),
    };
  }

  getFile(): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }> {
    if (this.bytes === null) return Promise.reject(new Error('NotFoundError'));
    const bytes = this.bytes;
    return Promise.resolve({
      arrayBuffer: () =>
        Promise.resolve(
          bytes.slice().buffer as ArrayBuffer,
        ),
    });
  }
}

/**
 * In-memory OPFS directory tree. Like the real API, reads of absent entries
 * reject (the store maps that to null) and removeEntry is recursive-opt-in.
 */
export class FakeOpfsDirectory implements OpfsDirectoryLike {
  readonly dirs = new Map<string, FakeOpfsDirectory>();
  readonly files = new Map<string, FakeOpfsFileHandle>();

  getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<OpfsDirectoryLike> {
    let dir = this.dirs.get(name);
    if (dir === undefined) {
      if (options?.create !== true)
        return Promise.reject(new Error('NotFoundError'));
      dir = new FakeOpfsDirectory();
      this.dirs.set(name, dir);
    }
    return Promise.resolve(dir);
  }

  getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<OpfsFileHandleLike> {
    let file = this.files.get(name);
    if (file === undefined) {
      if (options?.create !== true)
        return Promise.reject(new Error('NotFoundError'));
      file = new FakeOpfsFileHandle();
      this.files.set(name, file);
    }
    return Promise.resolve(file);
  }

  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void> {
    if (this.dirs.has(name)) {
      if (options?.recursive !== true)
        return Promise.reject(new Error('InvalidModificationError'));
      this.dirs.delete(name);
      return Promise.resolve();
    }
    if (this.files.delete(name)) return Promise.resolve();
    return Promise.reject(new Error('NotFoundError'));
  }
}

/** In-memory Cache (Request/Response from the undici globals in Node). */
export class FakeCache implements CacheLike {
  readonly entries = new Map<string, Response>();

  put(request: string, response: Response): Promise<void> {
    this.entries.set(request, response);
    return Promise.resolve();
  }

  match(request: string): Promise<Response | undefined> {
    return Promise.resolve(this.entries.get(request));
  }

  delete(request: string): Promise<boolean> {
    return Promise.resolve(this.entries.delete(request));
  }

  keys(): Promise<Array<{ url: string }>> {
    return Promise.resolve([...this.entries.keys()].map((url) => ({ url })));
  }
}
