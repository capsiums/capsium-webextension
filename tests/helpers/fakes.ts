import type {
  DnrPort,
  DnrRule,
  HtmlRewriter,
  OffscreenPort,
  StorageData,
  StoragePort,
  TabsPort,
} from '../../src/lib/ports';

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
