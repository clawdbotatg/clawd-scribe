// MeetWatch — watches the meeting window (Google Meet / Zoom / Teams) via
// ScreenCaptureKit at ~1fps and reports, per frame:
//   - all on-screen text with positions (Apple Vision OCR, fully local)
//   - bounding rects of "active speaker" highlight pixels (Meet's blue /
//     Zoom's green tile border), clustered on a coarse grid
// The daemon matches names to highlight rects to learn who is speaking when,
// and fuses that with voice diarization to auto-name speakers.
//
// Usage: meetwatch '<json opts>'   (opts: {patterns, colors, tolerance})
// Output: single-line JSON events on stdout:
//   {"event":"watching","title":...} {"event":"frame","texts":[...],"rects":[...]}
//   {"event":"lost"}
// All coordinates are normalized [0,1] with top-left origin.

import CoreMedia
import CoreVideo
import Foundation
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
            let candidates = (content?.windows ?? []).filter { w in
                guard let title = w.title?.lowercased(), !title.isEmpty else { return false }
                guard w.frame.width >= 320 && w.frame.height >= 240 else { return false }
                return opts.patterns.contains { title.contains($0) }
            }
            guard let win = candidates.max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }) else {
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
        let rects = highlightRects(pb)
        let texts = ocr(pb)
        if texts.isEmpty && rects.isEmpty { return }
        emit(["event": "frame", "texts": texts, "rects": rects])
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

        // connected components over grid cells with enough matches
        var visited = [Bool](repeating: false, count: GRID_W * GRID_H)
        var rects: [[String: Double]] = []
        for start in 0..<grid.count where grid[start] >= 2 && !visited[start] {
            var queueIdx = [start]
            visited[start] = true
            var minX = GRID_W, maxX = 0, minY = GRID_H, maxY = 0, cells = 0
            while let cur = queueIdx.popLast() {
                cells += 1
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
            if cells < 3 { continue }
            rects.append([
                "x": r3(Double(minX) / Double(GRID_W)),
                "y": r3(Double(minY) / Double(GRID_H)),
                "w": r3(Double(maxX - minX + 1) / Double(GRID_W)),
                "h": r3(Double(maxY - minY + 1) / Double(GRID_H)),
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
