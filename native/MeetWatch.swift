// MeetWatch — watches the meeting window (Google Meet / Zoom / Teams) via
// ScreenCaptureKit at ~1fps and reports, per frame:
//   - all on-screen text with positions (Apple Vision OCR, fully local)
//   - bounding rects of "active speaker" highlight pixels (Meet's blue /
//     Zoom's green tile border), clustered on a coarse grid
//   - a downscaled JPEG of the frame itself, so the local debug UI can show
//     the overlays on top of what was actually seen (never leaves the daemon)
// The daemon matches names to highlight rects to learn who is speaking when,
// and fuses that with voice diarization to auto-name speakers.
//
// Usage: meetwatch '<json opts>'   (opts: {patterns, colors, tolerance})
// Output: single-line JSON events on stdout:
//   {"event":"watching","title":...} {"event":"frame","texts":[...],"rects":[...]}
//   {"event":"lost"}
// All coordinates are normalized [0,1] with top-left origin.

import CoreImage
import CoreMedia
import CoreVideo
import Foundation
import ImageIO
import ScreenCaptureKit
import Vision

struct Opts {
    var patterns = ["meet", "zoom", "teams", "webex"]
    var colors: [[Int]] = [[26, 115, 232], [66, 133, 244], [35, 217, 89]]
    var tolerance = 90
    var debug = false
}

var opts = Opts()
if CommandLine.arguments.count > 1,
   let data = CommandLine.arguments[1].data(using: .utf8),
   let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
    if let p = obj["patterns"] as? [String], !p.isEmpty { opts.patterns = p.map { $0.lowercased() } }
    if let c = obj["colors"] as? [[Int]], !c.isEmpty { opts.colors = c }
    if let t = obj["tolerance"] as? Int { opts.tolerance = t }
    if let d = obj["debug"] as? Bool { opts.debug = d }
}

let emitLock = NSLock()
func emit(_ obj: [String: Any]) {
    emitLock.lock()
    defer { emitLock.unlock() }
    guard let d = try? JSONSerialization.data(withJSONObject: obj),
          let s = String(data: d, encoding: .utf8) else { return }
    if fputs(s + "\n", stdout) < 0 {
        exit(0) // stdout closed — parent is gone
    }
    fflush(stdout)
}

func r3(_ v: Double) -> Double { (v * 1000).rounded() / 1000 }

final class Watcher: NSObject, SCStreamOutput, SCStreamDelegate {
    private var stream: SCStream?
    private var windowID: CGWindowID = 0
    private let queue = DispatchQueue(label: "clawd-scribe.watch")
    private let ciContext = CIContext(options: nil)
    private var frameCount = 0
    private let GRID_W = 64
    private let GRID_H = 36

    func scan() {
        SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: true) {
            [weak self] content, error in
            guard let self = self else { return }
            if error != nil {
                self.rescanLater()
                return
            }
            if opts.debug {
                let titles = (content?.windows ?? []).compactMap { w -> String? in
                    guard let t = w.title, !t.isEmpty else { return nil }
                    return "\(w.owningApplication?.applicationName ?? "?"): \(t) [\(Int(w.frame.width))x\(Int(w.frame.height))]"
                }
                emit(["event": "windows", "titles": titles])
            }
            // Score candidates instead of substring-matching titles: "meet" must
            // match as a whole word ("Google Meet" yes, "meeting notes" no), and
            // windows owned by a real meeting app outrank browser tabs.
            let meetingApps = ["zoom.us", "microsoft teams", "webex", "cisco webex"]
            func score(_ w: SCWindow) -> Int {
                guard let title = w.title?.lowercased(), !title.isEmpty,
                      w.frame.width >= 320, w.frame.height >= 240 else { return 0 }
                let app = (w.owningApplication?.applicationName ?? "").lowercased()
                var s = 0
                if meetingApps.contains(where: { app.contains($0) }) { s += 4 }
                for p in opts.patterns {
                    let rx = "\\b" + NSRegularExpression.escapedPattern(for: p) + "\\b"
                    if title.range(of: rx, options: .regularExpression) != nil { s += 2; break }
                }
                return s
            }
            let candidates = (content?.windows ?? []).map { ($0, score($0)) }.filter { $0.1 >= 2 }
            guard let (win, _) = candidates.max(by: {
                ($0.1, $0.0.frame.width * $0.0.frame.height) < ($1.1, $1.0.frame.width * $1.0.frame.height)
            }) else {
                self.rescanLater()
                return
            }
            self.startStream(win)
        }
    }

    private func rescanLater() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in self?.scan() }
    }

    private func startStream(_ win: SCWindow) {
        let filter = SCContentFilter(desktopIndependentWindow: win)
        let cfg = SCStreamConfiguration()
        let scale = min(1.0, 1280.0 / win.frame.width)
        cfg.width = Int(win.frame.width * scale)
        cfg.height = Int(win.frame.height * scale)
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        cfg.pixelFormat = kCVPixelFormatType_32BGRA
        cfg.showsCursor = false
        cfg.capturesAudio = false

        let stream = SCStream(filter: filter, configuration: cfg, delegate: self)
        self.stream = stream
        self.windowID = win.windowID
        do {
            try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        } catch {
            emit(["event": "error", "detail": "addStreamOutput: \(error.localizedDescription)"])
            rescanLater()
            return
        }
        stream.startCapture { [weak self] error in
            if let error = error {
                emit(["event": "error", "detail": "startCapture: \(error.localizedDescription)"])
                self?.stream = nil
                self?.rescanLater()
                return
            }
            emit(["event": "watching", "title": win.title ?? "", "app": win.owningApplication?.applicationName ?? ""])
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        emit(["event": "lost"])
        self.stream = nil
        rescanLater()
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
                of type: SCStreamOutputType) {
        guard type == .screen,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let statusRaw = attachments.first?[.status] as? Int,
              statusRaw == SCFrameStatus.complete.rawValue,
              let pb = CMSampleBufferGetImageBuffer(sampleBuffer)
        else { return }
        process(pb)
    }

    private func process(_ pb: CVPixelBuffer) {
        frameCount += 1
        let rects = highlightRects(pb)
        let texts = ocr(pb)
        // face crops are heavier (JPEG over stdout) — sample every 5th frame
        let faces = frameCount % 5 == 0 ? detectFaces(pb) : []
        // emit even detection-less frames: the debug UI wants to show what the
        // watcher saw precisely when nothing was found
        var msg: [String: Any] = ["event": "frame", "texts": texts, "rects": rects]
        if !faces.isEmpty { msg["faces"] = faces }
        if let img = frameJpeg(pb) { msg["img"] = img }
        emit(msg)
    }

    // Downscaled JPEG of the whole frame for the debug UI. ~1fps over a local
    // pipe to the daemon; never written to disk.
    private func frameJpeg(_ pb: CVPixelBuffer) -> String? {
        var img = CIImage(cvPixelBuffer: pb)
        let scale = min(1.0, 640.0 / Double(CVPixelBufferGetWidth(pb)))
        if scale < 1 { img = img.transformed(by: CGAffineTransform(scaleX: scale, y: scale)) }
        let q = CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String)
        guard let jpg = ciContext.jpegRepresentation(
            of: img, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!, options: [q: 0.5]
        ) else { return nil }
        return jpg.base64EncodedString()
    }

    // Detect faces and emit small JPEG crops so the daemon can pair each face
    // with the participant name on the same tile. Crops stay on this machine.
    private func detectFaces(_ pb: CVPixelBuffer) -> [[String: Any]] {
        let request = VNDetectFaceRectanglesRequest()
        let handler = VNImageRequestHandler(cvPixelBuffer: pb, options: [:])
        guard (try? handler.perform([request])) != nil else { return [] }
        let W = Double(CVPixelBufferGetWidth(pb))
        let H = Double(CVPixelBufferGetHeight(pb))
        let img = CIImage(cvPixelBuffer: pb)
        var out: [[String: Any]] = []
        for obs in (request.results ?? []).prefix(12) {
            let bb = obs.boundingBox // normalized, bottom-left origin
            let m = 0.45 // margin around the face
            let crop = CGRect(
                x: (bb.minX - bb.width * m) * W,
                y: (bb.minY - bb.height * m) * H,
                width: bb.width * (1 + 2 * m) * W,
                height: bb.height * (1 + 2 * m) * H
            ).intersection(CGRect(x: 0, y: 0, width: W, height: H))
            guard crop.width >= 24, crop.height >= 24 else { continue }
            var face = img.cropped(to: crop)
            let scale = 96.0 / crop.height
            if scale < 1 { face = face.transformed(by: CGAffineTransform(scaleX: scale, y: scale)) }
            let q = CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String)
            guard let jpg = ciContext.jpegRepresentation(
                of: face, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!, options: [q: 0.7]
            ) else { continue }
            out.append([
                "x": r3(bb.minX),
                "y": r3(1 - bb.maxY), // top-left origin, like texts/rects
                "w": r3(bb.width),
                "h": r3(bb.height),
                "jpg": jpg.base64EncodedString(),
            ])
        }
        return out
    }

    // Find clusters of pixels matching the active-speaker highlight colors.
    private func highlightRects(_ pb: CVPixelBuffer) -> [[String: Double]] {
        CVPixelBufferLockBaseAddress(pb, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(pb) else { return [] }
        let w = CVPixelBufferGetWidth(pb)
        let h = CVPixelBufferGetHeight(pb)
        let stride = CVPixelBufferGetBytesPerRow(pb)
        let ptr = base.assumingMemoryBound(to: UInt8.self)

        var grid = [Int](repeating: 0, count: GRID_W * GRID_H)
        let step = 3
        var y = 0
        while y < h {
            var x = 0
            let row = y * stride
            while x < w {
                let p = row + x * 4 // BGRA
                let b = Int(ptr[p]), g = Int(ptr[p + 1]), r = Int(ptr[p + 2])
                for c in opts.colors {
                    if abs(r - c[0]) + abs(g - c[1]) + abs(b - c[2]) < opts.tolerance {
                        let gx = min(GRID_W - 1, x * GRID_W / w)
                        let gy = min(GRID_H - 1, y * GRID_H / h)
                        grid[gy * GRID_W + gx] += 1
                        break
                    }
                }
                x += step
            }
            y += step
        }

        // Connected components over grid cells with enough matches — but keep
        // only border-ring-shaped ones. The active-speaker highlight is a thin
        // hollow outline around one tile: its matched cells trace the bbox
        // perimeter with an empty interior. Buttons, links, and blue video
        // content are solid blobs (high interior fill) or far smaller than a
        // tile, and they were flooding the output with bogus rects.
        var visited = [Bool](repeating: false, count: GRID_W * GRID_H)
        var rects: [[String: Double]] = []
        for start in 0..<grid.count where grid[start] >= 2 && !visited[start] {
            var queueIdx = [start]
            visited[start] = true
            var members: [Int] = []
            var minX = GRID_W, maxX = 0, minY = GRID_H, maxY = 0
            while let cur = queueIdx.popLast() {
                members.append(cur)
                let cx = cur % GRID_W, cy = cur / GRID_W
                minX = min(minX, cx); maxX = max(maxX, cx)
                minY = min(minY, cy); maxY = max(maxY, cy)
                for (dx, dy) in [(-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (1, 1), (-1, 1), (1, -1)] {
                    let nx = cx + dx, ny = cy + dy
                    guard nx >= 0, nx < GRID_W, ny >= 0, ny < GRID_H else { continue }
                    let ni = ny * GRID_W + nx
                    if grid[ni] >= 2 && !visited[ni] {
                        visited[ni] = true
                        queueIdx.append(ni)
                    }
                }
            }
            let bw = maxX - minX + 1, bh = maxY - minY + 1
            if bw < 4 || bh < 3 { continue } // smaller than any video tile
            var interior = 0, onEdge = 0
            for cell in members {
                let cx = cell % GRID_W, cy = cell / GRID_W
                if cx == minX || cx == maxX || cy == minY || cy == maxY { onEdge += 1 } else { interior += 1 }
            }
            let fill = Double(interior) / Double(max(1, (bw - 2) * (bh - 2)))
            let cov = Double(onEdge) / Double(2 * (bw + bh) - 4)
            // a ring is hollow (low fill) and traces most of its perimeter;
            // rounded corners cost a few perimeter cells, hence 0.5 not higher
            if fill > 0.35 || cov < 0.5 { continue }
            rects.append([
                "x": r3(Double(minX) / Double(GRID_W)),
                "y": r3(Double(minY) / Double(GRID_H)),
                "w": r3(Double(bw) / Double(GRID_W)),
                "h": r3(Double(bh) / Double(GRID_H)),
                "cov": r3(cov),
            ])
        }
        return rects
    }

    private func ocr(_ pb: CVPixelBuffer) -> [[String: Any]] {
        var results: [[String: Any]] = []
        let request = VNRecognizeTextRequest { req, _ in
            for obs in (req.results as? [VNRecognizedTextObservation]) ?? [] {
                guard let cand = obs.topCandidates(1).first, cand.confidence > 0.4 else { continue }
                let bb = obs.boundingBox // normalized, bottom-left origin
                results.append([
                    "s": cand.string,
                    "x": r3(bb.minX),
                    "y": r3(1 - bb.maxY), // convert to top-left origin
                    "w": r3(bb.width),
                    "h": r3(bb.height),
                ])
                if results.count >= 60 { break }
            }
        }
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        let handler = VNImageRequestHandler(cvPixelBuffer: pb, options: [:])
        try? handler.perform([request])
        return results
    }
}

signal(SIGPIPE, SIG_IGN)
_ = CGMainDisplayID() // initialize the window-server connection before SCK window enumeration
let watcher = Watcher()
for sig in [SIGINT, SIGTERM] {
    signal(sig, SIG_IGN)
    let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    src.setEventHandler { exit(0) }
    src.resume()
    _ = Unmanaged.passRetained(src)
}
watcher.scan()
dispatchMain()
