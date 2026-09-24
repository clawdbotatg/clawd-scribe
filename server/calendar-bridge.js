// Calendar source "bridge": read Google Calendar out of the user's REAL,
// logged-in Chrome through the clawd-browser bridge (a small HTTP server next
// to the browser; the Clawd Browser extension executes its commands).
//
// Only called when the user hits Record (or someone asks /api/calendar/now).
// Nothing polls. Order of preference:
//   1. a calendar.google.com tab the user already has open that shows today:
//      a read-only look at its event tiles, well under a second;
//   2. otherwise, open OUR OWN calendar tab in the background (extension
//      >= 0.9.1 honors {active:false}, so focus never moves), read it, close
//      it — ~5 s.
// The user's own tabs are never navigated, clicked, typed into or closed.
// Reads use the extension's `select` (>= 0.9.2): chrome.scripting in an
// isolated world, so Chrome never shows its "started debugging this browser"
// banner. Older extensions fall back to eval, always followed by a detach.
//
// No cookies are copied and nothing logs in: this is the user's own browser
// session, which is why it can't expire or sign anyone out the way the old
// headless profile clone (tools/gcal-peek.mjs) did.
const { TILE_READER_JS, parseTile, titleShowsToday, sameDay } = require("./gcal-tiles");

const CAL_PREFIX = "https://calendar.google.com/";
// Marks tabs the scribe opened, so a tab leaked by a crashed read is never
// mistaken for the user's and gets reaped by the next read.
const OWN_MARK = "clawdscribe=1";
const OWN_URL = `https://calendar.google.com/calendar/u/0/r/day?${OWN_MARK}`;
const MIN_OPEN_VERSION = [0, 9, 1]; // open {active:false}
const MIN_SELECT_VERSION = [0, 9, 2]; // select (no debugger)
const TILE_SELECTOR = "[data-eventid][data-eventchip]";

class BridgeError extends Error {
  constructor(message, { transient = false } = {}) {
    super(message);
    this.transient = transient; // worth a retry (extension napping, bridge restarting)
  }
}

function verAtLeast(v, min) {
  const p = String(v || "").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < min.length; i++) {
    if ((p[i] || 0) !== min[i]) return (p[i] || 0) > min[i];
  }
  return true;
}

function makeClient(opts) {
  const base = String(opts.url || "http://127.0.0.1:8765").replace(/\/+$/, "");
  const endpoint = opts.token ? `${base}/k/${opts.token}/cmd` : `${base}/cmd`;
  const doFetch = opts.fetch || fetch;
  // Errors never carry the endpoint: with a token it IS the credential.
  return async function cmd(name, args = {}, timeoutMs = 5000, extra = {}) {
    let res;
    try {
      res = await doFetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cmd: name, args, ...extra }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const why = e && e.name === "TimeoutError" ? "timed out" : "unreachable";
      throw new BridgeError(`browser bridge ${why} (${name})`, { transient: true });
    }
    let body;
    try {
      body = await res.json();
    } catch {
      throw new BridgeError(`browser bridge sent a bad reply (${name}, HTTP ${res.status})`, { transient: true });
    }
    if (res.status === 403) throw new BridgeError("browser bridge refused the request (bad or missing token)");
    if (!body.ok) {
      const err = String(body.error || "unknown error");
      // the extension's MV3 worker naps and reconnects on its own
      const transient = /not connected|no tab with given id|timed out|timeout|disconnect/i.test(err);
      throw new BridgeError(`browser: ${err.slice(0, 200)}`, { transient });
    }
    return body.result;
  };
}

// One tab's tiles → { title, url, tiles: [{ id, lines, struck }] }.
async function readTab(cmd, tabId, timeoutMs, caps) {
  if (caps.select) {
    const r = await cmd("select", { tab_id: tabId, selector: TILE_SELECTOR, attrs: ["data-eventid"], max: 1000 }, timeoutMs);
    const seen = new Map();
    for (const it of (r && r.items) || []) {
      const id = it.attrs && it.attrs["data-eventid"];
      if (!id || seen.has(id)) continue;
      const lines = String(it.text || "").split("\n").map((x) => x.trim()).filter(Boolean);
      if (lines.length) seen.set(id, { id, lines, struck: !!it.lineThrough });
    }
    return { title: r && r.title, url: r && r.url, tiles: [...seen.values()] };
  }
  try {
    const r = await cmd("eval", { tab_id: tabId, code: TILE_READER_JS }, timeoutMs);
    return (r && r.value) || { tiles: [] };
  } finally {
    await cmd("detach", { tab_id: tabId }, 3000).catch(() => {}); // never leave the debugger attached
  }
}

// Our own freshly opened tab: poll until tiles render. A genuinely empty day
// never gets any, so running out of time isn't failure — the title decides.
async function readOwnTab(cmd, tabId, caps, waitMs = 8000) {
  const t0 = Date.now();
  let page;
  for (;;) {
    page = await readTab(cmd, tabId, 4000, caps);
    if (page.tiles.length || Date.now() - t0 > waitMs) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  if (page.tiles.length) {
    await new Promise((r) => setTimeout(r, 300)); // let the rest of the grid paint
    page = await readTab(cmd, tabId, 4000, caps);
  }
  return page;
}

function eventsFrom(page) {
  const out = [];
  for (const tile of (page && page.tiles) || []) {
    const ev = parseTile(tile);
    if (ev) out.push(ev);
  }
  return out;
}

// A page is usable when it provably covers today: its title says so, or one
// of its tiles is dated today.
function coversToday(page, events, now) {
  const title = page && page.title;
  return titleShowsToday(title, now) || events.some((e) => sameDay(new Date(e.date), now));
}

function tabList(result) {
  return Array.isArray(result) ? result : (result && result.tabs) || [];
}

async function readOnce(cmd, opts, now, log) {
  const tabs = tabList(await cmd("tabs", {}, 3000));
  const calTabs = tabs.filter((t) => String(t.url || "").startsWith(CAL_PREFIX));
  const own = calTabs.filter((t) => String(t.url).includes(OWN_MARK));
  const users = calTabs.filter((t) => !String(t.url).includes(OWN_MARK));

  // reap tabs a crashed earlier read left behind (ours only, by the mark)
  for (const t of own) await cmd("close_tab", { tab_id: t.tab_id }, 3000).catch(() => {});

  const ver = await cmd("version", {}, 3000).catch(() => null);
  const caps = {
    select: !!ver && verAtLeast(ver.version, MIN_SELECT_VERSION),
    open: !!ver && verAtLeast(ver.version, MIN_OPEN_VERSION),
  };

  // 1. the user's open calendar tabs, read-only
  const byId = new Map();
  let usable = 0;
  let lastErr = null;
  for (const t of users.slice(0, 3)) {
    try {
      const page = await readTab(cmd, t.tab_id, 4000, caps);
      const events = eventsFrom(page);
      if (!coversToday(page, events, now)) continue;
      usable++;
      for (const e of events) byId.set(e.gcalId, e);
    } catch (e) {
      lastErr = e;
    }
  }
  if (usable) {
    log(`[calendar] read ${byId.size} events from ${usable} open calendar tab(s)`);
    return [...byId.values()];
  }

  // 2. our own background tab
  if (!caps.open) {
    if (lastErr) throw lastErr;
    throw new BridgeError(
      users.length
        ? "the open Google Calendar tab isn't showing today"
        : "no Google Calendar tab open in Chrome (and the browser extension is too old to open one in the background)"
    );
  }
  // route to the browser that already shows Google Calendar, if several are connected
  const target = users[0] && users[0].browser ? { target: users[0].browser } : {};
  const opened = await cmd("open", { url: OWN_URL, active: false }, 20000, target);
  const tabId = opened && opened.tab_id;
  if (tabId == null) throw new BridgeError("browser didn't report the calendar tab it opened", { transient: true });
  try {
    if (/accounts\.google\.com/.test(String(opened.url || ""))) {
      throw new BridgeError("Chrome isn't signed in to Google Calendar");
    }
    const page = await readOwnTab(cmd, tabId, caps, opts.ownTabWaitMs);
    if (/accounts\.google\.com/.test(String(page.url || ""))) {
      throw new BridgeError("Chrome isn't signed in to Google Calendar");
    }
    const events = eventsFrom(page);
    if (!coversToday(page, events, now)) {
      throw new BridgeError("the calendar page didn't load today's day view", { transient: true });
    }
    log(`[calendar] read ${events.length} events from a background calendar tab`);
    return events;
  } finally {
    await cmd("close_tab", { tab_id: tabId }, 5000).catch(() => {});
  }
}

// Concurrent callers (a Record tap racing /api/calendar/now) share one read,
// so two background tabs are never opened at once.
let inflight = null;

// → array of events (see gcal-tiles.parseTile). Retries transient failures
// (the extension's service worker naps for seconds at a time) within a total
// budget; throws a BridgeError with a human reason otherwise.
async function fetchEvents(opts = {}) {
  if (inflight) return inflight;
  const cmd = makeClient(opts);
  const log = opts.log || ((m) => console.error(m));
  const budgetMs = (opts.timeoutSec || 15) * 1000;
  const tries = opts.tries || 3;
  const gapMs = opts.retryGapMs != null ? opts.retryGapMs : 2000;
  const t0 = Date.now();
  inflight = (async () => {
    let last;
    for (let i = 0; i < tries; i++) {
      try {
        return await readOnce(cmd, opts, opts.now ? new Date(opts.now) : new Date(), log);
      } catch (e) {
        last = e;
        if (!e.transient || Date.now() - t0 + gapMs > budgetMs) break;
        await new Promise((r) => setTimeout(r, gapMs));
      }
    }
    throw last;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

module.exports = { fetchEvents, BridgeError, verAtLeast, OWN_URL, OWN_MARK };
