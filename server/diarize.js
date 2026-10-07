// Speaker diarization: clusters the remote ("them") side of a meeting into
// Speaker 1/2/3… using sherpa-onnx (pyannote segmentation + speaker
// embeddings, all local). Runs in a child process, then labels transcript
// segments by dominant time-overlap with the diarized turns.
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { isNameVariant, looksLikeName } = require("./watcher");

function modelsAvailable(config) {
  return (
    fs.existsSync(config.diarization.segModel) &&
    fs.existsSync(config.diarization.embModel)
  );
}

function runWorker(wavPath, config) {
  return new Promise((resolve, reject) => {
    const workerCfg = {
      wavPath,
      channel: "right", // system audio = everyone who isn't you
      segModel: config.diarization.segModel,
      embModel: config.diarization.embModel,
      threshold: config.diarization.threshold,
      minDurationOn: config.diarization.minDurationOn,
      minDurationOff: config.diarization.minDurationOff,
    };
    const proc = spawn(
      process.execPath,
      [path.join(__dirname, "diarize-worker.js"), JSON.stringify(workerCfg)],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (err += d));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`diarize worker: ${err.trim() || "exit " + code}`));
      try {
        resolve(JSON.parse(out));
      } catch (e) {
        reject(new Error("diarize worker returned invalid JSON"));
      }
    });
  });
}

function overlap(a0, a1, b0, b1) {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

// Assign each "them" transcript segment the diarized speaker with the most
// overlapping talk time. Returns the set of speaker ids actually used.
function labelSegments(segments, turns) {
  const used = new Set();
  for (const seg of segments) {
    if (seg.who === "me") continue;
    const t0 = seg.t;
    const t1 = seg.end != null ? seg.end : seg.t + 12;
    const bySpeaker = new Map();
    for (const turn of turns) {
      const ov = overlap(t0, t1, turn.start, turn.end);
      if (ov > 0) bySpeaker.set(turn.speaker, (bySpeaker.get(turn.speaker) || 0) + ov);
    }
    if (bySpeaker.size) {
      const best = [...bySpeaker.entries()].sort((a, b) => b[1] - a[1])[0][0];
      seg.speaker = best + 1; // display ids are 1-based
      used.add(best + 1);
    }
  }
  return used;
}

// Which on-screen names are YOU. Your voice is on the mic channel, so your
// tile lights up while you talk and — with crosstalk — overlaps remote voice
// clusters; on 2026-10-06 a 13-minute remote voice was named "Austin
// Griffith" that way. A tile whose highlight time is almost all mic speech is
// the user's own; config.diarization.selfNames pins it explicitly.
function selfNameKeys(vision, segments, config) {
  const norm = (s) => s.trim().toLowerCase();
  const keys = new Set(((config && config.diarization && config.diarization.selfNames) || []).map(norm));
  const mine = (segments || []).filter((s) => s.who === "me").map((s) => [s.t, s.end != null ? s.end : s.t + 12]);
  const total = new Map();
  const onMic = new Map();
  for (const iv of vision.speaking || []) {
    total.set(iv.name, (total.get(iv.name) || 0) + (iv.end - iv.start));
    let ov = 0;
    for (const [a, b] of mine) ov += overlap(iv.start, iv.end, a, b);
    onMic.set(iv.name, (onMic.get(iv.name) || 0) + ov);
  }
  for (const [name, sec] of total) {
    if (sec >= 30 && onMic.get(name) / sec >= 0.8) keys.add(norm(name));
  }
  // OCR misreads of a self name ("Austin Grithth") are you too. Same first
  // word counts: at worst another Austin stays "Speaker N", never misnamed.
  const first = (k) => k.split(" ")[0];
  const self = [...keys];
  const names = [...(vision.speaking || []), ...(vision.roster || [])].map((x) => norm(x.name));
  for (const k of names) {
    if (self.some((s) => isNameVariant(k, s) || (first(s).length >= 3 && first(k) === first(s)))) keys.add(k);
  }
  return keys;
}

// Fuse voice clusters with the watcher's visual speaking timeline: if voice
// cluster N's talk turns line up with "Tom Chen's tile was highlighted",
// then speaker N is Tom Chen. Never overrides a name the user typed. A wrong
// name is worse than "Speaker N" (Austin, 10-07: "I cannot show a transcript
// with the wrong people saying things"), so the bar is high, and an earlier
// auto-name the evidence no longer supports goes back to "Speaker N".
function autoNameSpeakers(meta, turns, vision, segments, config) {
  meta.autoNamed = meta.autoNamed || {};
  const assigned = {};
  const self = vision ? selfNameKeys(vision, segments, config) : new Set();
  // only names seen under a face are candidates: a shared screen puts file
  // names and headings inside the highlight too ("v In this file", 10-07).
  // Camera-off people stay "Speaker N" — unnamed beats misnamed.
  const rosterNames = new Set(
    ((vision && vision.roster) || []).filter((r) => r.face || r.faceUnverified).map((r) => r.name.toLowerCase())
  );
  const votes = new Map(); // sid -> Map(name -> overlap seconds)
  for (const turn of turns) {
    const sid = turn.speaker + 1;
    for (const iv of (vision && vision.speaking) || []) {
      if (self.has(iv.name.trim().toLowerCase())) continue;
      const ov = overlap(turn.start, turn.end, iv.start, iv.end);
      if (ov <= 0) continue;
      if (!votes.has(sid)) votes.set(sid, new Map());
      const m = votes.get(sid);
      m.set(iv.name, (m.get(iv.name) || 0) + ov);
    }
  }
  // talk time per cluster: a name must explain a real share of it, not a
  // few seconds of crosstalk
  const talk = new Map();
  for (const t of turns) talk.set(t.speaker + 1, (talk.get(t.speaker + 1) || 0) + (t.end - t.start));
  // only voices that own transcript lines get names
  const shown = new Set((segments || []).map((s) => s.speaker).filter((x) => typeof x === "number"));
  const picks = [];
  for (const [sid, m] of votes) {
    if (shown.size && !shown.has(sid)) continue;
    const ranked = [...m.entries()].sort((a, b) => b[1] - a[1]);
    const [name, sec] = ranked[0];
    const second = ranked[1] ? ranked[1][1] : 0;
    if (sec < 15 || sec < second * 2 || sec < (talk.get(sid) || 0) * 0.15) continue;
    if (!rosterNames.has(name.toLowerCase())) continue;
    if (!looksLikeName(name) || /['’]s scr|\bscreen\b/i.test(name)) continue; // UI text, "Pierre's screen" share tiles
    picks.push({ sid, name, sec });
  }
  // one name, one voice: a highlight stuck on a presenter's tile otherwise
  // names every cluster after them
  picks.sort((a, b) => b.sec - a.sec);
  const taken = new Set();
  for (const { sid, name } of picks) {
    if (taken.has(name.toLowerCase())) continue;
    taken.add(name.toLowerCase());
    const current = meta.speakers[sid];
    const isDefault = !current || /^Speaker \d+$/.test(current);
    const wasAuto = meta.autoNamed[sid] && meta.autoNamed[sid] === current;
    if (isDefault || wasAuto) {
      meta.speakers[sid] = name;
      meta.autoNamed[sid] = name;
      assigned[sid] = name;
    }
  }
  for (const [sid, name] of Object.entries(meta.autoNamed)) {
    if (assigned[sid]) continue;
    if (meta.speakers[sid] === name) meta.speakers[sid] = `Speaker ${sid}`;
    delete meta.autoNamed[sid];
  }
  return assigned;
}

async function diarizeMeeting(id, store, config) {
  const wavPath = path.join(store.meetingDir(id), "audio.wav");
  if (!fs.existsSync(wavPath)) throw new Error("no audio.wav for this meeting");
  if (!modelsAvailable(config)) {
    throw new Error("diarization models missing — see README (data/models/)");
  }

  const turns = await runWorker(wavPath, config);
  store.writeText(id, "turns.json", JSON.stringify(turns, null, 1));
  const segments = store.getTranscript(id);
  const used = labelSegments(segments, turns);
  store.writeText(id, "transcript.json", JSON.stringify(segments, null, 1));

  const meta = store.getMeta(id);
  meta.speakers = meta.speakers || {};
  for (const sid of used) {
    if (!meta.speakers[sid]) meta.speakers[sid] = `Speaker ${sid}`;
  }

  let autoNames = {};
  let vision = null;
  const visionPath = path.join(store.meetingDir(id), "vision.json");
  if (fs.existsSync(visionPath)) {
    try {
      vision = JSON.parse(fs.readFileSync(visionPath, "utf8"));
    } catch (e) {
      console.error("[fusion]", e.message);
    }
  }
  autoNames = autoNameSpeakers(meta, turns, vision, segments, config);

  meta.diarizedAt = new Date().toISOString();
  store.saveMeta(meta);
  return { meta, segments, turnCount: turns.length, speakerCount: used.size, autoNames };
}

module.exports = { diarizeMeeting, modelsAvailable, autoNameSpeakers, selfNameKeys };
