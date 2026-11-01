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

  // ------------------------------------------------------------ page-world fetch
  // Instagram answers some requests made from the extension's isolated world with its app
  // page instead of JSON, so requests are relayed to page-fetch.js (MAIN world) when available.
  let fetchSeq = 0;
  function pageFetch(url, init) {
    if (document.documentElement.getAttribute('data-igt-page-fetch') !== '1') return fetch(url, init);
    return new Promise((resolve, reject) => {
      const id = `igt${Date.now()}_${++fetchSeq}`;
      const signal = init && init.signal;
      const done = (fn, v) => {
        window.removeEventListener('message', onMsg);
        fn(v);
      };
      const onMsg = (ev) => {
        const m = ev.data;
        if (ev.source !== window || !m || m.type !== 'IGT_FETCH_RESULT' || m.id !== id) return;
        if (!m.ok) return done(reject, new TypeError(m.error || 'Failed to fetch'));
        done(resolve, {
          status: m.status,
          url: m.url,
          redirected: m.redirected,
          headers: { get: (k) => (/^content-type$/i.test(k) ? m.contentType : /^retry-after$/i.test(k) ? m.retryAfter || null : null) },
          text: async () => m.text,
        });
      };
      if (signal) {
        if (signal.aborted) return reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
        signal.addEventListener('abort', () => done(reject, Object.assign(new Error('Aborted'), { name: 'AbortError' })), { once: true });
      }
      window.addEventListener('message', onMsg);
      window.postMessage({ type: 'IGT_FETCH', id, url, init: { method: init && init.method, headers: init && init.headers, body: init && init.body } }, '*');
    });
  }

  // Same extra headers instagram.com's own code sends; the claim lives in sessionStorage.
  function extraHeaders() {
    const h = { 'X-ASBD-ID': '129477' };
    try {
      h['X-IG-WWW-Claim'] = sessionStorage.getItem('www-claim-v2') || '0';
    } catch (e) {
      h['X-IG-WWW-Claim'] = '0';
    }
    return h;
  }

  // ---------------------------------------------------------------- engine
  let engine; // assigned below; the API's request hook needs it
  const realApi = IGApi.createApi({
    fetchImpl: pageFetch,
    cookieString: () => document.cookie,
    extraHeaders,
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
    fetchPending: () => currentApi.fetchPending(),
    friendship: (...a) => currentApi.friendship(...a),
    diagnose,
  };

  /** Failure helper: tries a few request variants (direct vs page world) and summarises each. Never includes body data. */
  async function diagnose(userId) {
    const session = IGApi.readSessionFromCookies(document.cookie);
    const headers = Object.assign(IGApi.buildHeaders(session).headers, extraHeaders());
    const id = encodeURIComponent(userId);
    const paths = [
      `/api/v1/friendships/${id}/followers/?count=1`,
      `/api/v1/friendships/${id}/followers/?count=12&search_surface=follow_list_page`,
      `/api/v1/friendships/${id}/following/?count=1`,
      `/api/v1/friendships/show/${id}/`,
    ];
    const out = [`pageScript=${document.documentElement.getAttribute('data-igt-page-fetch') === '1'}`, `page=${location.pathname}`];
    for (const p of paths) {
      for (const [label, fn] of [['direct', (u, i) => fetch(u, i)], ['page', pageFetch]]) {
        try {
          const r = await fn(p, { method: 'GET', credentials: 'include', headers, cache: 'no-store' });
          const t = await r.text();
          out.push(`${label} ${p.replace(id, '<id>')} -> ${r.status} ${t.trim().startsWith('{') ? 'JSON' : 'HTML/other'}${r.redirected ? ` redirected to ${String(r.url || '').replace(/^https?:\/\/[^/]+/, '').split('?')[0].replace(/\d{6,}/g, '<n>')}` : ''}`);
        } catch (e) {
          out.push(`${label} ${p.replace(id, '<id>')} -> ${e && e.message}`);
        }
      }
    }
    return out.join(' | ');
  }

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

  // ----------------------------------------------------------- quick collect
  // Used when Instagram refuses the followers list for this account. Instead of the followers
  // list it asks, for each account you follow, whether that account follows you back
  // (GET /api/v1/friendships/show/<id>/ -> followed_by), which works even when the list does not.
  // Progress is saved, so a stopped run resumes where it left off.
  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = (a, b) => a + Math.random() * (b - a);
  let quickRunning = false;

  /**
   * Instagram refuses the followers API for some accounts, so lists are read from the windows on
   * your own profile page: go to the profile, open the Followers (or Following) window, scroll to the
   * very end and collect every username. Throws an Error (with the reason) when it cannot.
   */
  async function ensureProfilePage(username) {
    const isProfile = () => location.pathname.replace(/\/+$/, '').toLowerCase() === `/${username.toLowerCase()}`;
    if (isProfile()) return;
    // client-side navigation (no page reload, so this script keeps running): click the Profile link
    const nav = document.querySelector(`a[href="/${username}/"]`);
    if (!nav) throw new Error(`Could not open your profile page. Open instagram.com/${username} and run the quick check again.`);
    nav.click();
    for (let i = 0; i < 60 && !isProfile(); i++) await sleepMs(250);
    if (!isProfile()) throw new Error(`Could not open your profile page. Open instagram.com/${username} and run the quick check again.`);
    await sleepMs(1500);
  }

  /** kind: 'followers' | 'following'. report(text, n) gets the number of names read so far. Returns [{u}]. */
  async function scrapeList(username, kind, expected, report) {
    if (!username) throw new Error('Could not tell which account is logged in.');
    report(`Opening your ${kind} window...`, 0);
    await ensureProfilePage(username);
    const textRe = new RegExp(`^[\\d.,]+\\s*[KkMm]?\\s+${kind}$`, 'i');
    const findLink = () => {
      const byHref = document.querySelector(`a[href="/${username}/${kind}/"]`) || document.querySelector(`a[href*="/${kind}"]`);
      if (byHref) return byHref;
      // fallback: any link/button whose text is like "136 followers" / "88 following"
      const els = Array.from(document.querySelectorAll('a, button, [role="link"], [role="button"], li, span'));
      const hit = els.find((el) => textRe.test((el.textContent || '').trim()));
      return hit && (hit.closest('a, button, [role="link"], [role="button"]') || hit);
    };
    // make sure no earlier window is still open
    for (let i = 0; i < 20 && document.querySelector('[role="dialog"]'); i++) await sleepMs(250);
    let link = null;
    for (let i = 0; i < 48 && !link; i++) {
      link = findLink();
      if (!link) await sleepMs(250);
    }
    if (!link) {
      const seen = Array.from(document.querySelectorAll('a[href*="follow"]')).slice(0, 5).map((a) => a.getAttribute('href')).join(', ');
      throw new Error(`Could not find the ${kind} link on your profile page (page: ${location.pathname}${seen ? `, links seen: ${seen}` : ', no follow links on the page'}).`);
    }
    link.click();
    // username links look like /name/ (relative or absolute); returns the username or null
    const userOf = (a) => {
      let p;
      try {
        const u = new URL(a.href || a.getAttribute('href') || '', location.origin);
        if (u.origin !== location.origin) return null;
        p = u.pathname;
      } catch (e) {
        return null;
      }
      const m = /^\/([A-Za-z0-9._]+)\/?$/.exec(p);
      return m ? m[1] : null;
    };
    const titleRe = new RegExp(kind, 'i');
    const pickDialog = () => {
      const all = Array.from(document.querySelectorAll('[role="dialog"]'));
      const withNames = all.filter((d) => Array.from(d.querySelectorAll('a[href]')).some((a) => userOf(a)));
      const titled = withNames.find((d) => titleRe.test((d.textContent || '').slice(0, 200)));
      return titled || withNames.sort((x, y) => y.querySelectorAll('a[href]').length - x.querySelectorAll('a[href]').length)[0] || null;
    };
    let dialog = null;
    for (let i = 0; i < 60 && !dialog; i++) {
      await sleepMs(250);
      dialog = pickDialog();
    }
    if (!dialog) {
      const ds = document.querySelectorAll('[role="dialog"]');
      throw new Error(`No names were found in the ${kind} window (windows open: ${ds.length}, links in them: ${Array.from(ds).reduce((n, d) => n + d.querySelectorAll('a[href]').length, 0)}).`);
    }
    await sleepMs(1500);
    const findScroller = () =>
      Array.from(dialog.querySelectorAll('div')).find((el) => {
        const oy = getComputedStyle(el).overflowY;
        return (oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 20;
      });
    const skip = new Set(['explore', 'reels', 'direct', 'p', 'accounts', 'stories', 'tv', 'about']);
    const me = username.toLowerCase();
    const found = new Map();
    let still = 0;
    // No early stop at the expected count: the window can list extra (disabled) accounts, so keep
    // scrolling until nothing new appears.
    for (let round = 0; round < 800 && still < 8; round++) {
      const before = found.size;
      dialog.querySelectorAll('a[href]').forEach((a) => {
        const name = userOf(a);
        if (!name) return;
        const key = name.toLowerCase();
        if (skip.has(key) || key === me || found.has(key)) return;
        found.set(key, { u: name });
      });
      report(`Reading your ${kind}: ${found.size}${expected ? ` of ${expected}` : ''}. Keep this tab open.`, found.size);
      still = found.size === before ? still + 1 : 0;
      const sc = findScroller();
      if (sc) sc.scrollTop = sc.scrollHeight;
      await sleepMs(jitter(900, 1700));
    }
    const closeBtn = dialog.querySelector('[aria-label="Close"]');
    if (closeBtn) (closeBtn.closest('[role="button"], button') || closeBtn).click();
    else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    for (let i = 0; i < 20 && document.querySelector('[role="dialog"]'); i++) await sleepMs(250);
    if (!found.size) throw new Error(`No names were found in the ${kind} window.`);
    return Array.from(found.values());
  }

  async function quickCollect(report, fresh) {
    if (quickRunning) throw new Error('A quick check is already running in this tab.');
    quickRunning = true;
    try {
      const session = IGApi.readSessionFromCookies(document.cookie);
      const userId = session.ds_user_id;
      if (!userId) throw new Error('Not logged in.');
      const headers = () => Object.assign(IGApi.buildHeaders(IGApi.readSessionFromCookies(document.cookie)).headers, extraHeaders());

      let st = fresh ? null : (await store.get('quickState')).quickState;
      if (!st || st.userId !== userId || !Array.isArray(st.following)) st = { userId, startedAt: Date.now(), following: null, checked: {} };

      // 1. following list (API; works for this account)
      if (!st.following) {
        const map = new Map();
        let cursor = null;
        for (let page = 0; page < 200; page++) {
          report(`Reading your following list: ${map.size} so far`);
          const p = await realApi.fetchPage('following', userId, cursor, { count: 50 });
          cursor = p.nextCursor;
          // Count up one by one instead of jumping a whole page (50) at once. The delay doubles as the pause between requests.
          const wait = cursor ? jitter(1500, 3000) : 600;
          const step = wait / Math.max(1, p.users.length);
          for (const u of p.users) {
            map.set(u.id, u);
            report(`Reading your following list: ${map.size} so far`);
            await sleepMs(step);
          }
          if (!cursor) break;
        }
        st.following = Array.from(map.values());
        await store.set({ quickState: st });
      }

      // 2. for each account: does it follow you back?
      const todo = st.following.filter((u) => st.checked[u.id] === undefined);
      let done = st.following.length - todo.length;
      let bad = 0;
      let rateWaits = 0;
      const t0 = Date.now();
      report(`Checked ${done} of ${st.following.length}. Keep this tab open.`, todo.length * 1050);
      for (let i = 0; i < todo.length; i++) {
        const u = todo[i];
        let r;
        let text = '';
        try {
          r = await pageFetch(`/api/v1/friendships/show/${encodeURIComponent(u.id)}/`, { method: 'GET', credentials: 'include', headers: headers(), cache: 'no-store' });
          text = await r.text();
        } catch (e) {
          bad++;
          if (bad >= 5) throw new Error(`Network problem: ${(e && e.message) || e}. Progress is saved; press the button to resume.`);
          await sleepMs(5000);
          i--;
          continue;
        }
        if (r.status === 429) {
          rateWaits++;
          if (rateWaits > 4) throw new Error(`Instagram asked to slow down (HTTP 429). Progress is saved (${done} of ${st.following.length}). Wait 30 minutes and press the button to resume.`);
          report(`Instagram asked to slow down. Pausing 2 minutes (${done} of ${st.following.length} checked)`);
          await sleepMs(120000);
          i--;
          continue;
        }
        let j = null;
        try {
          j = JSON.parse(text);
        } catch (e) {
          j = null;
        }
        if (!j || typeof j.followed_by !== 'boolean') {
          bad++;
          if (bad >= 5) throw new Error(`Instagram stopped answering with data (HTTP ${r.status}). Progress is saved (${done} of ${st.following.length}). Press the button to resume later.`);
          await sleepMs(8000);
          i--;
          continue;
        }
        bad = 0;
        st.checked[u.id] = j.followed_by ? 1 : 0;
        done++;
        if (done % 10 === 0) await store.set({ quickState: st });
        const perItem = i > 5 ? (Date.now() - t0) / (i + 1) : 1050;
        report(`Checked ${done} of ${st.following.length}. Keep this tab open.`, perItem * (todo.length - i - 1));
        await sleepMs(jitter(700, 1400));
      }
      await store.set({ quickState: st });

      // 3. incoming follow requests (best effort)
      let pending = [];
      let pendingNote = '';
      try {
        const rr = await pageFetch('/api/v1/friendships/pending/', { method: 'GET', credentials: 'include', headers: headers(), cache: 'no-store' });
        const jj = JSON.parse(await rr.text());
        pending = (jj.users || []).filter((u) => u && u.username).map((u) => ({ id: String(u.pk || u.pk_id || u.id || 'u:' + u.username), u: u.username, n: u.full_name || '', p: u.profile_pic_url || '' }));
      } catch (e) {
        pendingNote = 'Follow requests could not be read.';
      }
      // 4. your own totals: the profile endpoint if it answers, else the number shown on this page
      let followersCount = null;
      let username = (location.pathname.split('/').filter(Boolean)[0] || '').replace(/^user /, '');
      try {
        const p = await realApi.fetchProfile(userId);
        followersCount = p.followers;
        username = p.username || username;
      } catch (e) {
        const leaf = Array.from(document.querySelectorAll('header *, main *')).find(
          (el) => el.children.length <= 2 && /^[\d.,]+\s*[KkMm]?\s+followers$/i.test((el.textContent || '').trim())
        );
        const m = leaf && /([\d.,]+)\s*([KkMm])?/.exec(leaf.textContent);
        if (m) {
          let n = parseFloat(m[1].replace(/,/g, ''));
          if (m[2]) n *= /k/i.test(m[2]) ? 1e3 : 1e6;
          if (Number.isFinite(n)) followersCount = Math.round(n);
        }
      }
      // 5. names of the followers you don't follow back: read the followers window, compare it with the following list
      let fans = null;
      let followerNames = null;
      let fansNote = '';
      try {
        const names = await scrapeList(username, 'followers', followersCount, (t) => report(t));
        followerNames = names;
        const followingSet = new Set(st.following.map((u) => String(u.u).toLowerCase()));
        fans = names.filter((f) => !followingSet.has(f.u.toLowerCase())).map((f) => ({ id: 'u:' + f.u.toLowerCase(), u: f.u, n: '', p: '' }));
        fansNote = followersCount != null && names.length < followersCount ? `Only ${names.length} of ${followersCount} followers could be read, so this list may be incomplete.` : `${names.length} follower names were read.`;
      } catch (e) {
        fansNote = `Follower names were not read: ${(e && e.message) || e}`;
      }
      const nonFollowers = st.following.filter((u) => st.checked[u.id] === 0);
      const mutualCount = st.following.filter((u) => st.checked[u.id] === 1).length;
      await store.remove('quickState');
      return { username, followersCount, followingCount: st.following.length, following: st.following, followerNames, fans, fansNote, nonFollowers, mutualCount, pending, pendingNote };
    } finally {
      quickRunning = false;
    }
  }

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
      case 'pending':
        try {
          return { ok: true, count: (await apiProxy.fetchPending()).count };
        } catch (e) {
          return { ok: false, message: `${e.code || 'ERROR'}: ${e.message}` };
        }
      case 'friend':
        if (engine.isRunning()) return { ok: false, message: 'A scan is running. Pause it first.' };
        try {
          return Object.assign({ ok: true }, await apiProxy.friendship(args.action, args.id));
        } catch (e) {
          return { ok: false, message: `${e.code || 'ERROR'}: ${e.message}` };
        }
      case 'captureRaw':
        return engine.captureRaw();
      case 'quick':
        if (engine.isRunning()) return { ok: false, message: 'A scan is running. Pause it first.' };
        try {
          const report = (text, etaMs) => store.set({ quickProgress: { text, ts: Date.now(), etaMs: etaMs == null ? null : etaMs } });
          const data = await quickCollect(report, !!args.fresh);
          await store.remove('quickProgress');
          return Object.assign({ ok: true }, data);
        } catch (e) {
          await store.remove('quickProgress');
          return { ok: false, message: `${e.code ? e.code + ': ' : ''}${(e && e.message) || e}` };
        }
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
