/**
 * instagram-api.js
 * ============================================================================
 * EVERYTHING that knows about Instagram's unofficial web API lives in this file:
 *   - endpoint URLs and query parameters
 *   - request headers
 *   - response classification (rate limit / soft fail / blocked / logged out ...)
 *   - response schema validation and normalisation
 *
 * Instagram changes these internal endpoints without notice. If the tool stops
 * working after a "known good" run, THIS is the only file that should need a fix.
 * Use the side panel's "Save raw first response" button and the error panel's raw
 * snippets to see what Instagram actually returned.
 *
 * This module runs inside the content script on https://www.instagram.com so that
 * every request is same-origin and carries the user's existing logged-in session
 * (credentials: "include"). It must never be called from the service worker or
 * the side panel (that is failure mode #1: wrong origin).
 *
 * The module is a UMD: it works as a content-script global (IGApi) and under
 * Node (require) for the unit tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IGApi = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // 1. CONFIGURATION: verify these against the Network tab of instagram.com
  // ---------------------------------------------------------------------------
  const CONFIG = {
    ORIGIN: 'https://www.instagram.com',

    // X-IG-App-ID: the public "web app" ID that instagram.com itself sends.
    // VERIFY: open instagram.com, DevTools > Network, click any /api/v1/ request,
    // and compare the "x-ig-app-id" request header with this value. It can change.
    APP_ID: '936619743392459',

    PAGE_SIZE: 50, // accounts per request
    TIMEOUT_MS: 30000, // per-request timeout
    SNIPPET_CHARS: 500, // raw response snippet kept on every error
    RAW_CHARS: 6000, // larger raw sample kept for the "Save raw first response" button

    // Endpoints (path only; the content script is already on the right origin).
    // VERIFY: these are the paths instagram.com's own follower/following dialogs call.
    endpoints: {
      followers: (userId) => `/api/v1/friendships/${encodeURIComponent(userId)}/followers/`,
      following: (userId) => `/api/v1/friendships/${encodeURIComponent(userId)}/following/`,
      // Used to read the logged-in username and the follower/following TOTALS
      // (needed for the completeness check). Response: { user: { username,
      // follower_count, following_count, ... }, status: "ok" }.
      userInfo: (userId) => `/api/v1/users/${encodeURIComponent(userId)}/info/`,
      // Incoming follow requests waiting for approval (private accounts). Response: { users: [...], status: "ok" }.
      pending: () => '/api/v1/friendships/pending/',
      // Follow / unfollow one account (POST, form-encoded, same as the website's button).
      friendship: (action, userId) => `/api/v1/friendships/${action === 'follow' ? 'create' : 'destroy'}/${encodeURIComponent(userId)}/`,
    },
    cursorParam: 'max_id', // request query parameter carrying the cursor
    nextCursorField: 'next_max_id', // response field carrying the next cursor
  };

  // ---------------------------------------------------------------------------
  // 2. ERROR CODES (these appear verbatim in the error panel)
  // ---------------------------------------------------------------------------
  const CODES = Object.freeze({
    WRONG_ORIGIN_OR_HTML_RESPONSE: 'WRONG_ORIGIN_OR_HTML_RESPONSE',
    MISSING_HEADER_OR_TOKEN: 'MISSING_HEADER_OR_TOKEN',
    RATE_LIMITED_429: 'RATE_LIMITED_429',
    SOFT_FAIL: 'SOFT_FAIL',
    ACTION_BLOCKED: 'ACTION_BLOCKED',
    SESSION_EXPIRED: 'SESSION_EXPIRED',
    CHALLENGE_REQUIRED: 'CHALLENGE_REQUIRED',
    UNEXPECTED_RESPONSE_FORMAT: 'UNEXPECTED_RESPONSE_FORMAT',
    PAGINATION_ERROR: 'PAGINATION_ERROR',
    INCOMPLETE_DATA: 'INCOMPLETE_DATA',
    CONTENT_SCRIPT_DISCONNECTED: 'CONTENT_SCRIPT_DISCONNECTED',
    SCAN_STALLED: 'SCAN_STALLED',
    NETWORK_ERROR: 'NETWORK_ERROR',
    SCAN_ALREADY_ACTIVE: 'SCAN_ALREADY_ACTIVE',
    PARSE_ERROR: 'PARSE_ERROR',
    INTERNAL_ERROR: 'INTERNAL_ERROR',
  });

  // Only these are worth retrying automatically (temporary conditions).
  // Everything else is "serious": the scan pauses immediately with no retries.
  const RETRYABLE = new Set([CODES.RATE_LIMITED_429, CODES.NETWORK_ERROR]);

  class ApiError extends Error {
    constructor(code, message, details) {
      super(message);
      const d = details || {};
      this.name = 'ApiError';
      this.code = code;
      this.status = d.status == null ? null : d.status;
      this.url = d.url || ''; // never contains tokens or cookies
      this.snippet = d.snippet || ''; // first ~500 chars of the response body
      this.raw = d.raw || ''; // larger sample for the debug view
      this.retryable = RETRYABLE.has(code);
      this.retryAfterMs = d.retryAfterMs == null ? null : d.retryAfterMs;
    }
  }

  // ---------------------------------------------------------------------------
  // 3. COOKIES AND HEADERS
  // ---------------------------------------------------------------------------
  function getCookie(cookieString, name) {
    const parts = String(cookieString || '').split(';');
    for (const part of parts) {
      const i = part.indexOf('=');
      if (i < 0) continue;
      if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
    }
    return '';
  }

  function readSessionFromCookies(cookieString) {
    return {
      csrftoken: getCookie(cookieString, 'csrftoken'),
      ds_user_id: getCookie(cookieString, 'ds_user_id'),
    };
  }

  /**
   * Build the headers instagram.com's own JavaScript sends with these calls.
   * Returns { headers, missing } where `missing` lists names of EMPTY values
   * (never the values themselves, so tokens are never printed or logged).
   */
  function buildHeaders(session) {
    const missing = [];
    if (!session.csrftoken) missing.push('csrftoken cookie');
    if (!session.ds_user_id) missing.push('ds_user_id cookie');
    if (!CONFIG.APP_ID) missing.push('X-IG-App-ID');
    const headers = {
      // CSRF token: copied from the csrftoken cookie, exactly like the real site does.
      'X-CSRFToken': session.csrftoken,
      // Identifies the web client. If this is wrong/stale you get 400/403 even when logged in.
      'X-IG-App-ID': CONFIG.APP_ID,
      // Marks the call as an AJAX request.
      'X-Requested-With': 'XMLHttpRequest',
    };
    return { headers, missing };
  }

  function buildPath(path, query) {
    const qs = new URLSearchParams();
    Object.keys(query || {}).forEach((k) => {
      if (query[k] !== undefined && query[k] !== null && query[k] !== '') qs.set(k, String(query[k]));
    });
    const s = qs.toString();
    return s ? `${path}?${s}` : path;
  }

  // ---------------------------------------------------------------------------
  // 4. RESPONSE CLASSIFICATION (failure modes 1, 3, 4, 5, 6, 7)
  // ---------------------------------------------------------------------------
  const BLOCK_RE =
    /feedback_required|action[ _]?blocked|try again later|wait a few minutes|temporarily (blocked|restricted)|we restrict certain activity|suspicious|spam/i;

  function snippetOf(text, n) {
    return String(text || '').slice(0, n || CONFIG.SNIPPET_CHARS);
  }

  function parseRetryAfter(value, nowMs) {
    if (value == null || value === '') return null;
    const secs = Number(value);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
    const when = Date.parse(value);
    if (Number.isFinite(when)) return Math.max(0, when - (nowMs || Date.now()));
    return null;
  }

  /**
   * Turn a raw HTTP result into parsed JSON, or throw a classified ApiError.
   * res = { status, text, contentType, url (request URL), finalUrl (URL after
   *         redirects, '' if none), retryAfterMs }
   */
  function parseResponse(res) {
    const base = {
      status: res.status,
      url: res.url,
      snippet: snippetOf(res.text),
      raw: snippetOf(res.text, CONFIG.RAW_CHARS),
    };
    const finalUrl = res.finalUrl || '';

    // Redirected to a login or challenge page (failure mode 6)
    if (/\/accounts\/login/i.test(finalUrl)) {
      throw new ApiError(CODES.SESSION_EXPIRED, 'Redirected to the Instagram login page. Log in again in the Instagram tab.', base);
    }
    if (/\/challenge/i.test(finalUrl)) {
      throw new ApiError(CODES.CHALLENGE_REQUIRED, 'Redirected to an Instagram verification (challenge) page. Complete it in the Instagram tab.', base);
    }

    let json = null;
    try {
      const j = JSON.parse(res.text);
      if (j && typeof j === 'object' && !Array.isArray(j)) json = j;
    } catch (e) {
      json = null;
    }
    const igMessage = json
      ? [json.message, json.error_type, json.error_title, json.feedback_title, json.feedback_message]
          .filter((s) => typeof s === 'string' && s)
          .join(' | ')
      : '';

    // Rate limit (failure mode 3)
    if (res.status === 429) {
      throw new ApiError(
        CODES.RATE_LIMITED_429,
        `HTTP 429 Too Many Requests${igMessage ? `: ${igMessage}` : ''}`,
        Object.assign({}, base, { retryAfterMs: res.retryAfterMs })
      );
    }

    // Not JSON at all (failure mode 1): HTML login page, empty body, wrong origin ...
    if (!json) {
      if (res.status >= 500) {
        throw new ApiError(CODES.NETWORK_ERROR, `Instagram server error (HTTP ${res.status})`, base);
      }
      if (res.status === 404) {
        throw new ApiError(
          CODES.UNEXPECTED_RESPONSE_FORMAT,
          'HTTP 404: endpoint not found. Instagram may have changed this URL.',
          base
        );
      }
      const looksHtml = /^\s*</.test(res.text || '') || /html/i.test(res.contentType || '');
      const what = !(res.text || '').trim() ? 'empty body' : looksHtml ? 'an HTML page' : 'a non-JSON body';
      throw new ApiError(
        CODES.WRONG_ORIGIN_OR_HTML_RESPONSE,
        `HTTP ${res.status}: expected JSON but got ${what}. This usually means a wrong origin, a logged-out session, or a changed endpoint.`,
        base
      );
    }

    // JSON error bodies (failure modes 4, 5, 6)
    if (/checkpoint_required|challenge_required/i.test(igMessage) || json.checkpoint_url || json.challenge) {
      throw new ApiError(CODES.CHALLENGE_REQUIRED, `Instagram requires verification${igMessage ? `: ${igMessage}` : ''}`, base);
    }
    if (/login_required/i.test(igMessage) || res.status === 401) {
      throw new ApiError(CODES.SESSION_EXPIRED, `Session expired or logged out${igMessage ? `: ${igMessage}` : ''}`, base);
    }
    if (BLOCK_RE.test(igMessage)) {
      throw new ApiError(CODES.ACTION_BLOCKED, `Instagram is restricting this account: ${igMessage}`, base);
    }
    if (res.status >= 500) {
      throw new ApiError(CODES.NETWORK_ERROR, `Instagram server error (HTTP ${res.status})${igMessage ? `: ${igMessage}` : ''}`, base);
    }
    if (res.status === 404) {
      throw new ApiError(CODES.UNEXPECTED_RESPONSE_FORMAT, `HTTP 404${igMessage ? `: ${igMessage}` : ''}. The endpoint may have changed.`, base);
    }
    if (json.status === 'fail' || res.status >= 400) {
      throw new ApiError(CODES.SOFT_FAIL, igMessage || `HTTP ${res.status} with no message`, base);
    }
    return json;
  }

  // ---------------------------------------------------------------------------
  // 5. SCHEMA VALIDATION (failure mode 7) AND NORMALISATION (failure mode 12)
  // ---------------------------------------------------------------------------

  /** Reduce an Instagram user object to what we store. `id` is the numeric user ID (pk). */
  function normalizeUser(u, index) {
    const id = u && (u.pk != null ? u.pk : u.pk_id != null ? u.pk_id : u.id);
    const idStr = id == null ? '' : String(id);
    if (!/^\d+$/.test(idStr)) {
      throw new Error(`users[${index}] has no numeric id (pk). Keys: ${Object.keys(u || {}).slice(0, 12).join(', ')}`);
    }
    if (!u || typeof u.username !== 'string' || !u.username) {
      throw new Error(`users[${index}] has no username`);
    }
    return {
      id: idStr,
      u: u.username,
      n: typeof u.full_name === 'string' ? u.full_name : '',
      p: typeof u.profile_pic_url === 'string' ? u.profile_pic_url : '',
    };
  }

  /** Expected shape: { status: "ok", users: [ {pk, username, ...} ], next_max_id?: string } */
  function validatePage(json) {
    if (json.status !== 'ok') {
      throw new Error(`Expected status "ok" but got ${JSON.stringify(json.status)}`);
    }
    if (!Array.isArray(json.users)) {
      throw new Error(`Response has no "users" array. Top-level keys: ${Object.keys(json).slice(0, 12).join(', ')}`);
    }
    const users = json.users.map(normalizeUser);
    const next = json[CONFIG.nextCursorField];
    return { users, nextCursor: next == null || next === '' ? null : String(next) };
  }

  /** Expected shape: { status: "ok", user: { username, follower_count, following_count } } */
  function validateProfile(json) {
    if (json.status !== 'ok') throw new Error(`Expected status "ok" but got ${JSON.stringify(json.status)}`);
    const u = json.user;
    if (!u || typeof u !== 'object') throw new Error('Response has no "user" object');
    if (typeof u.username !== 'string' || !u.username) throw new Error('user.username is missing');
    const followers = Number(u.follower_count);
    const following = Number(u.following_count);
    if (!Number.isFinite(followers) || !Number.isFinite(following)) {
      throw new Error('user.follower_count / user.following_count are missing or not numbers');
    }
    return { username: u.username, followers, following };
  }

  // ---------------------------------------------------------------------------
  // 6. THE API OBJECT
  // ---------------------------------------------------------------------------

  /**
   * opts.fetchImpl     fetch-compatible function (window.fetch in the content script,
   *                    a mock in mock mode / tests)
   * opts.cookieString  () => document.cookie
   * opts.extraHeaders  optional () => headers merged into every request
   * opts.onRequest     optional ({method,url,status,ms,error}) => void  (debug log)
   * opts.now           optional clock
   */
  function createApi(opts) {
    const fetchImpl = opts.fetchImpl;
    const getCookies = opts.cookieString || (() => '');
    const onRequest = opts.onRequest || (() => {});
    const extraHeaders = opts.extraHeaders || (() => ({}));
    const nowFn = opts.now || (() => Date.now());

    function readSession() {
      return readSessionFromCookies(getCookies());
    }

    /** One GET request. Resolves to { text, url, status } or throws ApiError. */
    async function request(path, query, method) {
      const session = readSession();
      const built = buildHeaders(session);
      Object.assign(built.headers, extraHeaders());
      const relUrl = buildPath(path, query);
      if (built.missing.length) {
        throw new ApiError(CODES.MISSING_HEADER_OR_TOKEN, `Empty required value(s): ${built.missing.join(', ')}. Make sure you are logged in.`, { url: relUrl });
      }
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), CONFIG.TIMEOUT_MS);
      const t0 = nowFn();
      let resp;
      let text;
      try {
        resp = await fetchImpl(relUrl, {
          method: method || 'GET',
          credentials: 'include', // use the existing logged-in session
          headers: method === 'POST' ? Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded' }, built.headers) : built.headers,
          body: method === 'POST' ? '' : undefined,
          signal: ctrl.signal,
          cache: 'no-store',
        });
        text = await resp.text();
      } catch (e) {
        clearTimeout(timer);
        const timedOut = e && e.name === 'AbortError';
        const msg = timedOut ? `Request timed out after ${CONFIG.TIMEOUT_MS / 1000}s` : `Network error: ${(e && e.message) || e}`;
        onRequest({ method: 'GET', url: relUrl, status: 0, ms: nowFn() - t0, error: msg });
        throw new ApiError(CODES.NETWORK_ERROR, msg, { url: relUrl });
      }
      clearTimeout(timer);
      const status = resp.status;
      onRequest({ method: 'GET', url: relUrl, status, ms: nowFn() - t0 });
      const headers = resp.headers;
      return {
        status,
        text,
        url: relUrl,
        parsed: {
          status,
          text,
          url: relUrl,
          contentType: headers && headers.get ? headers.get('content-type') || '' : '',
          finalUrl: resp.redirected ? resp.url || '' : '',
          retryAfterMs: parseRetryAfter(headers && headers.get ? headers.get('retry-after') : null, nowFn()),
        },
      };
    }

    function wrapValidation(fn, res) {
      try {
        return fn();
      } catch (e) {
        throw new ApiError(CODES.UNEXPECTED_RESPONSE_FORMAT, e.message, {
          status: res.status,
          url: res.url,
          snippet: snippetOf(res.text),
          raw: snippetOf(res.text, CONFIG.RAW_CHARS),
        });
      }
    }

    /**
     * Fetch one page of followers or following.
     * kind: 'followers' | 'following'. cursor: null for the first page.
     * Resolves { users:[{id,u,n,p}], nextCursor, raw:{url,status,text} }.
     */
    async function fetchPage(kind, userId, cursor, options) {
      const count = (options && options.count) || CONFIG.PAGE_SIZE;
      const query = { count };
      if (cursor) query[CONFIG.cursorParam] = cursor;
      const res = await request(CONFIG.endpoints[kind](userId), query);
      const json = parseResponse(res.parsed);
      const page = wrapValidation(() => validatePage(json), res);
      return {
        users: page.users,
        nextCursor: page.nextCursor,
        raw: { url: res.url, status: res.status, text: snippetOf(res.text, CONFIG.RAW_CHARS) },
      };
    }

    /** Logged-in user's username plus total follower/following counts. */
    async function fetchProfile(userId) {
      try {
        const res = await request(CONFIG.endpoints.userInfo(userId), {});
        const json = parseResponse(res.parsed);
        const p = wrapValidation(() => validateProfile(json), res);
        return Object.assign({ id: String(userId), raw: { url: res.url, status: res.status, text: snippetOf(res.text, CONFIG.RAW_CHARS) } }, p);
      } catch (e) {
        // /users/{id}/info/ is not served as JSON on www.instagram.com for some sessions.
        // Fall back to current_user (username) + web_profile_info (totals).
        if (!e || e.code !== CODES.WRONG_ORIGIN_OR_HTML_RESPONSE) throw e;
        try {
          const r1 = await request('/api/v1/accounts/current_user/', { edit: 'true' });
          const j1 = parseResponse(r1.parsed);
          const username = j1 && j1.user && j1.user.username;
          if (!username) throw e;
          const r2 = await request('/api/v1/users/web_profile_info/', { username });
          const j2 = parseResponse(r2.parsed);
          const u = j2 && j2.data && j2.data.user;
          const followers = u && u.edge_followed_by && Number(u.edge_followed_by.count);
          const following = u && u.edge_follow && Number(u.edge_follow.count);
          if (!Number.isFinite(followers) || !Number.isFinite(following)) throw e;
          return { id: String(userId), username, followers, following, raw: { url: r2.url, status: r2.status, text: snippetOf(r2.text, CONFIG.RAW_CHARS) } };
        } catch (e2) {
          throw e; // report the original, clearer error
        }
      }
    }

    /** Number of follow requests waiting for the logged-in user's approval. */
    async function fetchPending() {
      const res = await request(CONFIG.endpoints.pending(), {});
      const json = parseResponse(res.parsed);
      return wrapValidation(() => {
        if (json.status !== 'ok' || !Array.isArray(json.users)) throw new Error('Expected status "ok" and a "users" array');
        return { count: json.users.length };
      }, res);
    }

    /** Follow or unfollow one account. action: 'follow' | 'unfollow'. Resolves { following, requested }. */
    async function friendship(action, userId) {
      if (!/^\d+$/.test(String(userId))) throw new ApiError(CODES.UNEXPECTED_RESPONSE_FORMAT, 'This account has no numeric ID (imported lists cannot follow or unfollow).', {});
      const res = await request(CONFIG.endpoints.friendship(action, userId), {}, 'POST');
      const json = parseResponse(res.parsed);
      return wrapValidation(() => {
        if (json.status !== 'ok') throw new Error(`Expected status "ok" but got ${JSON.stringify(json.status)}`);
        const fs = json.friendship_status || {};
        return { following: !!fs.following, requested: !!fs.outgoing_request };
      }, res);
    }

    return { readSession, fetchPage, fetchProfile, fetchPending, friendship };
  }

  return {
    CONFIG,
    CODES,
    RETRYABLE,
    ApiError,
    createApi,
    // exported for unit tests
    parseResponse,
    validatePage,
    validateProfile,
    normalizeUser,
    buildHeaders,
    buildPath,
    getCookie,
    readSessionFromCookies,
    parseRetryAfter,
  };
});
