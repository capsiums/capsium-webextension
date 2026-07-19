import browser from 'webextension-polyfill';
import { rewriteHtmlUrls } from '../../lib/html-rewrite';
import {
  REWRITE_RESPONSE_TYPE,
  isRewriteHtmlRequest,
  type RewriteHtmlResponse,
} from '../../lib/messages';

// Single persistent offscreen document (Chrome-only path): parses packaged
// HTML with DOMParser and rewrites relative URLs against the package's
// URL-space directory, which arrives with each request.
browser.runtime.onMessage.addListener((message: unknown) => {
  if (!isRewriteHtmlRequest(message)) return undefined;
  const response: RewriteHtmlResponse = {
    type: REWRITE_RESPONSE_TYPE,
    requestId: message.requestId,
    html: rewriteHtmlUrls(message.html, message.baseUrl),
  };
  return Promise.resolve(response);
});
