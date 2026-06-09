// Recording session: spawns the native audiocap helper, which emits 16k STEREO
// s16le PCM (L = mic/you, R = system audio/them). The two channels are split
// and transcribed independently, so every segment is attributed to "me" or
// "them" with certainty. Chunks are cut at quiet points; whisper runs are
// serialized across both streams.
// Emits: level, segment, error, helperExit.
const { spawn } = require("child_process");
const { EventEmitter } = require("events");
const fs = require("fs");
const path = require("path");
const { transcribeChunk, wavHeader } = require("./transcribe");

const RATE = 16000;
const BYTES_PER_SEC = RATE * 2; // per mono channel
const ENV_FRAME = 160; // 10ms loudness-envelope frames for echo detection

function envelopeOf(buf) {
  const frames = Math.floor(buf.length / 2 / ENV_FRAME);
  const env = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let acc = 0;
    const base = f * ENV_FRAME * 2;
    for (let i = 0; i < ENV_FRAME; i++) {
      const s = buf.readInt16LE(base + i * 2);
      acc += s * s;
    }
    env[f] = Math.sqrt(acc / ENV_FRAME);
  }
  return env;
}

// Pearson correlation of a against b shifted by lag.
function corrAtLag(a, b, lag) {
  const n = a.length;
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = i + lag < b.length ? b[i + lag] : 0;
    sa += x; sb += y; saa += x * x; sbb += y * y; sab += x * y;
  }
  const num = n * sab - sa * sb;
  const den = Math.sqrt((n * saa - sa * sa) * (n * sbb - sb * sb)) + 1e-9;
  return num / den;
}

// Buffers and cuts one mono channel into transcription chunks.
class Chunker {
  constructor(who, recorder) {
    this.who = who;
    this.rec = recorder;
    this.buf = Buffer.alloc(0);
    this.consumedSec = 0;
  }

  push(data) {
    this.buf = Buffer.concat([this.buf, data]);
    this.maybeCut();
  }

  maybeCut() {
    const minBytes = this.rec.config.chunkSeconds * BYTES_PER_SEC;
    const maxBytes = minBytes * 2;
    if (this.buf.length < minBytes) return;
    let cutByte;
    if (this.buf.length >= maxBytes) {
      cutByte = this.buf.length;
    } else {
      cutByte = this.findQuietCut(Math.floor(this.buf.length * 0.66), this.buf.length);
    }
    cutByte -= cutByte % 2;
    this.cut(cutByte);
  }

  findQuietCut(fromByte, toByte) {
    const win = Math.floor(0.3 * BYTES_PER_SEC); // 300ms
    const step = Math.floor(0.05 * BYTES_PER_SEC);
    let best = toByte;
    let bestEnergy = Infinity;
    for (let start = fromByte; start + win <= toByte; start += step) {
      let e = 0;
      for (let i = start; i < start + win; i += 16) e += Math.abs(this.buf.readInt16LE(i - (i % 2)));
      if (e < bestEnergy) {
        bestEnergy = e;
        best = start + Math.floor(win / 2);
      }
    }
    return best;
  }

  cut(cutByte) {
    if (cutByte <= 0) return;
    const chunk = this.buf.subarray(0, cutByte);
    this.buf = this.buf.subarray(cutByte);
    const startSec = this.consumedSec;
    const durSec = chunk.length / BYTES_PER_SEC;
    this.consumedSec += durSec;

    // Skip whisper on effectively-silent chunks (e.g. mic while you listen)
    let energy = 0;
    for (let i = 0; i + 1 < chunk.length; i += 64) energy += Math.abs(chunk.readInt16LE(i));
    const meanAbs = energy / (chunk.length / 64);
    if (meanAbs < 60) return;

    // Drop mic chunks that are just the laptop speakers leaking the meeting
    // audio back in (no-headphones echo).
    if (this.who === "me" && this.rec.isEcho(chunk, startSec)) return;

    this.rec.enqueue(Buffer.from(chunk), this.who, startSec, durSec);
  }

  flush() {
    if (this.buf.length > BYTES_PER_SEC / 2) this.cut(this.buf.length - (this.buf.length % 2));
  }
}

class Recorder extends EventEmitter {
  constructor(meeting, config, store) {
    super();
    this.meeting = meeting;
    this.config = config;
    this.store = store;
    this.helper = null;
    this.queue = Promise.resolve();
    this.stopped = false;
    this.startTime = Date.now();
    this.wavStream = null;
    this.wavBytes = 0;
    this.levelAcc = { sum: 0, n: 0 };
    this.mic = new Chunker("me", this);
    this.sys = new Chunker("them", this);
    this.leftover = Buffer.alloc(0);
    // rolling 10ms loudness envelope of the system stream, global timeline
    // (100 frames/sec — a one-hour meeting is ~3MB, fine to keep whole)
    this.sysEnv = [];
    this.sysEnvPartial = Buffer.alloc(0);
  }

  start() {
    if (this.config.keepAudio) {
      const wavPath = path.join(this.store.meetingDir(this.meeting.id), "audio.wav");
      this.wavStream = fs.createWriteStream(wavPath);
      this.wavStream.write(wavHeader(0, RATE, 2)); // sizes patched in finalizeWav()
    }

    const bin = path.join(__dirname, "..", "native", "audiocap");
    this.helper = spawn(bin, [], { stdio: ["ignore", "pipe", "pipe"] });

    this.helper.stdout.on("data", (data) => this.onPCM(data));
    this.helper.stderr.on("data", (d) => {
      for (const line of d.toString().split("\n").filter(Boolean)) {
        try {
          const msg = JSON.parse(line);
          if (msg.event === "error") this.emit("error", new Error(msg.detail));
          else this.emit("helperLog", msg);
        } catch {
          this.emit("helperLog", { event: "raw", detail: line });
        }
      }
    });
    this.helper.on("error", (e) => this.emit("error", e));
    this.helper.on("close", (code) => {
      if (!this.stopped) this.emit("helperExit", code);
    });
  }

  onPCM(data) {
    // keep frames (4 bytes: L int16 + R int16) intact across packets
    let buf = this.leftover.length ? Buffer.concat([this.leftover, data]) : data;
    const rem = buf.length % 4;
    if (rem) {
      this.leftover = buf.subarray(buf.length - rem);
      buf = buf.subarray(0, buf.length - rem);
    } else {
      this.leftover = Buffer.alloc(0);
    }
    if (!buf.length) return;

    if (this.wavStream) {
      this.wavStream.write(Buffer.from(buf));
      this.wavBytes += buf.length;
    }

    const frames = buf.length / 4;
    const micBuf = Buffer.alloc(frames * 2);
    const sysBuf = Buffer.alloc(frames * 2);
    for (let i = 0; i < frames; i++) {
      const l = buf.readInt16LE(i * 4);
      const r = buf.readInt16LE(i * 4 + 2);
      micBuf.writeInt16LE(l, i * 2);
      sysBuf.writeInt16LE(r, i * 2);
      const m = Math.max(Math.abs(l), Math.abs(r));
      this.levelAcc.sum += m * m;
      this.levelAcc.n++;
    }

    if (this.levelAcc.n >= 3200) {
      const rms = Math.sqrt(this.levelAcc.sum / this.levelAcc.n) / 32768;
      this.levelAcc = { sum: 0, n: 0 };
      this.emit("level", rms);
    }

    // extend the system-stream envelope (used by the mic echo gate)
    let envBuf = this.sysEnvPartial.length
      ? Buffer.concat([this.sysEnvPartial, sysBuf])
      : sysBuf;
    const wholeFrames = Math.floor(envBuf.length / 2 / ENV_FRAME);
    if (wholeFrames > 0) {
      const used = wholeFrames * ENV_FRAME * 2;
      for (const v of envelopeOf(envBuf.subarray(0, used))) this.sysEnv.push(v);
      this.sysEnvPartial = Buffer.from(envBuf.subarray(used));
    } else {
      this.sysEnvPartial = Buffer.from(envBuf);
    }

    this.mic.push(micBuf);
    this.sys.push(sysBuf);
  }

  // True when a mic chunk's loudness contour matches the system audio at the
  // same time (within 0–300ms lag) — i.e. the mic is hearing the speakers.
  isEcho(chunk, startSec) {
    const micEnv = envelopeOf(chunk);
    if (micEnv.length < 50) return false; // < 0.5s, not enough signal
    const startFrame = Math.round(startSec * 100);
    const maxLag = 30;
    const slice = this.sysEnv.slice(startFrame, startFrame + micEnv.length + maxLag);
    if (slice.length < micEnv.length * 0.8) return false;
    // system side must actually contain audio
    const sysMean = slice.reduce((a, b) => a + b, 0) / slice.length;
    if (sysMean < 100) return false;
    let best = 0;
    for (let lag = 0; lag <= Math.min(maxLag, slice.length - micEnv.length); lag++) {
      const c = corrAtLag(micEnv, slice, lag);
      if (c > best) best = c;
    }
    if (best > 0.65) {
      this.emit("helperLog", { event: "echoDropped", detail: `t=${Math.round(startSec)}s corr=${best.toFixed(2)}` });
      return true;
    }
    return false;
  }

  enqueue(pcm, who, startSec, durSec) {
    this.queue = this.queue
      .then(async () => {
        const text = await transcribeChunk(pcm, this.config);
        if (text) {
          const segment = {
            t: Math.round(startSec),
            end: Math.round(startSec + durSec),
            who,
            text,
          };
          this.store.appendTranscript(this.meeting.id, segment);
          this.emit("segment", segment);
        }
      })
      .catch((e) => this.emit("error", e));
  }

  async stop() {
    this.stopped = true;
    if (this.helper) {
      this.helper.kill("SIGTERM");
      this.helper = null;
    }
    // small grace period for in-flight stdout data
    await new Promise((r) => setTimeout(r, 400));
    this.mic.flush();
    this.sys.flush();
    await this.queue;
    await this.finalizeWav();
    return Math.round((Date.now() - this.startTime) / 1000);
  }

  finalizeWav() {
    return new Promise((resolve) => {
      if (!this.wavStream) return resolve();
      const wavPath = this.wavStream.path;
      const bytes = this.wavBytes;
      this.wavStream.end(() => {
        try {
          const fd = fs.openSync(wavPath, "r+");
          const riff = Buffer.alloc(4);
          riff.writeUInt32LE(36 + bytes);
          fs.writeSync(fd, riff, 0, 4, 4);
          const dataSz = Buffer.alloc(4);
          dataSz.writeUInt32LE(bytes);
          fs.writeSync(fd, dataSz, 0, 4, 40);
          fs.closeSync(fd);
        } catch (e) {
          this.emit("error", e);
        }
        resolve();
      });
    });
  }
}

module.exports = { Recorder };
