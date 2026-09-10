# workflow 域 agent() record 归位（游离 record 进 RecordStore）

> **层声明**：技术方案层设计——当前层 = 方案决策与接口/数据模型规格，下一层 = 可实施的 PR 单元（§5）。
> **前置依赖**：H1（chat 域统一，[subagent-chat-run-unification.md](subagent-chat-run-unification.md)）先行落地——本文档按 H1 终态基线设计；H1 审查修复中的机制细节以最终版为准，本文档仅依赖其方向性决策（record 单一模型 / ConversationContinuation 存在 / 守护单点 arm）。
>
> **一句话结论**：workflow 脚本里的 `agent()` 调用改走与 subagent 工具完全相同的派发路径（SubagentService 统一入口 + RecordStore 注册），删除 pump 的游离 liveRecord 与 runner 的平行引擎接线；可见性按用户裁定 = 进 store 但 GUI 列表默认隐藏（`origin` 标记）；并发与手动 subagent 共享同一池。

---

## 1. 背景目标

### 1.1 SCQA

- **S**：workflow 域是「用户写 JS 脚本编排多子代理」的功能——脚本里 `agent("任务")` 派单个子代理、`parallel()` 并发派多个。脚本本体跑在 worker 子进程，宿主进程侧由 `worker-message-pump.ts`（1295 行）接收 agent() 调用代为执行。
- **C**：pump 为 TUI 实时进度**自建了一套不进 RecordStore 的游离 record**——直接调 `createRecord(String(msg.callId), {mode:"background", …})`（`worker-message-pump.ts:708-717`）挂在 trace 节点的 `live` 字段上、事件经 `updateFromEvent`（`:784-786`）灌入、run 完即清（终态由 trace node.result 承载）；`SubprocessAgentRunner` 另自带一套平行引擎接线（路由/预检/journal 接线/守护，`subprocess-agent-runner.ts`）。后果：execution-record.ts 头注宣称的「唯一创建/更新入口」被绕开；store 的全部服务（持久化、重启恢复、孤儿恢复、对账 sweep、通知底座）对 workflow 子代理不可用——对账 sweep 明确跳过（`reconcile-sweep.ts` 注释「workflow run 不在 RecordStore，其注册对账按 type=workflow 保守跳过」）。
- **Q**：能否让 workflow 里的 agent() 等同一个 subagent？
- **A**：能——统一走 service 派发、record 进 store，进度展示改 store 订阅。用户已三裁定：可见性隐藏 / 进度从 store 订阅 / 并发共享池。

### 1.2 系统是什么（受众认知铺垫）

**RecordStore** 是所有 subagent record 的统一注册表：内存持有 running、终态从 session.jsonl 重建，持久化/恢复/对账/GUI 列表投影都挂在它上面。**AgentRunner** 是 workflow 引擎调用子代理的 port（`orchestration/models/ports.ts`：`run(opts, signal, onEvent?, stream?) → Promise<AgentResult>`），现由 `SubprocessAgentRunner` 实现。**WorkflowRun** 是 workflow 聚合根（含 trace 节点树），持久化在 FileRunStore（JSONL）——run 级状态与 record 级状态是两层，本设计只动后者。

### 1.3 设计目标

- **G1 agent() 等同 subagent**：同一派发路径、同一 record 模型、同一保障（持久化、重启恢复、无进展守护、崩溃终态语义）。
- **G2 可见性 = 隐藏**：workflow 子代理 record 进 store，GUI subagent 列表默认不显示；workflow run 视图实时进度从 store 订阅。
- **G3 并发共享池**：workflow agent() 与手动 subagent 共用同一 `DefaultConcurrencyPool`（同池同上限——`subagent-service.ts` 既有注释「pi 与引擎共用同一池」）。

### 1.4 in / out scope

**in**：record `origin` 字段与查询面；service 统一派发入口（workflow agent 专用参数）；pump 游离 record 删除与 trace 节点改造；TUI/GUI 进度源切换；runner 归位；`pending:unregister` 发射点归一；约束回写。
**out**：workflow 脚本语言/script-lint 本体；WorkflowRun 聚合根与 FileRunStore（run 级状态保留原状）；workflow 视图 UI 改版（只换数据源）；H4 持久化收敛。

---

## 2. 现状与问题分析

### 2.1 使用者视角的现状（真实链路）

用户在 GUI 跑一个 workflow：`parallel(() => agent("调研 A"), () => agent("调研 B"), () => agent("写总结"))`。每个 agent() 调用：worker 子进程发消息 → pump `dispatchAgentCall`（`:700-792`）→ **自建游离 liveRecord**（按 callId、TUI 进度用：text/thinking/toolCalls/usage 经 `getEventLog`/`getCurrentActivity` 展示）→ trace 节点入 `run.state.trace` → `runner.run(opts)` 平行接线执行（路由引擎、预检、journal、`armMidRoundNoProgress(taskId)`）→ AgentResult 回填 `node.result`，liveRecord 清除。重启后：WorkflowRun 由 FileRunStore 重水合（trace 节点的 result 摘要在），**子代理的 record 无任何持久痕迹**。

### 2.2 问题清单（带证据）

1. **游离 record**：`createRecord` 直调不进 store（`:708-717`）——无持久化、无恢复、无对账；`execution-record.ts:62-63`「唯一创建/更新入口」被绕开。
2. **双轨引擎接线**：service 侧（`runEngineTask` 族）与 runner 侧（路由/预检/journal/守护各一套）维护两份同构逻辑；journal-wiring 注释自述「两份同构接线提为 common helper」——helper 共享了，**派发路径没归一**（`engine/common/journal-wiring.ts:1-4`）。
3. **stream-sink 重复接线**：pump 自行 `new SubagentStream(...)`（`:790-792`），execution 侧 background streaming 通道重复。
4. **`pending:unregister` 第三发射面**：pump `finalizeRun` 直接 emit（`:281-290`）——与 notify-host、reconcile-sweep 构成三处发射（C-proc-13 ② 的发射点枚举制本要求收口）。
5. **孤儿恢复盲区**：workflow 子代理崩溃后无 record 可恢复/对账（sweep 保守跳过）。

### 2.3 根因分析

workflow 域早于引擎协议化演进定型；D3-③ 收敛时只把「两份同构 journal 接线」提到了 common helper，没有归一**派发路径**。`agent()` 的「子代理」与 subagent 工具的「子代理」概念同源（同一个 ExecutionRecord 形状——pump 都在直接复用 `createRecord`），实现却分叉成两套。**根因 = 概念同源、路径分叉，分叉又从未在后续收敛中被拉直。**

---

## 3. 解决方案

### 3.1 终态（使用者视角）

**成功路径**：

```
用户跑 parallel(3×agent())：
→ 每个 agent() 经 service 统一派发：record 注册进 store（origin:"workflow",
   parentRunId=<workflow run id>）→ 池 acquire（与手动 subagent 同池）→ 守护 arm
   → 引擎执行 → 事件流进 record → AgentResult 回脚本
→ TUI/GUI 的 workflow run 视图实时进度 = store 订阅（按 parentRunId 查询本 run 的
   record 集）；trace 节点保留终态摘要（result）
→ 重启后：workflow run 视图照常（FileRunStore 重水合）+ 每个子代理的完整 record
   由 store 恢复（孤儿恢复不再跳过）
→ GUI subagent 列表默认不显示这些 record（origin 过滤）
```

**失败路径**：

| 场景 | 行为 | 恢复指引 |
|------|------|---------|
| agent() 失败 | record 标 failed + trace node 终态（现状语义） | 脚本重跑该步 |
| 宿主重启于 agent() 在途 | record 经 store 孤儿恢复终态化；WorkflowRun 经 FileRunStore 恢复 | run 视图重开显示各步终态 |
| record 与 trace 摘要不一致 | **record 为真相**，trace node 是摘要缓存（详情视图读 store） | 无需动作 |

### 3.2 多方案对比

| 方案 | 长期合理性 | 短期成本 | 风险 | 判定 |
|------|-----------|---------|------|------|
| **A. 统一派发路径 + store 注册 + origin 标记**（本设计） | 高：单一路径单一真相，store 服务全家桶自动覆盖；与 H1/H3/H4 同轴 | 中：service 入口 + pump/runner 改造约 3-4 PR | 低：行为面可控（结果回脚本语义不变） | **选定** |
| B. 保留 runner 平行路径，仅把 record 注册进 store | 低：双轨派发仍在，每次引擎侧修复仍要两处同步 | 低 | 中：双轨漂移史（journal-wiring 先例）必复发 | 否——治标。若用它，§2.2 的双轨接线与发射面问题原样保留 |
| C. agent() 用专用轻量结构（非 ExecutionRecord） | 低：概念面更差，第三套「类 record」结构 | 中 | 高：用户的明确期望（等同 subagent）相悖 | 否 |

### 3.3 关键决策

- **D1 `origin` 字段（建议新增）**：`ExecutionRecord` 增 `origin: "tool" | "workflow"`（缺省 `"tool"`）与 `parentRunId?: string`。GUI subagent 列表默认过滤 `origin === "workflow"`；workflow run 视图按 `parentRunId` 查询。**被否**：按 slug 前缀/会话归属推导（隐式约定，规则 19 之鉴）。
- **D2 进度源切换**：trace node 的 `live` 字段删除；TUI/GUI 进度改 store 订阅（既有 `onChange`/`getEventLog` 查询面按 record id）；node 保留 `result` 终态摘要。
- **D3 并发共享池**：workflow agent() 走 service 的 `pool.acquire(PRIORITY_BACKGROUND, effectiveMaxConcurrentFor(record), signal)`（`subagent-service.ts` 既有单池）；**实施期核验点①**：runner 现路径是否绕过池（若是，归一后 workflow 并发行为变化 = 并发峰值受全局上限约束——这正是 G3 语义，需在验收 S4 实证）。
- **D4 守护单点**：runner 侧 `armMidRoundNoProgress(taskId)`（`subprocess-agent-runner.ts:449`）由 service 派发路径统一 arm（键从 taskId 归一为 record.id），与 H1 Continuation 同一模式；M3 守护语义不变。
- **D5 发射点归一**：pump 的 `pending:unregister` emit（`:281-290`）删除，改由 record 终态化统一发射——C-proc-13 ② 发射点枚举从三处收敛回 record 终态化 + sweep 两语义。
- **D6 通知语义保持**：workflow agent() 完成不产生主对话回注通知（结果由脚本返回值承载，现状）；notify-ledger 不涉入。

### 3.4 错误规格（增量）

| 错误 | 触发 | 形态 | 恢复 |
|------|------|------|------|
| 池排队中被 abort | workflow abort 信号 | run 域既有 cancelled 收口（S1 同款分支） | 脚本层重试 |
| record 创建失败（极端） | store 异常 | agent() 同步抛错回脚本 | 文案附原因 |

### 3.5 终态数据流

```
worker agent() → pump（薄：消息转调）→ service.executeWorkflowAgent(opts, parentRunId)
  → store.register({origin:"workflow", parentRunId}) → pool.acquire（共享池）
  → armMidRoundNoProgress(record.id) → 引擎执行（journal 接线单点）
  → 事件流 → record（TUI/GUI 经 store 订阅实时渲染）
  → AgentResult 回脚本 / record 终态（pending:unregister 统一发射）
```

---

## 4. 验收（真实场景；每场景回溯目标）

| # | 场景 | 步骤 | 通过标准 | 回溯 |
|---|------|------|---------|------|
| S1 | 多 agent 实时进度 | GUI 跑 `parallel(3×agent())`（真实 LLM） | run 视图实时进度与现状形态一致（数据源已换 store）；三步结果正确回脚本 | G1/G2 |
| S2 | 重启恢复 | S1 在途时重启宿主 | run 视图重开后各步终态正确；每个子代理 record 可查（store 孤儿恢复不再跳过 workflow） | G1 |
| S3 | 列表隐藏 | S1 后打开 GUI subagent 列表 | 列表默认不含 workflow 子代理；手动派的 subagent 照常显示 | G2 |
| S4 | 并发共享池 | workflow parallel(4) + 同时手动派 2 个 subagent（全局上限默认 N） | 任一时刻在途总数 ≤ 全局上限（池统计口径一致）；无互相饿死 | G3 |
| S5 | 删除面回归 | 删路完成后 | `grep -n "createRecord(" packages/subagent-core/src/orchestration/` 零命中；四包全量测试绿；workflow 崩溃恢复（FileRunStore）行为不变 | G1 |

---

## 5. 下一层拆分（PR 单元）

| 单元 | 内容 | justification | 可独立验收 |
|------|------|--------------|-----------|
| W1 | `origin`/`parentRunId` 字段 + store 查询面 + GUI 列表过滤 | 纯 additive 字段先行，消费方可渐进切换 | 单测 + GUI 过滤断言 |
| W2 | service 统一派发入口 `executeWorkflowAgent`（注册/池/守护/journal 单点） | 新路径最小闭环，与 W3 并行无冲突 | 单测：注册面/池行为/守护 arm 键 |
| W3 | pump 切换 + trace node 去 live + TUI/GUI 订阅源切换 | 消费面切换，W2 就绪后一次切换 | S1/S3 真机 |
| W4 | runner 归位（平行接线删除或薄壳化）+ `pending:unregister` 发射归一 + journal-wiring 调用点 2→1 | 死代码删除，最后做避免中间态 | S5 + 全量测试 |
| W5 | 约束/文档回写（C-proc-13 ②发射点枚举、troubleshooting 对账跳过条款更新） | C-proc-10 同步纪律 | doc-symbol-drift 绿 |

**文件改动地图**：core `execution/types.ts`（origin 字段）/ `execution/record-store.ts`（查询面）/ `execution/subagent-service.ts`（executeWorkflowAgent）/ `orchestration/worker-message-pump.ts`（删游离 record 与 emit）/ `orchestration/subprocess-agent-runner.ts`（归位）；extension `subagent-workflow/src/interface/{gui-mappers,tool-render,tui-kit}`（过滤与订阅源）。

**待验证检查点（实施期门）**：① runner 现路径是否绕过池（D3）；② TUI 渲染面对 `getEventLog`/`getCurrentActivity` 的精确依赖（订阅源等价替换）；③ workflow run 视图 GUI 数据源现状（gui-mappers 的 trace 投影链）；④ FileRunStore 重水合与 store 孤儿恢复的终态对齐（不一致以 record 为准的实现点）。

---

## 附：决策溯源

复杂度审查（2026-09-10）发现游离 record（编号 A4）；用户裁定期望形态 = 「workflow 中 agent() 等同一个 subagent」，并三裁定可见性（隐藏）/进度源（store 订阅）/并发（共享池）。执行序排 H1 之后（两者都动 record 模型，先统一 chat 域再归位 workflow，模型只重塑一次）。
