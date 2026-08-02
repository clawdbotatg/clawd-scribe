// Calendar peek — what meeting is the user in right now? Used to name a
// recording after the event and carry the invite's metadata (attendees,
// organizer, description) into meta.json and the notes LLM.
//
// Two sources, picked by config.calendar.source:
//   "gcal"     — tools/gcal-peek.mjs reads calendar.google.com through a
//                headless clone of the user's logged-in Chrome profile
//                (made once by tools/gcal-clone.sh). No Google API, no sync.
//   "eventkit" — native/calpeek reads whatever calendars macOS syncs
//                (needs the account added in System Settings → Internet
//                Accounts, and the one-time Calendars permission).
//   "auto"     — gcal if the cloned profile exists, else eventkit.
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const CALPEEK = path.join(__dirname, "..", "native", "calpeek");
const GCALPEEK = path.join(__dirname, "..", "tools", "gcal-peek.mjs");

function gcalProfileDir(config) {
  const cal = (config && config.calendar) || {};
  return (cal.gcal && cal.gcal.profileDir) || path.join(__dirname, "..", "data", "gcal-profile");
}

function source(config) {
  const cal = (config && config.calendar) || {};
  if (cal.source === "gcal" || cal.source === "eventkit") return cal.source;
  return fs.existsSync(gcalProfileDir(config)) ? "gcal" : "eventkit";
}

function available(config) {
  return source(config) === "gcal" ? fs.existsSync(GCALPEEK) : fs.existsSync(CALPEEK);
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
// short window: the UI hint polls once a minute, and a gcal peek costs a real
// headless-Chrome page load. First-ever calls are slow (EventKit: the macOS
// permission dialog; gcal: launching the headless clone) — hence the timeouts.
let cache = { at: 0, src: null, events: null };
async function fetchEvents(config, { fresh = false } = {}) {
  const cal = config.calendar || {};
  const src = source(config);
  if (!fresh && cache.events && cache.src === src && Date.now() - cache.at < (cal.cacheSec || 45) * 1000) {
    return cache.events;
  }
  let events;
  if (src === "gcal") {
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

// Which event is "the meeting I'm in right now"?
// - never all-day events, cancelled events, or invites the user declined
// - an event running now beats one about to start; among running events, ones
//   with actual invitees beat solo/focus blocks, then the latest start wins
//   (a 30-min standup inside an all-morning block IS the meeting, not the block)
// - otherwise the next event starting within lookaheadMs (the gcal source sees
//   the whole day at once, so "soon" must be bounded here, not by the fetch)
function pickCurrent(events, now = Date.now(), lookaheadMs = Infinity) {
  const live = [];
  const soon = [];
  for (const e of events || []) {
    if (e.allDay || e.cancelled || e.myStatus === "declined" || !e.title) continue;
    const start = Date.parse(e.startsAt);
    const end = Date.parse(e.endsAt);
    if (isNaN(start) || isNaN(end)) continue;
    if (start <= now && now < end) live.push({ e, start });
    else if (start > now && start - now <= lookaheadMs) soon.push({ e, start });
  }
  const invited = (x) => ((x.e.attendees || []).length ? 1 : 0);
  live.sort((a, b) => invited(b) - invited(a) || b.start - a.start);
  if (live.length) return live[0].e;
  soon.sort((a, b) => a.start - b.start);
  return soon.length ? soon[0].e : null;
}

// The best guess for the meeting happening now, or null (helper missing,
// feature disabled, or an empty calendar). Throws on access-denied/bad output
// so callers can log the reason.
async function currentEvent(config, opts) {
  if (!available(config)) return null;
  if (config.calendar && config.calendar.enabled === false) return null;
  const cal = config.calendar || {};
  return pickCurrent(await fetchEvents(config, opts), Date.now(), (cal.lookaheadMin || 20) * 60e3);
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

module.exports = { available, source, fetchEvents, pickCurrent, currentEvent, metaFromEvent };
