// bridge-peek — what the scribe sees in your calendar right now, read out of
// your real Chrome through the clawd-browser bridge. Read-only.
//
//   node tools/bridge-peek.mjs            # the pick + runners-up
//   node tools/bridge-peek.mjs --all      # every event read
//
// Uses calendar.bridge from data/config.json (default http://127.0.0.1:8765).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const bridge = require(path.join(HERE, "..", "server", "calendar-bridge.js"));
const { rankCandidates } = require(path.join(HERE, "..", "server", "calendar.js"));

let cal = {};
try {
  cal = JSON.parse(fs.readFileSync(path.join(HERE, "..", "data", "config.json"), "utf8")).calendar || {};
} catch {}

const t0 = Date.now();
try {
  const events = await bridge.fetchEvents(cal.bridge || {});
  const ranked = rankCandidates(events, Date.now(), (cal.lookaheadMin ?? 10) * 60e3);
  const out = { ms: Date.now() - t0, pick: ranked[0] || null, others: ranked.slice(1, 5) };
  if (process.argv.includes("--all")) out.events = events;
  console.log(JSON.stringify(out, null, 2));
} catch (e) {
  console.log(JSON.stringify({ ms: Date.now() - t0, error: e.message }));
  process.exit(1);
}
