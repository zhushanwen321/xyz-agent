# P3 构建与加载 + 快赢集（子文档 10）

> **一句话结论**：冷启动首屏过重的根因是重依赖（xterm+4 addon、shiki、katex、双份 locale）被静态 import 进首屏图（F6），本子文档用 D-8（defineAsyncComponent 拆三个非首屏组件 + manualChunks 分组 vendor/xterm/shiki/katex）把**主 chunk gzip JS 从 684KB 降到 <400KB**（**度量口径 = 主 chunk/entry-only，审查修正**：shiki/katex 是 `markdown.ts` 顶层静态 import、首屏必经，manualChunks 分组后仍在首屏**初始请求集合**内，首屏总字节不减——真正被推迟的是 xterm 与设置页树；详见 §2.2/§3.4），并用 Q1 快赢集（9 项单点修复）顺带消除后台多 session 完成时的主线程抖动与若干低价值重扫，全部与 01-09 零依赖、可随时并行。

## 开篇（SCQA）

- **S（情境）**：xyz-agent 是 Electron + Vue 3 + Pinia 桌面 AI 工作台。renderer 进程的入口是 `packages/renderer/src/main.ts` → `App.vue` → `AppShell`，冷启动时加载的 JS/CSS 产物直接决定「打开应用到可交互」的时长（G4）。
- **C（冲突）**：F6 实测主产物 **2.34MB（gzip 684KB）** 启动即下载解析——xterm + 4 个 addon、shiki core、markdown-it、katex 全部静态 import 进首屏图；同时全库 0 处 `defineAsyncComponent`、vite.config.ts 无 manualChunks。此外 Q1 各单项（markers 写盘、i18n 双 locale、completion sound、ROUTE_TABLE 线性扫描等）各自造成可感知的浪费，但单点太零散、易被主线忽略。
- **Q（问题）**：如何用结构上正确的手段（配置分割 + 组件懒加载边界）显著压缩首屏，并把 9 项零散但真实的单点成本一揽子收掉？
- **A（答案）**：D-8 已拍板——defineAsyncComponent 拆 TerminalView/DetailPane/SettingsModal 为懒加载 chunk，manualChunks 按 rolldown 可用键分组 vendor/xterm/shiki/katex；Q1 快赢集每项给「file:line 证据 + 一句话方案 + 一句话验收」，不展开成完整方案对比。

---

## §1 背景目标

**本节的结论：本子文档范围 = 构建配置（vite.config.ts）+ 6 个以上文件的单点修复，与 01-03 零依赖、可完全并行；目标是 G4（首屏显著变快）为骨架、G5（结构正确）为约束、附带一批 G1 相关的后台抖动消除。**

### 1.1 系统是什么（本次设计的接触面）

本子文档只碰两类东西，不碰 `packages/core`/`packages/ui` 的状态与渲染逻辑：

1. **构建配置层**：`packages/renderer/vite.config.ts`（当前 71 行，仅 `rollupOptions.input` + `base:'./'`，无任何代码分割配置）。它决定 build 产物的 chunk 如何切分、哪些依赖被静态打进入口 chunk。
2. **入口/组件层**：`main.ts`（字体与 katex css 静态 import）、`App.vue`/`AppShell.vue`（挂载树，含 SettingsModal 静态 import）、`PanelContainer.vue`（DetailPane/TerminalView 静态 import）。
3. **6+ 文件的单点修复**（Q1 集）：markers/i18n/sound/route/pending/update/turnElapsed/toast + 3 处杂项。

### 1.2 设计目标（从使用者体验倒推）

| 编号 | 目标 | 对应 |
|---|---|---|
| G4（继承父文档） | 开发者冷启动应用到可交互时间显著缩短：**主 chunk（entry）gzip JS 从 684KB 降到 <400KB**（度量口径 = 主 chunk；shiki/katex 静态绑定首屏，分组后仍在初始请求集合——「首屏总字节」不减少，如实声明，见 §2.2/§3.4）；TTI 提前 | D-8 |
| G5（继承父文档） | 修复结构上正确：懒加载边界选在「天然非首屏」的组件，不靠脆弱缓存键、不修补症状 | D-8 |
| 本子文档附加 | 后台多个 session 同时完成时，主线程不因 markers 全量 parse/stringify + 声音重复探测而抖动；切英文即时、无重编译等待 | Q1-1/Q1-2/Q1-3 |

### 1.3 In / Out of Scope

- **In**：`packages/renderer/vite.config.ts` 的 build 分割配置；`main.ts`/`AppShell.vue`/`PanelContainer.vue`/`App.vue` 的懒加载边界改造；Q1 集涉及的 9 项单点修复（文件清单见 §5.2）。
- **Out**：任何状态层/渲染层改动（07/08 范围）；终端输出模型（D-6，09 范围）；文件树（D-7，09 范围）；overlay 跨层（D-9，09 范围）；pi 进程与功能需求变更。

---

## §2 现状与问题分析

**本节的结论：F6 实测数据坐实「重依赖静态 import 进首屏图」是首屏过重的根因；Q1 的九项各有 file:line 级别的浪费证据，共同点是「每次触发都做了可以缓存/惰性化/上限化的重复工作」。**

### 2.1 失败模式（使用者视角的真实例子）

**失败模式 D（已有，G4 反面）**：开发者双击太极图标，等待窗口出现 → 连接 runtime → 侧栏与面板可用。这中间 renderer 要先下载并解析 2.34MB 主 chunk——其中 xterm + 4 addon（终端功能，可能整场会话都不用一次）、shiki（全语言语法、13 种语言高亮 core）、katex + markdown-it-katex（公式渲染）、双份 locale（3057 行 message）被强制一起加载。

**失败模式 F（本子文档新增，Q1-1 反面）**：开发者开了 5 个后台 session 让 AI 并行干活。它们几乎同时完成时，每个 session 的 `message.complete` 都会触发一次 `markUnread`（`useCompletionNotify.ts:56`，在声音防抖之前），而 `markUnread` 每次都 `readAll()`（`localStorage.getItem` + 全量 `JSON.parse`）→ mutate → `writeAll()`（全量 `JSON.stringify` + 同步 `setItem`）——完全绕过文件顶部已有的内存缓存 `cache`（`useSessionMarkers.ts:24`）。5 个 session 同时完成 = 5 次全量 JSON parse/stringify 跑在主线程上（**措辞修正：Electron renderer 的 `localStorage.setItem` 同步的是 JS 侧 + 内存 LevelDB 缓存、磁盘 flush 异步，且 markers 数据量小、写频极低——Q1-1 的收益定位是「结构性消除重复 parse/serialize 的代码卫生」，不夸大为主线程磁盘 IO 抖动**）。

### 2.2 首屏加载链路（真实 import 图）

冷启动时被打进首屏 chunk 的重依赖，链路如下（均取自代码，非编造）：

```
main.ts:3      → import '@fontsource-variable/inter'        (字体 CSS)
main.ts:4      → import 'katex/dist/katex.min.css'          (KaTeX CSS)
main.ts:5-6    → import i18n（createI18n 静态 import zh-CN + en-US 全量，见 §2.3 Q1-2）
main.ts:6      → import App → App.vue
App.vue:42     → import AppShell.vue
  AppShell.vue:34 → import SettingsModal.vue（静态 import，设置页树 → 深依赖）
  … AppShell → PanelContainer.vue:147/149
PanelContainer.vue:147 → import DetailPane.vue
PanelContainer.vue:149 → import TerminalView.vue
  TerminalView.vue:60-64 → import xterm + fit/web-links/search/unicode11 四个 addon
markdown.ts:23  → import katex（静态，供消息渲染）
markdown.ts:25  → import markdown-it-katex
markdown.ts:28  → import { createHighlighter } from 'shiki'
```

关键事实（对照 F6，好/坏并存）：

- ✅ **已有好的部分**：shiki 的语法块已自动按需懒加载（emacs-lisp 780KB 等按需 chunk 不占首屏）；mermaid 已动态 import（`composables/logic/mermaid.ts:32`，父文档确认）。
- ⛔ **坏的部分**：`markdown.ts:23-25` 的 katex 与 `markdown.ts:28` 的 shiki 是**静态 import**——经 `useChatViewDeps.ts:40`（静态 import `renderMarkdownSegments`）→ 首屏 `MessageStream.vue`，**静态绑定在首屏 module graph 里**：manualChunks 只改 chunk 边界、不减少「首屏全部初始请求」的总字节，分组的 shiki/katex 仍是主入口同步依赖、初始瀑布照常下载（**「首次渲染代码块时异步加载 shiki」「katex 与主 chunk 分离即免首屏」均不成立**，审查修正）；`TerminalView.vue:60-64` 的 xterm + 4 addon 静态 import 且 TerminalView 被 PanelContainer 静态 import → xterm 进首屏图（**这一项才是懒加载真正能推迟的**）；`AppShell.vue:34` 的 SettingsModal 静态 import → 设置页树进首屏图；双 locale 全量静态 import → 3057 行 message 启动时全编译。

### 2.3 Q1 各项现状证据（file:line + 一句话浪费性质）

| 编号 | 证据（file:line） | 浪费性质（一句话） |
|---|---|---|
| Q1-1 | `useSessionMarkers.ts:77-135` 四个写操作（markUnread/clearUnread/toggleMarkedDone/clearAll）每次 `readAll()`（:31-39 getItem+全量 parse）→ mutate → `writeAll()`（:41-45 全量 stringify+同步 setItem），完全绕过 :24 的 `cache` 内存缓存；触发点 `useCompletionNotify.ts:56` 每个后台 session 完成必调（在声音防抖之前） | 写路径把「已在内存的缓存」重新读盘、重新解析、重新序列化、同步写盘 |
| Q1-2 | `i18n/index.ts:2-3` 双 locale 同步 import；`:30-38` 全量传入 `createI18n` 的 `messages`（全仓 3057 行 message，settings.ts 760 行 ×2 全启动编译） | 英文用户根本用不到的 en-US 全量（反之亦然）启动期编译进首屏 |
| Q1-3 | `useCompletionSound.ts:39-64` win 每次 `new Audio(base64)`；mac/linux 每次 IPC `spawn` 系统进程；`detectPlatform`/`resolveName` 每次重探测（`sound-platform.ts:33-41`） | 平台探测与默认音解析是无状态纯函数却被反复重算；win 端每次新建 Audio 对象。**收益边界（审查修正）**：触发受 `useCompletionNotify.ts:64` 的 1s 模块级防抖约束（多 session 完成每 1s 至多一响）、mac/linux spawn 在 main 侧 renderer 只 IPC——省下的主线程成本趋近 0，按「代码卫生 + 语义缓存」定位而非性能收益 |
| Q1-4 | `route-inbound.ts:325` 每入站消息 `ROUTE_TABLE.find((e) => e.type === msg.type)` 线性扫描（表内 4 条，见 :160-203） | 每 token 的 `message.text_delta` 都要线性扫路由表（虽短，但高频热路径） |
| Q1-5 | `pending.ts:22` `pendingMap` 无并发/总量上限、超时用真实 `setTimeout`（:50-56） | 异常场景下 map 无限增长、每个 pending 一个真实 timer |
| Q1-6 | `useAppUpdate.ts:465` 20min 轮询 `runAutoCheck` 无 `visibilityState` 判断；`:462` `checkForUpdate(true)` force 绕过 1h 缓存 | 应用后台隐藏时仍每 20min 真正联网检测（force=true 绕过缓存） |
| Q1-7 | **真计时器在 `packages/ui/src/features/chat/composables/useTurnElapsed.ts:74-77`**（唯一运行时消费方 `Turn.vue:106` 经 `./composables/useTurnElapsed` import）；`packages/renderer/src/composables/panel/useTurnElapsed.ts` 是迁移 ui 包后遗留的**孤儿副本**（无任何 import 消费者，仅注释提及） | streaming 期间每秒 `setInterval` 无失焦节流；窗口失焦/切 tab 时不可见的计时器仍每秒 tick 重算 + 触发渲染 |
| Q1-8 | `useToast.ts:24-28` `setTimeout` 无句柄存储；`:49-51` `remove` 只 filter 数组不清 timer | 用户提前关闭 toast 时，4s 后的 timer 仍会跑一次（空 filter），句柄无法清理 |
| Q1-9（杂项，三处） | `bash-effects.ts:34` `[...messages].reverse()` 倒序拷贝再 findIndex；`lru.ts:141` `[...deps.messagesValue().keys()]` keys 二次拷贝；`ForkGroup.vue:206-215` 与 `project.ts:97-109` 的 `{deep:true}` watch | 三处「可避免的数组/深 watch 成本」，deep watch 需先读代码确认语义等价 |

### 2.4 根因

- **根因 5（构建无分割，父文档已列）**：重依赖（xterm/shiki/katex/vendor/双 locale）静态 import 进首屏图。这是 D-8 的唯一归属点。
- **Q1 共性根因（本子文档新增，非单一根因）**：九项是九个独立的「可缓存未缓存 / 可惰性未惰性 / 可上限未上限 / 可守卫未守卫 / 可句柄未句柄」单点，彼此无依赖，故用快赢清单形式集中收口，避免各自散落被遗忘。

---

## §3 解决方案

**本节的结论：D-8 采用「defineAsyncComponent 拆三个天然非首屏组件 + manualChunks 四组」的组合（选定方案），Q1 用一张清单表收口；懒加载边界选择依据是「组件是否在首屏渲染且是否携带重依赖」。**

### 3.1 终态（使用者视角）

- **冷启动变快**：双击太极 → 首屏主 chunk 从 684KB gzip 降到 <400KB，TTI 明显提前；终端、详情、设置这三块重功能在用户**第一次真正用到它们时**才各自加载（打开终端 tab 才下载 xterm chunk，打开设置弹窗才下载设置页树 chunk）。
- **切英文即时**：用户在设置里切 en-US，只触发一次动态 import + `setLocaleMessage`，无启动期全量编译、无额外等待。
- **后台多 session 完成不卡**：5 个后台 session 同时完成，markers 写路径走内存 cache +（可选）requestIdleCallback 合并落盘，主线程无 5 次同步盘 IO + 全量序列化；提示音平台探测与 win 端 Audio 对象复用，不重复 spawn/新建。

### 3.2 D-8 多方案对比

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A（选定）：defineAsyncComponent 拆 TerminalView/DetailPane/SettingsModal + manualChunks 四组（vendor/xterm/shiki/katex）** | 高：懒加载边界落在「天然非首屏 + 重依赖集中」的组件上，结构正确；manualChunks 只分大块（4 组），不逐包碎拆，配置稳定 | 中：改 3 个 import 点 + 1 处配置 + 验证 rolldown 键 | 低；唯一待验证点是 rolldown 下 manualChunks 键名（见 §5.3） | ✅ |
| **B：全量 manualChunks 按依赖逐包拆** | 差：每个依赖一个 chunk，边界随依赖增删漂移，配置碎、收益递减（V8 对过多小 chunk 的重合请求反而变慢） | 高：需枚举全部依赖、持续维护 | 中：易碎，依赖升级即破 | ❌（已否） |
| **C：不拆（维持现状）** | 差：F6 已证明 2.34MB/684KB 太重，且 xterm/shiki/katex 都压进首屏 | 零 | 高：首屏卡顿不解决 | ❌（已否） |

**被否若用**：

- **若用 B（逐包拆）**：首屏可能多几十个独立 chunk，在 Electron file:// 协议下（无 HTTP/2 多路复用协商空间）几十个小请求的握手/解析开销可能抵消甚至反超合并收益；且每新增一个依赖都要回来改 manualChunks，配置脆弱。§2.2 的首屏链路没有边界稳定的 50+ 依赖，逐包拆是过度设计。
- **若用 C（不拆）**：开发者每次冷启动仍要等 684KB + 解析 xterm/shiki/katex，即便这次会话只用聊天不用终端/公式/设置，也照单全收——§3.1 的「用到才加载」不成立，G4 不达标。

### 3.3 懒加载边界选择理由（为什么是这三个组件）

选择 `defineAsyncComponent` 的边界判据是**两条同时满足**：① 组件在首屏**不渲染**（条件挂载/弹窗）；② 组件携带**重依赖**。

| 组件 | 首屏是否渲染 | 重依赖 | 结论 |
|---|---|---|---|
| **TerminalView** | 否——`PanelContainer.vue:93` 是 `v-else-if="drawerTab === 'terminal'"`，只有切到终端 tab 才挂载 | xterm + 4 addon（`TerminalView.vue:60-64` 静态 import） | ✅ 拆 |
| **DetailPane** | 否——`PanelContainer.vue:87` 是 `v-else-if="drawerTab === 'detail'"` | 相对轻；拆出只推迟 DiffView 等 **DetailPane 专属依赖**（审查修正：DetailPane 引用的 MarkdownRenderer 是首屏消息路径共享组件，rolldown 会抽到共享 chunk 仍进首屏图——「整体剥离首屏/与 MainPanel 解耦」不成立；且 DetailPane 是即时响应面板，多一层 async 边界可能让快速打开出现轻量 spinner，loadingComponent 须无感） | ✅ 拆（收益如实收窄为专属依赖） |
| **SettingsModal** | 否——`AppShell.vue:20` 是 `v-model:open="settingsOpen"` 弹窗，默认关闭 | 设置页树（`AppShell.vue:34` 静态 import，含 SettingsResourcePage/ExtensionPage 等子页） | ✅ 拆 |
| **AppShell / PanelContainer / 消息流组件** | 是——连接后即挂载，是首屏必经 | — | ❌ 不拆（拆了会引入首屏异步闪烁，得不偿失） |
| **markdown/katex** | 是——消息渲染必经 | katex（`markdown.ts:23`） | ❌ 不拆入口，但 katex 在 manualChunks 里单独分组，与主 chunk 分离 |

**为什么 DetailPane 也拆（即使相对轻）**：它和 TerminalView 同是 `drawerTab` 的 `v-else-if` 分支、互斥挂载——拆出后「抽屉 tab 面板」的**专属依赖**（DiffView 等）从首屏初始请求推迟，边界整齐（收益按 §3.3 表如实收窄：共享的 MarkdownRenderer 仍首屏）。

### 3.4 manualChunks 分组设计

> **前置事实**：本仓库 build 是 **vite 8.1.3 + rolldown 1.1.4 内核**（`node_modules/vite/package.json`、`node_modules/rolldown/package.json` 实测）。当前 `vite.config.ts` 的 `build.rollupOptions.input` 能正常构建（rolldown 兼容 `rollupOptions` 的部分键），但 **`manualChunks` 在 rolldown 下的键名/行为需实施期验证**——父文档 F6 的构建警告显示 `build.rolldownOptions`，即 rolldown 可能有自己的配置命名空间（`build.rolldownOptions.output.advancedChunks` 或兼容 `manualChunks`）。这是 §5.3 的首要待验证检查点，不预设结论。

| 组名 | 成员 | 理由 |
|---|---|---|
| **vendor** | `vue` / `pinia` / `vue-i18n` / `reka-ui` / `@lucide/vue`（+ 其余稳定第三方 UI/状态库） | 框架与 UI 基座与业务 chunk 分离。**收益边界（审查修正）**：本项目是 Electron `file://` 协议——无 HTTP 协商缓存，每次启动从 asar/磁盘全量重读，「稳定缓存/升级不连带重缓存」对本地应用近乎为零；file:// 下 vendor 分组的真实收益只剩 parse/GC 隔离与 chunk 边界清晰，如实标注 |
| **xterm** | `@xterm/xterm` + `@xterm/addon-fit` / `-web-links` / `-search` / `-unicode11` | 单一大依赖（~数百 KB），配合 TerminalView 的 defineAsyncComponent **真正推迟出首屏初始请求**（唯一显著减初始字节的一组） |
| **shiki** | `shiki`（core + 13 语言） | 体积大 + 已有按需语法 chunk。**审查修正**：shiki 是 `markdown.ts` 顶层静态 import，分组后**仍在首屏初始请求集合**（modulepreload 照常拉取），不是「首次渲染代码块时异步加载」——分组收益 = 与业务 chunk 的 parse 隔离 |
| **katex** | `katex` + `markdown-it-katex` | 同 shiki：静态 import、首屏初始仍加载，分组只为 parse 隔离；**不是「与主 chunk 分离即免首屏」** |

**注意**：不把 `markdown-it` 拆进任何组（它内联进消息渲染的主 chunk 更合理，避免公式/代码/纯文本三种消息路径都要额外 round-trip）；「全量逐包拆」已由方案 B 否决。

### 3.5 错误规格：懒加载 chunk 失败（file:// 下 chunk 404）的兜底与恢复

本项目 `vite.config.ts:33` 设 `base:'./'`（打包后 file:// 协议加载，必须相对路径），懒加载 chunk 的失败模式**不是网络超时而是「相对路径解析错 → chunk 404/加载失败」**。

- **失败模式**：`defineAsyncComponent` 默认 factory 用 `import('@/components/panel/TerminalView.vue')`，Vite 会把它编译进 `__vitePreload`/动态 import，chunk 文件名带 hash 且路径相对 `base:'./'`。若 manualChunks 配置不当导致 chunk 路径重写错（如产出 `/assets/xterm-xxx.js` 绝对路径），file:// 下会解析到文件系统根 → 加载失败 → async component 抛 `Failed to fetch dynamically imported module`。
- **表现**：用户切到终端 tab，抽屉区域显示空白/错误，而非终端；设置弹窗打不开。
- **兜底**：给三个 `defineAsyncComponent` 统一配 `errorComponent`（一个极简错误占位组件 + 重试按钮）与 `loadingComponent`（轻量 spinner）。重试按钮内 `defineAsyncComponent` factory 重跑一次 import。
- **恢复指引（实施者/用户两级）**：
  1. 构建后产物自检：`ls apps/electron/renderer/dist/assets/` 确认 chunk 文件名是 `xterm-*.js`/`shiki-*.js`/`katex-*.js`（无 `/assets` 绝对前缀），且 `index.html` 里的 `import.meta.url` 引用是相对 `./assets/...`。
  2. 若用户遇到 chunk 404：dev 环境刷新重拉；prod 环境用 `import('/@vite/client')` 非必需，直接改回 `base:'./'` 并重新 `pnpm build`。
  3. **实施期门（探针）**：`懒加载 chunk 在 file:// 下正常加载` ⛔ 实施期验证——用 `pnpm build` 产物 + Electron `loadFile` 实测切 tab/开设置，DevTools Network 看无 404（见 §7）。

### 3.6 Q1 快赢清单（每项：证据 / 一句话方案 / 一句话验收）

| 编号 | 证据（file:line） | 一句话方案 | 一句话验收 |
|---|---|---|---|
| **Q1-1** | `useSessionMarkers.ts:77-135` 四写操作绕过 :24 内存 cache；触发点 `useCompletionNotify.ts:56` | 写路径改 `ensureCache()` → mutate cache → 更新 `cache.value` → 写盘；可选 `requestIdleCallback` 批量合并落盘 | 后台 5 session 完成，DevTools 无 5 次 `localStorage.setItem` 同步主线程长任务 |
| **Q1-2** | `i18n/index.ts:2-3`、:30-38 双 locale 全量静态 import（3057 行） | **静态保留 `readInitialLocale()` 探测到的初始 locale，只对另一个 locale 动态 `import` + `setLocaleMessage`**（审查修正：初稿「初始只传 zh-CN」回归了 en-US 首启——`main.ts` 同步 createI18n 后，AppShell 之前的 connecting 屏第一帧就用 zh-CN 渲染，en-US 系统用户冷启动看到**中文闪烁**） | **英文系统冷启动首屏（含 connecting 屏）即英文、无中文闪烁**；启动首屏只含初始 locale（另一份不进首屏 chunk）；切语言即时显示 |
| **Q1-3** | `useCompletionSound.ts:39-64` 每次 new Audio / IPC spawn / 重探测 | 缓存 `resolveName`/`detectPlatform` 结果 + win 平台 `Map<name, Audio>` 复用 | 连续播放同音不重复 spawn / 不重复 new Audio |
| **Q1-4** | `route-inbound.ts:325` `.find()` 线性扫描（表 :160 起 4 条） | `Record<string, entry>` 下标访问 | 入站消息路由 O(1)，热路径无 find |
| **Q1-5** | `pending.ts:22` 无上限；:50-56 真实 setTimeout | size 上限（如 256）超限最老 reject + 惰性超时清理（**审查补充：reject 前原子判定该 command-id 仍 pending——读 map 有则删再 reject；已 reject 的 id 若响应后到，`resolveEnvelope` 契约补「静默丢弃」**） | 高压下 pendingMap 不超 256，无 timer 泄漏、无双 settle/脱链 |
| **Q1-6** | `useAppUpdate.ts:465` 无 visibility 判断；:462 force 绕缓存 | hidden 时顺延 + visible 时补查 | 后台隐藏期间不发 20min 联网检测请求 |
| **Q1-7** | **目标文件 = `packages/ui/src/features/chat/composables/useTurnElapsed.ts:74-77`**（审查修正：初稿指向 renderer 孤儿副本，改错位置零效果） | `visibilitychange` 停表 + 恢复时 `Date.now()` 补算；**renderer 孤儿副本（`composables/panel/useTurnElapsed.ts`）注明去留：删除（首选）或保持不动但不作为修复目标** | 失焦时无每秒 tick；恢复时耗时连续正确 |
| **Q1-8** | `useToast.ts:24-28` 无句柄；:49-51 remove 不清 timer | `Map<id, timer>` + remove 时 `clearTimeout` | 提前关 toast 后 4s timer 不再触发 |
| **Q1-9** | `bash-effects.ts:34` reverse 拷贝；`lru.ts:141` keys 二次拷贝；`ForkGroup.vue:206-215` 与 `project.ts:97-109` 深 watch | reverse 改倒序 for；keys 避免二次拷贝；deep watch 改浅（**先读代码确认语义等价**） | 语义等价前提下，三处无冗余拷贝/无过度深 watch |

> Q1-9 的 deep watch 改浅是**有条件**的：`ForkGroup.vue` watch 的是 `props.freshIds`（数组身份），`project.ts` watch 的是 `projects`（数组身份）+ `activeProjectId`。若改浅需确认「数组内部元素变更」也通过数组身份替换（`projects.value = [...]`）表达——status 是 `activeProjectId` 是标量、`projects` 是否整替换替代是实施期须核实的语义点，文档不预设「直接浅化」结论。

---

## §4 验收

**本节的结论：D-8 用两个真实冷启动场景（TTI 对比 + 产物体积断言）+ 切英文即时性 + 后台多 session 完成无长任务四个场景验收，全部回溯 G4/G5；Q1 各项用一句话简化验收（表 §3.6 已给）。**

> 验证环境与父文档 §4 一致：`pnpm dev` 真实 Electron（renderer 9222）；D-8 的体积断言需 `pnpm build` 产物。

### 4.1 改动规模

D-8 是**中等改动**（3 个 import 点 + 1 处 build 配置 + 一个新错误占位组件），验收用多场景；Q1 是**小改动**（9 项单点），各用一句话验收（§3.6 表已含），不单独展开。

### 4.2 验收场景（D-8）

| 场景 | 回溯目标 | 步骤（真实流程） | 通过标准 |
|---|---|---|---|
| **A1 冷启动 TTI 对比** | G4 | ① `pnpm build` 产生产物；② 打包版（或 `pnpm dev` 的 build 产物 loadFile）冷启动；③ DevTools Performance/Network 记录「加载 → 可交互（侧栏可点击）」 | **主 chunk（entry）gzip 从基线 684KB 降到 <400KB（口径 = entry-only，非「首屏全部初始请求」总和）**；TTI 较改动前基线明显提前；xterm/设置页树不在初始请求集合 |
| **A2 首屏体积断言** | G4 | `pnpm build` 后 `du -sh apps/electron/renderer/dist/assets/` 逐个 chunk 看 | **主 chunk <400KB gzip（entry-only 口径）**；存在独立 vendor/xterm/shiki/katex 分组 chunk；xterm 不进主 chunk 且**不进首屏初始请求集合**（Network 首屏无 xterm）；shiki/katex 分组 chunk 仍在首屏初始请求集合（静态 import，符合声明）；**chunk 命名以实施期探针 1 收敛的实际产物名为准（rolldown 键名未验证，不把 `xterm-*` 等臆测命名固化为硬断言）** |
| **A3 语义不回归（三个懒加载点）** | G4/G5 | ① 切到终端 tab → 终端正常渲染、PTY 可用；② 点文件 → DetailPane 正常预览；③ 打开设置 → 设置页树正常 | 三处的功能与改动前一致；chunk 均**首次触发时**才在 Network 出现 |
| **A4 切英文即时性** | 本子文档附加 | ① 设置 → 语言 → en-US；② **英文系统（`LANG`/系统偏好 en-US）冷启动** | 切英文即时（无启动期编译等待），全部文案变英文；切回 zh-CN 即刻还原；**英文系统冷启动首屏（含 connecting 屏）即英文、无中文闪烁、无原始 key** |

### 4.3 验收场景（Q1-1，后台多 session 完成，代表性）

| 场景 | 回溯目标 | 步骤 | 通过标准 |
|---|---|---|---|
| **A5 后台多 session 完成无重复序列化** | 本子文档附加（代码卫生定位，见 Q1-1 措辞修正） | ① 开 4-5 个后台 session 并行让 AI 干活；② 切到别的应用等它们几乎同时完成；③ 代码断言 + DevTools Performance 录完成瞬间 | 写路径不再出现 `readAll()→writeAll()` 串（走内存 cache）；完成瞬间无因 markers 产生的重复全量 parse/stringify（>50ms 长任务为辅助观测——改动前很可能已满足，不作唯一判定） |

> 其余 Q1-2~Q1-9 的验收已在 §3.6 表内给出一句话标准（小改动简化验收，符合父文档「Q1 项用一句话简化验收」的约定）。

---

## §5 下一层拆分

**本节的结论：实施分两个独立阶段（D-8 构建分割 → Q1 快赢集），D-8 内部按「先手动分组验证 → 再组件懒加载」的顺序落；文件改动地图与 3 个待验证检查点列于下。**

### 5.1 实施路径

| 阶段 | 内容 | 交付什么 |
|---|---|---|
| **P3-1（D-8）** | ① 先在 `vite.config.ts` 加 manualChunks 四组（vendor/xterm/shiki/katex）+ 构建验证 chunk 切分正确（§5.3 探针 1）；② 再改 `main.ts`/`AppShell.vue:34`/`PanelContainer.vue:87,93,147,149` 三处为 `defineAsyncComponent` + error/loading 组件；③ 构建 + 冷启动验证 | 首屏 <400KB + 三个懒加载边界生效 |
| **P3-2（Q1 集）** | 按 §3.6 清单逐项修（互不依赖，可任序/并行）；Q1-9 先核实 deep watch 语义再改 | 9 项单点修复各达一句话验收 |

### 5.2 文件改动地图

| 文件 | 改动 | 所属 |
|---|---|---|
| `packages/renderer/vite.config.ts` | build 加 manualChunks 四组（键名待 §5.3 验证） | D-8 |
| `packages/renderer/src/main.ts` | 按需：katex css 是否保留静态 import（字体与 katex css 首屏必需，不拆，但确认不破） | D-8（核对） |
| `packages/renderer/src/components/shell/AppShell.vue`（:20,34） | SettingsModal 改 defineAsyncComponent | D-8 |
| `packages/renderer/src/components/workspace/PanelContainer.vue`（:87,93,147,149） | DetailPane/TerminalView 改 defineAsyncComponent | D-8 |
| `packages/renderer/src/components/` 新增 1 个 `AsyncErrorFallback.vue`（或复用） | error/loading 占位 + 重试 | D-8 |
| `packages/renderer/src/composables/useSessionMarkers.ts` | 写路径走 cache + 批量落盘 | Q1-1 |
| `packages/renderer/src/i18n/index.ts` | 静态保留 `readInitialLocale()` 探测的初始 locale；另一 locale 动态 import + setLocaleMessage（en-US 首启无中文闪烁） | Q1-2 |
| `packages/renderer/src/composables/effects/useCompletionSound.ts` | 缓存 platform/name + win Map<Audio> | Q1-3 |
| `packages/core/src/coordination/route-inbound.ts` | ROUTE_TABLE Record 化 | Q1-4 |
| `packages/renderer/src/api/pending.ts` | size 上限 + 惰性超时 | Q1-5 |
| `packages/renderer/src/composables/features/settings/useAppUpdate.ts` | visibility 守卫 | Q1-6 |
| `packages/ui/src/features/chat/composables/useTurnElapsed.ts`（真计时器）+ `packages/renderer/src/composables/panel/useTurnElapsed.ts`（孤儿副本，删除） | visibilitychange 停表 + Date.now 补算 | Q1-7 |
| `packages/renderer/src/composables/useToast.ts` | Map<id, timer> + remove clearTimeout | Q1-8 |
| `packages/core/src/domain/chat/bash-effects.ts` / `lru.ts`、`packages/renderer/src/components/sidebar/ForkGroup.vue`、`packages/renderer/src/stores/project.ts` | 倒序 for / 去二次拷贝 / 深 watch 核实后改浅 | Q1-9 |

### 5.3 待验证检查点（设计阶段诚实标注）

1. **rolldown 下 manualChunks 的实际键名与行为**（最高优先）：当前 `vite.config.ts` 用 `build.rollupOptions`，但 rolldown 1.1.4 的 code splitting 可能需 `build.rolldownOptions.output.advancedChunks` 或另有语法。实施期先写最小配置构建一次，观察 chunk 切分是否生效、`rollupOptions` 是否仍兼容（父文档 F6 提示构建警告显示 `build.rolldownOptions`）。**此为必须先验证的探针，不预设结论。**
2. Q1-9 两处 deep watch 改浅的语义等价性（见 §3.6 末注）：`projects` 是否整替换、`freshIds` 是否整替换，需读 `project.ts` 的全部写点与 ForkGroup 父组件传参确认。
3. Q1-1 用 `requestIdleCallback` 合并落盘的收益边界：markers 写频极低（后台 session 完成），纯内存 cache + 立即写盘可能已足够，idle 合并是可选优化，实施期按实测决定是否引入（避免为低收益加复杂度，遵循 §skill 减法原则）。

---

## §7 运行时断言附探针（✅已测 / ⛔实施期门）

> 依据 skill 准则 7：涉及运行时行为（懒加载、file:// 加载、构建产物）的断言必须附探针；探针失败则断言在文档中标 ⛔，不得作为已成立事实写入。

| 断言 | 探针 | 状态 |
|---|---|---|
| 懒加载 chunk 在 file:// 协议下正常加载（无 `/assets` 绝对路径 404） | `pnpm build` 后 `ls apps/electron/renderer/dist/assets/` 确认文件名相对、无绝对前缀；Electron loadFile 实测切 tab/开设置无 404 | ⛔ 实施期门（§3.5 恢复指引配套） |
| manualChunks 后 shiki 语法 chunk 仍按需懒加载（不被 vendor 组吞并） | `pnpm build` 产物检查 `shiki-*` 与语法 chunk（如 emacs-lisp）仍分离 | ⛔ build 产物检查 |
| **主 chunk（entry-only 口径）** gzip <400KB | `pnpm build` 后对主 chunk 做 gzip 测量 vs 基线 684KB（口径 = 主 chunk；shiki/katex 分组仍在首屏初始请求集合，符合 §2.2 声明） | ⛔ build 产物断言（对应 F6，§4 A2） |
| 切英文无启动期全量编译（en-US 不进首屏 chunk） | build 产物 grep 首屏 chunk 是否含 en-US 大段 message；`setLocale('en-US')` 触发动态 import | ⛔ 实施期门 |
| markers 写路径不再每次 readAll+writeAll | 代码断言（写操作不再出现 `readAll()→writeAll()` 串）+ 后台多 session 完成 DevTools 无同步长任务 | ⛔ 实施期门（对应 §4 A5） |

---

## 附录：变更历史

- 2026-08-15 v1：初版。基于父文档 00-overview 的 F6/D-8/Q1 快赢集成文；核实 vite 8.1.3 + rolldown 1.1.4、i18n 双 locale 3057 行、TerminalView xterm+4 addon、DetailPane/TerminalView/SettingsModal 三处 v-else-if/v-model 条件挂载边界。
