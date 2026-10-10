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
    /// 已确认装好语言包的「源>目标>译法」：每批都查 LanguageAvailability 要几十到上百毫秒，装好了就不再查
    private var installed: Set<String> = []

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
            let pair = "\(source)>\(target)>\(fluent)"
            if !installed.contains(pair) {
                switch await availability.status(from: sourceLanguage, to: targetLanguage) {
                case .installed:
                    installed.insert(pair)
                case .supported:
                    missing.append(source)
                    results += group.map { UnitResult(id: $0.id, source: source, error: "needsDownload") }
                    continue
                default:
                    results += group.map { UnitResult(id: $0.id, source: source, skipped: true, error: "unsupported") }
                    continue
                }
            }
            let session = session(source: sourceLanguage, target: targetLanguage, fluent: fluent)
            results += await translate(group, source: source, session: session)
        }
        return (results, missing)
    }

    /// 自检：同一句带链接 / 行内代码的英文，分别走单句 translate(AttributedString)（苹果文档示例的用法）和批量接口，
    /// 槽位编号用自定义属性 / 链接属性 / 加粗携带，两档译法各翻一次，看哪条路能把格式带回来
    func diagnose(target: String) async -> [String] {
        let parts: [(String, Int, Bool)] = [
            ("Read the ", 0, false), ("documentation", 1, false), (" before you ", 2, false),
            ("start", 3, false), (", then run ", 4, false), ("npm install", 5, true), (".", 6, false),
        ]
        enum Carrier: String, CaseIterable { case slot = "自定义属性", link = "链接属性", bold = "加粗" }
        func source(_ carrier: Carrier) -> AttributedString {
            var text = AttributedString()
            for (piece, slot, skip) in parts {
                var run = AttributedString(piece)
                switch carrier {
                case .slot: run[VersoSlotAttribute.self] = slot
                case .link: run.link = URL(string: "verso:\(slot)")
                case .bold: if slot == 1 || slot == 3 { run.inlinePresentationIntent = .stronglyEmphasized }
                }
                if skip { run[AttributeScopes.TranslationAttributes.SkipTranslationAttribute.self] = true }
                text.append(run)
            }
            return text
        }
        func describe(_ response: TranslationSession.Response, _ carrier: Carrier) -> String {
            guard let attributed = response.attributedTargetText else { return "无属性: \(response.targetText)" }
            var out = ""
            for run in attributed.runs {
                let piece = String(attributed[run.range].characters)
                switch carrier {
                case .slot: out += run[VersoSlotAttribute.self].map { "[\($0)]\(piece)" } ?? piece
                case .link: out += run.link.flatMap { Int($0.absoluteString.dropFirst(6)) }.map { "[\($0)]\(piece)" } ?? piece
                case .bold: out += run.inlinePresentationIntent?.contains(.stronglyEmphasized) == true ? "**\(piece)**" : piece
                }
            }
            return out
        }
        let sourceLanguage = Locale.Language(identifier: "en")
        let targetLanguage = Locale.Language(identifier: target)
        var lines: [String] = []
        for fluent in [false, true] {
            let session = TranslationSession(installedSource: sourceLanguage, target: targetLanguage, preferredStrategy: fluent ? .highFidelity : .lowLatency)
            let mode = fluent ? "流畅" : "快速"
            for carrier in Carrier.allCases {
                let start = Date()
                do {
                    let response = try await session.translate(source(carrier))
                    lines.append("\(mode)/单句/\(carrier.rawValue) \(Int(Date().timeIntervalSince(start) * 1000))ms \(describe(response, carrier))")
                } catch {
                    lines.append("\(mode)/单句/\(carrier.rawValue) 失败: \(error)")
                }
            }
            let start = Date()
            do {
                var described = "空结果"
                for try await response in session.translate(batch: [TranslationSession.Request(sourceText: source(.slot), clientIdentifier: "d")]) {
                    described = describe(response, .slot)
                }
                lines.append("\(mode)/批量序列/自定义属性 \(Int(Date().timeIntervalSince(start) * 1000))ms \(described)")
            } catch {
                lines.append("\(mode)/批量序列/自定义属性 失败: \(error)")
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

    /// 批量接口（translations(from:) / translate(batch:)）不带回属性，只有单句 translate(AttributedString) 能保格式（真机 build 6/7 诊断）。
    /// 单句并发 4 路；某段失败再串行重试，仍不行才退回纯文本（会丢掉段内链接等格式）
    private func translate(_ group: [TextUnit], source: String, session: TranslationSession) async -> [UnitResult] {
        var out = [UnitResult?](repeating: nil, count: group.count)
        await withTaskGroup(of: (Int, UnitResult?).self) { tasks in
            var next = 0
            while next < min(4, group.count) {
                let i = next
                tasks.addTask { (i, await Self.formatted(group[i], source: source, session: session)) }
                next += 1
            }
            while let item = await tasks.next() {
                out[item.0] = item.1
                if next < group.count {
                    let i = next
                    tasks.addTask { (i, await Self.formatted(group[i], source: source, session: session)) }
                    next += 1
                }
            }
        }
        var results: [UnitResult] = []
        for (i, unit) in group.enumerated() {
            if let result = out[i] { results.append(result) } else { results.append(await translateOne(unit, source: source, session: session)) }
        }
        return results
    }

    private static func formatted(_ unit: TextUnit, source: String, session: TranslationSession) async -> UnitResult? {
        guard let response = try? await session.translate(attributed(unit.runs)) else { return nil }
        return UnitResult(id: unit.id, runs: runs(response), source: source)
    }

    private func translateOne(_ unit: TextUnit, source: String, session: TranslationSession) async -> UnitResult {
        if let result = await Self.formatted(unit, source: source, session: session) { return result }
        do {
            let response = try await session.translate(unit.plain)
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
