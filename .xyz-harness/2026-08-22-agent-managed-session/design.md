# Agent-Managed Session：Agent 自主创建并管理独立 Session

> **一句话结论**：新建 pi extension 暴露 session 管理工具，跨进程通信复用 pi 现役的 `extension_ui_request`/`extension_ui_response` 请求-响应骨架（ask-user 同款 select 通道 + marker 拦截），runtime 在 interpreter 回调内直接调 SessionService 执行并回写结果——串联已有的 SessionService + MessageBus 基础设施，实现 agent 创建独立 session、注入 prompt、侧栏自动同步、用户可交互、父 agent 可持续管理。

## 开篇（SCQA）

- **S（情境）**：xyz-agent 的 pi coding agent 通过 subagent 机制（`@zhushanwen/pi-subagent-workflow`）支持 agent 内部派发子任务。子任务由独立 pi 子进程执行、结果以 record entry 嵌入父 session JSONL。
- **C（冲突）**：subagent 是结果嵌入式的后台机制——子任务对话不在侧栏显示、用户无法直接与子任务对话、子任务 session 文件隔离存储在 `~/.pi/agent/subagents/`（xyz-agent 的 `SessionScanner` 扫描不到）。当 agent 需要启动一个**长期运行且需要用户监督/介入**的独立工作流时（如"帮我跑完这个测试套件，有问题叫我"），subagent 无法胜任。
- **Q（问题）**：如何让 agent 能自主创建独立的、用户可交互的、侧栏可见的 session，并持续管理它的生命周期？
- **A（答案）**：pi extension 暴露工具，工具执行内通过 `ctx.ui.select` 发带 marker 的 UI 请求 → runtime event-adapter 识别 marker 并路由给 session-manager handler（不经前端）→ handler 调 SessionService 创建 session / 注入 prompt / 执行管理操作 → 通过 `sendExtensionUiResponse` 回写结果 → extension 的 `await` 直接拿到结果返回给 agent → 侧栏自动同步。

## 1. 背景：被设计的系统是什么

**本章结论：xyz-agent 是 Electron 桌面端 AI 编码工作台，session 是用户与 pi coding agent 的对话单元，本次设计聚焦"agent 自主创建 session"能力。**

xyz-agent 是 Electron + Vue 3 + Node.js Runtime 的 AI Agent 桌面工作台。核心架构分三层：

- **Electron 主进程**：窗口管理、runtime 子进程生命周期
- **Runtime（Node.js）**：WebSocket 服务，管理 pi 子进程（pi coding agent）的 spawn/通信/销毁
- **Renderer（Vue 3）**：侧栏 session 列表 + 主对话面板 + 文件树

**Session** 是用户与 pi coding agent 的一次对话。每个 session 对应：
- 一个独立的 pi 子进程（JSONL stdio 通信）
- 一个 `.jsonl` 文件（append-only entry 树，存储在 `~/.xyz-agent/pi/sessions/`）
- 侧栏中的一个可点击条目

**现有 subagent 机制**：pi 的 `@zhushanwen/pi-subagent-workflow` extension 支持 agent 派发子任务。子任务通过 spawn 独立 pi 子进程（`--mode rpc`）运行，但其 session 文件存储在 `~/.pi/agent/subagents/` 目录下（pi-paths.ts:104），以 record entry 形式嵌入父 session JSONL，不在侧栏显示，用户无法直接交互。

**In-scope**：
1. Agent 通过工具调用创建独立 session + 注入初始 prompt
2. 新 session 在侧栏自动出现
3. 用户可点击进入、继续对话
4. 父 agent 可向子 session 发消息、读取历史、查看状态
5. Session 元数据标记创建来源（agent vs user）

**Out-of-scope**：
- 权限控制（agent 可创建 session 数量限制、防递归 spawn）——Phase 3
- 侧栏分组/过滤（按 spawnSource 筛选）——Phase 3
- 级联生命周期（父 session 结束时子 session 行为）——子 session 独立存活
- 父 session 对话流中渲染子 session 管理操作的富 UI——Phase 3（Phase 1 仅 custom entry 审计留痕）

## 2. 现状：使用者眼里是什么样的

**本章结论：当前 agent 只有两种"并行工作"方式——subagent（轻量但用户不可直达）和手动创建 session（可交互但无法自动化），缺少"agent 自主创建 + 用户可交互"的中间态。**

### 2.1 现状的真实样子

**方式 A：Subagent（agent 视角）**

Agent 调用 `subagent` 工具派发子任务：
```json
{
  "action": "start",
  "task": "修复 login.ts 的类型错误",
  "slug": "fix-login-types",
  "agent": "code-fixer"
}
```

子任务在独立 pi 子进程内执行，结果以 record entry 嵌入父 session：
```jsonl
{"type":"custom","customType":"subagent-identity","data":{"rootSessionId":"...","slug":"fix-login-types","status":"running"}}
{"type":"custom","customType":"subagent-identity","data":{"rootSessionId":"...","slug":"fix-login-types","status":"completed"}}
```

用户侧看到的是：侧栏父 session 的 drawer 里有一个 subagent 条目，只读，无法对话。

注意：subagent 的 `ask_user` 在 xyz GUI（rpc 模式）下**是可用的**——subagent-workflow 的 host 模式会把子进程的 ask_user 请求经 dialog-queue 透传到主进程 UI（`extensions/subagent-workflow/src/execution/host-mode.ts:44-48` 的 `willRespondToAskUser`，仅 headless 模式不可用）。subagent 的真正短板不是"无法提问"，而是下面 2.3 节的结构性隔离。

**方式 B：手动创建 session（用户视角）**

用户点击侧栏「+」按钮 → 选择工作目录 → 输入 prompt → session 创建。

这个过程完全由用户驱动，agent 无法参与。

### 2.2 怎么出错

**失败模式 A：需要用户直达的长时间任务**

> 用户：agent，帮我跑完这个 E2E 测试套件，有问题告诉我
>
> Agent 用 subagent 派发 → subagent 跑测试遇到环境问题，经 ask_user 向用户提问 → 提问出现在**父 session 的对话流**里，与父 agent 自己的输出混在一起 → 用户回答后任务继续，但用户无法单独查看这个子任务的完整对话流、无法事后单独追问、无法在侧栏直接定位它——子任务对话隔离在 `~/.pi/agent/subagents/` 的文件里，侧栏永远不显示

**失败模式 B：需要独立生命周期的并行工作**

> 用户：agent，帮我同时做三件事——修 bug A、写文档 B、跑测试 C
>
> Agent 用 3 个 subagent → 任务 B 提前完成、任务 C 还在跑 → 用户想只关闭/归档 B、继续盯着 C → 不行，三个子任务都寄生在父 session 的 drawer 里，没有独立的侧栏条目、独立的重命名、独立的删除、独立的 fork

**失败模式 C：用户想接管 agent 的工作**

> Agent 用 subagent 开始修 bug → 修到一半用户下班关掉 xyz-agent → 父 session 的 pi 进程结束，subagent 子进程随之终止 → 第二天用户想接着昨天的进度直接对话 → 不行，subagent 无法独立存活，也不存在可接管的独立 session

### 2.3 根因

**根因：subagent 是"结果嵌入式"机制，不是"独立 session"机制。**

Subagent 的 session 文件存储在 `~/.pi/agent/subagents/` 目录，不在 `~/.xyz-agent/pi/sessions/`（xyz-agent 的 session 扫描目录）。这意味着：
- `SessionScanner.scanSessions()` 扫描不到它
- `broadcastSessionList()` 不包含它
- 侧栏不会显示它
- 用户无法点击进入
- 子进程生命周期绑定父 session 的编排器

Subagent 的设计初衷是**轻量级后台子任务**——适合快速执行、结果汇总回父上下文的场景。它不是为"独立工作流 + 用户直达"设计的。

## 3. 根因 + 物理数据流

**本章结论：问题的根因是 xyz-agent 的 session 创建/管理基础设施已完备，但未暴露给 pi agent 作为工具使用。且存在架构级约束——pi extension 运行在 pi 进程内，能用来与 xyz-agent runtime 双向通信的通道只有 pi 现役的 `extension_ui_request`/`extension_ui_response` 骨架。**

> **Session 创建的物理数据流**（现状，用户手动触发，已逐行核实）：
>
> ```
> 用户点击「+」
>   → Renderer sessionApi.create(cwd, label) [WS RPC]
>   → Runtime SessionMessageHandler session.create
>   → SessionLifecycle.create(cwd, label, options)
>   → ProcessManager.createSession(tempId, cwd, {skillPaths, extensionPaths, ...})
>   → spawn pi 子进程 + JSONL stdio 通信
>   → client.getState() → 获取真实 sessionId + sessionFilePath
>   → initializeManagedSession() → 入 sessions Map
>   → transport 层显式调 broadcastSessionList（session-message-handler.ts:73）
>   → WS config.sessions
>   → Renderer applySnapshot({ groups }) → 侧栏自动出现
> ```

关键洞察：**这条数据流的每一步都已经存在且成熟**。`SessionService.create(cwd?, label?, options?)` 支持创建独立 pi 进程并返回含真实 sessionId 的 `SessionSummary`（session-service.ts:404-413，options 已支持 `modelOverride`/`thinkingOverride`）；`sendMessage(sessionId, content)` 返回 `{blocked, rejected?}`（:513）；`getHistory(sessionId)` 返回 `{messages, truncated}`（:863）；`getRpcClient(sessionId)` 返回 `IPiEngine | undefined`（:649）；`listPersistedSessions()` 返回 `SessionGroup[]`（:532，且确实合并内存 sessions Map：scanner.listAll → getActiveSummaries → sessions.values()）；`abort(sessionId)`（:517）。

**广播的真实触发方（第三轮审查修正）**：`SessionService` 上**没有** `broadcastSessionList` 方法，`lifecycle.create` 内部零广播；手动创建路径的 `config.sessions` 广播由 transport 层在 `create` 返回后**显式调用**（session-message-handler.ts:73 `return this.ctx.broadcastSessionList()`）；session-service.ts:336 处的 `broker.broadcast({type:'config.sessions',...})` 位于进程退出回调内，不在 create 路径。⇒ session-manager handler 必须自己触发广播（opts 注入回调，现役先例：handoff-service.ts:40 声明、:305 调用），见 §6.2。

**但存在架构级约束**：pi extension 运行在 pi 进程内，使用 `ExtensionAPI`（来自 `@earendil-works/pi-coding-agent`），无法直接访问 xyz-agent 的 WebSocket。所有现有 pi extension（session-reader、ask-user、subagent-workflow 等）都通过 `ExtensionAPI` 与 pi 交互，不直接连 xyz-agent WS。

> **跨进程通信约束**：
>
> ```
> ┌───────────────────┐          ┌───────────────────┐
> │   xyz-agent        │          │   pi 进程          │
> │   Runtime          │  JSONL   │                   │
> │                    │◄─stdio──►│  ExtensionAPI     │
> │  SessionService    │          │  pi extension     │
> │  WS server         │          │  (session-manager)│
> └───────────────────┘          └───────────────────┘
>        ▲                              ▲
>        │                              │
>        │  Extension 无法直接调用       │  Extension 只能用
>        │  xyz-agent 的 WS RPC         │  ExtensionAPI
> ```

### 3.1 通道事实盘点（v2 教训：先验证通道存在，再设计协议）

v2 曾选择"extension 写 custom entry 表达意图 + runtime 写 result entry 回传 + extension 轮询读取"，第二轮审查证实**该回传通路不存在**：

- pi RPC 命令全集（rpc-types.d.ts:14-133）没有 `append_custom_entry`——runtime 无法通过 RPC 向父 session 写 entry；
- extension 侧 `ctx.sessionManager.getEntries()` 返回的是**本进程内存快照**（session-manager.js:980-983，构造时 `loadEntriesFromFile` 一次性加载，之后仅被本进程 `_appendEntry` 变异），没有文件 watcher——外部进程写入 JSONL 的 entry 永远不会出现在该视图，轮询必然超时；
- runtime 直写父 session JSONL 违反"JSONL 唯一写方是 pi 进程"的绝对写规则（handoff marker 曾因此迁移到 sidecar，见 session-file-utils.ts:475-511 的 [W11 迁移] 记录）。

pi 进程内 extension **真正可用的双向通道**只有一个：`ctx.ui.*` 交互请求。RPC 模式下（rpc-mode.js:83-86），extension 调用 `ctx.ui.select/confirm/input/editor` 时，pi 向 stdout 发 `extension_ui_request` 事件并在 `pendingExtensionRequests` 注册回调（rpc-mode.js:70-77）；xyz runtime 通过 rpc-client 的 `sendExtensionUiResponse(id, response, method)` 写回 stdin（rpc-client.ts:701-716），pi 在 stdin 循环里 resolve pending（rpc-mode.js:615-620）。**stdin 循环与 agent 回合并发**（rpc-mode.js:644 对每行输入 `void handleInputLine(line)` fire-and-forget 异步处理，`abort`/`steer` 能在 streaming 期间工作即依赖此并发性），所以**工具执行中等待 runtime 响应不会死锁**——`ask_user` 工具今天就跑在这条闭环上（extensions/ask-user/src/index.ts:196-198，RPC 模式 `await ctx.ui.select`）。

本设计就构建在这条现役骨架上，机制拆解见 §5.0。

## 4. 终态：使用者眼里将是什么样的

**本章结论：改造后 agent 能通过工具调用创建独立 session、注入 prompt，侧栏自动同步，用户和 agent 都能管理。**

### 4.1 成功路径

**场景 1：Agent 创建独立工作流**

```
[用户] 帮我跑完 test/e2e/ 下的所有测试，有问题告诉我

[agent 内部推理] 这是一个长时间运行的任务，需要用户监督环境问题。
我应该创建一个独立 session，让用户可以看到进度。

[agent 调用] create_managed_session({
  label: "E2E 测试执行",
  prompt: "运行 test/e2e/ 下的所有测试。每遇到环境配置问题或测试失败需要决策时，
           请明确描述问题并等待用户回复。不要自行决定跳过。",
  cwd: "/Users/dev/my-project"
})

[工具内部]
  1. 写审计 custom entry 到父 session（pi.appendEntry('xyz:session-manager-intent', {...})——
     extension 入口闭包持有的 ExtensionAPI 实例；同步 void，持久化对话流留痕；
     custom entry 不进 LLM context。注意 appendEntry 在 ExtensionAPI 上，工具 execute
     的 ctx: ExtensionContext 没有此方法——subagent-workflow 现役同款闭包写法 index.ts:251）
  2. 发起请求并等待响应：
     const raw = await ctx.ui.select(SESSION_MANAGER_MARKER,
       [JSON.stringify({ action: 'create', label, prompt, cwd })],
       { timeout: 60_000, signal })
     pi → stdout 发 extension_ui_request{method:'select', title:MARKER, options:[请求 JSON]}
  3. runtime event-adapter 识别 marker（ask-user 同款检测模式）→ 翻译为
     session-manager-request → interpreter 回调 handler（不经前端，不弹对话框）
  4. handler 调 SessionService.create(cwd, label, {spawnSource:'agent', parentAgentSessionId, ...})
     → SessionService.sendMessage(newSessionId, prompt)
     → rpcClient.sendExtensionUiResponse(requestId, JSON.stringify(result), 'select')
  5. pi resolve pending → ctx.ui.select 返回 JSON 字符串 → 工具 JSON.parse 得结果

[工具返回] { sessionId: "abc-123-def", status: "created" }

[agent 回复] 我已创建独立的测试执行 session「E2E 测试执行」，
             它会在侧栏显示，你可以随时点击查看进度或回复问题。

[侧栏变化] 自动出现新条目「E2E 测试执行」（badge [AI] 为 Phase 2 交付）

[用户点击侧栏] → 看到 session 内容：agent 注入的 prompt + LLM 开始执行的回复
               → 可以直接输入回复、追问、修改指令
```

**场景 2：Agent 持续管理子 session**

```
[agent 调用] read_session_history({ sessionId: "abc-123-def" })

[工具返回] {
  messages: [
    { role: "user", content: "运行 test/e2e/ 下的所有测试..." },
    { role: "assistant", content: "开始执行测试套件...\n\n测试 1/50: login.test.ts 通过\n..." }
  ]
}

[agent 内部推理] 测试在正常跑，没有需要用户决策的问题。继续监控。

[agent 调用] get_session_status({ sessionId: "abc-123-def" })

[工具返回] { status: "active", modelId: "xiaomi-token-plan-cn/mimo-v2.5-pro" }
```

**场景 3：Agent 向子 session 发送后续指令**

```
[agent 调用] send_to_session({
  sessionId: "abc-123-def",
  content: "测试跑完了，请生成一份测试报告，包含通过/失败/跳过的数量和失败用例的详细信息。"
})

[工具返回] { blocked: false }
```

### 4.2 失败路径（带恢复指引）

**失败 1：Runtime 未响应（60s 超时，pi 侧 pending 定时器触发）**

```
[agent 调用] create_managed_session({ label: "...", prompt: "..." })

[工具返回] Error: Session manager request timed out (60s). Runtime did not respond.
👉 恢复：确认 xyz-agent 正在运行且版本 ≥ 本 extension 要求；用 list_my_sessions 确认
   操作是否实际已生效（超时 ≠ 失败，可能是响应晚到——handler 完成后 pending 已清理，
   pi 侧忽略迟到响应，此为幂等安全设计）。
```

**失败 2：session 创建失败（model 未配置）**

```
[agent 调用] create_managed_session({ label: "...", prompt: "..." })

[工具返回] Error: No model configured. Please configure a provider and model in Settings.
👉 恢复：请用户在 Settings 中配置模型后重试。
```

**失败 3：目标 session 不存在**

```
[agent 调用] send_to_session({ sessionId: "old-id", content: "继续" })

[工具返回] Error: Session old-id not found (may have been deleted)
👉 恢复：用 list_my_sessions 查看当前可用的 session 列表。
```

**失败 4：用户中止父 session（AbortSignal 传播）**

```
[用户在父 session 点停止] → 工具的 signal 触发 → pi 侧 pending 提前 resolve
   默认值 undefined（rpc-mode.js:59-62 onAbort）→ 工具返回"已取消"说明
👉 结果：请求可能已到达 runtime（in-flight 操作照常完成），agent 下轮可 用
   list_my_sessions 核对实际状态后向用户说明。
```

**失败 5：session 已创建但 prompt 注入失败（部分成功）**

```
[agent 调用] create_managed_session({ label: "...", prompt: "..." })
[handler] create 成功（session 已进 sessions Map、侧栏已广播）→ sendMessage 抛错
[工具返回] Error: <sendMessage 失败原因> [session was created; use send_to_session
           to retry prompt delivery instead of create again] (sessionId: "abc-123-def")
👉 恢复：错误携带 sessionId——用 send_to_session(sessionId, prompt) 补发初始 prompt，
   禁止再次 create_managed_session（会产生重复 session）。侧栏条目此时已可见。
```

## 5. 关键决策与权衡

**本章结论：5 个决策。最关键的架构决策是跨进程通信走 pi 现役的 select+marker 请求-响应骨架；元数据持久化走 sidecar 家族（JSONL header 不可行）。**

### 5.0 跨进程通信机制：select+marker 请求-响应（选）vs custom entry 桥接 vs 直连 WS vs Runtime-side tool

**这是本设计最关键的架构决策**——pi extension 运行在 pi 进程内，无法直接调用 xyz-agent 的 WS RPC。必须选择一种跨进程通信方式。

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| A: select+marker 请求-响应（选） | 高——完整复用 pi 现役 UI 请求骨架的三个环节，每个环节都有生产先例（见下） | 中——extension 侧 ~40 行 + runtime 侧 marker 分支 + handler ~150 行 | 低——请求-响应语义天然，超时/中止/迟到响应语义由 pi pending 机制现成处理 | ✅ |
| B: custom entry 桥接（v2 方案） | 无——回传通路不存在（见 §3.1 通道事实盘点） | — | 致命——6 个工具 100% 走超时失败路径 | ❌ |
| C: extension 直连 xyz-agent WS | 低——pi extension 不应知道 xyz-agent 的 WS 地址，紧耦合 | 中——需暴露 WS endpoint 给 extension | 高——网络层故障面大，extension 升级可能破坏 | ❌ |
| D: Runtime-side tool（不走 extension） | 中——绕过跨进程问题，但违反"工具由 pi extension 提供"范式 | 高——需改 Runtime 注入自定义工具到 pi 的机制 | 高——pi 工具注册机制是 `ExtensionAPI.registerTool`，绕过即需修改 pi 核心，违反"不修改 pi 源码"约束 | ❌ |

**方案 A 的机制拆解——三个环节全部有现役先例，本方案是拼接而非发明**：

1. **extension 发起**：`ctx.ui.select(title, options, {timeout, signal})`（工具 `execute` 的第 5 参 `ctx: ExtensionContext` 提供）。pi 注册 pending 并发 `extension_ui_request`。现役先例：`ask_user` 工具（extensions/ask-user/src/index.ts:196-198）。
2. **runtime 识别并拦截**：event-adapter 已有"select + title 匹配 marker → 特殊翻译"的现役模式——ask-user 的 `ASK_USER_MARKER` 检测分支（event-adapter.ts:515-547）。本方案新增一个 marker 分支：title 等于 `SESSION_MANAGER_MARKER` 时翻译为新 kind `session-manager-request`，**不产生前端 WS 帧**（区别于 ask-user：ask-user 翻译后仍发前端渲染对话框，本方案走 bridge-ui 式"直接路由不经前端"，见 event-interpreter.ts:331-332 的 `bridge-ui` case 及其注释）。
3. **runtime 回写**：interpreter 新 case 路由到组合根注入的回调（参照 `onBridgeUIRequest` 的注入方式），handler 内调 SessionService 后用 `rpcClient.sendExtensionUiResponse(requestId, JSON.stringify(result), 'select')` 回写（rpc-client.ts:701-716；select 分支 `String(response)` 序列化 → pi 侧 parseResponse 原样 resolve value 字符串 → extension `JSON.parse`）。现役先例：bridge-handler.ts 的 bridge 请求响应全链路。

**数据编码约束**（select 通道的固有形状，设计时接受）：
- 请求方向：payload 必须编码为 `options[0]` 的 JSON 字符串（ask-user 同款，event-adapter.ts:519 解析 `options[0]`）；
- 响应方向：结果是经 `JSON.stringify` 的字符串（`String()` 强转，rpc-client.ts:713）——`read_session_history` 的大 payload（数十 KB）以单行 JSONL 传输，无协议长度限制，但列为 §10 待验证项（实测上限）；
- 超时：extension 侧 `timeout` 由 pi pending 定时器执行（rpc-mode.js:64-69 到期 resolve 默认值 `undefined`）；迟到响应被 pi 忽略（rpc-mode.js:617-619 pending 已清理）——幂等安全。

> **select+marker 请求-响应的物理数据流**：
>
> ```
> ┌───────────────────┐   extension_ui_request   ┌───────────────────┐
> │   pi 进程          │ ──(stdout JSONL)──────► │   xyz-agent        │
> │                    │   {method:'select',     │   Runtime          │
> │  extension         │    title:MARKER,        │                    │
> │  registerTool()    │    options:[请求JSON]}  │  event-adapter     │
> │  → agent 调用      │                         │  marker 检测       │
> │  → ctx.ui.select   │                         │  → 翻译 sm-request │
> │  → await pending   │                         │  → interpreter     │
> │                    │                         │    → handler       │
> │                    │                         │  → SessionService  │
> │  pending resolve   │ ◄─(stdin JSONL)──────── │  → sendExtensionUi │
> │  → JSON.parse      │   extension_ui_response │    Response        │
> │  → 返回给 agent    │   {id, value:结果JSON}  │                    │
> └───────────────────┘                         └───────────────────┘
> ```

**审计持久化（补充，非通信通道）**：extension 在发请求前同步写 `pi.appendEntry('xyz:session-manager-intent', {action, ...params})`（`pi` 是 extension 入口 `export default function (pi: ExtensionAPI)` 的闭包实例；签名 `appendEntry(customType, data?)`，types.d.ts:936——注意它在 ExtensionAPI 上，工具 execute 的 `ctx: ExtensionContext` 没有此方法，subagent-workflow 现役即闭包写法，index.ts:251 `pi.appendEntry("workflow:log", ...)`）。custom entry 不进 LLM context（types.d.ts:921-922），仅作对话流留痕。**live 可见性边界（可从代码预判，非待验证）**：live 路径 `handleEntryAppended` 的 customType 白名单只认 `subagent-record`/`workflow-record`，其余 customType 一律 noop（event-adapter.ts:907-917）——即审计 entry 在操作发生时**不显示**在前端对话流（纯留痕、无 UI 承诺），仅 reload（持久化路径 entry → reducer）后可见。这与关键规则 #9（live ≡ reload 的对象是"对话流状态"）不冲突：审计 entry 不属于对话流状态，是附加留痕。reload 渲染安全仍列为 §10 待验证项。**这是单向写**，结果不回写 entry（结果经 §4.1 场景 1 的 agent 回复自然留在对话流）。

### 5.1 工具暴露方式：pi Extension vs Runtime 内置 WS RPC

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| A: 新建 pi extension（选） | 高——与现有 19 个 extension 同范式，可独立发布/更新/禁用 | 中——需新建 extension + 通道编码 | 低——复用已有 extension 机制 | ✅ |
| B: Runtime 内置新 WS RPC | 中——增加 Runtime 复杂度，session-service 已 2327 行 | 低——直接在 session-message-handler 加 case | 中——侵入核心模块，测试面大 | ❌ |

**被否若用 B**：需要修改 `session-service.ts`（已 2327 行）和 `session-message-handler.ts`，增加新的 WS 消息类型和处理逻辑。这违反了"最小侵入"原则，且 Runtime WS RPC 是给 Renderer 前端调用的，不是给 pi agent 调用的——语义层次不对。

**推荐 A 的理由**：pi extension 是 xyz-agent 的标准扩展机制，已有 19 个成熟实践。Extension 独立于 Runtime 核心，可单独测试、发布、禁用。

### 5.2 初始 Prompt 注入方式：handler 同步注入 vs extension 异步注入

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| A: handler 同步注入（选） | 高——create + send 在同一 handler 调用内完成，原子性好 | 低——handler 内调用已有的 SessionService.sendMessage | 低——create 返回即含真实 sessionId（内部已 getState 确认就绪） | ✅ |
| B: Extension 异步二次注入 | 中——extension 先 create、再等就绪、再发 prompt | 中——需二次请求 + 就绪判断 | 中——两次请求间隙子 session 处于"已创建无内容"的中间态 | ❌ |

**推荐 A 的理由**：handler 运行在 xyz-agent 进程内，可以直接调用 `SessionService.create()` + `SessionService.sendMessage()`。`create()` 返回时 pi 进程已 spawn 且 sessionId 已确认（`ProcessManager.createSession` 后经 `client.getState()` 拿到真实 id 才 resolve，见 §3 数据流），`sendMessage` 通过已有的 `MessageDispatcher` 发送到新 session 的 pi 进程。整个过程在一次 handler 调用内完成。create 返回后立即 sendMessage 的就绪时序仍列为 §10 待验证项（pi 进程 spawn 完成与 RPC 就绪之间可能存在窗口，失败则在 handler 内加短重试）。

### 5.3 Session 元数据持久化：sidecar（选）vs JSONL Header vs 内存态

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| A: sidecar `.spawn.json`（选） | 高——xyz 自有语义写 sidecar 有成熟先例（`.handoff.json` 同构，session-file-utils.ts:494-511）；不触碰 JSONL（唯一写方是 pi） | 中——sidecar 读写 ~60 行 + scanner 提取 + summary 透传 | 低——原子写 + 文件存在守卫 + 缓存失效三件套照搬先例 | ✅ Phase 2 |
| B: JSONL Header 新增字段 | 无——header 由 pi 写：pi 的 `NewSessionOptions` 只接受 `{id?, parentSession?}`（core/session-manager.d.ts:13-16），xyz 无 header 写入通道；`forkEntryId` 能进 header 是 fork 流程 xyz 整文件重写的特殊路径，不可推广；且复用 `parentSession` 字段会污染 fork 血缘语义 | — | 致命——通路不存在 | ❌ |
| C: 纯内存态 | 低——重启丢失，无法跨 session 查询、重启后 badge 消失 | 低——零持久化代码 | 中——用户体验不完整 | ❌（仅作 Phase 1 过渡，见下） |

**Phase 拆分**：Phase 1 先用内存态（`SessionService.create` 的 options 接收 `spawnSource`/`parentAgentSessionId`，存入 sessions Map 的 summary 对象，`list_my_sessions` 从内存过滤——重启丢失）；Phase 2 落 sidecar 持久化（`persistSpawnSidecar`：原子写 `atomicWrite` + JSONL 不存在守卫（pi 延迟写窗口）+ `sessionMetaCache.delete` 缓存失效，三件套逐行照搬 `persistHandoffSidecar`），`scanSessionMeta` 提取 → `ScannedSessionMeta` → `scannedToSummary` 透传 → 重启后 badge/父子关系仍在。

### 5.4 子 Session 生命周期：独立存活 vs 级联终止

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| A: 独立存活（选） | 高——子 session 就是普通 session，语义清晰 | 低——零额外逻辑 | 低——用户可手动删除不需要的子 session | ✅ |
| B: 级联终止 | 中——干净但可能丢失用户需要的内容 | 中——需监听父 session 销毁事件 + 实现终止逻辑 | 中——误终止正在使用的子 session | ❌ |

**推荐 A 的理由**：子 session 创建后就是独立的 .jsonl 文件 + 独立 pi 进程，与用户手动创建的 session 无本质区别。父 session 结束不影响子 session——用户可以在侧栏看到它、继续使用它、或手动删除。

## 6. 实现机制

**本章结论：三层实现——pi extension 暴露工具（select+marker 通信 + custom entry 审计）、Runtime marker 拦截 + handler 执行、前端 badge（Phase 2）。**

### 6.1 Pi Extension：`extensions/session-manager/`（包名 `@zhushanwen/pi-session-manager`）

**职责**：暴露 session 管理工具给 agent；请求经 select+marker 通道发给 runtime，结果 JSON 回传。

**工具清单**：

| 工具名 | 参数 | 返回 | 说明 |
|--------|------|------|------|
| `create_managed_session` | `label`, `prompt`, `cwd?`, `model?`, `thinkingLevel?` | `{ sessionId, status }` | 创建子 session 并注入 prompt |
| `send_to_session` | `sessionId`, `content` | `{ blocked, rejected? }` | 对齐 sendMessage 返回形状 |
| `read_session_history` | `sessionId`, `tailTurns?` | `{ messages, truncated }` | handler 侧按 tailTurns 截断（SessionService.getHistory 无 limit 参数） |
| `list_my_sessions` | 无 | `{ sessions[] }` | 过滤 spawnSource='agent' 且 parentAgentSessionId=本 session |
| `get_session_status` | `sessionId` | `{ status, modelId? }` | status: active/idle；modelId 由 handler 从 get_state 的 `model` 对象组装为 `provider/id`（get_state 无 modelId 字段；对齐 switchModel 格式） |
| `abort_session` | `sessionId` | `{ success }` | 中止子 session 当前回合 |

**通信核心（全部工具共用）**：

```typescript
// marker 常量归属 @xyz-agent/extension-protocol（ASK_USER_MARKER 同款 SSOT 约定，
// event-adapter.ts:27 import）——extension 与 runtime 共享一份，禁两处复制。
// 值采用 \x00 NUL 前缀约定（ASK_USER_MARKER='\x00XYZ_ASK_USER'、GUI_WIDGET_MARKER
// 同款）：结构性排除与人类可读 title 碰撞，泄漏时不可能伪装成正常文本
const SESSION_MANAGER_MARKER = '\x00XYZ_SESSION_MANAGER'

async function requestSessionManager<T>(
  pi: ExtensionAPI,                     // extension 入口闭包实例（appendEntry 在此，不在 ctx）
  action: string,
  params: Record<string, unknown>,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<T> {
  // 审计留痕：custom entry 不进 LLM context，仅持久化到对话流
  // （appendEntry 签名为 (customType, data?)，同步 void）
  pi.appendEntry('xyz:session-manager-intent', { action, ...params })

  const raw = await ctx.ui.select(
    SESSION_MANAGER_MARKER,
    [JSON.stringify({ action, ...params })],
    { timeout: 60_000, signal },
  )
  // pi 侧超时/中止时 resolve undefined（rpc-mode.js:59-69）
  if (raw === undefined) {
    throw new Error('Session manager request timed out or aborted (60s). '
      + 'Use list_my_sessions to check whether the operation actually took effect.')
  }
  const result = JSON.parse(raw) as { error?: string; hint?: string; sessionId?: string } & T
  if (result.error) {
    // create 已成功但 prompt 注入失败时，error 附 sessionId + hint——
    // agent 据此走 send_to_session 补发，而非重复 create 产生重复 session
    throw new Error(result.hint ? `${result.error} [${result.hint}]` : result.error)
  }
  return result
}
```

工具注册入口（与现有 extension 同构）：

```typescript
export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'create_managed_session',
    // ...
    async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
      return requestSessionManager(pi, 'create', {
        label: params.label,
        prompt: params.prompt,
        cwd: params.cwd ?? ctx.cwd,          // ExtensionContext.cwd（types.d.ts:217）
        model: params.model,
        thinkingLevel: params.thinkingLevel,
      }, ctx, signal)
    },
  })
}
```

**通道语义要点**：
- `ctx.ui.select` 的泛型在运行时原样返回 pi resolve 的 value（此处为 runtime `JSON.stringify` 的结果字符串），类型断言由 `JSON.parse` + 运行时 guard（`error` 字段检查）承担；
- `signal`（用户中止父 session）传入 select——pi pending 提前 resolve `undefined`（rpc-mode.js:59-62），工具走超时/中止错误分支；
- 60s 超时覆盖 create 的 spawn + model 加载耗时（原 v2 定 30s 偏紧）。

### 6.2 Runtime：marker 拦截 + handler 执行

**改动点 1：event-adapter marker 分支**（`packages/runtime/src/infra/pi/event-adapter.ts`，`handleExtensionUIRequest` 的 INTERACTIVE_UI_METHODS 分支内，ask-user marker 检测的同位置后新增）：

```typescript
// session-manager 请求检测：select + title === SESSION_MANAGER_MARKER
// → options[0] 是请求 JSON。拦截后不经前端（区别于 ask-user：无 WS 帧、无对话框），
// 翻译为 session-manager-request 由 interpreter 直接路由（bridge-ui 同款模式）。
// 注意：检测失败（非法 JSON / action 非 string）也必须 return 本分支——
// 若 fall-through 到普通 select 翻译（:549-574），会产出 extension.ui_request WS 帧
// + extension-ui kind → 前端弹出 title 为 marker、options 为原始 JSON 的无意义对话框。
// 检测失败时带 error 标志交给 handler 回 cancelled（event-adapter 是纯翻译层，
// 无 rpc-client 引用，不能在此层直接回写）。
if (method === 'select' && event.title === SESSION_MANAGER_MARKER) {
  const raw = Array.isArray(event.options) ? String(event.options[0] ?? '') : ''
  let req: { action?: unknown } | undefined
  try { req = JSON.parse(raw) } catch { /* 非法 JSON → error 路径 */ }
  const okAction = typeof req?.action === 'string'
  return [{ kind: 'session-manager-request', requestId: String(event.id ?? ''),
            sessionId: sid, action: okAction ? req.action : '__malformed__',
            params: okAction ? req : { raw } }]
}
```

**改动点 2：interpreter 新 case**（`packages/runtime/src/services/session/event-interpreter.ts`，紧邻 `bridge-ui` case）：

```typescript
case 'session-manager-request':
  this.opts.onSessionManagerRequest?.(ev.requestId, ev.sessionId, ev.action, ev.params)
  return
```

**改动点 3：handler**（新文件 `packages/runtime/src/services/session/session-manager-handler.ts`，参照 bridge-handler.ts 结构；组合根接线 `onSessionManagerRequest`，注入方式参照 `onBridgeUIRequest`）：

```typescript
async handle(requestId: string, parentSessionId: string, action: string, params: Record<string, unknown>): Promise<void> {
  const respond = (payload: Record<string, unknown>) => {
    const client = this.sessionService.getRpcClient(parentSessionId)  // SessionService.getRpcClient（:649）
    if (!client) {
      // 父 pi 进程已死：无人等待响应，丢弃即正确语义；warn 落 runtime 日志（可观测性）
      console.warn(`[session-manager] parent client gone, drop response: ${parentSessionId}`)
      return
    }
    client.sendExtensionUiResponse(requestId, JSON.stringify(payload), 'select')
  }

  // marker 检测失败的兜底：回 cancelled（null → {id,cancelled:true}，rpc-client.ts:703-705
  // → pi resolve undefined → extension 走超时/中止错误分支），绝不让其弹前端对话框
  if (action === '__malformed__') {
    this.sessionService.getRpcClient(parentSessionId)
      ?.sendExtensionUiResponse(requestId, null, 'select')
    return
  }

  let createdId: string | undefined   // create 已成功标志：后续失败时 error 附 sessionId，
                                       // agent 可 send_to_session 补发 prompt 而非重复 create
  try {
    switch (action) {
      case 'create': {
        const summary = await this.sessionService.create(params.cwd, params.label, {
          spawnSource: 'agent',
          parentAgentSessionId: parentSessionId,
          modelOverride: params.model,
          thinkingOverride: params.thinkingLevel,
        })
        createdId = summary.id
        // 侧栏广播：SessionService 无此能力（第三轮审查 Blocker 修正）——
        // 手动创建路径由 transport 层显式调（session-message-handler.ts:73），
        // 本 handler 经 opts 注入同款回调（先例：handoff-service.ts:40/:305）。
        // 紧跟 create 成功即广播（先于 sendMessage）——prompt 注入失败不应
        // 连累侧栏可见性，注入失败走 error 附 sessionId 的恢复路径
        this.opts.broadcastSessionList?.()
        await this.sessionService.sendMessage(summary.id, params.prompt)
        respond({ sessionId: summary.id, status: 'created' })
        break
      }
      case 'send':    respond(await this.sessionService.sendMessage(params.sessionId, params.content)); break
      case 'history': {
        const { messages, truncated } = await this.sessionService.getHistory(params.sessionId)
        const tail = typeof params.tailTurns === 'number' ? messages.slice(-params.tailTurns * 2) : messages
        respond({ messages: tail, truncated: truncated || tail.length < messages.length })
        break
      }
      case 'status': {
        const client = this.sessionService.getRpcClient(params.sessionId)
        // get_state 返回字段是 model（Model 对象，rpc-mode.js:346），无 modelId——
        // 从 state.model 组装 provider/id（对齐 switchModel 的 modelId 格式，:556；
        // 现役同款先例 replicated-states.config.ts:96-102）
        const state = client ? await client.getState() : undefined
        const model = state?.model as { provider?: string; id?: string } | undefined
        const modelId = model?.provider && model?.id ? `${model.provider}/${model.id}` : undefined
        respond({ status: client ? 'active' : 'idle', ...(modelId ? { modelId } : {}) })
        break
      }
      case 'list': {
        const groups = this.sessionService.listPersistedSessions()
        const mine = groups.flatMap(g => g.sessions)
          .filter(s => s.spawnSource === 'agent' && s.parentAgentSessionId === parentSessionId)
        respond({ sessions: mine })
        break
      }
      case 'abort':
        await this.sessionService.abort(params.sessionId)
        respond({ success: true })
        break
      default:
        respond({ error: `Unknown action: ${action}` })
    }
  } catch (e) {
    respond({ error: toErrorMessage(e), ...(createdId ? { sessionId: createdId, hint: 'session was created; use send_to_session to retry prompt delivery instead of create again' } : {}) })
  }
}
```

**接线方式（防阻塞）**：interpreter 的 `onSessionManagerRequest` 回调**必须 fire-and-forget**（`onBridgeUIRequest` 同款：interpreter case 内同步调用回调不 await，组合根 index.ts:267-269 不 await server 处理函数）——interpreter 的 `interpret()` 是同步事件循环，async handler 若被 await 会阻塞父 session 的后续事件翻译。create 分支耗时数秒（spawn pi 进程）期间，父 session 的 message 事件流不受影响（readline 每行独立回调，rpc-client.ts:293）。

**params 校验位置**：event-adapter 只校验 `action` 是 string；`params` 的完整 schema 校验（unknown → 类型收窄）在 **handler 入口**执行（按 U2 定义的 schema）——校验失败走 catch 的同通道 error respond，畸形参数安全降级。

**错误闭环**：handler 的 catch 兜底与成功路径走同一 `respond`（select value 通道）——修复 v2"错误路径依赖不存在的回写命令、成功/失败路径一起失效"的结构缺陷。marker 检测失败（malformed）由 handler 回 `sendExtensionUiResponse(requestId, null, 'select')` → `{id, cancelled:true}` → pi resolve `undefined` → extension 走超时/中止错误分支——全程不产生前端 WS 帧，不弹对话框。

### 6.3 元数据扩展（Phase 1 内存态 + Phase 2 sidecar 持久化）

**共享类型**（`packages/shared/src/session.ts`，Phase 1 即加）：

```typescript
interface SessionSummary {
  // ...现有字段
  /** session 创建来源：用户手动 vs agent 工具调用（Phase 1 内存态，Phase 2 sidecar 持久化） */
  spawnSource?: 'user' | 'agent'
  /** agent 创建者的 sessionId（仅 spawnSource='agent' 时有值） */
  parentAgentSessionId?: string
}
```

**Phase 1（内存态）**：`SessionLifecycle.create` 的 options 新增 `spawnSource`/`parentAgentSessionId`，写入 sessions Map 中的 summary 对象；`listPersistedSessions` 从内存 sessions Map 合并时透传（活跃 session 的 list/badge 即时生效；重启后丢失，属已知过渡态）。

**Phase 2（sidecar 持久化）**（`packages/runtime/src/infra/pi/session-file-utils.ts`）：

新增 `persistSpawnSidecar(filePath, spawnSource, parentAgentSessionId)`——逐行照搬 `persistHandoffSidecar`（session-file-utils.ts:494-511）的三件套：
1. `atomicWrite(filePath + '.spawn.json', ...)`（tmpfile + rename 原子写）；
2. JSONL 不存在守卫（pi 延迟写窗口内 `existsSync=false` → warn + 跳过，绝不先于 pi 创建文件——规则 #6）；
3. 写后 `sessionMetaCache.delete(filePath)`（缓存键只含 JSONL 的 mtime/size，sidecar 变更不触发自然失效）。

读取侧：`scanSessionMeta` 提取 `.spawn.json` → `ScannedSessionMeta` 新字段 → `scannedToSummary` 透传 → `SessionSummary`。重启后 badge 与 `list_my_sessions` 过滤恢复。

**改动量估算**：Phase 1（shared 类型 5 行 + lifecycle options 10 行 + 内存透传 10 行）；Phase 2（sidecar 读写 60 行 + scanner 提取 15 行 + 透传 5 行）。

### 6.4 前端适配（Phase 2）

**侧栏 Badge**（`SessionItem.vue`）：

```vue
<span v-if="session.spawnSource === 'agent'"
      class="text-xs px-1 rounded bg-blue-500/20 text-blue-400">
  AI
</span>
```

**改动量**：~15 行。

**全功能兼容**：agent-spawned session 就是普通 session（独立 .jsonl、独立 pi 进程），所有侧栏操作天然兼容——点击进入、发消息、重命名、删除、Fork、Handoff、文件树、Subagent/Workflow drawer。零额外适配。

### 6.5 物理数据流（终态）

```
Agent (pi 进程 A)             pi stdio               Runtime (xyz-agent)           Sidebar
     │                            │                         │                        │
     │── create_managed_session ──│                         │                        │
     │   appendEntry(审计) ───────►│ (写入父 session JSONL)   │                        │
     │   ctx.ui.select(MARKER) ───►│ extension_ui_request    │                        │
     │   await pending…           │ {select,MARKER,[JSON]}  │                        │
     │                            │── event-adapter ───────►│                        │
     │                            │   marker 检测           │                        │
     │                            │   → sm-request kind     │                        │
     │                            │   （无前端 WS 帧）        │                        │
     │                            │   interpreter → handler │                        │
     │                            │                         │── SessionService       │
     │                            │                         │   .create() ───────────►│
     │                            │                         │   spawn pi 进程 C      │
     │                            │                         │   handler 触发广播      │
     │                            │                         │   (opts 注入回调)      │
     │                            │                         │                        │
     │                            │                         │── sendMessage(C,prompt)│
     │                            │                         │   pi 进程 C 开始执行   │
     │                            │                         │                        │
     │                            │◄─ extension_ui_response │                        │
     │                            │   {id, value:结果JSON}   │                        │
     │◄── pending resolve ─────────│                         │                        │
     │── 返回 {sessionId:"C"} ──►│                         │                        │
```

## 7. 验收（真实场景，非单测非 mock）

**本章结论：实施后按 Phase 分别验收——Phase 1 用 6 个真实场景验证核心链路（含超时与中止失败路径），Phase 2 补持久化与 badge 场景。全部在真实 xyz-agent + 真实 pi 进程上执行。**

### 7.1 改动规模

中等——新建 pi extension（6 个工具 + 通道编码 ~300 行）+ Runtime 三处（event-adapter marker 分支 ~25 行、interpreter case ~5 行、handler ~150 行）+ 元数据（Phase 1 ~25 行 / Phase 2 ~80 行）+ 前端 badge ~15 行。核心是串联已有能力，非核心逻辑重写。

### 7.2 Phase 1 验收场景

| 场景 | 回溯 §1 目标 | 真实流程/数据/路径 | 通过标准 |
|------|-------------|-------------------|---------|
| Agent 创建 session + 侧栏出现 | 目标 1 + 目标 2 | 在真实 xyz-agent（`pnpm dev`）中向 agent 发 prompt 使其调用 `create_managed_session` 创建 session | 侧栏在 5 秒内自动出现新 session 条目（badge 为 Phase 2，不在本场景标准内） |
| 用户点击进入 + 继续对话 | 目标 3 | 点击侧栏新出现的 session → 看到 agent 注入的 prompt 和 LLM 回复 → 输入新消息 → LLM 响应 | 对话正常进行，消息流实时显示 |
| Agent 持续管理子 session | 目标 4 | Agent 调用 `read_session_history` 读取子 session 历史 → 调用 `send_to_session` 发送后续指令 → 调用 `get_session_status` 查看状态 | 三个工具调用均成功返回，子 session 响应新指令 |
| 失败恢复：model 未配置 | 失败路径 | 清除 model 配置 → agent 调用 `create_managed_session` | 工具返回明确错误信息（经 select 通道回传），提示用户配置 model；父 session 对话流可见审计 entry |
| 失败恢复：超时/中止 | 失败路径 | 构造 runtime 不响应（如临时移除 handler 接线）→ agent 调用工具；或工具执行中用户点停止 | 前者 60s 后工具返回超时错误（含 list_my_sessions 恢复指引）；后者工具立即返回中止说明，父 session 可继续对话 |
| 多 session 并行 | 目标 1-4 | Agent 同时创建 3 个独立 session（不同任务）→ 用户在侧栏看到 3 个新条目 → 分别点击进入对话 | 3 个 session 独立运行，互不干扰，用户可自由切换 |

### 7.3 Phase 2 验收场景

| 场景 | 回溯目标 | 真实流程 | 通过标准 |
|------|---------|---------|---------|
| badge 显示 | 目标 5 | agent 创建 session 后观察侧栏 | 新条目显示 [AI] badge；用户手动创建的 session 无 badge |
| 重启持久性 | 目标 5 + 关键规则"重开 session 仍可见" | agent 创建 session → 完全退出并重启 xyz-agent → 观察侧栏 | badge 仍在；agent 调用 `list_my_sessions` 仍能列出该子 session（sidecar 读取恢复内存态） |
| 父 session reload 渲染安全 | 审计 entry | agent 发起管理操作后，关闭再重开父 session | 父 session 对话流正常渲染（`xyz:session-manager-intent` custom entry 不破坏 reload；渲染表现见 §10 待验证项的处置结论） |

### 7.4 验收依赖

- 真实 xyz-agent 桌面端（dev 模式 `pnpm dev`）
- 真实 pi binary（已配置 model）
- 无需 mock——select 通道、WS RPC、pi 进程全部真实执行

## 8. 实施

**本章结论：分 3 阶段交付。Phase 1（4-5 天）打通 select+marker 通道 + 6 工具 + 内存态元数据；Phase 2（2-3 天）sidecar 持久化 + badge；Phase 3（2-3 天）权限与分组。**

### 8.1 迁移路径

| 阶段 | 内容 | 交付终态的什么 |
|------|------|---------------|
| Phase 1（MVP） | extension 6 工具 + select+marker 通道 + event-adapter/interpreter/handler + 内存态元数据 | Agent 创建 session + 侧栏出现 + 用户可交互 + agent 可管理（重启丢元数据，已知过渡态） |
| Phase 2（持久化） | `.spawn.json` sidecar + scanSessionMeta 提取 + summary 透传 + 侧栏 badge + 父子导航 | 重启后 badge/父子关系保留 + 视觉标记 |
| Phase 3（治理） | 权限控制（最大子 session 数、防递归 spawn）+ 侧栏分组/过滤 + 子 session 操作富 UI | 生产级健壮性 |

**Phase 1 改动范围**：
- 新增：`extensions/session-manager/`（extension 项目，包名 `@zhushanwen/pi-session-manager`）
- 修改：`packages/runtime/src/infra/pi/event-adapter.ts`（~25 行，marker 检测分支）
- 修改：`packages/runtime/src/services/session/types.ts`（~3 行，`PiTranslatedEvent` 联合新增 `session-manager-request` kind——bridge-ui/extension-ui 同层）
- 修改：`packages/runtime/src/services/session/event-interpreter.ts`（~5 行，新 case + opts 类型）
- 新增：`packages/runtime/src/services/session/session-manager-handler.ts`（~150 行，含 `broadcastSessionList` opts 注入）
- 修改：组合根（interpreter opts 接线 `onSessionManagerRequest`，参照 `onBridgeUIRequest` 注入点 index.ts:267，fire-and-forget 不 await）
- 修改：`packages/shared/src/session.ts`（~5 行，SessionSummary 扩展）
- 修改：`packages/runtime/src/services/session/session-lifecycle.ts`（~10 行，options 扩展）
- 修改：`packages/extension-protocol/src/`（新增 `extensions/session-manager/marker.ts`：`SESSION_MANAGER_MARKER` 常量 + 请求/结果 schema 类型——`ASK_USER_MARKER` 同款位置 marker.ts）
- 修改：`packages/shared/src/mandatory-extensions.json`（若纳入 builtin 打包清单，Phase 1 末决定）

**Phase 2 改动范围**：
- 修改：`packages/runtime/src/infra/pi/session-file-utils.ts`（~60 行，`persistSpawnSidecar` + `scanSessionMeta` 提取）
- 修改：`packages/runtime/src/services/session/session-scanner.ts`（~5 行，透传）
- 修改：`packages/renderer/.../SessionItem.vue`（~15 行，badge）+ 父子导航入口

## 9. 下一层拆分

**本章结论：拆成 9 个下一层单元，按 Phase 1 → Phase 2 顺序交付。**

### Phase 1 拆分

| 单元 | 说明 | justification |
|------|------|---------------|
| U1: Extension 骨架 | 新建 `extensions/session-manager/` 项目，配置 package.json、tsconfig、工具注册入口 | 基础设施，所有工具的前置 |
| U2: 通道协议定义 | `packages/extension-protocol/src/extensions/session-manager/marker.ts`：marker 常量 + 请求/结果 JSON schema（action 枚举 + 各 action 参数/返回）+ `xyz:session-manager-intent` 审计 entry schema | 跨进程通信契约，extension 和 runtime 的对接点（单一 SSOT，禁两处复制） |
| U3: Runtime 拦截与路由 | event-adapter marker 分支 + interpreter case + 组合根接线 | 通信链路的 runtime 入口 |
| U4: handler + create | `session-manager-handler.ts` 的 create 分支 + lifecycle options 扩展（内存态元数据）+ extension 侧 `create_managed_session` | 核心功能，最先验收 |
| U5: 管理工具集 | handler 的 send/history/status/list/abort 分支 + extension 侧对应 5 个工具 | agent 管理能力 |
| U6: 失败路径 | 超时/中止/非法 JSON 回 cancelled/错误回传/create 部分成功（error 附 sessionId+hint）+ 恢复指引文案 | 可靠性（§4.2 五条失败路径全覆盖） |
| U7: 集成验收 | 按 §7.2 六个场景在真实 xyz-agent 实测（`pnpm dev` + Playwright 连 9222 辅助观察侧栏） | 质量保证 |

### Phase 2 拆分

| 单元 | 说明 | justification |
|------|------|---------------|
| U8: sidecar 持久化 | `persistSpawnSidecar` 三件套 + `scanSessionMeta` 提取 + `scannedToSummary` 透传 | 重启后元数据保留 |
| U9: 前端 badge + 导航 | SessionItem [AI] badge + 右键菜单「查看父 session」 | 用户体验 |

## 10. 待验证检查点

**本轮审查新增的关键检查点排最前——v2 的教训是：通道可行性必须最先验证，否则全部上层设计返工。**

| 检查点 | 验证时机 | 验证方式 |
|--------|---------|---------|
| **select+marker 请求-响应端到端闭环**（最高优先） | U3/U4 实施期首日 | 最小探针：临时 extension 注册一个工具发 `ctx.ui.select(MARKER, ...)`，runtime event-adapter 加分支直接 `sendExtensionUiResponse(id, JSON.stringify({ok:true}), 'select')`，实测工具内 `await` 是否拿到 `{ok:true}`；测量端到端延迟（预期 <1s） |
| marker 请求不触发前端对话框（含 malformed 路径） | U3 实施期 | 发起正常 marker 请求观察 renderer：无 `extension.ui_request` WS 帧、无弹窗；再构造非法 JSON 请求（手改 extension 发非 JSON options[0]），验证走 `__malformed__` 分支回 cancelled、同样不弹前端 |
| handler create 后侧栏广播生效 | U4 实施期 | agent 调 `create_managed_session`，监听 WS `config.sessions` 帧确认新 session 出现在广播 groups 中（广播经 opts 注入回调触发，非 create 内建） |
| 大 payload 经 select value 回传 | U5 实施期 | `read_session_history` 读取 50+ turn 的真实 session（数十 KB JSON），验证传输与解析稳定、耗时可接受 |
| create 返回后立即 sendMessage 的就绪时序 | U4 实施期 | create + sendMessage 连续调用，验证不丢首条消息；失败则在 handler 内加短重试（200ms × 3） |
| `xyz:session-manager-intent` custom entry 的 reload 渲染安全 | U2/U7 实施期 | live 不可见已由代码预判（白名单 noop，event-adapter.ts:907-917，非待验证）；实测关闭重开父 session，确认未知 customType 不破坏 reload 渲染（现役 `subagent-identity` entry 已证明 custom entry 渲染路径存在，新 customType 具体表现为折叠显示 or 忽略） |
| sidecar 写入时序（Phase 2） | U8 实施期 | create 流程中确认 `sessionFilePath` 在 handler 执行时已知（`create` 返回的 summary 含路径）；守卫在 pi 延迟写窗口的行为符合预期（跳过 + warn，绝不预创建） |
| 侧栏 config.sessions 广播包含新字段（Phase 2） | U8 实施期 | 创建 agent session 后监听 WS 事件，验证 SessionSummary 含 spawnSource |

## 附录：变更历史

- v1：初稿
- v2：第一轮对抗式审查修正——补充跨进程通信机制（custom entry 桥接），修正 `ensureActive` 不可由 extension 调用的事实，Phase 1 改动范围从"零侵入"修正为"含 event-handler 新增分支"
- v3：第二轮对抗式审查修正（2 Blocker + 4 Major + 6 Minor 全量修复）——
  - **[Blocker] 通信通道整体重设计**：custom entry 桥接被证实回传通路不存在（pi 无 `append_custom_entry` RPC；`getEntries()` 为内存快照无文件 watcher），改为 select+marker 请求-响应骨架（ask-user 现役先例拼接），超时从 30s 调整为 60s，错误路径与成功路径同通道回传；
  - **[Blocker] 撤换"复用 subagent-workflow 已验证模式"论证**：subagent-workflow 的 custom entry 实为单向持久化、其双向通信走自有子进程 stdio，§5.0 对比表按真实通道重做（四方案）；
  - **[Major] Phase 1 改动清单补 event-adapter.ts**：select/custom 事件的 live 过滤与翻译点在 `handleExtensionUIRequest`（:369-560），非 event-interpreter；
  - **[Major] 失败模式 A 重写**：ask_user 在 rpc 模式 subagent 上下文可用（host-mode 透传），真实差异改为结果嵌入/存储隔离/无侧栏条目/无独立生命周期；subagent 机制描述统一为"独立子进程、结果嵌入父 session"（消除"同进程"自相矛盾）；
  - **[Major] 元数据方案重做为 sidecar**：JSONL header 由 pi 写、xyz 无通道（`forkEntryId` 属 fork 整文件重写特殊路径），改为 `.spawn.json` sidecar（`persistHandoffSidecar` 三件套同构），Phase 1 内存态过渡；
  - **[Major] 待验证检查点重排**：通道端到端闭环列为最高优先首日验证项；补"marker 请求不触发前端对话框"、"大 payload 回传"检查点；
  - **[Minor] API 签名全面修正**：`appendEntry(customType, data?)` 在 ExtensionAPI 闭包实例上（非工具 ctx）、`ctx.ui.select`（替代不存在的 `api.getEntries`/`api.getSessionCwd`）、cwd 取 `ctx.cwd`、`getHistory(sessionId)` 无 limit 参数（handler 侧截断）、`get_session_status` 契约对齐实现（去掉拿不到的 tokenCount）；
  - **[Minor] 删除 `seenIds` 死代码**（新通道无轮询，自然消除）；
  - **[Minor] 验收 Phase 对齐**：Phase 1 场景不再以 Phase 2 的 badge 为通过标准；补超时/中止失败路径、重启持久性、reload 渲染安全场景。
- v4：第三轮对抗式审查修正（1 Blocker + 2 Major + 6 Minor，通道选型与 A.5 阻塞风险均裁决通过）——
  - **[Blocker] handler 补侧栏广播触发**：`SessionService` 无 `broadcastSessionList` 方法、`lifecycle.create` 内零广播，手动路径的广播由 transport 层显式调用（session-message-handler.ts:73）——handler 经 opts 注入广播回调（handoff-service 先例），create 成功后触发；§3 引用错误一并修正（session-service.ts:336 的广播在进程退出回调内）；
  - **[Major] marker 检测失败路径重做**：原伪代码 catch 为空会 fall-through 到普通 select 翻译 → 前端弹出无意义对话框（与自述矛盾）；改为检测失败也 return `__malformed__` 专用事件，由 handler 回 `cancelled`（null → `{id,cancelled:true}`，链路已核实），全程不经前端；
  - **[Major] `get_session_status` 的 modelId 字段源修正**：get_state 返回 `model` 对象（无 modelId 字段），handler 从 `model.provider/model.id` 组装 `provider/id`（对齐 switchModel 格式）；
  - **[Minor] Phase 1 清单补 `services/session/types.ts`**（PiTranslatedEvent 联合新增 kind）与 `packages/extension-protocol/src/extensions/session-manager/marker.ts`（marker 常量 SSOT，ASK_USER_MARKER 同位置）；
  - **[Minor] 审计 entry live 可见性边界显式声明**：live 路径白名单 noop（event-adapter.ts:907-917）可从代码预判——操作时不显示、仅 reload 可见，§10 对应项收窄为 reload 渲染安全；
  - **[Minor] 引用行号修正**：NewSessionOptions 实位 core/session-manager.d.ts:13-16；rpc-mode.js fire-and-forget 实位 :644；ctx.cwd 实位 types.d.ts:217；
  - **[补充] §6.2 增加接线方式约束**：interpreter 回调必须 fire-and-forget（onBridgeUIRequest 同款），async handler 不得阻塞同步事件翻译循环。
- v4.1：第四轮审查收敛（0 must-fix）后顺手修复 2 Minor + 2 INFO——
  - marker 值改 `\x00XYZ_SESSION_MANAGER`（对齐 NUL 前缀约定：ASK_USER_MARKER/GUI_WIDGET_MARKER 同款，结构性排除与人类可读 title 碰撞）；
  - broadcast 紧跟 create 成功（先于 sendMessage）——prompt 注入失败不连累侧栏可见性；catch 在 create 已成功时 error 附 sessionId + hint，extension 侧透传 hint，agent 走 send_to_session 补发而非重复 create（§4.2 新增失败 5）；
  - respond 在父 client 不存在时 warn 落日志（原静默丢弃，可观测性缺口）；
  - params schema 校验位置显式指派到 handler 入口（event-adapter 只校验 action 是 string）。
