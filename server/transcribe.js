// Wraps whisper-cli: writes a PCM chunk to a temp WAV, transcribes it,
// returns cleaned text. Runs are serialized by the caller (recorder.js).
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const TMP_DIR = path.join(__dirname, "..", "data", "tmp");

// Whisper hallucinates filler on near-silent audio; drop the known offenders.
// Lines that are entirely a (parenthetical) or [bracketed] sound description
// are never real speech.
const JUNK = [
  /^[([][^)\]]{0,80}[)\]]$/,
  /^\*[^*]{0,80}\*$/,
  /^(thank you\.?|thanks for watching!?|you)$/i,
];

function wavHeader(numSamples, sampleRate = 16000, channels = 1) {
  const dataSize = numSamples * 2 * channels;
  const b = Buffer.alloc(44);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + dataSize, 4);
  b.write("WAVE", 8);
  b.write("fmt ", 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * 2 * channels, 28);
  b.writeUInt16LE(2 * channels, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(dataSize, 40);
  return b;
}

function cleanLine(line) {
  const t = line.trim();
  if (!t) return null;
  if (JUNK.some((re) => re.test(t))) return null;
  return t;
}

async function transcribeChunk(pcm, config) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const wavPath = path.join(TMP_DIR, `chunk-${Date.now()}-${process.pid}.wav`);
  fs.writeFileSync(wavPath, Buffer.concat([wavHeader(pcm.length / 2), pcm]));

  try {
    const text = await new Promise((resolve, reject) => {
      const args = [
        "-m", config.whisperModel,
        "-f", wavPath,
        "-nt",            // no timestamps; we track chunk offsets ourselves
        "--no-prints",
        "-t", String(config.whisperThreads),
      ];
      const proc = spawn(config.whisperBin, args);
      let out = "";
      let err = "";
      proc.stdout.on("data", (d) => (out += d));
      proc.stderr.on("data", (d) => (err += d));
      proc.on("error", reject);
      proc.on("close", (code) => {
        if (code !== 0) reject(new Error(`whisper-cli exit ${code}: ${err.slice(-400)}`));
        else resolve(out);
      });
    });
    return text
      .split("\n")
      .map(cleanLine)
      .filter(Boolean)
      .join(" ")
      .trim();
  } finally {
    fs.rmSync(wavPath, { force: true });
  }
}

module.exports = { transcribeChunk, wavHeader };
