/**
 * background.js: minimal MV3 service worker
 * ============================================================================
 * Chrome shuts this worker down when idle, so NO scan work lives here. It only:
 *   - configures the GLOBAL side panel (opens on toolbar-icon click, not per tab)
 *   - relays keep-awake requests (chrome.power is not available in content scripts)
 *   - shows the toolbar badge and desktop notifications
 *   - runs the watchdog: while a scan is "running", an alarm fires every minute and
 *     checks the scan's heartbeat; stale > 5 min -> SCAN_STALLED error + badge
 */
const WATCHDOG_ALARM = 'ig-watchdog';
const STALE_MS = 5 * 60 * 1000;

function setupSidePanel() {
  // Global config: no tabId, so the panel stays open when switching tabs or pages.
  chrome.sidePanel.setOptions({ path: 'sidepanel.html', enabled: true }).catch(() => {});
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

chrome.runtime.onInstalled.addListener(setupSidePanel);
chrome.runtime.onStartup.addListener(setupSidePanel);
setupSidePanel();

// ------------------------------------------------------------------ helpers
function badge(text, color) {
  chrome.action.setBadgeText({ text }).catch(() => {});
  if (color) chrome.action.setBadgeBackgroundColor({ color }).catch(() => {});
}

function notify(id, title, message) {
  chrome.notifications.create(id, { type: 'basic', iconUrl: 'icons/icon128.png', title, message }, () => void chrome.runtime.lastError);
}

async function ensureWatchdog() {
  const { scan } = await chrome.storage.local.get('scan');
  if (scan && scan.status === 'running') {
    const existing = await chrome.alarms.get(WATCHDOG_ALARM);
    if (!existing) chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 1 });
  } else {
    await chrome.alarms.clear(WATCHDOG_ALARM);
    chrome.power.releaseKeepAwake();
  }
}

async function appendError(entry) {
  const { errors } = await chrome.storage.local.get('errors');
  const list = errors || [];
  list.push(entry);
  await chrome.storage.local.set({ errors: list.slice(-1000) });
}

// ----------------------------------------------------------------- watchdog
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== WATCHDOG_ALARM) return;
  const { scan, watchdog } = await chrome.storage.local.get(['scan', 'watchdog']);
  if (!scan || scan.status !== 'running') {
    await ensureWatchdog();
    if (watchdog) await chrome.storage.local.remove('watchdog');
    return;
  }
  const age = Date.now() - (scan.lastHeartbeat || 0);
  if (age > STALE_MS) {
    if (!watchdog || !watchdog.stalled) {
      const mins = Math.round(age / 60000);
      await appendError({
        id: `e${Date.now()}-wd`,
        ts: Date.now(),
        phase: scan.phase === 'following' ? 'Following' : 'Followers',
        batch: scan.phase ? scan.phases[scan.phase].batches + 1 : null,
        code: 'SCAN_STALLED',
        status: null,
        message: `No heartbeat from the Instagram tab for ${mins} minutes while the scan is marked running. The tab may be closed, discarded by Memory Saver, frozen, or the page crashed. Open instagram.com and press Resume.`,
        url: '',
        snippet: '',
        retryCount: 0,
        autoRetrying: false,
        nextRetryAt: null,
        note: null,
      });
      await chrome.storage.local.set({ watchdog: { stalled: true, since: Date.now() } });
      badge('!', '#d93025');
      notify('ig-stalled', 'Instagram scan stalled', 'No heartbeat for 5+ minutes. Open the Instagram tab and press Resume.');
      chrome.power.releaseKeepAwake();
    }
  } else if (watchdog && watchdog.stalled) {
    await chrome.storage.local.remove('watchdog');
    badge('');
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.scan) ensureWatchdog();
});

// ----------------------------------------------------------------- messages
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;
  switch (msg.type) {
    case 'ig:keepalive':
      sendResponse({ ok: true });
      return false;
    case 'ig:keepAwake':
      if (msg.on) chrome.power.requestKeepAwake('system');
      else chrome.power.releaseKeepAwake();
      sendResponse({ ok: true });
      return false;
    case 'ig:clearBadge':
      badge('');
      chrome.storage.local.remove('watchdog');
      sendResponse({ ok: true });
      return false;
    case 'ig:event': {
      const e = msg.event || {};
      if (e.type === 'started') {
        ensureWatchdog();
        badge('');
      } else if (e.type === 'complete') {
        badge('✓', '#188038');
        notify(
          'ig-complete',
          'Instagram scan complete',
          e.incomplete ? `${e.count} people don't follow you back, but some data may be incomplete. Open the panel to check.` : `${e.count} people don't follow you back.`
        );
      } else if (e.type === 'paused_error') {
        badge('!', '#d93025');
        notify('ig-paused', 'Instagram scan paused on error', `${e.code}: ${e.message}`.slice(0, 200));
      }
      sendResponse({ ok: true });
      return false;
    }
    default:
      return false;
  }
});
