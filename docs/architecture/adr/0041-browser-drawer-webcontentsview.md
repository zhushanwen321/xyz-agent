# ADR 0041: Browser Drawer 采用 WebContentsView

> Status: Accepted (2026-07-24)
> 相关：`.xyz-harness/2026-07-24-browser-drawer/spec.md`、`docs/page-design/v3/panel/draft-browser-drawer.html`

## Context

drawer 集成 browser 需要在 SideDrawer 的 browser tab 内嵌入真实网页。三种候选技术路径：

| 方案 | URL 加载范围 | drawer 布局同步 | electronAPI 注入 | Electron 官方态度 |
|---|---|---|---|---|
| A. iframe | 多数站点拒绝嵌入（X-Frame-Options / CSP frame-ancestors） | 零成本（跟随 DOM） | 跨源不可 | 稳定 |
| B. `<webview>` tag | 任意 | 零成本（跟随 DOM） | webview preload | discouraged |
| C. WebContentsView | 任意 | 需 setBounds 同步 | 独立 preload，完全可控 | 推荐（30+） |

## Decision

**采用方案 C · WebContentsView。**

排除 A：iframe 无法加载 agent 最常引用的链接类型（Google / GitHub / 登录站点均设 `X-Frame-Options: DENY`），实用率极低。这是硬伤不是取舍。

排除 B：webview tag 在 Electron 42 仍可用但官方 discouraged。对一个要打包分发、长期升级路径长的桌面应用，discouraged 不是文档措辞，是升级时的真实风险。其"跟随 DOM 零同步成本"的优势不足以抵消。

选 C 的代价是必须手动 `setBounds` 同步 drawer 的动态 rect（开合 / 模式切换 / resize），这是有成熟工程模式的可处理成本（rAF + 时间节流，或主进程自监听 resize）。换来稳定的 API 表面 + 完整的主进程控制权 + 独立 preload。

## Alternatives considered

- **iframe**：见上，硬伤排除
- **webview tag**：见上，长期风险排除
- **"先 webview 跑通再迁 WebContentsView"过渡方案**：考虑过。否决，因为迁移涉及双套实现 + 数据迁移，不如一次性投入。MVP 用 WebContentsView 的额外成本主要在 rect 同步，可处理

## Consequences

正面：
- 稳定的 Electron 推荐 API，升级路径无顾虑
- 独立 webContents，可配独立 preload，主进程完全可控
- 自动暴露为独立 CDP target（已验证，见下），支持 Playwright/CDP 多 target 断言验收

负面：
- drawer 动态 rect 需手动 `setBounds` 同步（开合 / 模式切换 / 窗口 resize）
- 集成工作量最大（view 生命周期 + IPC 导航 + rect 同步）
- per-session view 池管理是新增主进程复杂度（`Map<sessionId, WebContentsView>` + LRU）

## 附：CDP target 验收机制（2026-07-24 验证通过）

WebContentsView 是独立 webContents，与主窗口并列暴露为 CDP target。验收"网页真的加载了"的方案：

- Electron 启动带 `--remote-debugging-port=<port>`（全局开关，对所有 webContents 生效，含 WebContentsView）
- `/json/list` 返回所有 targets，WebContentsView 以独立 `type:page` + 独立 `webSocketDebuggerUrl` 出现
- **验收代码必须按 url/title 选择性 attach**（主窗口和 WebContentsView 都是 `type:page`，不能用"第一个 target"）
- 验证脚本：`tools/verify-webcontentsview-cdp.cjs`（已跑通，Electron 42.3.3）

这使验收标准可写成"CDP 找到 URL 匹配的 target → 对其 DOM 做断言"，而非依赖 renderer 侧的间接证据。
