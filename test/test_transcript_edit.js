// Transcript line delete + undo (node test/test_transcript_edit.js).
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.SCRIBE_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-tx-"));
const store = require("../server/store");

const m = store.createMeeting("t");
const segs = [
  { t: 0, speaker: "me", text: "testing testing" },
  { t: 0, speaker: "them", text: "can you hear me" },
  { t: 12, speaker: "them", text: "ok let's start" },
  { t: 24, speaker: "me", text: "thanks all, bye" },
];
for (const s of segs) store.appendTranscript(m.id, s);

// same t on both channels: only the matching speaker's line goes
let r = store.deleteSegment(m.id, { t: 0, speaker: "them", text: "can you hear me" });
assert.strictEqual(r.index, 1);
assert.deepStrictEqual(store.getTranscript(m.id).map((s) => s.text), ["testing testing", "ok let's start", "thanks all, bye"]);
console.log("ok: deletes the matching line only (same t, other channel kept)");

assert.strictEqual(store.deleteSegment(m.id, { t: 0, speaker: "them", text: "can you hear me" }), null);
assert.strictEqual(store.deleteSegment(m.id, { t: 12, speaker: "me", text: "ok let's start" }), null);
console.log("ok: a missing or mismatched line deletes nothing");

// a line arrives (recording) between delete and undo: undo still lands right
store.appendTranscript(m.id, { t: 36, speaker: "them", text: "late line" });
store.restoreSegment(m.id, r.index, r.segment);
assert.deepStrictEqual(store.getTranscript(m.id).map((s) => s.text), ["testing testing", "can you hear me", "ok let's start", "thanks all, bye", "late line"]);
store.restoreSegment(m.id, r.index, r.segment);
assert.strictEqual(store.getTranscript(m.id).length, 5);
console.log("ok: undo puts it back in place, and a double undo doesn't duplicate");

// diarized segments (numeric speaker, end) and legacy ones without a speaker
store.appendTranscript(m.id, { t: 48, speaker: 2, end: 55, text: "numbered" });
store.appendTranscript(m.id, { t: 60, text: "no speaker" });
assert.ok(store.deleteSegment(m.id, { t: 48, speaker: 2, text: "numbered" }));
assert.ok(store.deleteSegment(m.id, { t: 60, text: "no speaker" }));
console.log("ok: numeric speakers and speakerless segments");

r = store.restoreSegment(m.id, 999, { t: 99, text: "end" });
assert.strictEqual(store.getTranscript(m.id).at(-1).text, "end");
console.log("ok: restore index is clamped");

fs.rmSync(process.env.SCRIBE_DATA, { recursive: true, force: true });
console.log("\nALL TRANSCRIPT EDIT TESTS PASSED");
