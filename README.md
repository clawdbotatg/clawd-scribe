# ✍️ clawd-scribe

**Local, open-source meeting notes.** Like Granola, but nothing ever leaves your machine.

![status](https://img.shields.io/badge/status-early%20alpha-orange) ![platform](https://img.shields.io/badge/platform-macOS%2015%2B-lightgrey) ![license](https://img.shields.io/badge/license-MIT-green)

clawd-scribe records your Google Meet / Zoom / whatever calls **without a bot joining the meeting** — it captures your Mac's system audio (everyone else) plus your microphone (you), transcribes locally with [whisper.cpp](https://github.com/ggml-org/whisper.cpp), and turns the transcript + your rough notes into clean meeting notes with a local LLM via [Ollama](https://ollama.com).

- 🎙 **No meeting bot** — records system audio via ScreenCaptureKit, invisible to other participants*
- 🔒 **100% local** — audio, transcripts, and summaries never touch a cloud
- 👥 **Speaker identification** — your mic and the meeting audio are captured as separate channels, so *you* are always attributed correctly; remote voices are clustered into Speaker 1/2/3 with local diarization ([sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) + pyannote segmentation + NeMo TitaNet embeddings) and you name them with one click
- 👁 **Meeting-window vision** — while recording, clawd-scribe watches your Meet/Zoom window (ScreenCaptureKit + Apple's local Vision OCR, ~1fps): it reads participant names off the tiles and tracks the active-speaker highlight border, then fuses that timeline with the voice clusters to **auto-name speakers** — no clicking required when it's confident
- ✍️ **Granola-style notes** — type rough notes during the call; the LLM weaves them together with the transcript, attributing action items to the right people
- 🔇 **Echo gate** — if you're on laptop speakers, mic chunks that are just the meeting audio leaking back in are detected by envelope cross-correlation and dropped
- 📂 **Plain files** — every meeting is a folder of markdown + JSON + WAV you own

\* check your local laws and company policy on call recording — tell people you're recording.

## Requirements

- macOS 15+ (uses `SCStreamConfiguration.captureMicrophone`)
- [Homebrew](https://brew.sh), Node 18+
- Xcode command line tools (`xcode-select --install`) to build the audio helper

## Setup

```bash
# 1. transcription engine
brew install whisper-cpp

# 2. a whisper model (small.en is a good speed/quality tradeoff)
mkdir -p ~/whisper-models
curl -L -o ~/whisper-models/ggml-small.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin

# 3. local LLM for note generation
brew install ollama        # or download from ollama.com
ollama pull qwen3.6:35b-a3b-q4_K_M   # or any model you like

# 4. speaker-diarization models (optional but recommended)
mkdir -p data/models && cd data/models
curl -sL -O https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2
tar xjf sherpa-onnx-pyannote-segmentation-3-0.tar.bz2 && rm sherpa-onnx-pyannote-segmentation-3-0.tar.bz2
curl -sL -O https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/nemo_en_titanet_small.onnx
cd ../..

# 5. build + run clawd-scribe
npm install
npm run build:native
npm start
```

Open **http://localhost:3123**, hit **● Record meeting**, and grant the two permissions macOS asks for (Screen Recording — that's how system audio capture works — and Microphone). The permissions attach to whatever launched the daemon (your terminal).

## Usage

1. Hit **Record** when your meeting starts. The live transcript appears within ~15 seconds, labeled **Me** (your mic) or **Them** (system audio).
2. Type rough notes in **My notes** during the call — just fragments of what mattered.
3. Hit **Stop**. Speaker identification runs automatically; remote voices become **Speaker 1/2/3** chips — click a chip to type the person's real name.
4. Hit **✨ Generate**. The LLM merges your notes with the speaker-labeled transcript into structured notes (summary, key points, decisions, action items with owners).

**Who is who?** Your voice never needs diarizing — it arrives on its own channel (your mic), so "Me" is ground truth. Only the remote side is clustered by voice. Names come from two places: the **vision watcher** (below) auto-fills them when it can, and the rename chips are the manual override. Names persist per meeting and flow into the generated notes.

**The vision watcher.** While recording, a second native helper looks for a window whose title matches a meeting app (`meet`, `zoom`, `teams`, `webex` — configurable), captures one frame per second, OCRs it with Apple's on-device Vision framework, and finds the active-speaker border (Meet's blue / Zoom's green tile outline) by color clustering. That produces "Tom Chen's tile was highlighted from 4:10–4:25". After the meeting, voice cluster turns are matched against that timeline — consistent overlap means Speaker 2 *is* Tom Chen, and the chip is named automatically (your manual renames always win; ambiguous overlaps are left alone). Caveats: keep the meeting tab as the **active tab** of its browser window (its title is how the window is found — naturally true when you're in the call), and a 👁 badge in the sidebar shows which window is being watched. If the UI of Meet/Zoom changes their highlight colors, tweak `watcher.colors` in config. Everything is pixels-in, JSON-out on your machine — frames are never saved or uploaded.

## Configuration

Edit `data/config.json` (created on first run):

```jsonc
{
  "port": 3123,
  "whisperBin": "whisper-cli",
  "whisperModel": "/path/to/ggml-small.en.bin",
  "whisperThreads": 4,
  "llm": {
    "url": "http://localhost:11434",   // any Ollama-compatible endpoint
    "model": "qwen3.6:35b-a3b-q4_K_M"
  },
  "keepAudio": true,      // save audio.wav per meeting (~230 MB/hour, stereo)
  "chunkSeconds": 12,     // live-transcription chunk size
  "diarization": {
    "threshold": 0.5,     // lower = more speakers detected, higher = fewer
    "auto": true          // identify speakers automatically on stop
  },
  "watcher": {
    "enabled": true,      // watch the meeting window during recording
    "patterns": ["meet", "zoom", "teams", "webex"],
    "colors": [[26,115,232],[66,133,244],[35,217,89]],  // highlight border colors
    "tolerance": 90
  }
}
```

To sanity-check the vision pipeline without a real meeting, open
`http://localhost:3123/fake-meet.html#go` — a mock Meet page that cycles the
active-speaker border between two named tiles.

## How it works

```
┌─────────────┐ 16k stereo PCM  ┌──────────────┐  chunks   ┌─────────────┐
│  audiocap   │ L=mic R=system  │  node daemon │──────────▶│ whisper-cli │
│ (Swift/SCK) │ ───────────────▶│              │◀──────────│  (local)    │
│ system+mic  │     stdout      │  localhost   │   text    └─────────────┘
└─────────────┘                 │  :3123       │  audio.wav  ┌────────────┐
                                │   ▲  │       │────────────▶│ sherpa-onnx│
                                │   │  │       │◀────────────│ diarization│
                                │   │  │       │  speakers   └────────────┘
                                │   ▲  │       │  transcript+notes ┌────────┐
                       web UI ──┘   │  └──────────────────────────▶│ Ollama │
                       (ws live)    └────────── markdown notes ◀───└────────┘
```

- `native/AudioCapture.swift` — captures system audio + mic with ScreenCaptureKit as **separate channels** of 16 kHz stereo PCM on stdout (L = you, R = everyone else). Chunks are cut at the quietest moment so words don't get split.
- `server/` — zero-framework Node daemon: REST + WebSocket + static UI. Both channels transcribed independently (serial whisper queue), envelope-correlation echo gate, diarization in a worker child process, streaming Ollama summaries.
- `web/` — vanilla JS single page, no build step.
- `data/meetings/<id>/` — `meta.json` (incl. speaker names), `transcript.json` (per-segment `who`/`speaker`), `notes.md`, `summary.md`, `audio.wav` (stereo).

## Privacy & security

The design goal is **CROPS** — censorship-resistant, open source, private, secure:

- **No cloud, no accounts, no telemetry.** The only network call at runtime is to your own Ollama at `localhost:11434`. The daemon binds to `127.0.0.1` only.
- **Open source stack.** whisper.cpp (MIT), sherpa-onnx (Apache-2.0), Ollama (MIT), open-weight models (Whisper, pyannote, TitaNet, Qwen). The two closed-source pieces are Apple frameworks that run entirely on-device: ScreenCaptureKit (audio capture) and Vision (OCR).
- **Your data is plain files.** Everything lives in `data/` — grep it, back it up, encrypt it, delete it. Nothing is hidden in a database or synced anywhere.
- **Easy to audit.** ~2,400 lines total, two npm dependencies (`ws`, `sherpa-onnx-node`), no framework, no build step for the UI.

External touchpoints are setup-time only: Homebrew, npm, and model downloads from Hugging Face / GitHub releases. After setup, clawd-scribe works fully offline.

Known soft spots (PRs welcome): the localhost API has no auth token, meetings are not encrypted at rest (use FileVault), and it's macOS-only.

## License

MIT
