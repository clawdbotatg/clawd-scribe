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
]);

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
    this.roster = new Map(); // name -> frame count
    this.samples = []; // {t (sec rel), name}
    this.faces = new Map(); // name -> {area, jpg (Buffer)} — best crop so far
    this.windowTitle = null;
    this.lineBuf = "";
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
    const names = (msg.texts || []).filter((x) => looksLikeName(x.s));
    for (const n of names) {
      this.roster.set(n.s, (this.roster.get(n.s) || 0) + 1);
    }
    // active speaker: name inside the smallest highlight rect that contains one
    let best = null;
    for (const rect of msg.rects || []) {
      const contained = names.filter((n) => inside(n, rect));
      if (contained.length === 1) {
        const area = rect.w * rect.h;
        if (!best || area < best.area) best = { name: contained[0].s, area };
      }
    }
    if (best) this.samples.push({ t, name: best.name });

    // Pair detected faces with the name label on the same tile: the name sits
    // below the face (Meet/Zoom put it at the tile's bottom edge), roughly in
    // the same horizontal region.
    for (const f of msg.faces || []) {
      if (!f.jpg) continue;
      const fcx = f.x + f.w / 2;
      const fBottom = f.y + f.h;
      let match = null;
      for (const n of names) {
        const ncy = n.y + n.h / 2;
        const gap = ncy - fBottom;
        if (gap < -0.02 || gap > Math.max(f.h * 1.6, 0.12)) continue;
        const dx = Math.abs(n.x + n.w / 2 - fcx);
        if (dx > Math.max(f.w * 2.5, 0.14)) continue;
        if (!match || gap < match.gap) match = { name: n.s, gap };
      }
      if (!match) continue;
      const area = f.w * f.h;
      const prev = this.faces.get(match.name);
      if (!prev || area >= prev.area) {
        this.faces.set(match.name, { area, jpg: Buffer.from(f.jpg, "base64") });
      }
    }
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
    const roster = [...this.roster.entries()]
      .filter(([, frames]) => frames >= 2)
      .sort((a, b) => b[1] - a[1])
      .map(([name, frames]) => ({ name, frames }));
    // save the best face crop per rostered participant
    const dir = this.store.meetingDir(this.meeting.id);
    let faceIdx = 0;
    for (const entry of roster) {
      const f = this.faces.get(entry.name);
      if (!f) continue;
      if (faceIdx === 0) fs.mkdirSync(path.join(dir, "faces"), { recursive: true });
      const file = `faces/${faceIdx++}.jpg`;
      fs.writeFileSync(path.join(dir, file), f.jpg);
      entry.face = file;
    }
    const vision = {
      windowTitle: this.windowTitle,
      windowApp: this.windowApp || null,
      roster,
      speaking: this.buildTimeline(),
    };
    fs.writeFileSync(
      path.join(this.store.meetingDir(this.meeting.id), "vision.json"),
      JSON.stringify(vision, null, 1)
    );
    return vision;
  }
}

module.exports = { Watcher };
