import Foundation
import Speech
import AVFoundation

// The parent app captures only the selected mic. This helper receives raw PCM,
// uses Apple's Speech framework, and never saves audio or transcripts.
func emit(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value), var line = String(data: data, encoding: .utf8) {
        line += "\n"
        FileHandle.standardOutput.write(line.data(using: .utf8)!)
    }
}
let args = CommandLine.arguments
let probe = args.count > 1 && args[1] == "--probe"
let requested = args.count > 2 ? args[2] : Locale.current.identifier
let locales = SFSpeechRecognizer.supportedLocales()
let locale = locales.first { $0.identifier.replacingOccurrences(of: "_", with: "-").lowercased() == requested.lowercased() } ?? Locale(identifier: requested)
guard let recognizer = SFSpeechRecognizer(locale: locale) else {
    emit(["type": "capabilities", "available": false, "engine": "macOS speech", "local": false, "error": "Speech recognition is unavailable for this language in macOS."])
    exit(1)
}
if probe {
    emit(["type": "capabilities", "available": true, "engine": "macOS speech", "local": recognizer.supportsOnDeviceRecognition, "locale": locale.identifier])
    exit(0)
}
recognizer.queue = OperationQueue.main
func newRequest() -> SFSpeechAudioBufferRecognitionRequest {
    let value = SFSpeechAudioBufferRecognitionRequest()
    value.shouldReportPartialResults = true
    value.taskHint = .dictation
    if recognizer.supportsOnDeviceRecognition { value.requiresOnDeviceRecognition = true }
    return value
}
var request = newRequest()
var task: SFSpeechRecognitionTask?
var ended = false
var inputEnded = false
var generation = 0
func finish(_ error: String? = nil) {
    if ended { return }
    ended = true
    if let error = error { emit(["type": "error", "message": error]) }
    emit(["type": "ended"])
    exit(error == nil ? 0 : 1)
}
func beginRecognition() {
    guard recognizer.isAvailable else { finish("macOS speech recognition is unavailable. Check the speech language and your connection."); return }
    generation += 1
    let current = generation
    request = newRequest()
    task = recognizer.recognitionTask(with: request) { result, error in
        if current != generation || ended { return }
        if let result = result {
            emit(["type": "transcript", "text": result.bestTranscription.formattedString, "final": result.isFinal])
            if result.isFinal {
                if inputEnded { finish() }
                else { beginRecognition() }
                return
            }
        }
        if error != nil { finish("macOS speech recognition stopped. Your dictated text stays in the draft.") }
    }
}
func start() {
    beginRecognition()
    emit(["type": "ready"])
    DispatchQueue.global(qos: .userInitiated).async {
        let input = FileHandle.standardInput
        var pending = Data()
        while true {
            let part = input.availableData
            if part.isEmpty { break }
            pending.append(part)
            let byteCount = pending.count - pending.count % 2
            if byteCount == 0 { continue }
            let bytes = Array(pending.prefix(byteCount))
            pending.removeFirst(byteCount)
            DispatchQueue.main.async {
                if ended { return }
                let count = bytes.count / 2
                guard let format = AVAudioFormat(standardFormatWithSampleRate: 16000, channels: 1),
                      let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count)),
                      let samples = buffer.floatChannelData?[0] else { finish("macOS could not prepare microphone audio."); return }
                buffer.frameLength = AVAudioFrameCount(count)
                for index in 0..<count {
                    let value = Int16(bitPattern: UInt16(bytes[index * 2]) | UInt16(bytes[index * 2 + 1]) << 8)
                    samples[index] = Float(value) / 32768.0
                }
                request.append(buffer)
            }
        }
        DispatchQueue.main.async {
            inputEnded = true
            request.endAudio()
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { finish() }
        }
    }
}
SFSpeechRecognizer.requestAuthorization { status in
    DispatchQueue.main.async {
        if status == .authorized { start() }
        else { finish("Allow Speech Recognition for Bot-Bots Dictation in macOS Privacy & Security settings.") }
    }
}
RunLoop.main.run()
