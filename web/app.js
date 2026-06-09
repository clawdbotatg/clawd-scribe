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
  for (const m of state.meetings) {
    const div = document.createElement("div");
    div.className =
      "meeting-item" +
      (state.current && state.current.meta.id === m.id ? " active" : "");
    div.innerHTML = `
      <span class="t">${esc(m.title)}</span>
      <span class="d">${fmtDate(m.startedAt)}${m.durationSec ? " · " + fmtTime(m.durationSec) : ""}${m.status === "recording" ? " · ● rec" : ""}</span>
      <button class="del" title="delete">✕</button>`;
    div.onclick = () => openMeeting(m.id);
    div.querySelector(".del").onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete "${m.title}"?`)) return;
      await api("DELETE", "meetings/" + m.id);
      if (state.current && state.current.meta.id === m.id) showEmpty();
      await refreshMeetings();
    };
    el.appendChild(div);
  }
}

// stable colors: "me" is always green; remote speakers get a palette color
const SPK_COLORS = ["#6cb6ff", "#f69d50", "#dcbdfb", "#ef9eaa", "#7ce38b", "#fbd669"];
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
    chip.innerHTML = `<span class="dot" style="background:${speakerColor(key)}"></span>`;
    const input = document.createElement("input");
    input.value = speakerName(key);
    input.title = "Click to rename";
    input.onchange = async () => {
      const speakers = { ...(state.current.meta.speakers || {}) };
      speakers[key] = input.value.trim() || speakerName(key);
      state.current.meta.speakers = speakers;
      await api("PUT", `meetings/${state.current.meta.id}/speakers`, { speakers });
      renderTranscript();
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
  renderSummary();
  renderMeetingList();
}

async function refreshMeetings() {
  state.meetings = await api("GET", "meetings");
  renderMeetingList();
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
      if (msg.watching) $("watchBadge").textContent = "👁 " + (msg.title || "meeting window");
      break;
    case "diarizeError":
      $("diarizeBtn").disabled = false;
      $("diarizeBtn").textContent = "👥 Identify speakers";
      toast("Speaker identification failed: " + msg.message);
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
