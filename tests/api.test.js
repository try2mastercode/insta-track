const test = require('node:test');
const assert = require('node:assert/strict');
const Api = require('../instagram-api.js');
const Mock = require('../mock-api.js');

const res = (status, body, extra = {}) => ({
  status,
  text: typeof body === 'string' ? body : JSON.stringify(body),
  url: '/api/v1/x',
  contentType: 'application/json',
  finalUrl: '',
  retryAfterMs: null,
  ...extra,
});
const errOf = (fn) => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return null;
};
const codeOf = (fn) => (errOf(fn) || {}).code || null;

test('classifies the known failure modes', () => {
  assert.equal(codeOf(() => Api.parseResponse(res(429, { message: 'wait', status: 'fail' }))), 'RATE_LIMITED_429');
  assert.equal(codeOf(() => Api.parseResponse(res(200, '<html>login</html>', { contentType: 'text/html' }))), 'WRONG_ORIGIN_OR_HTML_RESPONSE');
  assert.equal(codeOf(() => Api.parseResponse(res(403, ''))), 'WRONG_ORIGIN_OR_HTML_RESPONSE');
  assert.equal(codeOf(() => Api.parseResponse(res(200, { status: 'fail', message: 'Something went wrong' }))), 'SOFT_FAIL');
  assert.equal(codeOf(() => Api.parseResponse(res(400, { message: 'feedback_required', status: 'fail' }))), 'ACTION_BLOCKED');
  assert.equal(codeOf(() => Api.parseResponse(res(400, { message: 'Please wait a few minutes before you try again.', status: 'fail' }))), 'ACTION_BLOCKED');
  assert.equal(codeOf(() => Api.parseResponse(res(403, { message: 'login_required', status: 'fail' }))), 'SESSION_EXPIRED');
  assert.equal(codeOf(() => Api.parseResponse(res(200, '', { finalUrl: 'https://www.instagram.com/accounts/login/?next=/' }))), 'SESSION_EXPIRED');
  assert.equal(codeOf(() => Api.parseResponse(res(400, { message: 'checkpoint_required', checkpoint_url: '/challenge/', status: 'fail' }))), 'CHALLENGE_REQUIRED');
  assert.equal(codeOf(() => Api.parseResponse(res(200, '', { finalUrl: 'https://www.instagram.com/challenge/abc' }))), 'CHALLENGE_REQUIRED');
  assert.equal(codeOf(() => Api.parseResponse(res(404, 'Not found'))), 'UNEXPECTED_RESPONSE_FORMAT');
  assert.equal(codeOf(() => Api.parseResponse(res(503, 'oops'))), 'NETWORK_ERROR');
});

test('only 429 and network errors are retryable; Retry-After is carried through', () => {
  const e429 = errOf(() => Api.parseResponse(res(429, {}, { retryAfterMs: 5000 })));
  assert.equal(e429.retryable, true);
  assert.equal(e429.retryAfterMs, 5000);
  assert.equal(errOf(() => Api.parseResponse(res(200, { status: 'fail' }))).retryable, false);
  assert.equal(errOf(() => Api.parseResponse(res(400, { message: 'feedback_required', status: 'fail' }))).retryable, false);
});

test('error entries keep a raw snippet of at most ~500 characters', () => {
  const e = errOf(() => Api.parseResponse(res(200, 'x'.repeat(5000), { contentType: 'text/html' })));
  assert.equal(e.snippet.length, 500);
  assert.ok(e.raw.length > 500);
});

test('validatePage requires status ok and a users array', () => {
  assert.throws(() => Api.validatePage({ status: 'ok' }), /no "users" array/);
  assert.throws(() => Api.validatePage({ status: 'fail', users: [] }), /Expected status "ok"/);
  assert.throws(() => Api.validatePage({ status: 'ok', users: [{ username: 'x' }] }), /numeric id/);
  const p = Api.validatePage({ status: 'ok', users: [{ pk: 5, username: 'x', full_name: 'X' }], next_max_id: 'abc' });
  assert.equal(p.users[0].id, '5');
  assert.equal(p.nextCursor, 'abc');
  assert.equal(Api.validatePage({ status: 'ok', users: [] }).nextCursor, null);
});

test('headers: reports which values are empty without exposing values', () => {
  const b = Api.buildHeaders({ csrftoken: '', ds_user_id: '42' });
  assert.deepEqual(b.missing, ['csrftoken cookie']);
  const ok = Api.buildHeaders({ csrftoken: 'tok', ds_user_id: '42' });
  assert.equal(ok.missing.length, 0);
  assert.equal(ok.headers['X-CSRFToken'], 'tok');
  assert.equal(ok.headers['X-Requested-With'], 'XMLHttpRequest');
  assert.ok(ok.headers['X-IG-App-ID']);
});

test('cookie parsing', () => {
  const s = Api.readSessionFromCookies('a=1; csrftoken=abc%3D; ds_user_id=99; z=2');
  assert.equal(s.csrftoken, 'abc=');
  assert.equal(s.ds_user_id, '99');
});

test('Retry-After parsing (seconds and HTTP date)', () => {
  assert.equal(Api.parseRetryAfter('30'), 30000);
  assert.equal(Api.parseRetryAfter(null), null);
  const future = new Date(Date.now() + 60000).toUTCString();
  const ms = Api.parseRetryAfter(future, Date.now());
  assert.ok(ms > 55000 && ms <= 61000);
});

test('createApi + mock: normal paging reaches the end and every user is normalised', async () => {
  const mock = Mock.createMock({ followers: 120, following: 80, mutual: 60 });
  const api = Api.createApi({ fetchImpl: mock.fetchImpl, cookieString: mock.cookieString });
  let cursor = null;
  const ids = new Set();
  let pages = 0;
  do {
    const p = await api.fetchPage('followers', '1000', cursor, { count: 50 });
    p.users.forEach((x) => ids.add(x.id));
    cursor = p.nextCursor;
    pages += 1;
  } while (cursor);
  assert.equal(pages, 3);
  assert.equal(ids.size, 120);
  const prof = await api.fetchProfile('1000');
  assert.equal(prof.followers, 120);
  assert.equal(prof.username, 'mock_me');
});

test('createApi + mock scenarios surface the right codes', async () => {
  const run = async (scenario) => {
    const mock = Mock.createMock({ scenario });
    const api = Api.createApi({ fetchImpl: mock.fetchImpl, cookieString: mock.cookieString });
    let cursor = null;
    for (let i = 0; i < 6; i++) {
      try {
        const p = await api.fetchPage('followers', '1000', cursor, { count: 50 });
        cursor = p.nextCursor;
        if (!cursor) return 'done';
      } catch (e) {
        return e.code;
      }
    }
    return 'ok';
  };
  assert.equal(await run('ratelimit'), 'RATE_LIMITED_429');
  assert.equal(await run('network'), 'NETWORK_ERROR');
  assert.equal(await run('softfail'), 'SOFT_FAIL');
  assert.equal(await run('blocked'), 'ACTION_BLOCKED');
  assert.equal(await run('session'), 'SESSION_EXPIRED');
  assert.equal(await run('challenge'), 'CHALLENGE_REQUIRED');
  assert.equal(await run('malformed'), 'UNEXPECTED_RESPONSE_FORMAT');
  assert.equal(await run('html'), 'WRONG_ORIGIN_OR_HTML_RESPONSE');
});

test('missing cookies -> MISSING_HEADER_OR_TOKEN before any request is sent', async () => {
  let called = false;
  const api = Api.createApi({
    fetchImpl: async () => {
      called = true;
    },
    cookieString: () => 'ds_user_id=1',
  });
  await assert.rejects(api.fetchPage('followers', '1', null), (e) => e.code === 'MISSING_HEADER_OR_TOKEN');
  assert.equal(called, false);
});
