// Fold diarization fragments into real voices. Measured on real calls with
// TitaNet: one person split in two scores 0.80-0.91 cosine, two different
// people at most 0.36. Short clusters embed noisily, so they get a lower bar.
const SAME_VOICE = 0.6;
const SAME_VOICE_SHORT = 0.45; // either side under SHORT_SEC
const SHORT_SEC = 30;
const SCRAP_SEC = 8; // still alone and this short: not a person, give it to a neighbour

function cosine(a, b) {
  let s = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) (s += a[i] * b[i]), (na += a[i] * a[i]), (nb += b[i] * b[i]);
  return s / Math.sqrt(na * nb || 1);
}

// turns: [{start, end, speaker}]; embed(turns) -> Float32Array | null.
// The surviving id of a merge is the bigger cluster's, so ids stay stable.
function mergeFragments(turns, embed) {
  turns = turns.map((t) => ({ ...t }));
  const groups = () => {
    const m = new Map();
    for (const t of turns) {
      if (!m.has(t.speaker)) m.set(t.speaker, []);
      m.get(t.speaker).push(t);
    }
    return m;
  };
  const dur = (ts) => ts.reduce((n, t) => n + t.end - t.start, 0);
  const emb = new Map();
  for (const [k, ts] of groups()) emb.set(k, embed(ts));

  for (;;) {
    const g = groups();
    let best = null;
    const ks = [...g.keys()];
    for (let i = 0; i < ks.length; i++) {
      for (let j = i + 1; j < ks.length; j++) {
        const [a, b] = [ks[i], ks[j]];
        if (!emb.get(a) || !emb.get(b)) continue;
        const sim = cosine(emb.get(a), emb.get(b));
        const bar = Math.min(dur(g.get(a)), dur(g.get(b))) < SHORT_SEC ? SAME_VOICE_SHORT : SAME_VOICE;
        if (sim >= bar && (!best || sim > best.sim)) best = { a, b, sim };
      }
    }
    if (!best) break;
    const [keep, drop] = dur(g.get(best.a)) >= dur(g.get(best.b)) ? [best.a, best.b] : [best.b, best.a];
    for (const t of g.get(drop)) t.speaker = keep;
    emb.set(keep, embed(groups().get(keep)));
    emb.delete(drop);
  }

  // leftover scraps (beeps, coughs, unembeddable blips) go to the nearest
  // real voice in time
  const g = groups();
  const real = turns.filter((t) => dur(g.get(t.speaker)) >= SCRAP_SEC);
  if (real.length) {
    for (const t of turns) {
      if (dur(g.get(t.speaker)) >= SCRAP_SEC) continue;
      let near = null, gap = Infinity;
      for (const r of real) {
        const d = Math.max(0, r.start - t.end, t.start - r.end);
        if (d < gap) (gap = d), (near = r);
      }
      t.speaker = near.speaker;
    }
  }
  return turns;
}

module.exports = { mergeFragments, cosine };
