// Who may write a meeting's title. One field, explicit authority:
//   meta.titleSource = "default"  — the scribe made up "Meeting <date>"
//                      "calendar" — set once from the calendar at Record
//                      "user"     — typed, passed in, or picked from the
//                                   overlap buttons
// The calendar may only replace a "default" title, exactly once. Nothing
// else writes titles: no LLM naming, no retitle after stop (removed
// 2026-08-05 after an LLM retitle clobbered a typed title).
const { metaFromEvent } = require("./calendar");

// Meetings recorded before titleSource existed were titled by hand.
function titleSourceOf(meta) {
  return meta.titleSource || "user";
}

// Attach a calendar pick ({ event, others }) to a meeting's meta. Always
// records the invite context; takes the title only while it's the default.
// Mutates meta; returns true when the title changed.
function applyCalendarPick(meta, pick) {
  if (!pick || !pick.event) return false;
  if (meta.calendar) return false; // once per meeting: never re-point title or context
  meta.calendar = metaFromEvent(pick.event);
  meta.calendarOthers = (pick.others || []).map(metaFromEvent);
  if (titleSourceOf(meta) !== "default") return false;
  meta.title = pick.event.title.slice(0, 200);
  meta.titleSource = "calendar";
  return true;
}

// The user tapped one of the "also on now" buttons: that event becomes the
// meeting's title and invite context; the old pick joins the alternatives.
function swapCalendarPick(meta, index) {
  const others = meta.calendarOthers || [];
  const chosen = others[index];
  if (!chosen) throw new Error("no such calendar event");
  const rest = others.filter((_, i) => i !== index);
  if (meta.calendar) rest.unshift(meta.calendar);
  meta.calendar = chosen;
  meta.calendarOthers = rest;
  meta.title = String(chosen.title || meta.title).slice(0, 200);
  meta.titleSource = "user";
}

function setUserTitle(meta, title) {
  const t = String(title || "").slice(0, 200);
  if (!t) return;
  meta.title = t;
  meta.titleSource = "user";
}

module.exports = { titleSourceOf, applyCalendarPick, swapCalendarPick, setUserTitle };
