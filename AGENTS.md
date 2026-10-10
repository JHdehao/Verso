# Verso 仓库约定（Codex / Claude Code 通用）

Safari 网页扩展 + 苹果 Translation 框架。设计、调研、里程碑见 `PLAN.md`。

- 本机没有 Xcode，**无法本地编译 Swift**；CI（`.github/workflows/build-ipa.yml`）里 `xcodegen generate` 生成工程再编译出无签名 IPA。工程描述改 `project.yml`，`*.xcodeproj` 和两个 Info.plist 都是生成物不入库。
- 网页端能在本机跑：`cd web && npm test`（jsdom 测切段 / 回填）、`npx tsc -p .`、`node build.mjs`（输出到 `Extension/Resources`，**不要建子目录**，Xcode 会平铺进扩展包）。
- 出包：`tools/ipa.sh`（要求 HEAD 已 push）→ 等 CI → oci 发布 SideStore 源 `https://jhai.cc.cd/<令牌>/verso/source.json`（令牌在仓库外 `~/.config/conch/sidestore-token`，和 Conch / Cove 共用；仓库公开，令牌绝不能进仓库）。
- 消息格式唯一来源：`web/src/protocol.ts`，Swift 侧 `Extension/Sources/SafariWebExtensionHandler.swift` 手写解析，改一边要改另一边。
- 语言列表在 `web/src/rules.ts` 的 `LANGUAGES` 和 `App/Sources/VersoApp.swift` 的 `AppInfo.languages` 各一份，保持一致。
- 图标：`tools/make-icons.py` 生成，产物入库。
- 部署目标 iOS 26.4（带格式翻译 `translate(AttributedString)`、`SkipTranslationAttribute`、`Strategy` 都是 26.4 起）。
