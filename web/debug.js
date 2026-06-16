// vision debug UI — live view of the meetwatch pipeline:
// raw frames (OCR boxes / highlight rects / faces), the growing roster,
// the visual speaking timeline, and a pipeline event log.
const $ = (id) => document.getElementById(id);

let snap = null; // last /api/watcher/debug snapshot (or vision.json fallback)
let lastFrame = null; // last watcherFrame over WS
let lastFrameWall = 0;
let frameImg = null; // latest /api/watcher/frame.jpg, drawn under the overlays
let frameImgBusy = false;

function refreshFrameImage() {
  if (frameImgBusy) return;
  frameImgBusy = true;
  const img = new Image();
  img.onload = () => {
    frameImgBusy = false;
    frameImg = img;
    drawFrame();
  };
  img.onerror = () => {
    frameImgBusy = false;
  };
  img.src = "/api/watcher/frame.jpg?t=" + Date.now();
}

// --- header chips ---
function setChip(el, text, cls) {
  el.textContent = text;
  el.className = "chip" + (cls ? " " + cls : "");
  el.classList.remove("hidden");
}

// --- event log ---
const MAX_LOG = 300;
function log(kind, text) {
  const el = document.createElement("div");
  el.className = "ln";
  const t = new Date().toLocaleTimeString();
  el.innerHTML = `<span class="t">${t}</span><span class="ev-${kind}"></span>`;
  el.lastChild.textContent = text;
  const box = $("log");
  const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 8;
  box.appendChild(el);
  while (box.children.length > MAX_LOG) box.removeChild(box.firstChild);
  if (stick) box.scrollTop = box.scrollHeight;
}

// --- live frame canvas ---
function drawFrame() {
  const canvas = $("frameCanvas");
  const wrap = $("frameWrap");
  const dpr = window.devicePixelRatio || 1;
  const W = wrap.clientWidth, H = wrap.clientHeight;
  if (!W || !H) return;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  const f = lastFrame;
  if (!f) {
    ctx.fillStyle = "#8a8f98";
    ctx.font = "13px -apple-system, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("waiting for frames…", W / 2, H / 2);
    return;
  }

  // the captured frame, letterboxed; overlay coords are normalized to the
  // frame, so map everything into its fitted rect — not the full canvas
  let ox = 0, oy = 0, fw = W, fh = H;
  if (frameImg) {
    const s = Math.min(W / frameImg.naturalWidth, H / frameImg.naturalHeight);
    fw = frameImg.naturalWidth * s;
    fh = frameImg.naturalHeight * s;
    ox = (W - fw) / 2;
    oy = (H - fh) / 2;
    ctx.drawImage(frameImg, ox, oy, fw, fh);
  }
  // text with a dark outline stays readable on top of the frame pixels
  function label(text, x, y) {
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(0,0,0,0.75)";
    ctx.strokeText(text, x, y);
    ctx.fillText(text, x, y);
  }

  // highlight candidates (faint, dashed) under everything else…
  ctx.setLineDash([5, 4]);
  for (const r of f.rects) {
    ctx.strokeStyle = "rgba(79,142,247,0.45)";
    ctx.lineWidth = 1;
    ctx.strokeRect(ox + r.x * fw, oy + r.y * fh, r.w * fw, r.h * fh);
  }
  ctx.setLineDash([]);
  // …and the one rect the pipeline matched to a speaker, bold
  if (f.activeRect) {
    const r = f.activeRect;
    ctx.fillStyle = "rgba(79,142,247,0.15)";
    ctx.strokeStyle = "#4f8ef7";
    ctx.lineWidth = 2.5;
    ctx.fillRect(ox + r.x * fw, oy + r.y * fh, r.w * fw, r.h * fh);
    ctx.strokeRect(ox + r.x * fw, oy + r.y * fh, r.w * fw, r.h * fh);
  }
  // faces (orange)
  for (const r of f.faces) {
    ctx.strokeStyle = "#f2994a";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(ox + r.x * fw, oy + r.y * fh, r.w * fw, r.h * fh);
  }
  // OCR texts: green if it passed the name filter, gray otherwise
  ctx.font = "10px ui-monospace, Menlo, monospace";
  ctx.textAlign = "left";
  for (const x of f.texts) {
    ctx.strokeStyle = x.name ? "#6fcf6f" : "rgba(138,143,152,0.6)";
    ctx.lineWidth = x.name ? 1.5 : 1;
    ctx.strokeRect(ox + x.x * fw, oy + x.y * fh, x.w * fw, x.h * fh);
    ctx.fillStyle = x.name ? "#6fcf6f" : "#aab0ba";
    label(x.s.slice(0, 40), ox + x.x * fw, Math.max(9, oy + x.y * fh - 3));
  }
  // footer: frame time + active speaker + freshness
  ctx.font = "12px -apple-system, sans-serif";
  ctx.fillStyle = "#e6e6e6";
  const age = ((Date.now() - lastFrameWall) / 1000).toFixed(0);
  let line = `t=${f.t}s · ${f.texts.length} texts · ${f.rects.length} rects · ${f.faces.length} faces · ${age}s ago`;
  label(line, 8, H - 10);
  if (f.active) {
    ctx.fillStyle = "#6fcf6f";
    ctx.font = "bold 13px -apple-system, sans-serif";
    label(`▶ speaking: ${f.active}`, 8, H - 28);
  }
}

// --- roster ---
function renderRoster(roster, note) {
  $("rosterNote").textContent = note || "";
  const box = $("roster");
  box.innerHTML = "";
  if (!roster || !roster.length) {
    box.innerHTML = '<div class="empty-note">no participants seen yet</div>';
    return;
  }
  const max = Math.max(...roster.map((p) => p.frames));
  for (const p of roster) {
    const el = document.createElement("div");
    el.className = "person";
    const face = p.face
      ? `<img src="${p.face}" alt="" />`
      : '<span class="noface">👤</span>';
    el.innerHTML = `${face}<span class="info">
        <span class="nm"></span>
        <span class="meta">${p.frames} frames${p.faceVotes ? ` · face ×${p.faceVotes}` : ""}</span>
        <span class="bar"><div style="width:${Math.round((p.frames / max) * 100)}%"></div></span>
      </span>`;
    el.querySelector(".nm").textContent = p.name;
    box.appendChild(el);
  }
}

// --- speaking timeline ---
const hue = (s) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
};
function renderTimeline(timeline, durationSec) {
  const canvas = $("timelineCanvas");
  const empty = $("tlEmpty");
  if (!timeline || !timeline.length) {
    canvas.classList.add("hidden");
    empty.classList.remove("hidden");
    return;
  }
  canvas.classList.remove("hidden");
  empty.classList.add("hidden");

  const names = [...new Set(timeline.map((iv) => iv.name))];
  const LANE = 22, LABEL = 130, AXIS = 16;
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.parentElement.clientWidth - 4;
  const H = names.length * LANE + AXIS;
  canvas.style.height = H + "px";
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  const tMax = Math.max(durationSec || 0, ...timeline.map((iv) => iv.end), 1);
  const tx = (t) => LABEL + (t / tMax) * (W - LABEL - 6);

  ctx.font = "11px -apple-system, sans-serif";
  names.forEach((name, i) => {
    const y = i * LANE;
    ctx.fillStyle = "#8d7e69";
    ctx.textAlign = "right";
    ctx.fillText(name.slice(0, 18), LABEL - 8, y + LANE / 2 + 4);
    ctx.strokeStyle = "rgba(217,202,176,0.5)";
    ctx.beginPath();
    ctx.moveTo(LABEL, y + LANE / 2);
    ctx.lineTo(W - 4, y + LANE / 2);
    ctx.stroke();
    ctx.fillStyle = `hsl(${hue(name)} 55% 55%)`;
    for (const iv of timeline) {
      if (iv.name !== name) continue;
      ctx.fillRect(tx(iv.start), y + 4, Math.max(2, tx(iv.end) - tx(iv.start)), LANE - 8);
    }
  });
  // time axis ticks
  ctx.fillStyle = "#8d7e69";
  ctx.textAlign = "center";
  const step = tMax > 1800 ? 600 : tMax > 600 ? 300 : tMax > 120 ? 60 : 30;
  for (let t = 0; t <= tMax; t += step) {
    const m = Math.floor(t / 60), s = String(Math.round(t % 60)).padStart(2, "0");
    ctx.fillText(`${m}:${s}`, tx(t), H - 3);
  }
}

// --- snapshot polling (live watcher, or last meeting's vision.json) ---
async function fallbackToSavedVision() {
  const meetings = await (await fetch("/api/meetings")).json();
  for (const m of meetings) {
    const full = await (await fetch(`/api/meetings/${m.id}`)).json();
    if (full.vision && (full.vision.roster?.length || full.vision.speaking?.length)) {
      setChip($("chipSource"), `saved vision.json — ${m.title}`, "");
      setChip($("chipWindow"), full.vision.windowTitle || "window unknown");
      $("chipFrames").classList.add("hidden");
      $("chipLast").classList.add("hidden");
      renderRoster(
        (full.vision.roster || []).map((p) => ({
          ...p,
          faceVotes: 0,
          face: p.face ? `/api/meetings/${m.id}/${p.face}` : null,
        })),
        "from last finished meeting"
      );
      renderTimeline(full.vision.speaking || [], m.durationSec);
      return true;
    }
  }
  return false;
}

let shownFallback = false;
async function poll() {
  let s;
  try {
    const res = await fetch("/api/watcher/debug");
    s = await res.json();
    if (res.status === 404) throw new Error("endpoint missing");
  } catch {
    setChip($("chipSource"), "server too old — restart it to enable debug", "bad");
    return;
  }
  if (!s.active) {
    setChip($("chipSource"), s.recording ? "recording, watcher off" : "idle — no recording", "");
    if (!shownFallback) {
      shownFallback = true;
      try { await fallbackToSavedVision(); } catch {}
    }
    return;
  }
  shownFallback = false;
  snap = s;
  setChip($("chipSource"), s.watching ? "● watching" : "searching for meeting window…", s.watching ? "ok" : "bad");
  if (s.windowTitle) setChip($("chipWindow"), `${s.windowApp ? s.windowApp + " — " : ""}${s.windowTitle}`);
  setChip(
    $("chipFrames"),
    `frames ${s.stats.frames} · named ${s.stats.namedFrames} · highlight ${s.stats.rectFrames} · faces ${s.stats.faceFrames} · samples ${s.sampleCount}`
  );
  const age = s.stats.lastFrameAt ? Math.round((Date.now() - s.stats.lastFrameAt) / 1000) : null;
  setChip($("chipLast"), age === null ? "no frames yet" : `last frame ${age}s ago`, age !== null && age > 10 ? "bad" : "");
  renderRoster(s.roster, "live, unfiltered");
  renderTimeline(s.timeline, (Date.now() - s.startTime) / 1000);
  // seed the canvas from the ring buffer if WS hasn't delivered a frame yet
  if (!lastFrame && s.recent && s.recent.length) {
    lastFrame = s.recent[s.recent.length - 1];
    lastFrameWall = s.stats.lastFrameAt || Date.now();
    refreshFrameImage();
    drawFrame();
  }
}

// --- websocket: live frames + pipeline events ---
function connect() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "watcherFrame") {
      lastFrame = msg.frame;
      lastFrameWall = Date.now();
      refreshFrameImage();
      drawFrame();
      const f = msg.frame;
      const names = f.texts.filter((t) => t.name).map((t) => t.s);
      let line = `frame t=${f.t}s texts=${f.texts.length} rects=${f.rects.length} faces=${f.faces.length}`;
      if (names.length) line += ` names=[${names.join(", ")}]`;
      if (f.active) line += ` ▶ ${f.active}`;
      if (f.paired.length) line += ` 📸 ${f.paired.join(", ")}`;
      log(f.active ? "hear" : "frame", line);
    } else if (msg.type === "watcher") {
      log("sys", msg.watching ? `watcher: found window "${msg.title}" (${msg.app || "?"})` : "watcher: meeting window lost");
    } else if (msg.type === "segment") {
      log("hear", `heard [${msg.segment.who || "?"} @ ${msg.segment.t}s] ${msg.segment.text}`);
    } else if (msg.type === "status") {
      log("sys", msg.recording ? `recording: ${msg.meeting.title}` : "recording stopped");
    } else if (msg.type === "diarizeStart") {
      log("sys", `diarize: started for ${msg.meetingId}`);
    } else if (msg.type === "diarizeDone") {
      const n = Object.entries(msg.autoNames || {});
      log("sys", `diarize: done — ${msg.speakerCount} speakers${n.length ? "; auto-named " + n.map(([k, v]) => `#${k}=${v}`).join(", ") : "; no auto-names (no vision overlap)"}`);
    } else if (msg.type === "diarizeError") {
      log("err", `diarize: ${msg.message}`);
    } else if (msg.type === "recError") {
      log("err", `recorder: ${msg.message}`);
    }
  };
  ws.onclose = () => {
    log("err", "websocket closed — reconnecting in 2s");
    setTimeout(connect, 2000);
  };
}

connect();
poll();
setInterval(poll, 2000);
window.addEventListener("resize", drawFrame);
log("sys", "debug ui ready");
