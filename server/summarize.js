// Note generation via a local LLM (Ollama's /api/chat, streaming NDJSON).
// The endpoint and model come from data/config.json.

const SYSTEM_PROMPT = `You are a meeting-notes assistant. You receive a raw, possibly
imperfect machine transcript of a meeting, and optionally the user's own rough notes
typed during the meeting. Produce clean, useful meeting notes in Markdown.

Rules:
- Transcript lines are labeled by speaker. "Me" (or the user's name) is the person
  whose notes these are; attribute commitments and action items to the right people.
- The user's own notes indicate what mattered to them — weave those points in and
  expand them with detail from the transcript.
- Structure: start with a 2-4 sentence "## Summary", then "## Key Points" as bullets,
  then "## Decisions" (omit if none), then "## Action Items" as a checklist with
  owners when identifiable (omit if none).
- Be specific: names, numbers, dates, and commitments from the transcript.
- Do not invent content that is not supported by the transcript or notes.
- The transcript may contain recognition errors; silently correct obvious ones.
- Output only the Markdown notes, no preamble.`;

function stripThinking(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trimStart();
}

function speakerLabel(seg, speakers) {
  if (seg.who === "me") return speakers.me || "Me";
  if (seg.speaker != null) return speakers[seg.speaker] || `Speaker ${seg.speaker}`;
  return seg.who ? "Them" : "";
}

async function generateNotes({ transcript, userNotes, title, speakers = {} }, config, onToken) {
  const transcriptText = transcript
    .map((s) => {
      const label = speakerLabel(s, speakers);
      return `[${Math.floor(s.t / 60)}:${String(s.t % 60).padStart(2, "0")}]${label ? " " + label + ":" : ""} ${s.text}`;
    })
    .join("\n");

  let user = `Meeting title: ${title}\n\n`;
  if (userNotes && userNotes.trim()) {
    user += `My rough notes:\n${userNotes.trim()}\n\n`;
  }
  user += `Transcript:\n${transcriptText}`;

  const res = await fetch(config.llm.url.replace(/\/$/, "") + "/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: config.llm.model,
      stream: true,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`LLM endpoint ${config.llm.url} returned ${res.status}: ${await res.text()}`);
  }

  let full = "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const tok = obj.message && obj.message.content;
      if (tok) {
        full += tok;
        if (onToken) onToken(tok);
      }
      if (obj.error) throw new Error(obj.error);
    }
  }
  return stripThinking(full).trim();
}

// Suggest a short, human-readable meeting title from the transcript (+ notes).
// One non-streaming LLM call; returns a few-word title with no surrounding quotes.
const TITLE_SYSTEM_PROMPT = `You name meetings. Given a transcript (and maybe the
user's rough notes), reply with a single short title — 3 to 7 words — that captures
what the meeting was about. Be specific: use project names, topics, or decisions that
actually appear. No date, no "meeting" filler, no quotes, no punctuation at the end.
Output only the title on one line, nothing else.`;

async function suggestTitle({ transcript, userNotes, speakers = {} }, config) {
  const transcriptText = transcript
    .map((s) => {
      const label = speakerLabel(s, speakers);
      return `${label ? label + ": " : ""}${s.text}`;
    })
    .join("\n")
    .slice(0, 6000); // a title needs context, not the whole call

  let user = "";
  if (userNotes && userNotes.trim()) user += `My rough notes:\n${userNotes.trim()}\n\n`;
  user += `Transcript:\n${transcriptText || "(no transcript)"}`;

  const res = await fetch(config.llm.url.replace(/\/$/, "") + "/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: config.llm.model,
      stream: false,
      messages: [
        { role: "system", content: TITLE_SYSTEM_PROMPT },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`LLM endpoint ${config.llm.url} returned ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  let title = stripThinking((data.message && data.message.content) || "").trim();
  // take the first non-empty line, strip wrapping quotes / trailing punctuation
  title = (title.split("\n").find((l) => l.trim()) || "").trim();
  title = title.replace(/^["'`]+|["'`]+$/g, "").replace(/[.\s]+$/, "").trim();
  return title.slice(0, 80);
}

module.exports = { generateNotes, suggestTitle };
