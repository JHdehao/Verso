import SwiftUI

@main
struct VersoApp: App {
    var body: some Scene {
        WindowGroup { HomeView() }
    }
}

enum AppInfo {
    static var version: String {
        let info = Bundle.main.infoDictionary ?? [:]
        let short = info["CFBundleShortVersionString"] as? String ?? "0"
        let build = info["CFBundleVersion"] as? String ?? "0"
        let commit = (info["VersoCommit"] as? String).flatMap { $0.isEmpty ? nil : " · \($0)" } ?? ""
        return "Verso \(short) (\(build))\(commit)"
    }

    /// 和网页侧 defaultTarget() 一致：中文区分简繁，其余取基础语言
    static var defaultTarget: String {
        switch Translator.normalized(Locale.preferredLanguages.first ?? "zh-Hans") {
        case "zh-hans": "zh-Hans"
        case "zh-hant": "zh-Hant"
        case let code: code
        }
    }

    static func name(_ code: String) -> String {
        Locale.current.localizedString(forIdentifier: code) ?? code
    }

    /// 与 web/src/rules.ts 的 LANGUAGES 保持一致
    static let languages = [
        "zh-Hans", "zh-Hant", "en", "ja", "ko", "fr", "de", "es", "it", "pt", "ru", "ar",
        "nl", "pl", "tr", "uk", "vi", "th", "id", "hi",
    ]
}
