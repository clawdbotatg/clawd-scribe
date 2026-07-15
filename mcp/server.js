#!/usr/bin/env node
// clawd-scribe MCP server — lets Claude (Desktop / Code / anything MCP) search and
// read every meeting you've ever recorded. Zero dependencies: it's a stdio JSON-RPC
// loop over the same data folder the daemon writes (server/store.js), so it works
// even when the clawd-scribe daemon isn't running.
//
//   claude mcp add clawd-scribe -- node /abs/path/to/mcp/server.js
//
// or in Claude Desktop's claude_desktop_config.json:
//   { "mcpServers": { "clawd-scribe": { "command": "node", "args": ["/abs/path/to/mcp/server.js"] } } }
//
// stdout is protocol-only; all logging goes to stderr.
const path = require("path");
const store = require(path.join(__dirname, "..", "server", "store.js"));

const SERVER_INFO = { name: "clawd-scribe", version: "0.1.0" };
const TRANSCRIPT_CHAR_BUDGET = 24000; // per get_transcript call; pages via `offset`

// --- speaker + transcript formatting (mirrors the web UI's labeling rules) ---
function speakerKey(seg) {
  if (seg.who === "me") return "me";
  if (seg.speaker != null) return String(seg.speaker);
  return seg.who ? "them" : null;
}
function speakerName(meta, key) {
  const speakers = meta.speakers || {};
  if (key === "me") return speakers.me || "Me";
  if (key === "them" || key === null) return "Them";
  return speakers[key] || "Speaker " + key;
}
function fmtClock(sec) {
  const m = Math.floor(sec / 60);
  return `${m}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
}
function fmtLine(meta, seg) {
  return `[${fmtClock(seg.t)}] ${speakerName(meta, speakerKey(seg))}: ${String(seg.text || "").trim()}`;
}
function fmtDate(iso) {
  return iso ? iso.slice(0, 16).replace("T", " ") + " UTC" : "?";
}
function metaLine(meta) {
  const named = Object.entries(meta.speakers || {})
    .filter(([k, v]) => k !== "me" && v && !/^speaker \d+$/i.test(v))
    .map(([, v]) => v);
  return (
    `${meta.id} | ${meta.title || "(untitled)"} | ${fmtDate(meta.startedAt)} | ` +
    `${fmtClock(meta.durationSec || 0)}` +
    (named.length ? ` | with: ${named.join(", ")}` : "")
  );
}

// --- tools ---
const TOOLS = [
  {
    name: "search_meetings",
    description:
      "Full-text search across every recorded meeting/call — titles, speaker names, your notes, " +
      "generated summaries, and the word-for-word transcripts. Case-insensitive substring match. " +
      "Returns matching meetings with a snippet and, for transcript hits, the matching lines with " +
      "timestamps. Use this first when looking for 'that call where we discussed X' or calls with a person.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "word or phrase to search for" } },
      required: ["query"],
    },
  },
  {
    name: "list_meetings",
    description:
      "List recorded meetings/calls, newest first: id, title, date, duration, and named participants. " +
      "Use limit/offset to page through history.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "max results (default 25)" },
        offset: { type: "number", description: "skip this many (default 0)" },
      },
    },
  },
  {
    name: "get_meeting",
    description:
      "Load one meeting by id: metadata, participants, your raw notes, and the generated summary " +
      "notes. Does NOT include the word-for-word transcript — call get_transcript for that.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "meeting id from list/search" } },
      required: ["id"],
    },
  },
  {
    name: "get_transcript",
    description:
      "The word-for-word transcript of a meeting, one '[m:ss] Speaker: text' line per segment, with " +
      "speaker names resolved. Long transcripts are paged — the output says how to fetch the next " +
      "chunk (pass `offset`). Prefer get_meeting's summary unless you need exact wording.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "meeting id from list/search" },
        offset: { type: "number", description: "segment index to start from (default 0)" },
      },
      required: ["id"],
    },
  },
];

const HANDLERS = {
  search_meetings({ query }) {
    const q = String(query || "").trim();
    if (!q) return "Empty query.";
    const hits = store.searchMeetings(q);
    if (!hits.length) return `No meetings match "${q}".`;
    const ql = q.toLowerCase();
    const out = [`${hits.length} meeting(s) match "${q}":`, ""];
    for (const m of hits.slice(0, 20)) {
      out.push(metaLine(m));
      out.push(`  matched in ${m.matchIn}: ${m.snippet}`);
      if (m.matchIn === "transcript") {
        const segs = store.getTranscript(m.id);
        const lines = [];
        for (const s of segs) {
          if (String(s.text || "").toLowerCase().includes(ql)) {
            lines.push("  " + fmtLine(m, s));
            if (lines.length >= 3) break;
          }
        }
        out.push(...lines);
      }
      out.push("");
    }
    if (hits.length > 20) out.push(`(showing first 20 of ${hits.length})`);
    return out.join("\n");
  },

  list_meetings({ limit, offset } = {}) {
    const all = store.listMeetings();
    const off = Math.max(0, Number(offset) || 0);
    const lim = Math.max(1, Number(limit) || 25);
    const page = all.slice(off, off + lim);
    if (!page.length) return `No meetings (total: ${all.length}).`;
    const out = [`${all.length} meetings total, showing ${off + 1}–${off + page.length} (newest first):`, ""];
    for (const m of page) out.push(metaLine(m));
    if (off + page.length < all.length)
      out.push("", `More available — call list_meetings with offset=${off + page.length}.`);
    return out.join("\n");
  },

  get_meeting({ id }) {
    const m = store.getMeeting(String(id || ""));
    const out = [
      `# ${m.meta.title || "(untitled)"}`,
      `id: ${m.meta.id} | ${fmtDate(m.meta.startedAt)} | duration ${fmtClock(m.meta.durationSec || 0)} | ${m.transcript.length} transcript segments`,
    ];
    const speakers = Object.entries(m.meta.speakers || {}).map(([k, v]) => `${k}=${v}`);
    if (speakers.length) out.push(`speakers: ${speakers.join(", ")}`);
    out.push("");
    out.push("## My notes (typed during the call)", m.notes.trim() || "(none)", "");
    out.push("## Generated summary", m.summary.trim() || "(none — summary was never generated)", "");
    out.push(`For exact wording, call get_transcript with id "${m.meta.id}".`);
    return out.join("\n");
  },

  get_transcript({ id, offset } = {}) {
    const mid = String(id || "");
    const meta = store.getMeta(mid);
    const segs = store.getTranscript(mid);
    if (!segs.length) return `Meeting ${mid} has no transcript.`;
    const off = Math.max(0, Number(offset) || 0);
    const out = [`# ${meta.title || "(untitled)"} — transcript (${segs.length} segments)`, ""];
    let chars = 0;
    let i = off;
    for (; i < segs.length; i++) {
      const line = fmtLine(meta, segs[i]);
      chars += line.length + 1;
      if (chars > TRANSCRIPT_CHAR_BUDGET && i > off) break;
      out.push(line);
    }
    if (i < segs.length) {
      out.push("", `…truncated at segment ${i} of ${segs.length}. Call get_transcript again with offset=${i} for the rest.`);
    }
    return out.join("\n");
  },
};

// --- MCP stdio plumbing: newline-delimited JSON-RPC 2.0 ---
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}
function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return reply(id, {
      protocolVersion: (params && params.protocolVersion) || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") return;
  if (method === "ping") return reply(id, {});
  if (method === "tools/list") return reply(id, { tools: TOOLS });
  if (method === "tools/call") {
    const name = params && params.name;
    const handler = HANDLERS[name];
    if (!handler) return replyError(id, -32602, `unknown tool: ${name}`);
    try {
      const text = handler((params && params.arguments) || {});
      return reply(id, { content: [{ type: "text", text }] });
    } catch (e) {
      return reply(id, { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true });
    }
  }
  if (id !== undefined) replyError(id, -32601, `method not found: ${method}`);
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch (e) {
      console.error("[mcp] bad message:", e.message);
    }
  }
});
process.stdin.on("end", () => process.exit(0));
console.error(`[mcp] clawd-scribe MCP server up — data: ${store.DATA_DIR}`);
