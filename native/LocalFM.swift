import Foundation
import FoundationModels

struct Turn: Decodable { let role: String; let text: String }
struct Request: Decodable { let prompt: String; let history: [Turn] }

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
            emit(["type": "ready"]); return
        }
        do {
            let request = try JSONDecoder().decode(Request.self, from: FileHandle.standardInput.readDataToEndOfFile())
            guard !request.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  request.prompt.count <= Limits.prompt, request.history.count <= Limits.historyTurns,
                  request.history.allSatisfy({ ["user", "assistant"].contains($0.role) && $0.text.count <= Limits.historyText }) else {
                emit(["type": "error", "code": "invalidInput", "message": "入力が長すぎるか、不正です。"]); return
            }
            let base = LanguageModelSession(instructions: "You are a helpful assistant. Respond in the user's language. Be concise and honest about uncertainty.")
            var entries = Array(base.transcript)
            for turn in request.history {
                let segments: [Transcript.Segment] = [.text(Transcript.TextSegment(content: turn.text))]
                if turn.role == "user" {
                    entries.append(.prompt(Transcript.Prompt(segments: segments)))
                } else {
                    entries.append(.response(Transcript.Response(assetIDs: [], segments: segments)))
                }
            }
            let session = LanguageModelSession(transcript: Transcript(entries: entries))
            let stream = session.streamResponse(to: request.prompt, options: GenerationOptions(maximumResponseTokens: 1024))
            for try await snapshot in stream {
                emit(["type": "snapshot", "text": snapshot.content])
            }
            emit(["type": "done"])
        } catch {
            let code: String
            let message: String
            if let generationError = error as? LanguageModelSession.GenerationError {
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
