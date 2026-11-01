const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../shared.js');

const u = (id, name, full = '') => ({ id: String(id), u: name, n: full, p: '' });

test('computeByIds matches by numeric ID, so a renamed account is not a non-follower', () => {
  const followers = [u(1, 'alice_new_name'), u(2, 'bob')];
  const following = [u(1, 'alice_old_name'), u(2, 'bob'), u(3, 'carol')];
  const r = S.computeByIds(followers, following);
  assert.deepEqual(r.nonFollowers.map((x) => x.id), ['3']);
  assert.equal(r.fans.length, 0);
  assert.equal(r.mutualCount, 2);
});

test('computeByIds returns fans (follow me, I do not follow back)', () => {
  const r = S.computeByIds([u(1, 'a'), u(9, 'fan')], [u(1, 'a')]);
  assert.deepEqual(r.fans.map((x) => x.id), ['9']);
  assert.equal(r.nonFollowers.length, 0);
});

test('computeByUsernames is case-insensitive and de-duplicates', () => {
  const r = S.computeByUsernames(['Alice', 'bob', 'bob'], ['alice', 'BOB', 'Carol', 'carol']);
  assert.deepEqual(r.nonFollowers.map((x) => x.u), ['Carol']);
  assert.equal(r.mutualCount, 2);
});

const followersFile = (names) =>
  JSON.stringify(
    names.map((n) => ({ title: '', media_list_data: [], string_list_data: [{ href: `https://www.instagram.com/${n}`, value: n, timestamp: 1 }] }))
  );
const followingFile = (names) =>
  JSON.stringify({
    relationships_following: names.map((n) => ({ title: '', string_list_data: [{ href: `https://www.instagram.com/${n}`, value: n, timestamp: 1 }] })),
  });

test('parseExportFiles reads several followers files plus following.json', () => {
  const r = S.parseExportFiles([
    { name: 'followers_1.json', text: followersFile(['a', 'b']) },
    { name: 'followers_2.json', text: followersFile(['c']) },
    { name: 'following.json', text: followingFile(['a', 'c', 'zed']) },
  ]);
  assert.deepEqual(r.followers, ['a', 'b', 'c']);
  assert.deepEqual(r.following, ['a', 'c', 'zed']);
  assert.deepEqual(r.fileCounts, { followers: 2, following: 1 });
  const cmp = S.computeByUsernames(r.followers, r.following);
  assert.deepEqual(cmp.nonFollowers.map((x) => x.u), ['zed']);
});

test('parseExportFiles falls back to title / href when value is missing (newer export layout)', () => {
  const following = JSON.stringify({
    relationships_following: [
      { title: 'from_title', string_list_data: [{ href: 'https://www.instagram.com/from_title', timestamp: 1 }] },
      { title: '', string_list_data: [{ href: 'https://www.instagram.com/_u/from_href', timestamp: 1 }] },
    ],
  });
  const r = S.parseExportFiles([
    { name: 'followers_1.json', text: followersFile(['x']) },
    { name: 'following.json', text: following },
  ]);
  assert.deepEqual(r.following, ['from_title', 'from_href']);
});

test('parseExportFiles gives clear errors instead of failing silently', () => {
  assert.throws(() => S.parseExportFiles([{ name: 'followers_1.json', text: '{nope' }]), /not valid JSON/);
  assert.throws(() => S.parseExportFiles([{ name: 'following.json', text: JSON.stringify({ something_else: [] }) }]), /unrecognised structure/);
  assert.throws(() => S.parseExportFiles([{ name: 'followers_1.json', text: followersFile(['a']) }]), /No following file/);
  assert.throws(() => S.parseExportFiles([{ name: 'following.json', text: followingFile(['a']) }]), /No followers file/);
  assert.throws(() => S.parseExportFiles([{ name: 'followers_1.json', text: JSON.stringify([{ string_list_data: [] }]) }]), /has no username/);
});

test('parseExportFiles skips unrelated files', () => {
  const r = S.parseExportFiles([
    { name: 'followers_1.json', text: followersFile(['a']) },
    { name: 'following.json', text: followingFile(['a']) },
    { name: 'profile.json', text: JSON.stringify({ hello: 1 }) },
  ]);
  assert.deepEqual(r.skipped, ['profile.json']);
});

test('completeness flags a list that is short by more than ~2%', () => {
  assert.equal(S.completeness(1000, 985).ok, true);
  assert.equal(S.completeness(1000, 940).ok, false);
  assert.equal(S.completeness(1000, 940).short, 60);
  assert.equal(S.completeness(1000, 1010).ok, true);
  assert.equal(S.completeness(null, 5).unknown, true);
});

test('ETA: calculating first, then average cycle time x remaining batches', () => {
  assert.equal(S.etaText(S.computeEta([4000, 4000], 10)), 'Calculating...');
  const eta = S.computeEta([6000, 6000, 6000], 100);
  assert.equal(eta.ms, 600000);
  assert.equal(S.etaText(eta), 'About 10 minutes left');
  assert.equal(S.etaText({ ms: 30000 }), 'Less than a minute left');
  assert.equal(S.etaText({ ms: 135 * 60000 }), 'About 2 hours 15 minutes left');
});

test('formatDuration', () => {
  assert.equal(S.formatDuration(45000), '45 s');
  assert.equal(S.formatDuration(34 * 60000), '34 min');
  assert.equal(S.formatDuration((2 * 60 + 5) * 60000), '2 h 5 min');
});
