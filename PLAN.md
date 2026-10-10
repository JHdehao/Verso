# Verso — 用苹果本机翻译、像原生一样改写网页的 Safari 扩展

> 一句话：沉浸式翻译级别的网页改写能力 + 苹果 Translation 框架（离线、免费、隐私不出机）+ 可以永久记住的自动翻译规则。
> 名字取自书页的「背面 / 译面」。

## 0. 进度
- 2026-10-10：M0+M1+M2 代码一次写完（网页端切段 / 原地回填 / 重建 / 可见区调度 / DOM 变化跟随 / 永久规则 / 弹窗 / 自检；Swift 扩展进程 + Translator + 宿主 App 语言包与自检），`web` 单测 9 项通过；内容脚本压缩后约 10 KB。**待真机验证 R1 / R2**（弹窗「设置 → 自检」和 App「格式保留自检」）。
- 2026-10-10 真机（build 5，快速档）：**R1 通过**（扩展进程里能用 Translation 框架，自检单句 71 ms）。**R2 未过**：自检译文没有槽位编号、行内代码也被译了 → 带格式翻译失败退回纯文本；页面翻译往返均 2072 ms（整批失败后逐段重试两次所致）。build 6 加「带格式诊断」（自定义属性 / 链接属性 × 快速 / 流畅）和连续 3 批失败后整批纯文本的保护，等诊断结果定 R2 方案。
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
- 缓存：两级，见 §3.8。

### 3.5 永久规则（解决痛点）
优先级从高到低（弹窗设置里的「自动翻译网页」总开关关掉时，2–4 全部不生效，只剩手动）：
1. 当前页手动开关（只对这个标签页生效）
2. 站点规则：`always` / `never`（按 eTLD+1 匹配，可以手动编辑成通配符）
3. 语言规则：「永远自动翻译 英语 / 日语 / …」
4. 默认：不翻译

**首屏不闪原文（2026-10-10 已实现）**：内容脚本 `document_start` 注入，读规则和页面解析并行。
- 不看正文就能定的（标签页手动选择 / 总开关关 / 站点规则 / `<html lang>` / 没有语言规则）当场定；只有「靠语言规则 + 页面没声明语言」才等解析完问原生识别。
- 定下来要翻：① 发 `op: 'warm'` 预热原生（叫醒扩展进程，`hint` 已知时翻一个词让模型加载）；② 设置「防闪烁」开着就给 `html` 加 `opacity:0`，视口内段落都有结果或 0.5 秒到就显示；③ 等到 `<body>` 就开始切段，加载期间新段落 16 ms 去抖切段（加载完恢复 120 ms），视口内的段落优先查缓存、优先送翻。
- 缓存键里的页面语言提示固定取开始翻译时的值，中途识别出语言也不改。
- 自检里「打开到首段译文」从导航开始计时。无头 Chromium 模拟（翻译 80 ms）：预热 81 ms → 查缓存 138 ms → 送翻 147 ms → 首屏显示 227 ms。

### 3.6 交互（克制，不加悬浮球）
- 工具栏弹窗：一个大开关「翻译此页」；站点规则三段选择（自动 / 总是 / 从不）；「永远翻译〈检测到的语言〉」开关。
- iOS：长按段落 0.4 秒，原文以浮层显示，松手消失。macOS：按住 ⌥ 并把鼠标悬停在段落上看原文；`commands` 快捷键 ⌥⌘T 切换。
- 图标角标：已翻译的页面显示一个点。

### 3.7 宿主 App
- 引导开启扩展（设置 → Safari → 扩展 → 允许所有网站）。
- 语言包：用 `LanguageAvailability` 列出状态，用 `.translationTask { try await $0.prepareTranslation() }` 下载。
- 质量策略：高保真（Apple Intelligence）/ 低延迟，存进 App Group，扩展进程读取。
- 试译沙盒：粘贴一段 HTML，对比回填效果（也作为回归测试用例）。

### 3.8 缓存（2026-10-10 定稿，已实现：`web/src/cache.ts`）
目标：回访页面、同站重复的导航/按钮不再走原生调用——iOS 上每次 `sendNativeMessage` 都要唤醒扩展进程（R3），缓存放在 JS 侧才能连这一跳一起省掉。

**分层**
- L1 内容脚本 `Map`（已有，单页 3000 条）：同页重复段落零消息。目标语言 / 译法变了要清空（现有 bug：切换后旧语言译文会被复用）。
- L2 background 的 IndexedDB（`verso-cache`，扩展自己的源，不碰网站存储）：跨页面、跨标签页、跨重启。
- 不在原生侧再做一层：命中原生缓存仍要付唤醒代价，收益小于复杂度。R1 若失败改走宿主 App，L2 照样挡在前面不用改。

**键与值**
- 键 = `SHA-256(版本|目标语言|译法|页面语言基础码|cacheKey(runs))` 取前 128 位十六进制。`crypto.subtle` 现成；原文不入库，只存哈希。
- 页面语言进键：短句识别靠它兜底，不同 hint 可能识别出不同源语言。
- 版本常量 `CACHE_V`：改了 `serialize` / `merge` / Swift 对齐逻辑就 +1，旧条目自然失效、按 LRU 老化。
- 值 `{ r: Run[] | null, src, d: 天数戳, n: 字节估算 }`，`r = null` 表示「已是目标语言」。
- **只缓存稳定结果**：有译文的、`skip` 且带 `src` 无 `err` 的。`needsDownload` / `unsupported` / 出错一律不存（装了语言包后要能重翻）。

**读写流程（命中不陪未命中的等）**
1. 内容脚本先发 `op: 'lookup'`（只查缓存，一批最多 300 段，不受翻译批 40 段的限制）→ background 一个只读事务批量 `get` → 命中的马上回填。
2. 没命中的进翻译队列，`op: 'translate'` 带 `cache: 'wo'`：background 不再重查，只在原生翻完后写回。
3. 先回复，再开读写事务写入 / 刷新使用日期，不阻塞回填。
4. 数据库打不开 / 事务出错 → 整层旁路，退化成直连原生，绝不因缓存挡住翻译。
5. background 一醒就开库（`warm()`），和内容脚本切段并行；iOS 上 background 被回收后下次唤醒重开。

**容量与淘汰**
- `meta` 仓库记总字节数，和条目写入在同一事务里更新（写前 `get` 旧条目扣掉旧 `n`，覆盖不重复计）。
- 超过 200 MB → 按索引 `d` 升序游标删到 180 MB（留回差，避免每次写都淘汰）；每个事务最多删 2000 条、循环到达标，iOS 中途杀进程不白干。manifest 申请 `unlimitedStorage`。
- LRU 按天粗粒度：命中时 `d` 不是今天才回写，回访热点每天最多写一次。

**隐私**
- 隐私浏览窗口（`extension.inIncognitoContext`）只读不写，请求带 `priv: 1`。
- 弹窗「设置」里「缓存译文」开关（`settings.cache`，默认开；关掉后请求不带 `cache`，background 直连原生），下面显示「已用 x.x MB / 200 MB」+「清除缓存」（`bg: 'cache-clear'` → 清空两个仓库）。

**可观测**：弹窗状态行「已翻译 N 段（缓存 M）」；自检输出本页端到端耗时「首段 / 查缓存往返 / 翻译往返」（内容脚本侧计时，含唤醒 background）。目标：回访页面首段 < 50 ms、查缓存往返 < 20 ms。

**待真机数据再定**：磁盘实际占用用 `navigator.storage.estimate()` 校准（现在只按译文长度估，没算键和索引开销）。

**改动清单**
| 文件 | 改什么 |
|---|---|
| `web/src/cache.ts`（新，约 100 行） | 键计算、IDB 适配、`split`（分命中 / 未命中）、`cacheable`、淘汰；存储层抽成接口，单测用 `Map` 实现 |
| `web/src/background.ts` | `translate` 走缓存；新增 `cache-stat` / `cache-clear` |
| `web/src/protocol.ts` | 请求加 `priv?`，响应加 `hits?`（不进原生，Swift 侧不用改） |
| `web/src/content.ts` | 带 `priv`；切换目标语言 / 译法时清 L1 |
| `web/src/popup.ts` + `popup.html` | 缓存大小、清除按钮、自检显示命中 |
| `web/test/cache.test.mjs` | 拆分 / 合并、可缓存判定、淘汰回差、版本隔离（不为此引入 fake-indexeddb，IDB 适配层靠真机自检） |

**刻意不做**：跨标签页同键在途请求去重（概率低）；预取下一页；按站点排除缓存（`never` 规则已经不翻）。

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
| R6 | Safari 扩展 background 的 IndexedDB 是否可用、200 MB 配额够不够、iOS 杀进程后是否留存、ITP 7 天清理是否波及扩展源 | 弹窗看「已用」是否增长、回访看「缓存 M」；隔天回访再测；配额不够就把 `LIMIT` 降档；IDB 整体不可用就换 `storage.local`（同一 `Store` 接口） |

## 6. 里程碑
- **M0 可行性验证（先做）**：最小扩展 + 原生 handler 调 `TranslationSession(installedSource:)` 翻译一句带链接的 AttributedString，真机打印结果和耗时。验证 R1、R2。
- M1：切段 / 序列化 / 回填 + 可见区调度，替换模式完整可用。
- M2：永久规则 + 弹窗 + 原文浮层。
- M1.5：缓存（§3.8）+ 设置里的「自动翻译网页」总开关。2026-10-10 已实现，单测 14 项通过，待和 M0 一起真机测。
- M3：宿主 App（语言包、策略、试译沙盒）。
- M4：macOS、双语模式、属性翻译、shadow DOM、站点适配表（X / Reddit / GitHub）。
