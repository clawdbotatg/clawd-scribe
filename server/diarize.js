// Speaker diarization: clusters the remote ("them") side of a meeting into
// Speaker 1/2/3… using sherpa-onnx (pyannote segmentation + speaker
// embeddings, all local). Runs in a child process, then labels transcript
// segments by dominant time-overlap with the diarized turns.
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

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

// Fuse voice clusters with the watcher's visual speaking timeline: if voice
// cluster N's talk turns line up with "Tom Chen's tile was highlighted",
// then speaker N is Tom Chen. Never overrides a name the user typed.
function autoNameSpeakers(meta, turns, vision) {
  if (!vision || !vision.speaking || !vision.speaking.length) return {};
  const votes = new Map(); // sid -> Map(name -> overlap seconds)
  for (const turn of turns) {
    const sid = turn.speaker + 1;
    for (const iv of vision.speaking) {
      const ov = overlap(turn.start, turn.end, iv.start, iv.end);
      if (ov <= 0) continue;
      if (!votes.has(sid)) votes.set(sid, new Map());
      const m = votes.get(sid);
      m.set(iv.name, (m.get(iv.name) || 0) + ov);
    }
  }
  const assigned = {};
  meta.autoNamed = meta.autoNamed || {};
  for (const [sid, m] of votes) {
    const ranked = [...m.entries()].sort((a, b) => b[1] - a[1]);
    const [name, sec] = ranked[0];
    const second = ranked[1] ? ranked[1][1] : 0;
    if (sec < 3 || sec < second * 1.5) continue; // not confident enough
    const current = meta.speakers[sid];
    const isDefault = !current || /^Speaker \d+$/.test(current);
    const wasAuto = meta.autoNamed[sid] && meta.autoNamed[sid] === current;
    if (isDefault || wasAuto) {
      meta.speakers[sid] = name;
      meta.autoNamed[sid] = name;
      assigned[sid] = name;
    }
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
  const visionPath = path.join(store.meetingDir(id), "vision.json");
  if (fs.existsSync(visionPath)) {
    try {
      const vision = JSON.parse(fs.readFileSync(visionPath, "utf8"));
      autoNames = autoNameSpeakers(meta, turns, vision);
    } catch (e) {
      console.error("[fusion]", e.message);
    }
  }

  meta.diarizedAt = new Date().toISOString();
  store.saveMeta(meta);
  return { meta, segments, turnCount: turns.length, speakerCount: used.size, autoNames };
}

module.exports = { diarizeMeeting, modelsAvailable };
