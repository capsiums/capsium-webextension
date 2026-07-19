import { describe, expect, it } from 'vitest';
import { OffscreenHtmlRewriter } from '../src/lib/offscreen-rewriter';
import {
  REWRITE_RESPONSE_TYPE,
  isRewriteHtmlRequest,
  type RewriteHtmlResponse,
} from '../src/lib/messages';
import { FakeMessaging, FakeOffscreen } from './helpers/fakes';

describe('OffscreenHtmlRewriter', () => {
  it('creates a single persistent document reused across rewrites (bug #6)', async () => {
    const offscreen = new FakeOffscreen();
    const messaging = new FakeMessaging();
    messaging.handler = (message) => {
      if (!isRewriteHtmlRequest(message)) return undefined;
      const response: RewriteHtmlResponse = {
        type: REWRITE_RESPONSE_TYPE,
        requestId: message.requestId,
        html: `<p>base:${message.baseUrl}</p>`,
      };
      return response;
    };
    const rewriter = new OffscreenHtmlRewriter(
      offscreen,
      messaging,
      'chrome-extension://x/offscreen.html',
    );

    await rewriter.rewrite('<p>a</p>', 'https://a.cap/');
    await rewriter.rewrite('<p>b</p>', 'https://a.cap/docs/');
    await rewriter.rewrite('<p>c</p>', 'https://a.cap/');

    expect(offscreen.documents).toBe(1);
    expect(messaging.sent).toHaveLength(3);
    expect(
      messaging.sent.every(
        (message) =>
          isRewriteHtmlRequest(message) &&
          typeof message.requestId === 'string',
      ),
    ).toBe(true);
  });

  it('correlates responses by requestId', async () => {
    const messaging = new FakeMessaging();
    messaging.handler = (message) => {
      if (!isRewriteHtmlRequest(message)) return undefined;
      return { type: REWRITE_RESPONSE_TYPE, requestId: 'WRONG-ID', html: '' };
    };
    const rewriter = new OffscreenHtmlRewriter(
      new FakeOffscreen(),
      messaging,
      'url',
    );
    await expect(
      rewriter.rewrite('<p>a</p>', 'https://a.cap/'),
    ).rejects.toThrow(/correlation ID/);
  });

  it('fails clearly when no response comes back', async () => {
    const messaging = new FakeMessaging(); // handler returns undefined
    const rewriter = new OffscreenHtmlRewriter(
      new FakeOffscreen(),
      messaging,
      'url',
    );
    await expect(
      rewriter.rewrite('<p>a</p>', 'https://a.cap/'),
    ).rejects.toThrow(/no valid response/);
  });

  it('times out when the document never responds', async () => {
    const messaging = new FakeMessaging();
    messaging.handler = () => new Promise(() => {}); // never resolves
    const rewriter = new OffscreenHtmlRewriter(
      new FakeOffscreen(),
      messaging,
      'url',
      20,
    );
    await expect(
      rewriter.rewrite('<p>a</p>', 'https://a.cap/'),
    ).rejects.toThrow(/timed out/);
  });

  it('recreates the document if creation fails', async () => {
    const offscreen = new FakeOffscreen();
    let failures = 1;
    offscreen.createDocument = () => {
      if (failures > 0) {
        failures -= 1;
        return Promise.reject(new Error('transient'));
      }
      offscreen.documents += 1;
      return Promise.resolve();
    };
    const messaging = new FakeMessaging();
    messaging.handler = (message) =>
      isRewriteHtmlRequest(message)
        ? {
            type: REWRITE_RESPONSE_TYPE,
            requestId: message.requestId,
            html: 'ok',
          }
        : undefined;
    const rewriter = new OffscreenHtmlRewriter(offscreen, messaging, 'url');

    await expect(
      rewriter.rewrite('<p>a</p>', 'https://a.cap/'),
    ).rejects.toThrow(/transient/);
    await expect(rewriter.rewrite('<p>a</p>', 'https://a.cap/')).resolves.toBe(
      'ok',
    );
  });
});
