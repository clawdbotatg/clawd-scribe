// Child process: runs sherpa-onnx speaker diarization on a meeting WAV.
// Synchronous and CPU-heavy, hence its own process.
//
// Usage: node diarize-worker.js <config-json>
//   config: { wavPath, channel ("right"|"mono"), segModel, embModel,
//             threshold, minDurationOn, minDurationOff }
// Prints JSON [{start, end, speaker}, ...] to stdout. Errors to stderr, exit 1.
const fs = require("fs");

function fail(msg) {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

function readWavChannel(wavPath, which) {
  const buf = fs.readFileSync(wavPath);
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF") fail("not a wav file");
  const channels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const bitsPerSample = buf.readUInt16LE(34);
  if (bitsPerSample !== 16) fail("expected 16-bit PCM");
  // find the data chunk (we write fixed 44-byte headers, but be tolerant)
  let off = 12;
  let dataOff = -1;
  let dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const len = buf.readUInt32LE(off + 4);
    if (id === "data") {
      dataOff = off + 8;
      dataLen = Math.min(len, buf.length - dataOff);
      break;
    }
    off += 8 + len + (len % 2);
  }
  if (dataOff < 0) fail("no data chunk");

  const frames = Math.floor(dataLen / (2 * channels));
  const out = new Float32Array(frames);
  const ch = channels === 1 ? 0 : which === "right" ? 1 : 0;
  for (let i = 0; i < frames; i++) {
    out[i] = buf.readInt16LE(dataOff + (i * channels + ch) * 2) / 32768;
  }
  return { samples: out, sampleRate };
}

const cfg = JSON.parse(process.argv[2]);
const sherpa = require("sherpa-onnx-node");

const { samples, sampleRate } = readWavChannel(cfg.wavPath, cfg.channel);
if (samples.length < sampleRate) fail("audio too short to diarize");

const sd = new sherpa.OfflineSpeakerDiarization({
  segmentation: { pyannote: { model: cfg.segModel }, debug: 0 },
  embedding: { model: cfg.embModel, debug: 0 },
  clustering: { numClusters: -1, threshold: cfg.threshold },
  minDurationOn: cfg.minDurationOn,
  minDurationOff: cfg.minDurationOff,
});
if (sd.sampleRate !== sampleRate) {
  fail(`wav is ${sampleRate}Hz but diarizer expects ${sd.sampleRate}Hz`);
}

const segments = sd.process(samples);
process.stdout.write(JSON.stringify(segments));
