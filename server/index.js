// muesli daemon — HTTP API + WebSocket + static web UI, all on localhost.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const store = require("./store");
const configMod = require("./config");
const { Recorder } = require("./recorder");
const { generateNotes } = require("./summarize");
const { diarizeMeeting, modelsAvailable } = require("./diarize");
const { Watcher } = require("./watcher");

const config = configMod.load();
const WEB_DIR = path.join(__dirname, "..", "web");

let recorder = null; // active Recorder or null
let watcher = null; // active Watcher or null
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
  recorder.on("helperLog", (msg) => console.error("[audiocap]", msg.event, msg.detail || ""));
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
      broadcast({ type: "watcher", ...s });
    });
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
    broadcast({ type: "watcher", watching: false });
  }
  const duration = await rec.stop();
  const meta = store.getMeta(meeting.id);
  meta.endedAt = new Date().toISOString();
  meta.durationSec = duration;
  meta.status = "done";
  store.saveMeta(meta);
  broadcast({ type: "meetingDone", meeting: meta });
  if (config.diarization.auto && config.keepAudio && modelsAvailable(config)) {
    runDiarize(meta.id).catch((e) => console.error("[diarize]", e.message));
  }
  return meta;
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
          generating: [...generating],
          config: { llm: config.llm, whisperModel: config.whisperModel },
        });
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
    JSON.stringify({ type: "status", recording: !!recorder, meeting: activeMeeting })
  );
});

process.on("SIGINT", async () => {
  if (recorder) await stopRecording();
  process.exit(0);
});

store.ensureDirs();
server.listen(config.port, "127.0.0.1", () => {
  console.log(`muesli listening on http://localhost:${config.port}`);
  console.log(`whisper model: ${config.whisperModel}`);
  console.log(`llm: ${config.llm.model} @ ${config.llm.url}`);
});
