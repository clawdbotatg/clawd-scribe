// Calendar peek — asks native/calpeek (EventKit) what's on the user's calendar
// right now, so a recording can be named after the meeting they're in and carry
// the invite's metadata (attendees, organizer, description) into meta.json and
// the notes LLM. All local: EventKit reads whatever calendars macOS already
// syncs (iCloud, Google, Exchange, …).
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const BIN = path.join(__dirname, "..", "native", "calpeek");

function available() {
  return fs.existsSync(BIN);
}

// Raw event list around "now". The first-ever call blocks on the macOS
// Calendars permission dialog, hence the generous timeout.
function fetchEvents(config) {
  const cal = config.calendar || {};
  return new Promise((resolve, reject) => {
    execFile(
      BIN,
      ["--back", String(cal.lookbackMin || 240), "--fwd", String(cal.lookaheadMin || 20)],
      { timeout: (cal.timeoutSec || 25) * 1000, maxBuffer: 8e6 },
      (err, stdout) => {
        let parsed = null;
        try {
          parsed = JSON.parse(stdout);
        } catch {}
        if (parsed && !Array.isArray(parsed) && parsed.error) return reject(new Error(parsed.error));
        if (err) return reject(new Error("calpeek failed: " + err.message));
        if (!Array.isArray(parsed)) return reject(new Error("calpeek returned bad JSON"));
        resolve(parsed);
      }
    );
  });
}

// Which event is "the meeting I'm in right now"?
// - never all-day events, cancelled events, or invites the user declined
// - an event running now beats one about to start; among running events, ones
//   with actual invitees beat solo/focus blocks, then the latest start wins
//   (a 30-min standup inside an all-morning block IS the meeting, not the block)
// - otherwise the next event starting within the lookahead window
function pickCurrent(events, now = Date.now()) {
  const live = [];
  const soon = [];
  for (const e of events || []) {
    if (e.allDay || e.cancelled || e.myStatus === "declined" || !e.title) continue;
    const start = Date.parse(e.startsAt);
    const end = Date.parse(e.endsAt);
    if (isNaN(start) || isNaN(end)) continue;
    if (start <= now && now < end) live.push({ e, start });
    else if (start > now) soon.push({ e, start });
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
async function currentEvent(config) {
  if (!available()) return null;
  if (config.calendar && config.calendar.enabled === false) return null;
  return pickCurrent(await fetchEvents(config));
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

module.exports = { available, fetchEvents, pickCurrent, currentEvent, metaFromEvent, binPath: () => BIN };
