const fs = require("fs");
const path = require("path");
const os = require("os");

const CONFIG_PATH = path.join(__dirname, "..", "data", "config.json");

function findWhisperModel() {
  const candidates = [
    path.join(__dirname, "..", "data", "models", "ggml-small.en.bin"),
    path.join(os.homedir(), "whisper-models", "ggml-small.en.bin"),
    path.join(os.homedir(), "whisper-models", "ggml-base.en.bin"),
    path.join(os.homedir(), "whisper-models", "ggml-large.bin"),
  ];
  return candidates.find((p) => fs.existsSync(p)) || candidates[0];
}

const DEFAULTS = {
  port: 3123,
  whisperBin: "whisper-cli",
  whisperModel: null, // resolved below if absent
  whisperThreads: 4,
  // Any OpenAI-compatible or Ollama endpoint works here. Local by default.
  llm: {
    url: "http://localhost:11434",
    model: "qwen3.6:35b-a3b-q4_K_M",
  },
  keepAudio: true,
  chunkSeconds: 12,
  diarization: {
    segModel: path.join(__dirname, "..", "data", "models",
      "sherpa-onnx-pyannote-segmentation-3-0", "model.onnx"),
    embModel: path.join(__dirname, "..", "data", "models", "nemo_en_titanet_small.onnx"),
    // agglomerative-clustering distance cutoff: higher merges more aggressively.
    // 0.5 shattered a real 5-person, 3-hour call into 34 clusters; 1.1 got it
    // exactly right. Lower this if distinct speakers get merged.
    threshold: 1.1,
    minDurationOn: 0.3,
    minDurationOff: 0.5,
    auto: true, // run automatically when a recording stops
  },
  watcher: {
    enabled: true, // watch the meeting window for names + active speaker
    patterns: ["meet", "zoom", "teams", "webex"],
    // active-speaker tile border colors: Meet blues, Zoom green
    colors: [[26, 115, 232], [66, 133, 244], [35, 217, 89]],
    tolerance: 90,
  },
};

function load() {
  let cfg = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    } catch (e) {
      console.error("config.json is invalid, using defaults:", e.message);
    }
  }
  const merged = {
    ...DEFAULTS,
    ...cfg,
    llm: { ...DEFAULTS.llm, ...(cfg.llm || {}) },
    diarization: { ...DEFAULTS.diarization, ...(cfg.diarization || {}) },
    watcher: { ...DEFAULTS.watcher, ...(cfg.watcher || {}) },
  };
  if (!merged.whisperModel) merged.whisperModel = findWhisperModel();
  // Persist so the user has a file to edit.
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
  return merged;
}

module.exports = { load, CONFIG_PATH };
