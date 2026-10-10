import Foundation
import SafariServices

/// 网页扩展 ⇄ 原生：后台脚本 browser.runtime.sendNativeMessage 发来的消息在这里处理。
/// 每条消息唤醒一次扩展进程，网页侧已经合批，一次处理几十段。
final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        let item = context.inputItems.first as? NSExtensionItem
        let message = item?.userInfo?[SFExtensionMessageKey] as? [String: Any] ?? [:]
        let request = NativeRequest(message)
        Task {
            let reply = await request.handle()
            let response = NSExtensionItem()
            response.userInfo = [SFExtensionMessageKey: reply]
            context.completeRequest(returningItems: [response], completionHandler: nil)
        }
    }
}

/// 消息格式见 web/src/protocol.ts
enum NativeRequest: Sendable {
    case translate(units: [TextUnit], target: String, fluent: Bool, hint: String?)
    case warm(target: String, fluent: Bool, hint: String?)
    case diag(target: String)
    case detect(String)
    case capabilities
    case invalid(String)

    init(_ message: [String: Any]) {
        switch message["op"] as? String {
        case "translate":
            let units = (message["units"] as? [[String: Any]] ?? []).map { unit in
                TextUnit(
                    id: unit["id"] as? String ?? "",
                    runs: (unit["runs"] as? [[String: Any]] ?? []).map { run in
                        TextRun(
                            text: run["t"] as? String ?? "",
                            slot: (run["s"] as? NSNumber)?.intValue ?? -1,
                            skip: (run["k"] as? NSNumber)?.boolValue ?? false)
                    })
            }
            self = .translate(
                units: units,
                target: message["target"] as? String ?? "zh-Hans",
                fluent: (message["fluent"] as? NSNumber)?.boolValue ?? true,
                hint: message["hint"] as? String)
        case "warm":
            self = .warm(
                target: message["target"] as? String ?? "zh-Hans",
                fluent: (message["fluent"] as? NSNumber)?.boolValue ?? true,
                hint: message["hint"] as? String)
        case "diag":
            self = .diag(target: message["target"] as? String ?? "zh-Hans")
        case "detect":
            self = .detect(message["text"] as? String ?? "")
        case "capabilities":
            self = .capabilities
        case let op:
            self = .invalid(op ?? "nil")
        }
    }

    func handle() async -> [String: Any] {
        switch self {
        case let .translate(units, target, fluent, hint):
            let start = Date()
            let (results, missing) = await Translator.shared.translate(units, target: target, fluent: fluent, hint: hint)
            return [
                "ok": true,
                "nms": Int(Date().timeIntervalSince(start) * 1000),
                "missing": missing,
                "results": results.map { result -> [String: Any] in
                    var out: [String: Any] = ["id": result.id]
                    if let runs = result.runs { out["runs"] = runs.map { ["t": $0.text, "s": $0.slot] } }
                    if let source = result.source { out["src"] = source }
                    if result.skipped { out["skip"] = 1 }
                    if let error = result.error { out["err"] = error }
                    return out
                },
            ]
        case let .warm(target, fluent, hint):
            await Translator.shared.warm(source: hint, target: target, fluent: fluent)
            return ["ok": true]
        case let .diag(target):
            return ["ok": true, "lines": await Translator.shared.diagnose(target: target)]
        case let .detect(text):
            guard let lang = Translator.detect(text, hint: nil) else { return ["ok": false, "error": "无法识别"] }
            return ["ok": true, "lang": lang]
        case .capabilities:
            guard let reason = Translator.fluentUnavailableReason else { return ["ok": true, "fluent": true] }
            return ["ok": true, "fluent": false, "reason": reason]
        case let .invalid(op):
            return ["ok": false, "error": "未知操作 \(op)"]
        }
    }
}
