# Task: Build a Chrome Extension, "Instagram Non-Followers"

Build this inside the current folder. Create the full working extension (Manifest V3), not just a plan. Before coding, briefly confirm your plan and file structure, then build it.

---

## 1. Single purpose

Show me the list of accounts I follow that do not follow me back. Nothing else.

- Speed is irrelevant. A scan taking 30 minutes, several hours, or spread across several days is fine.
- Reliability, resumability, and completeness of the final list matter most.
- Failures must be shown openly so I can see exactly what went wrong and fix it.

---

## 2. Background: a previous attempt failed

An earlier attempt at this tool failed partway because Instagram's servers stopped responding properly. The exact cause was never identified. Treat every item in Section 11 ("Known failure modes") as a real risk. Design the code so each one is **prevented, detected, or shown openly in the UI**.

---

## 3. Core requirements

### Scale
- Must work with 1,000+ followers and 1,000+ following (assume up to 10,000 each).

### Scan flow
1. Run the pre-flight check (Section 6).
2. Fetch the complete **Followers** list.
3. Fetch the complete **Following** list.
4. Compute people in Following who are NOT in Followers, matched by **numeric user ID** (not username, since usernames can change).
5. Run the completeness verification (Section 11, item 9).
6. Show the results (Section 9).

### Technology
- Chrome extension, Manifest V3, JavaScript or TypeScript.
- Chrome Side Panel API, `chrome.storage.local`, `chrome.alarms`, `chrome.notifications`, `chrome.power`.
- UI in vanilla JS or a light framework. No external servers.

---

## 4. Architecture (scan must survive the panel closing)

- **The scan loop runs inside the content script on the instagram.com tab.** This covers batches, delays, retries, backoff, and cooldowns. It must not depend on the side panel being open. Every request is made from the content script, same-origin, with `credentials: "include"`, so my existing logged-in session is used.
- The content script saves **all state** to `chrome.storage.local` after every batch (see Section 7 for the state contents).
- **The side panel is a display and control surface only.** It reads state from `chrome.storage.local`, listens to `chrome.storage.onChanged` for live updates, and sends Start / Pause / Resume / Cancel commands to the content script. Opening, closing, or replacing the panel must never affect a running scan. Reopening it must immediately show current progress, errors, and results.
- **Service worker (minimal):** opens the side panel, relays messages if needed, manages the icon badge and notifications, and runs a watchdog (below). No long-running work lives in the service worker, because Chrome shuts it down when idle.
- **Watchdog:** during a scan, a `chrome.alarms` alarm fires every 1 minute and checks a `lastHeartbeat` timestamp in storage (the content script updates it after every batch and every countdown tick). If the heartbeat is stale for more than 5 minutes while the scan status is "running", log a `SCAN_STALLED` error entry and set a badge on the extension icon.
- **Single active scan:** enforce one scan at a time with a lock stored in `chrome.storage.local`. If a second Instagram tab is open, detect it, show a message, and do not start a second scan (two simultaneous scans cause rate limiting).

---

## 5. Side panel persistence (must not fade away)

- Use `chrome.sidePanel` with a **global** configuration, not a per-tab one:
  - `chrome.sidePanel.setOptions({ path: "sidepanel.html", enabled: true })` with **no** `tabId`.
  - `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`.
- Clicking elsewhere on the page, switching tabs, or opening another extension's popup must not close the panel. It closes only when I close it.
- Chrome shows only one side panel at a time, so another extension's side panel may replace ours. That never affects the scan, since the scan lives in the content script. Add an **"Open in separate window"** button that opens the same UI in a standalone popup window (`chrome.windows.create` with `type: "popup"` and `sidepanel.html`), which stays visible independently.
- The panel appears on the **right side** of the browser window (Chrome's default side panel position; do not assume it can be changed).
- Clean, good-looking design. Light and dark mode. Readable at a narrow width.

---

## 6. Pre-flight check

Run before every scan, and also expose it as a **"Test connection"** button. Check in order and show a pass/fail line for each:

1. An instagram.com tab is open (if not, show a button to open one).
2. The content script is loaded in that tab (if the tab was open before the extension was installed or reloaded, say: "Refresh the Instagram tab").
3. I'm logged in (`ds_user_id` and `csrftoken` cookies exist). Show the logged-in username at the top of the panel.
4. No other scan is active (lock check), and only one Instagram tab is running the content script scan.
5. One small test request (count=1) succeeds and returns the expected JSON shape.
6. Read my profile's total follower and following counts (needed for completeness verification).

If any step fails, stop and show exactly which step and why. Do not start the scan.

---

## 7. Resume, persistence, and pause-on-error (very important)

### Resumable by design
- The scan has two phases: Followers and Following. Save the following to `chrome.storage.local` after **every batch**:
  - the Instagram user ID and username being scanned
  - the current phase and per-phase status (not started / in progress / complete)
  - the cursor (`next_max_id`) for the current phase
  - all user IDs and display info collected so far (id, username, full name, profile picture URL only)
  - per-phase "last updated" timestamps
  - the error log
  - total active scanning time across sessions
  - the `lastHeartbeat` timestamp and current status text
- If the scan stops for **any** reason (error, pause, closed tab, closed browser, computer shut down), the next Start continues from the exact saved cursor. If Followers is already complete, only Following is fetched.
- This must work **across days**. I can scan for 20 minutes today and continue tomorrow without losing anything.
- On Start with saved progress, ask **Resume** or **Start fresh**, and show what exists, for example: "Followers complete (1,204). Following 40% (480 of 1,190). Saved 1 day ago."
- Saved progress belongs to one Instagram account. If a different account is logged in, do not resume. Warn me and offer to start fresh for that account.
- "Clear stored data" must ask for confirmation, since it deletes saved progress.

### Cursor expiry (likely when resuming the next day)
- Instagram cursors may expire. If resuming with the saved cursor returns an error or unexpected response, **do not discard collected data**. Restart that phase from the beginning but keep the already collected IDs, and deduplicate by user ID, so the result stays complete.
- Show this message: "Saved position expired, rescanning this list. Previously collected accounts are kept."

### Stale data warning
- If saved progress is older than 3 days, warn that people may have followed or unfollowed since, recommend starting fresh, and let me choose.
- Each phase stores its own timestamp. If the Followers and Following lists were collected more than 24 hours apart, show a note on the results screen that small inaccuracies are possible.

### Pause on error (never retry forever)
- **Temporary errors** (429 rate limit, network failure, timeout): auto-retry up to **5 times** with exponential backoff and jitter (honor the `Retry-After` header if present, otherwise start at 60 s and double up to a 15-minute cap). If still failing, automatically **pause** the scan.
- **Serious errors** (`SOFT_FAIL`, `ACTION_BLOCKED`, `SESSION_EXPIRED`, `CHALLENGE_REQUIRED`, `UNEXPECTED_RESPONSE_FORMAT`, `PAGINATION_ERROR`): pause **immediately** with no retries.
- When paused: status becomes "Paused on error", progress is saved, the error appears in the error panel, and a **Resume** button continues from the saved cursor. A manual Pause button behaves the same way.
- Never discard or skip a failed batch. Resume always retries the same batch.

### Results appear only when complete
- While scanning, show progress only: percentages, counts, ETA, status. Do **not** show a partial non-followers list.
- The results list appears only after both phases are complete and the completeness check has run.
- Final results are saved, so reopening the panel later shows them immediately without scanning again.

---

## 8. Progress display, ETA, and timing

- Overall progress bar with percentage, plus per-phase percentage with counts, for example "Followers: 62% (620 / 1,000)".
- **ETA text**, for example "About 18 minutes left". Base it on the average time per batch over recent batches, the number of remaining accounts, and the expected longer pauses. Show "Calculating..." for the first few batches. Round to sensible units (minutes, or hours and minutes for long scans). Update it as the scan runs.
- When paused or rate limited, show "Paused" or "Waiting, resuming in 45s" instead of a misleading ETA.
- Show elapsed time for this session and **total scanning time across sessions** (for example "Total scanning time so far: 34 min").
- Live status text, for example "Fetching following, batch 14".
- When `document.hidden` is true, show "Tab in background, scan continues slowly".

### Request pacing
- Batches of about 50 accounts.
- Randomized delay of 2 to 5 seconds between batches (never a fixed interval).
- A longer random pause (20 to 60 seconds) every 5 to 8 batches.

### Timer rules (hidden-tab tolerance)
- Hidden tabs have their timers throttled. This only slows the scan, which is acceptable. Never assume delays are exact and never treat a late timer as an error.
- Base all timing and countdowns on timestamps (`Date.now()`), not counted ticks.
- Use the Web Locks API or a harmless periodic keep-alive so Chrome is less likely to freeze the tab.
- Request the `power` permission and call `chrome.power.requestKeepAwake("system")` during a scan. Release it when the scan ends, pauses, or is cancelled.

---

## 9. Results view

- Appears only after a complete scan (or after an import, Section 12). Stays on screen until I close it.
- Count at the top, for example "143 people don't follow you back".
- Scrollable list with profile picture, username, display name, and a link that opens the profile in a new tab.
- Profile pictures: use `referrerpolicy="no-referrer"` and a placeholder avatar on load error, because Instagram image URLs expire.
- Virtualize or paginate the list so 10,000 rows stay smooth.
- Search box and alphabetical sort.
- **Ignore list:** let me hide accounts permanently (brands, celebrities). Show a count of hidden accounts and a way to unhide.
- **Export:** CSV with a UTF-8 BOM (so Excel shows non-English names correctly), plus a "Copy usernames" button.
- Optional extra tab **"Fans"** (people who follow me but I don't follow back), computed from the same data.
- If the completeness check found a problem, show a prominent `INCOMPLETE_DATA` banner with exact numbers (for example "Followers: collected 940 of 1,000, results may be incomplete") and an option to re-scan the affected phase. Never show a partial list as if it were complete.
- Results survive closing and reopening the panel.

---

## 10. Error panel (errors must be visible)

A dedicated error panel openly shows every failure. Each entry contains:

- timestamp
- phase (Followers / Following / Compare / Import / Pre-flight)
- batch number
- error code (from Section 11)
- HTTP status
- message
- request URL (never include tokens or cookies)
- raw response snippet (first ~500 characters)
- retry count
- a **Retry** button

Also required:
- Errors that auto-retry are logged too, marked "auto-retrying", so I can see how often they happen.
- A **"Copy error log"** button that copies everything as plain text.
- A **debug log view**, plus console logging of every request URL and status.
- A **"Save raw first response"** debug button so I can copy the real API response back to Claude Code if the format has changed.

---

## 11. Known failure modes and how to avoid them

For each: what happens, why, how to prevent it, and how it appears in the error panel.

### 1. Requests sent from the wrong origin
- **What happens:** Requests return 401/403, an empty body, or an HTML login page instead of JSON.
- **Why:** Requests from a service worker, the side panel page, or another site don't carry the right origin and session context.
- **Prevent:** Perform every Instagram request inside the content script on instagram.com with `credentials: "include"`.
- **Show as:** `WRONG_ORIGIN_OR_HTML_RESPONSE` when the response is not JSON.

### 2. Missing or wrong request headers
- **What happens:** 400/403 responses even though I'm logged in.
- **Why:** These endpoints expect headers the real site sends.
- **Prevent:** Send `X-CSRFToken` (from the `csrftoken` cookie), `X-IG-App-ID` (the web app ID; **verify against what instagram.com currently sends in the browser's network tab**, since it can change), and `X-Requested-With: XMLHttpRequest`. Take the user ID from the `ds_user_id` cookie. Keep all header construction in the API module with comments.
- **Show as:** `MISSING_HEADER_OR_TOKEN`, listing which values were empty (never print token values).

### 3. Rate limiting (HTTP 429)
- **What happens:** The scan works for a while, then every request fails. This is the most likely cause of mid-scan failure at 1,000+ accounts.
- **Why:** Requests were too fast or too regular.
- **Prevent:** The pacing rules in Section 8. On 429, follow the retry-then-pause rules in Section 7. Show a live countdown.
- **Show as:** `RATE_LIMITED_429`, with retry count and next retry time.

### 4. "Soft" failures hidden inside HTTP 200 or 400 responses
- **What happens:** The response looks successful but has no user data, so the list quietly comes out short.
- **Why:** Instagram often returns JSON like `{"status":"fail","message":"..."}`, or `feedback_required`, `checkpoint_required`, `login_required`, "Please wait a few minutes before you try again".
- **Prevent:** Validate every response before using it. Require `status: "ok"` and a `users` array. Anything else is an error, and the `message` field must be displayed.
- **Show as:** `SOFT_FAIL: <message from Instagram>`.

### 5. Action block or temporary restriction
- **What happens:** Instagram starts rejecting everything with "Try again later" style messages.
- **Why:** The account was flagged for automated-looking activity.
- **Prevent:** Conservative pacing. If a block message appears, stop immediately (no retries), save progress, show a clear banner explaining the situation, and recommend waiting at least 30 minutes (ideally longer) before pressing Resume.
- **Show as:** `ACTION_BLOCKED`.

### 6. Session expired or login/challenge redirect
- **What happens:** 401/403, or a redirect to `/accounts/login` or `/challenge`.
- **Why:** Logged out, session timed out, or Instagram requires verification.
- **Prevent:** Detect these, pause automatically (never discard progress), tell me to log in or complete verification in the Instagram tab, and offer a Resume button.
- **Show as:** `SESSION_EXPIRED` or `CHALLENGE_REQUIRED`.

### 7. Endpoint or response format changed
- **What happens:** Fields missing, different JSON structure, or 404s. This can break a working tool with no change on my side.
- **Why:** These are unofficial internal endpoints that Instagram changes without notice.
- **Prevent:** Keep ALL endpoint URLs, query parameters, headers, and response parsing in **one separate, clearly commented module** (`instagram-api.js`). Use these as starting points but verify against the network tab of instagram.com:
  - `/api/v1/friendships/{user_id}/followers/?count=50&max_id={cursor}`
  - `/api/v1/friendships/{user_id}/following/?count=50&max_id={cursor}`
  Validate the shape of every response against an expected schema.
- **Show as:** `UNEXPECTED_RESPONSE_FORMAT`, with the raw snippet, so I can paste it back for a fix.

### 8. Pagination bugs
- **What happens:** Missing accounts, duplicates, or an infinite loop.
- **Why:** Cursor (`next_max_id`) not followed correctly, last page missed, or a retry fetched the same page twice.
- **Prevent:** Loop until `next_max_id` is absent. Store the cursor after every batch. Deduplicate by user ID using a Set. Stop if the same cursor repeats.
- **Show as:** `PAGINATION_ERROR`.

### 9. Silent partial results (completeness verification)
- **What happens:** The tool shows a list that looks fine but is missing people, so the "not following back" list is wrong.
- **Prevent:** Before showing results, compare collected counts to the follower and following totals read from my profile in the pre-flight step. If a list is short by more than a small tolerance (for example 2%), show the `INCOMPLETE_DATA` banner with exact numbers and offer to re-scan that phase.
- **Show as:** `INCOMPLETE_DATA`.

### 10. Extension lifecycle problems (Manifest V3)
- **What happens:** The scan stops silently after a few minutes or when I navigate.
- **Why:** Service workers are shut down when idle, hidden tabs are throttled, and reloading or closing the Instagram tab destroys the content script.
- **Prevent:** Scan loop in the content script (Section 4), state saved every batch, heartbeat watchdog, keep-awake, and timestamp-based timing (Section 8). Hidden tabs only slow the scan. If the Instagram tab is reloaded, closed, or discarded, the scan stops but saved progress remains, and the next Start or Resume continues from the saved cursor.
- **README must tell me:** keep the Instagram tab open (pinning it helps), turn off Chrome's Memory Saver for instagram.com so the tab isn't discarded, and optionally drag the Instagram tab into its own separate window and leave it in the background.
- **Show as:** `CONTENT_SCRIPT_DISCONNECTED` or `SCAN_STALLED`.

### 11. Network failures
- **What happens:** The scan dies on Wi-Fi drops or timeouts.
- **Prevent:** Catch fetch exceptions, apply a 30-second timeout per request, and retry with backoff (Section 7). If offline, wait for the `online` event, then resume.
- **Show as:** `NETWORK_ERROR`.

### 12. Wrong matching of people
- **What happens:** Someone who changed their username appears as a non-follower.
- **Prevent:** Compare by numeric user ID (`pk`) in live-scan mode. Store username, full name, and profile picture URL for display only.

---

## 12. Fallback: import from Instagram data export

A secondary feature that never depends on Instagram's servers and cannot be rate limited.

- An **"Import from Instagram data export"** option. I upload the followers and following JSON files from Instagram's "Download your information", and the extension computes the same list locally with **no network calls**.
- Support multiple follower files (`followers_1.json`, `followers_2.json`, ...), since large accounts are split across files.
- Handle both layouts: followers files are a top-level array, while `following.json` wraps entries under a `relationships_following` key. Usernames are in `string_list_data[0].value`. If the structure doesn't match, show a clear parse error instead of failing silently.
- Matching here is by **username** (the export has no numeric IDs). Mention that limitation in the UI.
- The results screen works the same as in Section 9.

---

## 13. Additional robustness and UX

- Storage: request the `unlimitedStorage` permission, since `chrome.storage.local` is capped at about 10 MB. Store only id, username, full name, and picture URL per account.
- Desktop notification (`chrome.notifications`) and an icon badge when the scan finishes, pauses on error, or stalls.
- Show the logged-in Instagram username at the top of the panel before and during a scan, so I never scan the wrong account.
- First-run notice: automated scanning of Instagram carries some account risk, so delays are kept generous.

---

## 14. Privacy

- Fully local. No external servers, analytics, or tracking.
- Never ask for or store my Instagram password. Only the existing logged-in browser session is used.
- Stored data stays in the browser.
- A **"Clear stored data"** button (with confirmation).

---

## 15. Testing

- Include **unit tests** for the compare logic and the data-export parser, using sample JSON.
- Include a **mock mode** with fake API responses, covering: normal paging, 429 rate limits, soft failures (`status: "fail"`), expired cursors, session expiry, and malformed responses. This lets error handling, pause/resume, and ETA be tested without Instagram.
- Note: you cannot log into my Instagram account, so real-world endpoint details may need one round of fixing after my first real run. I will use the error panel and the "Save raw first response" button to paste the real data back to you.

---

## 16. Deliverables

- Complete extension files:
  - `manifest.json` (with permissions: `storage`, `unlimitedStorage`, `sidePanel`, `alarms`, `notifications`, `power`, `tabs`, and host permission for `https://www.instagram.com/*`)
  - content script (scan engine)
  - `instagram-api.js` (all endpoint, header, and response-parsing code, heavily commented)
  - side panel HTML / JS / CSS
  - minimal background service worker (opens panel, badge, notifications, watchdog)
  - tests and mock mode
- A **README** with:
  - install steps (load unpacked in `chrome://extensions` with Developer mode on)
  - how to use it (Test connection, Start, Pause, Resume, results, export, import)
  - tips: keep the Instagram tab open and pinned, disable Memory Saver for instagram.com, optionally use a separate window
  - a troubleshooting section that mirrors the failure modes in Section 11
- Suggested build order: API module and mock mode, scan engine with state saving, side panel UI, pre-flight, error panel, resume logic, results view, import fallback, tests.

---

## 17. Out of scope

- Auto-unfollowing.
- Tracking follower history over time.
- Publishing to the Chrome Web Store.

---

## 18. Acceptance checklist

The build is done when all of these are true:

- [ ] "Test connection" shows a pass/fail line for each pre-flight step.
- [ ] A scan runs with the side panel closed, and reopening it shows live progress.
- [ ] Switching tabs or opening another extension does not stop the scan.
- [ ] Progress is saved after every batch, and Start offers Resume or Start fresh with the age of saved data.
- [ ] Resuming on a later day continues from the saved cursor, and an expired cursor keeps already collected accounts.
- [ ] Temporary errors retry up to 5 times, then pause. Serious errors pause immediately. Resume retries the same batch.
- [ ] Every error appears in the error panel with code, HTTP status, and raw snippet, and "Copy error log" works.
- [ ] ETA text, per-phase percentages, elapsed time, and total scan time display correctly.
- [ ] No partial list is shown during the scan. Results appear after completion and persist.
- [ ] Completeness check works and shows the `INCOMPLETE_DATA` banner when counts don't match.
- [ ] Search, sort, ignore list, CSV (UTF-8 BOM), and "Copy usernames" work.
- [ ] Import from the Instagram data export works with multiple follower files.
- [ ] Mock mode and unit tests pass.
- [ ] All Instagram API code is in `instagram-api.js`.
