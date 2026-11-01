/**
 * mock-api.js
 * ============================================================================
 * A fake "Instagram" for testing error handling, pause/resume and ETA without
 * touching the real service. It returns fetch-compatible Response objects with
 * the same JSON shapes instagram-api.js expects.
 *
 * Scenarios (the Nth request is counted over full-size scan batches only, so the
 * small pre-flight / sample requests never trigger a fault):
 *
 *   normal          clean paging
 *   ratelimit       HTTP 429 (Retry-After: 2) on batch requests #3 and #4, then recovers
 *   ratelimit_hard  HTTP 429 forever from request #3 -> 5 retries, then auto-pause
 *   network         network failure on requests #3 and #4 (auto-retried), then recovers
 *   softfail        HTTP 200 {"status":"fail"} once on request #4
 *   blocked         "feedback_required / Try again later" once on request #4 (ACTION_BLOCKED)
 *   session         login_required once on request #4 (SESSION_EXPIRED)
 *   challenge       checkpoint_required once on request #4 (CHALLENGE_REQUIRED)
 *   malformed       200 {"status":"ok"} without "users" once on request #4
 *   html            an HTML page instead of JSON once on request #4
 *   expiredcursor   cursors are only valid for 2 minutes (and only for this page load):
 *                   pause, wait, resume -> "Saved position expired" path
 *   incomplete      profile claims 40 more followers than the list delivers (INCOMPLETE_DATA)
 *
 * "once" faults hit exactly one request; pressing Resume retries the same batch
 * and succeeds, which is how pause-on-error + resume gets exercised.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IGMock = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SCENARIOS = {
    normal: 'Normal paging',
    ratelimit: '429 rate limit on batches 3-4, then recovers',
    ratelimit_hard: '429 forever -> 5 retries, then pause',
    network: 'Network failure on batches 3-4, then recovers',
    softfail: 'Soft failure (status: fail) once',
    blocked: 'Action blocked ("Try again later") once',
    session: 'Session expired (login_required) once',
    challenge: 'Challenge required (checkpoint) once',
    malformed: 'Malformed JSON shape once',
    html: 'HTML page instead of JSON once',
    expiredcursor: 'Cursor expires after 2 min (pause, wait, resume)',
    incomplete: 'Profile count higher than list (INCOMPLETE_DATA)',
    profile429: 'Profile-totals call returns 429 (scan still runs, totals unverified)',
  };

  const ME = { id: '1000', username: 'mock_me' };
  const FIRST = ['Ava', 'Noah', 'Zoë', 'Liam', 'Sakura', 'Mateo', 'Priya', 'Chloé', 'Hiro', 'Léa', 'Omar', 'Ines', 'Yuki', 'Anders', 'Fatima'];
  const LAST = ['Müller', 'Smith', '田中', 'García', 'Nguyen', 'Kowalski', 'Rossi', 'Haddad', 'Johansson', 'Silva'];

  function person(k, tag) {
    const first = FIRST[k % FIRST.length];
    const last = LAST[Math.floor(k / FIRST.length) % LAST.length];
    return {
      pk: String(2000 + k),
      username: `${tag}_${k}`,
      full_name: k % 11 === 0 ? '' : `${first} ${last}`,
      profile_pic_url: `https://example.invalid/avatars/${2000 + k}.jpg`,
    };
  }

  /** followers F, following M, of which `mutual` appear in both lists. */
  function buildDataset(o) {
    const F = (o && o.followers) || 230;
    const M = (o && o.following) || 260;
    const mutual = Math.min((o && o.mutual) || 170, F, M);
    const followers = [];
    const following = [];
    for (let k = 0; k < F; k++) followers.push(person(k, k < mutual ? 'friend' : 'fan'));
    for (let k = 0; k < mutual; k++) following.push(person(k, 'friend'));
    for (let k = 0; k < M - mutual; k++) following.push(person(F + k, 'idol'));
    const fset = new Set(followers.map((u) => u.pk));
    return {
      followers,
      following,
      nonFollowerIds: following.filter((u) => !fset.has(u.pk)).map((u) => u.pk),
      fanIds: followers.filter((u) => !following.some((g) => g.pk === u.pk)).map((u) => u.pk),
    };
  }

  /**
   * options: scenario, followers, following, mutual, latencyMs, now, cursorTtlMs, token
   * Returns { fetchImpl, cookieString, dataset, token, requestCount() }.
   */
  function createMock(options) {
    const o = options || {};
    const scenario = o.scenario || 'normal';
    const ds = buildDataset(o);
    const token = o.token || Math.random().toString(36).slice(2, 8);
    const now = o.now || (() => Date.now());
    const ttl = scenario === 'expiredcursor' ? o.cursorTtlMs || 120000 : Infinity; // only this scenario expires cursors by age
    const latency = o.latencyMs || 0;
    let batchRequests = 0;

    const json = (status, body, headers) =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, headers || {}),
      });

    /** Fault for the Nth scan-batch request, or null. Returns a thunk (may throw). */
    function faultFor(n) {
      switch (scenario) {
        case 'ratelimit':
          return n === 3 || n === 4
            ? () => json(429, { message: 'Please wait a few minutes before you try again.', status: 'fail' }, { 'Retry-After': '2' })
            : null;
        case 'ratelimit_hard':
          return n >= 3 ? () => json(429, { message: 'Please wait a few minutes before you try again.', status: 'fail' }, { 'Retry-After': '1' }) : null;
        case 'network':
          return n === 3 || n === 4
            ? () => {
                throw new TypeError('Failed to fetch');
              }
            : null;
        case 'softfail':
          return n === 4 ? () => json(200, { status: 'fail', message: 'Something went wrong. Please try again.' }) : null;
        case 'blocked':
          return n === 4
            ? () =>
                json(400, {
                  message: 'feedback_required',
                  feedback_title: 'Try Again Later',
                  feedback_message: 'We limit how often you can do certain things on Instagram to protect our community.',
                  status: 'fail',
                })
            : null;
        case 'session':
          return n === 4 ? () => json(403, { message: 'login_required', status: 'fail' }) : null;
        case 'challenge':
          return n === 4 ? () => json(400, { message: 'checkpoint_required', checkpoint_url: '/challenge/', status: 'fail' }) : null;
        case 'malformed':
          return n === 4 ? () => json(200, { status: 'ok', surprise: 'no users array here' }) : null;
        case 'html':
          return n === 4
            ? () =>
                new Response('<!DOCTYPE html><html><head><title>Login • Instagram</title></head><body>Log in</body></html>', {
                  status: 200,
                  headers: { 'content-type': 'text/html' },
                })
            : null;
        default:
          return null;
      }
    }

    const cursorOf = (kind, offset) => `${kind[0]}${offset}.${token}.${now()}`;
    function parseCursor(kind, cursor) {
      const m = /^([fg])(\d+)\.([a-z0-9]+)\.(\d+)$/.exec(cursor || '');
      if (!m || m[1] !== kind[0] || m[3] !== token) return null;
      if (now() - Number(m[4]) > ttl) return null;
      return Number(m[2]);
    }

    async function fetchImpl(input, init) {
      if (latency) await new Promise((r) => setTimeout(r, latency));
      if (init && init.signal && init.signal.aborted) {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }
      const url = new URL(String(input), 'https://www.instagram.com');
      const fr = /^\/api\/v1\/friendships\/(\d+)\/(followers|following)\/$/.exec(url.pathname);
      if (fr) {
        const kind = fr[2];
        const count = Number(url.searchParams.get('count')) || 12;
        const isBatch = count >= 50;
        if (isBatch) {
          batchRequests += 1;
          const fault = faultFor(batchRequests);
          if (fault) return fault();
        }
        const cursor = url.searchParams.get('max_id');
        let offset = 0;
        if (cursor) {
          const parsed = parseCursor(kind, cursor);
          if (parsed == null) return json(400, { message: 'Invalid max_id: the cursor is no longer valid.', status: 'fail' });
          offset = parsed;
        }
        const list = kind === 'followers' ? ds.followers : ds.following;
        const users = list.slice(offset, offset + count).map((u) => Object.assign({ pk_id: u.pk, is_private: false }, u));
        const body = { users, big_list: offset + count < list.length, page_size: count, status: 'ok' };
        if (offset + count < list.length) body.next_max_id = cursorOf(kind, offset + count);
        return json(200, body);
      }
      const info = /^\/api\/v1\/users\/(\d+)\/info\/$/.exec(url.pathname);
      if (info) {
        if (scenario === 'profile429') return json(429, { message: 'Please wait a few minutes before you try again.', status: 'fail' });
        return json(200, {
          user: {
            pk: ME.id,
            username: ME.username,
            follower_count: ds.followers.length + (scenario === 'incomplete' ? 40 : 0),
            following_count: ds.following.length,
          },
          status: 'ok',
        });
      }
      const fa = /^\/api\/v1\/friendships\/(create|destroy)\/(\d+)\/$/.exec(url.pathname);
      if (fa) return json(200, { friendship_status: { following: fa[1] === 'create', outgoing_request: false }, status: 'ok' });
      if (url.pathname === '/api/v1/friendships/pending/') {
        return json(200, { users: [{ pk: '1', username: 'mock_requester' }, { pk: '2', username: 'mock_requester2' }, { pk: '3', username: 'mock_requester3' }], status: 'ok' });
      }
      return json(404, { message: 'Not found', status: 'fail' });
    }

    return {
      fetchImpl,
      cookieString: () => `csrftoken=mock-csrf-token; ds_user_id=${ME.id}`,
      dataset: ds,
      token,
      me: ME,
      requestCount: () => batchRequests,
    };
  }

  return { SCENARIOS, createMock, buildDataset, ME };
});
