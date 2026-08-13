# Session Restore 显式 RPC 设计

> **层性质**：技术方案设计（当前层 = session 生命周期机制，下一层 = 可实现的 RPC 接口 + 前端编排方法）。准则 5/6/7（物理数据流 / 错误恢复 / 运行时断言）全部 P0 适用。
>
> **修订记录**：v2 按对抗式审查（`review.md`）修复 4 个 must-fix（行号核实 / postLoadSession 漏 setActiveId+cancelFlow / sidebar 注入式 / ghost session 闭环）+ 3 个 suggestion。

## 结论

新增 `session.restore` 显式 RPC，替代当前「重开借道 `session.switch` 隐式分支」的脆弱模式；前端补 `api.restoreSession()` + `useSidebarNew.restoreSession()` 编排方法，`Panel.vue` 改为 setup 内解构调用、sidebar 通过参数注入。一处改动同时根治五个问题：useI18n 报错、隐式分支依赖 Map 删除时序、前端无显式重开 API、磁盘文件不存在的 ghost session、sidebar revive 不一致。

---

## §1 背景目标

### SCQA

- **情境**：xyz-agent 的每个 session 对应一个 pi 子进程。进程崩溃/退出时，runtime 广播 `session.exited`，前端标记 `status='dead'`，Panel 显示「会话进程已退出，重新打开」占位。
- **冲突**：用户点击「重新打开」报错 `重新打开失败：Must be called at the top of a \`setup\` function`，重开完全失效。即便修了这个 bug，底层链路还有多个脆弱点（隐式分支、无显式 API、ghost session、sidebar revive 不一致）。
- **问题**：session 崩溃后缺乏可靠的重开手段——这是用户恢复工作的唯一入口，失效即阻断。
- **答案**：补一个语义清晰的显式 `session.restore` RPC，让重开不依赖隐式分支、错误可区分可引导、ghost session 有闭环。

### 系统是什么

xyz-agent 是 Electron 桌面 Agent 工作台。**session 是一个 pi 子进程的包装**：runtime（Node WebSocket 服务）为每个 session `spawn` 一个 `pi --mode rpc` 子进程，前端经 runtime 中转与 pi 通信。session 有 6 个进程级状态（`shared/src/session.ts:18`）：

| 状态 | 含义 | 谁写入 |
|---|---|---|
| `active` | pi 存活且正在生成 | runtime（turn 期间） |
| `idle` | pi 存活但空闲（默认态） | runtime |
| `dead` | pi 进程异常退出 | 前端（收到 `session.exited` 后 `markDead`） |
| `done` / `error` / `stopped` | 终态（正常完成 / LLM 出错 / 用户中止） | runtime（写 sidecar） |

「重开」= 对一个 `dead` session 重新 spawn pi 并载入历史对话。

### 设计目标（从使用者体验倒推）

1. **可靠重开**：dead session 点「重新打开」能稳定恢复 pi 进程 + 历史对话，不报错
2. **显式 API**：重开有专属的 RPC 和前端方法，语义独立于「切换 session」
3. **错误可引导**：重开失败时，错误信息能指向恢复动作（配 model / 删除幽灵项 / 查日志 / 重试），而非笼统的「失败了」
4. **入口一致**：无论从 Panel 按钮还是 sidebar 列表点击 dead session，重开后 UI 状态一致（置灰消失、可继续对话）

### Scope

- **In-scope**：`session.restore` RPC（runtime + shared 类型）、前端 `api.restoreSession` + `useSidebarNew.restoreSession` 编排、`Panel.vue` / `useSidebarSessionActions` 调用方式修正、错误码规格、ghost session 闭环
- **Out-of-scope**：「卡死但未退出」的 pi 进程检测（侦查确认 idle 态零健康巡检，需独立心跳机制，属另一个议题）、session 删除后从磁盘恢复、无磁盘文件的 dead session 降级为「以此 cwd 新建空 session」（模式 D 的降级，属另一个 feature）、自动重开（崩溃即自动 restore，不本次做）、orphan/zombie pi 进程定时清理

---

## §2 现状与问题分析

### 2.1 当前重开链路（物理数据流）

```
[用户] 点击 Panel「重新打开」
   │
   ▼  Panel.vue:242  onReviveSession()  ← 事件回调（非 setup）
   │
   │  useSidebarNew().selectSession(id)   ← ★ 问题点 1：在事件回调里调 composable
   │
   ▼  useSidebarNew.ts:218  selectSession()
   │
   │  sessionApi.switchSession(id)        ← session.switch RPC（useSidebarNew.ts:223）
   │
   ▼  runtime session-message-handler.ts  case 'session.switch'
   │
   │  getSummary(id)  ← 查内存 Map（session-service.ts:664 sessions.get）
   │     │
   │     ├─ 找到（session 还在内存）→ 只回历史，不 spawn pi
   │     │
   │     └─ 没找到（dead session 已被 removeSessionEntry 删，session-service.ts:187 调用）
   │           │                                        ★ 问题点 2：隐式分支
   │           ▼  ensureActive(id)（session-service.ts:456）→ restoreSession(id)（:464）
   │
   ▼  reply session.history { session, messages }
   │
   │  （回到前端 selectSession，useSidebarNew.ts:224-251）
   │  setActiveId → clearUnread → ensureStreamSubscription → touchLru →
   │  syncSessionToPanel → navigationPort.push → hydrate(getHistory) →
   │  consumePendingOpen → fileTree.loadTree → evictIfNeeded
   │
   ▼  sessionStore.revive(id)   ← status: dead → idle（Panel.vue:246，但走不到——步骤 2 已抛错）
```

**关键事实**（均经 `read` 源码核实，见附录）：

- `removeSessionEntry` 在 pi 退出回调里被调用（`session-service.ts:187`），从内存 Map 删除 session
- `getSummary`（`session-service.ts:664`）**只查内存 Map**，不查磁盘扫描列表
- `session.switch` handler 靠 `getSummary` 返回 `undefined` 判断「该 restore 了」——这是隐式分支
- `restoreSession`（`session-lifecycle.ts:349`）实现完整：找磁盘文件 → spawn pi → switchSession 历史文件 → 初始化

### 2.2 五个失败模式

**模式 A（用户遇到的）：useI18n 报错，重开完全失效**

```
onReviveSession（事件回调，Panel.vue:242）
  → useSidebarNew()                    // Panel.vue:245
    → useHandoffActions()              // useSidebarNew.ts:369（函数体顶层）
      → useI18n()                      // useHandoffActions.ts:33
        → getCurrentInstance() === null // 事件回调无活跃组件实例
        → 抛 "Must be called at the top of a `setup` function"
```

错误来自 vue-i18n（`MUST_BE_CALL_SETUP_TOP`，`node_modules/vue-i18n/dist/vue-i18n.runtime.mjs:82/2197`）。`useI18n()` 要求活跃组件实例。

**对比**：`Sidebar.vue` 在 setup 内解构 `const { selectSession } = useSidebarNew()`，useI18n 在 setup 上下文正常初始化，所以 sidebar 点击 dead session 不报 useI18n 错——但另有模式 E 的问题。

`onRetryHistory`（`Panel.vue:237`）同样的反模式，点「重试加载历史」也会报错。

**模式 B：隐式分支依赖 Map 删除时序**

重开走 `session.switch` 的 `getSummary → undefined → ensureActive` 隐式分支。这依赖「pi 退出时 `removeSessionEntry` 已执行、内存 Map 已删」。

反例：若 `onSessionExit` 回调（`session-service.ts:181`）因异常没执行到 `removeSessionEntry`，dead session 仍在内存 Map → `getSummary` 返回 summary → `session.switch` 直接回旧历史、**不 spawn pi**，且无报错。用户以为重开了，实际拿到的是死进程的残留状态。

**模式 C：前端无显式重开 API**

`api/domains/session.ts` 有 `list / create / switchSession / fork / remove ...`，**唯独没有 `restoreSession`**。runtime 侧 `restoreSession`（`session-lifecycle.ts:349`）能力存在，但前端无法显式调用，只能借道 `switchSession` 的隐式分支。语义不清、不可独立测试。

**模式 D：磁盘文件不存在（pi 延迟写入窗口崩溃）+ ghost session**

`restoreSession`（`session-lifecycle.ts:350`）第一步 `findScannedSession` 找磁盘文件，找不到直接 `throw 'Persisted session ... not found'`。pi 有延迟写入特性（AGENTS.md 规则 #6：首条 assistant 消息到达前不 flush session 文件）——**若进程在首次回复前崩溃，磁盘无文件，重开必然失败**。这不是边缘场景：extension 加载失败导致 pi 启动即 `exit(1)`、首条消息后立即 OOM 等都会触发。

更棘手的是 **ghost session**：文件丢失后，dead session 项仍留在 sidebar 列表（SessionScanner 磁盘扫描缓存 + 内存 Map），成为永久置灰、无法重开、无法进入的僵尸项。仅隐藏重开按钮不够——用户看到一个永远无法恢复的幽灵，没有出口。

**模式 E：sidebar 点击 dead session 不调 revive（UI 不一致）**

sidebar 点击 dead session 走 `useSidebarSessionActions.ts:62` 注入的 `selectSession`，成功后**不调 `revive`**——与 Panel 入口不对称。结果：`SessionItem.vue:231` 的 `isDead` 仍为 true → 列表项永久置灰，Panel 切过去仍显 dead 占位（`Panel.vue:166`）。两个入口对同一操作给出不一致的 UI 状态。

### 2.3 根因

| 问题 | 根因 |
|---|---|
| 模式 A | `useSidebarNew()` 在事件回调中调用，它内部 `useHandoffActions` → `useI18n` 需要 setup 上下文 |
| 模式 B | 重开复用了「切换 session」的 RPC（`session.switch`），靠内存状态副作用区分两个语义 |
| 模式 C | 前端 API 层缺 `restoreSession`，没有把 runtime 已有的 restore 能力显式暴露 |
| 模式 D | pi 延迟写入 + restoreSession 强依赖磁盘文件，无降级路径；ghost session 无清理/引导出口 |
| 模式 E | revive 散落在各调用方（Panel 调、sidebar 不调），无统一入口 |

模式 B/C 是同一架构债的两个面：**「切换」和「重开」是两个不同的用户意图，却共用一个 RPC、靠隐式状态分支区分**。

---

## §3 解决方案

### 3.1 终态

**用户视角**（成功路径）：

> 用户看到一个置灰的 dead session，点击 Panel 的「重新打开」→ pi 进程重新启动，历史对话完整呈现，session 恢复正常态（置灰消失），可继续对话。从 sidebar 列表点击同一 dead session，效果一致。

**用户视角**（失败路径，带恢复指引）：

> 若 model 未配置，显示「请先在设置中配置模型」并引导打开 Settings；若 session 文件丢失（ghost session），提示「会话文件已丢失，建议删除此项」并提供删除入口；若是 spawn 失败（extension 加载失败等），显示原因 + 日志路径（`~/.xyz-agent-dev/logs/`）+ 重试按钮。

**开发者视角**：

```ts
// 前端显式 API
await api.restoreSession(id)        // 明确语义：重开 pi 进程
// 不再是：await api.switchSession(id)  // 靠副作用隐式触发 restore
```

### 3.2 方案对比

| 维度 | 方案 B1：新增 `session.restore` RPC（推荐 ✅） | 方案 B2：`session.switch` 加 `restore` 标志 | 方案 B3：仅前端封装（不改 runtime） |
|---|---|---|---|
| **长期架构合理性** | 「切换」与「重开」语义分离，各自独立 RPC + 独立错误码。符合单一职责 | 一个 RPC 承担两义，handler 内 `if(restore) ensureActive else getSummary判断`，契约不清 | ❌ 不可行——前端无法清理 runtime 内存 Map，隐式分支问题无法绕过 |
| **短期实现成本** | 改 4 处：shared 类型 / handler case / 前端 api / useSidebarNew 方法 | 改 2 处：handler 加分支 / 前端 switchSession 加参数 | — |
| **风险** | 低。复用现有 `restoreSession` 实现 + `session.created` reply 类型。新增 RPC 不影响现有 switch | 中。switch 是高频路径，加分支增加复杂度，且未来 switch/restore 演进会互相牵绊 | — |
| **裁决** | ✅ 推荐 | ❌ 否决 | ❌ 否决 |

**若用方案 B2**，§3.1 的失败路径会退化：`session.switch` 的错误码当前只有 `not_found` / `history_load_failed` / `file_not_found`，要塞入 `MODEL_NOT_CONFIGURED` 等重开专属错误码，会让 switch handler 的 catch 越来越臃肿，且前端无法区分「切换失败」和「重开失败」该给什么恢复指引。

**若用方案 B3**：前端 `restoreSession` wrapper 内部仍调 `switchSession`，模式 B 的隐式分支依赖原封不动——没解决任何根本问题。

### 3.3 关键决策与权衡

#### 决策 1：`session.restore` 的 reply 类型复用 `session.created`

- **选择**：`ReplyPayloadMap['session.restore'] = ServerMessageMap['session.created']`，即 `{ session: SessionSummary }`（`protocol.ts:973`）
- **被否**：reply `void`（像 `session.switch`，`protocol.ts:1374`）；reply `session.history`（含 messages，省一次 getHistory）
- **证据**：`session.create`（`protocol.ts:1238`）和 `session.fork`（`:1239`）都已映射到 `session.created`，restore 与它们同属「让 session 可用」语义，复用最一致
- **hydrate 数据流**（澄清）：reply `{ session }` **不含 messages**；历史消息由 `postLoadSession` 内的 `chatApi.getHistory(id)`（`useSidebarNew.ts:236` 的 hydrate 分支）单独 RPC 拉取——与 selectSession 完全一致，保持单一数据通路
- **运行时断言**：✅ 已 read 核实——`restoreSession` 返回 `this.svc.toSummary(session)`（`session-lifecycle.ts:428`），类型为 `SessionSummary`，与 `{ session }` 匹配

#### 决策 2：错误码规格

restoreSession 可能抛的错及映射：

| 错误场景 | 抛出位置 | error code | 前端恢复指引 |
|---|---|---|---|
| session 不在磁盘扫描列表 | `session-lifecycle.ts:350` `findScannedSession` 返回 null | `session_not_found` | 提示「会话文件已丢失」+ **提供删除该项的入口**（见决策 6 ghost session） |
| model 未配置 | `session-lifecycle.ts:353` `getDefaultModel()` 为空 | `MODEL_NOT_CONFIGURED`（`errors.ts:57` 已有） | 引导打开 Settings 配置模型 |
| spawn pi 失败 / switchSession 失败 | `session-lifecycle.ts:396`（switchSession）/ `:417`（initErr catch） | `restore_failed` | 显示原因 + 日志路径 `~/.xyz-agent-dev/logs/`（AGENTS.md 规则 #16 错误必须可操作）+ 重试按钮 |

- **选择**：handler 内 `try/catch`，按 `e.code` 分流到 `sendError(ws, code, msg, msgId)`，对齐 `session.create` 的现有模式（`session-message-handler.ts:71-77`）
- **被否**：统一抛 `restore_failed` 不区分场景
- **证据**：`MODEL_NOT_CONFIGURED` 已有差异化引导先例；`session_not_found` 让前端能区分「文件丢了」vs「进程起不来」，前者该引导删除、后者该允许重试

#### 决策 3：`useSidebarNew.restoreSession` 编排（含 postLoadSession 抽取）

`onReviveSession` 仍在事件回调中，必须解决 useI18n 问题（否则新方法也调不了）。

**selectSession 完整步骤**（实读 `useSidebarNew.ts:218-251`，共 13 步）：

| 步 | 代码行 | 操作 |
|---|---|---|
| 1 | 219-221 | `useNewTaskFlow()` + `cancelFlow()`（若 flow 活跃） |
| 2 | 223 | `sessionApi.switchSession(id)` ← **RPC 入口** |
| 3 | 224 | `sessionStore.setActiveId(id)` ← **★ 前置依赖** |
| 4 | 226 | `clearUnread(id)` |
| 5 | 228 | `ensureStreamSubscription(id, chat, useSessionStoreSafe())` |
| 6 | 230 | `chat.touchLru(id)` |
| 7 | 231 | `syncSessionToPanel(id)` |
| 8 | 232 | `navigationPort.push(...)` |
| 9 | 236-241 | `chatApi.getHistory(id)` → `chat.hydrate(id, messages)` |
| 10 | 243 | `consumePendingOpen(id, panelPort)` |
| 11 | 245 | `useFileTree().loadTree(id)` |
| 12 | 247 | `chat.touchLru(panel.currentLeaf.sessionId)` |
| 13 | 248 | `chat.evictIfNeeded()` |

**关键时序约束**：步骤 3（`setActiveId`）**必须先于**步骤 5（`ensureStreamSubscription`）和步骤 7（`syncSessionToPanel`）——后两者依赖当前 activeId 路由到正确 session 分区（ADR-0049 + 架构约定 #7）。

**方案**：

- 抽 `postLoadSession(id)` = **步骤 4-13**（`clearUnread` 起，10 步）。这些步骤不区分 switch/restore，是 session 载入后的通用编排
- selectSession = 步骤 1（cancelFlow）+ 步骤 2（switchSession RPC）+ 步骤 3（setActiveId）+ `postLoadSession`
- **restoreSession = 步骤 1（cancelFlow）+ `api.restoreSession(id)`（替代步骤 2）+ 步骤 3（setActiveId）+ `postLoadSession` + `sessionStore.revive(id)`**

```ts
// useSidebarNew.ts 新增
async function restoreSession(id: string): Promise<void> {
  const newTaskFlow = useNewTaskFlow()
  if (newTaskFlow.isActive.value) newTaskFlow.cancelFlow()      // 步骤 1
  await sessionApi.restoreSession(id)                            // 替代步骤 2（显式 RPC）
  sessionStore.setActiveId(id)                                   // 步骤 3（★ 不可省）
  await postLoadSession(id)                                      // 步骤 4-13
  sessionStore.revive(id)                                        // dead → idle（统一收口）
}
```

- **被否**：`onReviveSession` 直接调 `api.restoreSession` + 内联编排（不经 useSidebarNew）
- **证据**：内联方案要么漏步骤（漏 setActiveId → 订阅作用于旧 activeId），要么重复实现 10 步 postLoadSession，未来易漂移。封装在 useSidebarNew + 抽 postLoadSession 是唯一不重复且不漏步的方案
- **运行时断言**：⛔ 实施期验证——`postLoadSession` 抽取后 selectSession 行为不变（场景 4 回归）

#### 决策 4：调用方式修正——Panel.vue + sidebar 都用注入，不调 `useSidebarNew()`

- **Panel.vue**：setup 顶部解构 `const { restoreSession, retryHistory } = useSidebarNew()`（对齐 `Sidebar.vue` 的正确模式），`onReviveSession` 改调解构出的闭包 `restoreSession(props.sessionId)`，不再在事件回调调 `useSidebarNew()`
- **sidebar**（`useSidebarSessionActions.ts`）：该 composable 是**依赖注入式**架构（`UseSidebarSessionActionsOptions` 接收 `selectSession` 等方法，注释明确「useSidebarNew 非单例，不能在本 composable 内重复调用」）。restoreSession 必须**通过参数注入**：
  - `UseSidebarSessionActionsOptions` 加 `restoreSession: (id: string) => Promise<void>`
  - `Sidebar.vue` setup 注入点加 `restoreSession`（从 useSidebarNew 解构传入）
  - `onSelectSession` handler 内判断目标是否 dead（用 `useSessionStore()`——pinia store 可在任何地方调用），dead → 注入的 `restoreSession`，非 dead → 注入的 `selectSession`
- **被否**：在 handler 内调 `useSidebarNew()`（会触发 `useHandoffActions → useI18n` 抛模式 A 同款错）
- **证据**：`useSidebarSessionActions.ts:60-66` 的 `onSelectSession` 当前调注入的 `selectSession`，改成 dead 分流到注入的 `restoreSession` 是对称扩展。useSessionStore() 在非 setup 上下文调用是 pinia 的设计许可（不像 useI18n 需要组件实例）

#### 决策 5：`session.switch` 的隐式 restore 分支去留

- **选择**：**保留**，不动
- **被否**：移除隐式分支（让 switch 只处理内存中存在的 session）
- **证据**：`core.selectSession`（headless/mobile 消费方，`useSidebarNew.ts:11` 注释 C-W5-1）仍走 switch 的隐式 restore。移除会破坏 headless 路径
- **代价（已知技术债）**：两条 restore 路径错误码暂不一致——显式 `session.restore` 走新错误码（`session_not_found` / `MODEL_NOT_CONFIGURED` / `restore_failed`），隐式 switch 分支仍走旧错误码（`file_not_found` / `not_found` / `history_load_failed`）。headless 迁移到显式 restore 后统一（TODO，与「移除隐式分支」并列）

#### 决策 6：ghost session 闭环（模式 D 的 UX 出口）

- **选择**：`session_not_found` 时，前端不只隐藏重开按钮，还引导用户**删除该 ghost session 项**
  - Panel dead 占位区：检测到 `session_not_found` 错误后，文案改为「会话文件已丢失，无法恢复」+ 显示「删除此项」按钮（调 `useSidebarNew().deleteSession(id)`）
  - sidebar 项：ghost session 仍可右键/菜单删除（现有 delete 入口不受影响）
- **被否**：① 自动从列表移除（用户可能不知道为什么消失了）；② 留僵尸只隐藏按钮（用户无出口）
- **证据**：模式 D 的根因（pi 延迟写入）在另一个 feature（降级新建空 session）解决前，ghost session 必须有可操作的出口。删除是最低成本的闭环——文件已丢失，session 项已无意义。AGENTS.md 规则 #16（错误必须可操作）要求指向恢复动作

---

## §4 验收

> 实施后在 dev app（`pnpm dev`）真实环境验证，不用 mock。每个场景回溯 §1 目标。

### 场景 1：dead session 正常重开（回溯目标 1「可靠重开」+ 目标 4「入口一致」）

**前置**：制造一个 dead session——在 dev app 里打开一个有消息的 session，用 `kill -9 <pi pid>` 杀掉对应的 pi 子进程（PID 从 Activity Monitor 或 `ps aux | grep pi` 获取）。

**步骤**：
1. 确认 Panel 显示「会话进程已退出」占位 + sidebar 该项置灰
2. 点击 Panel「重新打开」按钮
3. 观察：pi 进程重新启动、历史对话完整呈现、session 置灰消失
4. 在 composer 输入一条消息发送，确认能正常对话

**通过标准**：
- 不再出现 `Must be called at the top of a setup function` 报错
- `ps aux | grep pi` 能看到新的 pi 子进程（PID 变化）
- 历史消息条数与崩溃前一致
- 新消息能收到回复

### 场景 2：model 未配置时重开（回溯目标 3「错误可引导」）

**前置**：清空 model 配置（Settings 删掉所有 provider，或临时改 `~/.xyz-agent-dev/config.json` 的 defaultModel 为空）+ 制造一个 dead session。

**步骤**：点击「重新打开」

**通过标准**：
- 错误提示是「请先配置模型」类引导文案（`MODEL_NOT_CONFIGURED` code），而非笼统的 `restore_failed`
- 有入口能打开 Settings（按钮或链接）

### 场景 3：session 文件丢失 + ghost session 闭环（回溯目标 3 + 决策 6）

> 高频触发：pi 延迟写入窗口内崩溃（首条 assistant 消息前进程已退出）——磁盘从未创建 session 文件，与手动删除等效。

**前置**：制造 dead session 后，手动删除/重命名对应的 session JSONL 文件（路径从 PanelHeader 复制）。

**步骤**：点击「重新打开」

**通过标准**：
- 错误提示是「会话文件已丢失，建议删除此项」类文案（`session_not_found` code）
- **Panel 显示「删除此项」按钮**（ghost session 闭环出口），点击后该 session 从 sidebar 列表消失
- 重开按钮隐藏（文件没了，重试无意义）

### 场景 4：正常 session 切换不受影响（回归，回溯目标 1）

**步骤**：在两个活跃 session 间切换

**通过标准**：行为与改动前一致（历史加载、panel 切换、未读标记清除）——`postLoadSession` 抽取未破坏 selectSession。

### 场景 5：sidebar 点击 dead session 重开（回溯目标 1 + 目标 4「入口一致」+ 修复模式 E）

**步骤**：点击 sidebar 里置灰的 dead session 项

**通过标准**：
- 能正常重开 pi 进程 + 加载历史（走注入的 `restoreSession`，不报 useI18n 错）
- **重开后列表项置灰消失**（revive 被调用，status → idle）——改动前这里不 revive，是 bug
- Panel 切过去显示正常对话流（非 dead 占位）
- 与场景 1（Panel 按钮入口）效果完全一致

---

## §5 下一层拆分

### 实施路径

分 3 个独立可验收的单元，按依赖顺序：

| 单元 | 内容 | 验收场景 |
|---|---|---|
| **U1：runtime `session.restore` RPC** | shared 类型 + handler case + 错误码分流 | 场景 1/2/3（runtime 侧） |
| **U2：前端 api + useSidebarNew 编排** | `api.restoreSession` + `useSidebarNew.restoreSession`（含 postLoadSession 抽取） | 场景 1/4 |
| **U3：调用方式修正（Panel + sidebar 注入）+ ghost session** | Panel setup 解构 + useSidebarSessionActions 注入 restoreSession + Panel ghost session 删除入口 | 场景 1/3/5 |

### 文件改动地图

**U1（runtime + shared）**：
- `packages/shared/src/protocol.ts`
  - `ClientMessageType`（`:45`）加 `'session.restore'`
  - `ClientMessageMap`（`:246` 附近）加 `'session.restore': { sessionId: string }`
  - `ReplyPayloadMap`（`:1238` 附近）加 `'session.restore': ServerMessageMap['session.created']`
- `packages/runtime/src/transport/session-message-handler.ts`
  - `handledTypes` 数组加 `'session.restore'`
  - 新增 `case 'session.restore'`（模式对齐 `session.create`：try/catch + code 分流 + reply + broadcastSessionList）
- `packages/runtime/src/utils/errors.ts`
  - 加 `SESSION_NOT_FOUND` / `RESTORE_FAILED` 常量（对齐 `MODEL_NOT_CONFIGURED`，`:57`）
- `packages/runtime/src/services/session/session-lifecycle.ts`
  - `restoreSession`（`:349`）抛错处改用 `errorWithCode`（`:350` findScannedSession null → `SESSION_NOT_FOUND`；`:396`/`:417` → `RESTORE_FAILED`）

**U2（前端 api + 编排）**：
- `packages/renderer/src/api/domains/session.ts`
  - 加 `restoreSession(id)`（模式对齐 `switchSession`，但 return `SessionSummary`，reply 解包 `.session`）
- `packages/renderer/src/composables/features/sidebar/useSidebarNew.ts`
  - 抽 `postLoadSession(id)`（selectSession 步骤 4-13：`clearUnread` / `ensureStreamSubscription` / `touchLru` / `syncSessionToPanel` / `navigationPort.push` / `getHistory+hydrate` / `consumePendingOpen` / `fileTree.loadTree` / `evictIfNeeded`）
  - selectSession 步骤 4-13 改为调 `postLoadSession`
  - 新增 `restoreSession(id)`：`cancelFlow` → `api.restoreSession` → `setActiveId` → `postLoadSession` → `revive`
  - 导出 `restoreSession`

**U3（调用修正 + sidebar 注入 + ghost session）**：
- `packages/renderer/src/components/panel/Panel.vue`
  - setup 顶部加 `const { restoreSession, retryHistory, deleteSession } = useSidebarNew()`
  - `onReviveSession`（`:242`）改调 `restoreSession(props.sessionId)`，catch 内按 error code 分流：`session_not_found` → 显示「删除此项」按钮（调 `deleteSession`）
  - `onRetryHistory`（`:237`）改调已解构的 `retryHistory`
- `packages/renderer/src/composables/features/sidebar/useSidebarSessionActions.ts`
  - `UseSidebarSessionActionsOptions` 加 `restoreSession: (id: string) => Promise<void>`
  - `onSelectSession`（`:60`）内判断 dead：`useSessionStore().list.find(s => s.id === id)?.status === 'dead'` → 调注入的 `restoreSession`；非 dead 走原 `selectSession`
- `packages/renderer/src/components/sidebar/Sidebar.vue`
  - useSidebarSessionActions 注入点加 `restoreSession`（从 useSidebarNew 解构传入）

### 待验证检查点

- `postLoadSession` 抽取后 selectSession 的 13 步时序完全不变（尤其 `setActiveId` 必须先于 `ensureStreamSubscription`/`syncSessionToPanel`——决策 3 已显式编排）。U2 实施时用场景 4 回归
- `session.restore` 对「正在 restoring 中」的并发请求处理：`ensureActive`（`session-service.ts:456`）已有 `restoringSessions` Set 防重入，复用即可。实施期确认前端连点不会触发两次 spawn
- ghost session 删除后 sidebar 列表刷新：`deleteSession` 内部已调 `removeFromList`（`store.ts`），确认 UI 同步

---

## 附录：运行时事实核实清单

> 以下每条均经主 agent `read`/`grep` 源码核实（非推断）。实施时若代码已变更，重新核对。

| 事实 | 位置（已核实） | 值 | 核实状态 |
|---|---|---|---|
| restoreSession 定义 | `session-lifecycle.ts:349` | `async restoreSession(sessionId)` | ✅ read |
| restoreSession 返回 | `session-lifecycle.ts:428` | `return this.svc.toSummary(session)` → `SessionSummary` | ✅ read |
| findScannedSession 调用 | `session-lifecycle.ts:350` | 找不到抛 `'Persisted session ... not found'` | ✅ read |
| getDefaultModel 检查 | `session-lifecycle.ts:353` | 为空抛 `errorWithCode(..., MODEL_NOT_CONFIGURED)` | ✅ read |
| switchSession 调用 | `session-lifecycle.ts:396` | `await client.switchSession(tmpFile)` | ✅ read |
| initErr catch | `session-lifecycle.ts:417` | `safeDestroy` + throw | ✅ read |
| session.created reply payload | `protocol.ts:973` | `{ session: SessionSummary }` | ✅ read |
| ReplyPayloadMap session.create/fork | `protocol.ts:1238-1239` | 都映射 `session.created` | ✅ read |
| ReplyPayloadMap session.switch | `protocol.ts:1374` | `void`（前端不读 payload） | ✅ read |
| ClientMessageMap session.switch | `protocol.ts:246` | `{ sessionId: string }` | ✅ read |
| ClientMessageType 枚举 | `protocol.ts:45` | 含 `'session.switch'` 等，无 `'session.restore'` | ✅ read |
| session.create 错误处理先例 | `session-message-handler.ts:71-77` | catch → `e.code === MODEL_NOT_CONFIGURED` → `sendError` | ✅ read |
| errorWithCode 签名 | `errors.ts:50` | `(message, code) => Error & { code }` | ✅ read |
| MODEL_NOT_CONFIGURED 常量 | `errors.ts:57` | `'MODEL_NOT_CONFIGURED'` | ✅ read |
| ensureActive 防重入 | `session-service.ts:456` | `restoringSessions: Set<string>` | ✅ read |
| getSummary 只查内存 Map | `session-service.ts:664` | `this.sessions.get(sessionId)` | ✅ read |
| removeSessionEntry 调用点 | `session-service.ts:187` | onSessionExit 回调内（`:181`）调用 | ✅ read |
| session.switch handler | `session-message-handler.ts` | `case 'session.switch'`，getSummary → undefined → ensureActive | ✅ read |
| markDead / revive | `packages/core/src/domain/session/store.ts:97/103` | `status = 'dead'` / `'idle'` | ✅ read |
| session.exited 前端处理 | `composables/effects/useMessageEffects.ts:37` | `markDead` + `markMessageError` + toast | ✅ read |
| selectSession 定义 | `useSidebarNew.ts:218` | 13 步编排（见决策 3 表） | ✅ read |
| setActiveId 时序 | `useSidebarNew.ts:224` | 步骤 3，先于 ensureStreamSubscription（:228） | ✅ read |
| useHandoffActions useI18n | `composables/features/fork-handoff/useHandoffActions.ts:33` | `const { t } = useI18n()`（函数体顶层） | ✅ read |
| useSidebarNew 调 useHandoffActions | `useSidebarNew.ts:369` | 函数体顶层调用 | ✅ read |
| Panel onReviveSession | `Panel.vue:242` | 事件回调内调 `useSidebarNew()` | ✅ read |
| Panel onRetryHistory | `Panel.vue:237` | 同款反模式 | ✅ read |
| useSidebarSessionActions 架构 | `useSidebarSessionActions.ts` | 依赖注入式（Options 注入 selectSession 等） | ✅ read |
| onSelectSession | `useSidebarSessionActions.ts:60` | 调注入的 `selectSession`，无 switchSession 函数 | ✅ read |
| Sidebar setup 解构 | `Sidebar.vue` | setup 内 `const { selectSession, ... } = useSidebarNew()` | ✅ read |
| SessionItem isDead | `SessionItem.vue:231` | `computed(() => props.session.status === 'dead')` | ✅ read |
