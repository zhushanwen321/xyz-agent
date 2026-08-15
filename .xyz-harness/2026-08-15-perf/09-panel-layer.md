# 09 面板层 —— D-6 终端输出模型、D-7 文件树数据模型、D-9 git overlay 回写（renderer 侧）

> **一句话结论**：高频终端输出掉帧、万级文件树展开卡顿、AI 写文件后树角标永不刷新，三个失败模式的根因分别是「PTY chunk 逐条触发 watch + xterm.write 无合帧」「递归组件全量渲染 + 每行 O(n) 徽章扫描」「git 同步阻塞（runtime 侧）+ overlay 只在 loadTree 拉一次」——本文以三个决策（D-6 终端两步走、D-7 文件树两步走、D-9 overlay 回写）各成章修复，共享 §1/§2 框架；D-9 的 runtime 侧（execSync 异步化、file_changes 帧序）已由父 00 裁决让位于 runtime D3/D4（见 `03-git-state-service.md`），本文只承载 renderer 侧。

- **S（情境）**：开发者在 xyz-agent 的面板（Panel）里用终端跑 `npm run build`，在侧栏文件树里浏览本仓（>5000 文件）展开大目录，看 AI 连续写文件。renderer 侧终端由 `useTerminal`（per-session scrollback + PTY 控制，ADR-0049 Map 分区）配 `TerminalView`（xterm.js）、文件树由 `fileTreeStore`（4 facet per-session：tree/expandedPaths/nodeStates/gitOverlay）配 `FileView`/`FileTreeRow`、git 角标由 `git.status` RPC + `setGitOverlay` 承载；runtime 侧 `event-interpreter` 在每个 mutating tool 后同步调 `snapshotGitStatus`（execSync git status）推 file_changes。
- **C（冲突）**：失败模式 C（高频终端输出掉帧，G3 反面）、失败模式 B（大仓库文件树卡顿，G2 反面）、失败模式 E（AI 连续写文件主线程抖动 + 角标不刷新，G2/G5 反面）分别击中三个真实根因，且各有历史上的「理论优化假设」被实测证伪——F3 证伪了 scrollback splice 前删成本（5000 稳态 1 万 push 仅 6.3ms），说明终端真实成本在 watch/xterm.write/WS 帧数而非数组裁剪；F7 实测 git status execSync 0.35s/次、AI 写 10 文件 ≈ 11 次 ≈ 4s 同步阻塞。
- **Q（问题）**：如何在「结构上正确」（不引入与现存数据漂移的第二份状态，G5）的前提下，让这三个面板层模块对高频输入、大数据量、跨层协作都保持流畅，且每一步有独立验收点？
- **A（答案）**：D-6 终端分两步——第一步 rAF 写队列合并 xterm.write，第二步 scrollback 脱离响应式、改命令式 buffer + 版本回放并在本步落位 attach 流量控制；D-7 文件树分两步——第一步徽章预聚合 + 过滤防抖，第二步扁平可见列表 + virtua 虚拟滚动；D-9 overlay 回写（renderer 侧）——file_changes ready 后 debounce 300ms 调 `git.status` RPC（经 runtime D4 GitStateService 缓存）回写 `setGitOverlay`，runtime 侧 git 异步化与帧序保证见 `03-git-state-service.md`（D3/D4）。三项各自成章、各自可独立验收。

---

## §1 背景与目标

**本节的结论：本层是「技术方案设计」层，下一层产物是三大决策各自可实现的接口/数据模型/代码任务；范围含 renderer 三包。D-9 的 runtime 侧（git 异步化 + file_changes 帧序）已由父 00 裁决并入 runtime D3/D4（`03-git-state-service.md`，含「改 runtime 后须重启 dev」的项目验证规范），本文 D-9 为纯 renderer 改动，走 vite HMR 即时可见。**

### 1.1 本子文档在总纲中的位置

父文档 00 已把 renderer 性能优化切成 4 份子文档，本子是 §3.3 中的 **03 P2 面板层**（优先级「中」），承载三个面向不同失败模式的决策，它们唯一的共同点是都落在「面板/面板关联模块」（终端、文件树、git 角标跨层）而非对话流状态层：

| 本子文档决策 | 面向失败模式 | 根因归属（父 00 §2.2） | 事实依据（父 00 §2.4） |
|---|---|---|---|
| D-6 终端输出模型 | C 高频终端掉帧 | 根因 3（事件无批处理） | F3 证伪 splice；F6 bundle |
| D-7 文件树数据模型 | B 大仓库树卡顿 | 根因 4（树无虚拟化） | F11 消费面收敛 |
| D-9 overlay 回写（renderer 侧） | E 主线程抖动 + 角标 stale | 根因 3 + 根因 1（失效扇出副作用）；runtime 侧归 D3/D4 | F7 git status 实测 |

依赖关系：D-6/D-7 相互独立（父 00 §3.4：D-6/D-7 第一步属阶段 1、第二步属阶段 4）。D-9 依赖 runtime D3/D4（`03-git-state-service.md`，阶段 2 联动）——renderer 侧的 overlay 回写以 runtime 侧「异步 git + ready 帧序」为前置。D-7 的失效链（`useFileChangeInvalidation` 每 token 全量重扫）会随 00 的 D-1（per-session 消息 ref）受益——D-1 落地后 `chatStore.messages` 不再每次 commit 整体替换 Map 身份，`{deep:true}` watch 的触发频率下降；但 D-7/D-9 不依赖 D-1 才能成立，可先行实施（D-9 本身就把 `useFileChangeInvalidation` 的 wasteful 成本转正产出）。

### 1.2 设计目标（继承父文档 G1-G5，本层聚焦 G2/G3/G5）

| 编号 | 目标 | 本子文档对应决策 |
|---|---|---|
| G2 | 开发者在 >1 万文件大仓库展开目录、过滤文件名，操作即时响应 | D-7、D-9（角标刷新是 G2 的「AI 写文件后角标刷新」子目标） |
| G3 | 开发者在终端跑高频输出命令，输出流畅、界面不冻结 | D-6 |
| G5 | 修复结构上正确：不引入与树数据/scrollback 重复的漂移风险状态 | D-6 第二步、D-7 第二步 |

> G1（流式对话流畅）归 07/08 子文档；G4（首屏）归 10。本层不直接承载 G1/G4，但 D-7 第二步受益于 07 的失效收敛（见 §3.3 关键权衡），D-6 与 07 无依赖。

### 1.3 In / Out of Scope

- **In**：
  - renderer 侧终端：`useTerminal.ts`、`TerminalView.vue` 的写队列与命令式 buffer 重构。
  - renderer 侧文件树：`fileTree.ts`、`FileView.vue`、`FileTreeRow.vue`、`useFileTree.ts` 的预聚合/防抖/扁平化/虚拟化。
  - D-9 overlay 回写（renderer 侧）：`useFileChangeInvalidation.ts`（ready 后 debounce + RPC 回写）。runtime 侧（`file-change-reconciler.ts` execSync→execFile、`event-interpreter.ts` 帧序）见 `03-git-state-service.md`（D3/D4），不在本文范围。
- **Out**：pi 进程内部行为；electron 主进程；终端/文件树的任何功能需求变更（新增命令、新增树交互）；xterm 版本升级或替换；文件树后端 `file-service.ts` 的加载策略变更（保留 ADR-0026 懒加载，见 §2.3）。与父 00 §1.3 一致。

### 1.4 scope 声明（层定位）

- **当前层 = 技术方案**：接口先行 + 数据模型 + 错误规格 + 多方案对比 + 真实场景验收（本层最严格标准，父 skill 层适配表的「可实现的接口/数据模型/技术方案」）。
- **下一层 = 可实现的接口/数据模型/代码任务**：D-6 的 `pendingChunks/flush/replay(version)` 接口与命令式 buffer 语义、D-7 的 `VisibleRow` 数据结构与 `projectVisibleRows` 投影函数签名、D-9 的 renderer 侧 debounce 与 `git.status` RPC 复用契约，每章落到「文件改动地图 + 待验证检查点」（§5）。
- **D-9 跨层验证规范**（项目约束，AGENTS.md，指向 03 文档）：runtime 用 `tsx`（非 `tsx watch`）跑，**改 runtime 源码后必须重启 `pnpm dev` 才生效**——该约束适用于 `03-git-state-service.md` 的 D3/D4 实施；本文 D-9 为纯 renderer 改动，走 vite HMR 即时可见。D-6/D-7 同为纯 renderer，无此约束。

---

## §2 现状与问题分析

**本节的结论：三个失败模式各有代码级根因，且「理论成本」已被 F3/F4 类实测证伪或收敛——真实根因是 watch 回调频次、xterm.write 次数、DOM 节点数、O(n) 徽章、execSync 同步阻塞、以及「setGitOverlay 只在 loadTree 拉一次」这一断点。**

### 2.1 失败模式 C：高频终端输出掉帧（G3 反面）

**物理数据流图（PTY chunk 从 runtime 到 xterm 的全链路）：**

```
runtime 进程                           renderer 进程
┌─────────────────────────┐          ┌────────────────────────────────────────────┐
│ node-pty proc.onData    │   WS     │ useTerminal.onMessage('terminal.data')       │
│ (每 chunk 1-4KB,        │ ────────▶│   state.updateFor(sid, s => {               │
│  每秒数百~上千 chunk)     │ terminal │     s.scrollback.push(chunk)  ← reactive    │
│   └ terminal-service.ts │  .data   │     if (len>5000) splice(0, ...) ← F3 证伪  │
│     :98-104 broadcast     │          │   })  (useTerminal.ts:68-76)                │
│     （无合帧/无背压）      │          │              │                              │
└─────────────────────────┘          │              ▼ push 触发 scrollback          │
                                      │              length 变化（每 chunk 一次）      │
                                      │ Termview.vue:260-265 watch(scrollback.length)│
                                      │   → replayScrollback()                       │
                                      │   → for-loop xterm.write(lines[i])  ← 每 chunk│
                                      │         1 次 write（无 rAF 合并）              │
                                      └────────────────────────────────────────────┘
```

**真实代码片段**（`useTerminal.ts:68-76` + `TerminalView.vue:260-265`）：

```ts
// useTerminal.ts:68-76 —— terminal.data 每条消息 push 进 reactive 数组
onMessage('terminal.data', (msg, sid) => {
  state.updateFor(sid, (s) => {
    s.scrollback.push(msg.payload.data)
    if (s.scrollback.length > SCROLLBACK_LIMIT) {        // SCROLLBACK_LIMIT = 5000 (:52，按 chunk 计)
      s.scrollback.splice(0, s.scrollback.length - SCROLLBACK_LIMIT)
    }
  })
})
```

```ts
// Termview.vue:259-265 —— watch scrollback.length 每 chunk 触发一次全量增量 write
watch(
  () => state.value.scrollback.length,
  () => { if (xterm) replayScrollback() },
)
// replayScrollback (:192-202)：for 循环把未回放 chunk 逐个 xterm.write
```

**根因**：① `scrollback` 是 reactive 数组，每个 chunk push 触发一次 `watch(scrollback.length)` 回调；② 每次回调 `xterm.write` 一次（无合帧，xterm 每个 write 走一遍解析 + canvas 重绘调度）；③ runtime `onData` 无背压/合帧，高频命令每秒成百上千 chunk 全量透传。高频输出时主线程每秒被打断几千次。**注意 F3 已证伪 splice 前删不是成本**（5000 稳态裁剪 1 万 push 仅 6.3ms），所以「裁剪」不是优化点，真实成本在 `watch` 回调频次 × `xterm.write` 次数（跨进程 WS 帧数）。

### 2.2 失败模式 B：大仓库文件树卡顿（G2 反面）

**真实代码片段**（递归全渲染 + per-node O(n) 徽章）：

```vue
<!-- FileView.vue:83-91 —— 顶层节点全量 v-for，无虚拟滚动 -->
<div v-else class="mt-1 flex flex-col gap-px">
  <FileTreeRow v-for="node in visibleNodes" :key="node.path" :node="node" :depth="0" :session-id="sessionId" />
</div>
```

```vue
<!-- FileTreeRow.vue:65-71 —— 每目录展开态再递归 v-for 子节点 -->
<FileTreeRow
  v-for="child in visibleChildren"
  :key="child.path"
  :node="child"
  :depth="depth + 1"
  :session-id="sessionId"
/>
```

```ts
// fileTree.ts:90-102 —— 每目录行 computed 调一次 O(n) 扫描（n=改动文件数）
function getDirChangeCount(sessionId: string, dirPath: string): number {
  const map = gitOverlay.value.get(sessionId)
  if (!map || map.size === 0) return 0
  const prefix = `${dirPath}/`
  let count = 0
  for (const path of map.keys()) { if (path.startsWith(prefix)) count++ }
  return count
}
// FileTreeRow.vue:222 —— 每渲染一行触发一次
const dirChangeCount = computed(() => store.getDirChangeCount(props.sessionId, props.node.path))
```

**根因**：① 树是**递归组件全量渲染**——展开一个 3000 文件目录 = 递归挂载 3000+ 个 `FileTreeRow`（每行承载 12 个 computed），万级 DOM；② 每个目录行的 `dirChangeCount` 走 `getDirChangeCount` O(改动文件数) 扫描，D 个目录行 × N 个改动文件 = O(D×N)；③ 过滤 `FileView.vue:143-150` 无防抖，每敲一个字符全树 `nodeMatchesFilter` 递归重算。这是「根因 4 树无虚拟化」的直接体现。

> 与 ADR-0026 的关系（免误读）：ADR-0026 的「懒加载」解决的是**后端加载粒度**（首加载只取顶层 + 一级子，展开按需拉单层），不是**前端渲染量**——它就是递归组件全量渲染 + 每条目录链逐层串行 expand。ADR-0026 自身「被否方案」里也承认「全量 + 虚拟滚动」被一票否掉是当时的取舍；本决策 D-7 第二步**不推翻 ADR-0026 的懒加载 SSOT（tree 仍为 SSOT）**，只在渲染投影层加扁平 + virtua，两者正交（详见 §3.3 关键决策）。

### 2.3 失败模式 E：AI 连续写文件主线程抖动 + 树角标永不刷新（G2/G5 反面）

**物理数据流图（git status 从 execSync 到 UI 角标的链路，标注「角标永不刷新」断点）：**

```
runtime 进程                                      renderer 进程
┌───────────────────────────────────┐            ┌────────────────────────────────────────┐
│ event-interpreter.ts              │            │                                        │
│  turn-start :220 snapshotGitStatus│            │                                        │
│   (baseline 采集, execSync 0.35s) │            │                                        │
│  tool-call-end :362-363            │   WS       │                                        │
│   FILE_MUTATING 每 tool 一次       │ message.   │  (file_changes 帧 实际只被)             │
│   → sendDiffFileChanges('accum')   │ file_changes│  ChatStore 挂到 assistant 消息  │
│       :429 snapshotGitStatus(execSync)│ ────────▶│  → useFileChangeInvalidation        │
│  turn-end :410 ready               │            │     {deep:true} watch messages        │
│   → sendDiffFileChanges('ready')   │            │     :45-71 每 token 全量重扫 →        │
│     :429 snapshotGitStatus(execSync)│            │     invalidate(loaded→invalidated)    │
│  ※ 每 mutating tool 1 次 + agent_end │            │     （只影响下次展开重拉，不出角标）   │
│   1 次, 每次 execSync 阻塞主线程     │            │                                        │
│   0.35s → 10 文件≈11 次≈4s          │            │  ── 断点【角标永不刷新】────          │
└───────────────────────────────────┘            │  setGitOverlay 唯一调用点 =            │
                                                  │  useFileTree.loadTree (:49-80)         │
                                                  │  只在 session 首加载/重开会拉一次       │
                                                  │  useGitStatus :162 只在 message.complete│
                                                  │  刷新抽屉数据，不写 tree overlay        │
                                                  │  → AI 写文件后角标 stale 直到重开      │
                                                  └────────────────────────────────────────┘
```

**真实代码片段**（runtime execSync + renderer 断点）：

```ts
// file-change-reconciler.ts:90-109 —— snapshotGitStatus execSync 同步阻塞
export function snapshotGitStatus(cwd: string): StatusSnapshot {
  try {
    const output = execSync('git status --porcelain', { cwd, encoding: 'utf8', timeout: 5000 })
    ...
```

```ts
// event-interpreter.ts:425-444 —— 每次 sendDiffFileChanges 内同步 snapshotGitStatus
private sendDiffFileChanges(changeSetStatus: 'accumulating' | 'ready'): void {
  if (!this.currentMessageId) return
  const { cwd, fileChangeDiff } = this.opts
  if (!cwd || !fileChangeDiff) return
  const current = fileChangeDiff.snapshotGitStatus(cwd)   // ← execSync, 阻塞 runtime 主线程
  ...
}
// 调用点：:362-363 accumulating（每 mutating tool），:410 ready（agent_end）
```

```ts
// useFileTree.ts:49-80 —— setGitOverlay 唯一调用点 = loadTree（首加载）
if (overlayResult.status === 'fulfilled' && overlayResult.value.isRepo) {
  store.setGitOverlay(sessionId, overlayResult.value.files)   // ← 只有这一处写 overlay
}
```

```ts
// useGitStatus.ts:162 —— git 状态只在 agent_end 后刷新抽屉，不写 tree overlay
onMessage('message.complete', () => void refresh())   // refresh 只 set result.value, 不 setGitOverlay
```

```ts
// useFileChangeInvalidation.ts:45-71 —— 每 token 全量重扫的 wasteful watch
watch([() => sessionIdRef.value, () => chatStore.messages], () => { ... },
  { deep: true, immediate: true })   // 每 token commit 触发, 全量重扫该 session 所有消息 fileChanges
```

**根因**：① runtime 侧 `snapshotGitStatus` 用 `execSync`（`file-change-reconciler.ts:92`），每个 mutating tool（write/edit/bash）+ agent_end 各同步执行一次 `git status --porcelain`，0.35s/次（F7）同步阻塞 runtime 主线程（事件循环停滞期间所有 WS 广播、其他 session 处理都被卡住）；② renderer 侧「角标永不刷新」的**断点**是 `setGitOverlay` 只有 `loadTree`（`useFileTree.ts:49-80`）一个调用点，而 `loadTree` 只在 session 首加载/重开跑，`useGitStatus.ts:162` 虽在 `message.complete`（agent_end）后刷新 git 抽屉数据却不写 tree overlay——于是 AI 写文件后树角标 stale 直到重开 session；③ `useFileChangeInvalidation` 用 `{deep:true}` watch 整 `chatStore.messages`，每个 token commit 全量重扫该 session 所有消息的 fileChanges（根因 1 失效扇出在文件树的副作用），产出的 `invalidate()` 只是把 loaded 目录标 invalidated（下次展开重拉），**成本没有产出任何 UI 价值**（角标不刷新）。

---

## §3 解决方案

> 三个决策相互独立，各自成章（3.1 通用终态使用者视角 → 3.2 三组对比 → 3.3 关键决策与权衡 + 错误规格）。每章首句结论加粗。

### 3.1 终态使用者视角（成功路径 + 失败路径恢复指引）

**实施完成后，三个失败模式对应的体验（成功路径）：**

- **终端（D-6 后）**：开发者跑 `npm run build`，输出在每帧（rAF）合并写入 xterm，主线程空闲、界面可交互；切走 terminal tab 再回来，历史完好回放；PTY 未活时 AI 命令仍入队（联动 2 写队列），alive 后 flush。
- **文件树（D-7 后）**：开发者展开几千文件目录，只渲染视口 ± 缓冲行；过滤输入 150-200ms 防抖内即时；AI 写文件后树角标在文件回合结束数秒内刷新。
- **AI 连续写文件（D-9 后）**：runtime 主线程不再因 git 同步阻塞（由 runtime D3/D4 达成，见 `03-git-state-service.md`）；树角标随 file_changes ready → debounce → git.status RPC → 回写 overlay 刷新。

**失败路径 + 恢复指引（每个错误配恢复，规则 #8）：**

| 场景 | 失败表现 | 恢复指引 |
|---|---|---|
| 切 tab 回来回放 | 回放版本失配（buffer 已推进但 xterm 重挂载读到旧版本号） | 重挂载强制全量 `replay(0)` 一次 → 若仍失配（版本号被并发推进），以 buffer 当前版本重新全量 replay（命令式 buffer 天然幂等，见 §3.3 错误规格 E6） |
| 扁平树展开大目录 | 展开极深目录（如 node_modules 已加载的深层）首帧仍慢 | 按 ADR-0026 懒加载逐层展开是预期非缺陷；若单层 children > 视口缓冲仍卡，检查投影函数是否把 `changeCount` 等重 computed 放进「扁平行」，而非投影时重算（§5 检查点） |
| AI 写文件后角标刷新失败 | debounce 后 `git.status` RPC reject（非 repo/超时/越 cwd） | 降级为 `isRepo=false` 空 overlay，树仍渲染（与 loadTree 现有 T2.7 行为一致）；用户可手动重开抽屉 git 面板触发 `useGitStatus.refresh`（现有机制）或用 loadTree 重载 |
| 终端 PTY 未活写队列背压 | `pendingChunks` 超 `MAX_PENDING_WRITES`（=100 既有契约）仍无 alive | 丢弃最旧 chunk（保最新窗口）并记 debug 日志，不阻塞 push；alive 到达后 flush | 
| runtime git 异步超时 | execFile 超 5s 仍无响应 | 维持现有 null 降级（非仓库/git 不可用 → 跳过 diff，不推 file_changes），不影响主流程 |

### 3.2 三个决策各一组多方案对比

#### D-6 终端输出模型：多方案对比

| 维度 | 方案 A：维持响应式数组 + 加 rAF（治标）| 方案 B：环形缓冲（被否）| **方案 C：两步走——rAF 写队列 → 命令式 buffer + 版本回放（选定）** |
|---|---|---|---|
| 长期架构合理性 | 差：scrollback 仍是 reactive，每 chunk push 仍是失效源，rAF 只是把 N 次 write 合并成 1 次，模型错位的根源（scrollback 本该是「命令式字节流」而非「响应式列表」）没动 | 中：环形缓冲降低前删成本，但 F3 已证伪 splice 不是成本；且环形结构需包一层适配 reactive（否则组件 watch 失效），复杂度反增 | **优**：终态 scrollback 脱离响应式，xterm 写入全命令式，组件的「数据源→视图」单向用版本号裁决；watch/回放/裁剪三件事合成「一个 buffer + 一个 replay」 |
| 短期实现成本 | 低（~30 行 rAF 合并） | 高（环形实现 + reactive 包装 + 回放语义重写） | 中：第一步 rAF 队列 ~50 行可独立上线；第二步 buffer + replay 重构 ~150 行（含 TerminalView 回放逻辑替换） |
| 风险 | 治标不治本，第二步仍需再来一次；且 rAF 合并引入「终端 tab 切走时 flush 时机」新语义 | F3 证伪后「环形」无收益，还引入与 reactive 兼容的包装层，增加 G5 违反风险 | 第一步零模型改动（只加 flush 合并），第二步才动模型，风险分两段可控 |
| 推荐 | ✗ | ✗ | **✅ 两步走** |

**被否方案「若用它会怎样」**：方案 A 若直接上——高频输出掉帧缓解一部分（write 次数下降），但 scrollback 仍是万级 reactive 数组 + 每 chunk 一个 watch 回调，G3 只修复一半且 G5 违反（模型仍错）；方案 B 若上——F3 已证明它解决的是一个不存在的成本，还凭空引入环形/reactive 双层结构漂移，纯负收益。

#### D-7 文件树数据模型：多方案对比

| 维度 | 方案 A：维持现状 + 懒渲染阈值（被否）| 方案 B：递归组件上叠 virtua（被否）| **方案 C：两步走——徽章预聚合+防抖 → 扁平可见列表 + virtua（选定）** |
|---|---|---|---|
| 长期架构合理性 | 差：懒渲染阈值只把「卡」延迟到阈值后，不解决万级 DOM（展开 1 万文件目录仍全量挂载） | 差：递归组件与虚拟列表本质冲突——virtua 要求扁平 item 列表，递归组件天然树形，双模型（树 SSOT + virtua 扁平行）必然漂移 | **优**：树数据仍是 SSOT，渲染投影为扁平可见行数组（含 depth/expanded 元数据），sort/filter/展开/徽章全在扁平行预计算；虚拟化/过滤/排序/徽章统一到一个投影 |
| 短期实现成本 | 低（加个长度判断）| 中（引入 virtua 却要迁就递归结构，边际成本高） | 中：第一步预聚合 Map + 防抖 ~60 行可独立上线；第二步扁平投影 + virtua ~200 行 |
| 风险 | 不解决根因 4（树无虚拟化），G2 在大目录仍失败 | 双模型必然漂移（G5 直接违反），且递归结构里 virtua 无法固定行高/滚动位置 | 分两段：第一步消除 O(n) 徽章 + 过滤抖动，第二步才动渲染模型；每段有独立验收 |
| 推荐 | ✗ | ✗ | **✅ 两步走** |

**被否方案「若用它会怎样」**：方案 A 若上——展开 1 万文件目录时懒渲染阈值只是「分帧渲染」而非「少渲染」，DOM 总量不变、滚动仍掉帧，且阈值成为脆弱魔数；方案 B 若上——递归 `FileTreeRow` + virtua 两层各自算可见性，展开态、聚焦、滚动锚点三处双源，短期能跑长期必漂（正是 G5 要杜绝的）。

#### D-9 git overlay 回写（renderer 侧）：多方案对比

| 维度 | 方案 A：新增专用 WS 广播通道（被否）| 方案 B：renderer 无节流直接刷新（被否）| **方案 C：ready 后 debounce + 复用 git.status RPC 回写 overlay（选定）** |
|---|---|---|---|
| 长期架构合理性 | 中：专用通道更「实时」但多一条维护链，且 git.status RPC 已能回全量 overlay，减法优先 | 差：file_changes 每帧直接触发 renderer 拉 git.status，把刷新抖动搬进 renderer（且 runtime 侧未就绪时读不到最终态） | **优**：renderer 侧 debounce 收敛刷新频次并复用现存 `git.status` RPC（`git.status:result` reply 已有契约，且享受 runtime D4 GitStateService 的 TTL 缓存与 in-flight 去重），零新增通道；runtime 侧异步化与帧序保证由 D3/D4 承担（`03-git-state-service.md`） |
| 短期实现成本 | 高（新 server-push 类型 + renderer 订阅 + 前端 refresh 编排） | 低（去掉 debounce） | 低：renderer debounce + RPC 回写 ~50 行（runtime 侧另计 D3/D4 成本） |
| 风险 | 通道 + RPC 双路径并存，branch 名/行数等字段两处维护易漂移 | 多 session/多 turn 快速连续时高频 RPC 抖动，且「ready 尚未到达」时读到中间态 | debounce 窗口与 turn 结束时序需真实数据验证（§5 检查点）；依赖 D3/D4 先行（阶段 2 联动） |
| 推荐 | ✗ | ✗ | **✅ 复用 RPC + debounce** |

**被否方案「若用它会怎样」**：方案 A 若上——多出一条 `git:broadcast` 通道与 `git.status:result` RPC 并行，字段契约双份维护，违反「减法优先」；方案 B 若上——`file_changes` 每帧一次同步刷新，直接把刷新抖动搬进 renderer，角标在 AI 逐文件写时疯狂闪烁。

### 3.3 关键决策与权衡（接口先行 + 数据模型 + 错误规格）

#### 3.3.1 D-6 终端：接口草案

**第一步（快赢）rAF 写队列接口**（renderer 侧，不改模型）：

```ts
// useTerminal.ts 内新增（TerminalPartition 增两字段）
interface TerminalPartition {
  scrollback: string[]          // 保留（第一步不动模型）
  pendingChunks: string[]       // 新增：待 flush 的 chunk 暂存
  rafPending: boolean           // 新增：rAF 是否已置位（防重入）
  // ... 其余不变
}

// 写队列核心（3 个函数）
function appendChunk(sid: string, chunk: string): void   // terminal.data handler 只 push 到 pendingChunks + requestAnimationFrame 置位
function flushPending(sid: string, xterm: Terminal | null): void  // rAF 回调：合并 pendingChunks.join → 单次 xterm.write + 清空
function writeToTerminal(data: string): void            // 用户输入：直连绕过队列（terminalApi.write，保持现状）
```

- **终端数据**（PTY 输出）走 `appendChunk` + rAF `flushPending`（合并为单次 `xterm.write(pending.join(''))`）。
- **用户输入**（`xterm.onData` → `writeToTerminal`）走直连 `terminalApi.write` 绕过队列（已有路径，不合并——用户击键要即时回显）。
- 挂载/切 session 的**回放**仍走现有 `replayScrollback`（读 scrollback 全集），第一步不碰它。

**第二步（目标架构）命令式 buffer + 版本回放接口**：

```ts
// scrollback 脱离响应式：append-only 非响应式 buffer + 单调版本号
interface TerminalBuffer {
  chunks: string[]        // 非 reactive 数组（append-only，SCROLLBACK_LIMIT 裁剪见下）
  version: number         // 单调递增，每次 append/crop 自增
}
// xterm 写入全命令式（组件持有 buffer + 已回放版本号）
interface CommandTerminal {
  append(chunk: string): void          // push chunk + version++
  cropIfOver(limit: number): void      // 超限 splice + version++（F3 证伪成本，只为保留历史）
  replay(xterm: Terminal, fromVersion: number): void   // 从 fromVersion 回放 chunk[x..] 到当前
}

// 组件侧（TerminalView）用法
// mount / 切 tab 回来： const v = buffer.version; replay(xterm, 0)  // 或 fromVersion 增量
// 订阅：不再 watch scrollback.length，改为「单条 rAF flush 直接调 buffer.append + replay(xterm, fromVersion)」
```

- **三件事合成「一个 buffer + 一个 replay」**：watch 链消失（不再 watch `.length`）；回放由 `replay(version)` 承担；上限裁剪合并为 `cropIfOver`。`TerminalView.vue:259-265` 的 watch 与 `replayedScrollbackLength` 标记（:113）整体删除，替换为「每次 flushed chunk 写进 buffer + 调 replay」。
- **attach 流量控制在此步落位**：`terminal-service.ts:159-161` 的 `attach(_sid)` 现为 no-op 预留；此步把「仅活跃 tab 才推送」的流量控制落地（runtime 按 attach sid 集合过滤 `onData` 广播），配合第一步的 renderer 侧 rAF 合并，双层降帧。

**错误规格（D-6）**：

- **E6-a 背压**：PTY 未活时（`ptyAlive=false`）`pendingChunks` 累积超 `MAX_PENDING_WRITES`（**=100，沿用 terminal-write-queue 既有契约**）→ 丢弃最旧 chunk 保最新窗口 + `console.debug`；不抛错、不阻塞 push；`terminal.alive` 到达后 `flushPending` 一次性清空。这是**既有契约的复用**（联动 2 的写队列已有 pendingWrites 语义），不新增常量语义。
- **E6-b 回放版本失配**：切 tab 回来 `buffer.version` 可能已被异步 `terminal.data` 推进，`replay(xterm, fromVersion)` 读到 stale `fromVersion` → 幂等重放：以 `buffer.version` 为当前值全量 `replay(0)` 一次（命令式 buffer 天然幂等，重复回放只是重写既有内容，无副作用）。
- **E6-c 挂载期间未 flush**：rAF 回调在 tab 切走（xterm 已 dispose）时置位的 `rafPending` 残留 → `flushPending` 开头判 `xterm===null` 直接返回并清 `rafPending`，chunk 留在 buffer 等下次 mount replay。

#### 3.3.2 D-7 文件树：数据模型草案

**第一步（快赢）预聚合 + 防抖**：

```ts
// fileTree.ts 新增：dirPath → changeCount 预聚合 Map（随 setGitOverlay 一起算，O(改动文件数) 一次）
// 消除 getDirChangeCount 的 O(n) per-row 扫描
const dirChangeCounts: Ref<Map<string, Map<string, number>>> = ref(new Map()) // sid → dirPath → count
// 投影语义：对每个改动文件 path 'a/b/c.ts'，其所有祖先目录 'a'、'a/b' 的计数 +1
function rebuildDirChangeCounts(sessionId: string): void   // setGitOverlay 内部调用
function getDirChangeCount(sessionId, dirPath): number     // 改为 Map.get O(1)

// filter 防抖：FileView.onFilter → useFileTree.setFilter 加 150-200ms trailing debounce
function setFilter(text: string): void   // 内部 debounce 后 store.setFilter（保持对外签名不变）
```

**第二步（目标架构）扁平可见列表 + depth 元数据**：

```ts
// 可见行数据结构（供 virtua 虚拟滚动消费）
interface VisibleRow {
  path: string            // 节点相对路径（SSOT key）
  name: string            // 显示名
  type: 'file' | 'dir'
  depth: number           // 缩进层级（投影时算好，替代递归 depth prop）
  expanded: boolean       // 目录是否展开（从 expandedPaths 投影）
  changeCount: number     // 目录子树改动数（从预聚合 Map 投影，替代 per-row computed）
  gitStatus?: GitFileStatus   // 文件角标（从 gitOverlay 投影）
  lineStats?: LineStats       // 行数 +N −M（投影时算好）
  ignored: boolean
}

// 投影函数签名（SSOT 仍是 tree）
function projectVisibleRows(
  getTree: (sid) => FileNode[] | undefined,
  getExpanded: (sid) => Set<string>,
  gitOverlay: Map<sid, Map<path, GitFileStatus>>,
  dirChangeCounts: Map<sid, Map<path, number>>,
  filterText: string,
  showIgnored: boolean,
  sid: string,
): VisibleRow[]   // 深度优先走树，按 expanded/showIgnored/filterText 产出可见行，每行预计算 depth/expanded/changeCount/gitStatus/lineStats
```

- **树数据仍为 SSOT**（`fileTree.ts` 的 `tree/expandedPaths/nodeStates/gitOverlay` 4 facet 不变），侧边栏渲染投影为 `VisibleRow[]`；排序/过滤/展开/徽章全部在投影时预计算，`FileTreeRow` 从「递归组件」改为「纯行组件」（接收单个 `VisibleRow`），`FileView` 用 virtua 挂扁平行列表。
- **与 ADR-0025/0026 对齐**：ADR-0025（File View=全项目树、git.status 是现在态权威）→ 投影仍从 `gitOverlay` 取角标，不违反；ADR-0026（懒加载分层）→ `projectVisibleRows` 只投影已加载的 children（unloaded 目录不产出子行，展开时触发 `expandNode`），懒加载语义不变，虚拟化只作用于「已加载可见」的扁平行。

**错误规格（D-7）**：

- **E7-a 扁平投影在大树上的更新策略**：`projectVisibleRows` 是纯函数（无副作用），`FileView` 用 `computed` 包裹它以缓存——依赖 `tree/expandedPaths/gitOverlay/filterText/showIgnored` 的精确粒度失效。展开一个目录只改变「该目录」的 `expandedPaths`，若 computed 依赖整 `expandedPaths` 的 Map 身份会全量重投影 → **策略：投影 computed 依赖分桶后的细粒度 getter（`getExpanded(sid)` + `dirChangeCounts.get(sid)`），并让 `addExpanded/removeExpanded/setGitOverlay` 用 new Map 替换触发**（现有 store 已这么写），避免大树每次展开全量重算可视行外的成本。万级树全量重投影本身 O(可见行) 在懒加载下是「已加载」子集，不是全量。
- **E7-b 懒加载目录的展开语义**：投影时遇 `nodeStates[path].status!=='loaded'` 且未展开的目录，不产出其子行（与递归版「展开才拉」一致）；展开后 `expandNode` 拉完 children → `setNodeState(loaded)+children` 触发投影缓存失效 → 新行进入可见列表。
- **E7-c 过滤空结果**：`filterText` 命中仅祖先链保留（`nodeMatchesFilter` 语义），投影后 `VisibleRow[]` 为空 → 维持 `FileView` 现有空态（`file-empty` testid）不变，不需要新组件。

#### 3.3.3 D-9 overlay 回写：renderer 侧接口与 RPC 复用契约

**runtime 侧（不在本文，见 `03-git-state-service.md` D3/D4）**：git 子进程异步化（execFile + timeout 5000 + 失败 null）、GitStateService（in-flight 去重 + TTL 缓存 + 写失效钩子）、file_changes 帧序以 baseline promise 保证（baseline 未就绪跳过本次 accumulating、ready 全量兜底；accumulating 无 debounce——帧序契约不允许）。本文只消费其结果：ready 帧是每 turn 一次的最终全量 diff。

**renderer 侧（修复 F4 stale 角标）**：

```ts
// useFileChangeInvalidation.ts —— 从「每 token 全量重扫」改为「file_changes ready 后 debounce → git.status RPC → setGitOverlay」
// watch 不再挂 chatStore.messages deep，改为按 message.file_changes ready 事件：
// ready 后 debounce 300ms → gitApi.status(sid) → store.setGitOverlay(sid, result.files)
async function refreshOverlayOnReady(sid: string): Promise<void> {
  const result = await gitApi.status(sid)             // 复用现有 git.status RPC（经 runtime D4 GitStateService 缓存）
  if (result.isRepo) store.setGitOverlay(sid, result.files)
}
```

**debounce 归属与 RPC 复用契约**：

- **renderer ready 后 300ms debounce**：防多 session/多 turn 快速连续完成时的高频 RPC 抖动（每 turn 只有一次 ready，debounce 是防抖而非帧合并）；到点后调 `git.status` 拿**现在态全量**（含未被 file_changes 覆盖的既有 dirty 文件），写 `setGitOverlay`。
- **RPC 复用契约**：用现存 `git.status`（`git-message-handler.ts:43-51` → `gitService.getStatus` → reply `git.status:result`，命令已带 `--untracked-files=all`，AGENTS.md #15）——**不为角标新增通道**。`git.status:result` 返回 `GitStatusResult{isRepo, files: GitFileStatus[]}`，`renderer` 侧 `git.status()`（`api/domains/git.ts:18-20`）已封装好 promise 形式，直接 `setGitOverlay(sid, result.files)`。D4 落地后此 RPC 命中 GitStateService 缓存，多次调用零额外 spawn。
- **`useFileChangeInvalidation` 的成本转正**：原 `{deep:true}` watch 每 token 全量重扫的 wasteful 成本改为「只在 file_changes ready 后 debounce 一次 RPC」——既消除根因 1 在文件树的扇出副作用，又把刷新动作接上「产出 UI 价值」（角标真刷新）的断点。

**错误规格（D-9）**：

- **E9-a 高频连续完成**：多 session 快速连续 ready → debounce 窗口内多次触发只执行最后一次（trailing 语义），不会产生 RPC 风暴。
- **E9-b renderer git.status RPC reject**：非 repo / 越 cwd / 超时 → `refreshOverlayOnReady` catch，降级为不写 overlay（角标保持旧值），不打断 renderer 主循环；用户可手动重开抽屉 git 面板刷新（`useGitStatus` 既有路径）。
- **E9-c stale 竞态**：切 session 后 `refreshOverlayOnReady` 的 async result 回来时 sid 已变 → 用闭包捕获的 sid 校验（`setGitOverlay(capturedSid, ...)` 写原 sid 分桶），与 `useFileTree.expandNode` 的 AC-3.7 stale 丢弃一致。

---

## §4 验收（真实场景，非单测）

**本节的结论：4 个真实场景直接在 dev 环境跑真实用例，每个回溯 G2/G3/G5；终端场景用真实高频命令，文件树用本仓 >5000 文件目录，D-9 用真实 AI 写文件（标注验证缺口）。**

> 验证环境：`pnpm dev` 真实 Electron（renderer 9222 / runtime 3310），真实仓库本仓。D-6/D-7 纯前端可立即验；D-9 纯 renderer 可立即验，但其前置（runtime 异步 git + ready 帧序）由 03 文档 D3/D4 先行落地并重启 dev。

| 场景 | 步骤 | 通过标准 | 回溯目标 |
|---|---|---|---|
| V-P2-1 高频终端输出流畅 | ① 开终端 tab 跑 `npm run build`（或 `find / -name x` 高频输出）；② 输出期间滚动消息流、点侧栏文件；③ Performance 录输出密集段 | 终端输出流畅、界面可交互；CPU 峰值明显低于基线；每个 rAF 帧合并多次 write（探针 P-D6-1）；切 tab 回来历史完整（探针 P-D6-2） | G3 |
| V-P2-2 万文件目录展开即时 | ① 在本仓展开 `packages/` 大目录（数千文件）；② 过滤框敲 `store`；③ 展开多层子目录滚动 | 展开/滚动首帧 <100ms；过滤 150-200ms 防抖内即时；万级可见行只渲染视口 ± 缓冲（探针 P-D7-1）；目录徽章 O(1)（探针 P-D7-2） | G2 |
| V-P2-3 AI 一轮改 5 文件后角标刷新 | ① 让真实 AI 一轮修改 ≥5 个文件；② 观察侧栏文件树角标；③ 观察 runtime 进程 CPU | 角标在 file_changes ready 后数秒内刷新（探针 P-D9-2）；runtime 主线程无 >100ms git 阻塞（探针见 03 文档 P-git-*，由 D3/D4 验收）；fileChanges 不在 token 路径触发重扫（探针 P-D9-3） | G2、G5 |
| V-P2-4 终端切 tab 回放 + PTY 未活背压 | ① 跑长输出命令时切走 terminal tab 30s 再切回；② 首次打开终端（PTY 未活）时从 Block 点「在终端运行」连发命令；③ 观察输出完整性与顺序 | 切回历史完整按序回放；PTY 未活时命令入队、alive 后按序 flush；无 chunk 丢失（探针 P-D6-1 验证 pendingChunks flush） | G3、G5 |

**验证缺口说明**：V-P2-3 依赖真实 AI 工具调用链（真实 pi session），无法 mock——实施时优先争取真实模型会话；V-P2-1 若 `npm run build` 输出不够高频可用 `find / -name x 2>/dev/null` 补足。这些场景对应父 00 §4 的 V3（终端）/V2（文件树）/V5（AI 写文件），本层是它们的面板层细分。

---

## §5 下一层拆分（实施路径）

**本节的结论：每个决策按「两步走」拆成可独立提交的单元，每单元含 justification + 文件改动地图 + 待验证检查点；实施顺序 D-6 第一步 → D-7 第一步 → D-9（三项可并行，父 00 §5.2），各自完成一步即有独立验收点。**

### D-6 终端两步走

| 单元 | 内容 | justification | 文件改动 |
|---|---|---|---|
| D-6.1 rAF 写队列 | `TerminalPartition` 增 `pendingChunks/rafPending`；`terminal.data` handler 改 `appendChunk` + rAF；`flushPending` 单次 `xterm.write`；用户输入 `writeToTerminal` 直连不变 | 快赢消除 `watch` 回调 × `xterm.write` 频次，零模型改动，可独立验收 V-P2-1/V-P2-4 | `useTerminal.ts`（分区 + append/flush）、`TerminalView.vue`（挂 rAF flush 调用） |
| D-6.2 命令式 buffer + 版本回放 + attach 流量控制 | `scrollback` 改 append-only 非响应式 buffer + version；组件用 `replay(version)`；删 `watch(scrollback.length)` + `replayedScrollbackLength`；runtime `attach` 落位流量控制 | 目标架构，G5 结构正确（scrollback 不该是响应式列表）；attach 从预留变实 | `useTerminal.ts`（buffer 结构）、`TerminalView.vue`（回放重写）、`terminal-service.ts:159-161`（attach 过滤 onData） |

**检查点**：D-6.1 后 `watch(scrollback.length)` 仍存在但只承载「flush 后写 buffer」的单一职责；D-6.2 后该 watch 完全删除，回放只靠 `replay(version)`。

### D-7 文件树两步走

| 单元 | 内容 | justification | 文件改动 |
|---|---|---|---|
| D-7.1 徽章预聚合 + 过滤防抖 | `dirChangeCounts` Map 预聚合（随 `setGitOverlay` 一次算 O(n)）；`getDirChangeCount` 改 O(1)；`setFilter` 加 150-200ms debounce | 消除 per-row O(n) + 过滤抖动，零渲染模型改动，可独立验收 V-P2-2 的徽章/过滤部分 | `fileTree.ts`（预聚合 + getter）、`useFileTree.ts`（setFilter debounce） |
| D-7.2 扁平可见列表 + virtua | `VisibleRow` 结构 + `projectVisibleRows`；`FileTreeRow` 改纯行组件（收 `VisibleRow`）；`FileView` 用 virtua 挂扁平行 | 目标架构，G5（树 SSOT + 投影），统一虚拟化/过滤/排序/徽章 | `fileTree.ts`（投影函数 + dirChangeCounts 暴露）、`FileView.vue`（virtua + 扁平行）、`FileTreeRow.vue`（递归→单行） |

**检查点**：D-7.2 后 `projectVisibleRows` 是唯一「树→可见行」投影点，`expandNode/collapseNode/setFilter/toggleShowIgnored/setGitOverlay` 都通过触发投影缓存失效生效；`FileTreeRow` 不再 import `useFileTree` 的 `expandNode`（展开态由投影传入 `expanded` + 事件回调），消除递归组件的 per-node store 依赖。

### D-9 overlay 回写（renderer 侧一步）

| 单元 | 内容 | justification | 文件改动 |
|---|---|---|---|
| D-9 renderer debounce + RPC 回写 overlay | `useFileChangeInvalidation` 改「file_changes ready 后 debounce 300ms → `gitApi.status` → `setGitOverlay`」；移除 `{deep:true}` watch messages | 修复 F4 stale 角标断点；消除根因 1 在文件树的 wasteful 全量重扫；复用 git.status RPC（经 D4 GitStateService 缓存） | `useFileChangeInvalidation.ts`、`useFileTree.ts`（setupInvalidation 回调语义） |

> runtime 侧（git 异步化 + baseline promise 帧序 + GitStateService）属 `03-git-state-service.md` 的 D3/D4（阶段 2 联动，先于本单元验收）。本单元纯 renderer，走 vite HMR 即时可见。

**检查点**：D-9 后 `setGitOverlay` 有两个调用点（loadTree + ready 回写），`useFileChangeInvalidation` 不再挂 `chatStore.messages` deep watch；runtime 侧探针（git 无同步阻塞）在 03 文档的探针清单中验收。

**待验证检查点（设计阶段诚实标注）**：

1. **D-6 第二步的 version 回放粒度**：命令式 buffer 按 chunk 还是按行存储直接影响 `replay` 的 fromVersion 语义与 xterm scrollback 上限（xterm 的 `scrollback` 选项 vs app 层 `SCROLLBACK_LIMIT` 由谁裁决）——需实施时确认哪个是 SSOT（当前 app 层 `SCROLLBACK_LIMIT=5000` 按 chunk 计，xterm 侧 `DEFAULT_SCROLLBACK=5000` 按行计，双层语义易混）。
2. **D-7 第二步 virtua 滚动锚点**：展开/折叠目录导致可见行数剧变时，virtua 的滚动位置与键盘导航焦点保持需实测（项数动态增删 vs 稳定列表）。
3. **D-9 renderer debounce 窗口与 turn 结束时序**：ready 每 turn 一次，300ms debounce 只防多 turn/多 session 连续完成的 RPC 抖动；是否保留窗口或改为即时刷新，需真实 AI 一轮多文件的时序验证（V-P2-3）。

---

## §6 运行时断言（附探针 ✅/⛔）

**本节的结论：探针插入 dev 运行时（devtools console 或临时 debug 日志），验收时能直接读到「✅ 断言成立 / ⛔ 断言失败」；探针清单见 §7。**

| 断言 | 探针 | 通过 | 失败 |
|---|---|---|---|
| D-6 每帧 write 次数收敛 | P-D6-1（终端 rAF flush 计数 / 帧） | ✅ 密集输出时单帧合并 write 显著 ↑（write 次数/chunk 数 ↓） | ⛔ write 次数仍 ≈ chunk 数 |
| D-6 切 tab 回放完整 | P-D6-2（切回后 replay 覆盖版本差） | ✅ 切回一次 replay(0) 后 buffer 与 xterm 内容对齐 | ⛔ 回放后内容缺漏/重复 |
| D-7 万级节点 DOM 受控 | P-D7-1（DOM 中 `file-tree-*` 节点数 vs 视口） | ✅ 展开 5000 文件目录时 DOM 行数 ≈ 视口+buffer（<200） | ⛔ DOM 行数 ≈ 全量 |
| D-7 徽章 O(1) | P-D7-2（getDirChangeCount 命中 Map） | ✅ 目录徽章不再启动 per-row 扫描（预聚合命中） | ⛔ 仍走 startsWith 全扫 |
| D-9 角标刷新 | P-D9-2（ready 后 setGitOverlay 调用） | ✅ AI 写文件后 ready→debounce→RPC→overlay 链路走通 | ⛔ overlay 未更新（断点仍在） |
| D-9 无 token 路径重扫 | P-D9-3（useFileChangeInvalidation 触发点在 token vs ready） | ✅ 不再每 token 触发全量重扫 | ⛔ token 路径仍触发 deep watch |

> runtime 侧「git 无同步阻塞」断言与探针在 `03-git-state-service.md` 的探针清单（P-git-*），本层不重复。

---

## §7 探针清单（验收时逐条实跑）

| 探针 | 插入点 | 观察方式 | 判定 |
|---|---|---|---|
| P-D6-1 | `flushPending` 内计数 flushedChunks + 单帧 write 次数，`console.debug('[terminal] rAF flush', {chunks, frameMs})` | devtools console 过滤 `[terminal] rAF flush` | write 次数显著 < chunk 数即 ✅ |
| P-D6-2 | `replay(xterm, fromVersion)` 记录 fromVersion→version 覆盖差，`console.debug('[terminal] replay', {from, to})` | 切 tab 回来看日志 | from=0 全量回放且无重复即 ✅ |
| P-D7-1 | `FileView` 挂载后 `document.querySelectorAll('[data-testid^="file-tree-"]').length` 打印 | devtools 展开 5000 文件目录后 evaluate | 节点数 < 视口+buffer（约 <200）即 ✅ |
| P-D7-2 | `getDirChangeCount` 入口断言命中预聚合 Map（`if (map.has(dirPath)) return map.get(dirPath)` 分支打日志） | 展开大目录遍历徽章 | 无 startsWith 全扫分支命中即 ✅ |
| P-D9-2 | `refreshOverlayOnReady` 内 `console.debug('[fileTree] overlay refreshed', {sid, count})` | renderer console，AI 改文件后观察 | 出现该日志且角标更新即 ✅ |
| P-D9-3 | `useFileChangeInvalidation` 移除 deep watch 后，在 ready 事件 handler 打印触发点 | renderer console | 触发点只在 ready、token 无触发即 ✅ |

> P-D9-1（runtime 侧 git 调用耗时分布）已随 D3/D4 移交 `03-git-state-service.md` 探针清单。

---

## 附录：本子文档与父文档/linting 一致性自查

- **事实编号**：F3（splice 证伪）、F6（bundle）、F7（git status 0.35s/11 次）、F11（fileTree 消费面）全部按父 00 §2.4 原文引用，未改口径。
- **决策编号**：D-6/D-7/D-9 的「选定方案 + 被否方案」与父 00 §3.1/§3.2 总表逐一对应（D-6 两步走/被否环形+纯 rAF；D-7 两步走/被否递归 virtua+懒阈值；D-9 renderer 侧 ready→debounce→RPC 回写/被否专用通道+无节流，runtime 侧经父 00 裁决 1 让位于 03 文档 D3/D4）。
- **目标回溯**：G2（D-7+D-9 角标）、G3（D-6）、G5（D-6 第二步+D-7 第二步）在 §1.2 与 §4 验收场景明确回溯。
- **代码引用**：所有代码片段均来自 read 真实文件（`useTerminal.ts:68-76/52`、`TerminalView.vue:260-265/60-64/113`、`terminal-service.ts:159-161`、`fileTree.ts:90-102/196-203`、`FileView.vue:83-91/143-150`、`FileTreeRow.vue:65-71/179-182/222`、`useFileTree.ts:49-80`、`useGitStatus.ts:162`、`event-interpreter.ts:362-363/410/425-444`、`file-change-reconciler.ts:90-109/92`），未编造行号。
- **五段骨架**：背景目标（§1）→ 现状问题（§2）→ 方案对比（§3.2 三组 ≥2 方案 + 推荐 + 被否「若用它会怎样」）→ 验收真实场景（§4）→ 下一层拆分（§5），恢复指引（§3.1 + 错误规格）、探针（§6/§7）、每章首句结论加粗均已满足。
