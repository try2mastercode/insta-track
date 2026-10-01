/**
 * sidepanel.js: display + control surface only.
 * ============================================================================
 * The scan itself runs in the content script on the Instagram tab. This page:
 *   - reads all state from chrome.storage.local and live-updates via storage.onChanged
 *   - sends Start / Pause / Resume / Cancel / Test commands to the content script
 *   - never runs requests to Instagram, so opening/closing/replacing it never
 *     affects a running scan, and reopening it shows current progress immediately.
 */
(function () {
  'use strict';

  const Sh = IGShared;
  const PHASES = ['followers', 'following'];
  const STALE_PROGRESS_MS = 3 * 24 * 3600 * 1000;
  const ROW_H = 56;
  const KEYS = ['scan', 'results', 'importResults', 'errors', 'debuglog', 'ignored', 'lastSession', 'settings', 'rawFirstResponse', 'ack', 'watchdog'];
  const DEFAULTS = { errors: [], debuglog: [], ignored: [], settings: {}, ack: false };
  const PLACEHOLDER =
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36"><rect width="36" height="36" fill="#9aa0a6"/><circle cx="18" cy="14" r="6" fill="#fff"/><path d="M6 33c1-8 6-11 12-11s11 3 12 11z" fill="#fff"/></svg>'
    );

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => Number(n || 0).toLocaleString('en-US');
  const setText = (el, t) => {
    if (el.textContent !== t) el.textContent = t;
  };

  const S = {
    scan: null,
    results: null,
    importResults: null,
    errors: [],
    debuglog: [],
    ignored: [],
    lastSession: null,
    settings: {},
    rawFirstResponse: null,
    ack: false,
    watchdog: null,
    ping: { tabs: 0, loaded: 0, userId: '', scanning: false, mock: false },
    preflight: null,
    busy: false,
    tab: 'scan',
    sub: 'non',
    sort: 'asc',
    search: '',
    showHidden: false,
    source: null,
    importFiles: [],
  };

  // ------------------------------------------------------------------ utils
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => t.classList.remove('show'), 2600);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch (e2) {
        ok = false;
      }
      ta.remove();
      return ok;
    }
  }

  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type: type || 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function modal(o) {
    return new Promise((resolve) => {
      const back = document.createElement('div');
      back.className = 'modal-back';
      back.innerHTML = `<div class="modal" role="dialog" aria-modal="true"><h2>${esc(o.title)}</h2><div class="body">${o.body || ''}</div><div class="actions"></div></div>`;
      const finish = (v) => {
        document.removeEventListener('keydown', onKey);
        back.remove();
        resolve(v);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') finish(null);
      };
      document.addEventListener('keydown', onKey);
      back.addEventListener('click', (e) => {
        if (e.target === back) finish(null);
      });
      let primary = null;
      o.buttons.forEach((b) => {
        const btn = document.createElement('button');
        btn.className = 'btn' + (b.primary ? ' btn-primary' : '') + (b.danger ? ' btn-danger' : '');
        btn.textContent = b.label;
        btn.addEventListener('click', () => finish(b.value));
        $('.actions', back).appendChild(btn);
        if (b.primary) primary = btn;
      });
      $('#modalRoot').appendChild(back);
      (primary || $('.actions button', back)).focus();
    });
  }

  // --------------------------------------------------------------- derived
  function hasProgress(sc) {
    return !!sc && PHASES.some((p) => sc.phases[p].status !== 'not_started' || sc.phases[p].collected > 0);
  }

  function derived() {
    const sc = S.scan;
    const now = Date.now();
    const status = sc ? sc.status : 'none';
    const stalled = status === 'running' && !S.ping.scanning && now - (sc.lastHeartbeat || 0) > 90000;
    let eff = status;
    if (stalled) eff = 'stalled';
    const progress = hasProgress(sc);
    if ((eff === 'idle' || eff === 'none') && !progress) eff = 'none';
    return { sc, now, status, eff, stalled, progress };
  }

  function phaseFraction(ph) {
    if (ph.status === 'complete') return 1;
    if (ph.expected) return Math.min(0.99, ph.collected / ph.expected);
    return 0;
  }

  function phaseText(sc, p) {
    const ph = sc.phases[p];
    const label = p === 'followers' ? 'Followers' : 'Following';
    if (ph.status === 'complete') return `${label} complete (${fmt(ph.collected)})`;
    if (ph.status === 'not_started' && !ph.collected) return `${label} not started`;
    const pct = Math.floor(phaseFraction(ph) * 100);
    return `${label} ${pct}% (${fmt(ph.collected)}${ph.expected ? ' of ' + fmt(ph.expected) : ''})`;
  }

  function summarize(sc) {
    return `${phaseText(sc, 'followers')}. ${phaseText(sc, 'following')}. Saved ${Sh.timeAgo(sc.updatedAt)}.`;
  }

  // ------------------------------------------------------------- messaging
  async function igTabs() {
    try {
      return await chrome.tabs.query({ url: 'https://www.instagram.com/*' });
    } catch (e) {
      return [];
    }
  }

  function sendTab(tabId, msg, ms) {
    return Promise.race([
      chrome.tabs.sendMessage(tabId, msg),
      new Promise((_, rej) => setTimeout(() => rej(new Error('The Instagram tab did not answer (timeout).')), ms || 5000)),
    ]);
  }

  async function pingAll() {
    const tabs = await igTabs();
    const loaded = [];
    await Promise.all(
      tabs.map(async (t) => {
        try {
          const r = await sendTab(t.id, { type: 'ig:cmd', cmd: 'ping' }, 1500);
          if (r && r.ok) loaded.push({ tab: t, ping: r });
        } catch (e) {
          /* content script not loaded in this tab */
        }
      })
    );
    return { tabs, loaded };
  }

  let pingBusy = false;
  async function refreshPing() {
    if (pingBusy) return;
    pingBusy = true;
    try {
      const { tabs, loaded } = await pingAll();
      S.ping = {
        tabs: tabs.length,
        loaded: loaded.length,
        userId: loaded[0] ? loaded[0].ping.userId : '',
        scanning: loaded.some((l) => l.ping.scanning),
        mock: loaded.some((l) => l.ping.mock),
      };
      renderAccount();
      renderBanners();
      renderControls();
    } finally {
      pingBusy = false;
    }
  }

  /** Pre-flight steps 1 and 2 (tab open, content script loaded). */
  async function gatherTabs() {
    const { tabs, loaded } = await pingAll();
    const steps = [];
    const open = tabs.length > 0;
    steps.push({
      id: 'tab',
      label: 'Instagram tab open',
      ok: open,
      detail: open ? `${tabs.length} instagram.com tab${tabs.length === 1 ? '' : 's'} found` : 'Open instagram.com in a tab (and stay logged in).',
      action: open ? null : { act: 'openInstagram', label: 'Open Instagram' },
    });
    if (!open) return { ok: false, steps };
    steps.push({
      id: 'script',
      label: 'Extension active in the Instagram tab',
      ok: loaded.length > 0,
      detail: loaded.length > 0 ? '' : 'Refresh the Instagram tab. (It was open before the extension was installed or reloaded.)',
      action: loaded.length > 0 ? null : { act: 'reloadTabs', label: 'Refresh Instagram tab' },
    });
    if (!loaded.length) return { ok: false, steps };
    return {
      ok: true,
      steps,
      loaded,
      target: loaded[0].tab,
      // Orphaned lock recovery: exactly one tab with the extension, and it is not scanning.
      takeOver: loaded.length === 1 && !loaded[0].ping.scanning,
    };
  }

  function setBusy(b) {
    S.busy = b;
    renderControls();
  }

  async function connectionTest() {
    if (S.busy) return;
    setBusy(true);
    S.preflight = { running: true, steps: [] };
    renderPreflight();
    try {
      const g = await gatherTabs();
      if (!g.ok) {
        S.preflight = { steps: g.steps };
        return;
      }
      const r = await sendTab(g.target.id, { type: 'ig:cmd', cmd: 'preflight', args: { otherTabs: g.loaded.length - 1, takeOver: g.takeOver } }, 90000);
      S.preflight = { steps: g.steps.concat(r.steps || []), ok: !!r.ok, ts: Date.now() };
    } catch (e) {
      S.preflight = { steps: [{ id: 'err', label: 'Connection check', ok: false, detail: e.message }] };
    } finally {
      setBusy(false);
      renderPreflight();
      renderAccount();
    }
  }

  async function startScan(mode, extra) {
    if (S.busy) return;
    setBusy(true);
    S.preflight = { running: true, steps: [] };
    renderPreflight();
    try {
      await startScanInner(mode, extra || {});
    } catch (e) {
      S.preflight = { steps: [{ id: 'err', label: 'Start scan', ok: false, detail: `Could not reach the Instagram tab: ${e.message}. Refresh the Instagram tab and try again.` }] };
    } finally {
      setBusy(false);
      renderPreflight();
    }
  }

  async function startScanInner(mode, extra) {
    const g = await gatherTabs();
    if (!g.ok) {
      S.preflight = { steps: g.steps };
      return;
    }
    const args = Object.assign({ mode, takeOver: g.takeOver, otherTabs: g.loaded.length - 1 }, extra);
    const r = await sendTab(g.target.id, { type: 'ig:cmd', cmd: 'start', args }, 120000);
    S.preflight = { steps: g.steps.concat(r.steps || []), ok: !!r.ok, ts: Date.now() };
    if (r.ok) {
      toast(r.mode === 'fresh' ? 'Scan started' : 'Scan resumed');
      chrome.runtime.sendMessage({ type: 'ig:clearBadge' }).catch(() => {});
    } else if (r.code === 'ACCOUNT_MISMATCH') {
      renderPreflight();
      const c = await modal({
        title: 'Different account logged in',
        body: `<p>${esc(r.message)}</p><p>Saved progress is never resumed for a different account. Start a fresh scan for <strong>@${esc(r.account.username)}</strong>? This discards the saved progress for @${esc(r.savedAccount.username)}.</p>`,
        buttons: [
          { label: 'Cancel', value: null },
          { label: `Start fresh for @${r.account.username}`, value: 'fresh', primary: true },
        ],
      });
      if (c === 'fresh') await startScanInner('fresh', {});
    } else if (r.code === 'ALREADY_RUNNING') {
      toast('A scan is already running.');
    } else if (!r.steps) {
      S.preflight.steps.push({ id: 'err', label: 'Start scan', ok: false, detail: r.message || 'Start failed' });
    }
  }

  async function scanningTab() {
    const { loaded } = await pingAll();
    return loaded.find((l) => l.ping.scanning) || loaded[0] || null;
  }

  // --------------------------------------------------------------- actions
  async function onStart() {
    const d = derived();
    if (S.busy) return;
    if (d.eff === 'complete') {
      const c = await modal({
        title: 'Start a new scan?',
        body: '<p>The previous scan finished. Starting a new one scans both lists again and replaces the saved results.</p>',
        buttons: [
          { label: 'Cancel', value: null },
          { label: 'Start new scan', value: 'go', primary: true },
        ],
      });
      if (c === 'go') startScan('fresh');
      return;
    }
    if (d.progress) {
      await resumeChoice();
      return;
    }
    startScan('fresh');
  }

  /** Resume or Start fresh, showing exactly what is saved (spec section 7). */
  async function resumeChoice() {
    const sc = S.scan;
    const stale = Date.now() - sc.updatedAt > STALE_PROGRESS_MS;
    const mismatch = S.ping.userId && sc.account && S.ping.userId !== sc.account.id;
    let body = `<p><strong>Saved progress for @${esc(sc.account ? sc.account.username : '?')}:</strong><br>${esc(summarize(sc))}</p>`;
    if (stale) {
      body += `<p class="notice warn">This progress is more than 3 days old. People may have followed or unfollowed since, so starting fresh is recommended.</p>`;
    }
    if (mismatch) {
      body += `<p class="notice warn">A different Instagram account is logged in. Saved progress cannot be resumed for it.</p>`;
    }
    const buttons = [{ label: 'Cancel', value: null }];
    buttons.push({ label: 'Start fresh', value: 'fresh', primary: stale || mismatch });
    if (!mismatch) buttons.push({ label: 'Resume', value: 'resume', primary: !stale });
    const c = await modal({ title: 'Resume or start fresh?', body, buttons });
    if (c === 'resume') startScan('resume');
    else if (c === 'fresh') startScan('fresh');
  }

  async function onResume() {
    if (S.busy) return;
    const sc = S.scan;
    if (sc && Date.now() - sc.updatedAt > STALE_PROGRESS_MS) {
      await resumeChoice();
      return;
    }
    startScan('resume');
  }

  async function onFresh() {
    const c = await modal({
      title: 'Discard saved progress?',
      body: '<p>Start fresh scans both lists again from the beginning. Saved progress and results are replaced.</p>',
      buttons: [
        { label: 'Cancel', value: null },
        { label: 'Start fresh', value: 'go', danger: true },
      ],
    });
    if (c === 'go') startScan('fresh');
  }

  async function onPause() {
    try {
      const t = await scanningTab();
      if (!t) return toast('No Instagram tab with the extension was found.');
      await sendTab(t.tab.id, { type: 'ig:cmd', cmd: 'pause' }, 8000);
      toast('Pausing after the current request...');
    } catch (e) {
      toast(e.message);
    }
  }

  async function onCancel() {
    try {
      const t = await scanningTab();
      if (t) {
        await sendTab(t.tab.id, { type: 'ig:cmd', cmd: 'cancel' }, 8000);
      } else if (S.scan && S.scan.status !== 'complete') {
        const sc = Object.assign({}, S.scan, { status: 'cancelled', pauseReason: null, statusText: 'Cancelled. Progress is saved.', waitUntil: null });
        await chrome.storage.local.set({ scan: sc });
        await chrome.storage.local.remove('lock');
      }
      toast('Scan cancelled. Progress is saved.');
    } catch (e) {
      toast(e.message);
    }
  }

  async function onClear() {
    const d = derived();
    if (d.eff === 'running') return toast('Pause or cancel the running scan first.');
    const c = await modal({
      title: 'Clear stored data?',
      body: '<p>This permanently deletes saved scan progress, both account lists, results, imported results, the error log and the debug log from this browser.</p><p class="muted small">Your hidden-accounts list and settings are kept.</p>',
      buttons: [
        { label: 'Cancel', value: null },
        { label: 'Delete everything', value: 'go', danger: true },
      ],
    });
    if (c !== 'go') return;
    await chrome.storage.local.remove(['scan', 'users_followers', 'users_following', 'results', 'importResults', 'errors', 'debuglog', 'lock', 'rawFirstResponse', 'watchdog']);
    S.preflight = null;
    chrome.runtime.sendMessage({ type: 'ig:clearBadge' }).catch(() => {});
    renderAll();
    toast('Stored data cleared.');
  }

  // --------------------------------------------------------------- renders
  function renderAccount() {
    const d = derived();
    const el = $('#accountBar');
    let html;
    if (d.sc && d.progress && d.eff !== 'complete' && d.sc.account) {
      html = `Scanning account <span class="who">@${esc(d.sc.account.username)}</span>`;
    } else if (S.lastSession) {
      html = `Logged in as <span class="who">@${esc(S.lastSession.username)}</span> <span class="muted">(checked ${esc(Sh.timeAgo(S.lastSession.checkedAt))})</span>`;
    } else {
      html = 'Account not checked yet. Press <em>Test connection</em>.';
    }
    if (S.ping.userId && S.lastSession && S.ping.userId !== S.lastSession.id) {
      html += ' <span class="pill pill-warn">account changed, re-test</span>';
    }
    if (el.innerHTML !== html) el.innerHTML = html;
    $('#mockBadge').hidden = !(S.settings && S.settings.mock);
  }

  const ERROR_ADVICE = {
    ACTION_BLOCKED: 'Instagram is restricting this account. Stop now and wait at least 30 minutes (ideally longer) before pressing Resume.',
    SESSION_EXPIRED: 'Log in again in the Instagram tab, then press Resume. Progress is saved.',
    CHALLENGE_REQUIRED: 'Complete the verification Instagram is asking for in the Instagram tab, then press Resume.',
    RATE_LIMITED_429: 'Instagram kept answering "too many requests". Wait a while (30+ minutes) and press Resume.',
    SOFT_FAIL: 'Instagram answered with a failure message. Check the Errors tab for its exact text before resuming.',
    UNEXPECTED_RESPONSE_FORMAT: 'The response did not look like what the extension expects; Instagram may have changed its API. Open Debug, press "Save raw first response" and paste it to Claude Code.',
    WRONG_ORIGIN_OR_HTML_RESPONSE: 'Instagram returned a web page instead of data. Make sure you are logged in in the Instagram tab, then press Resume. If it keeps happening, copy the error log.',
    MISSING_HEADER_OR_TOKEN: 'A required cookie or header was empty. Reload the Instagram tab and make sure you are logged in.',
    PAGINATION_ERROR: 'Paging got stuck. Start fresh, or copy the error log if it repeats.',
    NETWORK_ERROR: 'Network problems persisted. Check your connection and press Resume.',
  };

  function bannerList() {
    const d = derived();
    const sc = d.sc;
    const out = [];
    if (S.ping.tabs === 0) {
      out.push({ cls: '', title: 'No Instagram tab open', html: 'The scan runs inside an instagram.com tab.', btn: [{ act: 'openInstagram', label: 'Open Instagram' }] });
    } else if (S.ping.loaded === 0) {
      out.push({ cls: 'warn', title: 'Refresh the Instagram tab', html: 'The extension is not active in the open Instagram tab yet.', btn: [{ act: 'reloadTabs', label: 'Refresh Instagram tab' }] });
    } else if (S.ping.loaded > 1) {
      out.push({ cls: 'warn', title: 'More than one Instagram tab is open', html: 'Close the extra tabs. Only one tab may run a scan (two at once cause rate limiting).' });
    }
    if (sc && d.progress && sc.account && S.ping.userId && sc.account.id !== S.ping.userId && d.eff !== 'complete') {
      out.push({ cls: 'warn', title: 'Different account logged in', html: `Saved progress belongs to @${esc(sc.account.username)}. It will not be resumed for the account that is logged in now; you can start fresh.` });
    }
    if (d.eff === 'stalled') {
      out.push({
        cls: 'warn',
        title: 'Scan not responding',
        html: `No heartbeat for ${esc(Sh.formatDuration(d.now - (sc.lastHeartbeat || d.now)))}. The Instagram tab may have been closed, reloaded, or discarded by Chrome's Memory Saver. Progress is saved; press Resume.`,
      });
    }
    if (sc && sc.status === 'paused' && sc.pauseReason === 'error' && sc.lastError) {
      out.push({
        cls: 'err',
        title: `Paused on error: ${esc(sc.lastError.code)}`,
        html: `${esc(sc.lastError.message)}<br><span class="muted">${esc(ERROR_ADVICE[sc.lastError.code] || 'Progress is saved. Press Resume to retry the same batch.')}</span>`,
        btn: [{ act: 'viewErrors', label: 'View error details' }],
      });
    } else if (sc && sc.status === 'paused' && sc.pauseReason === 'interrupted') {
      out.push({ cls: 'warn', title: 'Instagram tab was closed or reloaded', html: 'Progress is saved. Open Instagram and press Resume.' });
    }
    if (sc && sc.notice && (sc.status === 'running' || sc.status === 'paused')) {
      out.push({ cls: '', title: 'Saved position expired', html: esc(sc.notice) });
    }
    if (sc && d.progress && d.eff !== 'complete' && d.eff !== 'running' && d.now - sc.updatedAt > STALE_PROGRESS_MS) {
      out.push({ cls: 'warn', title: 'Saved progress is more than 3 days old', html: 'People may have followed or unfollowed since. Starting fresh is recommended.' });
    }
    if (S.watchdog && S.watchdog.stalled && d.eff === 'stalled') {
      out.push({ cls: 'err', title: 'SCAN_STALLED', html: 'The watchdog saw no heartbeat for more than 5 minutes.' });
    }
    return out;
  }

  let lastBannerKey = '';
  function renderBanners() {
    const list = bannerList();
    const key = JSON.stringify(list);
    if (key === lastBannerKey) return;
    lastBannerKey = key;
    $('#banners').innerHTML = list
      .map(
        (b) =>
          `<div class="banner ${b.cls}"><strong>${b.title}</strong>${b.html}${(b.btn || [])
            .map((x) => `<br><button class="btn btn-small" data-act="${x.act}">${esc(x.label)}</button>`)
            .join('')}</div>`
      )
      .join('');
  }

  function renderPreflight() {
    const ul = $('#preflightList');
    const p = S.preflight;
    let html;
    if (!p) {
      html = '<li class="muted">Not run yet. It also runs automatically before every scan.</li>';
    } else if (p.running) {
      html = '<li class="muted"><span class="mark">&hellip;</span> Checking the connection&hellip;</li>';
    } else {
      html = p.steps
        .map(
          (s) =>
            `<li class="${s.warn ? 'warn' : s.ok ? 'ok' : 'fail'}"><span class="mark">${s.warn ? '!' : s.ok ? '&#10003;' : '&#10007;'}</span><div>${esc(s.label)}${s.detail ? `<span class="detail">${esc(s.detail)}</span>` : ''}${
              s.action ? `<br><button class="btn btn-small" data-act="${s.action.act}">${esc(s.action.label)}</button>` : ''
            }</div></li>`
        )
        .join('');
      if (p.ok) html += '<li class="ok"><span class="mark">&#10003;</span><div>All checks passed</div></li>';
    }
    if (ul.innerHTML !== html) ul.innerHTML = html;
  }

  function renderControls() {
    const d = derived();
    const show = { start: false, resume: false, pause: false, cancel: false, fresh: false };
    let startLabel = 'Start scan';
    switch (d.eff) {
      case 'running':
        show.pause = show.cancel = true;
        break;
      case 'stalled':
        show.resume = show.fresh = show.cancel = true;
        break;
      case 'paused':
        show.resume = show.fresh = true;
        break;
      case 'complete':
        show.start = true;
        startLabel = 'Scan again';
        break;
      case 'idle':
      case 'cancelled':
        show.start = true;
        startLabel = d.progress ? 'Continue or start over...' : 'Start scan';
        break;
      default:
        show.start = true;
    }
    Object.keys(show).forEach((k) => {
      const b = $('#btn' + k[0].toUpperCase() + k.slice(1));
      b.hidden = !show[k];
      b.disabled = S.busy;
    });
    setText($('#btnStart'), startLabel);
    $('#btnTest').disabled = S.busy || d.eff === 'running';
    $('#btnClear').disabled = S.busy || d.eff === 'running';
    // settings can't change under a running scan
    ['#mockToggle', '#mockScenario', '#mockFast'].forEach((s) => ($(s).disabled = d.eff === 'running'));
  }

  function renderProgress() {
    const d = derived();
    const sc = d.sc;
    const card = $('#progressCard');
    const savedCard = $('#savedCard');
    if (!sc || !d.progress) {
      card.hidden = true;
      savedCard.hidden = true;
      return;
    }
    card.hidden = false;
    savedCard.hidden = d.eff === 'running' || d.eff === 'complete';
    if (!savedCard.hidden) setText($('#savedSummary'), summarize(sc));

    const exp = PHASES.map((p) => sc.phases[p].expected || 0);
    const fr = PHASES.map((p) => phaseFraction(sc.phases[p]));
    const totalExp = exp[0] + exp[1];
    let overall = totalExp ? (fr[0] * exp[0] + fr[1] * exp[1]) / totalExp : (fr[0] + fr[1]) / 2;
    if (d.eff === 'complete') overall = 1;
    const pct = Math.floor(overall * 100);
    $('#overallFill').style.width = pct + '%';
    $('#overallFill').classList.toggle('done', d.eff === 'complete');
    setText($('#overallPct'), `${pct}%`);

    PHASES.forEach((p, i) => {
      const ph = sc.phases[p];
      const label = p === 'followers' ? 'Followers' : 'Following';
      const ppct = Math.floor(fr[i] * 100);
      const total = ph.expected ? fmt(ph.expected) : '?';
      const done = ph.status === 'complete';
      setText($('#phase' + (i ? 'Following' : 'Followers') + 'Label'), `${label}: ${ppct}% (${fmt(ph.collected)} / ${done && ph.collected > ph.expected ? fmt(ph.collected) : total})`);
      const fill = $('#phase' + (i ? 'Following' : 'Followers') + 'Fill');
      fill.style.width = ppct + '%';
      fill.classList.toggle('done', done);
    });

    // status pill + text + ETA
    const waiting = sc.waitUntil && sc.waitUntil > d.now ? Math.ceil((sc.waitUntil - d.now) / 1000) : 0;
    const errWait = sc.waitReason === 'rate_limit' || sc.waitReason === 'network_retry';
    let pill = ['Idle', ''];
    let status = sc.statusText || '';
    let eta = '';
    switch (d.eff) {
      case 'running':
        pill = ['Running', 'pill-ok'];
        if (errWait && waiting) {
          eta = `Waiting, resuming in ${waiting}s`;
          pill = ['Waiting', 'pill-warn'];
        } else if (sc.waitReason === 'offline') {
          eta = 'Waiting for the connection';
        } else {
          eta = Sh.etaText(sc.eta);
          if (waiting && sc.waitReason === 'long_pause') status += ` (${waiting}s left)`;
        }
        break;
      case 'stalled':
        pill = ['Stalled', 'pill-warn'];
        status = 'Scan not responding';
        eta = 'Paused';
        break;
      case 'paused':
        pill = sc.pauseReason === 'error' ? ['Paused on error', 'pill-err'] : sc.pauseReason === 'interrupted' ? ['Interrupted', 'pill-warn'] : ['Paused', 'pill-warn'];
        eta = 'Paused';
        break;
      case 'complete':
        pill = ['Complete', 'pill-ok'];
        eta = 'Done';
        break;
      case 'cancelled':
      case 'idle':
        pill = ['Cancelled', ''];
        eta = 'Not running';
        break;
    }
    const pillEl = $('#statusPill');
    setText(pillEl, pill[0]);
    pillEl.className = 'pill ' + pill[1];
    setText($('#etaText'), eta);
    setText($('#statusText'), status);
    $('#bgText').hidden = !(d.eff === 'running' && sc.tabHidden);
    const extra = d.eff === 'running' && sc.lastTickAt ? Math.min(d.now - sc.lastTickAt, 60000) : 0;
    setText($('#timeText'), `This session: ${Sh.formatDuration(sc.sessionActiveMs + extra)} · Total scanning time so far: ${Sh.formatDuration(sc.totalActiveMs + extra)}`);
    setText($('#progressTitle'), d.eff === 'complete' ? 'Scan finished' : 'Progress');
  }

  function renderScan() {
    renderBanners();
    renderPreflight();
    renderProgress();
    renderControls();
    $('#firstRun').hidden = S.ack;
  }

  // -------------------------------------------------------------- results
  function currentResults() {
    const a = S.results;
    const b = S.importResults;
    let pick = S.source;
    if (pick === 'scan' && !a) pick = null;
    if (pick === 'import' && !b) pick = null;
    if (!pick) pick = a && b ? (a.computedAt >= b.computedAt ? 'scan' : 'import') : a ? 'scan' : b ? 'import' : null;
    return pick ? { kind: pick, data: pick === 'scan' ? a : b } : null;
  }

  const keyOf = (u) => String(u.id);
  let V = { items: [], showHidden: false };

  function computeList(res) {
    const ignored = new Set(S.ignored);
    const base = S.sub === 'non' ? res.data.nonFollowers : res.data.fans;
    const q = S.search.trim().toLowerCase();
    let list = base.filter((u) => ignored.has(keyOf(u)) === S.showHidden);
    if (q) list = list.filter((u) => u.u.toLowerCase().includes(q) || (u.n || '').toLowerCase().includes(q));
    list = list.slice().sort((x, y) => x.u.toLowerCase().localeCompare(y.u.toLowerCase()));
    if (S.sort === 'desc') list.reverse();
    return { list, ignored, base };
  }

  function resBanners(res) {
    const d = res.data;
    const out = [];
    if (res.kind === 'scan') {
      d.incomplete.forEach((inc) => {
        const label = inc.phase === 'followers' ? 'Followers' : 'Following';
        out.push(
          `<div class="banner err"><strong>INCOMPLETE_DATA</strong>${label}: collected ${fmt(inc.collected)} of ${fmt(inc.expected)}, results may be incomplete.<br><button class="btn btn-small" data-act="rescan" data-phase="${inc.phase}">Re-scan ${label.toLowerCase()}</button></div>`
        );
      });
      if (d.countsUnavailable) out.push('<div class="banner warn"><strong>Completeness not verified</strong>The profile totals could not be read, so the lists could not be checked.</div>');
      if (d.stale24h) out.push('<div class="banner">The Followers and Following lists were collected more than 24 hours apart, so small inaccuracies are possible.</div>');
    } else {
      out.push('<div class="banner">Imported from an Instagram data export. Matched by <strong>username</strong> (the export has no numeric IDs), so renamed accounts may be wrong.</div>');
    }
    return out.join('');
  }

  function renderResults() {
    const res = currentResults();
    const d = derived();
    const empty = $('#resEmpty');
    const body = $('#resBody');
    if (!res) {
      body.hidden = true;
      empty.hidden = false;
      empty.innerHTML =
        d.progress && d.eff !== 'complete'
          ? '<p><strong>Scan in progress</strong></p><p>The list appears only after both lists are complete and verified, so you never see a partial result as if it were final.</p>'
          : '<p><strong>No results yet</strong></p><p>Run a scan from the Scan tab, or import an Instagram data export from the Import tab.</p>';
      return;
    }
    empty.hidden = true;
    body.hidden = false;

    const sel = $('#resSource');
    sel.hidden = !(S.results && S.importResults);
    if (!sel.hidden) {
      sel.innerHTML = `<option value="scan">Live scan</option><option value="import">Data export</option>`;
      sel.value = res.kind;
    }

    const ignored = new Set(S.ignored);
    const visibleNon = res.data.nonFollowers.filter((u) => !ignored.has(keyOf(u))).length;
    const visibleFans = res.data.fans.filter((u) => !ignored.has(keyOf(u))).length;
    const hiddenHere = (S.sub === 'non' ? res.data.nonFollowers : res.data.fans).filter((u) => ignored.has(keyOf(u))).length;
    const flag = res.kind === 'scan' && res.data.incomplete.length ? ' (may be incomplete)' : '';
    setText($('#resCount'), `${fmt(visibleNon)} ${visibleNon === 1 ? "person doesn't" : "people don't"} follow you back${flag}`);
    const checks = res.data.checks;
    setText(
      $('#resMeta'),
      res.kind === 'scan'
        ? `@${res.data.username} · ${Sh.timeAgo(res.data.computedAt)} · ${fmt(checks.followers.collected)} followers, ${fmt(checks.following.collected)} following${S.ignored.length ? ` · ${fmt(hiddenCount(res))} hidden` : ''}`
        : `Data export · ${Sh.timeAgo(res.data.computedAt)} · ${fmt(res.data.counts.followers)} followers, ${fmt(res.data.counts.following)} following`
    );
    const rb = resBanners(res);
    if ($('#resBanners').innerHTML !== rb) $('#resBanners').innerHTML = rb;
    setText($('#cntNon'), fmt(visibleNon));
    setText($('#cntFans'), fmt(visibleFans));
    $$('.subtab').forEach((b) => b.classList.toggle('active', b.dataset.sub === S.sub));
    setText($('#btnHidden'), S.showHidden ? 'Back to list' : `Hidden (${fmt(hiddenHere)})`);
    setText($('#btnSort'), S.sort === 'asc' ? 'A → Z' : 'Z → A');
    renderList();
  }

  function hiddenCount(res) {
    const ignored = new Set(S.ignored);
    const ids = new Set();
    res.data.nonFollowers.concat(res.data.fans).forEach((u) => {
      if (ignored.has(keyOf(u))) ids.add(keyOf(u));
    });
    return ids.size;
  }

  function renderList(keepScroll) {
    const res = currentResults();
    if (!res) return;
    const { list } = computeList(res);
    V = { items: list, showHidden: S.showHidden };
    const wrap = $('#listWrap');
    if (!keepScroll) wrap.scrollTop = 0;
    $('#listSpacer').style.height = Math.max(list.length * ROW_H, 0) + 'px';
    if (!list.length) {
      $('#listRows').innerHTML = `<div class="empty">${S.showHidden ? 'No hidden accounts.' : S.search ? 'No matches.' : S.sub === 'fans' ? 'No fans: you follow everyone who follows you.' : 'Everyone you follow follows you back.'}</div>`;
      $('#listSpacer').style.height = '120px';
      $('#listRows').style.transform = 'none';
      return;
    }
    paintRows();
  }

  function paintRows() {
    const wrap = $('#listWrap');
    const items = V.items;
    if (!items.length) return;
    const first = Math.max(0, Math.floor(wrap.scrollTop / ROW_H) - 6);
    const last = Math.min(items.length, first + Math.ceil((wrap.clientHeight || 400) / ROW_H) + 12);
    let html = '';
    for (let i = first; i < last; i++) {
      const u = items[i];
      const pic = /^https:\/\//.test(u.p || '') ? u.p : PLACEHOLDER;
      const href = `https://www.instagram.com/${encodeURIComponent(u.u)}/`;
      html += `<div class="row-item"><img class="avatar" src="${esc(pic)}" referrerpolicy="no-referrer" loading="lazy" alt=""><div class="who-col"><a href="${esc(href)}" target="_blank" rel="noopener noreferrer">@${esc(u.u)}</a><span>${esc(u.n || '')}</span></div><button class="btn btn-small" data-act="${V.showHidden ? 'unhide' : 'hide'}" data-key="${esc(keyOf(u))}">${V.showHidden ? 'Unhide' : 'Hide'}</button></div>`;
    }
    const rows = $('#listRows');
    rows.style.transform = `translateY(${first * ROW_H}px)`;
    rows.innerHTML = html;
  }

  function visibleListForExport() {
    const res = currentResults();
    if (!res) return [];
    const ignored = new Set(S.ignored);
    const base = S.sub === 'non' ? res.data.nonFollowers : res.data.fans;
    return base.filter((u) => !ignored.has(keyOf(u))).sort((x, y) => x.u.toLowerCase().localeCompare(y.u.toLowerCase()));
  }

  async function setIgnored(list) {
    S.ignored = list;
    await chrome.storage.local.set({ ignored: list });
    renderResults();
  }

  // --------------------------------------------------------------- errors
  function errorText(e) {
    return [
      `[${new Date(e.ts).toISOString()}] ${e.code} | phase ${e.phase} | batch ${e.batch == null ? '-' : e.batch} | HTTP ${e.status == null ? '-' : e.status} | retries ${e.retryCount}${e.autoRetrying ? ' | auto-retrying' : ''}`,
      `  message: ${e.message}`,
      e.url ? `  url: ${e.url}` : null,
      e.nextRetryAt ? `  next retry: ${new Date(e.nextRetryAt).toISOString()}` : null,
      e.note ? `  note: ${e.note}` : null,
      e.snippet ? `  response: ${e.snippet}` : null,
    ]
      .filter(Boolean)
      .join('\n');
  }

  function retryable(e) {
    if (e.autoRetrying) return null;
    if (e.phase === 'Pre-flight') return { label: 'Test again', kind: 'preflight' };
    if (e.code === 'INCOMPLETE_DATA' && e.note) return { label: `Re-scan ${e.note}`, kind: 'rescan', phase: e.note };
    if (e.phase === 'Import' || e.phase === 'Compare') return null;
    return { label: 'Retry', kind: 'resume' };
  }

  function renderErrors() {
    const list = S.errors.slice().reverse();
    const stopped = S.errors.filter((e) => !e.autoRetrying).length;
    const auto = S.errors.length - stopped;
    const badge = $('#errBadge');
    badge.hidden = !stopped;
    setText(badge, String(stopped));
    setText($('#errSummary'), S.errors.length ? `${S.errors.length} entries · ${auto} auto-retrying · ${stopped} stopped` : 'No errors logged.');
    $('#errList').innerHTML = list.length
      ? list
          .map((e) => {
            const r = retryable(e);
            return `<div class="err-card ${e.autoRetrying ? 'retrying' : ''}">
              <div class="head"><span class="code">${esc(e.code)}</span>${e.autoRetrying ? '<span class="pill pill-warn">auto-retrying</span>' : ''}<span class="muted small">${esc(new Date(e.ts).toLocaleString())}</span></div>
              <div>${esc(e.message)}</div>
              <dl><dt>Phase</dt><dd>${esc(e.phase)}</dd><dt>Batch</dt><dd>${e.batch == null ? '-' : esc(e.batch)}</dd><dt>HTTP status</dt><dd>${e.status == null ? '-' : esc(e.status)}</dd><dt>Retry count</dt><dd>${esc(e.retryCount)}</dd>${
                e.nextRetryAt ? `<dt>Next retry</dt><dd>${esc(new Date(e.nextRetryAt).toLocaleTimeString())}</dd>` : ''
              }${e.url ? `<dt>Request</dt><dd>${esc(e.url)}</dd>` : ''}</dl>
              ${e.note ? `<div class="small muted">${esc(e.note)}</div>` : ''}
              ${e.snippet ? `<pre>${esc(e.snippet)}</pre>` : ''}
              ${r ? `<button class="btn btn-small" data-act="retry" data-id="${esc(e.id)}">${esc(r.label)}</button>` : ''}
            </div>`;
          })
          .join('')
      : '<div class="empty">No errors. Failures will appear here with their code, HTTP status and raw response.</div>';
  }

  // ---------------------------------------------------------------- debug
  function rawDisplay() {
    const r = S.rawFirstResponse;
    if (!r) return null;
    return `Instagram raw response (${r.kind}${r.code ? ' ' + r.code : ''}, HTTP ${r.status == null ? '?' : r.status}, ${r.url || ''}, ${new Date(r.ts).toISOString()})\n\n${r.text || ''}`;
  }

  function renderDebug() {
    const pre = $('#debugLog');
    const text = S.debuglog.slice(-400).join('\n');
    if (pre.textContent !== text) {
      pre.textContent = text || 'No requests logged yet.';
      pre.scrollTop = pre.scrollHeight;
    }
    const raw = rawDisplay();
    const ta = $('#rawText');
    if ((raw || '') !== ta.value) ta.value = raw || '';
    setText($('#rawInfo'), S.rawFirstResponse ? `Saved ${Sh.timeAgo(S.rawFirstResponse.ts)} (${S.rawFirstResponse.kind}).` : '');
  }

  // --------------------------------------------------------------- import
  function renderImport() {
    const files = S.importFiles;
    setText($('#importSel'), files.length ? `${files.length} file${files.length === 1 ? '' : 's'} selected: ${files.map((f) => f.name).join(', ')}` : '');
    $('#btnImport').disabled = !files.length;
  }

  async function runImport() {
    const msg = $('#importMsg');
    msg.innerHTML = '';
    try {
      const files = await Promise.all(S.importFiles.map(async (f) => ({ name: f.name, text: await f.text() })));
      const parsed = Sh.parseExportFiles(files);
      const cmp = Sh.computeByUsernames(parsed.followers, parsed.following);
      const importResults = {
        source: 'import',
        computedAt: Date.now(),
        counts: { followers: new Set(parsed.followers.map((n) => n.toLowerCase())).size, following: new Set(parsed.following.map((n) => n.toLowerCase())).size },
        files: parsed.fileCounts,
        skipped: parsed.skipped,
        nonFollowers: cmp.nonFollowers,
        fans: cmp.fans,
        mutualCount: cmp.mutualCount,
      };
      await chrome.storage.local.set({ importResults });
      S.source = 'import';
      S.sub = 'non';
      msg.innerHTML = `<div class="banner ok"><strong>Done</strong>${fmt(cmp.nonFollowers.length)} people you follow don't follow you back (${parsed.fileCounts.followers} followers file${parsed.fileCounts.followers === 1 ? '' : 's'}, ${parsed.fileCounts.following} following file${parsed.fileCounts.following === 1 ? '' : 's'}).${
        parsed.skipped.length ? `<br>Ignored unrelated file(s): ${esc(parsed.skipped.join(', '))}` : ''
      }</div>`;
      switchTab('results');
    } catch (e) {
      const text = e.name === 'ParseError' ? e.message : `Could not read the files: ${e.message}`;
      msg.innerHTML = `<div class="banner err"><strong>Import failed (PARSE_ERROR)</strong>${esc(text)}</div>`;
      const { errors } = await chrome.storage.local.get('errors');
      const list = errors || [];
      list.push({ id: `e${Date.now()}-imp`, ts: Date.now(), phase: 'Import', batch: null, code: 'PARSE_ERROR', status: null, message: text, url: '', snippet: '', retryCount: 0, autoRetrying: false, nextRetryAt: null, note: null });
      await chrome.storage.local.set({ errors: list.slice(-1000) });
    }
  }

  // ----------------------------------------------------------- tabs, init
  function switchTab(name) {
    S.tab = name;
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    $$('.pane').forEach((p) => p.classList.toggle('active', p.id === 'pane-' + name));
    if (name === 'results') requestAnimationFrame(() => renderList(true));
    if (name === 'debug') renderDebug();
    if (name === 'errors') renderErrors();
  }

  function renderSettings() {
    const s = S.settings || {};
    $('#mockToggle').checked = !!s.mock;
    $('#mockFast').checked = s.fast !== false;
    $('#mockScenario').value = s.scenario || 'normal';
    $('#devCard').open = $('#devCard').open || !!s.mock;
  }

  async function saveSettings() {
    const settings = { mock: $('#mockToggle').checked, scenario: $('#mockScenario').value, fast: $('#mockFast').checked };
    await chrome.storage.local.set({ settings });
    refreshPing();
  }

  function renderAll() {
    renderAccount();
    renderScan();
    renderResults();
    renderErrors();
    renderDebug();
    renderImport();
    renderSettings();
  }

  // ------------------------------------------------------- click delegation
  const ACTS = {
    test: connectionTest,
    start: onStart,
    resume: onResume,
    pause: onPause,
    cancel: onCancel,
    fresh: onFresh,
    clear: onClear,
    ackFirstRun: async () => {
      S.ack = true;
      await chrome.storage.local.set({ ack: true });
      renderScan();
    },
    openWindow: () => chrome.windows.create({ url: chrome.runtime.getURL('sidepanel.html'), type: 'popup', width: 430, height: 780 }),
    openInstagram: () => chrome.tabs.create({ url: 'https://www.instagram.com/' }),
    reloadTabs: async () => {
      const tabs = await igTabs();
      tabs.forEach((t) => chrome.tabs.reload(t.id));
      toast('Refreshing the Instagram tab...');
      setTimeout(refreshPing, 2500);
    },
    viewErrors: () => switchTab('errors'),
    sort: () => {
      S.sort = S.sort === 'asc' ? 'desc' : 'asc';
      renderResults();
    },
    toggleHidden: () => {
      S.showHidden = !S.showHidden;
      renderResults();
    },
    hide: (el) => setIgnored(Array.from(new Set(S.ignored.concat(el.dataset.key)))),
    unhide: (el) => setIgnored(S.ignored.filter((k) => k !== el.dataset.key)),
    exportCsv: () => {
      const rows = visibleListForExport();
      if (!rows.length) return toast('Nothing to export.');
      const name = `instagram-${S.sub === 'non' ? 'non-followers' : 'fans'}-${new Date().toISOString().slice(0, 10)}.csv`;
      download(name, Sh.toCsv(rows), 'text/csv;charset=utf-8');
      toast(`Exported ${fmt(rows.length)} accounts.`);
    },
    copyUsernames: async () => {
      const rows = visibleListForExport();
      if (!rows.length) return toast('Nothing to copy.');
      toast((await copyText(rows.map((r) => r.u).join('\n'))) ? `Copied ${fmt(rows.length)} usernames.` : 'Copy failed.');
    },
    rescan: (el) => startScan('resume', { rescan: el.dataset.phase }).then(() => switchTab('scan')),
    copyErrors: async () => {
      if (!S.errors.length) return toast('The error log is empty.');
      toast((await copyText(S.errors.map(errorText).join('\n\n'))) ? 'Error log copied.' : 'Copy failed.');
    },
    clearErrors: async () => {
      if (!S.errors.length) return;
      const c = await modal({
        title: 'Clear the error log?',
        body: '<p>This removes all entries from the error panel.</p>',
        buttons: [
          { label: 'Cancel', value: null },
          { label: 'Clear log', value: 'go', danger: true },
        ],
      });
      if (c === 'go') await chrome.storage.local.remove('errors');
    },
    retry: (el) => {
      const e = S.errors.find((x) => x.id === el.dataset.id);
      const r = e && retryable(e);
      if (!r) return;
      switchTab('scan');
      if (r.kind === 'preflight') return connectionTest();
      if (r.kind === 'rescan') return startScan('resume', { rescan: r.phase });
      const eff = derived().eff;
      if (eff === 'running') return toast('The scan is already running.');
      return eff === 'paused' || eff === 'stalled' ? onResume() : onStart();
    },
    saveRaw: async () => {
      let text = rawDisplay();
      if (!text) {
        await ACTS.freshRaw(true);
        text = rawDisplay();
      }
      if (!text) return toast('No raw response available yet. Run Test connection.');
      toast((await copyText(text)) ? 'Raw response copied. Paste it to Claude Code.' : 'Copy failed. Select the text below manually.');
    },
    freshRaw: async (quiet) => {
      try {
        const t = await scanningTab();
        if (!t) return toast('No Instagram tab with the extension was found.');
        const r = await sendTab(t.tab.id, { type: 'ig:cmd', cmd: 'captureRaw' }, 40000);
        if (quiet !== true) toast(r.ok ? 'Fresh sample saved.' : r.message || 'Sample failed.');
      } catch (e) {
        toast(e.message);
      }
    },
    downloadRaw: () => {
      const text = rawDisplay();
      if (!text) return toast('No raw response saved yet.');
      download('instagram-raw-response.txt', text);
    },
    copyDebug: async () => toast((await copyText(S.debuglog.join('\n'))) ? 'Request log copied.' : 'Copy failed.'),
    import: runImport,
  };

  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tab]');
    if (t) return switchTab(t.dataset.tab);
    const st = e.target.closest('[data-sub]');
    if (st) {
      S.sub = st.dataset.sub;
      S.showHidden = false;
      return renderResults();
    }
    const b = e.target.closest('[data-act]');
    if (b && ACTS[b.dataset.act] && !b.disabled) ACTS[b.dataset.act](b, e);
  });

  // broken avatars (image URLs expire): swap in the placeholder once
  document.addEventListener(
    'error',
    (e) => {
      const img = e.target;
      if (img && img.tagName === 'IMG' && img.classList.contains('avatar') && !img.dataset.fallback) {
        img.dataset.fallback = '1';
        img.src = PLACEHOLDER;
      }
    },
    true
  );

  $('#resSearch').addEventListener('input', (e) => {
    S.search = e.target.value;
    renderList();
  });
  $('#resSource').addEventListener('change', (e) => {
    S.source = e.target.value;
    renderResults();
  });
  let scrollQueued = false;
  $('#listWrap').addEventListener('scroll', () => {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => {
      scrollQueued = false;
      paintRows();
    });
  });
  $('#importFiles').addEventListener('change', (e) => {
    S.importFiles = Array.from(e.target.files || []);
    renderImport();
  });
  ['#mockToggle', '#mockScenario', '#mockFast'].forEach((s) => $(s).addEventListener('change', saveSettings));

  // ------------------------------------------------------------ live state
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const touched = new Set();
    Object.keys(changes).forEach((k) => {
      if (!KEYS.includes(k)) return;
      const nv = changes[k].newValue;
      S[k] = nv === undefined ? (k in DEFAULTS ? DEFAULTS[k] : null) : nv;
      touched.add(k);
    });
    if (touched.has('scan')) {
      renderAccount();
      renderScan();
      if (lastStatus !== (S.scan && S.scan.status)) {
        lastStatus = S.scan && S.scan.status;
        renderResults();
      }
    }
    if (touched.has('lastSession')) renderAccount();
    if (touched.has('results') || touched.has('importResults') || touched.has('ignored')) renderResults();
    if (touched.has('errors')) renderErrors();
    if (touched.has('debuglog') || touched.has('rawFirstResponse')) renderDebug();
    if (touched.has('ack')) renderScan();
    if (touched.has('settings')) {
      renderSettings();
      renderAccount();
    }
    if (touched.has('watchdog')) renderBanners();
  });
  let lastStatus = null;

  async function init() {
    const o = await chrome.storage.local.get(KEYS);
    KEYS.forEach((k) => {
      S[k] = o[k] === undefined ? (k in DEFAULTS ? DEFAULTS[k] : null) : o[k];
    });
    lastStatus = S.scan && S.scan.status;
    const sel = $('#mockScenario');
    sel.innerHTML = Object.keys(IGMock.SCENARIOS)
      .map((k) => `<option value="${k}">${esc(k)}: ${esc(IGMock.SCENARIOS[k])}</option>`)
      .join('');
    renderAll();
    chrome.runtime.sendMessage({ type: 'ig:clearBadge' }).catch(() => {});
    refreshPing();
    setInterval(refreshPing, 5000);
    setInterval(() => {
      renderProgress();
      renderBanners();
    }, 1000);
    let t = null;
    const soon = () => {
      clearTimeout(t);
      t = setTimeout(refreshPing, 600);
    };
    chrome.tabs.onUpdated.addListener((id, info) => {
      if (info.status === 'complete') soon();
    });
    chrome.tabs.onRemoved.addListener(soon);
  }

  init();
})();
