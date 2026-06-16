// Meeting-window watcher: drives the native meetwatch helper (ScreenCaptureKit
// frame capture + local Vision OCR + highlight detection) and turns its raw
// per-frame events into:
//   - a participant roster (names seen on tiles)
//   - a "who was visually speaking when" timeline (name inside the
//     highlighted-tile rect)
// Saved as vision.json in the meeting folder; diarize.js fuses it with the
// voice clusters to auto-name speakers.
const { spawn } = require("child_process");
const { EventEmitter } = require("events");
const fs = require("fs");
const path = require("path");

// Tile labels that are UI chrome, not people.
const UI_WORDS = new Set([
  "you", "mute", "unmute", "chat", "more", "caption", "captions", "present",
  "presenting", "share", "leave", "camera", "microphone", "mic", "settings",
  "participants", "people", "message", "messages", "call", "record",
  "recording", "live", "host", "cohost", "join", "audio", "video", "speaker",
  "view", "pin", "unpin", "raise", "hand", "react", "reactions", "meeting",
  "details", "info", "activities", "controls", "fullscreen", "minimize",
  "close", "end", "stop", "back", "menu", "apps", "now", "stop sharing",
  "leave call", "end call", "meeting details", "turn on captions",
  "you're presenting",
  // Meet/Zoom panels, feedback dialogs, browser chrome
  "ask gemini", "audio settings", "video settings", "call transcript",
  "add comment", "feedback", "inbox", "older", "work", "very good",
  "very bad", "reducing noise", "return to home screen", "share v",
  "send a message", "in this call", "everyone", "no one",
]);

// OCR reads the same display name slightly differently frame to frame
// ("Sov", "SOV -", "Sov-"). Reduce each variant to a canonical key so the
// roster counts them as one person.
function normalizeName(s) {
  return s
    .trim()
    .replace(/[\s\-–—.,;:!?]+$/u, "") // trailing dashes/punct from tile edges
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function looksLikeName(s) {
  // OCR fragments often carry trailing punctuation ("tiles.") — strip it first.
  const t = s.trim().replace(/[.,;:!?]+$/, "");
  if (t.length < 2 || t.length > 40) return false;
  // display names on tiles are capitalized; all-lowercase text is UI/page copy
  if (!/\p{Lu}/u.test(t)) return false;
  if (UI_WORDS.has(t.toLowerCase())) return false;
  // Meet/Zoom display names can include parens, digits, dots, @ — e.g.
  // "Coltron (Coltron.eth)" — but never slashes, pipes, or long word runs.
  if (!/^[\p{L}][\p{L}\p{N}'’.()@\- ]*$/u.test(t)) return false;
  if ((t.match(/\p{L}/gu) || []).length < 2) return false;
  if (t.split(/\s+/).length > 4) return false;
  return true;
}

function inside(text, rect, margin = 0.02) {
  const cx = text.x + text.w / 2;
  const cy = text.y + text.h / 2;
  return (
    cx >= rect.x - margin &&
    cx <= rect.x + rect.w + margin &&
    cy >= rect.y - margin &&
    cy <= rect.y + rect.h + margin
  );
}

class Watcher extends EventEmitter {
  constructor(meeting, config, store, startTime) {
    super();
    this.meeting = meeting;
    this.config = config;
    this.store = store;
    this.startTime = startTime; // ms epoch, equals Recorder.startTime
    this.helper = null;
    this.roster = new Map(); // canonical key -> frame count
    this.nameForms = new Map(); // canonical key -> Map(display form -> count)
    this.samples = []; // {t (sec rel), name (canonical key)}
    this.faces = new Map(); // canonical key -> {votes, area, jpg (Buffer)}
    this.windowTitle = null;
    this.lineBuf = "";
    // debug instrumentation: per-frame counters + a short ring buffer of
    // compact frame summaries, surfaced by snapshot() and the "frame" event
    this.stats = { frames: 0, namedFrames: 0, rectFrames: 0, faceFrames: 0, lastFrameAt: 0 };
    this.recent = [];
    this.lastFrameJpg = null; // latest full-frame capture, served at /api/watcher/frame.jpg
  }

  static binPath() {
    return path.join(__dirname, "..", "native", "meetwatch");
  }

  start() {
    this.helper = spawn(Watcher.binPath(), [JSON.stringify(this.config.watcher)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.helper.stdout.on("data", (d) => {
      this.lineBuf += d.toString();
      const lines = this.lineBuf.split("\n");
      this.lineBuf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          this.onEvent(JSON.parse(line));
        } catch {}
      }
    });
    this.helper.stderr.on("data", () => {});
    this.helper.on("error", (e) => this.emit("status", { watching: false, error: e.message }));
  }

  onEvent(msg) {
    if (msg.event === "watching") {
      this.windowTitle = msg.title;
      this.windowApp = msg.app || null;
      this.emit("status", { watching: true, title: msg.title, app: msg.app });
    } else if (msg.event === "lost") {
      this.emit("status", { watching: false });
    } else if (msg.event === "frame") {
      this.onFrame(msg);
    }
  }

  onFrame(msg) {
    const t = (Date.now() - this.startTime) / 1000;
    if (msg.img) this.lastFrameJpg = Buffer.from(msg.img, "base64");
    const names = (msg.texts || []).filter((x) => looksLikeName(x.s));
    for (const n of names) {
      const key = normalizeName(n.s);
      this.roster.set(key, (this.roster.get(key) || 0) + 1);
      if (!this.nameForms.has(key)) this.nameForms.set(key, new Map());
      const forms = this.nameForms.get(key);
      forms.set(n.s, (forms.get(n.s) || 0) + 1);
    }
    // active speaker: name inside the smallest highlight rect that contains one
    let best = null;
    for (const rect of msg.rects || []) {
      const contained = names.filter((n) => inside(n, rect));
      if (contained.length === 1) {
        const area = rect.w * rect.h;
        if (!best || area < best.area) best = { name: normalizeName(contained[0].s), area, rect };
      }
    }
    if (best) this.samples.push({ t, name: best.name });

    // Pair detected faces with the name label on the same tile: the name sits
    // below the face (Meet/Zoom put it at the tile's bottom edge), roughly in
    // the same horizontal region. Match one-to-one, nearest gap first, so one
    // face can't claim a neighboring tile's label when its own label is taken.
    const cands = [];
    for (const f of msg.faces || []) {
      if (!f.jpg) continue;
      const fcx = f.x + f.w / 2;
      const fBottom = f.y + f.h;
      for (const n of names) {
        const gap = n.y + n.h / 2 - fBottom;
        if (gap < -0.02 || gap > Math.max(f.h, 0.08)) continue;
        const dx = Math.abs(n.x + n.w / 2 - fcx);
        if (dx > Math.max(f.w * 1.5, 0.1)) continue;
        cands.push({ f, name: normalizeName(n.s), gap });
      }
    }
    cands.sort((a, b) => a.gap - b.gap);
    const usedFaces = new Set();
    const usedNames = new Set();
    const paired = [];
    for (const c of cands) {
      if (usedFaces.has(c.f) || usedNames.has(c.name)) continue;
      usedFaces.add(c.f);
      usedNames.add(c.name);
      paired.push(this.displayForm(c.name));
      const area = c.f.w * c.f.h;
      const prev = this.faces.get(c.name);
      if (!prev) {
        this.faces.set(c.name, { votes: 1, area, jpg: Buffer.from(c.f.jpg, "base64") });
      } else {
        prev.votes++;
        if (area >= prev.area) {
          prev.area = area;
          prev.jpg = Buffer.from(c.f.jpg, "base64");
        }
      }
    }

    // compact frame summary for the debug UI (no jpg payloads)
    this.stats.frames++;
    if (names.length) this.stats.namedFrames++;
    if ((msg.rects || []).length) this.stats.rectFrames++;
    if ((msg.faces || []).length) this.stats.faceFrames++;
    this.stats.lastFrameAt = Date.now();
    const nameSet = new Set(names);
    const entry = {
      t: Math.round(t * 10) / 10,
      texts: (msg.texts || []).map((x) => ({
        s: x.s, x: x.x, y: x.y, w: x.w, h: x.h, name: nameSet.has(x),
      })),
      rects: (msg.rects || []).map(({ x, y, w, h }) => ({ x, y, w, h })),
      faces: (msg.faces || []).map(({ x, y, w, h }) => ({ x, y, w, h })),
      active: best ? this.displayForm(best.name) : null,
      activeRect: best ? { x: best.rect.x, y: best.rect.y, w: best.rect.w, h: best.rect.h } : null,
      paired,
    };
    this.recent.push(entry);
    if (this.recent.length > 20) this.recent.shift();
    this.emit("frame", entry);
  }

  // Most-seen OCR spelling of a canonical roster key.
  displayForm(key) {
    const forms = [...(this.nameForms.get(key) || new Map()).entries()];
    forms.sort((a, b) => b[1] - a[1]);
    return forms.length ? forms[0][0].trim().replace(/[\s\-–—.,;:!?]+$/u, "") : key;
  }

  // Live state for the debug UI — everything stop() would eventually write,
  // plus raw counters, without touching disk.
  snapshot() {
    const roster = [...this.roster.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 40)
      .map(([key, frames]) => {
        const f = this.faces.get(key);
        return {
          name: this.displayForm(key),
          frames,
          faceVotes: f ? f.votes : 0,
          face: f ? `data:image/jpeg;base64,${f.jpg.toString("base64")}` : null,
        };
      });
    return {
      active: true,
      watching: !!this.windowTitle,
      windowTitle: this.windowTitle,
      windowApp: this.windowApp || null,
      startTime: this.startTime,
      stats: this.stats,
      sampleCount: this.samples.length,
      roster,
      timeline: this.buildTimeline()
        .slice(-100)
        .map((iv) => ({ ...iv, name: this.displayForm(iv.name) })),
      recent: this.recent,
    };
  }

  // Merge per-second samples into speaking intervals.
  buildTimeline() {
    const out = [];
    for (const s of this.samples) {
      const last = out[out.length - 1];
      if (last && last.name === s.name && s.t - last.end <= 2.5) {
        last.end = s.t + 0.5;
      } else {
        out.push({ start: Math.max(0, s.t - 0.5), end: s.t + 0.5, name: s.name });
      }
    }
    return out.filter((iv) => iv.end - iv.start >= 1);
  }

  async stop() {
    if (this.helper) {
      this.helper.kill("SIGTERM");
      this.helper = null;
    }
    // a real participant's tile is on screen for a sustained stretch; OCR
    // misreads and transient popups only rack up a handful of frames
    const maxFrames = Math.max(0, ...this.roster.values());
    const minFrames = Math.max(2, Math.min(30, Math.round(maxFrames * 0.02)));
    const roster = [...this.roster.entries()]
      .filter(([, frames]) => frames >= minFrames)
      // the meeting title is painted on screen too ("SPP3 Interview (JustaLab)")
      // and racks up frames like a participant — drop keys the window title contains
      .filter(([key]) => !(key.length >= 4 && this.windowTitle && normalizeName(this.windowTitle).includes(key)))
      .sort((a, b) => b[1] - a[1])
      .map(([key, frames]) => ({ key, name: this.displayForm(key), frames }));
    // save the best face crop per rostered participant; a couple of votes
    // could be a one-off mispairing, so require a consistent match
    const dir = this.store.meetingDir(this.meeting.id);
    let faceIdx = 0;
    for (const entry of roster) {
      const f = this.faces.get(entry.key);
      if (!f || f.votes < 3) continue;
      if (faceIdx === 0) fs.mkdirSync(path.join(dir, "faces"), { recursive: true });
      const file = `faces/${faceIdx++}.jpg`;
      fs.writeFileSync(path.join(dir, file), f.jpg);
      entry.face = file;
    }
    for (const entry of roster) delete entry.key;
    const vision = {
      windowTitle: this.windowTitle,
      windowApp: this.windowApp || null,
      roster,
      speaking: this.buildTimeline().map((iv) => ({ ...iv, name: this.displayForm(iv.name) })),
    };
    fs.writeFileSync(
      path.join(this.store.meetingDir(this.meeting.id), "vision.json"),
      JSON.stringify(vision, null, 1)
    );
    return vision;
  }
}

module.exports = { Watcher };
