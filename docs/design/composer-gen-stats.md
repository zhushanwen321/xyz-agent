# Composer 底栏生成指标：Token 速度 + 缓存命中率（双触发器）

> 层声明：本文档是**技术方案设计**（下一层产物 = 可实现的接口 / 数据模型 / 代码任务），
> 准则 5/6/7（物理数据流 / 错误规格 / 运行时断言探针）全适用。实施走 dev-flow（impl-plan 由下一层产出）。

---

## §1 背景目标

**一句话结论：在 composer 底栏「上下文容量」左侧新增「Token 速度」与「缓存命中率」两个触发器（方案 A，已与用户确认），数据由 runtime 从既有 turn-usage 事件流扩展采集，按模型持久化在 xyz-agent 自己的数据目录，算法对齐 pi-statusline。**

### SCQA

- **S（情境）**：xyz-agent 是 Electron + Vue 的 AI Agent 桌面工作台。composer（聊天输入组件）底栏右侧挂一排状态触发器：「上下文容量 6.9万 · 6.9%」「模型」「思考等级」，是用户感知 token 消耗的既有入口。
- **C（冲突）**：两个直接影响成本与体验的指标完全不可见——① **token 生成速度**（t/s，感知模型快慢与网络质量）；② **prompt 缓存命中率**（命中率掉到 0 意味着每轮全价重算整个上下文，成本翻倍、首字延迟拉长）。用户只能通过「感觉变贵了/变慢了」间接察觉。
- **Q（问题）**：如何让用户在 composer 底栏一眼看到这两个指标，且不破坏现有底栏的视觉语言与架构范式？
- **A（答案）**：新增双触发器（速度 `35 t/s`、缓存命中率 `91%`，各带 hover 详情浮层）；数据链路复用 runtime 既有的 `turn-usage` 事件流（pi 的 usage 全量字段已在链路上，现被翻译层丢弃），runtime 新增 GenStatsService 做按模型持久化与日级聚合。

### 系统是什么（给不懂内部背景的读者）

- **composer**：`packages/renderer/src/components/panel/Composer.vue`——聊天输入框 + 底部工具条（composer-bar）。工具条右侧从左到右：上下文容量（ContextCapacityPopover）→ 模型（ModelSelectPopover）→ 思考等级（ThinkingLevelPopover）→ 发送位。
- **runtime**：`packages/runtime`——Node.js WebSocket 服务（Electron 子进程）。与 pi 子进程（外部依赖 `@earendil-works/pi-coding-agent@0.84.4`，RPC 模式）通信；`EventAdapter` 把 pi 事件翻译为内部事件，`EventInterpreter` 消费后回写状态或广播 WS 帧给 renderer。
- **pi-statusline**：用户的一个独立 pi extension（`~/Code/pi-statusline`），在 pi 进程内监听 message 事件计算速度/命中率并渲染 TUI 状态栏。本项目**不安装**它，只对齐其**算法口径**；其数据写 `~/.pi/agent/`，不符合本项目数据隔离规范，不能复用其存储。

### 设计目标（从使用者体验倒推）

| id | 目标 | 验收场景回溯 |
|---|---|---|
| G1 | **可见**：composer 底栏常驻显示当前速度（t/s）与缓存命中率（%），位于上下文容量左侧 | §4 场景 1 |
| G2 | **可解释**：hover 触发器出详情浮层——「本次 vs 今日均值」+ 计算口径说明 | §4 场景 1 |
| G3 | **实时**：每次 turn 完成后指标即刷新；切换 session 立即显示**该 session 当前模型**的指标（不闪「—」）；重启后指标可恢复（不依赖新 turn） | §4 场景 4 |
| G4 | **隔离与健壮**：持久化只落在 `<dataDir>/gen-stats/`（`getDataDir()` 动态推导，测试注入 `XYZ_AGENT_DATA_DIR` 后路径随之隔离）；`~/.pi/agent/` 零新增文件；文件损坏自愈 | §4 场景 3/5 |

### Scope

- **In-scope**：shared 协议类型与登记；runtime 采集断链接通（event-adapter / event-interpreter）；GenStatsService（内存聚合 + 落盘）；WS 帧 + RPC；renderer composable + 双触发器组件 + i18n + Composer 挂载。
- **Out-of-scope**：streaming 生成中的实时滚动速度（demo 方案 D，二期）；ContextCapacityPopover 浮层内「缓存命中」占位（D9）的喂数改造（本文档数据链路就绪后可作为后续一行接线，但不在本次）；provider 套餐额度（已有 quota 链路）；TUI / pi-statusline 本身。

---

## §2 现状与问题分析

**结论：数据已全量到达 runtime 的事件流上，但翻译层丢弃了速度/命中率所需字段；且项目无日级聚合存储——问题是「断链 + 无存储」，不是「数据不存在」。**

### 2.1 使用者视角的现状

打开 xyz-agent 与 AI 对话，composer 底栏只能看到：

```
[+]                      6.9万 · 6.9%   GLM-5.3 ▾   高 ▾   [↑]
                       ↑ 只有上下文容量；速度与缓存命中率无处可看
```

hover「上下文容量」出的浮层里有一行「缓存命中」，但**恒显「—」**——`ContextCapacityPopover.vue` 中该字段写死占位，注释标注「cacheHit 无 runtime 来源（D9）：占位—」。

### 2.2 数据链路现状（物理数据流，代码事实）

pi 的 usage 数据在链路上的真实路径（文件:行号均为当前 worktree 实装）：

```
pi 子进程 (0.84.4)                runtime                                renderer
──────────────────               ─────────────────────────              ─────────────
turn_start                        EventAdapter         EventInterpreter
  (LLM 请求开始)        ──RPC──→  translate            turn-start case
                                  (event-adapter.ts)   (event-interpreter.ts:301
                                                        turnGen 代际管理)
turn_end                ──RPC──→  handleTurnEndPi      turn-usage case
  message = AssistantMessage      (event-adapter.ts:356) (event-interpreter.ts:325)
  .usage {                        ↘【断链】只取 totalTokens， ├→ onContextUpdate → WS 'context.update'
    input, output,                    cacheRead / cacheWrite /  │    → useContextUsage（上下文容量显示）
    cacheRead,     ← 数据在此          output / model 全部丢弃 ↘   │
    cacheWrite,                                     【新增】onGenStats 回调
    totalTokens }                                     ├→ GenStatsService：内存聚合 + 落盘
  .model / .provider ← 模型在此                        └→ WS 'session.stats_update'【新帧】
                                                                        → useGenStats【新 composable】
                                                                        → 双触发器【新组件】
```

关键代码事实：

1. **pi 侧字段完备**（`node_modules/@earendil-works/pi-ai/dist/types.d.ts:265-327`，实装 0.84.4，`npm ls` 核对）：
   - `Usage { input, output, cacheRead, cacheWrite, totalTokens, cost, ... }`
   - `AssistantMessage { provider, model, usage, stopReason, timestamp, ... }`
   - pi 事件模型：1 个 agent 循环 = N 个 turn，**每个 turn 恰好一次 LLM 请求**，`turn_end.message` 即该次请求的 `AssistantMessage`（event-adapter.ts:349-352 注释，ADR-0037 契约）。
2. **runtime 翻译断链**：`handleTurnEndPi`（event-adapter.ts:356-369）只提取 `usage.totalTokens` 产出 `turn-usage` 事件（kind 定义见 `services/session/types.ts:216`），cacheRead/cacheWrite/output/model 全部丢弃。补充精确性：`handleAgentEnd`（agent_end 路径，:283-345）其实把完整 `usage` 对象（含 cacheRead/cacheWrite）透传进了 turn-end kind（event-adapter.ts:344、types.ts:208），仅 WS 层 message.complete 的 usage 裁剪为三字段——但 agent_end 每 agent 循环只触发一次（多 turn 循环只带最后一个 turn 的 usage），**非 per-turn 粒度**，且无 per-turn 时长锚点，不能作为本设计的采集源；per-turn 断链仅在 turn-usage 路径上成立。
3. **已有的「事后统计」补不了这个需求**：`packages/shared/src/usage-stats.ts` 的 `UsageStatsService` 扫描 session JSONL 产出 `UsageRow`（含 cacheRead/cacheWrite，day×provider×model×project 分组），经 RPC `usage.getStats` 供前端统计页。但 ① session JSONL 的 entry `timestamp` 是消息**完成时刻**，无生成起算点，**速度（需耗时）从 JSONL 算不出来**；② 全量扫描是重操作，不适合每次 turn 实时刷新。
4. **前端已有可复用范式**：`useContextUsage.ts`——per-session 分区（`useSessionScopedState`，ADR-0049）+ `useSessionEvents('context.update')` 订阅 + RPC 恢复腿（切 session 无条件重拉，解决「broadcast 早于订阅」时序竞争，架构约定 #7）+ cleanup 编排 + 状态三态（ok / no-value / unknown）。
5. **外部参照 pi-statusline 的算法**（`~/Code/pi-statusline/src/quota/cache.ts` + `speed.ts`）：
   - 速度：`current = output / durationMs × 1000`（t/s）；聚合 = **加权平均** `Σtokens ÷ Σduration × 1000`（day / d7 / d30），不是各次速度的算术平均；
   - 命中率：`current = round(cacheRead ÷ promptTotal × 100)`，其中 `promptTotal = input + cacheRead + cacheWrite`；当日聚合 = `ΣcacheRead ÷ ΣpromptTotal`；
   - 防脏样本：`output` 超阈值但耗时极短（缓存回放等异常）时丢弃该样本（BOGUS_OUTPUT_THRESHOLD / BOGUS_DURATION_THRESHOLD_MS）；
   - 存储：按模型分文件 `{"YYYY-MM-DD": [[token, duration], ...]}`，30 天 GC，model 名做文件名安全化。

### 2.3 失败模式（不做本设计的真实后果）

| id | 失败模式 | 触发条件 |
|---|---|---|
| F1 | 缓存失效不可见：provider 缓存 TTL 过期 / 切模型后，每轮全价重算上下文，用户只觉得「变贵变慢」 | 任何超过缓存 TTL 的间隔或模型切换 |
| F2 | 模型速度无从比较：切模型前后无速度读数，用户无法用数据决定模型选择 | 使用不同 provider/model |
| F3 | 「缓存命中 —」占位永远无法兑现：ContextCapacityPopover 浮层 D9 占位空悬 | 现状即如此 |

### 2.4 根因分析

- **断链根因**：`turn-usage` 事件建模时（context-consistency Phase 1）只服务「上下文用量」一个消费方，字段按需裁剪成 inputTokens/totalTokens——当时速度/命中率无消费方，裁剪合理；现在需求出现，需在翻译层把字段补全（扩展现有事件，而非新开事件）。
- **无存储根因**：项目的持久化层（usage-stats）定位是「事后统计报表」（扫 JSONL，分钟级新鲜度），没有为「底栏实时指标」设计的小而快的日级聚合存储。pi-statusline 的 per-model 日记录文件正是这个形态，算法可直接对齐，但存储位置必须迁到本项目的数据目录规范内。

---

## §3 解决方案

### 3.1 终态（使用者视角先行）

**成功路径**：用户打开 xyz-agent，与 AI 对话。第一个 turn 完成后，底栏「上下文容量」左侧出现两个新触发器：

```
[+]     ⚡35 t/s   ◔ 91%   6.9万 · 6.9%   GLM-5.3 ▾   高 ▾   [↑]
```

- 「⚡35 t/s」= **当前模型**最近一次 turn 的生成速度（模型视角，非 session 视角——速度/命中率是模型与缓存状态的属性；详见 §3.3 D4 的显示语义）。
- 「91%」= 当前模型最近一次 turn 的缓存命中率，按阈值着色三档：≥80% 绿（success）/ 50–80% 黄（warn）/ <50% 红（danger），与项目语义色分档习惯一致。
- hover「⚡35 t/s」出浮层：

  ```
  TOKEN 速度                        mimo-v2.5-pro
  ────────────────────────────────
  本次        35 t/s     今日均值    28 t/s
  近 7 天     22 t/s     近 30 天    19 t/s
  ────────────────────────────────
  output tokens ÷ 生成耗时，按模型分文件累计（加权平均）
  ```

- hover「91%」出浮层：

  ```
  缓存命中率                        prompt cache
  ────────────────────────────────
  本次请求    91%       今日加权    87%
  命中 46.2K / 总 prompt 50.7K
  [█████████████████▓▓▓] 91%
  ────────────────────────────────
  cacheRead ÷ (input + cacheRead + cacheWrite)
  ```

**失败路径与恢复指引**：

| 场景 | 用户看到 | 行为 | 恢复 |
|---|---|---|---|
| 新 session 尚无任何 turn（或当前模型无任何记录） | 两个触发器显示「—」 | 通道 unknown 态（从未收到合法帧）；字段级无值由 null 表达。0 只作真实测量值显示（小 output × 长 duration 合法得 0），「无数据」与「测得 0」由 null/0 区分 | 正常发消息即出现 |
| provider 未上报缓存字段（usage.cacheRead/cacheWrite 缺失或 promptTotal=0，如某些非 cache 模型） | 命中率触发器显示「—」；速度触发器不受影响 | no-value 态（对齐 pi-statusline「current=null 整体不显示」的保守语义） | 无需恢复；换支持 cache 的模型即显示 |
| 数据文件损坏 / 被删 | 触发器回到「—」，速度显示本次值（内存中有） | warn 日志落盘（`<dataDir>/logs/`），下次 turn 重建文件 | 自愈，无需用户操作 |
| runtime 重启（app 重启） | 重启后切回 session：触发器立即显示（RPC 恢复腿从落盘文件读到 day 聚合 + 全局最近样本=current） | 无「—」闪烁 | — |
| 切换到用另一模型的 session | 触发器切换为新模型自己的指标 | 模型视角语义（D4） | — |
| 纯工具 turn（无 LLM usage） | 指标不变（不产生样本、不清零、不显 0） | 样本采集跳过 | — |

### 3.2 多方案对比

| 方案 | 长期架构 | 短期成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A. runtime turn-usage 链路扩展 + GenStatsService**（选） | 采集/聚合/传输/展示四段各归其位：runtime 是 session 数据的唯一持方（先例：usage-stats、context.update），renderer 纯展示；协议一次扩展，后续任何「生成指标」消费方（如 D9 占位喂数、统计页速度列）都从同一数据层取 | 中：event-adapter 事件扩展 + 新 Service + 协议登记 + 前端组件，约 5 个文件改动面 | turn-usage 事件字段扩展需同步 interpreter/types，跨 3 层；duration 依赖 interpreter 记 turn 起始时间戳（本地时钟，与 pi-statusline 精度等价） | ✅ |
| B. 新 pi extension 采集（pi-statusline 模式移植） | 采集逻辑与 pi 解耦（独立包可复用到 TUI）；但数据要 extension → 落盘 → runtime 读文件 → 前端，**两套存储**（extension 文件 + runtime 传输层），且 extension 需感知 xyz-agent 数据目录（env 出站契约 C-proc-09 边界），数据层分裂 | 高：新 extension 包 + 数据回传通道 + runtime 读取适配，比 A 多一整段 | extension 与 runtime 双方各自持久化的一致性；pi 沙箱 env 边界；msg-id-mapper 先例仅监听事件不回传数据，回传通道无先例 | ❌ |
| C. renderer 从 message 流自行累计 | runtime 零改动 | 低：前端从 message_end entry（带 usage）累计 | ① renderer 无 fs，持久化要新开 IPC 通道（比 A 的 WS/RPC 更重）；② per-panel 实例各自累计，split mode 双面板数据分叉；③ session JSONL 无 duration，刷新页面后 day 速度丢失；④ 违反「数据持方在 runtime」的既有分工 | ❌ |

**被否方案若用会怎样（§2.1 例子视角）**：若用 B，用户看到的数字与方案 A 相同，但 `~/.pi/agent/` 下会多出 speed/cache-ratio 文件（违背 G4 隔离），或需要 extension 读 `XYZ_AGENT_DATA_DIR` env 才能落对位置——把简单链路变成跨进程双持方。若用 C，用户刷新窗口后触发器从「35 t/s」变回「—」（renderer 内存清零，JSONL 无 duration），与 G3 冲突。

### 3.3 关键决策与权衡

**D1：采集点 = runtime EventAdapter 扩展 `turn-usage` 事件（选定）**
- **采用**：`handleTurnEndPi` 扩展产出字段 `outputTokens / cacheRead / cacheWrite / input / model / provider`（全来自 `turn_end.message`，AssistantMessage 自带）；`turn-usage` kind 在 `services/session/types.ts` 同步扩展。GenStatsService 消费位置 = EventInterpreter 的 `turn-usage` case（:325，现只调 onContextUpdate）。
- **被否**：新开 `gen-stats` 独立 pi 事件——同一 pi 事件（turn_end）不应翻译出两条平行事件流（双消费点会重新引入「同一数据两条通路」的协议债，context-consistency D1 收敛正是为了消灭这种形态）；pi extension 侧采集（方案 B，理由见 3.2）；复用 agent_end 路径的完整 usage（它已透传 cacheRead/cacheWrite，见 §2.2 事实 2）——agent_end 每 agent 循环仅触发一次，多 turn 循环只带末个 turn 的 usage，**非 per-turn 粒度**且无时长锚点，采不到逐 turn 样本。
- **证据**：pi-ai types.d.ts:265/307（字段实装）；event-adapter.ts:356（现翻译点）；event-interpreter.ts:325（现消费点）；ADR-0037（pi 事件强类型契约）。
- **效果**：G1/G3 成立——一次 turn 的全部指标一次采集，既有 context.update 链路不受影响。

**D2：duration 口径 = turn-start → turn-usage 的 runtime 本地时钟差（选定）**
- **采用**：EventInterpreter 在 `turn-start` case（:301，已有 turnGen 代际管理）记 `turnStartedAt = Date.now()`；`turn-usage` 处理时算 `durationMs = Date.now() - turnStartedAt`。首次见到 turn-usage 而无 turn-start（runtime 中途启动、事件丢失）→ durationMs 视为不可得，该样本速度不采集（缓存命中率不受影响，promptTotal 与时间无关）。
- **被否**：用 pi entry 的 timestamp 差——session JSONL 只有完成时刻，无起算点（§2.2 事实 3）；用 pi extension 传消息级时间戳——同方案 B 否决理由。
- **证据**：event-interpreter.ts:301 turn-start case 已存在（挂时间戳是纯增量）；pi-statusline 同样用本地时钟（message_start Date.now() → message_end Date.now()），turn_start→turn_end 与 message_start(assistant)→message_end(assistant) 的覆盖区间相差仅为请求组装的毫秒级本地开销。
- **效果**：G1 的速度数值与 pi-statusline 同口径可比。
- **探针**（⛔实施期门）：需验证两点：① 「1 turn = 恰好一次 assistant message」的配对假设（含工具调用会话）；② **turn 级 duration 数值 vs message 级时长的系统性偏差**——pi 在 turn 内对失败 LLM 请求自动重试/续传时，重试退避等待会计入 turn-start→turn-usage 时长，速度被低估；含工具调用会话中若 turn 级 duration 系统性偏大（如 >10%），或确认存在 turn 内重试事件，则触发降级评估：改挂 assistant `message_start`/`message_end` 事件对（pi 事件流上均有），turn-start 时间戳方案废弃。验证方式：实施期在 dev 环境跑含工具调用的真实会话，比对 runtime 日志中 turn 边界与 message 边界的配对数与耗时分布。

**D3：存储布局 = `<dataDir>/gen-stats/`，per-model 两类文件，算法对齐 pi-statusline（选定）**
- **采用**：
  ```
  <dataDir>/                      ← getDataDir() 动态推导（shared/paths.ts SSOT，读 XYZ_AGENT_DATA_DIR）
    gen-stats/
      speed/<safe-model>.json         {"2026-02-09": [[outputTokens, durationMs], ...], ...}
      cache-ratio/<safe-model>.json   {"2026-02-09": [[cacheRead, promptTotal], ...], ...}
  ```
  `<safe-model>` = 文件名安全化 **必须单射**：`safeBase = (provider + '__' + model).replace(/[/\\\s:]/g, '_')` 截断至 64 字符，再追加内容 hash 后缀 `${hash8}`（hash(provider + '__' + model) 取前 8 字符）——纯字符替换不单射（`a b` 与 `a_b` 碰撞、macOS 大小写不敏感 FS 下 `Glm`/`GLM` 碰撞、无长度上限），hash 后缀消解；P2 单测补碰撞用例。30 天 GC（写入时顺带清理）。日 key 用**本地时区** `YYYY-MM-DD`（与 usage-stats D6「本机时区，禁止 UTC 切日」口径一致；pi-statusline 蓝本用 `toISOString()` 即 UTC，此处**有意偏离**——UTC 日边界对中文用户是本地 08:00，浮层「今日」会与直觉相悖）。原子写（tmp + rename）。**路径一律 `getDataDir()` 推导，测试用 `XYZ_AGENT_DATA_DIR` 指向 tmpdir（fs-guard 白名单），禁止任何字面量路径。**
- **被否**：写 `~/.pi/agent/`（pi-statusline 现状）——违背项目数据隔离规范（AGENTS.md：「数据目录隔离：~/.xyz-agent/ 与 ~/.pi/agent/ 完全隔离」），且测试 fs-guard 会拦截；复用 usage-stats 的 JSONL 扫描——无 duration（§2.2 事实 3）；SQLite——项目无先例，杀鸡用牛刀。
- **证据**：shared/paths.ts:40（getDataDir SSOT）；AGENTS.md 数据隔离条款；pi-statusline quota/cache.ts persistDailyRecord（算法蓝本）；runtime logger.ts（既有 `<dataDir>/logs/` mkdirSync 先例）。
- **效果**：G4 成立——数据隔离 + 测试安全（fs-guard 白名单机制天然兼容）。

**D4：协议 = 新帧 `session.stats_update` + 新 RPC `session.getGenStats`，无值一律 null 编码，显示语义 = 模型视角（选定）**
- **采用**：
  ```ts
  // ServerMessageMap 新增
  'session.stats_update': {
    sessionId: string
    speed: { current: number | null; day: number | null; d7: number | null; d30: number | null }  // t/s；null=无数据，0=真实测量值
    cacheRatio: { current: number | null; day: number | null }          // %；null=无缓存数据
    model?: string                                                       // 最近样本模型 id（浮层标题用）
  }
  // ClientToServerType 新增
  'session.getGenStats': { sessionId: string }
  // reply = session.stats_update payload 同形（恢复腿；无任何数据时 speed/cacheRatio 全 null + model 缺省）
  ```
  广播时机：每次 turn-usage 采样后（含聚合刷新），**对该模型全部已知 session 各发一帧**（payload.sessionId=各自 sid）——「全局最近」语义要求同模型任一 session 采样后，所有同模型 session 的显示同步刷新，只发采样 session 会造成 live 显示滞后于语义（被 R2 击穿，见被否谱系）。桌面单 WS 连接，帧数 = 同模型已知 session 数，无害。RPC 恢复腿：renderer 切入 session 视图时拉取（对齐 useContextUsage D3 恢复腿，解决架构约定 #7 时序竞争）。
  **反向映射（modelKey→sids）生命周期 = 三写一清 + 前端兜底**（R3 补全；仅 recordSample 单点登记被 R3 击穿为脏映射/漏登记，见被否谱系⑥）：
  - **写 1**：recordSample(sid, modelKey) 采样登记（该 session 当时模型的样本落盘时）；
  - **写 2**：模型切换重登记 + **顺带推新模型快照帧**——runtime broadcast `session.state_changed`（含新 modelId）处同步更新映射，并向该 sid 推一帧 snapshot(M2)（R4 补：仅静默重登记被击穿为 MF7——切模型后 live 分区继续显旧模型指标，live ≠ reload 在「切模型后、新模型首采样前」窗口成立；推帧后切换立即显示新模型快照，无记录则「—」，与恢复腿同值）。**帧序规定（R5/MF9，构造性闭合）**：同一触发点内固定顺序「先广播 state_changed → 再重登记映射 → 最后推快照帧」——插件路径（plugin.agent.setModel）下 renderer 的 modelId 只能由 state_changed 帧更新，快照帧若先发会被前端校验（帧内 model ≠ 尚未更新的 modelId）丢弃，MF7 窗口在插件路径回归；单 WS 连接有序送达，固定顺序即无竞态；
  - **写 3**：恢复腿解析成功回填——getGenStats case 降级链解析出 modelKey 后登记（覆盖「新 session 未采样」缺口：未采样 session 本不在映射，用户切入触发恢复腿即登记，之后 live 帧可达；从未被打开的 session 无人观察，收不到帧无害）。竞态声明（R4/S14）：「snapshot 计算后、登记执行前」存在毫秒级交错窗口，期间该 sid 可能漏收一帧——恢复腿 reply 本身已含最新快照、下一采样自愈，有界无害；
  - **清**：onSessionDestroyedHandlers 汇聚点（session-service.ts:166/369/832，覆盖主动删 / deleteByCwd / 进程退出）删该 sid 全部条目；
  - **前端兜底（纵深防御）**：useGenStats 的帧 handler 校验帧内 `model` 与该 session 当前 modelId（renderer 既有 per-session modelId 状态），不匹配丢弃；model 缺省的 live 帧同样丢弃（防御：所有 live 推帧路径均有 modelKey，缺省即异常）——后端映射任意空窗产生的脏帧从「覆盖显示」降级为「无害丢弃」。恢复腿 reply 不经此校验（RPC 主动拉取语义，modelId 由 runtime 侧降级链权威解析）。
  **恢复腿的 modelId 解析降级链（消异步就绪窗口）**：session-message-handler 的 getGenStats case 为 async——① 优先实时 `get_state(sid)` 拿当前 modelId（pi 在线时一次性解析，绕开 replicated states 异步播种竞速窗口）；② 失败/超时 → GenStatsService 内存映射 sid→modelKey（该 session 至少采样过一次时命中）；③ 仍无 → replicated states 缓存值；④ 全部未命中（新 session 从未设置模型且未采样）→ 返回全 null 帧。**残余窗口声明（R3）**：重启后映射空 + get_state 失败（pi 真实离线）时全 null 持续到首 turn 自愈——pi 离线期间本就无法产生对话，窗口不可观测，接受不另设机制。
  **无值编码纪律 [HISTORICAL] 对齐**：全帧无值一律 `null`，禁止 `?? 0` 编码——protocol.ts:1103 明文「无值以字段缺失/null 表达，禁止 ?? 0 编码」，且 0 并非物理不可能（output=3、duration=80s 经 round 合法得出 0 t/s），0 只允许作为真实测量值出现（项目先例：useContextUsage 0 帧哨兵、context.update D1 收敛）。UI 侧 null → 「—」；0 → 显示 0。
  **显示语义 = 模型视角（非 session 视角）**：双触发器显示的是「该 session 当前模型」的生成指标——`current` = 该模型全局最近一次 turn 样本的速度/命中率（落盘文件末条，跨 session），`day/d7/d30` = 该模型全局聚合。依据：① 速度/命中率是模型与缓存状态的属性，不由 session 决定，用户心智是「这个模型多快/缓存健康吗」；② current 落在文件末条 ⇒ 重启后 RPC 恢复腿可直接恢复，无需 per-session 快照持久化。`snapshot(sid)` 实现语义：按该 session 当前 modelId（组合根 replicated states 已持有）查该模型快照；**model 回填规则（R5/MF8）**：modelKey 解析成功时 payload.model 恒回填（含该模型无记录的全 null 帧——否则写 2 推的无记录快照被自家前端校验拦截，场景 4⑥「无记录则—」分支不可达，live≡reload 在 null 分支断裂）；仅 modelKey 本身未解析（降级链④）时 model 缺省。浮层「今日均值」文案明示按模型口径（「今日均值（此模型）」）。
- **被否**：① 往 `context.update` 塞新字段——该帧有协议收敛史（D1：usage 三字段收敛、0 帧哨兵、无值=字段缺失语义），塞异质指标要重走「无值怎么编码」的协议论证；② `speed.current=0` 编码「无数据」（本设计初版，已被击穿）：违反本项目 [HISTORICAL] 协议收敛纪律，且把「无数据」伪装成「测得 0」，与同帧 cacheRatio 的 null 语义不对称；③ **session 视角**（「该 session 最近一次样本」）——存储需增加 session 维度（文件数 × session 数、GC 复杂化、session 删除后快照成孤儿），且「最近一次」只存内存则重启即失，与 G3 恢复要求冲突；多 session 并发同模型时全局末条可能来自其他 session，「session 专属」语义无法自圆；④ **广播只发采样 session**（R2 初版）——被反例击穿：A、B 同模型同时打开，B 完成 turn 后 A 分区不刷新，live 显示滞后于「全局最近」语义，切走再切回（恢复腿）后值跳变，live ≠ reload；⑤ **恢复腿直接读 replicated states 的 modelId**（R2 初版）——被反例击穿：registerReplicatedStates 播种异步竞速（session-state-projection.ts:59 自认）、扫描/dead session 的 modelId 占位 `''`（session-scanner.ts:82-85），恢复腿命中空窗口即全 null 且无重拉触发；⑥ **反向映射仅由 recordSample 单点登记**（R3 初版）——被反例击穿：脏映射（session 采样 M 后切 M2，映射残留 sid→M，扩展广播把 M 帧发给 M2 session，前端不校验则覆盖显示）+ 漏登记（未采样 session 收不到 live 帧，「新 session + 同模型」高频组合下 live≠reload 重现，且场景 4⑤ 脚本双采样恰好绕开）→ 修为三写一清 + 前端兜底；⑦ **写 2 静默重登记**（R3 初版）——被反例击穿：切模型后 live 分区无人发帧继续显旧模型指标，live ≠ reload 于「切模型后、新模型首采样前」窗口成立（与 MF4/MF6 同类），→ 修为写 2 顺带推新模型快照帧；⑧ **推快照帧无帧序规定 + 无记录快照缺 model**（R4 初版）——被反例击穿：插件路径 renderer modelId 依赖 state_changed 更新，快照帧先发被校验丢弃（MF9）；无记录快照 model 缺省被自家校验拦截，场景 4⑥ null 分支不可达（MF8）→ 修为固定帧序「state_changed → 重登记 → 推帧」+ snapshot model 恒回填。
- **证据**：protocol.ts:1100-1105（context.update 契约 + 无值编码纪律）；useContextUsage.ts:130-137（0 帧哨兵 = 同一纪律的前端防线）；session-message-handler.ts:450（RPC case 范式）；session-state-projection.ts:293-298（replicated states 持有 per-session modelId）。
- **效果**：G3 成立——stats_update 广播 + getGenStats 恢复腿双通路，live ≡ reload，重启后 current（文件末条）与 day 聚合均可恢复。

**D5：renderer = `useGenStats` composable（照 useContextUsage 骨架）+ 双触发器组件（选定）**
- **采用**：`useGenStats(sessionIdRef)` 返回 `{ current }`——分区结构 `{ status: 'unknown'|'no-value'|'ok', speed: {...}, cacheRatio: {...}, model }`；订 `session.stats_update`（handler 用第二参数 sid 写分区，ADR-0049）+ 切入视图拉 `session.getGenStats` 恢复腿 + `registerSessionCleanup` 编排。UI 组件 `GenStatsTriggers.vue`（内含速度/缓存两个触发器，各自 HoverCard 浮层），挂 Composer.vue composer-bar 的 ContextCapacityPopover 之前。i18n key 挂 `panel.context.*` 现有段（zh-CN/panel.ts:135 起；现有 `cacheHit` key 语义是 ContextCapacityPopover 浮层行标签，与本触发器浮层是否同义**实施期确认**——若复用造成两处文案耦合则新增独立 key）。
- **被否**：数据并入 ContextCapacityPopover（demo 方案 D 的 idle 收纳）——用户已选方案 A；并成单触发器（demo 方案 B）——同上，用户已选 A（双触发器独立 hover）。
- **证据**：useContextUsage.ts 全文（范式蓝本：分区/订阅/恢复腿/in-flight 去重/cleanup 五件套）；Composer.vue:118 composer-bar 结构；i18n zh-CN/panel.ts:129 context 段（`cacheHit` 在 :135）。
- **效果**：G1/G2 成立——视觉与既有触发器同构（h-7 ghost button、tabular-nums、HoverCard），行为与既有数据范式同构。

**D6：聚合在 runtime 算好，前端只拿结论（选定）**
- **采用**：`session.stats_update`/`session.getGenStats` 的 payload 均是**算好的聚合值**（current/day/d7/d30、current/day），前端不做任何记录级运算。
- **被否**：RPC 返回原始日记录让前端聚合——暴露存储内部格式（协议与文件格式耦合，将来改存储即破协议）；传输量无谓增大。
- **证据**：usage.getStats 先例（runtime 扫描聚合、renderer 纯消费）。
- **效果**：存储格式（D3）可独立演进。

**D7：防脏样本 = 对齐 pi-statusline bogus guard（阈值照抄）+ 语义内建防线（选定）**
- **采用**：① `outputTokens > 50 && durationMs < 100ms` → 速度样本丢弃（缓存回放型异常：巨量 output 瞬间完成；阈值照抄蓝本 pi-statusline index.ts:61-62 实装值，不自行放宽——无证据支持更宽阈值，且 G2「今日均值长期可信」依赖阈值有效性）；② `promptTotal <= 0` → 命中率样本不采集（current=null 语义）；③ provider 未上报 cache 字段（cacheRead/cacheWrite undefined）→ 按 0 处理进 promptTotal，但有效性由 ② 兜底。
- **被否**：不做防护——异常样本会污染 day 加权均值（一次 bogus 就能把 day 速度拉到荒谬值）。
- **证据**：pi-statusline index.ts:61-62（`BOGUS_OUTPUT_THRESHOLD = 50` / `BOGUS_DURATION_THRESHOLD_MS = 100`），:250 判定式；算法照抄不偏离。
- **效果**：G2 浮层里的「今日均值」长期可信。

**D8：写入策略 = 每 turn 采样后同步原子写（选定）**
- **采用**：turn 结束频率为人机对话节奏（秒~分钟级），单文件 JSON 体积小（30 天 × 数十样本），每 turn `writeFileSync(tmp) + renameSync` 可接受；运行期还有内存聚合兜底显示（写失败不影响当前帧推送，下次 turn 重写）。**并发正确性前提：read→append→write 必须在同一同步临界段内完成**（runtime 单进程 + 单线程事件循环 + 同步 fs 天然串行化；若将来 store 改 async，必须引入互斥，否则 read-modify-write 竞丢样本——多 session 并发 turn 写同一模型文件时依赖此前提）。
- **被否**：debounce 批写——引入关机丢样本窗口，复杂度换不回收益（写入量太小）。
- **证据**：pi-statusline persistDailyRecord 同为每次同步写；runtime 原子写先例（quota cache doUpdate tmp+rename）。
- **效果**：G4 健壮性——crash/kill 最多丢「正在进行的最后一个 turn」一条样本。

### 3.4 接口与数据模型（接口先行）

**shared（`packages/shared/src/`）**：

```ts
// protocol.ts
// ServerMessageType 联合新增 'session.stats_update'
// ClientToServerType 联合新增 'session.getGenStats'
// ServerMessageMap / PayloadMap 登记（与 §3.3 D4 一致）

// 新文件 gen-stats.ts（类型 SSOT，避免散落 protocol.ts）
export interface GenStatsSpeed { current: number | null; day: number | null; d7: number | null; d30: number | null }  // t/s；null=无数据，0=真实测量值
export interface GenStatsCacheRatio { current: number | null; day: number | null }        // %；null=无数据
export interface GenStatsFrame {
  sessionId: string
  speed: GenStatsSpeed
  cacheRatio: GenStatsCacheRatio
  model?: string       // 最近样本模型 id（浮层标题）；modelKey 解析成功恒回填（R5/MF8），仅 modelKey 未解析（降级链④）时缺省
}
```

**runtime（`packages/runtime/src/`）**：

```ts
// services/session/gen-stats-service.ts（新）
export class GenStatsService {
  // 采样：interpreter turn-usage 分支调用（fire-and-forget，不阻塞事件流；内部记 sid→modelKey 映射）
  recordSample(sid: string, s: {
    outputTokens: number; durationMs: number | null; model: string; provider: string
    input: number; cacheRead: number; cacheWrite: number
  }): void
  // 恢复腿：session-message-handler 'session.getGenStats' case 调用（async case 内先实时 get_state 解析
  // modelId，降级链见 D4：get_state → 内存映射 sid→modelKey → replicated states → 全 null）。
  // 语义（模型视角，D4）：按解析出的 modelKey 取该模型快照；
  // current = 该模型全局最近样本（落盘文件末条，跨 session、可跨重启恢复）；
  // model 回填规则（R5/MF8）：modelKey 非 null 时 payload.model 恒回填（无记录 → speed/cacheRatio 全 null 帧）；
  // modelKey 为 null（降级链④走尽）→ 全 null 且 model 缺省
  snapshot(modelKey: string | null): GenStatsFrame
  // 广播辅助：该模型全部已知 session（stats_update 逐 sid 发帧用）。
  // 映射生命周期 = 三写一清（recordSample / state_changed 模型切换重登记 / 恢复腿解析回填；
  // onSessionDestroyedHandlers 清理）+ 前端帧校验兜底，见 D4
  sessionsOfModel(modelKey: string): string[]
}
// 存储内核 gen-stats-store.ts（新，纯函数化便于测试）
// readDayRecords / writeDayRecords / aggregateSpeed(Σtokens/Σduration) /
// aggregateCacheRatio(Σread/Σtotal) / gc(30d) / safeModelFileName
```

**renderer（`packages/renderer/src/`）**：

```ts
// composables/features/model/useGenStats.ts（新）——useContextUsage 五件套范式
useGenStats(sessionIdRef): { current: ComputedRef<GenStatsFrame | null> }
// 分区直接存帧本体：null = 从未收到合法帧（R3 删 status 字段——unknown 与「ok 但字段全 null」渲染
// 均为「—」，status 无消费方，属过度设计；删除后「从未有帧」与「有帧但无值」的 UX 差异落在浮层：
// 前者浮层显示「暂无数据」，后者浮层可展示 day 等非 null 聚合值）
// 字段级无值由 null 表达（D4 编码纪律），双触发器各自独立判定：字段 null → 「—」，否则显数字。
// 「速度有值 + 命中率 null」（非 cache 模型常态组合）由此自然表达，无需组合枚举。
// 帧 handler 校验帧内 model ≠ 该 session 当前 modelId 时丢弃（D4 前端兜底，纵深防御）。
// 注：分区按 ADR-0049 范式建，但分区值是「session 当前模型」的全局快照（模型视角 D4）——同模型多 session 分区值相同是预期行为
// components/panel/GenStatsTriggers.vue（新）——双触发器 + HoverCard 浮层（复用 ui/hover-card）
```

### 3.5 错误规格

| 错误 | 检测点 | 行为 | 恢复指引 |
|---|---|---|---|
| 数据文件读失败（损坏/权限） | GenStatsStore 读 | warn 日志（带路径），按空记录继续，**不抛出** | 下次写入重建文件，自愈；用户无需操作 |
| 数据文件写失败（磁盘满等） | GenStatsStore 写 | warn 日志；内存聚合照常、当前帧照常推 | 释放磁盘后下个 turn 自动恢复；期间 day 值基于内存+旧文件 |
| turn-usage 无配对 turn-start | interpreter 查 turnStartedAt 缺失 | durationMs=null：速度样本跳过，命中率样本照常 | 自愈（下个 turn 正常配对） |
| provider 不报 cache 字段 | usage.cacheRead/cacheWrite === undefined | cacheRatio.current=null，触发器显「—」 | 换支持 cache 的模型 |
| 恢复腿 get_state 失败/超时（pi 离线、session 已死） | getGenStats RPC case 降级链 | 降级内存映射 → replicated states → 全 null 帧（前端显「—」，不卡加载） | pi 恢复后下一 turn 采样自愈；用户无需操作 |
| 超长对话记录膨胀 | GC（写入时 30 天前日期整键删除） | 单文件上限 ≈ 30 天样本量 | 无需用户操作 |
| 测试误触真实数据目录 | vitest fs-guard（既有切面） | 测试写入目标必须 `mkdtempSync(join(tmpdir()))` 自建 + env 注入 | 遵守 TEST-STRATEGY 红线，store 测试注入 `XYZ_AGENT_DATA_DIR` |

---

## §4 验收（真实场景，非 mock）

> 以下场景在**真实 dev 环境**执行：`pnpm dev` 启动 Electron + runtime，连真实 pi 进程与真实 provider 发消息。每条标注回溯的 §1 目标。

**场景 1：首次对话，指标出现且数值落在合理区间（G1/G2）**
步骤：dev 启动 → 新建 session → 发一条要求写代码的消息（产生真实 LLM 流式输出）→ 等 turn 完成。
通过标准：① 底栏「上下文容量」左侧出现 `⚡N t/s` 与 `NN%` 两个触发器；② 速度值在「当前 provider 网络下可信」区间（如 5~200 t/s，不应是 0 或上万）；③ 命中率首轮通常低（冷启动 0~60%）或多轮后高（≥70%），且与 hover 浮层中「本次请求」一致；④ hover 两个浮层分别展示本次/今日均值与口径说明文案（i18n 生效，中英文切换各验一次）。

**场景 2：多模型分别累计（G1/G4 数据正确性）**
步骤：同一 session 用模型 A（如 zai GLM）对话两轮 → 切模型 B（如 kimi）对话两轮 → hover 浮层看「今日均值」。
通过标准：模型 B 的浮层标题变为 B 的模型 id；B 的 day 速度只由 B 的两轮样本构成（A 的样本不混入）；`<dataDir>/gen-stats/speed/` 下出现两个独立文件（A、B 各一，文件名 = safeBase + hash 后缀）。

**场景 3：数据隔离（G4，机器可查）**
步骤：dev 启动前对系统 `~/.pi/agent/` 做文件清单快照 → 完成场景 1/2 → 再次快照比对，并 `ls <dataDir>/gen-stats/`（默认 `~/.xyz-agent/gen-stats/`）。
通过标准：① `gen-stats/` 只出现在 `<dataDir>/` 下；② `~/.pi/agent/` 前后快照 diff 为空（pi 目录零新增——注意项目 pi agent 目录是 `<dataDir>/pi/agent`，与系统 `~/.pi/agent/` 是两回事，后者才是隔离比对对象）；③ `grep -rn "pi/agent" packages/runtime/src/services/session/gen-stats-store.ts` 无命中（源码不引用任何 pi 目录）。

**场景 4：重启与切 session 的显示连续性（G3）**
步骤：session A 用模型 M 产生若干轮对话 → 完全退出 app → 重新 `pnpm dev` → 切到 session A → 另建 session B（同模型 M，未对话）→ 观察两者触发器 → 切回 A。
通过标准：① 重启后切到 A，触发器**立即**（不依赖新 turn）显示与重启前一致的 day 聚合值与 current 值（current = 模型 M 文件末条样本，RPC 恢复腿生效）；② session B 同模型 → 显示与 A 相同的指标（模型视角语义的预期行为，非串台——两分区值本就该相同）；③ 若 session C 用的是无任何记录的模型 → 显「—」；④ 切回 A 恢复显示；⑤ **多 session live 同步**：split 模式同开 A、B 两 panel（同模型 M），在 B 发消息完成一 turn → A panel 的速度/命中率**同步刷新**为与 B 一致的新值（无需切走切回，D4 扩展广播）；⑥ **未采样新 session 的 live 可达 + 切模型立即切换 + 不串台**：新建 session D（同模型 M，从未对话，仅切入一次触发恢复腿）→ B 完成一 turn → D 同步刷新（漏登记反例）；再将 D 切到模型 M2 → D **立即**显示 M2 的快照（无记录则「—」，不再显示 M 的指标——静默重登记反例，写 2 推帧）；此后 B 完成 turn → D 显示不变（脏映射反例：帧内 model=M ≠ D 当前 M2，前端校验丢弃）。这验证「live ≡ reload」与 D4 模型视角语义。

**场景 5：负面行为（G4 健壮性）**
5a 纯工具 turn：发一条触发多工具调用的消息，确认每轮 turn 之间指标只在新 LLM 响应完成后更新，中途工具执行不产生速度骤降到 0 的假样本。
5b 文件损坏自愈：手动把 `speed/<safe-model>.json` 写成 `"{corrupted"` → 再对话一轮 → 文件被重建为合法 JSON，触发器显示新样本值，runtime 日志有一条 warn。
5c 无 cache 上报模型（若可用）：命中率触发器显「—」而非 0%，速度正常。

**场景 6：测试红线合规（G4，实施期机器验证）**
通过标准：`packages/runtime` 新增测试全部在 vitest 下运行，写入目标为 `mkdtempSync(join(tmpdir(),'xyz-gen-stats-'))` + env 注入；`pnpm extensions:typecheck` / `pnpm run lint` / 相关包测试绿。

---

## §5 下一层拆分（实施路径 → dev-flow 输入）

实施顺序四阶段，每阶段可独立验证/回滚：

| 阶段 | 内容 | 独立验收 | justification |
|---|---|---|---|
| **P1 shared 契约** | `gen-stats.ts` 类型 + protocol 登记（帧 + RPC + payload） | typecheck 过；协议 map 完整性测试（既有 pattern）先行，避免运行时 payload 漂移 | 契约先行是跨包协作前提（三层都消费） |
| **P2 runtime 存储内核** | `gen-stats-store.ts` 纯函数族（读写/聚合/GC/安全文件名）+ vitest（tmpdir 注入） | 单测：聚合算法与 pi-statusline 数值口径一致（构造已知样本断言加权平均）、GC、损坏自愈、**safe-model 文件名碰撞**（`a b` vs `a_b`、大小写、超长 model id 截断后 hash 不碰撞）、null 语义（无样本 → 全 null，禁止 0 充数） | 算法正确性隔离验证，不掺事件流噪声；纯函数最可测 |
| **P3 runtime 链路** | event-adapter turn-usage 字段扩展 + interpreter turnStartedAt/onGenStats + GenStatsService（含 modelKey→sids 反向映射 + sessionsOfModel + sid 清理接线）+ stats_update 扩展广播（逐 sid 发帧）+ getGenStats RPC case（async + get_state 优先降级链）+ D2 探针验证 | 探针（D2）：真实会话日志验证 turn/message 配对与 duration 对比；手动对话看到帧（devtools WS）；双 session 同模型验证扩展广播 | 链路逐段接通，帧可用 devtools 独立确认，前端未动即可验 |
| **P4 renderer** | useGenStats + GenStatsTriggers.vue + Composer 挂载 + i18n（zh/en） | §4 场景 1/2/4 全量真实验收 | 组件薄（纯展示 + 既有范式复用），放最后风险最小 |

**文件改动地图**：

| 包 | 文件 | 动作 |
|---|---|---|
| shared | `src/gen-stats.ts` | 新增（类型 SSOT） |
| shared | `src/protocol.ts` | 修改（帧/RPC/payload 登记） |
| shared | `src/index.ts` | 修改（export） |
| runtime | `src/services/session/gen-stats-store.ts` | 新增（存储 + 聚合纯函数） |
| runtime | `src/services/session/gen-stats-service.ts` | 新增（采样 + 快照） |
| runtime | `src/services/session/types.ts` | 修改（turn-usage kind 字段扩展） |
| runtime | `src/services/session/event-interpreter.ts` | 修改（turnStartedAt + onGenStats 回调） |
| runtime | `src/infra/pi/event-adapter.ts` | 修改（handleTurnEndPi 字段补全） |
| runtime | `src/transport/session-message-handler.ts` | 修改（RPC case + 白名单） |
| runtime | `src/services/session/session-service.ts` | 修改（onSessionDestroyedHandlers 挂映射清理；state_changed 广播处挂模型切换重登记） |
| runtime | 组合根（index.ts / sessionService 装配处） | 修改（GenStatsService 装配注入） |
| renderer | `src/composables/features/model/useGenStats.ts` | 新增 |
| renderer | `src/components/panel/GenStatsTriggers.vue` | 新增 |
| renderer | `src/components/panel/Composer.vue` | 修改（挂载于 ContextCapacityPopover 前） |
| renderer | `src/i18n/locales/{zh-CN,en-US}/panel.ts` | 修改（genStats 文案段） |

**待验证检查点（实施期确认，设计不编造）**：
- D2 探针：① 1 turn = 1 assistant message 的配对假设（含工具调用会话）；② turn 级 duration 与 message 级时长的数值对比（不只配对数）——pi turn 内自动重试/续传会使 turn 级时长系统性偏大，触发降级评估（改挂 message_start/end 对）。
- turn_end.message.model 在各 provider 的真实性（responseModel vs model 字段，浮层标题取哪个）。
- get_state 返回的 model 字段格式（复合 id provider/model 还是裸 model id）与样本 modelKey（provider__model）的拼接对齐规则——降级链 ① 依赖此对齐；另确认 get_state 对「从未发消息的 session」返回默认模型还是空。
- provider 对 usage.cacheRead 的上报覆盖面（zai/kimi/xiaomi-mimo 实测），决定「—」态出现频率。
- subagent session 是否也走 turn-usage → 若是，per-sessionId 设计天然隔离（验证即可）。

---

## 变更历史

| 轮次 | 变更 | 触发 |
|---|---|---|
| R5（审查修复轮 5） | ① MF9：D4 写 2 补固定帧序「广播 state_changed → 重登记映射 → 推快照帧」（插件路径 renderer modelId 依赖 state_changed，序反则快照帧被校验弃）；② MF8：snapshot model 回填规则——modelKey 非 null 恒回填 payload.model（含无记录全 null 帧），前端校验补「model 缺省 live 帧丢弃」+ 澄清恢复腿 reply 不经校验；③ 被否谱系记⑧；§3.4 snapshot 注释同步 | tech-design-review R5：S13/S14 闭合；MF7 拆出 MF8/MF9（一句话级规格补写），见 review.md 第 5 轮章节；R6 复审判「设计就绪 0 must-fix」，唯一残留 S15（GenStatsFrame.model 注释旧语义）当轮同步修正 |
| R4（审查修复轮 4） |
| R4（审查修复轮 4） | ① MF7：写 2 静默重登记被击穿（切模型后 live≠reload 于「切模型后、新模型首采样前」窗口）→ 写 2 顺带推新模型快照帧，被否谱系记⑦，场景 4⑥ 通过标准改为「切模型立即显示新模型快照」；② S14：写 3 补毫秒级回填竞态声明（有界无害）；③ S13：被否谱系「。；」标点实际未修而 R3 历史误称已修，本轮修正并如实记录 | tech-design-review R4：MF6 修复成立（写 2 挂接点经实装核实为真汇聚点 session-state-projection.ts:437；写 3 竞态有界无害）；新增 MF7 + S13/S14 全修，见 review.md 第 4 轮章节 |
| R3（审查修复轮 3） | ① D4 反向映射生命周期改「三写一清 + 前端兜底」（recordSample / state_changed 切模型重登记 / 恢复腿回填；onSessionDestroyedHandlers 清理；useGenStats 帧校验 model 不匹配丢弃），被否谱系记⑥单点登记击穿反例（脏映射覆盖显示 + 未采样漏登记）；② 补 S10 残余窗口声明（pi 离线期不可观测，接受）；③ 删分区 status 字段改 `GenStatsFrame\|null`（S11：unknown 与 ok 全 null 渲染相同无消费方，浮层差异化承接）；④ 文件地图补 session-service.ts 接线；⑤ 场景 4 补⑥未采样 live 可达 + 切模型不串台断言；⑥ 被否谱系标点修正 | tech-design-review R3：MF5/S9 修复成立；MF4 升级为 MF6（映射生命周期）+ S10/S11/S12 全修，见 review.md 第 3 轮章节 |
| R2（审查修复轮 2） | ① D4 广播时机改「该模型全部已知 session 各发一帧」（GenStatsService 增 modelKey→sids 反向映射 + sessionsOfModel），被否谱系记「单采样 session 广播」击穿反例（MF4：同模型 A/B 并开，B 采样后 A live 滞后，live≠reload）；② 恢复腿 modelId 解析加降级链（实时 get_state → 内存映射 → replicated states → 全 null），snapshot 签名改 snapshot(modelKey)，被否谱系记「直接读 replicated states」击穿反例（MF5：异步播种竞速 + 占位 ''）；③ 分区 status 简化 unknown/ok 两态、无值由字段 null 表达，失败路径表第 1 行对齐（S9：「速度 ok+命中率 null」组合自然表达）；④ §3.5 补 get_state 失败行；⑤ 场景 4 补 ⑤ 多 session live 同步断言；⑥ 待验证点补 get_state model 字段格式对齐 | tech-design-review R2：上轮 3 must-fix 修复全部成立；新增 2 must-fix（MF4 live 同步断裂 / MF5 modelId 异步就绪窗口）+ 1 suggestion（S9 三态不闭合）全修，见 review.md 第 2 轮章节 |
| R1（审查修复轮 1） | ① D4 speed 无值编码 0 → null（全字段 `number\|null`），补「无值编码纪律」与被否谱系（0 编码被协议纪律击穿）；② 显示语义定为**模型视角**（current=该模型全局最近样本=文件末条、day=per-model 全局聚合、snapshot(sid) 按 session 当前模型取快照），§1 G3/§3.1 终态/失败路径表/§4 场景 4 联动改写，session 视角记入被否谱系；③ D7 bogus 阈值 1000/1000 → **50/100**（照抄蓝本实装值 index.ts:61-62）；④ D2 探针扩 duration 数值对比 + 待验证点补 turn 内重试；⑤ D3 safe-model 加 hash 后缀（单射）+ 本地时区日 key（有意偏离蓝本 UTC，对齐 usage-stats D6）；⑥ §2.2 事实 2 修正（handleAgentEnd 实透传完整 usage，断链仅在 turn-usage 路径）+ D1 补「为何不用 agent_end usage」；⑦ D8 补同步临界段并发前提；⑧ §4 场景 3 比对对象修正（系统 ~/.pi/agent 快照 diff）；⑨ i18n 行号 :135 + cacheHit 复用边界；⑩ §5 P2 单测补碰撞/null 用例 | tech-design-review R1：3 must-fix（协议 0 编码 / per-session 语义悬空 / 阈值与蓝本不符）+ 7 suggestions 全修，见 composer-gen-stats.review.md |
