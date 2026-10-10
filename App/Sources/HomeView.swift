import SwiftUI
import Translation

/// 宿主 App 只管三件事：教你打开扩展、下载语言包（扩展进程弹不了下载确认）、试译自检。
struct HomeView: View {
    @State private var target = AppInfo.defaultTarget
    @State private var statuses: [String: LanguageAvailability.Status] = [:]
    @State private var download: TranslationSession.Configuration?
    @State private var downloading: String?
    @State private var sample: String?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Label("打开「设置 → App → Safari → 扩展 → Verso」，打开开关", systemImage: "1.circle")
                    Label("「权限」里把「所有网站」设为「允许」", systemImage: "2.circle")
                    Label("在 Safari 地址栏的页面菜单里点 Verso：翻译此页，或设成这个网站 / 这种语言总是翻译", systemImage: "3.circle")
                } header: {
                    Text("开启扩展")
                }

                Section {
                    Picker("译成", selection: $target) {
                        ForEach(AppInfo.languages, id: \.self) { Text(AppInfo.name($0)).tag($0) }
                    }
                    ForEach(AppInfo.languages.filter { $0 != target }, id: \.self) { source in
                        row(source)
                    }
                } header: {
                    Text("语言包")
                } footer: {
                    Text("翻译全部在本机完成。语言包由系统管理，删除在「设置 → App → 翻译 → 下载的语言」。")
                }

                Section {
                    Button("格式保留自检") { Task { await runSample() } }
                    if let sample {
                        Text(sample).font(.callout.monospaced()).textSelection(.enabled)
                    }
                } header: {
                    Text("试译")
                } footer: {
                    Text("翻译一句带链接和行内代码的英文，看方括号里的槽位编号是否跟着译文走。")
                }

                Section {
                    Text(AppInfo.version).font(.footnote).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Verso")
        }
        .translationTask(download) { session in
            try? await session.prepareTranslation()
            await MainActor.run { downloading = nil }
            await refresh()
        }
        .task(id: target) { await refresh() }
        .onOpenURL(perform: open)
    }

    @ViewBuilder
    private func row(_ source: String) -> some View {
        HStack {
            Text(AppInfo.name(source))
            Spacer()
            switch statuses[source] {
            case .installed:
                Text("已下载").foregroundStyle(.secondary)
            case .supported:
                if downloading == source {
                    ProgressView()
                } else {
                    Button("下载") { start(source) }.buttonStyle(.borderless)
                }
            case .unsupported:
                Text("不支持").foregroundStyle(.tertiary)
            default:
                ProgressView()
            }
        }
    }

    private func start(_ source: String) {
        downloading = source
        let config = TranslationSession.Configuration(source: Locale.Language(identifier: source), target: Locale.Language(identifier: target))
        if download?.source == config.source && download?.target == config.target {
            download?.invalidate()
        } else {
            download = config
        }
    }

    private func refresh() async {
        let availability = LanguageAvailability()
        let targetLanguage = Locale.Language(identifier: target)
        var result: [String: LanguageAvailability.Status] = [:]
        for source in AppInfo.languages where source != target {
            result[source] = await availability.status(from: Locale.Language(identifier: source), to: targetLanguage)
        }
        await MainActor.run { statuses = result }
    }

    /// 扩展弹窗里「在 Verso 中下载」跳过来：verso://download?src=en&tgt=zh-Hans
    private func open(_ url: URL) {
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let value = { (name: String) in items.first { $0.name == name }?.value }
        if let tgt = value("tgt"), AppInfo.languages.contains(tgt) { target = tgt }
        if let src = value("src") { start(src) }
    }

    private func runSample() async {
        sample = "翻译中…"
        let unit = TextUnit(id: "sample", runs: [
            TextRun(text: "Read the ", slot: 0), TextRun(text: "documentation", slot: 1),
            TextRun(text: " before you ", slot: 2), TextRun(text: "start", slot: 3),
            TextRun(text: ", then run ", slot: 4), TextRun(text: "npm install", slot: 5, skip: true),
            TextRun(text: ".", slot: 6),
        ])
        let start = Date()
        let (results, missing) = await Translator.shared.translate([unit], target: target, fluent: true, hint: "en")
        let ms = Int(Date().timeIntervalSince(start) * 1000)
        let result = results.first
        let text = result?.runs?.map { $0.slot < 0 ? $0.text : "[\($0.slot)]\($0.text)" }.joined() ?? ""
        sample = [
            "耗时 \(ms) ms",
            text.isEmpty ? nil : text,
            result?.error.map { "错误：\($0)" },
            missing.isEmpty ? nil : "缺语言包：\(missing.map(AppInfo.name).joined(separator: "、"))",
        ].compactMap { $0 }.joined(separator: "\n")
    }
}
