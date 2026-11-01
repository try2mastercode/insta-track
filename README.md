# Insta-Track

**Insta-Track** is a Chrome extension that answers one question: **which accounts do I follow that don't follow me back?**

- Works with large accounts (10,000+ followers / following).
- **Resumable**: stop any time, even for days, and continue from the exact saved position.
- **Honest**: every failure is shown in an error panel with the code, HTTP status and raw response. Nothing fails silently.
- **Private**: runs entirely in your browser. No servers, no analytics, no passwords.
- Manifest V3, plain JavaScript, no build step.

> **Risk notice:** automated scanning of Instagram carries some account risk. The extension keeps its delays deliberately generous (a big account can take hours). That is intended. Don't try to speed it up.

---

## Contents

1. [Install](#1-install)
2. [Quick start](#2-quick-start)
3. [Using the side panel](#3-using-the-side-panel)
4. [Tips for reliable scans](#4-tips-for-reliable-scans)
5. [How it works](#5-how-it-works)
6. [Troubleshooting](#6-troubleshooting)
7. [Importing an Instagram data export](#7-importing-an-instagram-data-export-fallback)
8. [Testing](#8-testing)
9. [Project files](#9-project-files)
10. [Privacy](#10-privacy)

---

## 1. Install

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this project folder.
4. Open <https://www.instagram.com> and log in. **If the tab was already open, refresh it** so the extension loads into it.
5. Click the Insta-Track toolbar icon. The side panel opens on the right.

After changing any code, click the reload icon on the extension in `chrome://extensions` and refresh the Instagram tab.

## 2. Quick start

1. Make sure you are logged in at instagram.com in **one** tab, and keep that tab open.
2. Open the side panel and press **Start scan**. (It runs the connection check by itself.)
3. Leave it running. You can close the panel, switch tabs, or pause and resume whenever you like.
4. When the scan finishes you get a desktop notification. Open the **Results** tab.

## 3. Using the side panel

### Scan tab

| Control | What it does |
|---|---|
| **Test connection** | Runs the pre-flight check and shows a pass/fail line for each step: Instagram tab open, extension active in it, logged in, no other scan or tab running, a small test request returns the expected data, profile totals read. If a step fails, it tells you which one and why, and nothing starts. |
| **Start scan** | Pre-flight, then **Followers**, then **Following**, then compare by numeric user ID, then a completeness check, then results. |
| **Pause** / **Cancel** | Both keep all progress. |
| **Resume** | Continues from the saved position and retries the same batch. Never skips anything. |
| **Start fresh** | Discards saved progress and begins again. |
| **Clear stored data** | Asks for confirmation, then deletes saved progress, lists, results and logs. Your hidden-accounts list is kept. |
| **Open in separate window** (top-right icon) | Opens the same panel as a standalone popup that stays visible independently of Chrome's single side-panel slot. |

While scanning you see overall and per-phase progress, an ETA, elapsed time for this session, total scanning time across sessions, and live status text. The list of non-followers is deliberately **not** shown until both lists are complete and verified, so you never mistake a partial list for the real one.

When saved progress exists, **Start** asks whether to **Resume** or **Start fresh** and shows what is saved, for example: *"Followers complete (1,204). Following 40% (480 of 1,190). Saved 1 day ago."* Progress older than 3 days triggers a warning, and progress is never resumed for a different Instagram account.

### Results tab

- Count at the top, e.g. *"143 people don't follow you back"*.
- Search, A-Z / Z-A sort, profile picture, username, display name, and a link that opens the profile.
- **Hide**: permanently ignore accounts (brands, celebrities). The **Hidden (n)** button lists them and lets you unhide.
- **Export CSV** (UTF-8 with BOM, so Excel shows non-English names correctly) and **Copy usernames**.
- **Fans** sub-tab: people who follow you that you don't follow back.
- If the completeness check finds a problem, a prominent **INCOMPLETE_DATA** banner shows the exact numbers (e.g. *"Followers: collected 940 of 1,000"*) with a **Re-scan** button for the affected list.
- Results are saved, so reopening the panel shows them instantly.

### Errors tab

Every failure is logged with: timestamp, phase, batch, error code, HTTP status, message, request URL, the first ~500 characters of the raw response, retry count, and a **Retry** button. Errors that were retried automatically are logged too (marked *auto-retrying*). **Copy error log** copies everything as plain text.

### Debug tab

Request log, plus **Save raw first response**: copies a real API response to your clipboard so you can paste it to Claude Code if Instagram changes its format.

### Import tab

Compute the same list from Instagram's "Download your information" files, with no network requests. See [section 7](#7-importing-an-instagram-data-export-fallback).

## 4. Tips for reliable scans

- **Keep the Instagram tab open.** Pinning it helps.
- **Turn off Chrome's Memory Saver for instagram.com**: `chrome://settings/performance` > *Always keep these sites active* > add `instagram.com`. Otherwise Chrome may discard the tab and stop the scan (progress is still saved).
- Optionally **drag the Instagram tab into its own window** and leave it in the background. Background tabs are throttled, which only slows the scan; the panel shows *"Tab in background, scan continues slowly"*.
- Only **one** Instagram tab should have the extension active. A second tab blocks the scan, because two simultaneous scans cause rate limiting.
- Don't press **Test connection** repeatedly. Every press sends real requests to Instagram.
- If you reload or close the Instagram tab, the scan stops but progress is saved. Open Instagram again and press **Resume**.

## 5. How it works

**Architecture.** The scan loop runs inside a **content script on the instagram.com tab**, using your existing logged-in session (same-origin requests, `credentials: "include"`). It saves all state to `chrome.storage.local` after every batch. The side panel is only a display and control surface: opening, closing or replacing it never affects a running scan. The service worker is minimal (opens the panel, badge, notifications, keep-awake, watchdog).

**Pacing.** Batches of about 100 accounts, a random 2-5 s delay between batches, and a longer random 20-60 s pause every 5-8 batches. All timing is timestamp-based, so a throttled background tab only slows the scan and never causes an error.

**Error handling.**

- *Temporary* errors (429, network failure, timeout): up to 5 automatic retries with exponential backoff and jitter (honours `Retry-After`; otherwise 60 s doubling up to a 15-minute cap), then the scan **pauses**.
- *Serious* errors (`SOFT_FAIL`, `ACTION_BLOCKED`, `SESSION_EXPIRED`, `CHALLENGE_REQUIRED`, `UNEXPECTED_RESPONSE_FORMAT`, `PAGINATION_ERROR`, plus `WRONG_ORIGIN_OR_HTML_RESPONSE` and `MISSING_HEADER_OR_TOKEN`): pause immediately, no retries.
- A failed batch is never skipped. **Resume** retries it.

**Resume across days.** If a saved cursor has expired (typical the next day), that list restarts from the beginning, already-collected accounts are kept, and the data is de-duplicated by user ID.

**Matching.** Live scans compare by **numeric user ID**, so someone who renamed their account is never listed as a non-follower.

**Watchdog.** During a scan an alarm fires every minute. If the scan's heartbeat is stale for more than 5 minutes it logs `SCAN_STALLED`, sets a badge on the icon and shows a notification. The extension also keeps the computer awake while scanning (`chrome.power`).

**Completeness check.** At the end, collected counts are compared with the follower / following totals from your profile. If a list is short by more than about 2%, you get the `INCOMPLETE_DATA` banner.

## 6. Troubleshooting

| You see | Meaning | What to do |
|---|---|---|
| Yellow **!** on *Profile totals read* | Instagram rate-limited the call that reads your follower/following totals (it is limited more strictly than the list calls). It is retried twice, then skipped. | The scan still runs. Side effects: username may show as `@user <id>`, ETA stays "Calculating...", percentages stay at 0%, and completeness is marked "not verified". Totals are re-read when the scan finishes. |
| `RATE_LIMITED_429` | Too many requests. | Auto-retried 5 times with backoff, then paused. Wait 30+ minutes, then **Resume**. |
| `ACTION_BLOCKED` | Instagram's "Try again later" style restriction. | Stop. Wait at least 30 minutes (ideally longer) before **Resume**. |
| `SOFT_FAIL` | Instagram answered with `status: "fail"` or similar. Its exact message is shown. | Read the message in the Errors tab, wait, **Resume**. |
| `SESSION_EXPIRED` / `CHALLENGE_REQUIRED` | Logged out, or Instagram wants verification. | Log in or complete the verification in the Instagram tab, then **Resume**. Progress is kept. |
| `WRONG_ORIGIN_OR_HTML_RESPONSE` | Got a web page or empty body instead of JSON. | Make sure you are logged in, refresh the Instagram tab, **Resume**. If it persists, copy the error log. |
| `MISSING_HEADER_OR_TOKEN` | A required cookie or header was empty (the message names which; values are never shown). | Log in and refresh the tab. If it is `X-IG-App-ID`, compare with the `x-ig-app-id` header in DevTools > Network and update `CONFIG.APP_ID` in `instagram-api.js`. |
| `UNEXPECTED_RESPONSE_FORMAT` | Instagram changed an endpoint or its JSON. | Debug tab > **Save raw first response**, paste it to Claude Code. |
| `PAGINATION_ERROR` | A cursor repeated, or repeated empty pages. | **Start fresh**. If it repeats, copy the error log. |
| `INCOMPLETE_DATA` | Fewer accounts collected than your profile totals. | Press **Re-scan** on the banner. |
| `CONTENT_SCRIPT_DISCONNECTED` / `SCAN_STALLED` | The Instagram tab was closed, reloaded, discarded or frozen. | Open Instagram (refresh it) and **Resume**. See the Memory Saver tip. |
| `NETWORK_ERROR` | Offline, timeout (30 s per request) or server error. | Auto-retried. If offline, the scan waits for the connection to return. |
| "Refresh the Instagram tab" | The tab was open before the extension was installed or reloaded. | Refresh the tab. |

If anything breaks after an Instagram change, all Instagram-specific code (endpoints, headers, response parsing) is in **`instagram-api.js`**.

## 7. Importing an Instagram data export (fallback)

This never touches Instagram's servers, so it cannot be rate limited.

1. In Instagram: **Accounts Center > Your information and permissions > Download your information**.
2. Choose **Followers and following**, format **JSON**, and download.
3. In the panel's **Import** tab, select `followers_1.json` (plus `followers_2.json`, ... if present) and `following.json`.
4. Press **Compute list**. Results appear in the Results tab like a normal scan.

Note: the export has no numeric IDs, so matching is by **username**. Someone who renamed their account since the export may be listed wrongly. Parse problems produce a clear error instead of failing silently.

## 8. Testing

```bash
npm test
```

Requires Node 18+. The suite (43 tests) covers the compare logic, data-export parser, CSV, API response classification, and the full scan engine against a mock Instagram: paging, 429 retries and auto-pause, soft failures, expired cursors, session expiry, malformed responses, resume, account mismatch, the single-scan lock, ETA, and the completeness check.

**Mock mode (inside the extension).** In the Scan tab, open *Developer: mock mode*, tick **Use mock Instagram**, pick a scenario (`ratelimit`, `ratelimit_hard`, `network`, `softfail`, `blocked`, `session`, `challenge`, `malformed`, `html`, `expiredcursor`, `incomplete`, `profile429`) and start a scan. It still needs an Instagram tab open. Mock data is a fake account, so **turn mock mode off before a real scan**.

**Browser harness (no install needed).** `node tools/serve.js`, then open <http://localhost:8765/harness>. It runs the real panel and content script in one page with a stubbed `chrome` API.

## 9. Project files

| File | Purpose |
|---|---|
| `manifest.json` | MV3 manifest. Permissions: `storage`, `unlimitedStorage`, `sidePanel`, `alarms`, `notifications`, `power`, `tabs`; host `https://www.instagram.com/*` |
| `instagram-api.js` | **All** endpoint URLs, headers, response classification and schema validation |
| `scan-engine.js` | The resumable scan loop: pacing, retries, pause-on-error, cursor expiry, completeness, results |
| `content.js` | Runs on instagram.com: connects the engine to storage, panel commands and keep-alive |
| `background.js` | Minimal service worker: side panel setup, badge, notifications, keep-awake, watchdog |
| `sidepanel.html` / `.css` / `.js` | The UI (light and dark mode, readable at narrow widths) |
| `shared.js` | Compare logic, export parser, CSV, ETA and formatting helpers |
| `mock-api.js` | Fake Instagram for mock mode and tests |
| `tests/` | Unit and engine tests, plus a dev-only `chrome` shim |
| `tools/` | Icon generator and the dev server for the harness |
| `instagram-non-followers-extension-spec.md` | The original specification |

## 10. Privacy

- Fully local. No external servers, analytics or tracking.
- Your Instagram password is never requested or stored; only your existing logged-in browser session is used.
- Stored data (account IDs, usernames, display names, picture URLs, scan state, logs) stays in `chrome.storage.local` until you press **Clear stored data**.
- Out of scope by design: auto-unfollowing, follower-history tracking, Chrome Web Store publishing.
