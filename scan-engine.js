/**
 * scan-engine.js
 * ============================================================================
 * The resumable scan loop. It runs inside the content script on instagram.com
 * (see content.js) and never depends on the side panel being open.
 *
 * Everything it needs from the outside is injected (storage, api, clock, sleep),
 * so the same code runs under Node in the unit tests with a fake clock and the
 * mock API.
 *
 * Persisted state (chrome.storage.local):
 *   scan             small metadata object (status, phases, cursors, timings, heartbeat)
 *   users_followers  { "<id>": [username, fullName, pictureUrl] }
 *   users_following  same
 *   results          final results (only written after BOTH phases finished + verified)
 *   errors           error log (newest last)
 *   debuglog         request log lines
 *   lock             { owner, ts } single-active-scan lock
 *   rawFirstResponse a raw API response sample for debugging
 *   lastSession      { id, username, checkedAt } from the last successful pre-flight
 *
 * Rules enforced here (spec sections 7, 8, 11):
 *   - cursor + all collected IDs saved after EVERY batch; a failed batch is never skipped
 *   - temporary errors: up to 5 retries, backoff 60s doubling to a 15 min cap, jitter,
 *     Retry-After honoured; then auto-pause
 *   - serious errors: pause immediately
 *   - expired cursor on resume: restart that list, keep collected IDs, dedupe
 *   - repeated cursor / repeated empty pages: PAGINATION_ERROR
 *   - results only after completion + completeness check
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IGEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const Shared = typeof module === 'object' && module.exports ? require('./shared.js') : self.IGShared;

  const PHASES = ['followers', 'following'];
  const USERS_KEY = { followers: 'users_followers', following: 'users_following' };
  const PHASE_LABEL = { followers: 'Followers', following: 'Following' };
  // Errors that, on the FIRST request after resuming from a saved cursor, mean
  // "the saved cursor is no longer valid" rather than "Instagram is unhappy".
  const CURSOR_EXPIRY_CODES = new Set(['SOFT_FAIL', 'UNEXPECTED_RESPONSE_FORMAT', 'PAGINATION_ERROR']);

  const DEFAULT_CONFIG = {
    batchSize: 100,
    delayMinMs: 2000,
    delayMaxMs: 5000,
    longPauseMinMs: 20000,
    longPauseMaxMs: 60000,
    longEveryMin: 5,
    longEveryMax: 8,
    maxRetries: 5,
    backoffBaseMs: 60000,
    backoffCapMs: 15 * 60000,
    retryAfterCapMs: 60 * 60000,
    lockStaleMs: 3 * 60000,
    completenessTolerance: 0.02,
    maxErrors: 1000,
    maxDebugLines: 400,
    timeScale: 1, // mock "fast timing" shrinks every wait by this factor
  };

  function newPhase() {
    return { status: 'not_started', cursor: null, batches: 0, collected: 0, expected: null, updatedAt: null, startedAt: null, cursorResets: 0 };
  }

  function freshMeta(account) {
    const t = Date.now();
    return {
      version: 1,
      account: account || null,
      status: 'idle', // idle | running | paused | complete | cancelled
      pauseReason: null, // manual | error | interrupted
      statusText: 'Idle',
      phase: null,
      phases: { followers: newPhase(), following: newPhase() },
      totalActiveMs: 0,
      sessionActiveMs: 0,
      sessionStartedAt: null,
      lastTickAt: null,
      lastHeartbeat: null,
      waitUntil: null,
      waitReason: null, // pacing | long_pause | rate_limit | network_retry | offline
      eta: null,
      counts: null, // { followers, following } totals reported by Instagram
      tabHidden: false,
      notice: null,
      lastError: null,
      createdAt: t,
      updatedAt: t,
      finishedAt: null,
    };
  }

  function serializeUsers(map) {
    const o = {};
    map.forEach((v, k) => {
      o[k] = v;
    });
    return o;
  }

  function asApiError(e) {
    if (e && e.code && typeof e.message === 'string') return e;
    return { code: 'INTERNAL_ERROR', message: (e && e.message) || String(e), status: null, url: '', snippet: '', retryable: false };
  }

  function createEngine(deps) {
    const cfg = Object.assign({}, DEFAULT_CONFIG, deps.config || {});
    const now = deps.now || (() => Date.now());
    const rawSleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const rand = deps.random || Math.random;
    const store = deps.storage; // { get(keys), set(obj), remove(keys) }
    const api = deps.api; // { readSession(), fetchPage(), fetchProfile() }
    const hooks = deps.hooks || {}; // { onEvent(evt), keepAwake(bool) }
    const isOnline = deps.isOnline || (() => true);
    const instanceId = deps.instanceId || 'inst-' + Math.floor(rand() * 1e9).toString(36);

    const control = { stop: null }; // null | 'pause' | 'cancel' | 'interrupted'
    let running = false;
    let loopPromise = null;
    let meta = null;
    let wakeNow = null;
    let errSeq = 0;
    let debugBuf = [];
    const usersCache = { followers: null, following: null };
    const cycle = { times: [], last: null, retried: false };
    const pacing = { since: 0, nextLong: 6 };

    // ------------------------------------------------------------------ utils
    const scaled = (ms) => Math.max(0, Math.round(ms * cfg.timeScale));
    const randBetween = (a, b) => a + rand() * (b - a);
    const randInt = (a, b) => Math.floor(randBetween(a, b + 1));
    const stopRequested = () => !running || !!control.stop;

    function debug(line) {
      const entry = `[${new Date(now()).toISOString()}] ${line}`;
      debugBuf.push(entry);
      if (typeof console !== 'undefined') console.log('[IG-NF]', line);
    }
    async function flushDebug() {
      if (!debugBuf.length) return;
      const buf = debugBuf;
      debugBuf = [];
      const cur = (await store.get('debuglog')).debuglog || [];
      await store.set({ debuglog: cur.concat(buf).slice(-cfg.maxDebugLines) });
    }

    function sleep(ms) {
      return Promise.race([
        rawSleep(ms),
        new Promise((res) => {
          wakeNow = res;
        }),
      ]).then(() => {
        wakeNow = null;
      });
    }
    function wake() {
      if (wakeNow) wakeNow();
    }

    // ------------------------------------------------------------ error log
    async function logError(i) {
      const e = i.err || {};
      const entry = {
        id: `e${now()}-${++errSeq}`,
        ts: now(),
        phase: i.phase,
        batch: i.batch == null ? null : i.batch,
        code: e.code || 'INTERNAL_ERROR',
        status: e.status == null ? null : e.status,
        message: e.message || String(e),
        url: e.url || '',
        snippet: String(e.snippet || '').slice(0, 500),
        retryCount: i.retryCount || 0,
        autoRetrying: !!i.autoRetrying,
        nextRetryAt: i.nextRetryAt || null,
        note: i.note || null,
      };
      const cur = (await store.get('errors')).errors || [];
      cur.push(entry);
      const payload = { errors: cur.slice(-cfg.maxErrors) };
      // Keep a larger raw sample for non-transient failures so it can be pasted back for a fix.
      if (e.raw && !e.retryable) {
        payload.rawFirstResponse = { ts: now(), kind: 'failure', code: e.code, url: e.url, status: e.status, text: e.raw };
      }
      await store.set(payload);
      if (typeof console !== 'undefined') console.warn('[IG-NF] error', entry.code, entry.message);
      debug(`ERROR ${entry.phase} batch ${entry.batch}: ${entry.code} ${entry.message}${entry.autoRetrying ? ' (auto-retrying)' : ''}`);
      await flushDebug();
      return entry;
    }

    async function patchError(id, patch) {
      const cur = (await store.get('errors')).errors || [];
      const idx = cur.findIndex((x) => x.id === id);
      if (idx >= 0) {
        cur[idx] = Object.assign({}, cur[idx], patch);
        await store.set({ errors: cur });
      }
    }

    // ----------------------------------------------------------------- state
    async function loadMeta() {
      const { scan } = await store.get('scan');
      return scan || null;
    }

    async function getUsers(phase) {
      if (!usersCache[phase]) {
        const key = USERS_KEY[phase];
        const obj = (await store.get(key))[key] || {};
        usersCache[phase] = new Map(Object.entries(obj));
      }
      return usersCache[phase];
    }

    /** Heartbeat + save. Called after every batch and every countdown tick. */
    async function persist(opts) {
      if (!running) return;
      const t = now();
      if (meta.lastTickAt) {
        const d = Math.min(t - meta.lastTickAt, 120000); // never credit more than 2 min per tick
        if (d > 0) {
          meta.totalActiveMs += d;
          meta.sessionActiveMs += d;
        }
      }
      meta.lastTickAt = t;
      meta.lastHeartbeat = t;
      meta.updatedAt = t;
      const payload = { scan: meta, lock: { owner: instanceId, ts: t } };
      if (opts && opts.users) payload[USERS_KEY[opts.users]] = serializeUsers(usersCache[opts.users]);
      await store.set(payload);
    }

    async function finishRun(status, o) {
      const opts = o || {};
      running = false;
      meta.status = status;
      meta.pauseReason = opts.pauseReason || null;
      meta.statusText = opts.statusText || status;
      meta.waitUntil = null;
      meta.waitReason = null;
      meta.lastTickAt = null;
      meta.eta = null;
      meta.updatedAt = now();
      if (status === 'complete') meta.finishedAt = now();
      await store.set({ scan: meta, lock: null });
      await flushDebug();
      if (hooks.keepAwake) hooks.keepAwake(false);
      if (hooks.onEvent && opts.event) hooks.onEvent(opts.event);
    }

    async function pauseOnError(e, entry, retries) {
      meta.lastError = { code: e.code, message: e.message, ts: now(), entryId: entry ? entry.id : null };
      const after = e.retryable && retries >= cfg.maxRetries ? ` after ${cfg.maxRetries} retries` : '';
      await finishRun('paused', {
        pauseReason: 'error',
        statusText: `Paused on error${after}: ${e.code}`,
        event: { type: 'paused_error', code: e.code, message: e.message },
      });
    }

    async function haltForControl() {
      const s = control.stop;
      if (s === 'interrupted') return;
      if (s === 'cancel') await finishRun('cancelled', { statusText: 'Cancelled. Progress is saved.' });
      else await finishRun('paused', { pauseReason: 'manual', statusText: 'Paused' });
    }

    // ------------------------------------------------------------------ wait
    /** Timestamp-based wait with 1-second heartbeat ticks. Late timers are fine. Returns false if stopped. */
    async function wait(ms, reason) {
      const until = now() + ms;
      meta.waitUntil = until;
      meta.waitReason = reason;
      for (;;) {
        if (stopRequested()) {
          meta.waitUntil = null;
          meta.waitReason = null;
          return false;
        }
        const remaining = until - now();
        if (remaining <= 0) break;
        await persist();
        await sleep(Math.min(1000, remaining));
      }
      meta.waitUntil = null;
      meta.waitReason = null;
      return true;
    }

    function backoff(retries) {
      const base = Math.min(cfg.backoffCapMs, cfg.backoffBaseMs * Math.pow(2, retries));
      const jittered = base * (0.8 + 0.4 * rand());
      return scaled(Math.min(cfg.backoffCapMs, jittered));
    }

    // ------------------------------------------------------------- pre-flight
    /**
     * Steps 3-6 of the pre-flight check (steps 1-2 happen in the side panel, which
     * knows about tabs). opts: { otherTabs, takeOver }.
     */
    async function preflight(opts) {
      const o = opts || {};
      const steps = [];
      const result = { ok: false, steps, session: null, counts: null };
      const push = (id, label, ok, detail) => steps.push({ id, label, ok, detail: detail || '' });
      if (running) {
        push('lock', 'No other scan active', false, 'A scan is already running in this tab.');
        return result;
      }

      // 3. logged in?
      let session = {};
      try {
        session = api.readSession() || {};
      } catch (e) {
        session = {};
      }
      const missing = ['csrftoken', 'ds_user_id'].filter((k) => !session[k]);
      if (missing.length) {
        const msg = `Not logged in: missing cookie(s) ${missing.join(', ')}. Log in to instagram.com in this tab.`;
        push('login', 'Logged in to Instagram', false, msg);
        await logError({ phase: 'Pre-flight', batch: 0, err: { code: 'SESSION_EXPIRED', message: msg } });
        return result;
      }
      const userId = String(session.ds_user_id);
      push('login', 'Logged in to Instagram', true, `User ID ${userId}`);

      // 4. lock / single tab
      if (o.otherTabs > 0) {
        const msg = `${o.otherTabs} other Instagram tab(s) also have the extension loaded. Close them so only one tab runs the scan.`;
        push('lock', 'No other scan or Instagram tab active', false, msg);
        await logError({ phase: 'Pre-flight', batch: 0, err: { code: 'SCAN_ALREADY_ACTIVE', message: msg } });
        return result;
      }
      const { lock } = await store.get('lock');
      const t = now();
      if (lock && lock.owner !== instanceId && t - lock.ts < cfg.lockStaleMs && !o.takeOver) {
        const msg = `Another scan holds the lock (last heartbeat ${Math.round((t - lock.ts) / 1000)}s ago). If you just reloaded the Instagram tab, wait a few minutes or press Resume.`;
        push('lock', 'No other scan or Instagram tab active', false, msg);
        await logError({ phase: 'Pre-flight', batch: 0, err: { code: 'SCAN_ALREADY_ACTIVE', message: msg } });
        return result;
      }
      push('lock', 'No other scan or Instagram tab active', true, lock && lock.owner !== instanceId ? 'Recovered an orphaned scan lock' : '');

      // 5. one small test request (count=1)
      try {
        const page = await api.fetchPage('followers', userId, null, { count: 1 });
        await store.set({ rawFirstResponse: Object.assign({ ts: now(), kind: 'preflight' }, page.raw) });
        push('test', 'Test request returns the expected data', true, `HTTP ${page.raw.status}, JSON shape OK`);
      } catch (e0) {
        const e = asApiError(e0);
        let diag = '';
        if (typeof api.diagnose === 'function') {
          try {
            diag = ` DIAGNOSTICS: ${await api.diagnose(userId)}`;
          } catch (e2) {
            diag = '';
          }
        }
        const seen = diag + (e.snippet ? ` Instagram sent: ${String(e.snippet).replace(/\s+/g, ' ').slice(0, 300)}` : '');
        push('test', 'Test request returns the expected data', false, `${e.code}: ${e.message} [${e.url || ''}]${seen}`);
        await logError({ phase: 'Pre-flight', batch: 0, err: e });
        await flushDebug();
        return result;
      }

      // 6. profile counts
      // The totals endpoint is rate limited more aggressively than the list endpoints, so a
      // temporary error (429 / network) is retried a couple of times, and if it still fails the
      // scan is allowed to proceed WITHOUT totals (visible warning; completeness check is then
      // marked "not verified"). Non-temporary errors (format changed, logged out) still stop here.
      let profile = null;
      let countsErr = null;
      const waits = [10000, 30000];
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          profile = await api.fetchProfile(userId);
          break;
        } catch (e0) {
          countsErr = asApiError(e0);
          const again = !!countsErr.retryable && attempt < 2;
          await logError({ phase: 'Pre-flight', batch: 0, err: countsErr, retryCount: attempt, autoRetrying: again });
          if (!again) break;
          await sleep(scaled(countsErr.retryAfterMs != null ? Math.min(countsErr.retryAfterMs, 60000) : waits[attempt]));
        }
      }
      let username;
      if (profile) {
        username = profile.username;
        push('counts', 'Profile totals read', true, `${profile.followers.toLocaleString('en-US')} followers, ${profile.following.toLocaleString('en-US')} following`);
        result.counts = { followers: profile.followers, following: profile.following };
        await store.set({ lastSession: { id: userId, username, checkedAt: now() } });
      } else if (countsErr.retryable) {
        const prev = (await store.get('lastSession')).lastSession;
        username = prev && prev.id === userId ? prev.username : `user ${userId}`;
        steps.push({
          id: 'counts',
          label: 'Profile totals read',
          ok: true,
          warn: true,
          detail: `Skipped (${countsErr.code}). Instagram is limiting this call. The scan can still run, but the completeness check cannot compare against your profile totals and the ETA is unavailable.`,
        });
        result.counts = null;
      } else {
        push('counts', 'Profile totals read', false, `${countsErr.code}: ${countsErr.message}`);
        await flushDebug();
        return result;
      }
      steps[0].detail = `@${username} (ID ${userId})`;
      result.ok = true;
      result.session = { id: userId, username };
      await flushDebug();
      return result;
    }

    // ------------------------------------------------------------------ start
    async function resetScanData(account) {
      meta = freshMeta(account);
      usersCache.followers = new Map();
      usersCache.following = new Map();
      await store.remove([USERS_KEY.followers, USERS_KEY.following, 'results']);
    }

    /**
     * opts: { mode: 'resume' | 'fresh', takeOver, otherTabs, rescan: 'followers'|'following' }
     * Resolves after the pre-flight; the scan loop continues in the background.
     */
    async function start(opts) {
      const o = opts || {};
      if (running) return { ok: false, code: 'ALREADY_RUNNING', message: 'A scan is already running in this tab.' };
      if (o.mode === 'fresh' && !o.rescan) {
        // The user chose to discard saved progress: drop it right away so the panel shows an empty
        // scan while the pre-flight runs (which can take a while when Instagram rate limits it).
        await resetScanData(null);
        meta.statusText = 'Starting...';
        await store.set({ scan: meta });
      }
      const pre = await preflight({ otherTabs: o.otherTabs, takeOver: o.takeOver });
      if (!pre.ok) return { ok: false, code: 'PREFLIGHT_FAILED', steps: pre.steps };
      const account = pre.session;

      let saved = await loadMeta();
      let mode = o.mode || 'resume';
      const allDone = saved && PHASES.every((p) => saved.phases[p].status === 'complete');
      if (mode === 'resume' && allDone && !o.rescan) mode = 'fresh';
      if (mode !== 'fresh' && saved && saved.account && saved.account.id !== account.id) {
        return {
          ok: false,
          code: 'ACCOUNT_MISMATCH',
          message: `Saved progress belongs to @${saved.account.username}, but @${account.username} is logged in.`,
          steps: pre.steps,
          savedAccount: saved.account,
          account,
        };
      }
      if (mode === 'fresh' || !saved) {
        await resetScanData(account);
      } else {
        meta = saved;
        usersCache.followers = null;
        usersCache.following = null;
      }

      if (o.rescan && PHASES.includes(o.rescan)) {
        // Restart one list from the beginning but keep the accounts already collected.
        meta.phases[o.rescan] = Object.assign(newPhase(), { startedAt: meta.phases[o.rescan].startedAt });
        await store.remove('results');
      }

      const lk = await store.get('lock');
      if (lk.lock && lk.lock.owner !== instanceId && now() - lk.lock.ts < cfg.lockStaleMs && !o.takeOver) {
        return { ok: false, code: 'SCAN_ALREADY_ACTIVE', message: 'Another scan holds the lock.', steps: pre.steps };
      }
      await store.set({ lock: { owner: instanceId, ts: now() } });

      meta.account = account;
      meta.counts = pre.counts || meta.counts || null;
      PHASES.forEach((p) => {
        meta.phases[p].expected = pre.counts ? pre.counts[p] : meta.phases[p].expected;
      });
      meta.notice = null;
      meta.lastError = null;
      meta.status = 'running';
      meta.pauseReason = null;
      meta.statusText = 'Starting...';
      meta.sessionActiveMs = 0;
      meta.sessionStartedAt = now();
      meta.lastTickAt = now();
      meta.finishedAt = null;
      meta.eta = null;
      control.stop = null;
      cycle.times = [];
      cycle.last = null;
      cycle.retried = false;
      pacing.since = 0;
      pacing.nextLong = randInt(cfg.longEveryMin, cfg.longEveryMax);
      running = true;
      if (hooks.keepAwake) hooks.keepAwake(true);
      if (hooks.onEvent) hooks.onEvent({ type: 'started' });
      await persist();
      debug(`Scan ${mode} started for @${account.username} (${account.id}); totals: ${pre.counts ? `followers ${pre.counts.followers}, following ${pre.counts.following}` : 'unavailable'}`);
      await flushDebug();

      loopPromise = runScan().catch(async (err) => {
        const e = asApiError(err);
        if (typeof console !== 'undefined') console.error('[IG-NF] engine crash', err);
        if (running) {
          const entry = await logError({ phase: meta.phase ? PHASE_LABEL[meta.phase] : 'Scan', batch: null, err: Object.assign({}, e, { code: 'INTERNAL_ERROR' }) });
          await pauseOnError(Object.assign({}, e, { code: 'INTERNAL_ERROR', retryable: false }), entry, 0);
        }
      });
      return { ok: true, steps: pre.steps, mode };
    }

    // ---------------------------------------------------------------- the loop
    async function runScan() {
      for (const phase of PHASES) {
        if (meta.phases[phase].status === 'complete') continue;
        const r = await runPhase(phase);
        if (r !== 'done') return;
        if (stopRequested()) {
          await haltForControl();
          return;
        }
        if (!PHASES.every((p) => meta.phases[p].status === 'complete')) {
          meta.statusText = 'Pausing briefly between lists';
          if (!(await wait(scaled(randBetween(cfg.delayMinMs, cfg.delayMaxMs)), 'pacing'))) {
            await haltForControl();
            return;
          }
        }
      }
      await finalize();
    }

    async function runPhase(phase) {
      const ph = meta.phases[phase];
      const users = await getUsers(phase);
      if (ph.status !== 'in_progress') {
        ph.status = 'in_progress';
        ph.startedAt = ph.startedAt || now();
      }
      ph.collected = users.size;
      meta.phase = phase;
      const seenCursors = new Set(ph.cursor ? [ph.cursor] : []);
      let trustSavedCursor = !!ph.cursor; // first request after resuming from a stored cursor
      let emptyStreak = 0;

      for (;;) {
        if (stopRequested()) {
          await haltForControl();
          return 'stopped';
        }
        const batchNo = ph.batches + 1;
        meta.statusText = `Fetching ${phase}, batch ${batchNo}`;
        await persist();
        const res = await fetchWithRetry(phase, ph.cursor, batchNo);
        if (res.stopped) {
          await haltForControl();
          return 'stopped';
        }

        if (res.error) {
          const e = res.error;
          if (trustSavedCursor && ph.cursor && CURSOR_EXPIRY_CODES.has(e.code)) {
            // Saved position expired (typical when resuming the next day). Keep everything
            // collected so far and restart this list from the beginning; dedupe by ID.
            ph.cursor = null;
            ph.cursorResets += 1;
            seenCursors.clear();
            trustSavedCursor = false;
            meta.notice = 'Saved position expired, rescanning this list. Previously collected accounts are kept.';
            if (res.entry) await patchError(res.entry.id, { autoRetrying: true, note: 'Saved cursor rejected; restarting this list from the beginning (collected accounts kept).' });
            debug(`${phase}: saved cursor rejected (${e.code}); restarting list, keeping ${users.size} collected accounts`);
            await persist();
            continue;
          }
          await pauseOnError(e, res.entry, res.retries);
          return 'stopped';
        }
        trustSavedCursor = false;

        const page = res.page;
        page.users.forEach((u) => users.set(u.id, [u.u, u.n, u.p]));
        ph.batches += 1;
        ph.collected = users.size;
        ph.lastReq = res.stats;
        ph.maxGot = Math.max(ph.maxGot || 0, res.stats.got);
        ph.totalReqMs = (ph.totalReqMs || 0) + res.stats.ms;
        ph.updatedAt = now();

        // Cycle timing for the ETA (skip cycles disturbed by retries).
        const t = now();
        if (cycle.last != null && !cycle.retried) {
          cycle.times.push(t - cycle.last);
          if (cycle.times.length > 20) cycle.times.shift();
        }
        cycle.last = t;
        cycle.retried = false;

        // Pagination guards (failure mode 8)
        let paginationProblem = null;
        if (page.nextCursor) {
          if (seenCursors.has(page.nextCursor)) paginationProblem = 'Instagram returned the same cursor twice (would loop forever).';
          else if (page.users.length === 0 && ++emptyStreak >= 3) paginationProblem = 'Three empty pages in a row even though more pages were announced.';
          if (page.users.length > 0) emptyStreak = 0;
        }
        if (paginationProblem) {
          await persist({ users: phase });
          const entry = await logError({
            phase: PHASE_LABEL[phase],
            batch: batchNo,
            err: { code: 'PAGINATION_ERROR', message: paginationProblem, status: res.page.raw.status, url: res.page.raw.url, snippet: res.page.raw.text.slice(0, 500) },
          });
          await pauseOnError({ code: 'PAGINATION_ERROR', message: paginationProblem }, entry, 0);
          return 'stopped';
        }

        ph.cursor = page.nextCursor || null;
        if (page.nextCursor) seenCursors.add(page.nextCursor);
        if (meta.notice && ph.cursorResets && !page.nextCursor) meta.notice = null;

        if (!ph.cursor) {
          ph.status = 'complete';
          ph.updatedAt = now();
          meta.statusText = `${PHASE_LABEL[phase]} complete`;
          updateEta();
          await persist({ users: phase });
          debug(`${PHASE_LABEL[phase]} complete: ${users.size} accounts in ${ph.batches} batches`);
          await flushDebug();
          return 'done';
        }

        updateEta();
        await persist({ users: phase });
        await flushDebug();

        // Request pacing: random 2-5s, and a longer random pause every 5-8 batches.
        pacing.since += 1;
        let ok;
        if (pacing.since >= pacing.nextLong) {
          pacing.since = 0;
          pacing.nextLong = randInt(cfg.longEveryMin, cfg.longEveryMax);
          meta.statusText = `Long pause to stay under rate limits (${phase}, after batch ${batchNo})`;
          ok = await wait(scaled(randBetween(cfg.longPauseMinMs, cfg.longPauseMaxMs)), 'long_pause');
        } else {
          meta.statusText = `Fetching ${phase}, batch ${batchNo + 1} soon`;
          ok = await wait(scaled(randBetween(cfg.delayMinMs, cfg.delayMaxMs)), 'pacing');
        }
        if (!ok) {
          await haltForControl();
          return 'stopped';
        }
      }
    }

    /** Request with the retry policy. Never skips a batch: resolves {page} or {error} or {stopped}. */
    async function fetchWithRetry(phase, cursor, batchNo) {
      let retries = 0;
      let offlineLogged = false;
      for (;;) {
        if (stopRequested()) return { stopped: true };
        if (!isOnline()) {
          if (!offlineLogged) {
            offlineLogged = true;
            await logError({
              phase: PHASE_LABEL[phase],
              batch: batchNo,
              err: { code: 'NETWORK_ERROR', message: 'Browser is offline. Waiting for the connection to return.' },
              retryCount: retries,
              autoRetrying: true,
            });
          }
          meta.statusText = 'Offline, waiting for the connection to return';
          meta.waitReason = 'offline';
          await persist();
          await sleep(1000);
          continue;
        }
        if (offlineLogged) {
          offlineLogged = false;
          meta.waitReason = null;
        }
        try {
          const startedAt = now();
          const page = await api.fetchPage(phase, meta.account.id, cursor, { count: cfg.batchSize });
          const stats = { asked: cfg.batchSize, got: page.users.length, ms: now() - startedAt };
          debug(`${phase} batch ${batchNo}: asked ${stats.asked}, got ${stats.got} in ${stats.ms} ms`);
          await flushDebug();
          return { page, stats };
        } catch (e0) {
          await flushDebug();
          const e = asApiError(e0);
          const willRetry = !!e.retryable && retries < cfg.maxRetries;
          let delay = null;
          let nextRetryAt = null;
          if (willRetry) {
            delay = e.retryAfterMs != null ? Math.min(cfg.retryAfterCapMs, e.retryAfterMs) + Math.round(rand() * 2000) : backoff(retries);
            nextRetryAt = now() + delay;
          }
          const entry = await logError({ phase: PHASE_LABEL[phase], batch: batchNo, err: e, retryCount: retries, autoRetrying: willRetry, nextRetryAt });
          if (!willRetry) return { error: e, entry, retries };
          retries += 1;
          cycle.retried = true;
          meta.statusText = `${e.code === 'RATE_LIMITED_429' ? 'Rate limited' : 'Network problem'}, retry ${retries} of ${cfg.maxRetries}`;
          const ok = await wait(delay, e.code === 'RATE_LIMITED_429' ? 'rate_limit' : 'network_retry');
          if (!ok) return { stopped: true };
        }
      }
    }

    function updateEta() {
      let remaining = 0;
      let known = true;
      for (const p of PHASES) {
        const ph = meta.phases[p];
        if (ph.status === 'complete') continue;
        if (ph.expected == null) {
          known = false;
          break;
        }
        remaining += Math.max(0, ph.expected - ph.collected);
      }
      meta.eta = known ? Object.assign({ computedAt: now() }, Shared.computeEta(cycle.times, Math.ceil(remaining / cfg.batchSize))) : null;
    }

    // ---------------------------------------------------------------- finalize
    async function finalize() {
      meta.statusText = 'Verifying results';
      await persist();
      // Re-read the profile totals (they may have moved since the pre-flight); keep the old ones on failure.
      let counts = meta.counts;
      try {
        const p = await api.fetchProfile(meta.account.id);
        counts = { followers: p.followers, following: p.following };
        meta.counts = counts;
      } catch (e) {
        debug(`Could not refresh profile totals: ${asApiError(e).message}`);
      }
      const fUsers = await getUsers('followers');
      const gUsers = await getUsers('following');
      const toObj = (m) => Array.from(m, ([id, v]) => ({ id, u: v[0], n: v[1], p: v[2] }));
      const followers = toObj(fUsers);
      const following = toObj(gUsers);
      const cmp = Shared.computeByIds(followers, following);

      const incomplete = [];
      const checks = {};
      PHASES.forEach((p) => {
        const collected = p === 'followers' ? followers.length : following.length;
        const c = Shared.completeness(counts ? counts[p] : null, collected, cfg.completenessTolerance);
        checks[p] = { expected: counts ? counts[p] : null, collected, ok: c.ok, short: c.short };
        if (c.ok === false) incomplete.push({ phase: p, expected: counts[p], collected });
      });
      // Follower changes since the previous complete scan of this account. A short
      // followers list would show false "lost" entries, so it neither diffs nor replaces the snapshot.
      const prevSnap = (await store.get('followersSnapshot')).followersSnapshot;
      const prev = prevSnap && prevSnap.accountId === meta.account.id ? prevSnap : null;
      let newFollowers = [];
      let lostFollowers = [];
      let followersSince = null;
      const followersTrusted = checks.followers.ok !== false;
      if (followersTrusted) {
        if (prev) {
          followersSince = prev.ts;
          const nowIds = new Set(followers.map((x) => x.id));
          const prevIds = new Set(Object.keys(prev.users));
          newFollowers = followers.filter((x) => !prevIds.has(x.id));
          lostFollowers = Object.entries(prev.users)
            .filter(([id]) => !nowIds.has(id))
            .map(([id, v]) => ({ id, u: v[0], n: v[1], p: v[2] }));
        }
        await store.set({ followersSnapshot: { accountId: meta.account.id, ts: now(), users: serializeUsers(fUsers) } });
      }
      const fT = meta.phases.followers.updatedAt || 0;
      const gT = meta.phases.following.updatedAt || 0;
      const results = {
        source: 'scan',
        accountId: meta.account.id,
        username: meta.account.username,
        computedAt: now(),
        followersUpdatedAt: fT,
        followingUpdatedAt: gT,
        stale24h: Math.abs(fT - gT) > 24 * 3600 * 1000,
        checks,
        incomplete,
        countsUnavailable: !counts,
        nonFollowers: cmp.nonFollowers,
        fans: cmp.fans,
        mutualCount: cmp.mutualCount,
        followers,
        following,
        newFollowers,
        lostFollowers,
        followersSince,
        followersDiffTrusted: followersTrusted,
      };
      await store.set({ results });
      for (const inc of incomplete) {
        await logError({
          phase: 'Compare',
          batch: null,
          err: {
            code: 'INCOMPLETE_DATA',
            message: `${PHASE_LABEL[inc.phase]}: collected ${inc.collected} of ${inc.expected}, results may be incomplete.`,
          },
          note: inc.phase,
        });
      }
      meta.notice = null;
      await finishRun('complete', {
        statusText: incomplete.length ? 'Complete, but the data may be incomplete' : 'Scan complete',
        event: { type: 'complete', count: cmp.nonFollowers.length, incomplete: incomplete.length },
      });
      debug(`Scan complete: ${cmp.nonFollowers.length} non-followers, ${cmp.fans.length} fans, ${incomplete.length} incomplete phase(s)`);
      await flushDebug();
    }

    // ---------------------------------------------------------------- controls
    function pause() {
      if (!running) return { ok: false, message: 'No scan is running in this tab.' };
      control.stop = 'pause';
      wake();
      return { ok: true };
    }

    async function cancel() {
      if (running) {
        control.stop = 'cancel';
        wake();
        return { ok: true };
      }
      const m = await loadMeta();
      if (m && m.status !== 'complete') {
        m.status = 'cancelled';
        m.pauseReason = null;
        m.statusText = 'Cancelled. Progress is saved.';
        m.waitUntil = null;
        await store.set({ scan: m, lock: null });
      }
      return { ok: true };
    }

    /** Page is going away (reload/close): record it so the panel shows the truth. Best effort. */
    async function interrupt() {
      if (!running) return;
      running = false;
      control.stop = 'interrupted';
      meta.status = 'paused';
      meta.pauseReason = 'interrupted';
      meta.statusText = 'Paused: the Instagram tab was closed or reloaded';
      meta.waitUntil = null;
      meta.lastTickAt = null;
      await store.set({ scan: meta, lock: null });
      if (hooks.keepAwake) hooks.keepAwake(false);
      await logError({
        phase: meta.phase ? PHASE_LABEL[meta.phase] : 'Scan',
        batch: meta.phase ? meta.phases[meta.phase].batches + 1 : null,
        err: { code: 'CONTENT_SCRIPT_DISCONNECTED', message: 'The Instagram tab was closed or reloaded. Progress is saved; press Resume to continue.' },
      });
    }

    function setHidden(h) {
      if (meta && running) meta.tabHidden = !!h;
    }

    /** Fetch a small fresh sample for the "Save raw first response" debug button. */
    async function captureRaw() {
      if (running) return { ok: false, message: 'A scan is running; use the sample saved by the pre-flight check.' };
      const session = api.readSession() || {};
      if (!session.ds_user_id) return { ok: false, message: 'Not logged in.' };
      try {
        const page = await api.fetchPage('followers', session.ds_user_id, null, { count: 3 });
        const rawFirstResponse = Object.assign({ ts: now(), kind: 'sample' }, page.raw);
        await store.set({ rawFirstResponse });
        await flushDebug();
        return { ok: true, raw: rawFirstResponse };
      } catch (e0) {
        const e = asApiError(e0);
        await logError({ phase: 'Pre-flight', batch: 0, err: e });
        const rawFirstResponse = { ts: now(), kind: 'failure', code: e.code, url: e.url, status: e.status, text: e.raw || e.snippet || e.message };
        await store.set({ rawFirstResponse });
        return { ok: false, message: `${e.code}: ${e.message}`, raw: rawFirstResponse };
      }
    }

    return {
      instanceId,
      preflight,
      start,
      pause,
      cancel,
      interrupt,
      setHidden,
      captureRaw,
      noteRequest(info) {
        debug(`${info.method} ${info.url} -> ${info.status}${info.error ? ' (' + info.error + ')' : ''} ${info.ms}ms`);
      },
      configure(patch) {
        Object.assign(cfg, patch);
      },
      isRunning: () => running,
      whenIdle: () => loopPromise || Promise.resolve(),
      getMeta: () => meta,
      flushDebug,
      wake,
      config: cfg,
    };
  }

  return { createEngine, DEFAULT_CONFIG, PHASES, freshMeta };
});
