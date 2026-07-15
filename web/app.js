// clawd-scribe web UI — vanilla JS, talks to the local daemon over REST + WebSocket.
const $ = (id) => document.getElementById(id);

let state = {
  meetings: [],
  current: null, // full meeting object {meta, transcript, notes, summary}
  recording: false,
  recordingMeetingId: null,
  recStart: null,
  generatingFor: null,
  streamBuf: "",
  search: "",        // current search query ("" = show full list)
  searchResults: [], // results from /api/search when search is active
};

// --- tiny markdown renderer (headers, bullets, bold/italic/code, checkboxes) ---
function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/\*([^*]+)\*/g, "<i>$1</i>");
}
function renderMd(md) {
  const lines = md.split("\n");
  let html = "";
  let inList = false;
  const closeList = () => { if (inList) { html += "</ul>"; inList = false; } };
  for (const line of lines) {
    const h = line.match(/^(#{1,4})\s+(.*)/);
    const li = line.match(/^\s*[-*]\s+(?:\[([ xX])\]\s+)?(.*)/);
    if (h) {
      closeList();
      const lvl = Math.min(h[1].length + 1, 4);
      html += `<h${lvl}>${inline(h[2])}</h${lvl}>`;
    } else if (li) {
      if (!inList) { html += "<ul>"; inList = true; }
      const box = li[1] !== undefined ? (li[1].trim() ? "☑ " : "☐ ") : "";
      html += `<li>${box}${inline(li[2])}</li>`;
    } else if (line.trim() === "") {
      closeList();
    } else {
      closeList();
      html += `<p>${inline(line)}</p>`;
    }
  }
  closeList();
  return html;
}

function fmtTime(sec) {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}
function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    " · " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function toast(msg, info) {
  const t = $("toast");
  t.textContent = msg;
  t.className = info ? "info" : "";
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), 5000);
}

// --- API ---
async function api(method, path, body) {
  const res = await fetch("/api/" + path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// --- rendering ---
function renderMeetingList() {
  const el = $("meetings");
  el.innerHTML = "";
  const searching = !!state.search;
  const items = searching ? state.searchResults : state.meetings;
  if (searching && !items.length) {
    el.innerHTML = `<div class="no-results">No meetings match “${esc(state.search)}”.</div>`;
    return;
  }
  for (const m of items) {
    const div = document.createElement("div");
    div.className =
      "meeting-item" +
      (state.current && state.current.meta.id === m.id ? " active" : "");
    const hit = searching && m.snippet
      ? `<span class="snip"><span class="where">${esc(m.matchIn)}</span> ${esc(m.snippet)}</span>`
      : "";
    div.innerHTML = `
      <span class="t">${esc(m.title)}</span>
      <span class="d">${fmtDate(m.startedAt)}${m.durationSec ? " · " + fmtTime(m.durationSec) : ""}${m.status === "recording" ? " · ● rec" : ""}</span>
      ${hit}
      <button class="del" title="delete">✕</button>`;
    div.onclick = () => openMeeting(m.id);
    div.querySelector(".del").onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete "${m.title}"?`)) return;
      await api("DELETE", "meetings/" + m.id);
      if (state.current && state.current.meta.id === m.id) showEmpty();
      if (searching) await runSearch(state.search);
      await refreshMeetings();
    };
    el.appendChild(div);
  }
}

// --- search ---
let searchTimer = null;
async function runSearch(q) {
  state.search = q.trim();
  if (!state.search) {
    state.searchResults = [];
    renderMeetingList();
    return;
  }
  try {
    state.searchResults = await api("GET", "search?q=" + encodeURIComponent(state.search));
  } catch (e) {
    state.searchResults = [];
    toast("Search failed: " + e.message);
  }
  renderMeetingList();
}

// stable colors: "me" is always green; remote speakers get a palette color
const SPK_COLORS = ["#2c6cb0", "#c05a1f", "#7c4dab", "#b03a52", "#2e7d44", "#8f7415"];
function speakerKey(s) {
  if (s.who === "me") return "me";
  if (s.speaker != null) return String(s.speaker);
  return s.who ? "them" : null;
}
function speakerColor(key) {
  if (key === "me") return "var(--green)";
  if (key === "them" || key === null) return "var(--dim)";
  return SPK_COLORS[(parseInt(key, 10) - 1) % SPK_COLORS.length];
}
function speakerName(key) {
  const speakers = (state.current && state.current.meta.speakers) || {};
  if (key === "me") return speakers.me || "Me";
  if (key === "them") return "Them";
  return speakers[key] || "Speaker " + key;
}

function renderTranscript() {
  const el = $("transcript");
  el.innerHTML = "";
  for (const s of state.current.transcript) {
    const div = document.createElement("div");
    div.className = "seg";
    const key = speakerKey(s);
    const spk = key
      ? `<span class="spk" style="color:${speakerColor(key)}">${esc(speakerName(key))}</span>`
      : "";
    div.innerHTML = `<span class="ts">${fmtTime(s.t)}</span>${spk}${esc(s.text)}`;
    el.appendChild(div);
  }
  el.scrollTop = el.scrollHeight;
}

function renderSpeakers() {
  const el = $("speakers");
  el.innerHTML = "";
  if (!state.current) return;
  // talk time per speaker key, from segment durations
  const time = new Map();
  for (const s of state.current.transcript) {
    const key = speakerKey(s);
    if (!key) continue;
    const dur = (s.end != null ? s.end : s.t + 12) - s.t;
    time.set(key, (time.get(key) || 0) + dur);
  }
  const keys = [...time.keys()].sort((a, b) => {
    if (a === "me") return -1;
    if (b === "me") return 1;
    return a.localeCompare(b, undefined, { numeric: true });
  });
  for (const key of keys) {
    if (key === "them") continue; // unclustered remote audio gets no chip
    const chip = document.createElement("div");
    chip.className = "speaker-chip";
    const face = key === "them" ? null : rosterFace(speakerName(key));
    chip.innerHTML = face
      ? `<img class="face" src="${face}" alt="" />`
      : `<span class="dot" style="background:${speakerColor(key)}"></span>`;
    const input = document.createElement("input");
    input.value = speakerName(key);
    input.title = "Click to rename";
    input.onchange = async () => {
      const speakers = { ...(state.current.meta.speakers || {}) };
      speakers[key] = input.value.trim() || speakerName(key);
      state.current.meta.speakers = speakers;
      await api("PUT", `meetings/${state.current.meta.id}/speakers`, { speakers });
      renderTranscript();
      renderSpeakers(); // a rename can match a rostered face
    };
    chip.appendChild(input);
    const t = document.createElement("span");
    t.className = "time";
    t.textContent = fmtTime(Math.round(time.get(key)));
    chip.appendChild(t);
    el.appendChild(chip);
  }
}

function renderSummary() {
  $("summary").innerHTML = state.current.summary
    ? renderMd(state.current.summary)
    : '<p style="color:var(--dim)">No notes yet — record or type notes, then hit Generate.</p>';
}

function rosterFace(name) {
  const v = state.current && state.current.vision;
  const entry = v && (v.roster || []).find((r) => r.face && r.name === name);
  return entry ? `/api/meetings/${state.current.meta.id}/${entry.face}` : null;
}

function renderVision() {
  const el = $("visionInfo");
  const v = state.current && state.current.vision;
  el.classList.toggle("hidden", !v);
  if (!v) return;
  if (!v.windowTitle) {
    el.textContent = "👁 no meeting window found — names weren't read";
    return;
  }
  const roster = v.roster || [];
  const hl = (v.speaking || []).length
    ? `${v.speaking.length} active-speaker intervals`
    : "no active-speaker highlights";
  let html = `<div class="vision-line">👁 watched “${esc(v.windowTitle)}”${
    v.windowApp ? ` (${esc(v.windowApp)})` : ""
  } — ${roster.length ? `saw ${roster.length} participant${roster.length === 1 ? "" : "s"}` : "no participant names recognized"} · ${hl}</div>`;
  if (roster.length) {
    html += `<div class="vision-roster">` + roster.slice(0, 12).map((r) => {
      const img = r.face
        ? `<img src="/api/meetings/${state.current.meta.id}/${r.face}" alt="" />`
        : `<span class="noface">👤</span>`;
      return `<span class="vision-person">${img}${esc(r.name)}</span>`;
    }).join("") + `</div>`;
  }
  el.innerHTML = html;
}

function showEmpty() {
  state.current = null;
  $("meeting").classList.add("hidden");
  $("empty").classList.remove("hidden");
  renderMeetingList();
}

async function openMeeting(id) {
  state.current = await api("GET", "meetings/" + id);
  state.streamBuf = "";
  $("empty").classList.add("hidden");
  $("meeting").classList.remove("hidden");
  $("title").value = state.current.meta.title;
  const meta = state.current.meta;
  $("meetingMeta").textContent =
    fmtDate(meta.startedAt) + (meta.durationSec ? " · " + fmtTime(meta.durationSec) : "");
  $("notes").value = state.current.notes;
  $("liveBadge").classList.toggle("hidden", meta.id !== state.recordingMeetingId);
  renderTranscript();
  renderSpeakers();
  renderVision();
  renderSummary();
  renderMeetingList();
}

async function refreshMeetings() {
  state.meetings = await api("GET", "meetings");
  if (state.search) await runSearch(state.search);
  else renderMeetingList();
}

// --- recording controls ---
$("recordBtn").onclick = async () => {
  try {
    const meeting = await api("POST", "record/start", {});
    state.recording = true;
    state.recordingMeetingId = meeting.id;
    state.recStart = Date.now();
    updateRecUI();
    await refreshMeetings();
    await openMeeting(meeting.id);
  } catch (e) {
    toast(e.message);
  }
};

$("copyBtn").onclick = async () => {
  if (!state.current) return;
  const m = state.current;
  const lines = [`# ${m.meta.title}`, fmtDate(m.meta.startedAt), ""];
  for (const s of m.transcript) {
    const key = speakerKey(s);
    lines.push(`[${fmtTime(s.t)}] ${key ? speakerName(key) : "?"}: ${s.text.trim()}`);
  }
  if (m.notes && m.notes.trim()) lines.push("", "## My notes", m.notes.trim());
  if (m.summary && m.summary.trim()) lines.push("", "## Generated notes", m.summary.trim());
  try {
    await navigator.clipboard.writeText(lines.join("\n"));
    toast(`Copied ${m.transcript.length} segments — paste away`, true);
  } catch (e) {
    toast("Copy failed: " + e.message);
  }
};

$("stopBtn").onclick = async () => {
  $("stopBtn").disabled = true;
  try {
    await api("POST", "record/stop");
  } catch (e) {
    toast(e.message);
  }
  $("stopBtn").disabled = false;
};

function updateRecUI() {
  $("recordBtn").classList.toggle("hidden", state.recording);
  $("recState").classList.toggle("hidden", !state.recording);
  if (state.current) {
    $("liveBadge").classList.toggle(
      "hidden",
      !state.recording || state.current.meta.id !== state.recordingMeetingId
    );
  }
}

setInterval(() => {
  if (state.recording && state.recStart) {
    $("recTimer").textContent = fmtTime(Math.round((Date.now() - state.recStart) / 1000));
  }
}, 500);

// --- notes autosave ---
let saveTimer = null;
$("notes").addEventListener("input", () => {
  if (!state.current) return;
  $("saveState").textContent = "…";
  clearTimeout(saveTimer);
  const id = state.current.meta.id;
  const val = $("notes").value;
  saveTimer = setTimeout(async () => {
    await api("PUT", `meetings/${id}/notes`, { notes: val });
    $("saveState").textContent = "saved";
    setTimeout(() => ($("saveState").textContent = ""), 1500);
  }, 600);
});

// --- title edit ---
$("title").addEventListener("change", async () => {
  if (!state.current) return;
  await api("PUT", `meetings/${state.current.meta.id}/title`, { title: $("title").value });
  await refreshMeetings();
});

// --- AI name the meeting ---
$("nameBtn").onclick = async () => {
  if (!state.current) return;
  const btn = $("nameBtn");
  btn.disabled = true;
  btn.textContent = "naming…";
  try {
    const { title } = await api("POST", `meetings/${state.current.meta.id}/retitle`);
    $("title").value = title;
    state.current.meta.title = title;
    await refreshMeetings();
    toast(`Named “${title}”`, true);
  } catch (e) {
    toast("Naming failed: " + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "✨ Name";
  }
};

// --- search box ---
$("search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  const q = $("search").value;
  searchTimer = setTimeout(() => runSearch(q), 200);
});

// --- generate notes ---
$("generateBtn").onclick = async () => {
  if (!state.current) return;
  try {
    await api("POST", `meetings/${state.current.meta.id}/generate`);
  } catch (e) {
    toast(e.message);
  }
};

// --- identify speakers ---
$("diarizeBtn").onclick = async () => {
  if (!state.current) return;
  try {
    await api("POST", `meetings/${state.current.meta.id}/diarize`);
  } catch (e) {
    toast(e.message);
  }
};

// --- connect Claude (MCP install snippets) ---
function connectBlocks({ serverPath, nodePath }) {
  const desktopConfig = JSON.stringify(
    { mcpServers: { "clawd-scribe": { command: nodePath, args: [serverPath] } } },
    null,
    2
  );
  const skill = [
    "# clawd-scribe — my recorded calls",
    "All my phone calls and meetings are recorded locally by clawd-scribe and exposed",
    "through the `clawd-scribe` MCP server. When I ask about a past call, meeting, or",
    "conversation, use its tools:",
    "- `search_meetings(query)` — full-text search over titles, people, notes, summaries, transcripts. Start here.",
    "- `list_meetings(limit, offset)` — recent calls, newest first.",
    "- `get_meeting(id)` — one call's participants, my notes, and the generated summary.",
    "- `get_transcript(id, offset)` — the word-for-word transcript (paged; only when exact wording matters).",
    '"Me" in transcripts is always me; other speakers are named when identified.',
  ].join("\n");
  return [
    {
      title: "Claude Code",
      hint: "run this once in any terminal",
      text: `claude mcp add --scope user clawd-scribe -- ${sh(nodePath)} ${sh(serverPath)}`,
    },
    {
      title: "Claude Desktop",
      hint: "merge into ~/Library/Application Support/Claude/claude_desktop_config.json, then restart Claude Desktop",
      text: desktopConfig,
    },
    {
      title: "Skill / instructions (optional)",
      hint: "paste into your Claude project instructions or CLAUDE.md so it knows when to reach for these tools",
      text: skill,
    },
  ];
}
function sh(p) {
  return /[^A-Za-z0-9_\/.-]/.test(p) ? `'${p.replace(/'/g, `'\\''`)}'` : p;
}

$("connectClaudeBtn").onclick = async () => {
  const wrap = $("connectBlocks");
  wrap.innerHTML = "";
  let info;
  try {
    info = await api("GET", "mcp");
  } catch {
    wrap.innerHTML = `<p class="modal-intro">This daemon predates the MCP endpoint — restart clawd-scribe (it self-updates on start) and try again.</p>`;
    $("connectModal").classList.remove("hidden");
    return;
  }
  for (const b of connectBlocks(info)) {
    const div = document.createElement("div");
    div.className = "connect-block";
    div.innerHTML = `<div class="connect-head"><b>${esc(b.title)}</b><span class="hint">${esc(b.hint)}</span>
      <button class="copy-snippet">⧉ Copy</button></div><pre></pre>`;
    div.querySelector("pre").textContent = b.text;
    div.querySelector(".copy-snippet").onclick = async (e) => {
      await navigator.clipboard.writeText(b.text);
      e.target.textContent = "✓ copied";
      setTimeout(() => (e.target.textContent = "⧉ Copy"), 1500);
    };
    wrap.appendChild(div);
  }
  $("connectModal").classList.remove("hidden");
};
$("connectClose").onclick = () => $("connectModal").classList.add("hidden");
$("connectModal").onclick = (e) => {
  if (e.target === $("connectModal")) $("connectModal").classList.add("hidden");
};

// --- websocket ---
function connectWS() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    handleWS(msg);
  };
  ws.onclose = () => setTimeout(connectWS, 1500);
}

function handleWS(msg) {
  switch (msg.type) {
    case "status":
      state.recording = msg.recording;
      state.recordingMeetingId = msg.meeting ? msg.meeting.id : null;
      if (msg.recording && msg.meeting) {
        state.recStart = new Date(msg.meeting.startedAt).getTime();
      }
      updateRecUI();
      if (msg.watcher) handleWS({ type: "watcher", ...msg.watcher });
      break;
    case "level":
      $("levelBar").style.width = Math.min(100, msg.rms * 350) + "%";
      break;
    case "segment":
      if (state.current && state.current.meta.id === msg.meetingId) {
        state.current.transcript.push(msg.segment);
        renderTranscript();
        renderSpeakers();
      }
      break;
    case "diarizeStart":
      if (state.current && state.current.meta.id === msg.meetingId) {
        $("diarizeBtn").disabled = true;
        $("diarizeBtn").textContent = "identifying…";
      }
      break;
    case "diarizeDone":
      $("diarizeBtn").disabled = false;
      $("diarizeBtn").textContent = "👥 Identify speakers";
      if (state.current && state.current.meta.id === msg.meetingId) {
        openMeeting(msg.meetingId);
        const auto = Object.values(msg.autoNames || {});
        toast(
          auto.length
            ? `Found ${msg.speakerCount} speaker${msg.speakerCount === 1 ? "" : "s"} — auto-named: ${auto.join(", ")}`
            : `Found ${msg.speakerCount} remote speaker${msg.speakerCount === 1 ? "" : "s"} — click a chip to name them.`,
          true
        );
      }
      break;
    case "watcher":
      $("watchBadge").classList.toggle("hidden", !msg.watching);
      if (msg.watching)
        $("watchBadge").textContent =
          "👁 " + (msg.title || "meeting window") + (msg.app ? ` (${msg.app})` : "");
      break;
    case "diarizeError":
      $("diarizeBtn").disabled = false;
      $("diarizeBtn").textContent = "👥 Identify speakers";
      toast("Speaker identification failed: " + msg.message);
      break;
    case "titleUpdated":
      if (state.current && state.current.meta.id === msg.meetingId) {
        state.current.meta.title = msg.title;
        $("title").value = msg.title;
        toast(`Auto-named “${msg.title}”`, true);
      }
      refreshMeetings();
      break;
    case "speakersUpdated":
      if (state.current && state.current.meta.id === msg.meetingId) {
        state.current.meta.speakers = msg.speakers;
        renderTranscript();
        renderSpeakers();
      }
      break;
    case "meetingDone":
      state.recording = false;
      state.recordingMeetingId = null;
      updateRecUI();
      refreshMeetings();
      if (state.current && state.current.meta.id === msg.meeting.id) {
        openMeeting(msg.meeting.id);
        toast("Recording saved. Hit ✨ Generate for notes.", true);
      }
      break;
    case "recError":
      toast(msg.message);
      break;
    case "notesStart":
      state.generatingFor = msg.meetingId;
      state.streamBuf = "";
      if (state.current && state.current.meta.id === msg.meetingId) {
        $("generateBtn").disabled = true;
        $("generateBtn").textContent = "generating…";
        $("summary").innerHTML = "";
      }
      break;
    case "notesToken":
      if (state.current && state.current.meta.id === msg.meetingId) {
        state.streamBuf += msg.token;
        $("summary").innerHTML = renderMd(state.streamBuf.replace(/<think>[\s\S]*?(<\/think>|$)/, ""));
        $("summary").scrollTop = $("summary").scrollHeight;
      }
      break;
    case "notesDone":
      state.generatingFor = null;
      $("generateBtn").disabled = false;
      $("generateBtn").textContent = "✨ Generate";
      if (state.current && state.current.meta.id === msg.meetingId) {
        state.current.summary = msg.summary;
        renderSummary();
      }
      break;
    case "notesError":
      state.generatingFor = null;
      $("generateBtn").disabled = false;
      $("generateBtn").textContent = "✨ Generate";
      toast("Notes generation failed: " + msg.message);
      break;
  }
}

// --- init ---
(async () => {
  connectWS();
  await refreshMeetings();
  const status = await api("GET", "status");
  state.recording = status.recording;
  state.recordingMeetingId = status.meeting ? status.meeting.id : null;
  if (status.meeting) {
    state.recStart = new Date(status.meeting.startedAt).getTime();
    await openMeeting(status.meeting.id);
  } else if (state.meetings.length) {
    await openMeeting(state.meetings[0].id);
  }
  updateRecUI();
})();
