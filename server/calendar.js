// Calendar peek — what meeting is the user in right now? Used to name a
// recording after the event and carry the invite's metadata (attendees,
// organizer, description) into meta.json and the notes LLM.
//
// Sources, picked by config.calendar.source:
//   "bridge"   — server/calendar-bridge.js reads calendar.google.com out of
//                the user's REAL logged-in Chrome via the clawd-browser
//                bridge. Nothing to set up, nothing to expire. The default.
//   "gcal"     — tools/gcal-peek.mjs reads calendar.google.com through a
//                headless clone of the user's Chrome profile (made by
//                tools/gcal-clone.sh). Legacy: the clone's login expires in
//                days, and killing a clone once signed the user's real
//                browser out (2026-09-20). Opt-in only.
//   "eventkit" — native/calpeek reads whatever calendars macOS syncs
//                (needs the account in System Settings → Internet Accounts).
//                Opt-in only.
//   "auto"     — bridge. (A fallback chain onto sources that don't work
//                only hides failures; set one of the others explicitly.)
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const bridge = require("./calendar-bridge");

const CALPEEK = path.join(__dirname, "..", "native", "calpeek");
const GCALPEEK = path.join(__dirname, "..", "tools", "gcal-peek.mjs");

function gcalProfileDir(config) {
  const cal = (config && config.calendar) || {};
  return (cal.gcal && cal.gcal.profileDir) || path.join(__dirname, "..", "data", "gcal-profile");
}

function source(config) {
  const cal = (config && config.calendar) || {};
  if (cal.source === "gcal" || cal.source === "eventkit") return cal.source;
  return "bridge";
}

function available(config) {
  const src = source(config);
  if (src === "bridge") return true; // reachability is only known by asking
  return src === "gcal" ? fs.existsSync(GCALPEEK) && fs.existsSync(gcalProfileDir(config)) : fs.existsSync(CALPEEK);
}

function run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8e6 }, (err, stdout) => {
      let parsed = null;
      try {
        parsed = JSON.parse(stdout);
      } catch {}
      if (parsed && !Array.isArray(parsed) && parsed.error) return reject(new Error(parsed.error));
      if (err) return reject(new Error(`${path.basename(cmd === process.execPath ? args[0] : cmd)} failed: ${err.message}`));
      if (!Array.isArray(parsed)) return reject(new Error("calendar peek returned bad JSON"));
      resolve(parsed);
    });
  });
}

// Raw event list around "now", from whichever source is active. Cached for a
// few seconds so a burst of callers shares one read; the Record tap always
// passes fresh. Nothing calls this on a timer.
let cache = { at: 0, src: null, events: null };
async function fetchEvents(config, { fresh = false } = {}) {
  const cal = config.calendar || {};
  const src = source(config);
  if (!fresh && cache.events && cache.src === src && Date.now() - cache.at < (cal.cacheSec != null ? cal.cacheSec : 10) * 1000) {
    return cache.events;
  }
  let events;
  if (src === "bridge") {
    events = await bridge.fetchEvents(cal.bridge || {});
  } else if (src === "gcal") {
    const g = cal.gcal || {};
    const args = [GCALPEEK, "--back", String(cal.lookbackMin || 240), "--fwd", String(cal.lookaheadMin || 20)];
    if (g.port) args.push("--port", String(g.port));
    if (g.profileDir) args.push("--profile", g.profileDir);
    if (g.binary) args.push("--binary", g.binary);
    events = await run(process.execPath, args, (g.timeoutSec || 90) * 1000);
  } else {
    events = await run(
      CALPEEK,
      ["--back", String(cal.lookbackMin || 240), "--fwd", String(cal.lookaheadMin || 20)],
      (cal.timeoutSec || 25) * 1000
    );
  }
  cache = { at: Date.now(), src, events };
  return events;
}

// Which event is "the meeting I'm in right now"? rankCandidates returns every
// plausible event, best first; pickCurrent is its head.
//
// Candidates: running now, or starting within lookaheadMs. Never all-day,
// cancelled, declined, or untitled. Ranked by, in order:
//   1. invited: a meeting with other people (a guest RSVP on the tile, a URL
//      location, or a known attendee list) beats a solo block — a trash
//      reminder or a "Prepare:" block overlapping a call never wins;
//   2. fresh: an event that started less than FRESH_MS ago, or is about to,
//      beats one that has been running for a while (hitting Record at 1:50
//      means the 1:45 meeting, not the 1:30 one that's still on);
//   3. the start closest to now.
const FRESH_MS = 10 * 60e3;
function rankCandidates(events, now = Date.now(), lookaheadMs = 10 * 60e3) {
  const cands = [];
  for (const e of events || []) {
    if (e.allDay || e.cancelled || e.myStatus === "declined" || !e.title) continue;
    const start = Date.parse(e.startsAt);
    const end = Date.parse(e.endsAt);
    if (isNaN(start) || isNaN(end)) continue;
    const live = start <= now && now < end;
    const soon = start > now && start - now <= lookaheadMs;
    if (!live && !soon) continue;
    cands.push({
      e,
      invited: e.invited || (e.attendees || []).length > 0 ? 1 : 0,
      fresh: soon || now - start < FRESH_MS ? 1 : 0,
      dist: Math.abs(start - now),
    });
  }
  cands.sort((a, b) => b.invited - a.invited || b.fresh - a.fresh || a.dist - b.dist);
  return cands.map((c) => c.e);
}

function pickCurrent(events, now = Date.now(), lookaheadMs = 10 * 60e3) {
  return rankCandidates(events, now, lookaheadMs)[0] || null;
}

// The best guess for the meeting happening now, or null (helper missing,
// feature disabled, or an empty calendar). Throws on access-denied/bad output
// so callers can log the reason.
async function currentEvent(config, opts) {
  const p = await currentPick(config, opts);
  return p ? p.event : null;
}

// { event, others } — the pick plus the runners-up the UI offers as one-tap
// swaps — or null when there's no event now (or the feature is off).
async function currentPick(config, opts) {
  if (!available(config)) return null;
  if (config.calendar && config.calendar.enabled === false) return null;
  const ranked = rankCandidates(await fetchEvents(config, opts), Date.now(), lookaheadMs(config));
  if (!ranked.length) return null;
  return { event: ranked[0], others: ranked.slice(1, 5) };
}

function lookaheadMs(config) {
  const cal = (config && config.calendar) || {};
  return (cal.lookaheadMin != null ? cal.lookaheadMin : 10) * 60e3;
}

// The slice of an event worth persisting into a meeting's meta.json.
function metaFromEvent(e) {
  return {
    title: e.title,
    calendar: e.calendar || "",
    startsAt: e.startsAt,
    endsAt: e.endsAt,
    organizer: e.organizer || null,
    attendees: e.attendees || [],
    description: (e.description || "").slice(0, 4000),
    location: e.location || "",
    url: e.url || "",
  };
}

module.exports = {
  available, source, fetchEvents, rankCandidates, pickCurrent, currentEvent, currentPick, lookaheadMs, metaFromEvent,
};
