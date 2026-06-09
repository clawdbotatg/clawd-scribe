// AudioCapture — captures system audio (the meeting) + microphone (you) via
// ScreenCaptureKit and streams both as 16kHz STEREO PCM (s16le) on stdout:
//   left channel  = microphone (you)
//   right channel = system audio (everyone else)
// Keeping the sources separate is what lets the daemon attribute speech to
// "me" vs "them" with certainty, and diarize only the remote side.
//
// Requires macOS 15+ (SCStreamConfiguration.captureMicrophone).
// Permissions: Screen Recording + Microphone, granted to the parent process
// (your terminal, or whatever launches the daemon).
//
// Usage: audiocap [--no-mic] [--no-system]
// Output: raw PCM, 16000 Hz, 2 channels interleaved, s16le, on stdout.
// Diagnostics go to stderr as single-line JSON.

import AVFoundation
import CoreMedia
import Foundation
import ScreenCaptureKit

let TARGET_RATE: Double = 16000

func logErr(_ event: String, _ detail: String = "") {
    let obj: [String: String] = ["event": event, "detail": detail]
    if let d = try? JSONSerialization.data(withJSONObject: obj),
       let s = String(data: d, encoding: .utf8) {
        FileHandle.standardError.write((s + "\n").data(using: .utf8)!)
    }
}

// Converts incoming CMSampleBuffers (any rate/layout) to 16k mono Float32.
// Extracts samples via the AudioBufferList block-buffer API (the layout SCK
// actually delivers), downmixes to mono, then linearly resamples to 16k with
// state carried across buffers so the stream stays continuous.
final class StreamConverter {
    var debugTag = ""
    private var loggedFormat = false

    // resampler state (absolute positions in source-sample units)
    private var srcRate: Double = 0
    private var nextPos: Double = 0
    private var absBase: Double = 0
    private var lastSample: Float = 0

    func convert(_ sampleBuffer: CMSampleBuffer) -> [Float] {
        guard let fmtDesc = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fmtDesc)?.pointee
        else { return [] }
        let frames = CMSampleBufferGetNumSamples(sampleBuffer)
        if frames <= 0 { return [] }
        if !loggedFormat {
            loggedFormat = true
            logErr("format", "\(debugTag): rate=\(asbd.mSampleRate) ch=\(asbd.mChannelsPerFrame) flags=\(asbd.mFormatFlags)")
        }

        // Pull the AudioBufferList out of the sample buffer.
        var sizeNeeded = 0
        var status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: &sizeNeeded,
            bufferListOut: nil, bufferListSize: 0,
            blockBufferAllocator: nil, blockBufferMemoryAllocator: nil,
            flags: 0, blockBufferOut: nil)
        guard sizeNeeded > 0 else { return [] }

        let ablMem = UnsafeMutableRawPointer.allocate(
            byteCount: sizeNeeded, alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { ablMem.deallocate() }
        var blockBuffer: CMBlockBuffer?
        status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: nil,
            bufferListOut: ablMem.assumingMemoryBound(to: AudioBufferList.self),
            bufferListSize: sizeNeeded,
            blockBufferAllocator: kCFAllocatorDefault,
            blockBufferMemoryAllocator: kCFAllocatorDefault,
            flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
            blockBufferOut: &blockBuffer)
        if status != noErr {
            logErr("debug", "\(debugTag): getAudioBufferList failed \(status)")
            return []
        }
        let abl = UnsafeMutableAudioBufferListPointer(
            ablMem.assumingMemoryBound(to: AudioBufferList.self))

        let mono = downmix(abl, asbd: asbd, frames: frames)
        if mono.isEmpty { return [] }
        return resample(mono, rate: asbd.mSampleRate)
    }

    private func downmix(_ abl: UnsafeMutableAudioBufferListPointer,
                         asbd: AudioStreamBasicDescription, frames: Int) -> [Float] {
        let isFloat = asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0

        func floats(_ buf: AudioBuffer) -> [Float] {
            guard let data = buf.mData else { return [] }
            if isFloat {
                let n = Int(buf.mDataByteSize) / 4
                let p = data.assumingMemoryBound(to: Float.self)
                return Array(UnsafeBufferPointer(start: p, count: n))
            } else {
                let n = Int(buf.mDataByteSize) / 2
                let p = data.assumingMemoryBound(to: Int16.self)
                return UnsafeBufferPointer(start: p, count: n).map { Float($0) / 32768 }
            }
        }

        if abl.count == 1 {
            let samples = floats(abl[0])
            let ch = max(1, Int(abl[0].mNumberChannels))
            if ch == 1 { return samples }
            // interleaved multi-channel → average
            var out = [Float](repeating: 0, count: samples.count / ch)
            for i in 0..<out.count {
                var acc: Float = 0
                for c in 0..<ch { acc += samples[i * ch + c] }
                out[i] = acc / Float(ch)
            }
            return out
        }
        // non-interleaved: one buffer per channel → average
        var channels: [[Float]] = []
        for buf in abl { channels.append(floats(buf)) }
        guard let first = channels.first, !first.isEmpty else { return [] }
        if channels.count == 1 { return first }
        var out = first
        for c in 1..<channels.count {
            let chData = channels[c]
            for i in 0..<min(out.count, chData.count) { out[i] += chData[i] }
        }
        let scale = 1.0 / Float(channels.count)
        return out.map { $0 * scale }
    }

    private func resample(_ x: [Float], rate: Double) -> [Float] {
        if rate == TARGET_RATE { return x }
        if srcRate != rate {
            // first buffer or format change: reset stream state
            srcRate = rate
            nextPos = 0
            absBase = 0
            lastSample = x[0]
        }
        let ratio = rate / TARGET_RATE
        let n = x.count
        var out: [Float] = []
        out.reserveCapacity(Int(Double(n) / ratio) + 2)
        while nextPos < absBase + Double(n) - 1 {
            let rel = nextPos - absBase
            let i = Int(rel.rounded(.down))
            let t = Float(rel - Double(i))
            let s0 = i < 0 ? lastSample : x[i]
            let s1 = x[i + 1]
            out.append(s0 + (s1 - s0) * t)
            nextPos += ratio
        }
        lastSample = x[n - 1]
        absBase += Double(n)
        return out
    }
}

final class Capturer: NSObject, SCStreamOutput, SCStreamDelegate {
    let captureSystem: Bool
    let captureMic: Bool

    private var stream: SCStream?
    private let sysConverter = StreamConverter()
    private let micConverter = StreamConverter()

    private let lock = NSLock()
    private var sysBuf: [Float] = []
    private var micBuf: [Float] = []
    private var sysLast: TimeInterval = 0
    private var micLast: TimeInterval = 0

    private let sysQueue = DispatchQueue(label: "clawd-scribe.sys")
    private let micQueue = DispatchQueue(label: "clawd-scribe.mic")
    private var mixTimer: DispatchSourceTimer?

    private var sysCount = 0
    private var micCount = 0
    private var debugTicks = 0

    init(system: Bool, mic: Bool) {
        self.captureSystem = system
        self.captureMic = mic
        super.init()
        sysConverter.debugTag = "sys"
        micConverter.debugTag = "mic"
    }

    func start() {
        SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) {
            [weak self] content, error in
            guard let self = self else { return }
            if let error = error {
                logErr("error", "screen-recording permission missing or denied: \(error.localizedDescription)")
                exit(2)
            }
            guard let display = content?.displays.first else {
                logErr("error", "no display found")
                exit(2)
            }
            self.startStream(display: display)
        }
    }

    private func startStream(display: SCDisplay) {
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let config = SCStreamConfiguration()
        config.capturesAudio = captureSystem
        config.excludesCurrentProcessAudio = true
        config.sampleRate = Int(TARGET_RATE)
        config.channelCount = 1
        if captureMic {
            config.captureMicrophone = true
        }
        // Minimal video — we never read the frames, but SCK wants a video config.
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)

        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        self.stream = stream
        do {
            if captureSystem {
                try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: sysQueue)
            }
            if captureMic {
                try stream.addStreamOutput(self, type: .microphone, sampleHandlerQueue: micQueue)
            }
        } catch {
            logErr("error", "addStreamOutput failed: \(error.localizedDescription)")
            exit(2)
        }

        stream.startCapture { error in
            if let error = error {
                logErr("error", "startCapture failed: \(error.localizedDescription)")
                exit(2)
            }
            logErr("started", "system=\(self.captureSystem) mic=\(self.captureMic)")
            self.startMixer()
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
                of type: SCStreamOutputType) {
        guard sampleBuffer.isValid else { return }
        switch type {
        case .audio:
            sysCount += 1
            let samples = sysConverter.convert(sampleBuffer)
            if !samples.isEmpty {
                lock.lock()
                sysBuf.append(contentsOf: samples)
                sysLast = ProcessInfo.processInfo.systemUptime
                lock.unlock()
            }
        case .microphone:
            micCount += 1
            let samples = micConverter.convert(sampleBuffer)
            if !samples.isEmpty {
                lock.lock()
                micBuf.append(contentsOf: samples)
                micLast = ProcessInfo.processInfo.systemUptime
                lock.unlock()
            }
        default:
            break
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        logErr("error", "stream stopped: \(error.localizedDescription)")
        exit(2)
    }

    // Every 100ms, mix whatever both sources have in common and emit it.
    // If one source goes stale (muted device, denied permission), pass the
    // other through alone so the recording never deadlocks.
    private func startMixer() {
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "clawd-scribe.mix"))
        timer.schedule(deadline: .now() + 0.1, repeating: 0.1)
        timer.setEventHandler { [weak self] in self?.mixTick() }
        timer.resume()
        mixTimer = timer
    }

    private func mixTick() {
        let now = ProcessInfo.processInfo.systemUptime
        var mic: [Float] = []
        var sys: [Float] = []

        debugTicks += 1
        if debugTicks % 10 == 0 && ProcessInfo.processInfo.environment["AUDIOCAP_DEBUG"] != nil {
            logErr("debug", "tick sysBufs=\(sysCount) micBufs=\(micCount) sysQ=\(sysBuf.count) micQ=\(micBuf.count)")
        }

        lock.lock()
        let sysActive = captureSystem && (now - sysLast) < 1.5
        let micActive = captureMic && (now - micLast) < 1.5
        if sysActive && micActive {
            let n = min(sysBuf.count, micBuf.count)
            if n > 0 {
                mic = Array(micBuf.prefix(n))
                sys = Array(sysBuf.prefix(n))
                sysBuf.removeFirst(n)
                micBuf.removeFirst(n)
            }
        } else if sysActive {
            sys = sysBuf
            sysBuf = []
            micBuf = []
            mic = [Float](repeating: 0, count: sys.count)
        } else if micActive {
            mic = micBuf
            micBuf = []
            sysBuf = []
            sys = [Float](repeating: 0, count: mic.count)
        }
        lock.unlock()

        guard !mic.isEmpty else { return }
        func s16(_ f: Float) -> Int16 { Int16(max(-1.0, min(1.0, f)) * 32767) }
        var pcm = Data(capacity: mic.count * 4)
        for i in 0..<mic.count {
            var l = s16(mic[i]) // L = mic (you)
            var r = s16(sys[i]) // R = system (them)
            withUnsafeBytes(of: &l) { pcm.append(contentsOf: $0) }
            withUnsafeBytes(of: &r) { pcm.append(contentsOf: $0) }
        }
        let written = pcm.withUnsafeBytes { ptr -> Int in
            write(1, ptr.baseAddress, ptr.count)
        }
        if written <= 0 {
            // stdout closed — parent is gone
            exit(0)
        }
    }

    func stop() {
        mixTimer?.cancel()
        stream?.stopCapture { _ in exit(0) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { exit(0) }
    }
}

// --- main ---
signal(SIGPIPE, SIG_IGN)

let args = CommandLine.arguments
let useMic = !args.contains("--no-mic")
let useSystem = !args.contains("--no-system")
if !useMic && !useSystem {
    logErr("error", "nothing to capture")
    exit(1)
}

let capturer = Capturer(system: useSystem, mic: useMic)

for sig in [SIGINT, SIGTERM] {
    signal(sig, SIG_IGN)
    let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    src.setEventHandler { capturer.stop() }
    src.resume()
    // keep the source alive for the life of the process
    _ = Unmanaged.passRetained(src)
}

func begin() {
    if useMic {
        AVCaptureDevice.requestAccess(for: .audio) { granted in
            if !granted {
                logErr("warn", "microphone permission denied; capturing system audio only")
            }
            capturer.start()
        }
    } else {
        capturer.start()
    }
}

begin()
dispatchMain()
