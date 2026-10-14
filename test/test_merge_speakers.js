// Diarization scrap folding (node test/test_merge_speakers.js).
// Shape of the 2026-10-14 1:1: one remote voice came back as 10 clusters.
const assert = require("assert");
const { mergeFragments } = require("../server/merge-speakers");

// fake embeddings: a cluster's "voice" is its first turn's v
const embed = (ts) => (ts[0].v ? Float32Array.from(ts[0].v) : null);
const A = [1, 0, 0], A2 = [0.9, 0.3, 0], B = [0, 1, 0], NOISE = [0, 0, 1];

// one person: big cluster, a 44 s split-off of the same voice, a 2 s beep
let out = mergeFragments(
  [
    { start: 0, end: 800, speaker: 2, v: A },
    { start: 800, end: 844, speaker: 3, v: A2 },
    { start: 900, end: 902, speaker: 7, v: NOISE },
    { start: 902, end: 1700, speaker: 2, v: A },
  ],
  embed
);
assert.deepStrictEqual([...new Set(out.map((t) => t.speaker))], [2], "1:1 call is one remote voice");

// two people stay two, even when one only talks 40 s
out = mergeFragments(
  [
    { start: 0, end: 500, speaker: 0, v: A },
    { start: 500, end: 540, speaker: 1, v: B },
    { start: 540, end: 541, speaker: 5, v: null }, // too short to embed
  ],
  embed
);
assert.deepStrictEqual(out.map((t) => t.speaker), [0, 1, 1], "distinct voices kept, scrap goes to its neighbour");
console.log("ok");
