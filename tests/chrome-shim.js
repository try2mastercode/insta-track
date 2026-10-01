/**
 * chrome-shim.js: DEV/TEST ONLY (not part of the extension).
 * A tiny in-page stand-in for the chrome.* APIs so the real side panel and the
 * real content script can run together in an ordinary browser page, talking to the
 * mock Instagram. Served by tools/serve.js at /harness. State persists in
 * localStorage so a page reload behaves like reopening the panel.
 */
(function () {
  const listeners = [];
  const changeListeners = [];
  let data = {};
  try {
    data = JSON.parse(localStorage.getItem('shimdata') || '{}');
  } catch (e) {
    data = {};
  }
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const persist = () => localStorage.setItem('shimdata', JSON.stringify(data));
  const fire = (ch) => changeListeners.forEach((f) => f(ch, 'local'));

  const local = {
    async get(keys) {
      if (keys == null) return clone(data);
      const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const out = {};
      list.forEach((k) => {
        if (k in data) out[k] = clone(data[k]);
      });
      return out;
    },
    async set(obj) {
      const ch = {};
      Object.keys(obj).forEach((k) => {
        ch[k] = { oldValue: clone(data[k]), newValue: clone(obj[k]) };
        data[k] = clone(obj[k]);
      });
      persist();
      fire(ch);
    },
    async remove(keys) {
      const ch = {};
      (typeof keys === 'string' ? [keys] : keys).forEach((k) => {
        if (k in data) {
          ch[k] = { oldValue: clone(data[k]) };
          delete data[k];
        }
      });
      persist();
      fire(ch);
    },
  };

  window.chrome = {
    storage: { local, onChanged: { addListener: (f) => changeListeners.push(f) } },
    runtime: {
      id: 'harness',
      getURL: (p) => '/' + p,
      onMessage: { addListener: (f) => listeners.push(f) },
      async sendMessage(msg) {
        console.log('[shim] runtime.sendMessage', JSON.stringify(msg).slice(0, 120));
        return {};
      },
    },
    tabs: {
      async query() {
        return [{ id: 1, url: 'https://www.instagram.com/' }];
      },
      sendMessage(tabId, msg) {
        return new Promise((resolve) => {
          listeners.forEach((l) => l(msg, {}, resolve));
        });
      },
      create: (o) => console.log('[shim] tabs.create', o.url),
      reload: (id) => console.log('[shim] tabs.reload', id),
      onUpdated: { addListener() {} },
      onRemoved: { addListener() {} },
    },
    windows: { create: (o) => console.log('[shim] windows.create', o.url) },
  };
  window.__shimReset = () => {
    localStorage.removeItem('shimdata');
    location.reload();
  };
})();
