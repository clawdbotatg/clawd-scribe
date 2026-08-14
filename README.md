# clawd-scribe

<img src="web/mascot.png" width="180" align="right" alt="clawd-scribe mascot" />

**Local, open-source meeting notes.** Like Granola, but nothing ever leaves your machine.

![status](https://img.shields.io/badge/status-early%20alpha-orange) ![platform](https://img.shields.io/badge/platform-macOS%2015%2B-lightgrey) ![license](https://img.shields.io/badge/license-MIT-green)

clawd-scribe records your Google Meet / Zoom / whatever calls **without a bot joining the meeting** — it captures your Mac's system audio (everyone else) plus your microphone (you), transcribes locally with [whisper.cpp](https://github.com/ggml-org/whisper.cpp), and turns the transcript + your rough notes into clean meeting notes with a local LLM via [Ollama](https://ollama.com).

- 🎙 **No meeting bot** — records system audio via ScreenCaptureKit, invisible to other participants*
- 🔒 **100% local** — audio, transcripts, and summaries never touch a cloud
- 👥 **Speaker identification** — your mic and the meeting audio are captured as separate channels, so *you* are always attributed correctly; remote voices are clustered into Speaker 1/2/3 with local diarization ([sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) + pyannote segmentation + NeMo TitaNet embeddings) and you name them with one click
- 👁 **Meeting-window vision** — while recording, clawd-scribe watches your Meet/Zoom window (ScreenCaptureKit + Apple's local Vision OCR, ~1fps): it reads participant names off the tiles and tracks the active-speaker highlight border, then fuses that timeline with the voice clusters to **auto-name speakers** — no clicking required when it's confident
- 🖼 **Meeting snapshots** — a handful of evenly-spaced frames of the meeting window are saved with each recording and shown under the generated notes; a 📸 button (bottom right while recording) snapshots the current moment on demand, and those are always kept
- 🗓 **Calendar-aware** — record during a calendar event and the recording names itself after it, pulling the invite's attendees and description in as context for the notes (reads Google Calendar through your own logged-in browser profile, or macOS Calendar via EventKit — locally either way)
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

The daemon also serves the **LAN** by default — the startup log prints a
`http://<your-lan-ip>:3123` URL you can open from any machine on your network
to read meetings (there's no auth, so anyone on the network can too; set
`"host": "127.0.0.1"` in config to keep it this-machine-only).

### Survive reboots + permission grants: launch it as an .app

macOS ties the Screen Recording / Microphone grants to **whatever launched the
daemon**. Launch from a terminal and the grants attach to that terminal app;
launch `node` a different way later and macOS asks again (or silently records
nothing). The fix is a tiny .app bundle that always launches it the same way:

```bash
mkdir -p "/Applications/Clawd Scribe.app/Contents/MacOS"
cat > "/Applications/Clawd Scribe.app/Contents/MacOS/Clawd Scribe" <<'EOF'
#!/bin/bash
# Start the daemon if needed, then open the UI.
PROJECT="$HOME/clawd-scribe"          # <- your checkout
NODE="$(command -v node || echo /opt/homebrew/bin/node)"
PORT=3123
LOG="$HOME/Library/Logs/clawd-scribe.log"
mkdir -p "$(dirname "$LOG")"
if ! curl -s -o /dev/null "http://localhost:$PORT"; then
  cd "$PROJECT" || exit 1
  nohup "$NODE" server/index.js >> "$LOG" 2>&1 &
  for i in $(seq 1 30); do
    curl -s -o /dev/null "http://localhost:$PORT" && break; sleep 0.5
  done
fi
open "http://localhost:$PORT"
EOF
chmod +x "/Applications/Clawd Scribe.app/Contents/MacOS/Clawd Scribe"
```

Grant the two permissions once when recording from an .app-launched daemon,
and they stick across restarts. (Restarting after a code update = quit the
`node` on port 3123, reopen the .app — the grants survive.)

## Usage

1. Hit **Record** when your meeting starts, and type the meeting's name in the title field. **Titles are manual-only**: nothing ever generates, suggests, or overwrites a title — the name you type is the name it keeps.
2. The live transcript appears within ~15 seconds, labeled **Me** (your mic) or **Them** (system audio).
3. Type rough notes in **My notes** during the call — just fragments of what mattered.
4. Hit **Stop**. Speaker identification runs automatically; remote voices become **Speaker 1/2/3** chips — click a chip to type the person's real name.
5. Hit **✨ Generate**. The LLM merges your notes with the speaker-labeled transcript into structured notes (summary, key points, decisions, action items with owners).

**Who is who?** Your voice never needs diarizing — it arrives on its own channel (your mic), so "Me" is ground truth. Only the remote side is clustered by voice. Names come from two places: the **vision watcher** (below) auto-fills them when it can, and the rename chips are the manual override. Names persist per meeting and flow into the generated notes.

**Calendar (query-only).** `GET /api/calendar/now` answers "what event is on right now" for external tooling. It plays **no part in recording**: auto-naming from the calendar (and the AI ✨ Name button) were removed 2026-08-05 after the calendar title overwrote a manually entered name — titles are manual-only, full stop. Two sources (`calendar.source`, default `auto`):

- **`gcal`** — reads calendar.google.com **through your own logged-in Chrome
  profile**: run `tools/gcal-clone.sh` once to clone the profile that's signed
  into Google (default: Chrome's `Default`) into `data/gcal-profile`, and
  `tools/gcal-peek.mjs` drives a headless copy of your Chrome against it. No
  Google API keys, no OAuth app, no macOS account setup — if your browser can
  see the calendar, the scribe can. The headless clone launches on first use
  and sticks around (~300 MB RAM) so later peeks take ~2s. If Google ever
  rotates the clone's session out (`gcal-peek` reports "session expired"),
  just re-run `tools/gcal-clone.sh`. `auto` uses this source whenever
  `data/gcal-profile` exists.
- **`eventkit`** — a third tiny native helper (`native/calpeek`) reads whatever
  calendars macOS Calendar syncs (iCloud, or Google added via System Settings →
  Internet Accounts with **Calendars** enabled). First use pops a macOS
  *"access your calendar"* prompt.

Either way everything stays on your machine, and `"calendar": { "enabled": false }` in config disables the peek entirely.

**The vision watcher.** While recording, a second native helper looks for a window whose title matches a meeting app (`meet`, `zoom`, `teams`, `webex` — configurable), captures one frame per second, OCRs it with Apple's on-device Vision framework, and finds the active-speaker border (Meet's blue / Zoom's green tile outline) by color clustering. That produces "Tom Chen's tile was highlighted from 4:10–4:25". After the meeting, voice cluster turns are matched against that timeline — consistent overlap means Speaker 2 *is* Tom Chen, and the chip is named automatically (your manual renames always win; ambiguous overlaps are left alone). Caveats: keep the meeting tab as the **active tab** of its browser window (its title is how the window is found — naturally true when you're in the call), and a 👁 badge in the sidebar shows which window is being watched. If the UI of Meet/Zoom changes their highlight colors, tweak `watcher.colors` in config. Everything is pixels-in, JSON-out on your machine — frames are never saved or uploaded.

## Configuration

Edit `data/config.json` (created on first run):

```jsonc
{
  "port": 3123,
  "host": "0.0.0.0",      // serve the LAN; "127.0.0.1" = this machine only
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
    "threshold": 1.1,     // lower = more speakers detected, higher = fewer
    "auto": true          // identify speakers automatically on stop
  },
  "calendar": {
    "enabled": true,      // name recordings after the calendar event happening now
    "source": "auto",     // "gcal" (logged-in Chrome profile) | "eventkit" (macOS Calendar)
    "lookaheadMin": 20    // an event starting this soon counts as "now"
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

## Ask Claude about your calls (MCP)

clawd-scribe ships a local [MCP](https://modelcontextprotocol.io) server (`mcp/server.js`,
zero dependencies) so Claude Desktop / Claude Code can **search, list, and read every call
you've recorded** — transcripts with speaker names, your notes, and the generated summaries.
It reads the same `data/meetings/` files directly, so it works even when the daemon is down,
and nothing leaves your machine: the tools are read-only file access, not a network service.

Two transports, same tools:

- **HTTP (easiest)** — the daemon serves MCP at `http://localhost:3123/mcp`. One line,
  no paths: `claude mcp add --scope user --transport http clawd-scribe http://localhost:3123/mcp`
  — or add that URL as a custom connector in Claude Desktop. Needs the daemon running.
- **stdio** — Claude spawns `mcp/server.js` directly, so your call history is readable
  even when the daemon is down:

```json
// Claude Desktop — ~/Library/Application Support/Claude/claude_desktop_config.json
// use an absolute node path (GUI apps don't see homebrew's PATH)
{ "mcpServers": { "clawd-scribe": {
  "command": "/opt/homebrew/bin/node",
  "args": ["/path/to/clawd-scribe/mcp/server.js"] } } }
```

The easy way to get either: hit **🔌 Connect Claude** at the bottom of the sidebar — it
fills in the URL and absolute paths for you, plus a paste-able skill for your agent's
instructions.

Tools: `search_meetings` (full-text across everything), `list_meetings`, `get_meeting`
(notes + summary), `get_transcript` (word-for-word, paged). Point the server at a
different data folder with `SCRIBE_DATA=/path/to/data`.

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

- **No cloud, no accounts, no telemetry.** The only network call at runtime is to your own Ollama at `localhost:11434`. The daemon serves your local network by default (`"host": "0.0.0.0"`) so other machines can read meetings — set `"host": "127.0.0.1"` to bind loopback only. It is never reachable from the internet unless you port-forward it yourself.
- **Open source stack.** whisper.cpp (MIT), sherpa-onnx (Apache-2.0), Ollama (MIT), open-weight models (Whisper, pyannote, TitaNet, Qwen). The two closed-source pieces are Apple frameworks that run entirely on-device: ScreenCaptureKit (audio capture) and Vision (OCR).
- **Your data is plain files.** Everything lives in `data/` — grep it, back it up, encrypt it, delete it. Nothing is hidden in a database or synced anywhere.
- **Easy to audit.** ~2,400 lines total, two npm dependencies (`ws`, `sherpa-onnx-node`), no framework, no build step for the UI.

External touchpoints are setup-time only: Homebrew, npm, and model downloads from Hugging Face / GitHub releases. After setup, clawd-scribe works fully offline.

Known soft spots (PRs welcome): the API has no auth token (anyone on your LAN can read meetings under the default `host` — bind `127.0.0.1` on networks you don't trust), meetings are not encrypted at rest (use FileVault), and it's macOS-only.

## License

MIT
