# ONESHOT.md — build your own local meeting scribe

This document is for an AI agent (Claude, Codex, whoever) or a determined human
who wants to build their **own** local, private meeting note-taker from first
principles. It's everything we learned building clawd-scribe, written so you
can rebuild it in a day or two without repeating our debugging. Rebrand it
however you like — nothing below is brand-locked. Pick your own name, mascot,
and color scheme; the architecture is the gift.

Target platform for this recipe is **macOS 15+**. The ideas port to
Windows/Linux, but the capture layer (ScreenCaptureKit) and OCR (Apple Vision)
are the two Apple-specific pieces — everything else is portable Node + open
models.

---

## 1. The idea, from first principles

Commercial tools (Granola, Otter, Fireflies) do some mix of: join your call
with a bot, upload your audio to their cloud, and charge rent. All three are
unnecessary.

Four insights make the whole product fall out naturally:

1. **You don't need a meeting bot.** Every word of the meeting already plays
   through your computer's speakers. Capture **system audio** at the OS level
   and you have everyone else, invisibly, regardless of which meeting app is
   used. macOS exposes this via ScreenCaptureKit (that's why the permission is
   "Screen Recording" — audio rides that grant).

2. **Two channels = free speaker attribution.** Capture your **microphone**
   and **system audio** as *separate channels* of one stereo stream
   (L = you, R = everyone else). Now "me vs. them" attribution is ground
   truth, not a diarization guess — and you only ever need to diarize the
   remote side. This single decision does more for transcript quality than
   any model upgrade.

3. **Local models are good enough now.** whisper.cpp transcribes in real time
   on Apple Silicon; sherpa-onnx diarizes; any Ollama model writes the notes.
   Nothing needs to leave the machine — which means no accounts, no telemetry,
   no vendor, no monthly fee, and you can record things you'd never send to a
   SaaS.

4. **The meeting is also on screen.** While recording, the meeting window
   shows participant names on tiles and outlines whoever is speaking. Capture
   one frame per second, OCR it locally, track the highlight border, and you
   can auto-name the diarized voice clusters — "Speaker 2" becomes "Tom Chen"
   with zero clicks.

Everything is **plain files** the user owns: each meeting is a folder of
markdown + JSON + WAV. No database. This makes backup, grep, deletion, audit,
and the MCP server (§9) trivial.

> ⚖️ Recording calls has legal and social rules. Tell people you're recording;
> check local law and company policy. Build that reminder into your README.

## 2. The stack we used (and why)

| Piece | Tool | Why |
|---|---|---|
| Audio capture | Swift + ScreenCaptureKit (~400 lines) | Only sane way to get system audio + mic on macOS; needs macOS 15+ for `SCStreamConfiguration.captureMicrophone` |
| Transcription | `whisper-cli` from whisper.cpp (Homebrew) | Local, fast, battle-tested; `small.en` is the speed/quality sweet spot |
| Diarization | sherpa-onnx (npm `sherpa-onnx-node`) + pyannote segmentation 3.0 + NeMo TitaNet-small embeddings | All-local ONNX pipeline; the only viable no-Python option we found |
| Notes LLM | Ollama, any model (`/api/chat`, streaming NDJSON) | Local; endpoint/model configurable so any OpenAI-ish server works |
| Window vision | Swift + ScreenCaptureKit + Apple Vision OCR (~370 lines) | On-device OCR is shockingly good; no model download |
| Daemon | Node 18+, **zero framework** — `http` + `ws` only | Whole server is ~2,400 lines; two npm deps total (`ws`, `sherpa-onnx-node`) |
| UI | One static HTML page, vanilla JS, no build step | Live view over WebSocket; keeps the project auditable |
| Agent access | MCP server, zero-dep, stdio + HTTP transports | Reads the data folder directly, works with the daemon down |

The "no framework, no build step" choice is deliberate: the pitch is
*private and auditable*, and 2,400 total lines with two dependencies is
something a user can actually read.

## 3. Build order

Build it in this order; each stage is independently useful and testable.

1. **Capture helper** (Swift): stereo PCM on stdout. Test with
   `./audiocap > test.raw` while playing music; inspect in Audacity.
2. **Daemon + live transcription**: spawn the helper, chunk each channel,
   shell out to whisper, stream segments over WebSocket. You now have live
   captions labeled Me/Them — already useful.
3. **Notes**: a textarea for rough notes during the call + a Generate button
   that sends transcript + notes to Ollama and streams back markdown.
   **This is the Granola trick and the actual product** — the user's fragments
   say what mattered; the transcript supplies the detail.
4. **Keep the WAV + diarize on stop**: cluster the right channel into
   Speaker 1/2/3, rename chips in the UI.
5. **Vision watcher**: OCR the meeting window, active-speaker timeline, fuse
   with the clusters to auto-name speakers. Also: per-meeting snapshots.
6. **Calendar awareness**: attach the current event's attendees/description
   as LLM context.
7. **MCP server** so your agent can search/read every call.
8. **Reliability layer**: watchdog, respawn-with-backoff, permission
   preflight + loud alarm. Boring, and it's what makes the thing trustworthy
   enough to rely on for real meetings.

The rest of this doc is the accumulated knowledge for each stage — mostly
things that cost us real debugging time. **Read §4 and §8 even if you skim the
rest; the capture and permission gotchas are the ones that silently ruin
recordings.**

## 4. Audio capture (the Swift helper)

One small CLI: captures system audio + mic via ScreenCaptureKit, emits
**16 kHz stereo s16le PCM on stdout** (L = mic, R = system), single-line JSON
diagnostics on stderr. The daemon spawns it per recording and reads stdout.
Keep the helper dumb; all intelligence lives in the daemon.

Hard-won details:

- **SCK wants a video config even for audio-only.** Set `width=2, height=2,
  minimumFrameInterval=1fps` and never read the frames. Set
  `excludesCurrentProcessAudio = true` (or you'll capture your own alert
  sounds).
- **Extract samples via `CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer`**
  — the two-call size-then-fill dance. That's the layout SCK actually
  delivers; simpler APIs hand you garbage.
- **Do not assume int16 mic input.** External mics deliver what they feel
  like: a Blue Yeti X delivers **32-bit integer** PCM; 24-bit packed exists
  too. Reading int32 as int16 turns speech into constant white noise. Branch
  on `mBitsPerChannel` and `kAudioFormatFlagIsFloat`, and handle interleaved
  vs. per-channel-buffer layouts (downmix to mono by averaging).
- **Resample with state carried across buffers.** A naive per-buffer linear
  resampler leaves a discontinuity at every buffer boundary — an audible tick
  bed that measurably worsens whisper output. Keep the fractional read
  position and the last sample across calls.
- **The mixer must survive one source going stale.** Emit on a 100 ms timer:
  interleave the min(common length) of both queues. If one side has produced
  nothing for 1.5 s (muted device, denied mic, AirPods profile switch), pass
  the other through with zeros in the missing channel — otherwise a dead mic
  deadlocks the whole recording forever.
- **`signal(SIGPIPE, SIG_IGN)` and exit(0) when `write(1,…)` fails** —
  stdout closing is how the helper learns its parent died.
- A healthy capture streams **continuously — silence is still bytes**. This
  invariant is what makes the watchdog and preflight (§8) possible, so don't
  optimize it away.

## 5. Live transcription (the daemon side)

Split the interleaved stereo into two mono streams, chunk each independently,
and shell out to `whisper-cli` per chunk (`-nt --no-prints -t <threads>`,
write a temp WAV, delete after). Serialize all whisper runs through one
promise queue — two channels racing for cores is slower than taking turns.

- **Cut chunks at the quietest moment,** not at fixed intervals. Buffer at
  least `chunkSeconds` (12 s), then scan the last third of the buffer with a
  300 ms energy window and cut at the minimum; force-cut at 2× chunk size.
  Words stop getting split in half; it's the difference between a usable and
  an annoying live transcript.
- **Skip near-silent chunks** (mean |sample| < ~60): while you're just
  listening, your mic channel is silence, and whisper *will* hallucinate on
  silence.
- **Filter whisper's hallucination catalogue** from the output: lines that
  are entirely `(parenthetical)` / `[bracketed]` sound descriptions, `*…*`,
  and the classics "Thank you." / "Thanks for watching!" on quiet audio.
- **Echo gate** — the one non-obvious signal-processing trick. On laptop
  speakers, the mic hears the meeting audio, so remote speech gets duplicated
  into "Me" chunks. Full AEC is overkill; instead compute a 10 ms RMS loudness
  envelope (100 frames/s) of the whole system stream on a global timeline, and
  for each mic chunk take the Pearson correlation of its envelope against the
  system envelope at the same timestamps, over lags 0–300 ms. **Correlation
  > 0.65 → the chunk is speaker bleed; drop it.** Guard rails: need ≥0.5 s of
  signal, and the system side must actually contain audio. A full hour of
  envelope is ~3 MB — just keep it all in memory.
- Timestamps: track each chunk's start offset yourself (`consumedSec`);
  whisper's own timestamps are per-chunk and useless to you (`-nt`).
- Append each segment `{t, end, who: "me"|"them", text}` to
  `transcript.json` as it lands, and push it over the WebSocket.

Also write the raw stereo stream to `audio.wav` as it arrives (write a
44-byte header with zero sizes, patch the RIFF/data sizes on stop). Stereo
16 kHz is ~230 MB/hour; make keeping it a config flag. Downstream readers
must tolerate the zero-size header — a recording in progress has one.

## 6. Diarization + naming

On stop, diarize **only the right channel** (remote side) with sherpa-onnx:
pyannote segmentation + TitaNet-small embeddings, agglomerative clustering.
Run it in a **child process** — it's synchronous and CPU-pinning.

- **The clustering `threshold` is the whole game: use ~1.1, not the
  example default of 0.5.** At 0.5 a real 5-person, 3-hour call shattered into
  34 clusters. At 1.1 it came out exactly right. Expose it in config
  (lower = more speakers).
- `minDurationOn: 0.3, minDurationOff: 0.5`.
- Label transcript segments by **dominant time-overlap** with the diarized
  turns; display ids 1-based ("Speaker 1"). Unmatched segments just stay
  "Them" — never guess.
- UI: one chip per speaker; click to type the real name. **A user-typed name
  is sacred — nothing may ever overwrite it** (track which names were
  auto-assigned so auto-naming may revise only its own work).

## 7. The vision watcher (the flashiest part — and optional)

A second Swift helper: find the window whose title/app matches a meeting app
(`meet`, `zoom`, `teams`, `webex`), capture ~1 fps via SCK, and per frame emit
JSON: all OCR'd text with normalized [0,1] positions (Apple Vision), bounding
rects of active-speaker highlight pixels (color match on a coarse 64×36 grid,
clustered), detected faces, and a downscaled JPEG. The daemon turns that into
a participant roster + a "who was visually speaking when" timeline, and fuses
it with the voice clusters.

What we learned, in descending order of pain:

- **OCR junk management is 80% of the work.** Filters that earned their
  place: a ~40-entry stoplist of UI words ("Mute", "You're presenting",
  Meet's people-panel copy…); require capitalization (tile names are
  capitalized, page copy isn't); reject >4 words and sentence-case strings;
  in **browser** windows ignore the top 12% of the frame (tab titles + URL
  bar + bookmarks OCR into phantom "participants" every single frame).
- **Merge OCR variants.** The same name reads differently frame to frame
  ("Sov", "SOV -", "Sov-"; "ustin griffith"). Normalize (lowercase, strip
  trailing punctuation and "(You)"), then fold near-duplicates: substring
  containment, ≥80% common prefix, or Levenshtein ≤ 1–2. Keep per-variant
  counts and display the most-seen spelling.
- **Roster admission is frame-count based**: a real participant's tile is on
  screen for a sustained stretch; misreads and popups rack up a handful of
  frames. Threshold ≈ 2% of the max count (clamped 2–30).
- **The window-title trap**: the meeting title is painted on screen ("SPP3
  Interview (JustaLab)") and racks up frames like a participant. Drop roster
  keys the window title contains — *unless* they showed tile evidence (a
  paired face or a speaking highlight), because 1:1 call titles name the
  actual participants.
- **Active speaker** = the name inside the *smallest* highlight rect that
  contains exactly one name. Merge per-second samples into intervals (gap
  ≤ 2.5 s), drop intervals < 1 s.
- **Highlight colors drift.** Google shipped a new Meet border color
  (#a8c7fa) that matched zero pixels of our original list. Make the color
  list + tolerance config, and build a **fake meeting page** (a local HTML
  page cycling a highlight border between two named tiles) so the whole
  pipeline is testable without a real call.
- **Browser tab-switching**: SCK keeps streaming the *window*, so when the
  user checks Twitter mid-meeting in the same window, you OCR Twitter into
  the roster. Re-check the window title every ~4 s and pause OCR while it
  doesn't look like a meeting. Score candidate windows (real meeting app >
  browser tab; whole-word title match only — "meet" must not match "meeting
  notes").
- **Fusion rule** (voice cluster ↔ visual timeline): accumulate
  overlap-seconds per (cluster, name); assign only if best ≥ 3 s **and**
  ≥ 1.5× the runner-up, and the name is on the roster. When vision names two
  clusters the same person, they *are* the same person — diarization split
  one voice; merge the clusters (keep the one with more talk time).
- **Faces** (optional garnish): Vision face detection, pair each face to the
  name label *below* it on the same tile, nearest-gap first, one-to-one.
  Require ≥3 consistent votes before saving a crop. Great for "who did I
  talk to" recall.
- **Snapshots** (cheap, delightful): keep a bounded reservoir of full frames
  — every N seconds, and when full, drop every other one and double N — so a
  20-minute call and a 3-hour call both end with ~5 well-spaced JPEGs under
  the notes. Wait ~45 s before the first (skips the join screen). A manual
  📸 button pins the current frame, exempt from thinning.

Privacy note that keeps the feature defensible: frames are pixels-in,
JSON-out; nothing but the handful of chosen snapshots is ever written.

## 8. Reliability: permissions are your #1 failure mode

macOS ties the Screen Recording + Microphone grants to **whatever launched
the daemon**. This causes every one of these real failures:

- Launch from a terminal → the grant belongs to that terminal app. Launch
  differently later → macOS asks again, or worse, **silently records
  nothing**.
- **The wedge**: after a reboot (or a TCC re-validation), Settings still shows
  the grant ON but capture delivers zero frames. No API call can fix it —
  only a human toggling the grant OFF/ON in System Settings. You cannot
  repair this; you can only *detect it and get loud*.
- GUI-launched apps don't inherit your shell's PATH — a bare `whisper-cli`
  spawn dies with ENOENT from an .app-launched daemon even though the
  terminal works fine. **Resolve helper binaries to absolute paths**
  (`/opt/homebrew/bin`, `/usr/local/bin`, then PATH fallback).

The countermeasures, all of which we ship:

1. **A tiny .app bundle launcher** (a 15-line shell script in
   `Contents/MacOS/`) that starts the daemon the same way every time and
   opens the UI — so the grant attaches to one stable identity and survives
   reboots and updates.
2. **Preflight probe**: run the capture helper for a few seconds and count
   stdout bytes. Because silence is still bytes, ≥0.5 s of PCM = healthy;
   zero bytes = the grant is wedged. Run it at boot and shortly before
   calendar events.
3. **Loud alarm when dead**: macOS notification + modal dialog
   (`osascript`) + open the exact Settings pane
   (`open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"`)
   + an optional user shell hook. File-backed cooldown (~10 min), because the
   daemon may restart during handling. Re-probe every minute; notify again
   when healed. The UI mirrors it with an unmissable "NO RECORDING
   PERMISSION" state on the record button.
4. **In-recording watchdog**: no stdout bytes for 6 s → kill and respawn the
   helper once; still nothing → declare capture dead (alarm). Separately,
   `SCStream.startCapture` flakes transiently (device churn — AirPods
   switching profiles right as the meeting starts), so respawn a dying helper
   with exponential backoff (~8 tries / 75 s) before giving up — and reset
   the failure streak once audio has actually flowed, so a mid-meeting crash
   gets fresh retries.

Do these before the fancy features. A note-taker that silently records
nothing once is a note-taker nobody trusts again.

## 9. Notes generation, calendar, MCP, storage

**Notes.** One system prompt (see `server/summarize.js`): summary → key
points → decisions → action items with owners; weave in the user's rough
notes as the signal of what mattered; "silently correct obvious recognition
errors"; "do not invent". Send the transcript with `[m:ss] Name:` line
prefixes. Stream tokens to the UI. Strip `<think>…</think>` — reasoning
models leak it. **Watch RAM**: a 35B model alongside Chrome + friends
swap-thrashed a 24 GB machine into uselessness; default to something like
`qwen3:4b` and let power users upgrade.

**Calendar** (context, not control): "what event is on right now" (running,
or starting within ~20 min) gives you the invite's attendees + description as
LLM context — correct name spellings for free. Two local sources: **EventKit**
via a third tiny Swift helper (works if macOS Calendar syncs the account), or
— the trick that needs no API keys, no OAuth app — **clone the user's
logged-in Chrome profile once** and drive a headless Chrome against
calendar.google.com, scraping via CDP. If their browser can see the calendar,
the scribe can. Strip HTML from descriptions and cap length; Meet invites are
join-info boilerplate soup.

**Titles: decide your policy and enforce it totally.** We first auto-named
meetings (calendar title, then AI naming) — and an auto-title overwrote a
name the user had typed by hand. The fix was philosophical, not technical:
**titles are manual-only, full stop.** Whatever you choose, mixed authority
over one field is the bug; give every field exactly one writer.

**Storage.** `data/meetings/<id>/` with `meta.json` (title, times, speaker
names, calendar event), `transcript.json`, `notes.md` (user's), `summary.md`
(generated), `audio.wav`, `vision.json`, `shots/*.jpg`, `faces/*.jpg`.
Write JSON atomically (temp file + rename) — the daemon gets killed at
arbitrary times. Full-text search is a grep across those files at request
time; at personal scale you need no index.

**MCP server** — turns the archive into agent memory, and it's ~250
dependency-free lines: tools `search_meetings` (multi-word = all words
match), `list_meetings`, `get_meeting`, `get_transcript` (paged). Read the
data folder directly so it works with the daemon down (stdio transport), and
also serve MCP over HTTP from the daemon at `/mcp` so hooking it up is one
`claude mcp add --transport http` line. Give the UI a "Connect Claude" button
that prints the exact command with absolute paths filled in — and use the
LAN URL, not localhost, so it works from other machines. Remember: GUI-app
MCP configs need an absolute `node` path.

## 10. What works well / honest weaknesses

Works well: me/them attribution (ground truth by construction) · live
transcript ~15 s behind · notes from transcript + rough fragments (the
product) · diarization at threshold 1.1 · vision auto-naming on Meet when the
tab stays active · echo gate · MCP + agent search · the reliability layer
(§8) has caught real wedges before real meetings · snapshots.

Weaknesses to be honest about in your README: vision assumes the meeting tab
is the active tab of its window · highlight colors drift with meeting-app
redesigns (config, not code, is the mitigation) · diarization on far-end
compressed audio is decent, not perfect — the manual rename chip must stay ·
whisper `small.en` mangles names/jargon (the calendar-invite context helps
the LLM fix spellings) · no auth on the HTTP API (bind 127.0.0.1 on untrusted
networks) · not encrypted at rest (FileVault) · macOS-only.

## 11. Shopping list

Hardware: Apple Silicon Mac, macOS 15+, 16 GB RAM (whisper `small.en` +
qwen3:4b fit comfortably; leave headroom for the meeting itself).

Software: Xcode CLT (`swiftc`) · Homebrew: `whisper-cpp`, `ollama` · Node 18+
· npm: `ws`, `sherpa-onnx-node`.

Models: `ggml-small.en.bin` (Hugging Face, ~466 MB) ·
`sherpa-onnx-pyannote-segmentation-3-0` + `nemo_en_titanet_small.onnx`
(sherpa-onnx GitHub releases, ~30 MB) · an Ollama chat model of your choice.

Permissions: Screen Recording + Microphone (to the launcher, once —
see §8) · Calendar only if using EventKit.

## 12. Rebranding + a v1 cut

Rebrand: name, mascot, favicon, CSS accent colors, the .app bundle name (it's
what shows in the permission panes), MCP server name, data dir. That's the
whole surface — nothing else knows the brand.

A solid v1 is stages 1–4 (§3): capture, live Me/Them transcript, notes
generation, diarization + rename chips — with the §8 reliability layer.
Vision, calendar, faces, snapshots, and MCP are all additive; none is load-
bearing. Ship the honest version of the privacy pitch: local-only, plain
files, tiny auditable codebase, tell-people-you're-recording.

Go build it. The reference implementation behind this document is
github.com/clawdbotatg/clawd-scribe (MIT) — steal any of it.
