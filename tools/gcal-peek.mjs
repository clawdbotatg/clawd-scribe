// gcal-peek — read the user's Google Calendar through their own logged-in
// Chrome profile, no Google API and no macOS Calendar sync required.
//
//   node tools/gcal-peek.mjs [--back <min>] [--fwd <min>] [--port 9333]
//                            [--profile <user-data-dir>] [--binary <chrome>]
//
// Emits the same JSON shape as native/calpeek: an array of events around
// "now" (title, startsAt/endsAt, allDay), with the event picked as "the
// meeting happening now" enriched with attendees/organizer/description read
// from its details popover. server/calendar.js re-picks from the array, so
// the enriched event is the one it lands on.
//
// How: a CLONE of the user's Chrome profile (made once by tools/gcal-clone.sh;
// it carries the Google login) runs headless with a CDP port. This script
// launches it on demand and leaves it running, so later peeks attach in ~2s.
// The clone must be driven by the SAME Chrome binary that owns the profile —
// that's how the cookies decrypt (macOS Keychain "Safe Storage").
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const { chromium } = require("playwright-core");

const opts = {
  back: 240,
  fwd: 20,
  port: 9333,
  profile: path.join(HERE, "..", "data", "gcal-profile"),
  binary: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
};
const argv = process.argv.slice(2);
while (argv.length >= 2) {
  const flag = argv.shift().replace(/^--/, "");
  const val = argv.shift();
  if (flag in opts) opts[flag] = typeof opts[flag] === "number" ? Number(val) : val;
}

function fail(msg, code = 1) {
  process.stdout.write(JSON.stringify({ error: msg }) + "\n");
  process.exit(code);
}

async function debuggerUp() {
  try {
    const res = await fetch(`http://127.0.0.1:${opts.port}/json/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

// Launch the headless clone if it isn't already running. Headless can't steal
// window focus, but must spoof a normal-Chrome UA or Google serves a warning
// page instead of the app.
async function ensureChrome() {
  if (await debuggerUp()) return;
  if (!fs.existsSync(opts.profile)) {
    fail(`no cloned profile at ${opts.profile} — run tools/gcal-clone.sh once (see README)`, 2);
  }
  if (!fs.existsSync(opts.binary)) fail(`chrome binary not found: ${opts.binary}`, 2);
  const ua =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
  const child = spawn(
    opts.binary,
    [
      "--headless=new",
      `--user-agent=${ua}`,
      "--window-size=1440,900",
      `--user-data-dir=${opts.profile}`,
      `--remote-debugging-port=${opts.port}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
    { detached: true, stdio: "ignore" }
  );
  child.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await debuggerUp()) return;
  }
  fail("headless chrome did not open its debug port within 20s", 3);
}

// "10:45am to 11am" / "1 to 2pm" / "11:30pm to 12am" → [start, end] Dates today.
function parseTimeRange(text, base) {
  const m = text.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)? to (\d{1,2})(?::(\d{2}))?(am|pm)/i);
  if (!m) return null;
  const mk = (h, min, ap) => {
    let hh = Number(h) % 12;
    if (ap.toLowerCase() === "pm") hh += 12;
    const d = new Date(base);
    d.setHours(hh, Number(min || 0), 0, 0);
    return d;
  };
  const endAp = m[6];
  const startAp = m[3] || endAp; // "1 to 2pm" — start inherits the meridiem
  const start = mk(m[1], m[2], startAp);
  const end = mk(m[4], m[5], endAp);
  if (end <= start) end.setDate(end.getDate() + 1); // crosses midnight
  return [start, end];
}

// Grid chips carry everything but guests: first innerText line reads like
// "10:45am to 11am, Prepare: SLOP.COMPUTER, Austin Griffith, No location,
// August 1, 2026"; the second line is the bare title. Declined events render
// struck through.
async function readGrid(page) {
  return page.evaluate(() => {
    const seen = new Map();
    for (const el of document.querySelectorAll("[data-eventid][data-eventchip]")) {
      const id = el.getAttribute("data-eventid");
      if (!id || seen.has(id)) continue;
      const lines = (el.innerText || "").split("\n").map((s) => s.trim()).filter(Boolean);
      if (!lines.length) continue;
      const struck = [el, ...el.querySelectorAll("span,div")].some(
        (n) => getComputedStyle(n).textDecorationLine.includes("line-through")
      );
      seen.set(id, { id, line0: lines[0], title: lines[1] || "", struck });
    }
    return [...seen.values()];
  });
}

// The details popover: guests (email via data-hovercard-id, RSVP words in the
// row text), organizer, location, description.
async function readPopover(page) {
  return page.evaluate(() => {
    const dlg = document.querySelector("[role=dialog]");
    if (!dlg) return null;
    const out = { attendees: [], organizer: null, description: "", location: "" };
    // several nodes carry the same data-hovercard-id (avatar, name, row) —
    // merge them per email, growing each node to its enclosing row but never
    // past row-sized text (the whole dialog also matches ancestors).
    const people = new Map();
    for (const el of dlg.querySelectorAll("[data-hovercard-id]")) {
      const email = el.getAttribute("data-hovercard-id");
      if (!email || !email.includes("@")) continue;
      let row = el;
      while (
        row.parentElement &&
        row.parentElement !== dlg &&
        (row.parentElement.innerText || "").length < 160
      ) {
        row = row.parentElement;
      }
      const rowText = (row.innerText || "").trim();
      const lines = rowText.split("\n").map((s) => s.trim()).filter(Boolean);
      const isOrganizer = /\borganizer\b/i.test(rowText);
      const status = /declined/i.test(rowText)
        ? "declined"
        : /awaiting|no rsvp|hasn't responded/i.test(rowText)
        ? "pending"
        : /maybe|tentative/i.test(rowText)
        ? "tentative"
        : /\baccepted\b/i.test(rowText)
        ? "accepted"
        : "unknown";
      let name = null;
      const om = rowText.match(/organizer:\s*([^\n]+)/i);
      if (om) name = om[1].trim();
      else {
        // first row line that looks like a person, not a "1 guest / 1 awaiting"
        // count header or an action label
        const cand = lines.find(
          (l) =>
            !l.includes("@") &&
            l.length < 60 &&
            !/^\d+\s|^copy |^email /i.test(l) &&
            !/^[a-z_]+$/.test(l) // material-icon ligatures: content_copy, more_vert…
        );
        if (cand) name = cand;
      }
      const prev = people.get(email);
      if (prev) {
        if (name && !prev.name) prev.name = name;
        if (isOrganizer) prev.isOrganizer = true;
        if (prev.status === "unknown" && status !== "unknown") prev.status = status;
      } else {
        people.set(email, { email, status, isOrganizer, ...(name ? { name } : {}) });
      }
    }
    for (const p of people.values()) {
      const { isOrganizer, ...person } = p;
      if (isOrganizer && !out.organizer) out.organizer = person;
      else out.attendees.push(person);
    }
    const text = dlg.innerText || "";
    const desc = text.match(/Description:\s*\n([\s\S]*?)(?:\n\d+ minutes? before|\nOrganizer:|$)/i);
    if (desc) out.description = desc[1].trim();
    const loc = text.match(/Location:\s*\n?([^\n]+)/i);
    if (loc) out.location = loc[1].trim();
    return out;
  });
}

const { pickCurrent } = require(path.join(HERE, "..", "server", "calendar.js"));

await ensureChrome();
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${opts.port}`, { timeout: 15000 });
try {
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  try {
    await page.goto("https://calendar.google.com/calendar/u/0/r/day", {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    if (/accounts\.google\.com/.test(page.url())) {
      fail("google session expired in the cloned profile — re-run tools/gcal-clone.sh", 4);
    }
    await page.waitForSelector("[data-eventid]", { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1000);

    const today = new Date();
    const events = [];
    const byId = new Map();
    for (const chip of await readGrid(page)) {
      const range = parseTimeRange(chip.line0, today);
      const ev = {
        gcalId: chip.id,
        title: chip.title || chip.line0.split(",")[1]?.trim() || chip.line0,
        calendar: "google",
        allDay: !range,
        ...(range ? { startsAt: range[0].toISOString(), endsAt: range[1].toISOString() } : {}),
        ...(chip.struck ? { myStatus: "declined" } : {}),
      };
      events.push(ev);
      byId.set(chip.id, ev);
    }

    // enrich only the event the server will pick — one popover click.
    // GCAL_PEEK_NOW=<iso> fakes the clock, for testing outside meeting hours.
    const now = process.env.GCAL_PEEK_NOW ? Date.parse(process.env.GCAL_PEEK_NOW) : Date.now();
    const picked = pickCurrent(events, now, opts.fwd * 60e3);
    if (picked && picked.gcalId) {
      const sel = `[data-eventid=${JSON.stringify(picked.gcalId)}][data-eventchip]`;
      await page.click(sel, { timeout: 5000 }).catch(() => {});
      const pop = await page
        .waitForSelector("[role=dialog]", { timeout: 8000 })
        .then(() => page.waitForTimeout(1200))
        .then(() => readPopover(page))
        .catch(() => null);
      if (pop) Object.assign(byId.get(picked.gcalId), pop);
    }

    process.stdout.write(JSON.stringify(events) + "\n");
  } finally {
    await page.close().catch(() => {});
  }
} finally {
  await browser.close().catch(() => {}); // disconnect only; chrome keeps running
}
