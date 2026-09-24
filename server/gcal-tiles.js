// Google Calendar event tiles → events. Shared by both Google Calendar
// sources: server/calendar-bridge.js (the user's real Chrome, via the
// clawd-browser bridge) and tools/gcal-peek.mjs (the legacy headless clone).
//
// A tile's first innerText line reads like
//   "7am to 7:30am, Some Sync, Austin Griffith, Accepted, No location, September 23, 2026"
// and its second line is the bare title. Everything here is plain parsing so
// it can be tested without a browser (test/test_calendar.js).

// Runs IN the calendar page (string, so it can go through CDP Runtime.evaluate
// or playwright's page.evaluate). Read-only: it touches nothing.
const TILE_READER_JS = `(() => {
  const seen = new Map();
  for (const el of document.querySelectorAll("[data-eventid][data-eventchip]")) {
    const id = el.getAttribute("data-eventid");
    if (!id || seen.has(id)) continue;
    const lines = (el.innerText || "").split("\\n").map((s) => s.trim()).filter(Boolean);
    if (!lines.length) continue;
    const struck = [el, ...el.querySelectorAll("span,div")].some(
      (n) => getComputedStyle(n).textDecorationLine.includes("line-through")
    );
    seen.set(id, { id, lines, struck });
  }
  return { title: document.title, url: location.href, tiles: [...seen.values()] };
})()`;

const MONTHS = ["january", "february", "march", "april", "may", "june", "july",
  "august", "september", "october", "november", "december"];

// "September 23, 2026" → local-midnight Date, or null.
function parseDate(text) {
  const m = /([A-Za-z]+) (\d{1,2}), (\d{4})/.exec(text || "");
  if (!m) return null;
  const mon = MONTHS.indexOf(m[1].toLowerCase());
  if (mon < 0) return null;
  return new Date(Number(m[3]), mon, Number(m[2]));
}

// The date a tile belongs to: the trailing "Month D, YYYY" of its first line.
function tileDate(line0) {
  const m = /([A-Za-z]+ \d{1,2}, \d{4})\s*$/.exec(line0 || "");
  return m ? parseDate(m[1]) : null;
}

// "10:45am to 11am" / "1 to 2pm" / "11:30pm to 12am" at the start of a line
// → [start, end] on the base date's day, or null (all-day and multi-day
// tiles don't start with a time range).
function parseTimeRange(text, base) {
  const m = /^(\d{1,2})(?::(\d{2}))?(am|pm)? to (\d{1,2})(?::(\d{2}))?(am|pm)/i.exec(text || "");
  if (!m) return null;
  const mk = (h, min, ap) => {
    let hh = Number(h) % 12;
    if (ap.toLowerCase() === "pm") hh += 12;
    const d = new Date(base);
    d.setHours(hh, Number(min || 0), 0, 0);
    return d;
  };
  const endAp = m[6];
  const startAp = m[3] || endAp; // "1 to 2pm": the start inherits the meridiem
  const start = mk(m[1], m[2], startAp);
  const end = mk(m[4], m[5], endAp);
  if (end <= start) end.setDate(end.getDate() + 1); // crosses midnight
  return [start, end];
}

// The RSVP word Google shows on a tile only when you're a GUEST on the event
// (your own solo blocks never carry one). It's the strongest "this is a real
// meeting with other people" signal a tile has.
const RSVP = { "accepted": "accepted", "needs rsvp": "pending", "maybe": "tentative",
  "tentative": "tentative", "declined": "declined" };

function rsvpOf(line0) {
  for (const field of (line0 || "").split(", ")) {
    const s = RSVP[field.trim().toLowerCase()];
    if (s) return s;
  }
  return null;
}

// One tile → one event, in the shape server/calendar.js expects. Returns null
// for tiles it can't place in time (no date). base: fallback date for tiles
// with no trailing date (not seen in practice).
function parseTile(tile, base = null) {
  const line0 = (tile.lines && tile.lines[0]) || "";
  const date = tileDate(line0) || (base ? new Date(base) : null);
  if (!date) return null;
  const range = parseTimeRange(line0, date);
  const rsvp = rsvpOf(line0);
  const locUrl = /(?:^|, )Location: (https?:\/\/[^,\s]+)/.exec(line0);
  const loc = /(?:^|, )Location: ([^,]+)/.exec(line0);
  const title = (tile.lines[1] || "").trim() || (line0.split(", ")[1] || "").trim();
  const ev = {
    gcalId: tile.id,
    title,
    calendar: "google",
    allDay: !range,
    date: date.toISOString(),
    invited: !!rsvp || !!locUrl,
    location: loc ? loc[1].trim() : "",
  };
  if (range) {
    ev.startsAt = range[0].toISOString();
    ev.endsAt = range[1].toISOString();
  }
  if (tile.struck || rsvp === "declined") ev.myStatus = "declined";
  else if (rsvp) ev.myStatus = rsvp;
  return ev;
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// Does a calendar page (by its document.title) show today? Day view:
// "… - Wednesday, September 23, 2026, today". Week view: "… - Week of
// September 20, 2026". Month and custom views return false; the tile dates
// still count (see readTab in calendar-bridge.js).
function titleShowsToday(title, now = new Date()) {
  const t = title || "";
  const week = /Week of ([A-Za-z]+ \d{1,2}, \d{4})/.exec(t);
  if (week) {
    const start = parseDate(week[1]);
    if (!start) return false;
    const end = new Date(start);
    end.setDate(end.getDate() + 7);
    return now >= start && now < end;
  }
  const day = /([A-Za-z]+ \d{1,2}, \d{4})/.exec(t);
  return !!day && sameDay(parseDate(day[1]) || new Date(0), now);
}

module.exports = { TILE_READER_JS, parseDate, tileDate, parseTimeRange, rsvpOf, parseTile, titleShowsToday, sameDay };
