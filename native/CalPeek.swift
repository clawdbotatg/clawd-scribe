// CalPeek — prints the calendar events around "now" as JSON, for clawd-scribe.
//
//   calpeek [--back <minutes>] [--fwd <minutes>]
//
// Reads every calendar macOS already syncs (iCloud, Google, Exchange, …) via
// EventKit and emits an array of events overlapping [now-back, now+fwd]:
// title, calendar, times, organizer, attendees (name/email/RSVP), description,
// location, url. The daemon uses it to name a recording after the meeting the
// user is in and to attach the invite's metadata. All local — no network.
//
// TCC: the first run pops the macOS "access your calendar" dialog, attributed
// to the responsible app (Clawd Scribe.app when spawned by the daemon). An
// unbundled CLI has no Info.plist, and requestFullAccessToEvents refuses to
// even prompt without a usage description — so build:native embeds
// CalPeek-Info.plist into the binary's __TEXT,__info_plist section.
// Exit codes: 0 ok · 2 access denied (JSON {"error": …} on stdout).
import EventKit
import Foundation

var backMin = 240.0
var fwdMin = 30.0
var argv = Array(CommandLine.arguments.dropFirst())
while argv.count >= 2 {
  let flag = argv.removeFirst()
  guard let v = Double(argv.removeFirst()) else { continue }
  if flag == "--back" { backMin = v }
  if flag == "--fwd" { fwdMin = v }
}

func emit(_ obj: Any) {
  let data = try! JSONSerialization.data(withJSONObject: obj, options: [])
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

let store = EKEventStore()
let sem = DispatchSemaphore(value: 0)
var granted = false
if #available(macOS 14.0, *) {
  store.requestFullAccessToEvents { ok, _ in granted = ok; sem.signal() }
} else {
  store.requestAccess(to: .event) { ok, _ in granted = ok; sem.signal() }
}
sem.wait()
if !granted {
  emit(["error": "calendar access denied — allow it in System Settings > Privacy & Security > Calendars"])
  exit(2)
}

func word(_ s: EKParticipantStatus) -> String {
  switch s {
  case .accepted: return "accepted"
  case .declined: return "declined"
  case .tentative: return "tentative"
  case .pending: return "pending"
  default: return "unknown"
  }
}

func person(_ p: EKParticipant) -> [String: Any] {
  var o: [String: Any] = [:]
  if let n = p.name, !n.isEmpty { o["name"] = n }
  let u = p.url.absoluteString
  if u.lowercased().hasPrefix("mailto:") { o["email"] = String(u.dropFirst(7)) }
  o["status"] = word(p.participantStatus)
  if p.isCurrentUser { o["me"] = true }
  if p.participantRole == .optional { o["optional"] = true }
  return o
}

let now = Date()
let pred = store.predicateForEvents(
  withStart: now.addingTimeInterval(-backMin * 60),
  end: now.addingTimeInterval(fwdMin * 60),
  calendars: nil
)
let iso = ISO8601DateFormatter()
var out: [[String: Any]] = []
for e in store.events(matching: pred) {
  guard let start = e.startDate, let end = e.endDate else { continue }
  var d: [String: Any] = [
    "title": e.title ?? "",
    "calendar": e.calendar?.title ?? "",
    "startsAt": iso.string(from: start),
    "endsAt": iso.string(from: end),
    "allDay": e.isAllDay,
  ]
  if e.status == .canceled { d["cancelled"] = true }
  if let loc = e.location, !loc.isEmpty { d["location"] = loc }
  if let notes = e.notes, !notes.isEmpty { d["description"] = notes }
  if let url = e.url { d["url"] = url.absoluteString }
  if let org = e.organizer { d["organizer"] = person(org) }
  if let att = e.attendees, !att.isEmpty {
    d["attendees"] = att.map(person)
    if let mine = att.first(where: { $0.isCurrentUser }) {
      d["myStatus"] = word(mine.participantStatus)
    }
  }
  out.append(d)
}
emit(out)
