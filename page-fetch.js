/**
 * Runs in the PAGE's own JavaScript world (manifest "world": "MAIN"), so requests made here
 * are indistinguishable from instagram.com's own. The content script (isolated world) asks
 * this script to perform a same-origin fetch via window.postMessage and gets the result back.
 * Only relative /api/ URLs are accepted.
 */
(function () {
  'use strict';
  if (window.__igtPageFetch) return;
  window.__igtPageFetch = true;

  window.addEventListener('message', async (ev) => {
    const m = ev.data;
    if (ev.source !== window || !m || m.type !== 'IGT_FETCH' || typeof m.id !== 'string') return;
    const reply = (payload) => window.postMessage(Object.assign({ type: 'IGT_FETCH_RESULT', id: m.id }, payload), '*');
    try {
      if (typeof m.url !== 'string' || !/^\/api\//.test(m.url)) throw new Error('Blocked URL');
      const init = m.init || {};
      const resp = await fetch(m.url, {
        method: init.method || 'GET',
        credentials: 'include',
        headers: init.headers || {},
        body: init.body,
        cache: 'no-store',
      });
      const text = await resp.text();
      reply({
        ok: true,
        status: resp.status,
        text,
        url: resp.url,
        redirected: resp.redirected,
        contentType: resp.headers.get('content-type') || '',
        retryAfter: resp.headers.get('retry-after') || '',
      });
    } catch (e) {
      reply({ ok: false, error: (e && e.message) || String(e) });
    }
  });

  document.documentElement.setAttribute('data-igt-page-fetch', '1');
})();
