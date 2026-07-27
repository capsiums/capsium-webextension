import type {
  HtmlRewriter,
  OffscreenPort,
  RuntimeMessagingPort,
} from './ports';
import { rewriteHtmlUrls, extractInlineScripts } from './html-rewrite';
import { REWRITE_REQUEST_TYPE, isRewriteHtmlResponse } from './messages';

/**
 * Rewrites HTML directly with the ambient DOMParser. Used where DOMParser is
 * available in the background context: Firefox event pages (and tests).
 *
 * On Firefox, inline `<script>` elements are blocked by the MV2 CSP
 * (script-src 'self' blob: — no 'unsafe-inline'). The rewriter extracts
 * inline script content into blob: URLs before serving so the scripts
 * execute under the blob: CSP directive. On Chrome this path is not
 * used (the sandbox page handles inline scripts natively).
 */
export class DirectHtmlRewriter implements HtmlRewriter {
  rewrite(html: string, baseUrl: string): Promise<string> {
    const urlRewritten = rewriteHtmlUrls(html, baseUrl);
    const inlineExtracted = extractInlineScripts(urlRewritten, (content, type) => {
      const blob = new Blob([content], { type });
      return URL.createObjectURL(blob);
    });
    return Promise.resolve(inlineExtracted);
  }
}

/**
 * Chrome MV3 path: a SINGLE persistent offscreen document does the DOM
 * parsing. The document is created lazily once (no per-file create/close
 * churn — the original raced on concurrent opens) and every request carries
 * a correlation ID.
 */
export class OffscreenHtmlRewriter implements HtmlRewriter {
  private ensuring: Promise<void> | null = null;

  constructor(
    private readonly offscreen: OffscreenPort,
    private readonly messaging: RuntimeMessagingPort,
    private readonly documentUrl: string,
    private readonly timeoutMs = 10_000,
  ) {}

  private ensureDocument(): Promise<void> {
    this.ensuring ??= (async () => {
      if (!(await this.offscreen.hasDocument())) {
        await this.offscreen.createDocument(this.documentUrl);
      }
    })().catch((error: unknown) => {
      this.ensuring = null;
      throw error;
    });
    return this.ensuring;
  }

  async rewrite(html: string, baseUrl: string): Promise<string> {
    await this.ensureDocument();
    const requestId = crypto.randomUUID();
    const response = await this.withTimeout(
      this.messaging.sendMessage({
        type: REWRITE_REQUEST_TYPE,
        requestId,
        html,
        baseUrl,
      }),
    );
    if (!isRewriteHtmlResponse(response)) {
      throw new Error(
        'Offscreen HTML rewrite failed: no valid response (is the offscreen document ready?)',
      );
    }
    if (response.requestId !== requestId) {
      throw new Error(
        'Offscreen HTML rewrite failed: mismatched response correlation ID',
      );
    }
    return response.html;
  }

  private withTimeout(promise: Promise<unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `Offscreen document timed out after ${this.timeoutMs} ms`,
            ),
          ),
        this.timeoutMs,
      );
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }
}
