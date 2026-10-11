import Foundation
import FoundationModels
import ImageIO

struct Turn: Decodable { let role: String; let text: String; let image: InputImage? }
struct Request: Decodable { let prompt: String; let history: [Turn]; let image: InputImage? }

struct InputImage: Decodable {
    let data: String
    func decoded() throws -> (CGImage, CGImagePropertyOrientation) {
        guard data.utf8.count <= 13981016, let bytes = Data(base64Encoded: data), bytes.count <= 10 * 1024 * 1024,
              let source = CGImageSourceCreateWithData(bytes as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int,
              width > 0, height > 0, width <= 16384, height <= 16384, width * height <= 40_000_000,
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw ImageError.invalid }
        let orientation = CGImagePropertyOrientation(rawValue: (properties[kCGImagePropertyOrientation] as? UInt32) ?? 1) ?? .up
        return (image, orientation)
    }
}
enum ImageError: Error { case invalid, unsupported }

// Keep in sync with src/limits.ts (checked by test/limits.test.cjs).
enum Limits {
    static let prompt = 12000
    static let historyTurns = 100
    static let historyText = 24000
}

func emit(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([10]))
    }
}

@main struct LocalFM {
    static func main() async {
        guard #available(macOS 26.0, *) else {
            emit(["type": "error", "code": "unsupportedOS", "message": "macOS 26以降が必要です。"]); return
        }
        await run()
    }

    @available(macOS 26.0, *)
    static func run() async {
        switch SystemLanguageModel.default.availability {
        case .available: break
        case .unavailable(let reason):
            let message: String
            let code: String
            switch reason {
            case .deviceNotEligible: code = "deviceNotEligible"; message = "このMacはApple Intelligenceに対応していません。"
            case .appleIntelligenceNotEnabled: code = "appleIntelligenceNotEnabled"; message = "システム設定でApple Intelligenceを有効にしてください。"
            case .modelNotReady: code = "modelNotReady"; message = "モデルの準備中です。Apple Intelligenceのダウンロード完了後に再確認してください。"
            @unknown default: code = "unavailable"; message = "モデルを利用できません。Apple Intelligenceの設定を確認してください。"
            }
            emit(["type": "error", "code": code, "message": message]); return
        }
        if CommandLine.arguments.contains("--status") {
            var images = false
            #if IMAGE_INPUT
            if #available(macOS 27.0, *) { images = true }
            #endif
            emit(["type": "ready", "images": images]); return
        }
        // The extension may start this process before the user sends anything; load the model
        // while blocked on stdin so the first token arrives sooner.
        let base = LanguageModelSession(instructions: "You are a helpful assistant. Respond in the user's language. Be concise and honest about uncertainty.")
        base.prewarm()
        do {
            let request = try JSONDecoder().decode(Request.self, from: FileHandle.standardInput.readDataToEndOfFile())
            guard !request.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  request.prompt.count <= Limits.prompt, request.history.count <= Limits.historyTurns,
                  request.history.allSatisfy({ ["user", "assistant"].contains($0.role) && $0.text.count <= Limits.historyText }) else {
                emit(["type": "error", "code": "invalidInput", "message": "入力が長すぎるか、不正です。"]); return
            }
            let imageCount = request.history.filter { $0.image != nil }.count + (request.image == nil ? 0 : 1)
            guard imageCount <= 3, request.history.allSatisfy({ $0.image == nil || $0.role == "user" }) else { throw ImageError.invalid }
            if imageCount > 0 {
                #if IMAGE_INPUT
                guard #available(macOS 27.0, *) else { throw ImageError.unsupported }
                #else
                throw ImageError.unsupported
                #endif
            }
            var entries = Array(base.transcript)
            for turn in request.history {
                var segments: [Transcript.Segment] = [.text(Transcript.TextSegment(content: turn.text))]
                #if IMAGE_INPUT
                if #available(macOS 27.0, *), let input = turn.image {
                    let (image, orientation) = try input.decoded()
                    segments.append(.attachment(Transcript.AttachmentSegment(content: .image(Transcript.ImageAttachment(image, orientation: orientation)))))
                }
                #endif
                if turn.role == "user" {
                    entries.append(.prompt(Transcript.Prompt(segments: segments)))
                } else {
                    entries.append(.response(Transcript.Response(assetIDs: [], segments: segments)))
                }
            }
            let session = LanguageModelSession(transcript: Transcript(entries: entries))
            var prompt = Prompt(request.prompt)
            #if IMAGE_INPUT
            if #available(macOS 27.0, *), let input = request.image {
                let (image, orientation) = try input.decoded()
                prompt = Prompt { request.prompt; Attachment(image, orientation: orientation) }
            }
            #endif
            let stream = session.streamResponse(to: prompt, options: GenerationOptions(maximumResponseTokens: 1024))
            for try await snapshot in stream {
                emit(["type": "snapshot", "text": snapshot.content])
            }
            emit(["type": "done"])
        } catch {
            let code: String
            let message: String
            if let imageError = error as? ImageError {
                code = "invalidInput"
                message = imageError == .unsupported ? "画像入力にはmacOS 27以降と対応ビルドが必要です。" : "画像を読み込めません。10 MB・4000万画素以下、各辺16384ピクセル以下の画像を選択してください。"
            } else if let generationError = error as? LanguageModelSession.GenerationError {
                switch generationError {
                case .exceededContextWindowSize: code = "contextLimit"; message = "会話がモデルの上限に達しました。"
                case .assetsUnavailable: code = "modelNotReady"; message = "モデルを利用する準備が整っていません。"
                case .guardrailViolation, .refusal: code = "refusal"; message = "このリクエストには回答できませんでした。"
                case .unsupportedLanguageOrLocale: code = "unsupportedLanguage"; message = "この言語では生成できませんでした。"
                case .rateLimited, .concurrentRequests: code = "rateLimited"; message = "現在モデルが混み合っています。"
                default: code = "generationFailed"; message = "生成できませんでした。"
                }
            } else if error is DecodingError {
                code = "invalidInput"; message = "入力を読み取れませんでした。"
            } else {
                code = "generationFailed"; message = "生成できませんでした。"
            }
            let native = error as NSError
            // Do not emit localizedDescription/userInfo: they may contain input text.
            let safeDomain = native.domain.range(of: "^[A-Za-z0-9_.-]{1,160}$", options: .regularExpression) != nil
            var event: [String: Any] = ["type": "error", "code": code, "message": message, "nativeCode": native.code]
            if safeDomain { event["nativeDomain"] = native.domain }
            emit(event)
        }
    }
}
