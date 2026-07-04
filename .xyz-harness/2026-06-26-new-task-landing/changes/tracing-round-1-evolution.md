---
round: 1
frame: evolution
perspectives: [5, 6]
converged: false
---

# 演进帧追踪 · Round 1

> 视角 5（变化轴）+ 视角 6（行为契约）。fresh context 独立追踪。
> 证据均经源码 grep 核实（file:line）。本轮发现 7 个 gap（F×3 / K×1 / D×3），**未收敛**。

---

## 视角5 变化轴

### G-1 [D] useNewTaskFlow 变化轴描述过窄，多子轴内聚于「编排中心」却承诺「单一轴」

**问题**：§7 模块表声明 `useNewTaskFlow` 变化轴 = 「UI 交互流程变化（spec §3 步骤调整）」单一轴，LOC ~120。但 §5 状态机 + §1 目标 + §9 泳道显示该 composable 实际承担：
- 状态机转换（8 态 + ~12 转换，流程轴）
- overlay 嵌套互斥守卫（布局轴，§5 不变式）
- Esc 优先级（键盘交互轴，spec §4）
- sessionApi.create 协调 + cwd 透传（T1，协议轴）
- RecentWorkspaceCache 读写（缓存轴）
- GitService.getStatus 读 dirty（数据轴，UC-4 dirty 接入）

「每个模块只承担一个变化轴」的措辞与 useNewTaskFlow 的实际定位（新建任务流程**编排中心**）有张力。准确说法是：它内聚于「新建任务流程」这一**业务轴**，内部含多个技术子轴——这与 useSidebar.ts（现有 316 行，同样多子轴内聚于 sidebar 业务轴）是同一模式。

**证据**：
- `system-architecture.md` §7（变化轴列）、§5（状态机 8 态）、§11 AC-3（5 触发点经 composable）
- `src-electron/renderer/src/composables/features/useSidebar.ts:154-167`（现有 newSession/newSessionToStandby 同样多职责，316 行）

**风险**：120 行预估偏低（对照 useSidebar 同类编排 composable 316 行）。若按「单一轴」承诺实现，要么过度拆分（状态机/overlay/Esc 各拆一文件→协调成本暴涨），要么硬塞 120 行后超限返工。

**建议**：将 §7 useNewTaskFlow 的变化轴改述为「新建任务流程编排（业务轴内聚，含状态机/overlay/IPC 子轴）」，LOC 预估上调至 ~200-250，或显式说明子模块拆分边界。

---

### G-2 [D] RecentWorkspaceCache 边界必要性未经「派生 vs 独立缓存」证伪

**问题**：§7 列 `RecentWorkspaceCache`（LRU 10，~60 行）作为独立模块，变化轴=「缓存策略/存储介质」。但 SessionSummary 已含 `cwd` + `lastActiveAt`（`session.ts:6,10`），「最近 workspace」可从现有 session list 派生（distinct cwd by lastActiveAt desc, top 10），无需独立缓存。

文档 D-2 只证伪了「RecentWorkspace 建 DTO vs aggregate」，**未对「独立缓存 vs session list 派生」做 deletion test**。证伪三连：
- **删**：去掉 RecentWorkspaceCache，directory popover 从 session store 派生 distinct cwd → 复杂度塌缩（无独立存储/淘汰/持久化逻辑，复用已有 session 数据）→ 边界当前可能多余
- **挪**：缓存边界可滑动（LRU 在 composable / 在 store / 派生），无自然接缝卡死 → 边界非强约束

**证据**：
- `src-electron/shared/src/session.ts:3-18`（SessionSummary 含 cwd + lastActiveAt；SessionGroup 按 cwd 分组）
- `system-architecture.md` §4 RecentWorkspace DTO、§7 RecentWorkspaceCache 模块、D-2（只证伪 DTO vs aggregate）

**反方**：独立缓存 O(1) 读 vs 派生每次 dedup 遍历（性能轴）；且「最近 workspace」可能含已删除 session 的 cwd（派生拿不到）。但这恰是需明示的取舍，文档未给。

**建议**：§7 或 D-2 补一行 deletion test 结论——若「最近 workspace」语义=「最近活跃过的 cwd（含已删 session 的）」则独立缓存必要（边界真实）；若=「现存 session 的最近 cwd」则派生即可（边界多余，YAGNI）。requirements §3 数据清单未区分这两种语义，需 K 确认或 D 决策。

> [CROSS-VALIDATED 候选]：与结构帧视角 3「伪 port / 空壳层」可能同源——若派生成立，RecentWorkspaceCache 是零价值边界。

---

### G-3 [D] landing 组件 ~200 LOC 偏大，视觉子轴堆叠

**问题**：§7 landing 组件（`Landing*.vue` ~200 行）承担 watermark + 问候语 + composer 元信息行（directory/branch chip 渲染）。这三个是不同视觉变化轴（背景水印 / 文案 / chip 状态显示），200 行接近 CLAUDE.md 单组件 400 行上限的 1/2，且 chip 渲染逻辑（非 git 目录隐藏、dirty 标记显示）与 branch/dir popover 的 chip 状态有重复风险。

**证据**：`system-architecture.md` §7 landing 行；`requirements.md` §5 落地空态线框（watermark + 问候语 + composer 三段）

**风险**：弱信号。拆分合理性存在（视觉轴 vs 交互轴已分离到 popover）。但若 chip 渲染逻辑散落在 landing + popover 两处，违反「相同变化轴内聚」。属实现层（⑤design-code-arch）关注，本轮仅提示。

**建议**：§7 补注「chip 状态显示逻辑抽 shared（landing 渲染 + popover 编辑共用），避免双写」。

---

## 视角6 行为契约

### G-4 [F] BC-8 newSession 触发点清单不完整：1 处源码不存在 + 遗漏 3 处真实触发点

**问题**：BC-8 列「5 个触发点」：`Sidebar.vue:200,232 / SessionList.vue:44 / PanelHeader.vue:71 / SearchModal.vue:119`。源码核实：

| 文档标注 | 核实结果 |
|---------|---------|
| Sidebar.vue:200 | ✅ `await newSession()` |
| Sidebar.vue:232 | ✅ `void newSession()` |
| SessionList.vue:44 | ✅ `emit('newSession')` |
| PanelHeader.vue:71 | ✅ `emit('newSession')` |
| **SearchModal.vue:119** | ❌ **不存在**（`overlays/SearchModal.vue` grep newSession/create 零命中） |
| **Workspace.vue:46** | ❌ 遗漏（`await newSession()` in onNewSession） |
| **Overview.vue:95** | ❌ 遗漏（`await newSession()` in onNew） |
| **PanelContainer.vue:69** | ❌ 遗漏（`newSessionToStandby()` → 另一 create 路径） |

实际 newSession 触发点 ≥ 7 处（不含 SearchModal），文档只列 5 处且含 1 处幽灵行号。

**证据**：
- `grep -rn "newSession" src-electron/renderer/src/components/` 命中 Sidebar/SessionList/PanelHeader/Workspace/Overview/PanelContainer
- `src-electron/renderer/src/components/overlays/SearchModal.vue` grep `newSession|sessionApi.create|session.create` **零命中**

**影响**：§11 AC-3「5 触发点均经 useNewTaskFlow」的 grep 验收会漏掉 Workspace/Overview/PanelContainer 三处，改造时这三处仍裸调旧 newSession → 行为不一致。且 SearchModal:119 不存在，AC-3 grep 无效。

**建议**：BC-8 触发点清单更正为实际 7 处，移除 SearchModal:119，补 Workspace.vue:46 / Overview.vue:95 / PanelContainer.vue:69（注明 newSessionToStandby 是 standby 侧 create 路径，改造语义需单独决策）。

---

### G-5 [F] BC 清单遗漏 forkSession 调 sessionApi.create() 路径

**问题**：`useSidebar.ts:223` `forkSession` 内部调 `sessionApi.create()`（复制历史到新 session）。这是真实存在的「新建 session」路径，由 `Turn.vue:292` 触发。

T1 改造（sessionApi.create 透传 cwd）会波及 forkSession——fork 出的 session 应绑什么 cwd？沿用源 session 的 cwd（语义正确，fork 是同目录内复制）。但 BC 清单完全未列此行为，requirements 也未提（fork 不在新建任务用例内）。

视角 6 职责正是查「代码有但 requirements 没写」的行为，forkSession 调 create() 是典型此类——它会被架构变更（T1）波及，却未被标「保持/变更/删除」。

**证据**：
- `src-electron/renderer/src/composables/features/useSidebar.ts:223`（`const created = await sessionApi.create()` in forkSession）
- `src-electron/renderer/src/components/panel/message-stream/Turn.vue:292`（`await forkSession(...)`）

**影响**：T1 改 sessionApi.create 签名增 cwd 参数时，forkSession 调用点若不同步处理，fork 出的 session cwd 回退到 process.cwd()（BC-2 的 runtime 回退），破坏 fork 语义（应与源 session 同目录）。

**建议**：BC 清单新增 BC-11「forkSession 经 sessionApi.create 新建，cwd 应沿用源 session」标「保持（T1 改造时显式传源 session cwd）」。

---

### G-6 [F] BC-7 preload 源码路径错误

**问题**：BC-7 标 preload 源码位置 `preload.ts:87`，实际文件路径是 `src-electron/preload/preload.ts`（不是 `src-electron/preload/src/preload.ts`，仓库无 `preload/src/` 子目录）。line:87 内容准确（`pickDirectory: (options?) => ipcRenderer.invoke('pick-directory', options)`）。

**证据**：
- `find src-electron -name "preload*"` → `src-electron/preload/preload.ts`（无 src/ 子目录）
- `src-electron/preload/preload.ts:87`（pickDirectory invoke 行）

**影响**：轻微。AC 验收 grep 路径误导，但行为描述正确。

**建议**：BC-7 源码位置更正为 `src-electron/preload/preload.ts:87`。

---

### G-7 [K] BC-5「create 成功后 broadcastSessionList」时序与源码不符

**问题**：BC-5 描述「create 成功后 broadcastSessionList 推全量 SessionGroup[]」，源码核实 create 流程**不触发 session.list 广播**：

- `session-lifecycle.ts:85-88` create 末尾是 `this.sessionStore.refreshAll()` → `pi-config-bridge refreshAll()`（刷新内存缓存，**非 WS broadcast**）
- `session-message-handler.ts:30-32` session.create WS handler 只 `reply(ws, msg.id, 'session.created', { session })`（**单播给请求方**）
- `server.ts:336` / `session-service.ts:75` 的 `session.list` broadcast 实际在 **session 进程退出 / 其他事件**时触发，非 create 后

前端 sidebar 刷新靠 `session.created` reply + `useSidebar.newSession` 内 `session.appendSession`（乐观更新，`useSidebar.ts:156`），**不依赖 create 后广播**。

**证据**：
- `src-electron/runtime/src/services/session/session-lifecycle.ts:85-88`（refreshAll 非 broadcast）
- `src-electron/runtime/src/transport/session-message-handler.ts:30-32`（reply 单播 session.created）
- `src-electron/renderer/src/composables/features/useSidebar.ts:155-156`（appendSession 乐观更新）

**影响**：BC-5「保持」结论可能仍对（广播行为本身在其他场景保持），但「create 成功后」这个时序归因错误，会误导 issue 拆分时把「create 后广播」当既有契约保护。

**建议**：BC-5 改述为「session.list 广播在 session 进程退出等事件触发（server.ts:336），create 走 session.created 单播 + 前端乐观 appendSession」，确认要「保持」的是哪个具体行为。

---

## 收敛判定

**未收敛**。7 个 gap（F×3 / K×1 / D×3），其中：
- **强信号（F）**：G-4（触发点清单错误+遗漏）、G-5（forkSession 路径遗漏）直接影响 §11 AC-3 验收有效性，须回 Step 3 修正
- **中信号（K/D）**：G-1/G-2/G-7 影响模块划分与契约准确性，G-3 弱提示

**交叉验证候选**（待与建模帧/结构帧 round 1 结果比对）：
- G-2 RecentWorkspaceCache 边界 vs 结构帧视角 3「伪 port/空壳层」
- G-1 useNewTaskFlow 多轴 vs 结构帧视角 4「上帝对象」（若 120 行实则 250 行）
