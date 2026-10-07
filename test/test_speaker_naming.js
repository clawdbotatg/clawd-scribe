// Speaker auto-naming + face pairing (node test/test_speaker_naming.js).
// Shapes come from the 2026-10-06 "AL x Builder" call, where a remote voice
// was named after the user and two of three tile photos were someone else.
const assert = require("assert");
const { autoNameSpeakers } = require("../server/diarize");
const { Watcher } = require("../server/watcher");

// --- naming -------------------------------------------------------------
// The user talks 0-400s (mic). Their tile is highlighted the whole time.
// Remote cluster 0 (Rahul) talks 100-900s, overlapping the user's crosstalk;
// Rahul's own tile barely registers. Cluster 1 (Philip) talks 900-1300s.
const segments = [];
for (let t = 0; t < 400; t += 12) segments.push({ t, end: t + 12, who: "me" });
const turns = [
  { start: 100, end: 900, speaker: 0 },
  { start: 900, end: 1300, speaker: 1 },
];
const vision = {
  roster: [{ name: "Rahul Kothari", face: "f" }, { name: "Austin Griffith", face: "f" }, { name: "Philip Krause", face: "f" }, { name: "Austin Grithth" }],
  speaking: [
    { start: 0, end: 380, name: "Austin Griffith" },
    { start: 381, end: 388, name: "Austin Grithth" },
    { start: 500, end: 502, name: "Rahul Kothari" },
    { start: 950, end: 1100, name: "Philip Krause" },
  ],
};
const meta = {
  speakers: { 1: "Austin Griffith", 2: "Speaker 2" },
  autoNamed: { 1: "Austin Griffith" }, // what the old fusion wrote
};
const got = autoNameSpeakers(meta, turns, vision, segments, {});
assert.deepStrictEqual(got, { 2: "Philip Krause" });
assert.strictEqual(meta.speakers[1], "Speaker 1");
assert.ok(!meta.autoNamed[1]);
console.log("ok: a remote voice is never named after you (auto-detected), stale wrong name reset");

// thin evidence (2 s of Rahul's tile over 800 s of talk) names nobody
assert.strictEqual(meta.speakers[1], "Speaker 1");
console.log("ok: a few seconds of highlight doesn't name a voice");

// one name, one voice: a stuck highlight on a presenter names only the
// cluster it best explains
const meta4 = { speakers: {} };
const v4 = { roster: [{ name: "Eliza", face: "f" }], speaking: [{ start: 0, end: 1300, name: "Eliza" }] };
assert.deepStrictEqual(autoNameSpeakers(meta4, turns, v4, [], {}), { 1: "Eliza" });
console.log("ok: a name goes to one voice only");

// text on a shared screen has no face under it
const meta6 = { speakers: {} };
const v6 = { roster: [{ name: "v In This File" }], speaking: [{ start: 100, end: 900, name: "v In This File" }] };
assert.deepStrictEqual(autoNameSpeakers(meta6, turns, v6, [], {}), {});
console.log("ok: shared-screen text never becomes a name");

// screen-share tiles and UI words are not people
const meta5 = { speakers: {} };
const v5 = { roster: [{ name: "Pierre's screen", face: "f" }, { name: "File", face: "f" }], speaking: [{ start: 100, end: 900, name: "Pierre's screen" }, { start: 900, end: 1300, name: "File" }] };
assert.deepStrictEqual(autoNameSpeakers(meta5, turns, v5, [], {}), {});
console.log("ok: share tiles and UI words never become names");

// explicit selfNames works with no highlight evidence at all
const meta2 = { speakers: {} };
const v2 = { roster: [{ name: "Jo Doe" }], speaking: [{ start: 100, end: 140, name: "Jo Doe" }] };
assert.deepStrictEqual(autoNameSpeakers(meta2, turns, v2, [], { diarization: { selfNames: ["jo doe"] } }), {});
console.log("ok: config selfNames excluded");

// a user-typed name is never touched
const meta3 = { speakers: { 1: "Rahul" }, autoNamed: {} };
autoNameSpeakers(meta3, turns, vision, segments, {});
assert.strictEqual(meta3.speakers[1], "Rahul");
console.log("ok: manual names survive");

// --- face pairing ---------------------------------------------------------
// Three tiles side by side, faces centered, labels at each tile's bottom-left.
const w = new Watcher({ id: "x" }, { watcher: {} }, null, Date.now());
const jpg = (who) => Buffer.from(who).toString("base64");
const tiles = [
  { name: "Rahul Kothari", x0: 0.0 },
  { name: "Philip Krause", x0: 0.28 },
  { name: "Austin Griffith", x0: 0.56 },
];
const frame = (opts = {}) => ({
  event: "frame",
  texts: tiles
    .filter((t) => !(opts.hideLabel || []).includes(t.name))
    .map((t) => ({ s: t.name, x: t.x0 + 0.01, y: 0.84, w: 0.08, h: 0.02 })),
  rects: [],
  faces: tiles.map((t) => ({
    // all three faces at the same height — the old pairing tied here
    x: t.x0 + 0.09, y: 0.35, w: 0.1, h: opts.big === t.name ? 0.4 : 0.3,
    jpg: jpg(t.name),
  })),
});
for (let i = 0; i < 5; i++) w.onFrame(frame());
// Philip's label drops out for a frame and Rahul's face is huge: must not
// hand any face to the wrong name
w.onFrame(frame({ hideLabel: ["Philip Krause"], big: "Rahul Kothari" }));
for (const t of tiles) {
  const f = w.bestFace(t.name.toLowerCase());
  assert.ok(f, `face for ${t.name}`);
  assert.strictEqual(f.jpg.toString(), t.name, `${t.name} got ${f.jpg.toString()}'s face`);
}
console.log("ok: side-by-side tiles each get their own face");

// a contested tile position yields no face rather than a wrong one
const w2 = new Watcher({ id: "y" }, { watcher: {} }, null, Date.now());
const at = { x: 0.4, y: 0.3, w: 0.1, h: 0.3 };
for (let i = 0; i < 4; i++) w2.addFace("a", { ...at, jpg: jpg("A") });
for (let i = 0; i < 5; i++) w2.addFace("b", { ...at, jpg: jpg("B") });
assert.strictEqual(w2.bestFace("a"), null);
assert.strictEqual(w2.bestFace("b").jpg.toString(), "B");
console.log("ok: contested face position goes to the name seen there most, the other gets none");
