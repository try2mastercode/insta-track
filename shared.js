/**
 * shared.js
 * ============================================================================
 * Pure helpers used by the scan engine, the side panel and the unit tests:
 *   - compare logic (by numeric user ID for live scans, by username for imports)
 *   - Instagram "Download your information" export parser
 *   - CSV export (UTF-8 BOM), duration / ETA formatting, completeness check
 * No DOM, no chrome.* APIs, so it runs under Node for the tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IGShared = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Compare
  // ---------------------------------------------------------------------------

  /**
   * Live-scan compare, matched by numeric user ID (usernames can change).
   * Inputs: arrays of { id, u, n, p }.
   * nonFollowers = people I follow who don't follow me. fans = the reverse.
   */
  function computeByIds(followers, following) {
    const fset = new Set(followers.map((x) => String(x.id)));
    const gset = new Set(following.map((x) => String(x.id)));
    const nonFollowers = following.filter((x) => !fset.has(String(x.id)));
    const fans = followers.filter((x) => !gset.has(String(x.id)));
    return { nonFollowers, fans, mutualCount: following.length - nonFollowers.length };
  }

  /** Import compare, matched by lower-cased username (the export has no numeric IDs). */
  function computeByUsernames(followerNames, followingNames) {
    const toUser = (name) => ({ id: 'u:' + name.toLowerCase(), u: name, n: '', p: '' });
    const uniq = (names) => {
      const seen = new Set();
      const out = [];
      names.forEach((n) => {
        const k = n.toLowerCase();
        if (!seen.has(k)) {
          seen.add(k);
          out.push(toUser(n));
        }
      });
      return out;
    };
    return computeByIds(uniq(followerNames), uniq(followingNames));
  }

  // ---------------------------------------------------------------------------
  // Instagram data-export parser
  // ---------------------------------------------------------------------------

  class ParseError extends Error {
    constructor(message, file) {
      super(message);
      this.name = 'ParseError';
      this.file = file || null;
    }
  }

  function usernameFromEntry(entry, file, index) {
    if (!entry || typeof entry !== 'object') {
      throw new ParseError(`${file}: entry #${index + 1} is not an object`, file);
    }
    const sld = Array.isArray(entry.string_list_data) ? entry.string_list_data[0] : null;
    let name = sld && typeof sld.value === 'string' ? sld.value.trim() : '';
    // Newer exports put the username in "title" for the following list.
    if (!name && typeof entry.title === 'string') name = entry.title.trim();
    if (!name && sld && typeof sld.href === 'string') {
      const m = /instagram\.com\/(?:_u\/)?([^/?#]+)/i.exec(sld.href);
      if (m) name = m[1];
    }
    if (!name) {
      throw new ParseError(`${file}: entry #${index + 1} has no username (expected string_list_data[0].value)`, file);
    }
    return name;
  }

  /**
   * files: [{ name, text }]. Followers files are a top-level array;
   * following.json wraps entries under "relationships_following".
   * Also accepts pending_follow_requests.json (requests you sent).
   * Returns { followers:[names], following:[names], pending:[names], fileCounts, skipped }.
   * Throws ParseError with a clear message if the structure does not match.
   */
  function parseExportFiles(files) {
    const followers = [];
    const following = [];
    const pending = [];
    const skipped = [];
    let followerFiles = 0;
    let followingFiles = 0;
    for (const f of files) {
      const name = f.name || 'file';
      let data;
      try {
        data = JSON.parse(f.text);
      } catch (e) {
        throw new ParseError(`${name}: not valid JSON (${e.message})`, name);
      }
      let kind = null;
      let list = null;
      if (data && Array.isArray(data.relationships_follow_requests_sent)) {
        // pending_follow_requests.json: requests YOU sent that are still waiting for approval
        pending.push(...data.relationships_follow_requests_sent.map((entry, i) => usernameFromEntry(entry, name, i)));
        continue;
      } else if (Array.isArray(data)) {
        list = data;
        kind = /following/i.test(name) ? 'following' : 'followers';
      } else if (data && Array.isArray(data.relationships_following)) {
        list = data.relationships_following;
        kind = 'following';
      } else if (data && Array.isArray(data.relationships_followers)) {
        list = data.relationships_followers;
        kind = 'followers';
      } else if (!/follow/i.test(name)) {
        skipped.push(name); // unrelated file picked by mistake
        continue;
      } else {
        throw new ParseError(
          `${name}: unrecognised structure. Expected a top-level array (followers_N.json) or an object with a "relationships_following" array (following.json).`,
          name
        );
      }
      const names = list.map((entry, i) => usernameFromEntry(entry, name, i));
      if (kind === 'followers') {
        followerFiles += 1;
        followers.push(...names);
      } else {
        followingFiles += 1;
        following.push(...names);
      }
    }
    if (!followerFiles) throw new ParseError('No followers file found. Select followers_1.json (and followers_2.json ... if present).');
    if (!followingFiles) throw new ParseError('No following file found. Select following.json.');
    return { followers, following, pending, fileCounts: { followers: followerFiles, following: followingFiles }, skipped };
  }

  // ---------------------------------------------------------------------------

  function csvCell(v) {
    let s = v == null ? '' : String(v);
    // Neutralise spreadsheet formula injection from display names.
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /** rows: [{ id, u, n }]. Returns a string beginning with a UTF-8 BOM so Excel shows non-English names. */
  function toCsv(rows) {
    const lines = [['username', 'full_name', 'profile_url', 'user_id'].join(',')];
    rows.forEach((r) => {
      const numericId = /^\d+$/.test(String(r.id)) ? r.id : '';
      lines.push([csvCell(r.u), csvCell(r.n), csvCell(`https://www.instagram.com/${r.u}/`), csvCell(numericId)].join(','));
    });
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  // ---------------------------------------------------------------------------
  // Completeness, ETA, formatting
  // ---------------------------------------------------------------------------

  /** Compare what we collected with the total Instagram reports. Tolerance: 2% (at least 1). */
  function completeness(expected, collected, tolerancePct) {
    if (expected == null) return { ok: null, unknown: true, short: 0, tolerance: 0 };
    const tol = Math.max(1, Math.ceil(expected * (tolerancePct == null ? 0.02 : tolerancePct)));
    const short = Math.max(0, expected - collected);
    return { ok: short <= tol, unknown: false, short, tolerance: tol };
  }

  /** cycleTimes: ms per batch cycle (request + pacing delay). Needs a few samples first. */
  function computeEta(cycleTimes, remainingBatches, minSamples) {
    const min = minSamples == null ? 3 : minSamples;
    if (!cycleTimes || cycleTimes.length < min) return { calculating: true, ms: null };
    const avg = cycleTimes.reduce((a, b) => a + b, 0) / cycleTimes.length;
    return { calculating: false, ms: Math.max(0, Math.round(avg * remainingBatches)) };
  }

  function plural(n, word) {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
  }

  function etaText(eta) {
    if (!eta || eta.calculating || eta.ms == null) return 'Calculating...';
    const minutes = eta.ms / 60000;
    if (minutes < 1) return 'Less than a minute left';
    if (minutes < 20) return `About ${plural(Math.round(minutes), 'minute')} left`;
    if (minutes < 90) return `About ${plural(Math.round(minutes / 5) * 5, 'minute')} left`;
    const total = Math.round(minutes / 5) * 5;
    const h = Math.floor(total / 60);
    const m = total % 60;
    return `About ${plural(h, 'hour')}${m ? ' ' + plural(m, 'minute') : ''} left`;
  }

  /** 45 s / 12 min / 2 h 5 min */
  function formatDuration(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s} s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    return `${h} h ${m % 60} min`;
  }

  function timeAgo(ts, nowMs) {
    const d = Math.max(0, (nowMs == null ? Date.now() : nowMs) - ts);
    const min = Math.floor(d / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${plural(min, 'minute')} ago`;
    const h = Math.floor(min / 60);
    if (h < 48) return `${plural(h, 'hour')} ago`;
    return `${plural(Math.floor(h / 24), 'day')} ago`;
  }

  return {
    computeByIds,
    computeByUsernames,
    parseExportFiles,
    ParseError,
    completeness,
    computeEta,
    etaText,
    formatDuration,
    timeAgo,
  };
});
