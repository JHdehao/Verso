# Verso — 用苹果本机翻译、像原生一样改写网页的 Safari 扩展

> 一句话：沉浸式翻译级别的网页改写能力 + 苹果 Translation 框架（离线、免费、隐私不出机）+ 可以永久记住的自动翻译规则。
> 名字取自书页的「背面 / 译面」。

## 0. 进度
- 2026-10-10：M0+M1+M2 代码一次写完（网页端切段 / 原地回填 / 重建 / 可见区调度 / DOM 变化跟随 / 永久规则 / 弹窗 / 自检；Swift 扩展进程 + Translator + 宿主 App 语言包与自检），`web` 单测 9 项通过；内容脚本压缩后约 10 KB。**待真机验证 R1 / R2**（弹窗「设置 → 自检」和 App「格式保留自检」）。
- 与原设计的差异：回填优先「原地改文本节点」（React 等框架安全），只有行内元素顺序被调换时才克隆重建；iOS 长按看原文暂不做（与系统长按选字冲突），用弹窗「显示原文」；站点规则按主机名（去 www），没有接公共后缀表。

## 1. 要解决的问题

- Safari 自带翻译每次都要手动点；跨域名、新标签页就失效，没有「永远自动翻译英文」或「这个网站总是翻译」的开关。
- 沉浸式翻译功能强，但很重：4 MB 内容脚本 + 3.8 MB 设置页，带 GA 上报（翻译过的域名 + 停留时长），还要登录、有会员体系。
- 目标：**轻**（内容脚本 < 20 KB，没有框架，没有网络请求）、**像原生**（译文继承页面原有样式，链接、加粗、行内代码都留在原来的位置）、**规则能永久保存**。

## 2. 调研结论（2026-10-10）

| 路线 | 结论 |
|---|---|
| 网页 Translator API（`Translator.create`） | Safari 27.2 / iOS Safari 都不支持，WebKit 没表态 → 不可用 |
| 用代码触发 Safari 自带翻译 | 没有公开 API → 不可用 |
| WASM 本地模型（Bergamot 等） | 每个语言对约 20 MB，质量不如苹果，还受 iOS 扩展内存上限限制 → 放弃 |
| **原生扩展进程 + Translation 框架** | **采用**，依据如下 |

- `TranslationSession(installedSource:target:)`（iOS / macOS 26.0+）：不需要界面，直接创建会话，适合在扩展进程里使用。前提是语言包已经下载好，否则会抛错。
- `translate(_: AttributedString)` 和带属性的批量请求（26.4+）：**保留格式，自定义属性也原样保留**，框架会在源语言和目标语言之间对齐格式。这是「还原度」的根基。
- `Strategy.highFidelity`（Apple Intelligence 模型，更流畅）/ `.lowLatency`（传统模型，更快），都是 26.4+。
- 语言包下载必须由 SwiftUI 的 `.translationTask` 弹窗请求用户同意 → 放到宿主 App 里做。
- 社区先例：OpenTranslate（GPL，Safari 扩展，接的是云端服务）、Apollo-Reborn（在 App 内用 headless 会话）。**没有找到在 Safari 扩展进程里调用 Translation 框架的公开先例** → 见风险 R1，M0 先验证这一点。
- 沉浸式翻译 Safari 版逆向结论（v1.33.3）：nativeMessaging 只用来查询地区；段落识别、MutationObserver、规则表这些思路可以借鉴，不照搬它的代码。

## 3. 架构

```
网页 ── content.js ──runtime.sendMessage──▶ background.js ──sendNativeMessage──▶ 扩展进程（Swift）
        切段 / 序列化 / 回填              合批 / 缓存（IndexedDB）               语种识别 NLLanguageRecognizer
        规则判断 / 观察 DOM 变化                                                 TranslationSession（按语言对缓存会话）
                                                                                       │ 缺语言包
宿主 App（SwiftUI）◀────────── verso://download?src=en&tgt=zh-Hans ──────────────┘
  语言包管理 / 质量策略 / 引导开启扩展
```

### 3.1 切段（找「翻译单元」）
- 从上往下遍历 DOM（包括打开状态的 shadow root）。「翻译单元」= 子节点只有文本和行内元素的块级元素（p、li、h1-6、td、blockquote、figcaption、dt/dd，以及只含行内内容的 div）。
- 跳过：`script style noscript code pre kbd samp var textarea input select svg math`、`[contenteditable]`、`[translate=no]`、`.notranslate`，以及已经是目标语言的段落。
- 属性也要翻：`title`、`alt`、`placeholder`、`aria-label`，以及 `document.title`。

### 3.2 序列化（还原度的核心）
- 每个单元转成一组片段：`[{t:"Read the ", n:0}, {t:"docs", n:2}, {t:" first.", n:0}]`。`n` 指向「行内元素链」表（如 `0=单元本身`，`2=<a href><b>`）。
- 原子行内元素（`img`、`br`、`code`、`kbd`、`math`、`svg`、带 `translate=no` 的元素）序列化为一个占位字符（U+FFFC）加 `n`，不参与翻译，翻译后原样放回。
- Swift 侧把片段拼成带自定义属性 `VersoNode` 的 AttributedString，交给框架翻译，再按属性拆回片段。

### 3.3 回填（替换模式，跟 Safari 一样）
- 每个输出片段按 `n` **浅克隆**原来的行内元素链（属性全部保留，链接照样能点，CSS 照样生效），再填入译文；原子元素直接放回原节点。
- 原来的子节点存进 `WeakMap`，切回原文时瞬间恢复，不用重新请求。
- 不额外包 wrapper、不注入样式表，页面 CSS 直接作用在译文上 → 看起来就是网站本来的样子。
- 可选的双语模式只加一个 `<span lang>` 跟在原文后面，复用原元素的样式。

### 3.4 调度
- 用 `IntersectionObserver`（rootMargin 为一屏）只翻可见区域和下一屏，进入视口前就翻好。
- 用 `MutationObserver` 处理 SPA 和无限滚动：先去抖，再用 `requestIdleCallback` 处理；带「我自己改的」标记，避免自己触发自己。
- background 每 16 ms 合并一次请求（上限 40 段或 6000 字符），一次原生调用翻完一批，降低 IPC 开销。
- 缓存：background 用 IndexedDB 存「(源语言, 目标语言, 片段哈希) → 译文片段」，上限 20 MB，按 LRU 淘汰；回访页面秒出。

### 3.5 永久规则（解决痛点）
优先级从高到低：
1. 当前页手动开关（只对这个标签页生效）
2. 站点规则：`always` / `never`（按 eTLD+1 匹配，可以手动编辑成通配符）
3. 语言规则：「永远自动翻译 英语 / 日语 / …」
4. 默认：不翻译

`document_start` 时先读 `storage.local` 做判断（同步缓存一份在内存里），命中就在首屏内容出现时开始翻译，不闪原文。

### 3.6 交互（克制，不加悬浮球）
- 工具栏弹窗：一个大开关「翻译此页」；站点规则三段选择（自动 / 总是 / 从不）；「永远翻译〈检测到的语言〉」开关。
- iOS：长按段落 0.4 秒，原文以浮层显示，松手消失。macOS：按住 ⌥ 并把鼠标悬停在段落上看原文；`commands` 快捷键 ⌥⌘T 切换。
- 图标角标：已翻译的页面显示一个点。

### 3.7 宿主 App
- 引导开启扩展（设置 → Safari → 扩展 → 允许所有网站）。
- 语言包：用 `LanguageAvailability` 列出状态，用 `.translationTask { try await $0.prepareTranslation() }` 下载。
- 质量策略：高保真（Apple Intelligence）/ 低延迟，存进 App Group，扩展进程读取。
- 试译沙盒：粘贴一段 HTML，对比回填效果（也作为回归测试用例）。

## 4. 平台与构建
- iOS / iPadOS 26.4+（主），macOS 26.4+（共享同一份代码）。
- 工程：Xcode 多平台 Safari Web Extension 模板；JS 用纯 TypeScript，经 esbuild 打成单文件。
- 构建：照搬 Cove 的流程（GitHub Actions `macos-26` 出无签名 IPA → SideStore 源）。扩展需要单独一个 App ID；如果用免费账号，要占 2 个名额。

## 5. 风险
| # | 风险 | 应对 |
|---|---|---|
| R1 | Translation 框架能不能在 Safari 扩展进程里跑（没有公开先例） | M0 真机验证；不行就改成「macOS 用登录项 XPC；iOS 用宿主 App 预热 + App Group 缓存」，体验会降级 |
| R2 | 中英语序调换后，自定义属性对齐不准 | 试译沙盒积累用例；对齐失败时退回纯文本翻译，并保留首尾链接 |
| R3 | iOS 原生消息每次唤醒扩展进程的延迟 | 合批 + 缓存 + 预取下一屏 |
| R4 | 扩展进程不能弹下载窗 | 返回 `needsDownload`，弹窗里的按钮跳转宿主 App |
| R5 | 用户没开「允许所有网站」时，每个站点都要授权 | 引导页说明；弹窗里检测到后提示 |

## 6. 里程碑
- **M0 可行性验证（先做）**：最小扩展 + 原生 handler 调 `TranslationSession(installedSource:)` 翻译一句带链接的 AttributedString，真机打印结果和耗时。验证 R1、R2。
- M1：切段 / 序列化 / 回填 + 可见区调度，替换模式完整可用。
- M2：永久规则 + 弹窗 + 原文浮层。
- M3：宿主 App（语言包、策略、试译沙盒）+ 缓存。
- M4：macOS、双语模式、属性翻译、shadow DOM、站点适配表（X / Reddit / GitHub）。
