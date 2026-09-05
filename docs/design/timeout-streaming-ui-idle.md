# streaming UI 超时改 idle 无进展语义 + 配置口接通 + dormant 契约清理（P0-2）

> **一句话结论**：把 chat streaming UI 的 10min 固定墙钟（`DEFAULT_STREAMING_TIMEOUT_MS`）改为**活动刷新的 idle 无进展检测**（`message.*` 帧刷新计时 + `subagent.stream_delta` 旁路桥接刷新，默认阈值 1800s 对齐 keep-alive 30min 先例），配「message.complete 到达时自动恢复误判气泡」的自愈规则与 settings 表单配置口；同时删除 dormant 的 bash timer 契约与 `readStreamingTimeoutMs` 死配置口。

> **层声明**：当前层 = 技术方案；下一层 = 实现任务单元（文件级）。套 doc-structure「可实现的接口/技术方案」行——准则 5（数据流图）/ 6（错误配恢复指引）/ 7（运行时断言附探针）全 P0 最严格档。

## 开篇（SCQA）

- **S（情境）**：xyz-agent 渲染层为每个 assistant turn 的 streaming 气泡挂了一个 10min 超时兜底 timer（`packages/core/src/domain/chat/timers.ts`），到期把该 session 全部 streaming 实体强推终态，防「message.complete 永不到」的 UI 永久卡「生成中」。
- **C（冲突）**：这个 timer 是固定墙钟——`text_delta`/`tool_call` 等任何活动帧都**不刷新**计时，而它的阈值校准依据（源码注释自辩「runtime 5min watchdog 先行、本 timer 只兜底」）经核实**不成立**：runtime 实装的 ping watchdog 是 180s 进程死亡检测，对「进程活着但 turn 无产出」的形态永不触发。于是 >10min 的合法活跃 turn（subagent 编排、长 bash、慢 provider）被 UI 误判死，pi 侧继续烧 token、后续帧与 UI 终态撕裂；且唯一的调节通道 `XYZ_STREAMING_TIMEOUT_MS` 是死配置口，用户无法逃生。
- **Q（问题）**：UI 兜底 timer 应该用什么语义（墙钟 → idle？）、误判后迟到帧怎么恢复、配置口怎么接通、以及同文件里退役未删的 bash timer 契约怎么处置？
- **A（答案）**：idle 无进展检测（帧刷新 + `subagent.stream_delta` 桥接 + 默认 1800s）+ complete 自愈恢复 + settings 表单配置（对齐 worktree timeout 先例）+ 删除 bash timer 整链。本文展开。

---

## 1. 背景：被设计的系统是什么

**chat streaming UI 超时链路是渲染层对流式对话气泡的「防挂死兜底」，本设计重构它的判死语义。**

系统上下文（受众假设：会用 xyz-agent 但不懂内部链路的开发者）：

xyz-agent 是 Electron + Vue 3 的 AI Agent 工作台。用户在聊天框发消息后，runtime（Node 子进程）把 prompt 喂给 pi 子进程，pi 逐事件产出（正文增量、工具调用、思考块……），runtime 翻译成 `message.*` 帧经 WebSocket 广播，renderer 的 chat store（`packages/core/src/domain/chat/`，headless，在 renderer 以 Pinia store 实例化）把这些帧折叠成对话气泡。

- **streaming 实体** = store 里 `status: 'streaming'` 的 assistant 气泡（`message_start` 帧创建、`text_delta` 帧逐块追加正文、`message.complete` 帧定稿）。就是用户看到的那个正在打字的气泡。
- **finalizeSession** = store 的统一收口函数（`store.ts:858`）：把一个 session 内全部 streaming 实体按 reason 映射推终态（`timeout` → `status:'error'` + toolCall `end_not_received`），并清 pendingSend 标志与 timer。例如 pi 进程崩溃时 runtime 广播 `message.error`，前端 handler 调 `finalizeSession(sid,'error',...)`，气泡从「生成中」翻成红色错误态。

本设计覆盖超时普查（`docs/design/timeout-audit-2026-09.md` §1 ❌2 + §2 D 组）登记的 P0-2 及其连带项：streaming 墙钟本体、`readStreamingTimeoutMs` 死配置口、`BASH_TIMEOUT_MS` dormant 契约、`PENDING_SEND_TIMEOUT_MS` 边界论证、renderer re-export 与消费测试的连带清理。

## 2. 设计目标

**改造后，长任务用户不再看到「任务明明在跑却被判死」的撕裂，真挂死流仍能在有限时间内恢复 UI，且阈值用户可调。**

1. **活跃流不误判**（G1）：真实 pi 跑 >10min 的活跃 turn（含 subagent/workflow 编排、长 bash 持续产出），UI 全程保持 streaming，pi 完成后正常定稿——「静默 ≠ 卡死」（ADR-0047）在 UI 层成立。编排期子代理逐字产出经 `subagent.stream_delta` 桥接刷新父 timer，不出现「子面板在打字、父气泡被判死」的自相矛盾。
2. **挂死流有出路 + 误判可自愈**（G2）：`message.complete` 永不到达的挂死流，默认 30min 内 UI 收口并给用户明确恢复指引；若收口是误判（pi 其实活着），pi 完成时 UI 自动恢复为真实终态（内容/usage 完整），不依赖用户重开 session。
3. **阈值用户可调**（G3）：用户经 settings 表单读写 idle 阈值，持久化、新 turn 生效——规则 19「用户显式指定才生效」的逃生门。
4. **死契约清零**（G4）：dormant bash timer 契约与死配置口删除，代码里不再存在「复活即 5min 墙钟误杀正常 bash」的陷阱。

**In-scope**：core chat 域 timer 语义、迟到帧恢复规则、配置链（shared protocol + runtime config-service + renderer settings UI）、dormant 契约删除、连带测试/re-export 清理。
**Out-of-scope**：runtime 侧 ping watchdog 数值调整（180s/120s 属 ADR-0047 域）；`disconnect` finalize 的撕裂恢复（断连有自己的重连对账路径，撕裂形态与 timeout 不同，本轮不动）；compact 300s 双端墙钟（归 Doc 4 `timeout-slow-flow-wallclock.md`）；settled-watchdog 10min（归 Doc 1）；timeout 收口后是否主动 abort pi 进程（见 D7——本轮显式不做，论证见决策）。

## 3. 现状：使用者眼里是什么样的

**现状是「10min 固定墙钟 + 不看活动 + 无法配置」，它把活跃长任务误判成死流，并且源码注释里的校准前提是假的。**

### 3.1 现状的真实样子（取自代码）

判死链路的三个关键片段（file:line 已逐一核实）：

```ts
// packages/core/src/domain/chat/store.ts:69 —— 值定义 + 注释自辩
/**
 * streaming 超时默认值：10min。
 * W6 调整：原 24h 形同虚设。降到 10min 作为 runtime pi watchdog（5min ABORT）之后的
 * 第二道 UI 兜底——runtime watchdog 先检测 pi 卡死并自动 abort（广播 message.error），
 * 前端 streaming 超时只处理 runtime 自身也卡死的极端场景。
 */
export const DEFAULT_STREAMING_TIMEOUT_MS = 600_000 // 10min

// packages/core/src/domain/chat/timers.ts:55-61 —— timer 主体（固定墙钟，无刷新接口）
function armStreamingTimer(sessionId: string): void {
  clearSessionTimer(streamingTimers, sessionId)
  streamingTimers.set(sessionId, setTimeout(() => {
    finalizeSession(sessionId, 'timeout')
    streamingTimers.delete(sessionId)
  }, streamingTimeoutMs))
}

// packages/core/src/domain/chat/effects/registry.ts:308 —— 唯一挂载点（message_start effect 内）
// 挂载 streaming 超时兜底 timer：防 message.complete 永不到的 pi 静默卡死。
armStreamingTimer(sid)
```

全仓 `rg armStreamingTimer`：调用点仅 `registry.ts:267`（解构）与 `:308`（message_start 挂载）。`text_delta`（registry.ts:436）、`tool_call_start/update/end`、`thinking_*` 等 effect 均**不**触碰 timer——turn 一开始计时就定死 10min，之后 pi 再活跃也不刷新（探针 P-A ✅）。

「可配置」宣称 vs 实装（store.ts:240-245）：

```ts
// [D-016] 经 IPC 读主进程 env（非 import.meta.env，Vite 不暴露 XYZ_ 前缀）。
// [w4 归位] IPC 接线经 PlatformPort 注入属另一个 wave（标 TODO @platform-port-wave）。
function readStreamingTimeoutMs(): number {
  // TODO @platform-port-wave: 接 IPC — window.electronAPI?.getStreamingTimeout?.()
  const env = undefined            // ← 恒 undefined
  ...
  return ... : DEFAULT_STREAMING_TIMEOUT_MS  // ← 恒返默认 10min
}
```

配置通道是死口：`env` 硬编码 `undefined`，`XYZ_STREAMING_TIMEOUT_MS` 从未被读取。另经 `rg D-016` 核实：该「D-016」引用的设计文档已不存在（docs/ 下零命中），而编号 D-016 已被 renderer 命令注册表（`stores/command.ts` 的「D-016 物理隔离」）复用——悬空引用 + 编号撞车，随本设计一并清除。

### 3.2 「runtime watchdog 先行」辩护的核实结论：不成立

store.ts:69 注释的校准前提（「runtime 5min watchdog 先检测 pi 卡死并自动 abort，UI timer 只兜底 runtime 自身卡死」）经 runtime 侧全文检索（`rg -i "watchdog|stream_warn|卡死"`）核实为**两重失实**：

1. **数值不符**：runtime 没有任何 5min streaming watchdog。实装的是 ADR-0047 **ping watchdog**（`packages/runtime/src/services/session/event-interpreter.ts:37-41`）：turn 进行中每 60s 向 pi 发 `get_state` 健康探测；连续 2 次失败（120s）广播一次 `message.stream_warn`（仅提示）；连续 3 次失败（**180s**）判 pi 进程真死 → `onSilentAbort`（`runtime/src/index.ts:378`）→ `sessionService.abort` → 终态帧（探针 P-B ✅）。
2. **语义不符（致命）**：ping watchdog 检测的是**进程级死亡**（pi 对 `get_state` 无响应）。对「pi 进程活着、turn 持续产出」的正常长任务，`get_state` 正常应答 → 失败计数清零 → watchdog 永不触发——「先行」根本轮不到它。也就是说：**UI timer 不是第二道兜底，它就是「进程活着」形态下的第一道、也是唯一一道判死线**，而这道线不看活动、10min 到点就杀。zcode 300s 事故（21% 误杀、343s/541s 正常完成的任务被判死、死后继续烧 token，AGENTS.md 规则 19 [HISTORICAL] 案）与此同构，仅量级 2 倍。

### 3.3 怎么出错（真实失败模式）

- **失败模式 A（误判活跃流）**：用户让 agent 跑一个含 subagent 编排的任务，父 turn 持续 >10min（工具调用、增量、编排进度帧不断到达）。timer 到点 → `finalizeSession('timeout')` → 气泡翻红色 error、正在跑的 toolCall 全部标 `end_not_received`。pi 实际还在产出、token 还在烧；后续帧到达时——`text_delta` effect 首行 `if (!isLastAssistantStreaming(...)) return`（registry.ts:438，[D-010 sealed]）**静默丢弃**；`message.complete` 到达时 map 守卫 `m.status !== 'streaming' → return m`（registry.ts:340-341）**不改状态、不回填 usage、不覆盖内容**。终态定格为「error + 截断正文」。真相只在 session JSONL 里——重开 session 才能看到完整结果，违反 AGENTS.md 规则 9「live ≡ reload」不变式（探针 P-C ✅）。
- **失败模式 B（配置死口堵死逃生门）**：用户的长任务工作流稳定超 10min，想调大阈值——`XYZ_STREAMING_TIMEOUT_MS` 是死口，无任何 UI/env 通道，唯一手段是改源码常量重打包。规则 19 的「用户显式指定才生效」逃生门缺失。
- **失败模式 C（dormant 契约复活陷阱）**：`BASH_TIMEOUT_MS=300_000`（timers.ts:15）自 W1 起 zero 调用方（effect-types.ts:53-56 明示退役），但 `armBashTimer/clearBashTimer` 仍在 effect ctx 契约（store.ts:836-837）与 store 公开 API（store.ts:1137-1138）暴露。谁将来顺手接上，>5min 的正常 bash（构建/测试常态）就会被 UI 标 `cancelled:'timeout'` 而 pi 侧 bash 继续跑——又一个 zcode 形态的复活陷阱。

### 3.4 根因 + 物理数据流

**根因：UI 兜底 timer 用「固定墙钟」承担了只有「无进展检测」才能正确承担的职责，且它的校准论证（runtime 先行）建立在对 runtime 机制的错误认知上；配套的配置口半途而废成为死口。**

```
pi 子进程（stdout 事件流）
  │ message_start / text_delta / tool_call_* / thinking_* / message.complete ...
  ▼
runtime EventAdapter（infra/pi/event-adapter.ts：pi 事件 → message.* 帧）
  ▼
runtime EventInterpreter（services/session/event-interpreter.ts）
  ├─ ping watchdog：turn 中每 60s get_state
  │    ├─ 2 次失败(120s) → 广播 message.stream_warn（仅提示，不中断）        ← protocol.ts:938
  │    └─ 3 次失败(180s) → onSilentAbort → sessionService.abort → 终态帧    ← 进程死亡形态
  │      （进程活着但无产出：get_state 成功 → 计数清零 → 永不触发 ★保护盲区）
  ▼
message-bus 广播 → WebSocket → renderer useConnection → useChat（delta 合帧）
  ▼
core store.applyMessageEvent（store.ts:825，message.* 单一入口）
  ├─ effects/registry.ts 按 type 执行副作用
  │    ├─ message_start(:266) → 新建 streaming 气泡 + armStreamingTimer(:308) ★唯一挂载点
  │    ├─ text_delta(:436) → 追加正文（sealed guard：终态后丢弃）★撕裂点①
  │    └─ message.complete(:311) → 定稿 + finalizeSession（终态后 no-op）★撕裂点②
  ├─ timers.ts armStreamingTimer(:55)：600s 固定墙钟，无刷新接口 ★本设计主改造对象
  └─ 到期 → finalizeSession('timeout') → 全部 streaming 实体 status:'error'
       （pi 若仍在产出：后续帧全部被 ①② 吞掉，直到用户重开 session）
```

对照正面范本：`stream_warn`（protocol.ts:938-940）是「无进展检测 + 仅提示不杀流」的标杆——120s 无活动只 WARN，真正杀流交给进程级证据（180s ping 判死）。UI timer 应当对齐这一层次观：**越靠近 UI 越宽容、判死动作越可恢复**。

## 4. 终态：使用者眼里将是什么样的

**改造后：活跃长任务全程不被打断；真挂死 10min 内收口且文案告知「若任务仍在进行会自动恢复」；误判在 pi 完成时自愈；阈值可在设置里调。**

### 4.1 成功路径（活跃长流）

```text
[用户] 帮我跑 review-fix-loop 全仓审查并修复（预计 20min+）
[pi]   turn 开始 → message_start → 气泡 streaming；timer 挂载（idle 1800s）
[pi]   持续产出：tool_call_start/end（review subagent）、tool_call_update（进度）、
       text_delta（阶段总结）…… 每帧刷新 idle 计时 ← ★与现状的差异：活动即刷新
[pi]   sync subagent 步骤运行期：父 session message.* 帧静默，但子代理面板逐字打字
       → subagent.stream_delta 经桥接刷新父 timer ← ★编排期零 message 帧（§5.1 腿②）不误判
[用户] 看到气泡随进度滚动，第 11/20 分钟依然 streaming（现状：10min 处已被误判 error）
[pi]   turn 完成 → message.complete（含权威全文 content + usage）
[UI]   气泡定稿 complete，内容完整（runtime 提取的权威 content 覆盖，registry.ts:331-333）
```

### 4.2 失败路径（挂死流）与误判自愈（带恢复指引）

```text
[场景] pi 进程活着但流挂死（如 LLM 请求黑洞、扩展工具死锁——get_state 仍应答，
       runtime watchdog 不触发，message.complete 永不到）
[T+30min] idle timer 到期 → finalizeSession('timeout')
[UI]     气泡转 error 态，渲染层据 prematureTimeout 标记显示本地化文案：
         「响应超时（30 分钟无任何进展）。若任务仍在后台进行，完成后会自动恢复显示。」
         👉 恢复指引（准则 6）：
           a. 等待：若 pi 实际仍在跑，完成帧到达时本气泡自动恢复为完整终态（见下）
           b. 确认死了就止损：停止按钮 / 切走再切回该 session（reload 从 session JSONL
              对账出权威状态）
           c. 反复出现 → 设置里调大 idle 阈值（见 4.3）

[自愈续] 若超时是误判（pi 活着，只是 >30min 无帧）——
[T+32min] pi 完成 → message.complete（stopReason:'end_turn'——STOP_REASON_MAP 映射后实装值，r2 复审 MF-2 修正，含权威 content/usage）到达
[UI]     恢复规则命中：prematureTimeout 标记的气泡 → status:'complete'、
         内容以权威 content 覆盖、usage 回填、标记清除 ← ★撕裂修复
         （迟到 tool_call_end 此前已把 end_not_received 覆盖为 completed——现有行为，探针 P-D）
```

配置错误路径：settings 表单输入超范围（<60s 或 >3600s，对齐 D3 单一权威口径 60–3600s——r2 复审 MF-3 修正 v1 残留 7200s）→ 表单校验红字提示合法域，保存被拒（不会把运行中会话调坏）。

**恢复窗口内用户操作矩阵（v1.1，四行为各自结果）**：① 重发消息 → runtime busy 预检拒绝（`send.rejected{reason:'busy'}`）或入队（pi 队列跨 abort 存活）——turn 末自愈照常，排队消息照常投递；② 点停止 → abort 链 → complete{stopReason:'aborted'} → 恢复映射命中，气泡定 complete 终态（status:'complete'，registry.ts:348 实装；r3 复审 SG-2 措辞对齐）+ 清标；③ 切走再切回 → store 单例状态保留，恢复逻辑照常；④ reload → 标记是 live 态不持久化，reload 从 session JSONL 重建权威状态，无撕裂（规则 9）。

### 4.3 配置形态（使用者视角）

设置页新增「对话流式空闲超时」数字输入（单位分钟，合法域 1–60、默认 30——D3 单一权威口径，r2 复审 MF-3 修正 v1 残留 1–120），形态对齐既有「worktree 创建超时」输入域（`packages/renderer/src/components/settings/worktree/WorktreePage.vue` template :88-94 / script :161-194 / `config.setTimeout` 先例，r2 复审 SG-4 补全路径）：保存 → `config.setStreamingIdleTimeout` RPC → runtime 持久化到 settings.json → 对新开始的 turn 生效（进行中 turn 不受影响，对齐 LLM retry 配置「保存后新会话生效」先例）。

## 5. 方案对比与关键决策

**六个决策：D1 判死语义改 idle（核心）、D2 迟到帧自愈恢复、D3 配置走 settings RPC、D4 删除 bash timer 契约、D5 保留 pendingSend 30s、D6 timeout 不联动 abort、D7 stream_warn 排除刷新。**

### 5.1 D1：刷新语义——纯活动刷新（idle 无进展检测）（选定）

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **(a) 纯活动刷新：任何 `message.*` 帧刷新，到期=「N 分钟零帧」**（选） | 与规则 19 认可形态一致（无进展检测）；与 keep-alive 30min 无进展、stream_warn 120s 提示同族；误判面收敛到「>阈值且零帧」 | 低：timers.ts 加 refresh + store 单点挂载 + 测试改写 | 阈值内零帧的合法静默（见 P-F）会误判——由 D2 自愈 + D3 可调兜底 | ✅ |
| (b) 活动刷新 + 宽绝对上界 opt-in（防「永远有微活动但永不完成」） | 双阈值两套语义，绝对上界仍是墙钟（规则 19 反模式），与「UI 兜底」层次观冲突 | 中：双 timer + 两套测试 | 绝对上界本身会误杀慢而活跃的流；为臆想敌（永动微活动流）加机制，违反准则 8 减法 | ❌ |
| (c) 删除 UI timer，完全依赖 runtime 帧通知 | runtime 侧需先补「进程活但 turn 挂起」检测（ping 盲区），跨层扩 scope；UI 失去最后兜底（runtime 自身卡死时无人救 UI） | 高（runtime 新机制） | 保护倒退：本设计 §3.2 核实的盲区（进程活+零帧）在 runtime 侧无 owner | ❌ |

**刷新规则细节**：挂载点不变（message_start）；新增 `refreshStreamingTimer(sid)`——实现为「当前有 timer 才清+重挂，无 timer 则 no-op」（迟到帧在 finalize 后到达时 timer 已清，天然不复活，by construction）。刷新挂在 `store.applyMessageEvent` 单一入口（所有 message.* 帧必经，core headless 可测），排除清单唯一成员 `message.stream_warn`（它本身是「无活动」断言，刷新它等于给挂死流续命）。**编排期旁路桥接（v1.1 新增，r2 复审 MF-1 重写接线）**：sync subagent/workflow 步骤运行期父 session 的 `message.*` 帧按构造为零（生产端 `subagent-tool.ts` `executeSubagent` 显式不消费 `_onUpdate`——注释原话「保留以兼容 SDK 回调签名，但不消费」；registry.ts:559 讲的是 `tool_execution_end` 的结束快照非进度帧），真实活跃信号走 `subagent.stream_delta` 旁路（stream-sink → event-adapter:419-425 → interpreter 广播，renderer 由 stores/subagent.ts 消费，不经 chat `applyMessageEvent`）。桥接接线（对齐实装包边界，r2 复审核正；r3 复审 MF-2 补实施锚点）：**桥接挂 core 入站分发单点 routeInbound 的 FALLBACK 路径（`packages/core/src/coordination/route-inbound.ts`，经 ConnectionPorts.effects 端口注入回调——useMessageEffects 是现成范本；r4 复审实装验证：该帧不在 ROUTE_TABLE/CROSS_SESSION_TYPES → 恒落 FALLBACK，帧与 sid 在挂载点完全可见，pending 分流与 seq gap 均不拦截）**。**⚠️ 不能类比 message.* 帧走 api/events.ts 的 session 通道订阅**（r3 复审 MF-2 修正 v1.2 类比：该通道按帧内 sessionId 路由，tee 帧 sid = 动态虚拟 id，`on(主sid)` 订阅对 tee 主流通道帧不可达且静默无报错——照类比实施桥接失效、S1 编排段误判照旧）；桥接在 routeInbound 侧收 `subagent.stream_delta` 帧后经 effects 端口调 core action `refreshStreamingTimer(父sid)`。**父 session 解析 = 纯字符串函数，零失败模式**：帧 payload.sessionId 经 `isSubagentVirtualId` 判别——虚拟分区 id 是三段式 `subagent:<mainSessionId>:<subagentId>`（stores/subagent.ts:20），shared 包现成 `extractMainSessionId`（:37 re-export）提取父 session；**双通道两形态兼容**：tee 通道带虚拟 id、旧 widget 通道 payload.sessionId = 主 sid（stores/subagent.ts:271-274 双键订阅注释）——主 sid 原样即父；两形态归一为父 sid 后 refresh（v1.1 的「经 subagent store record 索引解析、映射不可得 no-op」删除——record 索引跨包不可达（stores 互不 import 铁律）且引入「records 未加载即失效」的人为失败模式）。反例消灭：「subagent 面板逐字打字、父气泡同时被判无进展」在桥接后不可再现。

**阈值取值论证（默认 1800s，v1.1 重裁定）**：① 层次对齐——runtime 进程死亡判死 180s、stream_warn 提示 120s，UI 是最后兜底必须更宽：1800s = 10× 进程判死、15× 提示阈值；② **构造性零帧窗口覆盖（审查 MF1 修复，替换 v1 失实论据；r2 复审 SG-1 补长尾披露与口径声明）**：sync subagent/workflow 步骤按构造 message.* 零帧，且桥接未覆盖的残余静默窗真实存在——非 subagent 长工具执行（如无输出的长 bash：tool_call_start 后到 end 前零 message.* 帧、无 stream_delta——bash 工具开始时发一次空 onUpdate（pi 0.84.4 bash.js:286-288）算一次刷新，其后真零帧；r3 复审 SG-3 字面精确化）。subagent-core 自家数据：单 turn 经验值约 5min、keep-alive 窗口 P50=24.5min——600s 默认必周期性误判。**长尾披露（P-T2 报告完整数据）**：同报告 `packages/subagent-core/probe/p-t2-report.md` :35 载「96.6% 样本（86/89）窗口超过 30min」（P95≈71.6min 数据点在 :24，r3 复审 SG-3 引文精化），:46 结论原话「30min 作为默认值在本分布上不成立（P50 即触线）」——但该口径是 keep-alive **窗口时长**（无 stdout 进展的连续窗），≠ 本设计 idle **零帧静默窗**：窗口内 stdout 活动、且 sync 编排主流形态由 stream_delta 桥接刷新（零帧前提不成立）、keep-alive 自身 fire 时复核存活后代——P-T2 对「固定 30min 无进展窗」的否定不适用于「桥接覆盖主流 + 1800s 只兜桥接外残余」的 idle 语义；残余长尾（>30min 全静默且无桥接）由 D2 自愈兜底 + D3 可调 + P-F 探针定论；③ 历史锚点——W6 测试 rationale 接受的「10min 合理上限」是墙钟语义下的值，idle 语义下重解释为「零帧时长」并按 ② 上调。用户侧再由 D3 提供调节。

**被否若用（反演）**：选 (b) → §4.1 的 20min 活跃流虽不被 idle 误杀，但绝对上界若设小时级以下仍会在某刻强杀；两套阈值还让「为什么既刷新又有上限」成为永久解释成本。选 (c) → §4.2 的挂死场景（进程活+零帧）UI 永久卡「生成中」——恰是 timer 当年初设要防的场景（24h 形同虚设的教训）。

- **采用**：见上（活动刷新 + stream_delta 桥接 + 默认 1800s + stream_warn 除外 + refresh 仅在 timer 存活时生效）。
- **被否**：(b) 双阈值、(c) 删除 timer——理由见表；**维持 600s 默认不桥接（v1 形态）——击穿反例（审查 MF1/MF2）**：sync 编排步骤 >600s 时「subagent 面板在打字、父气泡被判 error」的自相矛盾误判（构造性零帧 + P50 24.5min 步长），靠 D2 自愈兜底 = 把周期性误判常态化。
- **证据**：registry.ts:308 唯一挂载（P-A ✅）；runtime watchdog 语义盲区（P-B ✅）；keep-alive 无进展先例（`packages/subagent-core/src/execution/session-runner.ts:181-201`，30min stdout 刷新 + 复核）；stream_warn 不杀流先例（protocol.ts:938-940，P-E ✅）。
- **效果**：G1（活跃流不误判）由构造成立；G2 的「挂死有出路」半边成立。

### 5.2 D2：误判终态撕裂的恢复——timeout 打标 + message.complete 自愈（选定）

- **采用**：① `finalizeMessages` 在 reason==='timeout' 时给被收口的 assistant 消息打 `prematureTimeout: true` 标记（Message 新可选字段；同时保持现状不写 errorText——超时文案由 renderer 据标记渲染本地化文本，core 保持 headless）；② `message.complete` handler 新增恢复分支：**谓词（r2 复审 SG-3 措辞对齐实装帧形态——complete 帧不携带实体 id）= 「complete 帧到达（按 session 路由）∧ 打标 id 快照非空 ∧ 目标实体仍处 timeout error 态」**；命中的气泡按 stopReason 定真实终态（**全集映射对齐实装帧值域（r2 复审 MF-2 修正——STOP_REASON_MAP event-adapter.ts:66-77 映射后值域为 end_turn/max_tokens/tool_use/error/aborted/content_filter，pi raw 'stop' 已被映射为 'end_turn'，v1.1 的 'stop' 键在实装中不存在、正常完成永不命中）**：`end_turn / max_tokens / tool_use / content_filter → complete`（+末位气泡 runtime 权威 content 覆盖 + usage 回填 + 清标）/ `error → error+errorMessage` / `aborted → complete 终态 + 清标`（用户主动停，非误判场景但标记需清；abort 路径 complete 无权威 content——registry.ts:345，P-G 降级登记））；③ 迟到 `text_delta`/`thinking_*` 维持 [D-010 sealed] 丢弃不变（内容由 ② 的权威覆盖自足恢复）；④ 迟到 `tool_call_end` 的 `end_not_received → completed` 覆盖是既有行为，随 ② 一起被场景验收覆盖。
- **标记生命周期规格（v1.1 补全，审查 MF3 修复）**：
  - **恢复目标定位**：打标时记录被收口实体的 id 集（finalizeMessages 现场 snapshot），恢复只作用于该 id 集内、且仍处 timeout error 态的实体——不按「session 内存在标记」盲匹配。
  - **清除时机全集**：① 恢复命中（complete 到达且 id 命中）；② 该 session 任一非 timeout 的 finalizeSession（真实终态覆盖后标记失效）；③ 该 session 下一条 `message_start` 到达（新 turn 开始，旧 turn 标记作废——防跨 turn 错配）；④ `resetTransientStates`（disconnect 断连清理）。
  - **反例重演（v1 → v1.1）**：「turn A 超时打标 → complete 迟到 → 恢复 A、清标」✓；「turn A 超时打标 → pi 真挂死 complete 永不到 → 用户发新 prompt → turn B 的 message_start 到达 → 清 A 标（时机③）→ turn B complete 不命中任何标记，无误恢复」✓（v1 反例「旧气泡被新 turn 权威 content 覆盖」被时机③消灭）；「turn A 打标 → 用户点停止 → complete{aborted} → 全集映射命中 → 气泡定 complete 终态（status:'complete'）+ 清标」✓（v1 缺 aborted 映射的滞留反例被消灭）。
- **被否**：解除 D-010 sealed 放行迟到 delta——sealed 是「终态后实体不再变」的构造性不变式（防乱序/重复帧把 error 气泡改回中间态），为恢复破例引入「哪些迟到帧可放行」的新语义泥潭；不做恢复依赖用户 reload——违反规则 9「live ≡ reload」（reload 能看到的完整性，live 期也应收敛到）。
- **证据**：迟到 delta 丢弃（registry.ts:438-440，P-C ✅）；complete 对终态气泡 no-op（registry.ts:340-354，P-C ✅）；complete 帧携带权威全文（registry.ts:331-333 注释：runtime 从 agent_end 提取完整 content——P-D ✅ 注释级 + S3 场景实跑复核）；tool_call_end 迟到覆盖（store-types.ts:28-33 映射注释，S3 一并验）。
- **效果**：G2「误判可自愈」成立：误判代价从「用户重开 session」降为「气泡短暂显示超时文案后自动恢复」。false positive 从不可逆伤害变成可逆瞬态——这也是 D6（不联动 abort）成立的前提。

**已知限制（诚实登记）**：误判期间到达的 `tool_call_start` 仍被 sealed 丢弃，其 `tool_call_end` 无 owner 也被丢弃——该工具在 live 期不可见，reload 自愈（与现状等价，不因本设计恶化；live≡reload 的该残角属 apply-entry 对账层议题，out-of-scope）。

### 5.3 D3：配置口——settings 表单 config.* RPC（选定）

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **(a) settings 表单 + `config.setStreamingIdleTimeout` RPC**（选） | 用户可发现、per-user 持久化；端到端复用 worktree timeout 全链先例（protocol.ts:550-553 → config-service 持久化 → 表单输入域）；可测试 | 中：protocol 两条 + config-service handler + settings UI + store 注水 action | 无结构性风险；链路长是先例固有成本 | ✅ |
| (b) 接通原死口 `XYZ_STREAMING_TIMEOUT_MS` env（IPC 读主进程 env） | env 是机器级配置，打包应用用户不可发现、不可持久化 per-user；D-016 悬空引用要另接 preload/IPC 面 | 低（接通 TODO 即可） | 维持「宣称可配置实则靠 env」的隐性配置面；与 settings 体系并立成两源 | ❌ |
| (c) 两者都要 | 双源需定义优先级/覆盖规则，新增长期解释成本 | 高 | 两源漂移（env 改了 UI 显示不同步）| ❌ |

- **采用**：(a)。协议形态对齐先例：`config.setStreamingIdleTimeout {timeout: 秒}` / `config.getStreamingIdleTimeout` → reply；runtime 持久化 settings.json；**默认 1800s、合法域 clamp 60–3600s（1–60min）——单一权威口径（r2 复审 MF-3 定案，本文其余处引用此处；v1 残留 600s 已清）**。生效时机=下一次 arm（新 turn / 新 message_start），进行中 turn 不变。store 侧：删 `readStreamingTimeoutMs` 死口，改为 store action `setStreamingIdleTimeoutMs(ms)`（app 启动时 renderer 经 `config.getStreamingIdleTimeout` 水合），`armStreamingTimer`/refresh 在挂载时读当前值。同时清除 store.ts:233-234/361 的悬空 D-016 注释（编号已被 command 注册表合法复用，防误导）。
- **被否**：(b)/(c)——见表；核心论据是**可发现性**：这个阈值的用户是「任务总被 10min 卡断」的终端用户，不是运维。
- **证据**：worktree timeout 先例（protocol.ts:122 命令族 + :550-553 payload + `packages/renderer/src/api/domains/settings.ts:98-103` renderer API + WorktreePage.vue template :88-94 / script :161-194 输入域）；LLM retry「保存后新会话生效」先例（rend-ui 报告 SystemLlmRetrySection）；死口现状（§3.1）。
- **效果**：G3 成立；§4.3 终态形态落地。

**被否若用**：选 (b) → §3.2 失败模式 B 的用户（打包应用、无 shell）依然无逃生门——死口从「没接线」变成「接了但没人找得到」。

### 5.4 D4：BASH_TIMEOUT_MS dormant 契约——删除整链（选定）

- **采用**：删除 bash timer 整链：`BASH_TIMEOUT_MS`（timers.ts:15）、`armBashTimer`/`clearBashTimer`（timers.ts:71-100 区段 + bashTimers Map）、`finalizeBashOnly`（store.ts:872——唯一调用方就是被删的 bash timer 回调）、effect ctx 契约（effect-types.ts:53-60）、store 公开 API 导出（store.ts:1137-1138）；连带收窄 `markBashError` 签名（store.ts:1154 传入的 `clearBashTimer` 参数移除）。**保留**：`markBashError`（bash 错误路径 live 调用，store.ts:1154）、`findLastStreamingBashIndex`（其依赖）。测试同步改写（timers.test.ts / effects.test.ts / chat-bash-effects.test.ts / chat-chunk-content-blocks.test.ts 中 armBashTimer 用例删除）。
- **被否**：① 保留契约「以防万一」——dormant + 公开暴露 = 审计原话「复活即量级错配」（>5min 正常 bash 被 UI 标 timeout 而 pi 侧继续跑）；② 复活并改小时级——当前无任何调用场景，为臆想需求写代码且小时级墙钟仍违规则 19。真有需求时按 idle 语义重造，git 历史可考。
- **证据**：退役标注（effect-types.ts:53-56「armBashTimer 当前无 effect 调用方」）；`finalizeBashOnly` 调用点全查仅 initTimers 注入（store.ts:939）；「手动注入 streaming bash 消息的种子场景」仅存在于测试（生产代码 W1 后无构造方，bash-effects.ts:11-14 自述 ephemeral + 完成态 entry 两段式）。
- **效果**：G4 成立；准则 8 减法——删掉的是纯负债（无行为变化，回归测试守卫）。

### 5.5 D5：PENDING_SEND_TIMEOUT_MS=30s 保留（选定）

- **采用**：保留不动。
- **被否**：调整/删除——无必要。
- **证据**：store.ts:365 定义 + :921 挂载；core-shared 审计判定 ✅（边界）：该 timer 只清「send 乐观插入 → message_start 确认」空窗标志，触发时无 streaming 实体可杀（`finalizeSession` 此时效果=仅清标志），busy 场景已被 `send.rejected` 前置拦截，极端慢首 token（>30s）的损害=标志提前消失，pi 侧任务不受影响。
- **效果**：控制面秒级 + 无实体伤害，符合规则 19 粒度校准；本设计不改其行为。

### 5.6 D6：idle 收口不联动 abort pi（选定）

- **采用**：idle 到期只做 UI 收口（finalizeSession('timeout') + 打标），**不**主动向 runtime 发 abort。
- **被否**：finalize 时联动 best-effort abort——两个理由：① 误判不可逆化：D1 语义下误判窗口收敛但非零（桥接遗漏的残余静默窗），一旦 abort 就亲手杀掉健康长 turn，把「可自愈瞬态」变回「zcode 式不可逆误杀」；② 真挂死场景收益有限且分形态（v1.1 限定）：工具死锁/进程挂起类挂死不烧 token（无生成），abort 只省一个空闲进程；**LLM 黑洞形态**请求已发出，provider 侧可能继续产 token 计费（量级有界于单响应 max_tokens，abort 取消 HTTP 请求有机会止损）——但为保误判可逆性（论据①）仍不联动，黑洞计费有界代价 < 误杀健康 turn 不可逆代价。
- **证据**：zcode 教训（审计总报告 §0：误杀后 app-server 继续烧 token 的前提是**仍在执行**——D1 已消灭「执行中被误杀」）；§4.2 恢复指引 b（用户确认死了可手动停止——人工确认补上自动 abort 缺的判断力）。
- **效果**：D2 自愈闭环成立的前提；误判零不可逆伤害。

### 5.7 D7：stream_warn 排除刷新 + 其他边界（随 D1 落定）

- **采用**：`message.stream_warn` 不刷新 idle 计时（它是「120s 无活动」的断言帧，刷新它=给挂死流续命一轮阈值）；`message.auto_retry_*` **参与**刷新（重试是受 maxRetries 约束的有界活动，pi 活着且在推进）；`message.complete/error/stream_error` 等终态帧无需关心（finalize 路径本就清 timer）。
- **被否**：全帧无差别刷新——实现最简但语义含混（warn 续命），排除清单是单行成本换语义正确。
- **证据**：stream_warn 前端仅追加提示气泡不 finalize（registry.ts:425-433，P-E ✅）；auto_retry 有界（core-shared 审计 llm-retry：pi 默认 maxRetries=3）。
- **效果**：D1 刷新语义完整自洽；验收 S5 反向验证。

## 6. 实现机制（文件级改动地图）

**改动分三簇：core 判死语义簇（M1/M2）、配置链簇（M3）、清理簇（M2/M4）——各簇可独立合入与回归。**

| 文件 | 改动 |
|---|---|
| `packages/core/src/domain/chat/timers.ts` | `armStreamingTimer` 改为挂载时读当前配置值（注入 getter 而非常量）；新增 `refreshStreamingTimer`（timer 存活才重挂，否则 no-op）；删除 `BASH_TIMEOUT_MS`/`armBashTimer`/`clearBashTimer`/bashTimers Map |
| core 入站分发层（`packages/core/src/coordination/route-inbound.ts`——在 core 包非 renderer，r4 复审 INFO 修正行名路径定位；useMessageEffects 同簇范本，r3 复审 MF-2 补行） | `subagent.stream_delta` 桥接挂载（InboundEffects 回调，FALLBACK 路径收帧 → isSubagentVirtualId 判别 → extractMainSessionId 解析父 sid（虚拟 id）/主 sid 原样（旧 widget 通道）→ 经 ConnectionPorts.effects 调 core `refreshStreamingTimer`；非 subagent 帧 no-op） |
| `packages/core/src/domain/chat/store.ts` | `applyMessageEvent` 入口挂 refresh（排除 stream_warn）+ 新增 `refreshStreamingTimer` action（供 renderer 装配层桥接调用——stream_delta 帧监听在装配层，父 sid 解析用 shared 纯函数 isSubagentVirtualId/extractMainSessionId，r2 复审 MF-1 重写）；删 `readStreamingTimeoutMs` + 悬空 D-016 注释；`STREAMING_TIMEOUT_MS` 常量改由可变配置源（`setStreamingIdleTimeoutMs` action，默认 `DEFAULT_STREAMING_IDLE_TIMEOUT_MS=1800_000`——常量更名以名实相符）；删 `finalizeBashOnly`、ctx 与导出中的 `armBashTimer`/`clearBashTimer`；`markBashError` 调用收窄 |
| `packages/core/src/domain/chat/streaming-state-machine.ts` | `finalizeMessages`：reason==='timeout' 时写 `prematureTimeout: true`（不写 errorText，维持现状） |
| `packages/core/src/domain/chat/effects/registry.ts` | `message.complete` handler 新增恢复分支（§5.2 ②） |
| `packages/core/src/domain/chat/store-types.ts`（Message 类型） | 新增 `prematureTimeout?: boolean` 可选字段（类型 + 注释锚定本 doc） |
| `packages/core/src/domain/chat/effect-types.ts` | 删 `armBashTimer`/`clearBashTimer` ctx 契约及退役注释 |
| `packages/core/src/domain/chat/bash-effects.ts` | `markBashError` 签名收窄（移除 clearBashTimer 参数） |
| `packages/core/src/domain/chat/index.ts` + `packages/renderer/src/stores/chat.ts:30` | 常量改名 re-export 同步（`DEFAULT_STREAMING_IDLE_TIMEOUT_MS`） |
| `packages/shared/src/protocol.ts` | 新增 `'config.setStreamingIdleTimeout'`/`'config.getStreamingIdleTimeout'` 命令 + payload/reply 类型（秒） |
| `packages/runtime/src/services/config-service.ts` | handler + settings.json 持久化（对齐 worktree timeout 模式） |
| renderer settings 页 + 水合 wiring | 表单输入域（1–60min）；app 启动 `config.getStreamingIdleTimeout` → `store.setStreamingIdleTimeoutMs` |
| renderer 消息渲染组件 | `status==='error' && prematureTimeout` → 本地化超时文案（含「完成后自动恢复」提示） |

接口契约（下一层的边界，r3 复审 SG-1 对齐）：`refreshStreamingTimer(sid): void`（无 timer 时 no-op 语义）；`setStreamingIdleTimeoutMs(ms): void`（非法值 clamp + warn）；stream_delta 桥接挂载 = **InboundEffects 回调形态**（`onSubagentStreamDelta?(frame): void`——经 ConnectionPorts.effects 端口在 routeInbound FALLBACK 路径调用；r4 复审 SG 修正：v1.1 的 `attachSubagentStreamBridge(unregister)` 签名是 events.on 监听形态残留，与 routeInbound/effects 端口锚点错配；非 subagent 帧 no-op——解析是纯字符串函数无「解析失败」形态）；恢复规则的触发谓词 =「complete 帧到达（按 session 路由）∧ 打标 id 快照非空 ∧ 目标实体仍处 timeout error 态」（与 D2 一致——complete 帧不携带实体 id）。

## 7. 验收（真实场景，非单测非 mock）

**改动规模：大（行为变更 + 新配置接口 + 契约删除），五场景真实验收 + 一负面反向验证；单测仅作回归辅助。**

| # | 场景 | 回溯 §2 目标 | 真实流程/数据/路径 | 通过标准 |
|---|---|---|---|---|
| S1 | 长活跃流不判死 | G1 | dev 模式（`pnpm dev` + Playwright 连 9222）跑真实 pi：派一个含 subagent 编排的任务（如 review-fix-loop 或多文件重构）使 turn >10min；覆盖两种帧形态：① delta/工具帧持续段，② sync subagent 长步骤（父 session message.* 构造性零帧、subagent 面板在打字）段 | 全程气泡 streaming 不出现 timeout error（含编排零帧段——桥接刷新生效）；pi 完成后气泡 complete、内容/usage 完整；对照现状（M1 前同任务 10min 处被误判）|
| S2 | 挂死流收口 + 恢复指引 | G2 | 真实 pi 起一个 turn，用代理黑洞/断点手段挂起 LLM 响应（进程保持存活、get_state 可应答——复现 ping 盲区），不投递任何帧 | 30min 内气泡收口为带超时文案的 error 态；文案含「若任务仍在进行会自动恢复」与具体恢复动作；单测 fake-timer 版另守卫 timer 精度 |
| S3 | 误判自愈 | G2 | 配置阈值临时调至 60s（走 D3 配置口），跑一个 2–3min 且中段 >60s 全刷新源静默的任务制造受控误判——**手段（r2 复审 MF-4 修正）：非 subagent 的无输出长工具（如 `sleep 90` bash：tool_call_start 后到 end 前零 message.* 帧（工具开始时一次空 onUpdate 算一次刷新，其后真零帧——与 §5.1 腿② 同口径，r4 复审 SG 同步精确化）、无 stream_delta——D1 腿② 自己点名的桥接外残余静默窗；v1.1 的「sync subagent 长步骤」手段不可达——该形态恰被桥接刷新保护，S1 同场景通过标准就是它不误判）**；等 bash 工具真实完成、turn 结束；另验跨 turn 反例：误判后发新 prompt | complete 帧到达后气泡自动恢复 complete、权威 content 覆盖截断正文、usage 回填、prematureTimeout 清除；迟到 tool_call_end 已把 toolCall 覆盖为 completed（P-D 场景实跑）；新 turn 的 message_start 清旧标、其 complete 不恢复旧气泡（时机③） |
| S4 | 配置生效且持久 | G3 | settings 表单改阈值（如 5min）→ 保存 → 新 turn 触发 arm；重启应用后再查 | 新 turn 按新值计时（fake-timer 单测断言 arm 值 + 真实 UI 验证表单回显）；重启后值保留（settings.json）；超范围输入被表单拒绝 |
| S5 | 负面：warn 不刷新不收口 | G1/D7 | 真实 pi turn 中 SIGSTOP pi 进程 ~120-140s 后 SIGCONT 恢复（ping 探测的是 pi 进程对 get_state 的应答，须使 pi 进程本身无响应；窗口须在第 3 次失败 180s 判死红线前恢复，否则 onSilentAbort 终态化、场景报废）→ stream_warn 到达 | 气泡仍 streaming（warn 只追加提示气泡）；idle 计时**不**被 warn 重置（后续挂死仍在原阈值窗口内收口）|

**依赖说明**：S1/S3 依赖真实 pi 子进程与真实 LLM provider（按 AGENTS.md extension 实测惯例可先用 `--mode rpc` 本地 pi CLI 复现帧序列，再在 dev app 内端到端）；S2 的「进程活+零帧」用网络层手段模拟，不 mock store。每个场景可独立执行——对应 §8 拆分的分阶段验收。

## 8. 下一层拆分（实现任务单元）

**四个里程碑串行交付，每个独立可验可回滚；M1 是风险主修复。**

| 单元 | 说明 | justification（为什么这么拆） |
|---|---|---|
| **M1-U1**：core timer idle 语义 + stream_delta 桥接 | timers.ts refresh/读当前值 + store.applyMessageEvent 挂 refresh（排除 warn）+ **`subagent.stream_delta` 桥接（r2 复审 MF-5 补落位；锚点 = `packages/core/src/coordination/route-inbound.ts` FALLBACK 路径 + ConnectionPorts.effects 端口（r4 复审 SG 点名）——isSubagentVirtualId/extractMainSessionId 纯函数解析父 sid + 双通道兼容，回调 core `refreshStreamingTimer`；桥接用例：虚拟 id/主 sid 两形态解析、非 subagent 帧 no-op）** + 常量改名 + index/chat.ts re-export + 相关测试（chat-streaming-timeout.test.ts 重写为 idle 语义、chat-perf-scan-timer.test.ts、useChat.test.ts 跟改） | ❌2 主修复，行为变更最大、先行合入；S1 整体可验（v1.1 声称「S1 即可独立验收」依赖桥接——桥接与 refresh 同簇落本单元）；常量改名在 M1 做避免 M3 再动一遍 re-export |
| **M1-U2**：complete 自愈恢复 | streaming-state-machine 打标 + Message.prematureTimeout 字段 + registry complete 恢复分支 + 渲染层超时文案 + 恢复用例 | 依赖 U1 的语义（误判窗口缩小后恢复才有「瞬态」性质）但代码正交，可独立回归；S3 验收 |
| **M2-U3**：bash timer 契约删除 | §5.4 清单整链删除 + markBashError 收窄 + 4 个测试文件跟改 | 纯减法零行为变化，独立成 commit 便于回滚定位；不与语义改动混提 |
| **M3-U4**：配置链 | protocol 两条 RPC + config-service 持久化 + settings 表单 + 启动水合 + store action + 死口/悬空 D-016 注释删除 | 依赖 U1 的「读当前值」挂点已就位；S4 验收 |
| **M4-U5**：登记回写与收尾 | 超时审计 SSOT（timeout-audit-2026-09.md）P0-2/D 组条目标记已修；constraints.json 按需登记「UI 流式判死必须 idle 语义」约束（C-proc-10 修复即清账） | 审计驱动流程的闭环纪律；放最后避免设计变更期反复改登记 |

**待验证检查点（设计阶段无法确定，诚实标注）**：

- **P-F（⛔ M1 门；v1.1 性质改写，r2 复审 MF-1 联动重定义）**：sync 编排期父 session message.* 帧构造性为零已源码确认（executeSubagent 不消费 onUpdate），桥接映射是纯字符串解析（isSubagentVirtualId/extractMainSessionId，无「成功率」维度——v1.1 的映射成功率探针随映射机制改写删除）。本探针转为**标定桥接覆盖后的残余零帧长尾**：实测编排任务期间（a）stream_delta 帧到达父 session refresh 的端到端连通（虚拟 id/主 sid 双形态各采样）、（b）全刷新源零帧窗口分布。**降级路径**：桥接连通性异常（帧丢失/形态未覆盖）→ 修桥接（非降阈值问题）；2×P95 零帧窗 > 1800s → 默认阈值上调至 2×P95（若超 D3 clamp 上限 3600s 则同步扩 clamp 合法域——r2 复审 SG-2 补：不扩域则降级值被封顶截断、降级路径不可达）；或编排心跳帧（**必须走 message.* 命名空间**——旁路帧不经 chat store，硬约束）由 subagent-workflow 侧补发，归属与优先级另立任务。
- **P-G（⛔ M1-U2 门）**：S3 场景下权威 content 覆盖链端到端跑通（event-adapter handleAgentEnd 提取 content → complete 帧 → 恢复覆盖）。**降级路径**：若 complete 帧在特定 stopReason 下不带 content → 恢复分支降级为「仅状态/usage 恢复，内容保截断 + 提示重开 session」，不阻塞状态自愈主线。

## 9. 探针清单（运行时断言审计）

| ID | 验证的行为 | 探针 | 状态 | 失败时的降级路径 |
|---|---|---|---|---|
| P-A | armStreamingTimer 唯一挂载点=message_start，delta/tool_call 不刷新 | 全仓 `rg armStreamingTimer`（仅 registry.ts:267/:308 + timers.ts 定义 + store 装配） | ✅ 已核（2026-09-04） | — |
| P-B | runtime 无 5min streaming watchdog；实装 ping 60s×3=180s 判死 + 120s warn，且只覆盖进程死亡形态 | runtime 全文 `rg -i "watchdog\|stream_warn"` + event-interpreter.ts:37-41/index.ts:378 精读 | ✅ 已核 | — |
| P-C | 迟到 delta 被 sealed 丢弃；complete 对终态气泡 no-op（撕裂现状） | registry.ts:438-440 / :340-354 精读 | ✅ 已核 | — |
| P-D | complete 帧携带权威全文 content（恢复内容自足）；tool_call_end 迟到覆盖 end_not_received | registry.ts:331-333 + store-types.ts:28-33 注释级核实 | ✅ 注释级 + ⛔ S3 实跑复核 | S3 见 P-G 降级 |
| P-E | stream_warn 前端不 finalize（仅追加提示气泡） | protocol.ts:938-940 + registry.ts:425-433 精读 | ✅ 已核 | — |
| P-F | 桥接端到端连通（虚拟 id/主 sid 双形态）+ 全刷新源零帧窗分布（r3 复审 MF-1 同步 §8 v1.2 定义——「映射成功率」维度随纯函数解析删除，「回退单一入口+60min」废案清除） | 实测编排任务：stream_delta 帧到父 session refresh 的连通采样（双形态各一）+ 零帧窗分布 | ⛔ M1 前 | 桥接连通异常 → 修桥接（非降阈值）；2×P95 > 1800s → 阈值上调（超 3600s 同步扩 clamp 域）；心跳帧另立任务（见 §8 P-F） |
| P-G | 恢复链端到端（打标→complete→覆盖 content/usage→清标） | S3 场景实跑 | ⛔ M1-U2 前 | 恢复降级为仅状态/usage 恢复 |
| P-H | refresh 的 no-op 语义（finalize 后迟到帧不复活 timer） | 单测：finalize 后投递 delta，断言 timers Map 无新增 | ⛔ M1 单测 | — （构造性 no-op，失败即实现 bug） |

## 附录：变更历史

- v1（2026-09-04）：初版。依据超时普查总报告（timeout-audit-2026-09.md §1 ❌2 / §2 D 组 / §6 映射 Doc 2）与 core-shared、rend-api 两份模块报告撰写；报告所引 file:line 已逐一在实装代码复核（store.ts:69/240-245/363/365、timers.ts:15/55-61、registry.ts:267/308/438、effect-types.ts:53-60、stores/chat.ts:30、protocol.ts:938-940），并完成「runtime 5min watchdog」辩护的证伪（实装 180s ping watchdog、语义盲区，见 §3.2）。
- v1.1（2026-09-04）：第一轮对抗式审查修复（3 MF/4 SG，逐条对应）：
  - MF1+MF2（同根：编排期帧形态认知失实）→ 阈值论证腿②重写（tool_call_update 进度帧论据删除——registry.ts:559 是结束快照、executeSubagent 不消费 onUpdate）；新增 `subagent.stream_delta` 桥接刷新（模块级监听 + record 索引解析父 session，ADR-0049 合规，映射不可得 no-op）；默认阈值 600s→1800s（对齐 keep-alive 30min 先例，覆盖非 subagent 长工具静默窗与 P50 24.5min 编排步长）；反例重演：「子面板打字 + 父气泡判死」桥接后不可再现；「维持 600s 不桥接」记入被否谱系（周期性误判常态化击穿）。G1/§4.1/S1 场景描述与真实帧形态对齐。
  - MF3（标记生命周期）→ D2 补规格四件套：stopReason 全集映射（含 aborted）、清除时机全集（恢复命中/非 timeout finalize/下一条 message_start/resetTransientStates）、恢复目标按打标 id 快照定位、跨 turn 反例重演（「旧气泡被新 turn 权威 content 覆盖」被时机③消灭）；S3 场景补跨 turn 负面验证。
  - S1（D6 论据限定）→ LLM 黑洞形态计费有界性补入、不联动结论不变；S2（S5 验收手段）→ SIGSTOP pi 进程 120-140s + 180s 判死红线；S3（引用漂移）→ settings.ts 加 domains 段/WorktreePage.vue 区间拆分/session-runner.ts 补包路径三处核准修正；S4（恢复窗口操作矩阵）→ §4.2 补重发/停止/切走/reload 四行为结果。
  - 联动同步：正文决策（D1/D2/D6）、终态（§2 G1/G2、§4.1/4.2/4.3）、错误规格（D2 生命周期）、§6 改动地图（store 桥接行/接口契约）、§7 验收（S1/S2/S3/S5）、§8 拆分（P-F）、§9 探针（P-F）全部同步；变更历史本条。
- v1.2（2026-09-05）：**第 2 轮聚焦复审修复**（5 MF/4 SG 全修，报告 .review/timeout-streaming-ui-r2.md；r1 三条 MF 修复方向全部验证成立，但 MF2/MF3 修复产物自身携带新失实，另 v1.1 联动遗漏两处、验收自相矛盾一处）。①MF-1（桥接接线三层失实，P0-11）：「chat 域模块级 event-bus 监听」违反包边界（core chat 域无事件总线，分发器 api/events.ts 在 renderer，「core 零 import renderer」铁律）、「record 索引解析父 session」跨包不可达且不必要——重写为 renderer 装配层监听 + shared 纯函数 isSubagentVirtualId/extractMainSessionId（虚拟 id 三段式自带父 sid，零失败模式）+ 双通道两形态兼容（tee 虚拟 id / 旧 widget 主 sid）；§6 store.ts 行与 P-F 探针同步（映射成功率维度删除，重心移零帧窗分布）；②MF-2（stopReason 映射键 'stop' 不在实装值域）：STOP_REASON_MAP 映射后值域为 end_turn/max_tokens/tool_use/error/aborted/content_filter——映射改为 end_turn/max_tokens/tool_use/content_filter→complete、error→error、aborted→complete+清标；§4.2 场景值 'stop'→'end_turn'；③MF-3（默认值/合法域文档内两说）：D3 定单一权威口径（默认 1800s、clamp 60–3600s），清 §4.2 的 7200s / §4.3 的 1–120 残留；④MF-4（S3 手段与桥接自相矛盾）：「sync subagent 长步骤」制造误判不可达（该形态被桥接保护）——改「非 subagent 无输出长工具（sleep bash）」全刷新源静默形态；⑤MF-5（§8 拆分漏桥接落位）：桥接并入 M1-U1（S1 整体可验）+ 桥接用例；⑥SG-1：阈值论证腿② 补 P-T2 长尾完整披露（96.6%>30min、P95≈71.5min、报告结论原话）+ 口径声明（窗口时长≠零帧窗、桥接覆盖 sync 主流、P-T2 否定不适用 idle 语义）；⑦SG-2：P-F 降级路径补「2×P95 超 3600s 时同步扩 clamp 域」（否则降级值被封顶截断不可达）；⑧SG-3：恢复谓词措辞对齐实装帧形态（complete 帧不带实体 id——「按 session 路由 ∧ 打标快照非空 ∧ 仍处 timeout error 态」）；⑨SG-4：WorktreePage.vue 补全路径。
- v1.3（2026-09-05）：**第 3 轮聚焦复审修复**（2 MF/3 SG 全修，报告 .review/timeout-streaming-ui-r3.md；r2 五条 MF 修复方向全部验证成立——包边界违例清零/映射六值相符/默认值零残留/S3 手段经 pi 0.84.4 bash.js:249-252 实装核实/拆分落位齐备）。①MF-1（§9 P-F 行漏同步）：探针表 P-F 行仍是 v1.1 废案（映射成功率 + 回退单一入口 + 60min 顶格）——同步 §8 v1.2 新定义（连通性采样双形态 + 零帧窗分布 + 修桥接/扩域降级）；②MF-2（桥接实施锚点缺失 + 类比误导）：装配层监听具体化为 routeInbound 入站分发单点（经 ConnectionPorts.effects 端口，useMessageEffects 范本）+ §6 文件地图补 renderer 装配层行；修正「与 message.* 帧同构」类比——api/events.ts session 通道按帧内 sessionId 路由，tee 帧是虚拟 id，on(主sid) 订阅不可达且静默失效；③SG-1：§6 接口契约残留旧谓词（「帧对应实体 id」）与「解析失败 no-op」矛盾清除，对齐 D2 新谓词与纯函数零失败语义；④SG-2：「aborted 终态」两处改 status:'complete'（registry.ts:348 实装）；⑤SG-3：「零帧」字面精确化（bash 开始一次空 onUpdate 后真零帧）+ P95 引文 :24/71.6min 精化。
- v1.4（2026-09-05）：**第 4 轮聚焦复审 0 must-fix / 3 SG / 1 INFO，当轮全修收口**（报告 .review/timeout-streaming-ui-r4.md；四轮收敛 3→5→2→0 MF——r2/r3 的扩张是修复产物精度问题的暴露非方向错误。核心裁决：routeInbound 锚点实装验证通过——use-connection 单槽独占 + 该帧恒落 FALLBACK（不在 ROUTE_TABLE/CROSS_SESSION_TYPES）+ pending 分流与 seq gap 均不拦截，行级证据链完整）。①SG：S3 零帧口径与 §5.1 腿② 同步精确化（空 onUpdate 一帧之差）；②SG：接口契约签名改 InboundEffects 回调形态（`onSubagentStreamDelta`——v1.1 `attachSubagentStreamBridge(unregister)` 是 events.on 监听形态残留，与端口锚点错配）；③SG：M1-U1 点名锚点文件 route-inbound.ts + effects 端口；④INFO：文件地图行名改 core 包路径定位（route-inbound 在 core 非 renderer），§5.1 桥接挂载点表述同步。**设计就绪。**
