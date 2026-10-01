/**
 * content.js: runs on https://www.instagram.com/*
 * ============================================================================
 * Wires the scan engine to the real browser:
 *   - same-origin fetch with the user's logged-in session (via instagram-api.js)
 *   - chrome.storage.local for all state
 *   - commands from the side panel (start / pause / cancel / preflight / ping ...)
 *   - keep-alive: a Web Lock held during a scan + a periodic harmless ping to the
 *     service worker, so Chrome is less likely to freeze the tab
 *   - best-effort "tab closing" bookkeeping
 *
 * The scan loop lives HERE, not in the side panel or the service worker, so it
 * keeps running when the panel is closed (spec section 4).
 */
(function () {
  'use strict';
  if (window.__igNonFollowersLoaded) return;
  window.__igNonFollowersLoaded = true;

  const store = {
    get: (k) => chrome.storage.local.get(k),
    set: (o) => chrome.storage.local.set(o),
    remove: (k) => chrome.storage.local.remove(k),
  };

  // ---------------------------------------------------------------- engine
  let engine; // assigned below; the API's request hook needs it
  const realApi = IGApi.createApi({
    fetchImpl: (url, init) => fetch(url, init),
    cookieString: () => document.cookie,
    onRequest: (info) => engine && engine.noteRequest(info),
  });

  let mockCache = { key: null, mock: null, api: null };
  let currentApi = realApi;

  /** Real API unless mock mode is enabled in the side panel's developer section. */
  async function refreshApi() {
    const { settings } = await store.get('settings');
    const s = settings || {};
    if (!s.mock) {
      currentApi = realApi;
      engine.configure({ timeScale: 1 });
      return s;
    }
    const key = s.scenario || 'normal';
    if (mockCache.key !== key) {
      const mock = IGMock.createMock({ scenario: key, latencyMs: 250 });
      mockCache = {
        key,
        mock,
        api: IGApi.createApi({
          fetchImpl: mock.fetchImpl,
          cookieString: mock.cookieString,
          onRequest: (info) => engine && engine.noteRequest(Object.assign({}, info, { url: '[mock] ' + info.url })),
        }),
      };
    }
    currentApi = mockCache.api;
    engine.configure({ timeScale: s.fast === false ? 1 : 0.05 });
    return s;
  }

  const apiProxy = {
    readSession: () => currentApi.readSession(),
    fetchPage: (...a) => currentApi.fetchPage(...a),
    fetchProfile: (...a) => currentApi.fetchProfile(...a),
  };

  // ------------------------------------------------------------ keep-alive
  let releaseWebLock = null;
  let keepAliveTimer = null;

  function safeSend(msg) {
    try {
      return chrome.runtime.sendMessage(msg).catch(() => {});
    } catch (e) {
      return Promise.resolve(); // extension context invalidated (extension reloaded)
    }
  }

  function setKeepAlive(on) {
    if (on) {
      if (navigator.locks && !releaseWebLock) {
        navigator.locks.request('ig-nonfollowers-scan', () => new Promise((res) => (releaseWebLock = res))).catch(() => {});
      }
      if (!keepAliveTimer) keepAliveTimer = setInterval(() => safeSend({ type: 'ig:keepalive' }), 25000);
    } else {
      if (releaseWebLock) releaseWebLock();
      releaseWebLock = null;
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
  }

  engine = IGEngine.createEngine({
    storage: store,
    api: apiProxy,
    isOnline: () => navigator.onLine !== false,
    hooks: {
      onEvent: (evt) => safeSend({ type: 'ig:event', event: evt }),
      keepAwake: (on) => {
        setKeepAlive(on); // Web Lock + periodic ping
        safeSend({ type: 'ig:keepAwake', on }); // chrome.power is only available in the service worker
      },
    },
  });

  window.addEventListener('online', () => engine.wake());
  document.addEventListener('visibilitychange', () => engine.setHidden(document.hidden));
  window.addEventListener('pagehide', () => {
    engine.interrupt();
  });

  // -------------------------------------------------------------- commands
  async function handle(msg) {
    await refreshApi();
    const args = msg.args || {};
    switch (msg.cmd) {
      case 'ping':
        return {
          ok: true,
          instanceId: engine.instanceId,
          scanning: engine.isRunning(),
          hidden: document.hidden,
          userId: (apiProxy.readSession() || {}).ds_user_id || '',
          mock: currentApi !== realApi,
        };
      case 'preflight':
        return engine.preflight(args);
      case 'start':
        engine.setHidden(document.hidden);
        return engine.start(args);
      case 'pause':
        return engine.pause();
      case 'cancel':
        return engine.cancel();
      case 'captureRaw':
        return engine.captureRaw();
      default:
        return { ok: false, message: `Unknown command: ${msg.cmd}` };
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'ig:cmd') return false;
    handle(msg)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, message: String((e && e.message) || e) }));
    return true; // async response
  });

  engine.setHidden(document.hidden);
})();
