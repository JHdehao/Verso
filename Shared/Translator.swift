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

    /// timing：各步耗时（ms），自检用来看冷启动的时间花在哪：detect 语言识别 / avail 查语言包 / translate 会话 + 翻译
    func translate(_ units: [TextUnit], target: String, fluent: Bool, hint: String?) async -> (results: [UnitResult], missing: [String], timing: [String: Int]) {
        var results: [UnitResult] = []
        var missing: [String] = []
        var groups: [String: [TextUnit]] = [:]
        var timing: [String: Int] = [:]
        var mark = Date()
        func lap(_ key: String) { timing[key, default: 0] += Int(Date().timeIntervalSince(mark) * 1000); mark = Date() }
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

        lap("detect")
        let targetLanguage = Locale.Language(identifier: target)
        let availability = LanguageAvailability(preferredStrategy: fluent ? .highFidelity : .lowLatency)
        for (source, group) in groups {
            mark = Date()
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
            lap("avail")
            let session = session(source: sourceLanguage, target: targetLanguage, fluent: fluent)
            results += await translate(group, source: source, session: session)
            lap("translate")
        }
        return (results, missing, timing)
    }

    /// 自检：① 带格式回归（单句 translate(AttributedString) 能否带回槽位、不翻译标记）；
    /// ② 吞吐：12 句真实长度的英文，串行单句 / 并发 4 路单句（生产路径）/ 批量接口（不带格式）各翻一遍的总耗时，决定并发度
    func diagnose(target: String) async -> [String] {
        let sourceLanguage = Locale.Language(identifier: "en")
        let targetLanguage = Locale.Language(identifier: target)
        let session = session(source: sourceLanguage, target: targetLanguage, fluent: false)
        var lines: [String] = []
        let ms = { (start: Date) in Int(Date().timeIntervalSince(start) * 1000) }

        let sample = TextUnit(id: "f", runs: [
            TextRun(text: "Read the ", slot: 0), TextRun(text: "documentation", slot: 1), TextRun(text: " before you start, then run ", slot: 2),
            TextRun(text: "npm install", slot: 3, skip: true), TextRun(text: ".", slot: 4),
        ])
        var start = Date()
        if let r = await Self.formatted(sample, source: "en", session: session) {
            lines.append("带格式 \(ms(start))ms " + (r.runs ?? []).map { $0.slot < 0 ? $0.text : "[\($0.slot)]\($0.text)" }.joined())
        } else {
            lines.append("带格式 失败")
        }

        let sentences = [
            "Ghidra is a software reverse engineering framework created and maintained by the National Security Agency Research Directorate.",
            "This framework includes a suite of full-featured, high-end software analysis tools that enable users to analyze compiled code.",
            "Capabilities include disassembly, assembly, decompilation, graphing, and scripting, along with hundreds of other features.",
            "Users may run Ghidra in either user-interactive or automated modes on a variety of platforms including Windows, macOS, and Linux.",
            "To install an official pre-built multi-platform release, download the latest release and extract it anywhere you like.",
            "If you are a developer, you can extend the framework with your own plugins and scripts written in Java or Python.",
            "Please see the developer guide for instructions on setting up a development environment and building from source.",
            "We welcome contributions from the community, including bug reports, feature requests, and pull requests.",
            "Before submitting a pull request, make sure that all tests pass and that your changes follow the coding style.",
            "Security vulnerabilities should be reported privately so that they can be fixed before being disclosed publicly.",
            "The project is distributed under the Apache License, which permits commercial use, modification, and distribution.",
            "Recent releases improved performance on large binaries and added support for several new processor architectures.",
        ]
        let units = sentences.enumerated().map { TextUnit(id: "s\($0.offset)", runs: [TextRun(text: $0.element, slot: 0)]) }

        start = Date()
        for unit in units { _ = await Self.formatted(unit, source: "en", session: session) }
        let serial = ms(start)
        start = Date()
        _ = await translate(units, source: "en", session: session)
        let parallel = ms(start)
        start = Date()
        _ = try? await session.translations(from: units.map { TranslationSession.Request(sourceText: $0.plain, clientIdentifier: $0.id) })
        let batch = ms(start)
        lines.append("吞吐 12 句：串行单句 \(serial)ms / 并发4单句 \(parallel)ms / 批量无格式 \(batch)ms")
        return lines
    }

    /// 预热：页面一判定要翻就调用，先把扩展进程叫醒、建好会话、翻一个词让模型加载，第一批正文不用再等冷启动
    func warm(source: String?, target: String, fluent: Bool) async {
        guard let source, Self.normalized(source) != Self.normalized(target) else { return }
        let sourceLanguage = Locale.Language(identifier: source)
        let targetLanguage = Locale.Language(identifier: target)
        let availability = LanguageAvailability(preferredStrategy: fluent ? .highFidelity : .lowLatency)
        guard case .installed = await availability.status(from: sourceLanguage, to: targetLanguage) else { return }
        installed.insert("\(source)>\(target)>\(fluent)")
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
