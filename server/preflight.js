// Capture preflight + dead-capture alarm.
//
// macOS can wedge the Screen & System Audio Recording grant (Settings still
// shows it ON, capture delivers zero frames — typically after a reboot or a
// Sequoia grant re-validation). The daemon can't repair that itself; only a
// human toggling the grant OFF/ON can. So the job here is to make the failure
// LOUD and EARLY instead of silent: a self-test probe run at boot and before
// calendar meetings, and an on-screen alarm (notification + modal dialog +
// the exact Settings pane opened) the moment capture is known dead.
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const BIN = () => process.env.AUDIOCAP_BIN || path.join(__dirname, "..", "native", "audiocap");
const ALARM_MARKER = path.join(__dirname, "..", "data", "tmp", "capture-alarm.json");

const FIX_STEPS =
  "System Settings > Privacy & Security > Screen & System Audio Recording: " +
  "toggle Clawd Scribe OFF, then back ON.";

// Run audiocap briefly and see if PCM actually flows. The helper streams
// silence as bytes, so a healthy grant produces data within ~a second even in
// a quiet room; a wedged grant produces nothing (or an error on stderr).
// minBytes = 0.5s of 16kHz stereo s16le.
function probeCapture({ timeoutMs = 8000, minBytes = 32000 } = {}) {
  return new Promise((resolve) => {
    let bytes = 0;
    let err = "";
    let done = false;
    let child;
    let timer;
    const finish = (ok, error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill("SIGKILL"); } catch {}
      resolve({ ok, bytes, error: error || err.trim().slice(0, 300) || (ok ? null : "no audio bytes") });
    };
    try {
      child = spawn(BIN(), [], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return resolve({ ok: false, bytes: 0, error: e.message });
    }
    timer = setTimeout(() => finish(bytes >= minBytes), timeoutMs);
    child.stdout.on("data", (d) => {
      bytes += d.length;
      if (bytes >= minBytes) finish(true);
    });
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("error", (e) => finish(false, e.message));
    child.on("close", () => finish(bytes >= minBytes));
  });
}

function readAlarmMarker() {
  try { return JSON.parse(fs.readFileSync(ALARM_MARKER, "utf8")); } catch { return null; }
}

function fire(cmd, args) {
  try { spawn(cmd, args, { detached: true, stdio: "ignore" }).unref(); } catch {}
}

// q() — AppleScript string literal (JSON escaping is a compatible subset).
const q = (s) => JSON.stringify(String(s));

// Raise the on-screen alarm: notification + Settings pane + modal dialog +
// optional user hook. File-backed cooldown, because the daemon restarts itself
// during capture-dead handling and an in-memory timestamp wouldn't survive.
// exec is injectable for tests. Returns true if the alarm actually fired.
function raiseAlarm(config, reason, exec = fire) {
  const a = (config && config.alerts) || {};
  if (a.enabled === false) return false;
  const cooldownMs = (a.cooldownMin != null ? a.cooldownMin : 10) * 60e3;
  const m = readAlarmMarker();
  if (m && Date.now() - new Date(m.at).getTime() < cooldownMs) return false;
  fs.mkdirSync(path.dirname(ALARM_MARKER), { recursive: true });
  fs.writeFileSync(ALARM_MARKER, JSON.stringify({ at: new Date().toISOString(), reason }));
  console.error("[preflight] ALARM:", reason);
  exec("open", ["x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"]);
  exec("osascript", ["-e",
    `display notification ${q(FIX_STEPS)} with title "Clawd Scribe: audio capture is DEAD" sound name "Basso"`]);
  if (a.dialog !== false) {
    exec("osascript", ["-e",
      `display dialog ${q(
        reason + "\n\nFix (10 seconds): " + FIX_STEPS +
        "\n\nClawd Scribe re-tests every minute and will notify you when capture is healthy again."
      )} with title "Clawd Scribe: audio capture is DEAD" buttons {"OK"} default button "OK" with icon caution giving up after 900`]);
  }
  if (a.command) {
    try {
      spawn("/bin/sh", ["-c", a.command], {
        env: { ...process.env, SCRIBE_ALERT_REASON: reason },
        detached: true,
        stdio: "ignore",
      }).unref();
    } catch {}
  }
  return true;
}

function clearAlarm() {
  try { fs.unlinkSync(ALARM_MARKER); } catch {}
}

function notifyHealed(exec = fire) {
  exec("osascript", ["-e",
    `display notification "Audio capture is healthy again — recordings will work." with title "Clawd Scribe: capture healed" sound name "Glass"`]);
}

module.exports = { probeCapture, raiseAlarm, clearAlarm, notifyHealed, FIX_STEPS, ALARM_MARKER };
