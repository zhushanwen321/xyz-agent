# Browser Drawer · 设计文档（spec）

> 模块 **L2** · Panel Side Drawer · browser tab 从文本空壳升级为真实嵌入式浏览器
> 配套设计稿：`docs/page-design/v3/panel/draft-browser-drawer.html`
> 上游：`docs/page-design/v3/panel/spec.md`（drawer 归属）、`design-tokens.md`（v3 冷蓝暗色）
> 技术方案：C · WebContentsView（用户 2026-07-24 确认）
> 产品定位：**帮助 agent 的浏览器嵌入工具**（非被动查看器），二期实现"网页内容→composer badge→agent"协作闭环

## 0. 分阶段规划（用户 2026-07-24 确认）

| 阶段 | 范围 | 状态 |
|---|---|---|
| **一期** | 浏览器嵌入（WebContentsView）+ 点击对话流 http(s) 链接在 drawer 内跳转 | 本 spec 详述 |
| **二期** | browser 内框选/评论 → 作为 badge 插入 composer → 发给 agent（AI 协作闭环） | §13 简述扩展点 + 可行性结论 |

**分阶段依据（架构合理性）**：一期完全独立于二期，不受 pi 限制。二期瓶颈在 pi 侧（见 §13），但二期能否做、做成什么形态，不影响一期架构决策。这是分阶段的合理性所在。

## 1. 背景与目标

### 1.1 问题

agent 输出的 http(s) 链接当前一律走 `shell.openExternal` → 系统浏览器打开。问题：
- **上下文断裂**：用户被甩出应用，再切回时丢失工作焦点
- **不可追溯**：系统浏览器的历史与 agent 对话脱节
- **drawer 已留槽位但空置**：`SideDrawerTab` 类型已含 `'browser'`，icon/i18n 齐备，但 tab 内容只是 extension 推送的纯文本/widget，无真实网页渲染能力

### 1.2 目标

agent 输出的 http(s) 链接在 **drawer 的 browser tab** 内打开，应用内浏览，不离开工作上下文。并为二期"网页内容回传 agent"奠定基础。

### 1.3 非目标（明确不做）

- 不做全功能浏览器（无书签、无历史、无下载管理、无多账号 cookie 隔离）
- 不改 pi 侧任何东西（agent 侧不感知 browser 的存在）
- 不做"agent 主动推 URL"（触发源仅"用户点击 agent 输出的链接"）
- 不纳入 tool 调用结果区的纯文本 URL（Block.vue，见 §5 边界 case）
- 不替代系统浏览器做登录态长会话（drawer browser 是临时预览，非主力浏览器）

## 2. 分流设计（核心）

### 2.1 现状：天然已分流

探索确认，`useMarkdownInteractions.ts` 的 `onClick` 已是**三路有序分流**，命中即 `return`：

| 优先级 | 选择器 | 命中条件 | 当前 destination |
|---|---|---|---|
| ① | `.md-codeblock__copy` | 代码块复制按钮 | 复制 |
| ② | `.md-filepath` | 文件路径链接（markdown.ts 白名单 linkify 生成，带 `data-path` base64，**无 href**） | `selectFile` + `drawer.open('detail')` |
| ③ | `a[href]` + `EXTERNAL_HREF_RE`（`^https?://`） | 外链 URL | `openExternal` → 系统浏览器 |

**关键事实**：② 和 ③ **互斥且有序**。
- `.md-filepath` 元素无 `href` 属性（只有 `class` + `data-path`），所以 `target.closest('a[href]')` 对它返回 null → 不会误触 ③
- markdown-it 的 linkify 产生的 `<a href>` 内部 text 被 `inLink` 标志跳过，不会再被插 `.md-filepath` → 不会 `<a>` 嵌套
- 判断顺序 ② → ③，文件优先于 URL

### 2.2 本次改造：仅改 ③ 的 destination

**文件分支 ② 零改动**。`markdown.ts` 的 linkify 规则、`useMarkdownInteractions` 的分支②、DetailPane 消费链路全部不动。

**URL 分支 ③**：`openExternal(href)` → `drawer.open('browser', { url: href })`

```ts
// useMarkdownInteractions.ts:146-156 改造前
if (EXTERNAL_HREF_RE.test(href)) {
  e.preventDefault()
  openExternal(href).catch(() => {})
}

// 改造后
if (EXTERNAL_HREF_RE.test(href)) {
  e.preventDefault()
  drawer.open('browser', { url: href })  // 替代 openExternal
}
```

### 2.3 分流判据不变

`EXTERNAL_HREF_RE = /^https?:\/\//i` 是 URL 的唯一判据，**保持不变**。边界 case 见 §5。

## 3. 技术方案 C · WebContentsView

### 3.1 为什么选 C（不选 iframe / webview tag）

| | iframe | webview tag | **WebContentsView** |
|---|---|---|---|
| URL 加载范围 | 多数站点拒绝嵌入（X-Frame-Options） | 任意 | **任意** |
| drawer 布局同步 | 零成本 | 零成本 | 需 setBounds 同步 |
| electronAPI 注入 | 跨源不可 | webview preload | **独立 preload，完全可控** |
| Electron 官方 | 稳定 | discouraged（升级风险） | **推荐（30+）** |
| 集成工作量 | 最小 | 中 | 大 |

iframe 硬伤排除（打不开 Google/GitHub/登录站）；webview tag 的 discouraged 在长期维护的桌面应用是升级路径上的真实风险。WebContentsView 是终态选择。

### 3.2 架构分层

```
触发层  renderer: useMarkdownInteractions 拦截 <a href>
           ↓ drawer.open('browser', { url })
状态层  renderer: useSideDrawer（OpenDrawerOptions 加 url 字段）
           ↓ mount <BrowserPane :url :session-id>
桥接层  renderer: BrowserPane.vue（导航栏 + 地址栏 + back/forward/reload + 加载态）
           ↓ IPC
主进程  main: BrowserViewManager（WebContentsView 生命周期 + setBounds + 导航事件回传）
           ↓ attach to BrowserWindow
嵌入层  WebContentsView（独立 webContents，加载真实 URL）
```

### 3.3 关键设计决策

**D1. View 归属窗口**：WebContentsView attach 到 `focusedSessionId` 对应的 BrowserWindow。`WindowManager.findSessionBySessionId` 已有 session→window 映射可复用。切 session / 切窗口时 view re-attach。

**D2. rect 计算由 renderer 推送，主进程只执行**：主进程不自己算 drawer 位置（否则与 renderer 各算一套导致漂移）。renderer 用 `getBoundingClientRect()` 算出浏览器面板的矩形（CSS 像素），通过 IPC 传给主进程 `setBounds`。

> [HISTORICAL · 审查修正] **不要乘 devicePixelRatio**。`WebContentsView.setBounds(bounds)` 的单位是 **DIP（device-independent pixels）**，与 CSS 像素 1:1，不是物理像素。`getBoundingClientRect()` 返回的就是 CSS 像素。在 retina 屏（dpr=2）上误乘 dpr 会导致 view 定位到屏外 + 尺寸翻倍。多显示器混合 DPI 由主进程 `screen.on('display-metrics-changed')` + `win.on('restore')` 触发 renderer 重算 rect 处理，不靠单个 dpr 值。

**D3. resize 节流：rAF + 时间双限**：drawer 开合 / 模式切换是离散事件；用户拖拽主窗口 resize 是高频连续。
- `requestAnimationFrame` 节流基础（合并同帧多次 resize）
- **加时间节流下限（~33ms / 30fps）**：rAF 单独约 60fps，每秒 ~60 次同步 `ipcRenderer.invoke('setBounds')` 会阻塞主进程单线程
- **备选方案（更优）**：主进程 `win.on('resize')` 自己触发 view 缩放（drawer 相对窗口比例在 resize 期间不变），renderer 只在 drawer 开合/模式切换等离散事件推一次 rect。减少跨进程 IPC

**D4. openExternal 作降级保留**：非 http(s) 协议、view 加载失败、用户显式选"系统浏览器打开"时，回退 `openExternal`。原链路完整保留不删除。

**D5. 主进程 view 池 + per-session 隔离** [审查新增]：ADR-0036 是 renderer 的 `useSessionScopedState`，对主进程 native view 无约束力。主进程必须自建 view 池：
- 结构：`Map<sessionId, WebContentsView>`（主进程 BrowserViewManager 持有）
- 切 session 时 renderer 发 `session:focus` → 主进程 swap visible view（隐藏旧 sid 的 view，显示新 sid 的 view）
- **数量上限 + LRU**：默认上限 3（每个 view 是独立 renderer+GPU 进程）。超过上限 LRU 销毁最旧 session 的 view，下次切回重建
- 一致性：renderer drawerState swap 与主进程 view swap 必须由同一 IPC 触发，避免双 Map 不同步

**D6. view 显隐生命周期状态机** [审查新增]：SideDrawer 是 `v-if="isOpen"`（关闭即 unmount），tab 切换也 unmount。但 keep-alive 的 native view 不会随 DOM 销毁（native view z-order 高于 renderer DOM，会继续盖在屏幕上）。必须显式驱动：
- BrowserPane `onBeforeUnmount` → IPC `browser:hide`（主进程 `view.setBounds({0,0,0,0})` 或 `contentView.removeChildView(view)`）
- BrowserPane `onMounted` → IPC `browser:show`（重新 attach + setBounds）
- **不可依赖 ResizeObserver 被动跟随**：占位 div 消失时 Observer 断了，view 仍需主动隐藏
- drawer 过渡动画（320ms opacity）期间，view 显隐时序需与动画对齐，避免"网页悬浮在关闭中的抽屉外"

## 4. BrowserPane.vue 组件设计

### 4.1 结构（参考 DetailPane.vue 模式）

```
BrowserPane.vue
├── browser-chrome（导航栏）
│   ├── browser-tabs（多 tab 条，见 §4.4 决策点）
│   └── browser-toolbar（back/forward/reload + 地址栏 + 菜单）
├── browser-vp（viewport 占位区，WebContentsView 叠加其上）
└── browser-status（状态栏：安全指示 + target URL + 新消息提示）
```

### 4.2 导航栏元素（MANDATORY）

| 元素 | 作用 | 必须 |
|---|---|---|
| 地址栏 | 显示当前 URL，防钓鱼（did-navigate 回填真实 URL）。**可选中文本，支持 Cmd+C 复制** | ✅ |
| 安全锁 | https 指示，可点击看证书信息 | ✅ |
| back/forward | 历史导航 | ✅ |
| reload | 刷新当前页 | ✅ |
| 外链导出 | "在系统浏览器打开"（openExternal 降级入口，也是登录墙页面的出口） | ✅ |
| 加载进度 | loading 态 spinner / 进度条 | ✅ |
| 缩放 | Cmd+/- / Cmd+0 字号控制，per-session 持久化 | ✅ |
| 复制链接 | 一键复制当前 URL（分享/笔记闭环） | ✅ |

**防钓鱼**：地址栏不能只显示初始 URL。必须监听 WebContentsView 的 `did-navigate` / `did-navigate-in-page` 事件，回填**真实当前 URL**。否则重定向到钓鱼站而地址栏不变。
> [审查标注] `history.pushState`/`replaceState` 改 URL 不重载文档，是否触发 `did-navigate-in-page` 各 Electron 版本行为不一。实现时**必须实测**；不触发则需补覆盖（注入脚本到零信任页本身有风险，需 contextIsolation 隔离评估）。

**登录墙 CTA** [审查新增]：agent 最常引用的高价值链接（GitHub private、Notion、内部文档站）常需登录，drawer browser 无登录态。BrowserPane 检测到 401/403/登录表单特征时，主动在顶部显示醒目提示条：「此页可能需要登录，[在系统浏览器打开]」。不沉默让用户撞墙。

### 4.3 viewport 与 WebContentsView 的叠加

WebContentsView 是主进程 native view，不参与 renderer DOM。`browser-vp` 是一个**透明占位 div**，作用：
1. 提供 rect 给主进程 setBounds（ResizeObserver 监听）
2. 显示加载/错误/空态 overlay（native view 在加载时可能白屏）

native view 的 z-order 高于 renderer DOM，加载完成后会盖住 overlay。

### 4.4 历史 / 导航栈语义 [审查新增]

无论是否做多 tab（§6 Q1），back/forward 栈语义必须明确，否则实现会拍脑袋：

| 事件 | 对历史栈的影响 |
|---|---|
| 点击 agent 输出的新链接 | **reset**（清空历史，新 URL 成栈底）。理由：agent 链接是用户主动发起的新浏览任务，与上一个无关 |
| 页面内点击链接（target=_blank 或普通 a） | **append**（push 到历史栈，可 back 回原页） |
| 重定向（HTTP 302 / JS location） | **replace** 当前条目 |
| 用户主动 reload | 不影响历史栈 |

### 4.5 drawer 打开期间 agent 新消息感知 [审查新增]

PRODUCT.md DP2「通知驱动不打扰」+ DP5「状态即信任」。drawer 打开期间对话流被遮挡/压缩，agent 若继续输出消息（尤其需确认的告警），用户必须能感知：
- drawer 边缘或 tab 栏非侵入式提示（新消息计数角标 / 闪烁点）
- 仅在 agent 新消息到达时触发，不打扰正常浏览
- 这是 MVP 必需，非打磨项（否则长任务监控核心功能在 drawer 打开时静默失效）

### 4.6 首次使用引导 [审查新增]

目标用户（PRODUCT.md）对前端 UX 概念不熟。从「点链接=跳系统浏览器」突变到「点链接=应用内网页」缺乏过渡。首次触发时 drawer 顶部一条可关闭的提示条（如「链接现在在此处打开，不跳出应用」），传达 BrowserPane 是浏览器面板而非普通抽屉。

### 4.7 多 tab 决策（见 §6 Q1）

是否支持同时开多个网页（像浏览器 tab 栏）。单 URL 预览（打开新 URL 替换旧的）实现简单一半；多 tab 要 view 池管理。

## 5. 边界 case（设计文档必须明确）

### 5.1 当前识别范围（`EXTERNAL_HREF_RE`）

| 输入 | 当前行为 | 本次改造后 | 说明 |
|---|---|---|---|
| `https://example.com` | openExternal | **drawer browser** | 主场景 |
| `http://foo.bar` | openExternal | **drawer browser** | 同上 |
| `file:///abs/path` | 纯文本死链 | **纯文本死链（不变）** | 非本次范围，见决策点 |
| 裸域名 `example.com` | 纯文本 | **纯文本（不变）** | fuzzyLink:false，防误判文件名 |
| 相对 URL `./foo` | 纯文本 | **纯文本（不变）** | 不匹配任何规则 |

### 5.2 跨 panel / 多窗口行为

drawer 是 per-panel（per-session）的。当：
- 切到另一个 panel：browser drawer 跟随 panel 切换（per-session 状态隔离，见 §7）
- 关闭窗口：view 需销毁释放

> [审查修正] **"panel 拖出独立窗口 re-attach" 不在本 spec 范围**。代码验证：项目当前**无 panel detach-to-window 功能**（`createWindow` IPC 仅用于 sidebar new-session-to-standby，无拖拽拆分入口）。view 跨窗口迁移（`contentView.addChildView/removeChildView`）依赖该前置功能，属独立 epic，本 spec 删除 re-attach 设计。MVP 的 view 只 attach 到当前 focusedSessionId 所在窗口。

### 5.3 加载失败 / 网络错误

WebContentsView `did-fail-load` 事件 → BrowserPane 显示错误态 + "重试" / "在系统浏览器打开" 两个出口。不卡白屏。

### 5.4 新窗口 / target=_blank

网页内的 `window.open` / `target=_blank` 链接如何处理？默认拦截，在同一 view 内导航（不弹系统浏览器、不开新窗口）。见 §6 决策点。

### 5.5 生命周期与内存

WebContentsView 是独立进程，持续占内存。drawer 关闭时是否销毁 view？还是 keep-alive 保留以便重开快速恢复？见 §6 决策点。

### 5.6 下载链接 [审查新增]

WebContentsView 默认允许下载，嵌入页是零信任第三方页（§8）。恶意/钓鱼页可用 `<a download>` 或 JS 触发下载，不监听 `will-download` 则静默落盘（可能写入可执行文件）。
- **MANDATORY（非待定）**：默认 `session.on('will-download')` 全部 `event.preventDefault()` 拦截
- 拦截后 BrowserPane 提示「已拦截下载，如需请在系统浏览器打开」，提供一键降级（复用外链导出按钮）
- spec §8 的"待定"措辞已升级为强制

### 5.7 Escape 归属冲突 [审查新增]

`SideDrawer.vue` 当前注册**全局** `window.keydown` Escape 关闭 drawer。WebContentsView 内交互时（网页 modal/全屏图），用户按 Esc 想关网页弹窗，会被 drawer 全局监听抢先关闭整个 drawer。
- 需判断焦点：焦点在 WebContentsView 内时，Escape 由网页先消费，仅当网页不处理才关 drawer
- 补充决策点 §6 Q6

## 6. 决策点（待用户确认）

> 审查后新增 Q6-Q9。倾向已根据两份审查调整。

| 编号 | 问题 | 倾向 | 备选 / 说明 |
|---|---|---|---|
| Q1 | **多 tab 支持**：同时开多个网页 vs 单 URL 预览 | **单 URL（MVP）**。多链接对比靠历史栈语义（§4.4）缓解：agent 新链接 reset 历史，in-page 链接 append | 多 tab（view 池管理，工作量大） |
| Q2 | **agent 主动推 URL**：是否做 | **不做**（需 runtime→前端事件通道 + pi 侧约定，独立 epic） | 做 |
| Q3 | **drawer 关闭后 view**：keep-alive vs 销毁 | **keep-alive + LRU 上限 3**（§3.3 D5）。切回快速恢复，内存可控 | 全销毁 |
| Q4 | **网页内 target=_blank**：同 view 内导航 vs 系统浏览器 | **同 view 内导航 + append 历史**（§4.4） | 系统浏览器 |
| Q5 | **file:// 协议**：是否纳入 | **不纳入**（超出 http(s) 判据，保持死链） | 纳入（走 detail） |
| Q6 [新] | **Escape 归属**：焦点在 WebContentsView 内时，Escape 由网页先消费还是关 drawer | 网页先消费，不处理才关 drawer（需 focus 判断） | drawer 全局优先 |
| Q7 [新] | **登录态页面**：是否复用系统浏览器 cookie session（session.fromPartition） | **不做**。改为登录墙检测 + 醒目"系统浏览器打开"CTA（§4.2）。复用 cookie 升级成浏览器产品，违反克制边界 | 做（复杂，跨浏览器 cookie store 格式不一，隐私争议） |
| Q8 [新] | **reader-mode / 注入 readability 脚本** | **不做（MVP）**。注入脚本到零信任页有安全/维护成本 | 评估 |
| Q9 [新] | **agent 读取 drawer 当前页面**：AI 协作闭环（agent 能消费 drawer URL/选区/全文） | **二期做，纯文本 badge 路径**（见 §13）。一期架构为此预留扩展点（Segment 判别联合 + composer-injection 通道），不在一期实装 | 截图路径受 pi 限制（§13） |

### 审查驳回/降级的建议（记录理由）

- **cookie 复用**（P-C1）：reviewer 建议复用系统浏览器 cookie。驳回——升级成浏览器产品违反 §1.3 克制边界，且跨浏览器 cookie 同步实现复杂。改为登录墙 CTA（Q7）。
- **reader-mode**（P-M5）：注入 readability 到零信任页有安全/维护成本，列为未来探索不进 MVP（Q8）。
- **多链接"半套回退"**（P-M2）：reviewer 建议保留"上一个页面快速回退"。不引入半套多 tab，改为定义清楚历史栈语义（§4.4）解决，多 tab 整体留 Q1。

## 7. Session 隔离

遵循 ADR-0036（Map 分区派）。browser drawer 状态（当前 URL、历史、加载态）按 sessionId 分区：
- `useSideDrawer` 已是 per-session scoped（`useSessionScopedState`，键 `focusedSessionId`）
- `OpenDrawerOptions.url` 作为打开时的初始参数，消费后即清除（参考 `detailFilePath` 模式）
- 若新增 composable（如 `useBrowserState`），必须用 `useSessionScopedState` 工厂，不能用实例级 + watch 清空

切 session 时 view 的 re-attach：新 session 若有 keep-alive 的 view，恢复显示；无则显示空态。

## 8. 安全

- **协议白名单**：仅 http(s)，复用现有 `isValidExternalUrl`
- **will-attach-webview 不适用**（WebContentsView 非 webview tag，但创建时仍校验 URL）
- **webPreferences 显式硬编码（MANDATORY）** [审查新增]：WebContentsView 创建时必须显式设置，不继承窗口默认、不传空 `{}`：
  ```js
  new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,           // 强制 sandbox
      // 不设 preload（默认零注入）
    }
  })
  ```
  嵌入页若拿到 `require`/`process` 即 RCE。独立 preload（若有，见 §9）必须经 code review，不得暴露 `electronAPI`。
- **独立 preload**：可配独立 preload 注入最小必要 API（如"在系统浏览器打开"回退）。**默认不注入任何 API**（嵌入页是任意第三方网页，零信任）
- **下载拦截（MANDATORY，非待定）** [审查升级]：见 §5.6。默认 `session.on('will-download')` 全部 `event.preventDefault()` 拦截 + 提示 + 一键系统浏览器降级

## 9. 改动清单（按依赖顺序）

### 9.1 最小闭环（按层）

1. `useSideDrawer.ts:35-41`：`OpenDrawerOptions` 加 `url?: string`；`pendingOpen` 支持带 url
2. `useMarkdownInteractions.ts:146-156`：分支③ `openExternal(href)` → `drawer.open('browser', { url: href })`
3. `packages/renderer/src/components/panel/BrowserPane.vue`（新建）：导航栏 + 地址栏 + 状态 + 触发主进程导航 + rect 同步（ResizeObserver + rAF + 时间节流）+ **onBeforeUnmount 触发 view 隐藏 IPC**（§3.3 D6）
4. `SideDrawer.vue`：browser tab 内容分支。**widget 通路裁决（§6）**：url 驱动优先——有 pending url 显 `<BrowserPane>`，消费后若 extension 推了 widget 则回落 widget 通路；extension 推 widget 时不清 url
5. `apps/electron/main/browser/browser-view-manager.ts`（新建）：**view 池 `Map<sessionId, WebContentsView>` + LRU 上限 3**（§3.3 D5）+ setBounds + 导航 + 事件回传 + **view 显隐生命周期**（§3.3 D6）+ **下载拦截**（§5.6）
6. IPC handlers（新增）：`browser:navigate` / `browser:back` / `browser:forward` / `browser:reload` / `browser:get-url` / `browser:hide` / `browser:show` / `browser:set-rect` / `session:focus`（触发 view swap）
7. `preload.ts`：暴露上述 IPC（注意：preload 只注入主窗口，WebContentsView 若需独立 preload 见 §8）
8. **新 composable**（若需）：如 `useBrowserState`（per-session 浏览状态）必须用 `useSessionScopedState` 工厂（ADR-0036），不能用实例级 + watch 清空

### 9.2 已知坑（探索发现）

- `preload.js`（仓库残留）与 `preload.ts` **不同步**，别参考它，改 `preload.ts`
- 打包（AGENTS §12）：WebContentsView 本身不需额外文件，但若配独立 preload 脚本，确保 `electron-builder.yml` 正确打包
- 多窗口：view 绑窗口，`WindowManager` 要支持 per-window view 管理
- `did-navigate` 回填地址栏是防钓鱼关键，不可省
- **rect 坐标系**（§3.3 D2）：不乘 devicePixelRatio，retina 屏关键坑
- **v-if × native view**（§3.3 D6）：SideDrawer 是 v-if 卸载，关 drawer/tab 切走时必须主动 IPC 隐藏 view，否则残留盖屏

## 10. 成功标准（DoD）

1. agent 输出的 http(s) 链接点击后在 drawer browser 打开，不跳系统浏览器
2. 文件路径链接（`.md-filepath`）点击后仍打开 detail tab（零回归）
3. 地址栏显示真实 URL（经重定向后回填，防钓鱼）
4. 加载态 / 错误态 / 空态都有明确视觉反馈，不卡白屏
5. "在系统浏览器打开"降级出口可用
6. drawer 开合 / 模式切换 / 窗口 resize 时 WebContentsView rect 正确同步（resize 节流，无卡顿）
7. per-session 状态隔离（切 panel/browser drawer 跟随）
8. [审查新增] **retina 屏 rect 正确**：不乘 devicePixelRatio，view 精确定位无错位
9. [审查新增] **view 显隐生命周期**：关 drawer / 切 tab 离开 browser 时 native view 不残留在屏幕上
10. [审查新增] **下载默认拦截**：零信任页的下载请求被 preventDefault + 提示
11. [审查新增] **drawer 打开期间 agent 新消息可感知**（新消息角标/提示，否则长任务监控失效）
12. [审查新增] **复制链接可用**：地址栏可选可复制，agent 链接支持右键菜单
13. [审查新增] **缩放可用**：Cmd+/- 字号控制
14. [审查新增] **登录墙 CTA**：检测到 401/403/登录表单时主动提示系统浏览器出口

### 测试策略 [审查新增]

> 现有 `apps/electron/main/test/` 全是纯函数/HTTP 单测，**无主进程-renderer 协同测试先例**。view re-attach、rect 同步这类协同行为现有 harness 难覆盖。

- **rect 计算抽纯函数单测**：把 rect 计算逻辑抽成纯函数（输入 DOMRect + window state → 输出 bounds），单测覆盖两态两向 + 折叠态
- **人工 QA checklist**：retina rect、resize 节流流畅度、切 session view swap、关 drawer view 残留检查、多显示器 DPI
- **Playwright Electron（项目已有 test:e2e）**：评估覆盖"点击链接 → drawer 打开 → 网页加载 → 地址栏回填"主链路

## 11. 降级路径

- WebContentsView 加载失败 → BrowserPane 错误态 + "系统浏览器打开"出口
- 非 http(s) 协议 → 不进 browser 分支（保持纯文本或走 openExternal）
- 用户显式选"系统浏览器打开" → openExternal（原链路保留）
- 登录墙页面（401/403/登录表单） → 醒目提示条 + "系统浏览器打开"CTA（§4.2）
- 下载链接（will-download） → preventDefault 拦截 + 提示 + "系统浏览器打开"降级（§5.6）

## 12. 审查记录

本 spec 经双视角审查（2026-07-24）：
- **产品/需求视角**：1 critical + 5 major + 2 minor + 1 question
- **技术实现视角**：2 critical + 5 major + 2 minor + 2 question

已采纳并修订进 spec 的关键项：
- [critical] rect 坐标系错误（不乘 devicePixelRatio）→ §3.3 D2 修正
- [critical] re-attach 依赖不存在的功能 → §5.2 删除，标独立 epic
- [major] 主进程 view 池设计缺失 → §3.3 D5 新增
- [major] v-if × keep-alive 生命周期错配 → §3.3 D6 新增
- [major] widget 通路冲突 → §9 改动清单 + §6 Q 裁决
- [major] 下载拦截 → §5.6 + §8 升 MANDATORY
- [major] resize 节流 → §3.3 D3 加时间节流
- [major] agent 新消息感知 → §4.5 新增
- [major] 复制链接缺失 → §4.2 + §2
- [major] 首用引导 → §4.6 新增
- [major] 缩放 → §4.2 新增

驳回/降级（理由见 §6 末尾）：cookie 复用、reader-mode、多链接半套回退。

待用户拍板的决策点见 §6（Q1-Q9）。

## 13. 二期扩展：browser → composer badge → agent（可行性已验证）

二期目标：在 browser 内框选网页内容 + 写评论，作为 badge 插入 composer，发送给 agent。这是本功能区别于"随便嵌个浏览器"的核心价值（AI 协作闭环）。

### 13.1 架构结论：可行，扩展点已预留

explorer 逐行验证了 composer 的扩展机制，xyz-agent 设计者已为二期埋好扩展点：

| 扩展点 | 位置 | 现状 | 二期改动 |
|---|---|---|---|
| **Segment 判别联合** | `packages/shared/src/segments.ts:24` | 已有 text/skill/file/mention 四类，注释明写"新增 badge 类型只需加一个 case" | 加 `{type:'browser-selection'; url; text; comment?}` |
| **chip 范式** | `useComposerChipCommands.ts` | insertSlashChip/insertFileChip/insertMentionChip 三套，模式统一（createElement + dataset + insertNode） | 仿 insertFileChip 加 insertBrowserSelectionChip |
| **DOM→Segment 解析** | `useContenteditableInput.ts:255 getSegmentsFromEl` | TreeWalker 按 class+dataset 还原 | 加 browser-selection 分支 |
| **注入通道** | `stores/composer-injection.ts` | **已实现**"drawer 跨组件树注入 composer"的 store（GitPanel 已用） | payload 加 badge 字段，applyInjection 分流 |

### 13.2 关键约束：截图的瓶颈在 pi 侧

发送链路的真实形态（explorer 验证）：
```
composer Segment[] → segmentsToPrompt() → 纯字符串 → client.prompt(content: string)
```

`client.prompt` 只收字符串，整个发送链路在 pi 边界把结构化内容拍平成文本。现有 chip 能工作是因为它们都能无损序列化成文本（路径、命令名）。

**pi 协议限制**：
- pi 支持 tool result 方向带 image content（agent→LLM）
- pi **不支持 user prompt 方向带 image**（user→agent）—— `client.prompt` 的 message 字段是纯 string，无 image block 入口

### 13.3 二期路径选择（按决策原则：长期、架构合理）

| 路径 | 内容 | 评价 |
|---|---|---|
| **A. 纯文本 badge（选区文本 + 评论）** | 序列化成文本走现有 prompt 链路 | ✅ **长期方案**。改动约 4 文件，不碰发送链路，架构干净。设计者预期路径 |
| **B1. 截图存盘 + badge 带路径** | 截图写文件，badge 传路径，agent 用 read 工具读图 | ⚠️ 短期补充。依赖 agent 自觉调 read，非原生图片输入，体验打折 |
| **B2. 扩展 prompt 协议带 image block** | 改 dispatcher/rpc-client + **依赖 pi 端支持** | ❌ 超出 xyz-agent 范围，pi 当前不支持 prompt 带 image |

**推荐：二期走路径 A（纯文本 badge）**。框选网页文字 + 评论 → 发给 agent 的核心价值已实现。截图若必要用 B1 补充，B2 不做（pi 侧限制）。

### 13.4 一期为二期预留的扩展点（一期实装时注意）

一期实现 browser drawer 时，以下设计选择要为二期留路（避免二期返工）：

1. **BrowserPane 暴露"获取选区文本 + 当前 URL"的方法**：二期框选交互需要拿到网页选区文本。一期 BrowserPane 的主进程 IPC 设计要预留 `browser:get-selection`（通过 webContents.executeJavaScript 读 window.getSelection）。
2. **不锁死 widget 通路**：§9 改动清单第 4 点的 widget 通路裁决（url 驱动优先）要保留 extension widget 的回落能力，二期框选 UI 可能作为新的渲染层叠加。
3. **composer-injection 通道保持通用**：二期 badge 注入复用此通道，一期不要把它和 file chip 耦合死。

## 14. 决策记录（2026-07-24 用户确认）

- **技术方案**：C · WebContentsView
- **分流**：仅 http(s) URL 进 browser；文件路径（.md-filepath）保持走 detail tab
- **分阶段**：一期浏览器嵌入 + 链接跳转；二期 browser→composer badge→agent（纯文本路径 A）
- **决策原则**：长期、架构合理
- **其余决策点**：按 spec §6 倾向（Q1-Q8）
