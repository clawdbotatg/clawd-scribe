// Calendar titles (node test/test_calendar.js). No browser, no network: a
// fake clawd-browser bridge on a local port stands in for Chrome. Fixture
// titles are made up but copy the real tile text format (this repo is public).
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

process.env.SCRIBE_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-cal-"));
const tiles = require("../server/gcal-tiles");
const calendar = require("../server/calendar");
const bridge = require("../server/calendar-bridge");
const titles = require("../server/titles");
const store = require("../server/store");
const { migrate } = require("../server/config");

let n = 0;
function ok(name) {
  n++;
  console.log("ok: " + name);
}
const at = (h, m = 0, d = 23) => new Date(2026, 8, d, h, m).getTime();
const tile = (id, line0, title, struck = false) => ({ id, lines: [line0, title, "x"], struck });

// ---------------------------------------------------------------- parsing
{
  const e = tiles.parseTile(tile("a", "7am to 7:30am, Alpha / Beta, Pat Doe, Needs RSVP, No location, September 23, 2026", "Alpha / Beta"));
  assert.strictEqual(e.title, "Alpha / Beta");
  assert.strictEqual(Date.parse(e.startsAt), at(7));
  assert.strictEqual(Date.parse(e.endsAt), at(7, 30));
  assert.strictEqual(e.invited, true);
  assert.strictEqual(e.myStatus, "pending");
  assert.strictEqual(e.allDay, false);
  ok("guest tile: times, title, RSVP → invited");

  const solo = tiles.parseTile(tile("b", "7:15am to 7:45am, WATER THE PLANTS, Pat Doe, No location, September 23, 2026", "WATER THE PLANTS"));
  assert.strictEqual(solo.invited, false);
  assert.strictEqual(solo.myStatus, undefined);
  ok("solo block: not invited");

  const url = tiles.parseTile(tile("c", "1:45pm to 3:15pm, Show LIVESTREAM, Pat Doe, Location: https://vdo.example/?room=x&hash=y, September 23, 2026", "Show LIVESTREAM"));
  assert.strictEqual(url.invited, true);
  assert.strictEqual(url.location, "https://vdo.example/?room=x&hash=y");
  assert.strictEqual(Date.parse(url.startsAt), at(13, 45));
  ok("URL location → invited");

  const night = tiles.parseTile(tile("d", "1am to 2am, Night Talk | Topic (prev. Old), Pat Doe, Needs RSVP, No location, September 22, 2026", "Night Talk | Topic (prev. Old)"));
  assert.strictEqual(Date.parse(night.startsAt), at(1, 0, 22));
  ok("date comes from the tile, not today");

  const late = tiles.parseTile(tile("e", "11:30pm to 12am, Late, Pat Doe, No location, September 22, 2026", "Late"));
  assert.strictEqual(Date.parse(late.endsAt), at(0, 0, 23));
  ok("crossing midnight");

  const inherit = tiles.parseTile(tile("f", "1 to 2pm, dog, Pat Doe, No location, September 23, 2026", "dog"));
  assert.strictEqual(Date.parse(inherit.startsAt), at(13));
  ok("start inherits the end's am/pm");

  assert.strictEqual(tiles.parseTile(tile("g", "8am to 9am, Nope, Pat Doe, Declined, No location, September 23, 2026", "Nope")).myStatus, "declined");
  assert.strictEqual(tiles.parseTile(tile("h", "8am to 9am, Struck, Pat Doe, No location, September 23, 2026", "Struck", true)).myStatus, "declined");
  ok("declined by word or strikethrough");

  const allDay = tiles.parseTile(tile("i", "All day, Holiday, Pat Doe, September 23, 2026", "Holiday"));
  assert.strictEqual(allDay.allDay, true);
  ok("no time range → all-day");

  const comma = tiles.parseTile(tile("j", "9am to 10am, Sync, part 2, Pat Doe, Accepted, No location, September 23, 2026", "Sync, part 2"));
  assert.strictEqual(comma.title, "Sync, part 2");
  ok("title with a comma comes whole from line 2");

  assert.strictEqual(tiles.parseTile({ id: "k", lines: ["gibberish", "t"] }), null);
  ok("undatable tile → null");

  const now = new Date(at(10));
  assert.strictEqual(tiles.titleShowsToday("Org - Calendar - Week of September 20, 2026", now), true);
  assert.strictEqual(tiles.titleShowsToday("Org - Calendar - Week of September 27, 2026", now), false);
  assert.strictEqual(tiles.titleShowsToday("Org - Calendar - Wednesday, September 23, 2026, today", now), true);
  assert.strictEqual(tiles.titleShowsToday("Org - Calendar - Thursday, September 24, 2026", now), false);
  assert.strictEqual(tiles.titleShowsToday("Org - Calendar - September 2026", now), false);
  ok("page title → shows today?");
}

// ---------------------------------------------------------------- picking
{
  const ev = (title, h1, m1, h2, m2, invited = false, extra = {}) => ({
    title, invited, startsAt: new Date(at(h1, m1)).toISOString(), endsAt: new Date(at(h2, m2)).toISOString(), ...extra,
  });
  const pick = (events, h, m) => (calendar.pickCurrent(events, at(h, m), 10 * 60e3) || {}).title;
  // the six real overlaps from the week of 2026-09-20, renamed
  assert.strictEqual(pick([ev("Alpha / Beta", 7, 0, 7, 30, true), ev("WATER THE PLANTS", 7, 15, 7, 45)], 7, 20), "Alpha / Beta");
  assert.strictEqual(pick([ev("dog", 13, 0, 14, 0), ev("Standup", 13, 30, 14, 0, true)], 13, 35), "Standup");
  assert.strictEqual(
    pick([ev("dog", 13, 0, 14, 0), ev("Standup", 13, 30, 14, 0, true), ev("money", 13, 45, 15, 30), ev("Show LIVESTREAM", 13, 45, 15, 15, true)], 13, 50),
    "Show LIVESTREAM"
  );
  assert.strictEqual(pick([ev("workshop", 10, 45, 12, 15), ev("Workshop With Guests", 11, 0, 12, 0, true)], 11, 2), "Workshop With Guests");
  assert.strictEqual(pick([ev("Prepare: Show", 12, 15, 12, 30), ev("Show", 12, 30, 13, 30, true)], 12, 27), "Show");
  assert.strictEqual(pick([ev("Call: Sam + Pat", 8, 0, 8, 30)], 8, 2), "Call: Sam + Pat");
  ok("the six real overlaps pick the meeting");

  assert.strictEqual(pick([ev("Later", 10, 15, 11, 0, true)], 10, 0), undefined);
  assert.strictEqual(pick([ev("Soon", 10, 8, 11, 0, true)], 10, 0), "Soon");
  ok("lookahead is 10 minutes");

  assert.strictEqual(pick([ev("Declined", 10, 0, 11, 0, true, { myStatus: "declined" }), ev("Solo", 10, 0, 11, 0)], 10, 5), "Solo");
  assert.strictEqual(pick([ev("Holiday", 0, 0, 23, 59, true, { allDay: true })], 10, 5), undefined);
  ok("declined and all-day never win");

  assert.strictEqual(pick([ev("Long", 9, 0, 11, 0, true), ev("Next", 10, 5, 11, 0, true)], 10, 0), "Next");
  assert.strictEqual(pick([ev("Long", 9, 0, 11, 0, true)], 10, 0), "Long");
  ok("fresh beats long-running; long-running still wins alone");

  const ranked = calendar.rankCandidates([ev("dog", 13, 0, 14, 0), ev("Standup", 13, 30, 14, 0, true)], at(13, 35));
  assert.deepStrictEqual(ranked.map((e) => e.title), ["Standup", "dog"]);
  assert.strictEqual(pick([ev("Known Guests", 10, 0, 11, 0, false, { attendees: [{ email: "x@y" }] }), ev("Solo", 10, 1, 11, 0)], 10, 2), "Known Guests");
  ok("runners-up in rank order; attendee lists count as invited");
}

// ---------------------------------------------------------------- titles
{
  const pickObj = { event: { title: "Widget Sync", startsAt: "a", endsAt: "b" }, others: [{ title: "dog", startsAt: "c", endsAt: "d" }] };
  const m1 = { title: "Meeting 9/23", titleSource: "default" };
  assert.strictEqual(titles.applyCalendarPick(m1, pickObj), true);
  assert.strictEqual(m1.title, "Widget Sync");
  assert.strictEqual(m1.titleSource, "calendar");
  assert.strictEqual(m1.calendar.title, "Widget Sync");
  assert.deepStrictEqual(m1.calendarOthers.map((o) => o.title), ["dog"]);
  ok("default title → calendar title");

  assert.strictEqual(titles.applyCalendarPick(m1, { event: { title: "Other" }, others: [] }), false);
  assert.strictEqual(m1.title, "Widget Sync");
  assert.strictEqual(m1.calendar.title, "Widget Sync");
  assert.strictEqual(m1.calendarOthers.length, 1);
  ok("calendar writes title and context only once");

  const m2 = { title: "My typed name", titleSource: "user" };
  assert.strictEqual(titles.applyCalendarPick(m2, pickObj), false);
  assert.strictEqual(m2.title, "My typed name");
  assert.strictEqual(m2.calendar.title, "Widget Sync");
  ok("typed title wins; invite context still attached");

  const legacy = { title: "Meeting 8/1" };
  assert.strictEqual(titles.applyCalendarPick(legacy, pickObj), false);
  assert.strictEqual(legacy.title, "Meeting 8/1");
  ok("meetings from before titleSource count as typed");

  titles.swapCalendarPick(m1, 0);
  assert.strictEqual(m1.title, "dog");
  assert.strictEqual(m1.titleSource, "user");
  assert.deepStrictEqual(m1.calendarOthers.map((o) => o.title), ["Widget Sync"]);
  assert.throws(() => titles.swapCalendarPick(m1, 5));
  ok("overlap button swaps title + context, becomes the user's");

  titles.setUserTitle(m2, "");
  assert.strictEqual(m2.title, "My typed name");
  titles.setUserTitle(m2, "New");
  assert.strictEqual(m2.titleSource, "user");
  ok("empty typed title is ignored");

  assert.strictEqual(store.createMeeting().titleSource, "default");
  assert.strictEqual(store.createMeeting("Named").titleSource, "user");
  assert.strictEqual(store.createMeeting("Kept", "calendar").titleSource, "calendar");
  ok("createMeeting records where the title came from");

  const cfg = { calendar: { lookaheadMin: 20, cacheSec: 45 }, alerts: { preflightLookaheadMin: 15 } };
  migrate(cfg);
  assert.deepStrictEqual([cfg.calendar.lookaheadMin, cfg.calendar.cacheSec, "preflightLookaheadMin" in cfg.alerts], [10, 10, false]);
  const edited = { calendar: { lookaheadMin: 5, cacheSec: 30 } };
  migrate(edited);
  assert.deepStrictEqual([edited.calendar.lookaheadMin, edited.calendar.cacheSec], [5, 30]);
  ok("config: stale defaults migrate, edited values stay");
}

// ---------------------------------------------------------------- fake bridge
const TODAY_TILES = [
  tile("t1", "10am to 11am, Widget Sync, Pat Doe, Accepted, No location, September 23, 2026", "Widget Sync"),
  tile("t2", "10am to 11am, dog, Pat Doe, No location, September 23, 2026", "dog"),
];
const WEEK_TITLE = "Org - Calendar - Week of September 20, 2026";
const DAY_TITLE = "Org - Calendar - Wednesday, September 23, 2026, today";

function fakeBridge(script) {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const msg = JSON.parse(body || "{}");
      calls.push({ path: req.url, ...msg });
      let out;
      try {
        out = { ok: true, result: await script(msg, calls) };
      } catch (e) {
        out = { ok: false, error: e.message };
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(out));
    });
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, calls, url: `http://127.0.0.1:${srv.address().port}` })));
}

// a scripted browser: tabs = [{tab_id,url,title,tiles}], version string
function browser({ tabs, version = "0.9.2", ownTitle = DAY_TITLE, ownTiles = TODAY_TILES, ownUrl, failTabs = 0, evalThrowsFor = null, openDelayMs = 0 }) {
  let tabCalls = 0;
  const byId = new Map(tabs.map((t) => [t.tab_id, t]));
  return async (msg) => {
    const a = msg.args || {};
    switch (msg.cmd) {
      case "tabs":
        if (tabCalls++ < failTabs) throw new Error("extension not connected");
        return { tabs: [...byId.values()].map(({ tab_id, url }) => ({ tab_id, url })) };
      case "eval":
      case "select": {
        if (a.tab_id === evalThrowsFor) throw new Error("page crashed");
        const t = byId.get(a.tab_id);
        if (!t) throw new Error(`No tab with given id ${a.tab_id}.`);
        if (msg.cmd === "eval") return { value: { title: t.title, url: t.url, tiles: t.tiles } };
        return {
          title: t.title,
          url: t.url,
          items: (t.tiles || []).map((x) => ({ attrs: { "data-eventid": x.id }, text: x.lines.join("\n"), lineThrough: !!x.struck })),
        };
      }
      case "detach":
        return { detached: a.tab_id };
      case "version":
        return { version };
      case "open": {
        if (openDelayMs) await new Promise((r) => setTimeout(r, openDelayMs));
        const t = { tab_id: 999, url: ownUrl || a.url, title: ownTitle, tiles: ownTiles };
        byId.set(999, t);
        return { tab_id: 999, url: t.url, loaded: true };
      }
      case "wait_for":
        return { ready: true };
      case "close_tab":
        byId.delete(a.tab_id);
        return { closed: a.tab_id };
      default:
        throw new Error("unexpected cmd " + msg.cmd);
    }
  };
}

const NOW = at(10, 5);
const quiet = { log: () => {}, now: NOW, retryGapMs: 10 };
const cmds = (calls) => calls.map((c) => c.cmd + (c.args && c.args.tab_id != null ? ":" + c.args.tab_id : ""));
const USER_TAB_ID = 7;

async function bridgeTests() {
  {
    const fb = await fakeBridge(browser({ tabs: [{ tab_id: USER_TAB_ID, url: "https://calendar.google.com/calendar/u/0/r", title: WEEK_TITLE, tiles: TODAY_TILES }, { tab_id: 3, url: "https://example.com/" }] }));
    const events = await bridge.fetchEvents({ url: fb.url, ...quiet });
    assert.deepStrictEqual(events.map((e) => e.title).sort(), ["Widget Sync", "dog"]);
    assert.deepStrictEqual(cmds(fb.calls), ["tabs", "version", "select:7"]);
    ok("bridge: open calendar tab showing today → one select, no debugger, nothing opened");
    fb.srv.close();
  }
  {
    const fb = await fakeBridge(browser({ tabs: [{ tab_id: 3, url: "https://example.com/" }] }));
    const events = await bridge.fetchEvents({ url: fb.url, ...quiet });
    assert.strictEqual(events.length, 2);
    const open = fb.calls.find((c) => c.cmd === "open");
    assert.strictEqual(open.args.active, false);
    assert.ok(open.args.url.includes(bridge.OWN_MARK));
    assert.deepStrictEqual(cmds(fb.calls), ["tabs", "version", "open", "select:999", "select:999", "close_tab:999"]);
    ok("bridge: no calendar tab → background tab (active:false), read, closed");
    fb.srv.close();
  }
  {
    const oldWeek = [tile("o1", "10am to 11am, Old, Pat Doe, No location, September 9, 2026", "Old")];
    const fb = await fakeBridge(browser({ tabs: [{ tab_id: USER_TAB_ID, url: "https://calendar.google.com/calendar/u/0/r/week/2026/9/9", title: "Org - Calendar - Week of September 6, 2026", tiles: oldWeek }] }));
    const events = await bridge.fetchEvents({ url: fb.url, ...quiet });
    assert.deepStrictEqual(events.map((e) => e.title).sort(), ["Widget Sync", "dog"]);
    const onUserTab = fb.calls.filter((c) => c.args && c.args.tab_id === USER_TAB_ID).map((c) => c.cmd);
    assert.deepStrictEqual(onUserTab, ["select"]);
    ok("bridge: calendar tab on another week → ignored (never navigated), background tab instead");
    fb.srv.close();
  }
  {
    const fb = await fakeBridge(browser({ tabs: [], version: "0.9.0" }));
    await assert.rejects(bridge.fetchEvents({ url: fb.url, ...quiet }), /no Google Calendar tab open/);
    assert.ok(!fb.calls.some((c) => c.cmd === "open"));
    ok("bridge: extension too old to open a background tab → never opens one");
    fb.srv.close();
  }
  {
    const fb = await fakeBridge(browser({ tabs: [{ tab_id: USER_TAB_ID, url: "https://calendar.google.com/", title: WEEK_TITLE, tiles: TODAY_TILES }], failTabs: 2 }));
    const events = await bridge.fetchEvents({ url: fb.url, ...quiet });
    assert.strictEqual(events.length, 2);
    assert.strictEqual(fb.calls.filter((c) => c.cmd === "tabs").length, 3);
    ok("bridge: extension napping twice → retried, still read");
    fb.srv.close();
  }
  {
    // extension 0.9.1: no select, so eval — and a detach after every eval, even a failing one
    const fb = await fakeBridge(browser({ tabs: [{ tab_id: USER_TAB_ID, url: "https://calendar.google.com/", title: WEEK_TITLE, tiles: TODAY_TILES }], evalThrowsFor: USER_TAB_ID, version: "0.9.1" }));
    await bridge.fetchEvents({ url: fb.url, ...quiet });
    const seq = cmds(fb.calls);
    assert.ok(seq.indexOf("detach:7") === seq.indexOf("eval:7") + 1, seq.join(" "));
    assert.ok(seq.includes("close_tab:999"));
    assert.ok(!seq.some((c) => c.startsWith("select")));
    assert.strictEqual(seq.filter((c) => c.startsWith("eval")).length, seq.filter((c) => c.startsWith("detach")).length);
    ok("bridge: old extension → eval with a detach after every one, even failing");
    fb.srv.close();
  }
  {
    const fb = await fakeBridge(browser({ tabs: [{ tab_id: 55, url: "https://calendar.google.com/calendar/u/0/r/day?clawdscribe=1", title: DAY_TITLE, tiles: TODAY_TILES }] }));
    // (tab 55 is ours by its mark)
    await bridge.fetchEvents({ url: fb.url, ...quiet });
    const on55 = fb.calls.filter((c) => c.args && c.args.tab_id === 55).map((c) => c.cmd);
    assert.deepStrictEqual(on55, ["close_tab"]);
    ok("bridge: a leaked scribe tab is reaped, never read as the user's");
    fb.srv.close();
  }
  {
    const fb = await fakeBridge(browser({ tabs: [], ownUrl: "https://accounts.google.com/signin" }));
    await assert.rejects(bridge.fetchEvents({ url: fb.url, ...quiet }), /isn't signed in/);
    assert.ok(cmds(fb.calls).includes("close_tab:999"));
    ok("bridge: signed out → clear error, our tab still closed");
    fb.srv.close();
  }
  {
    const fb = await fakeBridge(browser({ tabs: [], openDelayMs: 100 }));
    const [a, b] = await Promise.all([bridge.fetchEvents({ url: fb.url, ...quiet }), bridge.fetchEvents({ url: fb.url, ...quiet })]);
    assert.strictEqual(a, b);
    assert.strictEqual(fb.calls.filter((c) => c.cmd === "open").length, 1);
    ok("bridge: concurrent reads share one background tab");
    fb.srv.close();
  }
  {
    // our own tab on a genuinely empty day: no tiles ever, but the title says today
    const fb = await fakeBridge(browser({ tabs: [], ownTiles: [] }));
    const events = await bridge.fetchEvents({ url: fb.url, ...quiet, ownTabWaitMs: 300 });
    assert.deepStrictEqual(events, []);
    assert.ok(cmds(fb.calls).includes("close_tab:999"));
    ok("bridge: empty day → no events (not an error), tab closed");
    fb.srv.close();
  }
  {
    // our tab never reaches today's view: retried as transient, then a clear error
    const fb = await fakeBridge(browser({ tabs: [], ownTiles: [], ownTitle: "Org - Calendar" }));
    const err = await bridge.fetchEvents({ url: fb.url, ...quiet, ownTabWaitMs: 100 }).catch((e) => e);
    assert.ok(/didn't load today/.test(err.message), err.message);
    assert.strictEqual(fb.calls.filter((c) => c.cmd === "open").length, fb.calls.filter((c) => c.cmd === "close_tab").length);
    ok("bridge: page never shows today → clear error, every opened tab closed");
    fb.srv.close();
  }
  {
    const fb = await fakeBridge(browser({ tabs: [{ tab_id: USER_TAB_ID, url: "https://calendar.google.com/", title: WEEK_TITLE, tiles: TODAY_TILES }] }));
    await bridge.fetchEvents({ url: fb.url, token: "sekrit-token", ...quiet });
    assert.ok(fb.calls.every((c) => c.path === "/k/sekrit-token/cmd"));
    fb.srv.close();
    // bridge gone entirely: fails within budget, and the token never leaks
    const t0 = Date.now();
    const err = await bridge.fetchEvents({ url: fb.url, token: "sekrit-token", ...quiet, timeoutSec: 2 }).catch((e) => e);
    assert.ok(err instanceof Error && /unreachable|timed out/.test(err.message), String(err));
    assert.ok(!err.message.includes("sekrit"), err.message);
    assert.ok(Date.now() - t0 < 3000);
    ok("bridge: token rides the path, never the error; bridge down fails fast");
  }
}

bridgeTests()
  .then(() => {
    console.log(`\n${n} passed`);
    fs.rmSync(process.env.SCRIBE_DATA, { recursive: true, force: true });
  })
  .catch((e) => {
    console.error("FAIL:", e);
    process.exit(1);
  });
