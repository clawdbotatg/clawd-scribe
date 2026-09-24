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
// launches it on demand; chrome exits with the last tab, so each peek is a
// clean ~5s cold launch (warm reattach hangs on managed Workspace profiles).
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

// Kill every chrome process running against OUR clone dir (the profile path
// is unique to this tool, so the match can't hit the user's real browser) and
// wait for the debug port to drop. Also clears the profile's singleton lock so
// the relaunch can't hand itself off to a half-dead instance.
async function killClone() {
  const pattern = `--user-data-dir=${opts.profile}`;
  for (const sig of ["-TERM", "-KILL"]) {
    await new Promise((r) => spawn("pkill", [sig, "-f", "--", pattern], { stdio: "ignore" }).on("exit", r));
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 300));
      if (!(await debuggerUp())) break;
    }
    if (!(await debuggerUp())) break;
  }
  for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    fs.rmSync(path.join(opts.profile, f), { force: true });
  }
}

// Launch the headless clone if it isn't already running. Headless can't steal
// window focus, but must spoof a normal-Chrome UA or Google serves a warning
// page instead of the app.
async function ensureChrome() {
  // Never reattach. A clone left behind by a peek that died mid-flight parks a
  // chrome://managed-user-profile-notice page (managed Google Workspace
  // account, Chrome 153+) that makes connectOverCDP itself hang — every later
  // peek then burns its full timeout. The clone is disposable: kill it and
  // cold-launch, which is a reliable 3-4s.
  if (await debuggerUp()) {
    await killClone();
    if (await debuggerUp()) fail("a stale headless clone on the debug port would not die", 3);
  }
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
const { TILE_READER_JS, parseTile } = require(path.join(HERE, "..", "server", "gcal-tiles.js"));

// last-resort watchdog: no single CDP call is trusted to time out (a managed
// profile once made Target.createTarget hang forever). unref'd so it never
// keeps the process alive itself; a leaked tab is reaped by the next run.
setTimeout(() => fail("gcal-peek watchdog: still running after 75s", 5), 75000).unref();

await ensureChrome();
let failure = null;
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${opts.port}`, { timeout: 15000 });
try {
  const ctx = browser.contexts()[0];
  // the clone exists only for these peeks — any page already open is a leak
  // from a run that died mid-flight (execFile timeout, crash); reap them all.
  // Chrome exits when its last tab closes, so each peek is a clean cold launch
  // (~5s, well inside the server's 90s budget). We used to keep chrome warm
  // between peeks, but a managed Google Workspace profile parks a
  // chrome://managed-user-profile-notice page that blocks Target.createTarget
  // on reattach, hanging the peek forever.
  for (const stray of ctx.pages()) await stray.close().catch(() => {});
  const page = await ctx.newPage();
  try {
    await page.goto("https://calendar.google.com/calendar/u/0/r/day", {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    if (/accounts\.google\.com/.test(page.url())) {
      // throw, don't fail(): process.exit() would skip the finallys below and
      // leak this tab into the long-lived chrome on every single peek.
      const err = new Error("google session expired in the cloned profile — re-run tools/gcal-clone.sh");
      err.exitCode = 4;
      throw err;
    }
    await page.waitForSelector("[data-eventid]", { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1000);

    const today = new Date();
    const events = [];
    const byId = new Map();
    const grid = await page.evaluate(TILE_READER_JS);
    for (const tile of grid.tiles) {
      const ev = parseTile(tile, today); // dates come from the tile itself
      if (!ev) continue;
      events.push(ev);
      byId.set(ev.gcalId, ev);
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
} catch (e) {
  failure = e;
} finally {
  await browser.close().catch(() => {}); // disconnect
  await killClone(); // don't leave a wedge-prone clone (~300 MB) behind
}
if (failure) fail(failure.message, failure.exitCode || 1); // after every cleanup ran
