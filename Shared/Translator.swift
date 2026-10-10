import Foundation
import FoundationModels
import NaturalLanguage
import Translation

/// 段内槽位编号：网页侧每个文本节点 / 原子元素一个编号，随 AttributedString 过翻译，回来按编号写回 DOM。
enum VersoSlotAttribute: CodableAttributedStringKey {
    typealias Value = Int
    static let name = "VersoSlot"
}

struct TextRun: Sendable {
    var text: String
    var slot: Int
    var skip = false
}

struct TextUnit: Sendable {
    var id: String
    var runs: [TextRun]
    var plain: String { runs.filter { !$0.skip }.map(\.text).joined() }
}

struct UnitResult: Sendable {
    var id: String
    var runs: [TextRun]?
    var source: String?
    var skipped = false
    var error: String?
}

/// 苹果 Translation 框架的薄封装：按语种分组、按语言对缓存会话、带格式批量翻译，失败退回纯文本。
actor Translator {
    static let shared = Translator()

    /// 「流畅」= .highFidelity，要 Apple 智能；不可用时系统静默退回标准模型，两档其实一样。nil = 可用。
    static var fluentUnavailableReason: String? {
        switch SystemLanguageModel.default.availability {
        case .available: nil
        case .unavailable(.deviceNotEligible): "本机不支持 Apple 智能"
        case .unavailable(.appleIntelligenceNotEnabled): "未开启 Apple 智能"
        case .unavailable(.modelNotReady): "Apple 智能模型还没下载好"
        case .unavailable: "Apple 智能不可用"
        }
    }

    private var sessions: [String: TranslationSession] = [:]
    /// 带格式整批翻译连续失败的次数（按语言对 + 译法）。到 3 次就当这一档不支持带格式，后面整批直接纯文本，省掉逐段重试
    private var formatFailures: [String: Int] = [:]

    func translate(_ units: [TextUnit], target: String, fluent: Bool, hint: String?) async -> (results: [UnitResult], missing: [String]) {
        var results: [UnitResult] = []
        var missing: [String] = []
        var groups: [String: [TextUnit]] = [:]
        for unit in units {
            guard let source = Self.detect(unit.plain, hint: hint) else {
                results.append(UnitResult(id: unit.id, skipped: true))
                continue
            }
            if Self.normalized(source) == Self.normalized(target) {
                results.append(UnitResult(id: unit.id, source: source, skipped: true))
                continue
            }
            groups[source, default: []].append(unit)
        }

        let targetLanguage = Locale.Language(identifier: target)
        let availability = LanguageAvailability(preferredStrategy: fluent ? .highFidelity : .lowLatency)
        for (source, group) in groups {
            let sourceLanguage = Locale.Language(identifier: source)
            switch await availability.status(from: sourceLanguage, to: targetLanguage) {
            case .installed:
                break
            case .supported:
                missing.append(source)
                results += group.map { UnitResult(id: $0.id, source: source, error: "needsDownload") }
                continue
            default:
                results += group.map { UnitResult(id: $0.id, source: source, skipped: true, error: "unsupported") }
                continue
            }
            let session = session(source: sourceLanguage, target: targetLanguage, fluent: fluent)
            results += await translate(group, source: source, session: session, key: "\(source)>\(target)>\(fluent)")
        }
        return (results, missing)
    }

    /// 自检：同一句带链接 / 行内代码的英文，槽位编号分别用自定义属性和链接属性携带，两档译法各翻一次，看格式能不能保住
    func diagnose(target: String) async -> [String] {
        let parts: [(String, Int, Bool)] = [
            ("Read the ", 0, false), ("documentation", 1, false), (" before you ", 2, false),
            ("start", 3, false), (", then run ", 4, false), ("npm install", 5, true), (".", 6, false),
        ]
        let source = Locale.Language(identifier: "en")
        let targetLanguage = Locale.Language(identifier: target)
        var lines: [String] = []
        for fluent in [false, true] {
            let session = TranslationSession(installedSource: source, target: targetLanguage, preferredStrategy: fluent ? .highFidelity : .lowLatency)
            for useLink in [false, true] {
                let label = "\(fluent ? "流畅" : "快速")/\(useLink ? "链接属性" : "自定义属性")"
                var text = AttributedString()
                for (piece, slot, skip) in parts {
                    var run = AttributedString(piece)
                    if useLink { run.link = URL(string: "verso:\(slot)") } else { run[VersoSlotAttribute.self] = slot }
                    if skip { run[AttributeScopes.TranslationAttributes.SkipTranslationAttribute.self] = true }
                    text.append(run)
                }
                let start = Date()
                do {
                    let responses = try await session.translations(from: [TranslationSession.Request(sourceText: text, clientIdentifier: "d")])
                    let ms = Int(Date().timeIntervalSince(start) * 1000)
                    guard let response = responses.first else { lines.append("\(label) \(ms)ms 空结果"); continue }
                    guard let attributed = response.attributedTargetText else {
                        lines.append("\(label) \(ms)ms 无属性: \(response.targetText)")
                        continue
                    }
                    var out = ""
                    for run in attributed.runs {
                        let piece = String(attributed[run.range].characters)
                        let slot: Int? = useLink ? run.link.flatMap { Int($0.absoluteString.dropFirst(6)) } : run[VersoSlotAttribute.self]
                        out += slot.map { "[\($0)]\(piece)" } ?? piece
                    }
                    lines.append("\(label) \(ms)ms \(out)")
                } catch {
                    lines.append("\(label) 失败: \(error)")
                }
            }
        }
        return lines
    }

    /// 预热：页面一判定要翻就调用，先把扩展进程叫醒、建好会话、翻一个词让模型加载，第一批正文不用再等冷启动
    func warm(source: String?, target: String, fluent: Bool) async {
        guard let source, Self.normalized(source) != Self.normalized(target) else { return }
        let sourceLanguage = Locale.Language(identifier: source)
        let targetLanguage = Locale.Language(identifier: target)
        let availability = LanguageAvailability(preferredStrategy: fluent ? .highFidelity : .lowLatency)
        guard case .installed = await availability.status(from: sourceLanguage, to: targetLanguage) else { return }
        _ = try? await session(source: sourceLanguage, target: targetLanguage, fluent: fluent).translate("Hello")
    }

    private func translate(_ group: [TextUnit], source: String, session: TranslationSession, key: String) async -> [UnitResult] {
        if formatFailures[key, default: 0] < 3 {
            let requests = group.map { TranslationSession.Request(sourceText: Self.attributed($0.runs), clientIdentifier: $0.id) }
            if let responses = try? await session.translations(from: requests) {
                formatFailures[key] = 0
                return responses.map { UnitResult(id: $0.clientIdentifier ?? "", runs: Self.runs($0), source: source) }
            }
            formatFailures[key, default: 0] += 1
        }
        if formatFailures[key, default: 0] >= 3 {
            let plain = group.map { TranslationSession.Request(sourceText: $0.plain, clientIdentifier: $0.id) }
            if let responses = try? await session.translations(from: plain) {
                return responses.map { UnitResult(id: $0.clientIdentifier ?? "", runs: [TextRun(text: $0.targetText, slot: -1)], source: source) }
            }
        }
        // 整批失败多半只是个别段落属性对不齐：逐段重试带格式，只有仍失败的那段才退回纯文本（会丢掉段内链接等格式）
        var results: [UnitResult] = []
        for unit in group {
            results.append(await translateOne(unit, source: source, session: session))
        }
        return results
    }

    private func translateOne(_ unit: TextUnit, source: String, session: TranslationSession) async -> UnitResult {
        let formatted = TranslationSession.Request(sourceText: Self.attributed(unit.runs), clientIdentifier: unit.id)
        if let response = try? await session.translations(from: [formatted]).first {
            return UnitResult(id: unit.id, runs: Self.runs(response), source: source)
        }
        do {
            let plain = TranslationSession.Request(sourceText: unit.plain, clientIdentifier: unit.id)
            guard let response = try await session.translations(from: [plain]).first else {
                return UnitResult(id: unit.id, source: source, error: "empty")
            }
            return UnitResult(id: unit.id, runs: [TextRun(text: response.targetText, slot: -1)], source: source)
        } catch {
            return UnitResult(id: unit.id, source: source, error: String(describing: error))
        }
    }

    private func session(source: Locale.Language, target: Locale.Language, fluent: Bool) -> TranslationSession {
        let key = "\(source.minimalIdentifier)>\(target.minimalIdentifier)>\(fluent)"
        if let session = sessions[key] { return session }
        let session = TranslationSession(installedSource: source, target: target, preferredStrategy: fluent ? .highFidelity : .lowLatency)
        sessions[key] = session
        return session
    }

    static func attributed(_ runs: [TextRun]) -> AttributedString {
        var string = AttributedString()
        for run in runs {
            var piece = AttributedString(run.text)
            piece[VersoSlotAttribute.self] = run.slot
            if run.skip { piece[AttributeScopes.TranslationAttributes.SkipTranslationAttribute.self] = true }
            string.append(piece)
        }
        return string
    }

    static func runs(_ response: TranslationSession.Response) -> [TextRun] {
        guard let target = response.attributedTargetText else {
            return [TextRun(text: response.targetText, slot: -1)]
        }
        var out: [TextRun] = []
        for run in target.runs {
            let text = String(target[run.range].characters)
            let slot = run[VersoSlotAttribute.self] ?? -1
            if let last = out.last, last.slot == slot {
                out[out.count - 1].text += text
            } else {
                out.append(TextRun(text: text, slot: slot))
            }
        }
        return out
    }

    /// 短句识别不准时用页面语言兜底；没有字母（数字、符号）返回 nil，不翻
    static func detect(_ text: String, hint: String?) -> String? {
        guard text.unicodeScalars.contains(where: { CharacterSet.letters.contains($0) }) else { return nil }
        let recognizer = NLLanguageRecognizer()
        recognizer.processString(text)
        let best = recognizer.languageHypotheses(withMaximum: 1).first
        if let best, best.value >= 0.6 || hint == nil || text.count >= 40 {
            return best.key.rawValue
        }
        return hint ?? best?.key.rawValue
    }

    /// 中文区分简繁，其余只看基础语言
    static func normalized(_ code: String) -> String {
        let lower = code.lowercased()
        if lower.hasPrefix("zh") {
            return lower.contains("hant") || lower.contains("-tw") || lower.contains("-hk") ? "zh-hant" : "zh-hans"
        }
        return String(lower.split(separator: "-").first ?? Substring(lower))
    }
}
