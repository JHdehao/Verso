# Verso

用苹果本机翻译（Translation 框架）把网页原样译成你的语言的 Safari 扩展，iOS / iPadOS 26.4+。

- **像原生一样**：译文写回原来的文本节点，链接、加粗、行内代码留在原位，页面样式照常生效；不加包裹层、不注入样式表。
- **记得住**：「这个网站总是 / 从不翻译」「永远翻译英语」，规则永久保存，打开页面就自动翻。
- **轻**：网页里只有一个约 10 KB 的脚本，没有任何网络请求；翻译全部在本机完成。
- **跟得上**：只翻看得见的段落，滚动、无限加载、单页应用的内容变化都会继续翻。

## 结构

| 目录 | 内容 |
|---|---|
| `web/` | 网页扩展（TypeScript）：`dom.ts` 切段 / 回填，`content.ts` 调度，`popup.ts` 弹窗；`npm test` 用 jsdom 测回填 |
| `Extension/` | Safari 扩展进程：收消息，调 `Shared/Translator.swift` |
| `Shared/` | Translation 框架封装：语种识别、按语言对缓存会话、带槽位属性的 AttributedString 批量翻译 |
| `App/` | 宿主 App：开启引导、语言包下载、格式保留自检 |
| `project.yml` | XcodeGen 工程描述 |

设计与调研见 [PLAN.md](PLAN.md)。

## 构建

本仓库在 GitHub Actions（macOS）上编译出无签名 IPA，用 SideStore 等工具自签安装。本地只需要 Node：

```bash
cd web && npm ci && npm test && npm run build   # 产物在 Extension/Resources
```

## 许可

MIT
