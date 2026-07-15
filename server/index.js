// clawd-scribe daemon — HTTP API + WebSocket + static web UI, all on localhost.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { WebSocketServer } = require("ws");

const store = require("./store");
const configMod = require("./config");
const { Recorder } = require("./recorder");
const { generateNotes, suggestTitle } = require("./summarize");
const { diarizeMeeting, modelsAvailable } = require("./diarize");
const { Watcher } = require("./watcher");

const config = configMod.load();
const WEB_DIR = path.join(__dirname, "..", "web");

let recorder = null; // active Recorder or null
let watcher = null; // active Watcher or null
let watcherStatus = null; // last watcher status, so reloads can re-show the badge
let activeMeeting = null;

// --- WebSocket broadcast ---
let wss;
function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

// --- recording control ---
function startRecording(title) {
  if (recorder) throw new Error("already recording");
  const meeting = store.createMeeting(title);
  activeMeeting = meeting;
  recorder = new Recorder(meeting, config, store);

  recorder.on("segment", (segment) =>
    broadcast({ type: "segment", meetingId: meeting.id, segment })
  );
  recorder.on("level", (rms) => broadcast({ type: "level", rms }));
  recorder.on("error", (e) => {
    console.error("[recorder]", e.message);
    broadcast({ type: "recError", message: e.message });
  });
  recorder.on("helperLog", (msg) => {
    console.error("[audiocap]", msg.event, msg.detail || "");
    if (msg.event === "warn") broadcast({ type: "recError", message: `capture warning: ${msg.detail}` });
  });
  recorder.on("dead", () =>
    handleCaptureDead(meeting).catch((e) => console.error("[watchdog]", e.message))
  );
  recorder.on("helperExit", (code) => {
    console.error("[audiocap] exited unexpectedly, code", code);
    broadcast({ type: "recError", message: `audio capture exited (code ${code})` });
    stopRecording().catch(() => {});
  });

  recorder.start();

  if (config.watcher.enabled && fs.existsSync(Watcher.binPath())) {
    watcher = new Watcher(meeting, config, store, recorder.startTime);
    watcher.on("status", (s) => {
      console.error("[meetwatch]", s.watching ? `watching: ${s.title}` : "no meeting window");
      watcherStatus = s;
      broadcast({ type: "watcher", ...s });
    });
    watcher.on("frame", (frame) => broadcast({ type: "watcherFrame", frame }));
    watcher.start();
  }

  broadcast({ type: "status", recording: true, meeting });
  return meeting;
}

async function stopRecording() {
  if (!recorder) return null;
  const rec = recorder;
  const meeting = activeMeeting;
  recorder = null;
  activeMeeting = null;
  broadcast({ type: "status", recording: false, meeting: null, finalizing: meeting.id });
  if (watcher) {
    try {
      await watcher.stop(); // writes vision.json before diarization fuses it
    } catch (e) {
      console.error("[meetwatch]", e.message);
    }
    watcher = null;
    watcherStatus = null;
    broadcast({ type: "watcher", watching: false });
  }
  const duration = await rec.stop();
  const meta = store.getMeta(meeting.id);
  meta.endedAt = new Date().toISOString();
  meta.durationSec = duration;
  meta.status = "done";
  store.saveMeta(meta);
  broadcast({ type: "meetingDone", meeting: meta });
  const willDiarize = config.diarization.auto && config.keepAudio && modelsAvailable(config);
  if (config.diarization.auto && config.keepAudio) {
    if (willDiarize) {
      // retitle runs *after* diarization so it has named speakers + roster to work with
      runDiarize(meta.id).catch((e) => console.error("[diarize]", e.message));
    } else {
      console.error("[diarize] skipped — models not found at configured paths (see data/config.json)");
    }
  }
  // auto-name the meeting if the user never gave it a real title; when diarization
  // is running, autoRetitle() is triggered from runDiarize once names are known.
  if (!willDiarize && isGenericTitle(meta.title) && store.getTranscript(meta.id).length) {
    runRetitle(meta.id).catch((e) => console.error("[retitle]", e.message));
  }
  return meta;
}

// --- capture watchdog: dead audio → relaunch the whole daemon ---
// macOS can silently revoke the daemon's mic/system-audio grant while it runs
// for days (System Settings still shows the toggles ON); respawning audiocap
// doesn't help because TCC attributes the grant to the daemon, so the only
// cure is a fresh launch of the app. The daemon restarts itself and resumes
// the recording on boot, capped so a genuinely revoked permission can't loop.
const RESUME_PATH = path.join(__dirname, "..", "data", "tmp", "resume.json");
const MAX_CAPTURE_RESTARTS = 2;

function readResumeMarker() {
  try {
    const m = JSON.parse(fs.readFileSync(RESUME_PATH, "utf8"));
    if (Date.now() - new Date(m.at).getTime() < 3 * 60 * 1000) return m;
  } catch {}
  return null;
}

async function handleCaptureDead(meeting) {
  const attempts = (readResumeMarker() || {}).attempts || 0;
  console.error(`[watchdog] audio capture dead, restart attempt ${attempts + 1}`);
  const title = meeting.title;
  await stopRecording();
  if (attempts >= MAX_CAPTURE_RESTARTS) {
    try { fs.unlinkSync(RESUME_PATH); } catch {}
    broadcast({
      type: "recError",
      message:
        "no audio even after restarting twice — check Microphone and Screen & System Audio Recording in System Settings, then quit and reopen Clawd Scribe",
    });
    return;
  }
  broadcast({
    type: "recError",
    message: "no audio coming in (stale macOS permission?) — restarting Clawd Scribe, recording resumes in ~15s",
  });
  fs.mkdirSync(path.dirname(RESUME_PATH), { recursive: true });
  fs.writeFileSync(RESUME_PATH, JSON.stringify({ title, at: new Date().toISOString(), attempts: attempts + 1 }));
  // free the port so the launcher starts a fresh daemon instead of just
  // opening the UI, then relaunch through launchd for clean TCC attribution
  server.close();
  spawn("open", ["-a", "Clawd Scribe"], { detached: true, stdio: "ignore" }).unref();
  setTimeout(() => process.exit(0), 500);
}

function resumeAfterRestart() {
  const m = readResumeMarker();
  if (!m) {
    try { fs.unlinkSync(RESUME_PATH); } catch {} // stale marker, if any
    return;
  }
  console.error(`[watchdog] daemon restarted — resuming recording (attempt ${m.attempts})`);
  try {
    startRecording(m.title);
  } catch (e) {
    return console.error("[watchdog]", e.message);
  }
  // only a healthy stream clears the marker, so a still-dead capture keeps
  // its attempt count and handleCaptureDead can give up at the cap
  setTimeout(() => {
    if (recorder && recorder.pcmBytes > 0) {
      try { fs.unlinkSync(RESUME_PATH); } catch {}
      broadcast({ type: "recError", message: "recording resumed — audio is flowing again" });
    }
  }, 15000);
}

// --- diarization ---
const diarizing = new Set();
async function runDiarize(id) {
  if (diarizing.has(id)) throw new Error("already identifying speakers");
  diarizing.add(id);
  broadcast({ type: "diarizeStart", meetingId: id });
  try {
    const result = await diarizeMeeting(id, store, config);
    broadcast({
      type: "diarizeDone",
      meetingId: id,
      speakerCount: result.speakerCount,
      autoNames: result.autoNames || {},
    });
    // now that speakers are named, auto-name the meeting if still untitled
    const meta = store.getMeta(id);
    if (isGenericTitle(meta.title) && store.getTranscript(id).length) {
      runRetitle(id).catch((e) => console.error("[retitle]", e.message));
    }
  } catch (e) {
    broadcast({ type: "diarizeError", meetingId: id, message: e.message });
    throw e;
  } finally {
    diarizing.delete(id);
  }
}

// --- notes generation ---
const generating = new Set();
async function runGenerate(id) {
  if (generating.has(id)) throw new Error("already generating notes for this meeting");
  const m = store.getMeeting(id);
  if (!m.transcript.length && !m.notes.trim()) throw new Error("nothing to summarize yet");
  generating.add(id);
  broadcast({ type: "notesStart", meetingId: id });
  try {
    const md = await generateNotes(
      {
        transcript: m.transcript,
        userNotes: m.notes,
        title: m.meta.title,
        speakers: m.meta.speakers || {},
      },
      config,
      (tok) => broadcast({ type: "notesToken", meetingId: id, token: tok })
    );
    store.writeText(id, "summary.md", md);
    broadcast({ type: "notesDone", meetingId: id, summary: md });
  } catch (e) {
    broadcast({ type: "notesError", meetingId: id, message: e.message });
    throw e;
  } finally {
    generating.delete(id);
  }
}

// --- AI title naming ---
const retitling = new Set();
// A title is "generic" if the user never named it — the default is "Meeting <date>".
function isGenericTitle(title) {
  return !title || /^meeting\b/i.test(title.trim());
}
async function runRetitle(id) {
  if (retitling.has(id)) throw new Error("already naming this meeting");
  const m = store.getMeeting(id);
  if (!m.transcript.length && !m.notes.trim()) throw new Error("nothing to name yet");
  retitling.add(id);
  try {
    // who is this meeting with? named speakers (skip generic "Speaker N") + faces
    // read off the meeting window by the vision watcher.
    const speakers = m.meta.speakers || {};
    const namedSpeakers = Object.entries(speakers)
      .filter(([k, v]) => k !== "me" && v && !/^speaker\s*\d+$/i.test(v.trim()))
      .map(([, v]) => v.trim());
    const rosterNames = ((m.vision && m.vision.roster) || [])
      .map((r) => r.name)
      .filter(Boolean);
    const participants = [...new Set([...namedSpeakers, ...rosterNames])];
    const title = await suggestTitle(
      { transcript: m.transcript, userNotes: m.notes, speakers, participants },
      config
    );
    if (!title) throw new Error("model returned an empty title");
    const meta = store.getMeta(id);
    meta.title = title;
    store.saveMeta(meta);
    broadcast({ type: "titleUpdated", meetingId: id, title });
    return title;
  } finally {
    retitling.delete(id);
  }
}

// --- HTTP helpers ---
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (d) => {
      data += d;
      if (data.length > 5e6) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".wav": "audio/wav",
};

function serveStatic(res, filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404);
    return res.end("not found");
  }
  res.writeHead(200, { "content-type": MIME[path.extname(filePath)] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
}

// --- server ---
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);

  try {
    if (parts[0] === "api") {
      // GET /api/status
      if (req.method === "GET" && parts[1] === "status") {
        return json(res, 200, {
          recording: !!recorder,
          meeting: activeMeeting,
          watcher: watcherStatus,
          generating: [...generating],
          config: { llm: config.llm, whisperModel: config.whisperModel },
        });
      }
      // GET /api/watcher/debug — live vision-pipeline state for the debug UI
      if (req.method === "GET" && parts[1] === "watcher" && parts[2] === "debug") {
        return json(res, 200, watcher ? watcher.snapshot() : { active: false, recording: !!recorder });
      }
      // GET /api/watcher/frame.jpg — latest captured frame, drawn under the debug overlays
      if (req.method === "GET" && parts[1] === "watcher" && parts[2] === "frame.jpg") {
        if (!watcher || !watcher.lastFrameJpg) return json(res, 404, { error: "no frame" });
        res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "no-store" });
        return res.end(watcher.lastFrameJpg);
      }
      // POST /api/record/start  { title }
      if (req.method === "POST" && parts[1] === "record" && parts[2] === "start") {
        const body = await readBody(req);
        return json(res, 200, startRecording(body.title));
      }
      // POST /api/record/stop
      if (req.method === "POST" && parts[1] === "record" && parts[2] === "stop") {
        return json(res, 200, (await stopRecording()) || {});
      }
      // GET /api/meetings
      if (req.method === "GET" && parts[1] === "meetings" && !parts[2]) {
        return json(res, 200, store.listMeetings());
      }
      // GET /api/search?q=...
      if (req.method === "GET" && parts[1] === "search") {
        return json(res, 200, store.searchMeetings(url.searchParams.get("q") || ""));
      }
      // GET /api/mcp — absolute paths the "Connect Claude" panel needs to build
      // copy-pasteable install snippets (node path matters: GUI apps like Claude
      // Desktop don't have homebrew on PATH).
      if (req.method === "GET" && parts[1] === "mcp") {
        return json(res, 200, {
          serverPath: path.join(__dirname, "..", "mcp", "server.js"),
          nodePath: process.execPath,
        });
      }
      if (parts[1] === "meetings" && parts[2]) {
        const id = parts[2];
        // GET /api/meetings/:id
        if (req.method === "GET" && !parts[3]) {
          return json(res, 200, store.getMeeting(id));
        }
        // GET /api/meetings/:id/audio
        if (req.method === "GET" && parts[3] === "audio") {
          return serveStatic(res, path.join(store.meetingDir(id), "audio.wav"));
        }
        // GET /api/meetings/:id/faces/<n>.jpg
        if (req.method === "GET" && parts[3] === "faces" && /^\d+\.jpg$/.test(parts[4] || "")) {
          return serveStatic(res, path.join(store.meetingDir(id), "faces", parts[4]));
        }
        // PUT /api/meetings/:id/notes  { notes }
        if (req.method === "PUT" && parts[3] === "notes") {
          const body = await readBody(req);
          store.writeText(id, "notes.md", body.notes || "");
          return json(res, 200, { ok: true });
        }
        // PUT /api/meetings/:id/title  { title }
        if (req.method === "PUT" && parts[3] === "title") {
          const body = await readBody(req);
          const meta = store.getMeta(id);
          meta.title = String(body.title || "").slice(0, 200) || meta.title;
          store.saveMeta(meta);
          return json(res, 200, meta);
        }
        // POST /api/meetings/:id/generate
        if (req.method === "POST" && parts[3] === "generate") {
          runGenerate(id).catch((e) => console.error("[generate]", e.message));
          return json(res, 202, { ok: true });
        }
        // POST /api/meetings/:id/retitle — AI-name the meeting from its transcript
        if (req.method === "POST" && parts[3] === "retitle") {
          return json(res, 200, { title: await runRetitle(id) });
        }
        // POST /api/meetings/:id/diarize
        if (req.method === "POST" && parts[3] === "diarize") {
          runDiarize(id).catch((e) => console.error("[diarize]", e.message));
          return json(res, 202, { ok: true });
        }
        // PUT /api/meetings/:id/speakers  { speakers: {"1": "Tom", "me": "Alice"} }
        if (req.method === "PUT" && parts[3] === "speakers") {
          const body = await readBody(req);
          const meta = store.getMeta(id);
          meta.speakers = { ...(meta.speakers || {}) };
          for (const [k, v] of Object.entries(body.speakers || {})) {
            if (!/^(me|\d+)$/.test(k)) continue;
            meta.speakers[k] = String(v).slice(0, 80);
          }
          store.saveMeta(meta);
          broadcast({ type: "speakersUpdated", meetingId: id, speakers: meta.speakers });
          return json(res, 200, meta);
        }
        // DELETE /api/meetings/:id
        if (req.method === "DELETE" && !parts[3]) {
          if (activeMeeting && activeMeeting.id === id) throw new Error("meeting is recording");
          store.deleteMeeting(id);
          return json(res, 200, { ok: true });
        }
      }
      return json(res, 404, { error: "not found" });
    }

    // static UI
    const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const resolved = path.normalize(path.join(WEB_DIR, file));
    if (!resolved.startsWith(WEB_DIR)) {
      res.writeHead(403);
      return res.end();
    }
    return serveStatic(res, resolved);
  } catch (e) {
    return json(res, 400, { error: e.message });
  }
});

wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (sock) => {
  sock.send(
    JSON.stringify({
      type: "status",
      recording: !!recorder,
      meeting: activeMeeting,
      watcher: watcherStatus,
    })
  );
});

process.on("SIGINT", async () => {
  if (recorder) await stopRecording();
  process.exit(0);
});

store.ensureDirs();
server.listen(config.port, "127.0.0.1", () => {
  console.log(`clawd-scribe listening on http://localhost:${config.port}`);
  console.log(`whisper model: ${config.whisperModel}`);
  console.log(`llm: ${config.llm.model} @ ${config.llm.url}`);
  resumeAfterRestart();
});
