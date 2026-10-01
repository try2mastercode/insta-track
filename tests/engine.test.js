const test = require('node:test');
const assert = require('node:assert/strict');
const { makeStorage, makeClock, makeTab } = require('./helpers.js');

// Silence the engine's console logging during tests.
const realLog = console.log;
const realWarn = console.warn;
test.before(() => {
  console.log = () => {};
  console.warn = () => {};
});
test.after(() => {
  console.log = realLog;
  console.warn = realWarn;
});

const errorsOf = (storage) => storage.data.errors || [];
const codes = (storage) => errorsOf(storage).map((e) => e.code);

test('normal scan: saves progress, computes results only at the end, verifies completeness', async () => {
  const storage = makeStorage();
  const clock = makeClock();
  let partialResultsSeen = false;
  const tab = makeTab({
    storage,
    clock,
    scenario: 'normal',
    onSleep: () => {
      if (storage.data.results) partialResultsSeen = true; // results must not exist mid-scan
    },
  });
  const r = await tab.engine.start({ mode: 'fresh' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.steps.map((s) => s.ok), [true, true, true, true]);
  await tab.engine.whenIdle();

  const scan = storage.data.scan;
  assert.equal(scan.status, 'complete');
  assert.equal(scan.phases.followers.status, 'complete');
  assert.equal(scan.phases.following.status, 'complete');
  assert.equal(scan.phases.followers.collected, 230);
  assert.equal(scan.phases.following.collected, 260);
  assert.equal(partialResultsSeen, false);

  const res = storage.data.results;
  assert.equal(res.nonFollowers.length, 90);
  assert.equal(res.fans.length, 60);
  assert.deepEqual(
    res.nonFollowers.map((x) => x.id).sort(),
    tab.mock.dataset.nonFollowerIds.slice().sort()
  );
  assert.equal(res.incomplete.length, 0);
  assert.equal(storage.data.lock, undefined, 'lock released when finished');
  assert.ok(tab.events.some((e) => e.type === 'complete' && e.count === 90));
  assert.ok(scan.totalActiveMs > 0);
  assert.equal(storage.data.lastSession.username, 'mock_me');
  assert.ok((storage.data.debuglog || []).length > 0, 'requests are logged');
});

test('pacing: 2-5 s delays with a longer 20-60 s pause every 5-8 batches', async () => {
  const storage = makeStorage();
  const clock = makeClock();
  const waits = [];
  const tab = makeTab({
    storage,
    clock,
    mockOpts: { followers: 600, following: 10, mutual: 5 },
    onSleep: () => {},
  });
  // Observe waitReason transitions through the stored meta.
  let last = null;
  const origSet = storage.set;
  storage.set = async (o) => {
    if (o.scan && o.scan.waitUntil && o.scan.waitReason !== last) {
      last = o.scan.waitReason;
      waits.push({ reason: o.scan.waitReason, ms: o.scan.waitUntil - clock.t });
    }
    return origSet(o);
  };
  await tab.engine.start({ mode: 'fresh' });
  await tab.engine.whenIdle();
  const short = waits.filter((w) => w.reason === 'pacing');
  const long = waits.filter((w) => w.reason === 'long_pause');
  assert.ok(short.length > 0 && long.length > 0);
  short.forEach((w) => assert.ok(w.ms >= 2000 && w.ms <= 5000, `short delay ${w.ms}`));
  long.forEach((w) => assert.ok(w.ms >= 20000 && w.ms <= 60000, `long pause ${w.ms}`));
  assert.equal(new Set(short.map((w) => w.ms)).size > 1, true, 'delays are randomised, not fixed');
});

test('429: auto-retries (logged as auto-retrying), honours Retry-After, then recovers', async () => {
  const storage = makeStorage();
  const clock = makeClock();
  const tab = makeTab({ storage, clock, scenario: 'ratelimit' });
  await tab.engine.start({ mode: 'fresh' });
  await tab.engine.whenIdle();
  assert.equal(storage.data.scan.status, 'complete');
  const rl = errorsOf(storage).filter((e) => e.code === 'RATE_LIMITED_429');
  assert.equal(rl.length, 2);
  rl.forEach((e) => {
    assert.equal(e.autoRetrying, true);
    assert.equal(e.status, 429);
    assert.ok(e.nextRetryAt > e.ts);
    assert.ok(e.nextRetryAt - e.ts >= 2000 && e.nextRetryAt - e.ts <= 4100, 'Retry-After: 2 honoured');
  });
  assert.equal(storage.data.results.nonFollowers.length, 90);
});

test('429 forever: 5 retries then automatic pause; Resume retries the same batch', async () => {
  const storage = makeStorage();
  const clock = makeClock();
  const tab = makeTab({ storage, clock, scenario: 'ratelimit_hard' });
  await tab.engine.start({ mode: 'fresh' });
  await tab.engine.whenIdle();
  let scan = storage.data.scan;
  assert.equal(scan.status, 'paused');
  assert.equal(scan.pauseReason, 'error');
  assert.match(scan.statusText, /after 5 retries/);
  const rl = errorsOf(storage).filter((e) => e.code === 'RATE_LIMITED_429');
  assert.equal(rl.length, 6, '1 initial + 5 retries');
  assert.equal(rl.filter((e) => e.autoRetrying).length, 5);
  assert.equal(rl[5].autoRetrying, false);
  assert.equal(rl[5].retryCount, 5);
  assert.equal(storage.data.lock, undefined);
  const stalledAt = scan.phases.followers.batches;
  const cursorAtPause = scan.phases.followers.cursor;
  assert.ok(cursorAtPause, 'cursor saved at pause');
  assert.ok(tab.events.some((e) => e.type === 'paused_error'));

  // Fresh page load, healthy Instagram: Resume continues from the exact saved cursor.
  // (A new mock has a new cursor token, which is the expired-cursor path; use the same token.)
  const tab2 = makeTab({ storage, clock, scenario: 'normal', mockOpts: { token: tab.mock.token } });
  const r = await tab2.engine.start({ mode: 'resume' });
  assert.equal(r.ok, true);
  await tab2.engine.whenIdle();
  scan = storage.data.scan;
  assert.equal(scan.status, 'complete');
  assert.ok(scan.phases.followers.batches >= stalledAt + 1);
  assert.equal(scan.phases.followers.cursorResets, 0, 'resumed from the saved cursor, no restart');
  assert.equal(storage.data.results.nonFollowers.length, 90);
});

test('network failures are retried with backoff and logged', async () => {
  const storage = makeStorage();
  const clock = makeClock();
  const tab = makeTab({ storage, clock, scenario: 'network' });
  await tab.engine.start({ mode: 'fresh' });
  await tab.engine.whenIdle();
  assert.equal(storage.data.scan.status, 'complete');
  const net = errorsOf(storage).filter((e) => e.code === 'NETWORK_ERROR');
  assert.equal(net.length, 2);
  assert.ok(net.every((e) => e.autoRetrying));
  // first backoff ~60s (+/- 20% jitter), second ~120s
  assert.ok(net[0].nextRetryAt - net[0].ts >= 48000 && net[0].nextRetryAt - net[0].ts <= 72000);
  assert.ok(net[1].nextRetryAt - net[1].ts >= 96000 && net[1].nextRetryAt - net[1].ts <= 144000);
});

for (const [scenario, code] of [
  ['softfail', 'SOFT_FAIL'],
  ['blocked', 'ACTION_BLOCKED'],
  ['session', 'SESSION_EXPIRED'],
  ['challenge', 'CHALLENGE_REQUIRED'],
  ['malformed', 'UNEXPECTED_RESPONSE_FORMAT'],
  ['html', 'WRONG_ORIGIN_OR_HTML_RESPONSE'],
]) {
  test(`serious error ${code}: pauses immediately with no retries; Resume retries the same batch`, async () => {
    const storage = makeStorage();
    const clock = makeClock();
    const tab = makeTab({ storage, clock, scenario });
    await tab.engine.start({ mode: 'fresh' });
    await tab.engine.whenIdle();
    let scan = storage.data.scan;
    assert.equal(scan.status, 'paused');
    assert.equal(scan.pauseReason, 'error');
    const errs = errorsOf(storage).filter((e) => e.code === code);
    assert.equal(errs.length, 1, 'logged exactly once, no retries');
    assert.equal(errs[0].autoRetrying, false);
    assert.equal(errs[0].retryCount, 0);
    assert.ok(errs[0].snippet.length > 0);
    assert.equal(errs[0].phase, 'Followers');
    assert.equal(errs[0].batch, 4 > 5 ? null : errs[0].batch);
    assert.equal(storage.data.results, undefined, 'no results while paused');
    const batchesBefore = scan.phases.followers.batches;

    // Resume (same page load: the mock fault was one-shot)
    const r = await tab.engine.start({ mode: 'resume' });
    assert.equal(r.ok, true);
    await tab.engine.whenIdle();
    scan = storage.data.scan;
    assert.equal(scan.status, 'complete');
    assert.ok(scan.phases.followers.batches > batchesBefore);
    assert.equal(storage.data.results.nonFollowers.length, 90, 'no account lost across the pause');
    assert.equal(scan.phases.followers.collected, 230);
  });
}

test('manual pause saves progress; resume continues; no duplicates', async () => {
  const storage = makeStorage();
  const clock = makeClock();
  const tab = makeTab({
    storage,
    clock,
    onSleep: (n, engine) => {
      if (n === 3) engine.pause();
    },
  });
  await tab.engine.start({ mode: 'fresh' });
  await tab.engine.whenIdle();
  let scan = storage.data.scan;
  assert.equal(scan.status, 'paused');
  assert.equal(scan.pauseReason, 'manual');
  assert.ok(scan.phases.followers.collected > 0 && scan.phases.followers.collected < 230);
  assert.equal(Object.keys(storage.data.users_followers).length, scan.phases.followers.collected);
  assert.equal(storage.data.results, undefined);

  const tab2 = makeTab({ storage, clock, mockOpts: { token: tab.mock.token } });
  await tab2.engine.start({ mode: 'resume' });
  await tab2.engine.whenIdle();
  assert.equal(storage.data.scan.status, 'complete');
  assert.equal(Object.keys(storage.data.users_followers).length, 230);
  assert.equal(storage.data.results.nonFollowers.length, 90);
});

test('resume with Followers already complete only fetches Following', async () => {
  const storage = makeStorage();
  const clock = makeClock();
  const tab = makeTab({
    storage,
    clock,
    onSleep: (n, engine) => {
      // pause once Following has started
      const m = engine.getMeta();
      if (m && m.phases.following.batches >= 1) engine.pause();
    },
  });
  await tab.engine.start({ mode: 'fresh' });
  await tab.engine.whenIdle();
  assert.equal(storage.data.scan.phases.followers.status, 'complete');
  assert.equal(storage.data.scan.status, 'paused');

  const tab2 = makeTab({ storage, clock, mockOpts: { token: tab.mock.token } });
  await tab2.engine.start({ mode: 'resume' });
  await tab2.engine.whenIdle();
  assert.equal(storage.data.scan.status, 'complete');
  // followers: 1 pre-flight request was count=1; scan batches should only be following pages (6 total across both runs minus those)
  const followerBatchRequests = (storage.data.debuglog || []).filter((l) => /followers\/\?count=50/.test(l)).length;
  assert.equal(followerBatchRequests, 5, 'followers fetched exactly once (5 batches of 50 for 230 accounts)');
});

test('expired cursor on resume: collected accounts are kept, list restarts, results stay complete', async () => {
  const storage = makeStorage();
  const clock = makeClock();
  const tab = makeTab({
    storage,
    clock,
    onSleep: (n, engine) => {
      if (n === 3) engine.pause();
    },
  });
  await tab.engine.start({ mode: 'fresh' });
  await tab.engine.whenIdle();
  const before = Object.keys(storage.data.users_followers).length;
  assert.ok(before > 0 && before < 230);

  // "Next day": new page load -> new mock token -> every old cursor is rejected.
  clock.t += 24 * 3600 * 1000;
  const tab2 = makeTab({ storage, clock });
  await tab2.engine.start({ mode: 'resume' });
  await tab2.engine.whenIdle();
  const scan = storage.data.scan;
  assert.equal(scan.status, 'complete');
  assert.equal(scan.phases.followers.cursorResets, 1);
  assert.equal(Object.keys(storage.data.users_followers).length, 230, 'no duplicates, nothing lost');
  assert.equal(storage.data.results.nonFollowers.length, 90);
  const expiryEntry = errorsOf(storage).find((e) => e.note && /Saved cursor rejected/.test(e.note));
  assert.ok(expiryEntry, 'the rejection is visible in the error log');
});

test('completeness check: INCOMPLETE_DATA is recorded with exact numbers', async () => {
  const storage = makeStorage();
  const clock = makeClock();
  const tab = makeTab({ storage, clock, scenario: 'incomplete' });
  await tab.engine.start({ mode: 'fresh' });
  await tab.engine.whenIdle();
  const res = storage.data.results;
  assert.equal(storage.data.scan.status, 'complete');
  assert.deepEqual(res.incomplete, [{ phase: 'followers', expected: 270, collected: 230 }]);
  const e = errorsOf(storage).find((x) => x.code === 'INCOMPLETE_DATA');
  assert.match(e.message, /Followers: collected 230 of 270/);
  assert.ok(tab.events.some((ev) => ev.type === 'complete' && ev.incomplete === 1));

  // Re-scan just the affected phase keeps the collected accounts and re-verifies.
  const tab2 = makeTab({ storage, clock, scenario: 'incomplete' });
  const r = await tab2.engine.start({ mode: 'resume', rescan: 'followers' });
  assert.equal(r.ok, true);
  assert.equal(storage.data.results, undefined, 'old results hidden while re-scanning');
  await tab2.engine.whenIdle();
  assert.equal(Object.keys(storage.data.users_followers).length, 230);
  assert.equal(storage.data.results.incomplete.length, 1);
});

test('saved progress belongs to one account: a different login is refused, fresh is allowed', async () => {
  const storage = makeStorage();
  const clock = makeClock();
  const tab = makeTab({
    storage,
    clock,
    onSleep: (n, engine) => {
      if (n === 2) engine.pause();
    },
  });
  await tab.engine.start({ mode: 'fresh' });
  await tab.engine.whenIdle();
  const saved = storage.data.scan.account;
  storage.data.scan.account = { id: '555', username: 'someone_else' }; // pretend progress is from another account

  const tab2 = makeTab({ storage, clock, mockOpts: { token: tab.mock.token } });
  const r = await tab2.engine.start({ mode: 'resume' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ACCOUNT_MISMATCH');
  assert.equal(r.savedAccount.username, 'someone_else');
  assert.equal(r.account.id, saved.id);

  const r2 = await tab2.engine.start({ mode: 'fresh' });
  assert.equal(r2.ok, true);
  await tab2.engine.whenIdle();
  assert.equal(storage.data.scan.account.id, saved.id);
  assert.equal(storage.data.scan.status, 'complete');
});

test('single active scan: a second tab cannot start while the first holds the lock', async () => {
  const storage = makeStorage();
  const clock = makeClock();
  let second;
  const tab = makeTab({
    storage,
    clock,
    instanceId: 'tab-A',
    onSleep: (n, engine) => {
      if (n === 2 && !second) {
        second = makeTab({ storage, clock, instanceId: 'tab-B' });
        second.promise = second.engine.start({ mode: 'resume' });
        engine.pause();
      }
    },
  });
  await tab.engine.start({ mode: 'fresh' });
  await tab.engine.whenIdle();
  const r = await second.promise;
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PREFLIGHT_FAILED');
  const lockStep = r.steps.find((s) => s.id === 'lock');
  assert.equal(lockStep.ok, false);
  assert.match(lockStep.detail, /Another scan holds the lock/);
  assert.ok(codes(storage).includes('SCAN_ALREADY_ACTIVE'));
});

test('pre-flight reports exactly which step failed and starts nothing', async () => {
  const storage = makeStorage();
  const clock = makeClock();
  const tab = makeTab({ storage, clock, scenario: 'session' });
  // make the very first (pre-flight) friendships request fail: use a scenario-less tab with no cookies
  const noCookies = require('../instagram-api.js').createApi({ fetchImpl: tab.mock.fetchImpl, cookieString: () => 'foo=bar' });
  const Engine = require('../scan-engine.js');
  const engine = Engine.createEngine({ storage, api: noCookies, now: clock.now, sleep: clock.sleep });
  const r = await engine.start({ mode: 'fresh' });
  assert.equal(r.ok, false);
  assert.equal(r.steps.length, 1);
  assert.equal(r.steps[0].id, 'login');
  assert.equal(r.steps[0].ok, false);
  assert.equal(storage.data.scan, undefined, 'nothing started');
  assert.equal(errorsOf(storage)[0].phase, 'Pre-flight');
});

test('ETA shows Calculating... first, then a value that shrinks', async () => {
  const storage = makeStorage();
  const clock = makeClock();
  const seen = [];
  const origSet = storage.set;
  storage.set = async (o) => {
    if (o.scan && o.scan.status === 'running') seen.push(o.scan.eta ? JSON.stringify(o.scan.eta.calculating ? 'calc' : o.scan.eta.ms) : 'none');
    return origSet(o);
  };
  const tab = makeTab({ storage, clock, mockOpts: { followers: 900, following: 10, mutual: 5 } });
  await tab.engine.start({ mode: 'fresh' });
  await tab.engine.whenIdle();
  const first = seen.find((s) => s !== 'none');
  assert.equal(first, '"calc"');
  const nums = seen.filter((s) => /^\d+$/.test(s)).map(Number);
  assert.ok(nums.length > 3, 'numeric ETA appears after a few batches');
  assert.ok(nums[nums.length - 1] < nums[0], 'ETA shrinks as the scan progresses');
});

test('a late timer (hidden tab) is never treated as an error', async () => {
  const storage = makeStorage();
  const clock = makeClock();
  // every sleep overshoots by 10 minutes, as a heavily throttled hidden tab might
  const tab = makeTab({ storage, clock, onSleep: () => (clock.t += 10 * 60 * 1000) });
  await tab.engine.start({ mode: 'fresh' });
  await tab.engine.whenIdle();
  assert.equal(storage.data.scan.status, 'complete');
  assert.equal(codes(storage).length, 0);
});

test('interrupt (tab closed/reloaded) is recorded as CONTENT_SCRIPT_DISCONNECTED and progress stays', async () => {
  const storage = makeStorage();
  const clock = makeClock();
  const tab = makeTab({
    storage,
    clock,
    onSleep: (n, engine) => {
      if (n === 3) engine.interrupt();
    },
  });
  await tab.engine.start({ mode: 'fresh' });
  await tab.engine.whenIdle();
  const scan = storage.data.scan;
  assert.equal(scan.status, 'paused');
  assert.equal(scan.pauseReason, 'interrupted');
  assert.ok(codes(storage).includes('CONTENT_SCRIPT_DISCONNECTED'));
  assert.ok(Object.keys(storage.data.users_followers).length > 0);
  assert.equal(storage.data.lock, undefined);
});

test('profile-totals 429: retried, then the scan still runs with a visible warning and "not verified" results', async () => {
  const storage = makeStorage();
  const clock = makeClock();
  const tab = makeTab({ storage, clock, scenario: 'profile429' });
  const r = await tab.engine.start({ mode: 'fresh' });
  assert.equal(r.ok, true);
  const counts = r.steps.find((s) => s.id === 'counts');
  assert.equal(counts.ok, true);
  assert.equal(counts.warn, true);
  const logged = errorsOf(storage).filter((e) => e.code === 'RATE_LIMITED_429' && e.phase === 'Pre-flight');
  assert.equal(logged.length >= 3, true, 'initial attempt + retries are logged');
  await tab.engine.whenIdle();
  assert.equal(storage.data.scan.status, 'complete');
  assert.equal(storage.data.results.countsUnavailable, true);
  assert.equal(storage.data.results.nonFollowers.length, 90);
});
