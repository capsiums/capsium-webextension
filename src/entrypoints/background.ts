import { defineBackground } from 'wxt/utils/define-background';
import browser from 'webextension-polyfill';
import { PackageLoader } from '../lib/package-loader';
import { PackageStore } from '../lib/store';
import { DnrRuleManager } from '../lib/dnr';
import {
  DirectHtmlRewriter,
  OffscreenHtmlRewriter,
} from '../lib/offscreen-rewriter';
import { CapsiumService, SWEEP_ALARM_NAME } from '../lib/background-service';
import { isAddDependencyRequest, isOpenCapRequest } from '../lib/messages';
import type {
  DnrPort,
  HtmlRewriter,
  OffscreenPort,
  RuntimeMessagingPort,
  StoragePort,
  TabsPort,
} from '../lib/ports';

const OFFSCREEN_DOCUMENT_PATH = '/offscreen.html';
const OFFSCREEN_JUSTIFICATION =
  'Rewrite relative URLs in packaged HTML against the package URL space (DOM parsing is not available in a service worker).';

function createStoragePort(): StoragePort {
  return {
    get: (keys) => browser.storage.local.get(keys),
    set: (items) => browser.storage.local.set(items),
    remove: (keys) => browser.storage.local.remove(keys),
  };
}

function createDnrPort(): DnrPort {
  const dnr = browser.declarativeNetRequest;
  type AddRules = NonNullable<
    Parameters<typeof dnr.updateSessionRules>[0]['addRules']
  >;
  return {
    updateSessionRules: (options) =>
      dnr.updateSessionRules({
        removeRuleIds: options.removeRuleIds ?? [],
        // Structural shape is identical; the polyfill's ResourceType union is narrower.
        addRules: (options.addRules ?? []) as unknown as AddRules,
      }),
    getSessionRules: async () =>
      (await dnr.getSessionRules()).map((rule) => ({ id: rule.id })),
  };
}

function createTabsPort(): TabsPort {
  return {
    create: async (options) => {
      await browser.tabs.create({ url: options.url });
    },
  };
}

function createMessagingPort(): RuntimeMessagingPort {
  return {
    sendMessage: (message) => browser.runtime.sendMessage(message),
  };
}

/**
 * Chrome-only offscreen document adapter. chrome.offscreen.hasDocument only
 * exists since Chrome 116; on 109-115 we optimistically create and treat
 * "already exists" as success.
 */
function createOffscreenPort(): OffscreenPort {
  return {
    hasDocument: async () => {
      if (typeof chrome.offscreen.hasDocument === 'function') {
        return chrome.offscreen.hasDocument();
      }
      return false;
    },
    createDocument: async (url) => {
      try {
        await chrome.offscreen.createDocument({
          url,
          reasons: [chrome.offscreen.Reason.DOM_PARSER],
          justification: OFFSCREEN_JUSTIFICATION,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/single offscreen|already exists/i.test(message)) throw error;
      }
    },
  };
}

/**
 * DOMParser is available in Firefox event pages, so rewriting happens in the
 * background context there; in the Chrome MV3 service worker we need the
 * offscreen document.
 */
function createRewriter(messaging: RuntimeMessagingPort): HtmlRewriter {
  if (typeof DOMParser !== 'undefined') return new DirectHtmlRewriter();
  return new OffscreenHtmlRewriter(
    createOffscreenPort(),
    messaging,
    browser.runtime.getURL(OFFSCREEN_DOCUMENT_PATH),
  );
}

function createService(): CapsiumService {
  const storage = createStoragePort();
  return new CapsiumService({
    loader: new PackageLoader(),
    store: new PackageStore(storage),
    rules: new DnrRuleManager(createDnrPort(), storage),
    rewriter: createRewriter(createMessagingPort()),
    tabs: createTabsPort(),
  });
}

export default defineBackground(() => {
  const service = createService();

  // Recover state after a service-worker / browser restart.
  void service.onStartup();

  browser.runtime.onMessage.addListener((message: unknown) => {
    if (isOpenCapRequest(message)) {
      return service.openFromDataUri(message.dataURI, message.privateKey);
    }
    if (isAddDependencyRequest(message)) {
      return service.addDependencyFromDataUri(
        message.parentCapId,
        message.dataURI,
        message.privateKey,
      );
    }
    return undefined;
  });

  // Periodic expiry sweep (packages live at most maxAgeMs).
  void browser.alarms.create(SWEEP_ALARM_NAME, { periodInMinutes: 30 });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === SWEEP_ALARM_NAME) void service.sweepExpired();
  });
});
