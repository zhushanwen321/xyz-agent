# 崩溃韧性：Taiji.app 中短期崩溃防治技术方案

> **一句话结论**：「session 崩溃」是三层进程（renderer / runtime / pi）各自缺陷的同一表象；本方案用五道防线（extension 守卫、renderer 韧性、传输预算、内存观测、pi 恢复）在中短期消灭已实锤的崩溃源，长期架构项（runtime 多进程隔离、统一遥测）明确出 scope。

**层声明**：当前层 = 技术方案设计（崩溃治理专题）；下一层 = 实现计划（dev-flow 实施单元）。本文设计深度止于实施单元拆分与文件改动地图，不到函数签名。涉及运行时行为/数据流/错误处理，层敏感准则 5/6/7 全部适用。

---

## 1. 背景目标

**SCQA**：

- **S（情境）**：Taiji.app（xyz-agent 打包版）是 Electron 桌面应用，架构为四层进程：Electron main（窗口/runtime 监管）、runtime（Node.js WebSocket 服务，托管所有 session）、renderer（Vue 3 GUI）、pi 子进程（每 session 一个，AI 引擎，extension 与 pi 同进程运行）。
- **C（冲突）**：用户频繁遇到「某个 session 直接崩溃」，而单独使用 pi CLI（主 session 或 subagent）从不崩溃。2026-09 真实日志取证确认三类故障都在发生：pi 进程被 extension 错误炸死（9/3 实锤）、多个 session 同秒被连带 SIGTERM（9/5 实锤）、renderer 进程 OOM 崩溃（9/9 实锤）。
- **Q（问题）**：怎么在中短期让「单个组件出错不再杀死 session、崩溃后用户能自动恢复、每次崩溃都有日志可查」，同时不触碰需要架构论证的长期项？
- **A（答案）**：按崩溃面分五道防线逐层设防——extension 异步回调守卫（杀已实锤的崩溃源）、renderer 错误边界与自动恢复、server→client 传输预算、内存水位观测、pi 崩溃自动恢复。本文展开这个答案。

**术语锚定**（首次出现，后文不再解释）：

- **stale ctx（失效上下文）**：pi 的 extension API 对象（`pi` / `ctx`）在 session 替换（`ctx.newSession()` / `fork()` / `switchSession()` / `reload()`）后被 pi 标记失效，再调用其方法会**同步抛错**（`assertActive` 检查，错误文案含 `stale after session replacement`）。GUI 的每次切 session/新建/重载都在制造失效窗口；CLI 用户几乎不触发这些操作——这是「pi 单独用不崩、套 GUI 就崩」的核心机制差异。
- **三层崩溃面**：用户看到的「session 崩溃」实际是三种不同故障——① pi 子进程死亡（该 session 的引擎没了）；② runtime 整机重启（所有 session 的引擎连带死亡）；③ renderer 进程死亡（GUI 白屏，引擎其实还活着）。三者的防护与恢复机制完全不同。
- **出站帧**：runtime 经 WebSocket 发往 renderer 的单条消息。现网入站（renderer→runtime）有 16MB 上限，出站（runtime→renderer）**无任何上限**。session 级 push 帧的形态是 `{type, payload: {sessionId, entry}}`——**大内容藏在 entry 内部字段**（持久化 entry 的实时权威载体是 `message.message_end` 帧；工具结果文本在 `entry.message.content`，工具参数在 `entry.arguments`，**图片是 content 数组内的 Image block**，entry 无独立 images 字段）。
- **ring 回放与 seq gap 检测**：runtime 的 MessageBus 为每个 session 的消息分配单调递增 seq；stream 类消息写入容量 1000 的环形缓冲（ring），state 类更新订阅快照；WS 断连重连后按 seq 回放补齐，客户端发现 seq 跳号（gap）则触发重订阅全量拉取。**seq 连续性是断连恢复机制的正确性前提**——任何「分配了 seq 但客户端没收到」的消息都会被判为丢帧。
- **单条消息体积 vs 累计流量**：本机观测的单 session pi stdout tee 累计流量达 198MB，但**单条工具结果体积受 pi 工具链上游约束**（read/bash 类工具自选截断输出到 50KB/2000 行，图片 ≤16MB；pi 无全局「白名单机制」，截断与否是各工具自选行为——write 类工具的 toolResult 只回小确认，但**写入全文在 `tool_call_start` 帧的 `entry.arguments` 里**）——累计大不等于单帧大。传输层预算（D3）防的是单帧超限，读取层预算（D4/D5）防的是文件级与累计级无界，两者对象不同。

**设计目标**（从用户体验倒推）：

- **G1 单点故障不杀 session**：任何 extension 的异步回调错误不得导致 pi 进程退出；session 只死于真正的引擎故障。
- **G2 renderer 崩溃可恢复且有痕**：渲染进程死亡后 3 秒内自动恢复到可用界面；崩溃前的 JS 错误现场有日志落盘；连续崩溃有熔断，不陷入 reload 循环。
- **G3 大 session 不炸内存**：任意体积的 session 历史（当前观测最大历史文件 6MB、单 session 累计流量 198MB）都不会让 renderer 或 runtime OOM；传输、加载、恢复附着全程有字节预算。
- **G4 pi 崩溃自动恢复且用户可见**：pi 进程死亡后 session 自动重建，用户看到明确提示而不是「session 无声消失」；在途回合与后台任务的丢失必须告知。
- **G5 每次崩溃可定位**：任何一层崩溃后，`~/.xyz-agent/logs/` 里能回答「哪层、哪个 session、退出码、崩溃前内存水位」，且目录体积不失控。

**in-scope**：五道防线的中短期形态（D1-D7）。**out-of-scope**（留给长期架构论证，本文不设计）：runtime 多进程化 session 隔离、统一崩溃遥测 schema 与诊断包导出、系统级内存压力感知看门狗、pi 上游改动（违反仓规 [MANDATORY] 不改 pi）、zcode engine 层、dev 实例与打包版数据目录隔离（E2 的根治项，先靠 D6 取证归因，复发即立项——见 §3.3 D6 已接受代价）。

---

## 2. 现状与问题分析

**本章结论：三个实锤崩溃事件分别命中四个根因（R1-R4），现有防线集中在 runtime 层，renderer 层与 extension 层几乎裸奔。**

### 2.1 四层进程模型与崩溃面

```
┌─ Electron main（长寿）：窗口管理、runtime supervisor、IPC 桥
│    └─ 监管 runtime：崩溃退避重启（1-16s×5 次）、30s liveness 探针、孤儿收割
│    ⚠ main 进程的 console 无落盘通道（打包版 stdout 无人收集）——main 侧日志当前不可见
├─ runtime（Node 单进程）：WS 服务（127.0.0.1:32xx），托管全部 session
│    ├─ pi 子进程 × N（每活跃 session 一个，extension 在 pi 进程内运行）
│    └─ plugin worker（Worker Thread，无独立 pid）/ relay 受托子进程
└─ renderer（Chromium 渲染进程 × 窗口，多窗口存在）：Vue GUI，经 WS 连 runtime
```

关键结构事实：**runtime 是单进程**，任何一个 session 触发的 uncaughtException 或内存尖峰都会带走所有 session；**extension 跑在 pi 进程内**，extension 里一个没人接的异常 = pi 进程死亡 = 该 session 死亡；**renderer 是唯一没有恢复链路的进程**（main 对它只打日志）。

### 2.2 真实崩溃证据（取自本机日志，非推演）

**事件 E1（9/3，pi 进程被 extension 炸死）**：`~/.xyz-agent/logs/pi-crash-2026-09-03-835c6577-*.log` 记录打包版 pi exit 1，堆栈：

```
error: This extension ctx is stale after session replacement or reload. ...
  at assertActive (/$bunfs/root/pi:238195:13)
  at sendUserMessage (/$bunfs/root/pi:238338:19)
  at onError (/Applications/TaiJi.app/.../@zhushanwen/pi-smart-context/index.js:901:33)
```

机制：smart-context 的 `compact_context` 工具是 fire-and-forget（[tool.ts:163-192](../../../../extensions/universal/smart-context/src/tool.ts)），`ctx.compact()` 的 `onError`/`onComplete` 回调**异步**触发；用户在压缩进行中切换/重载 session（GUI 高频操作），回调里的 `pi.sendUserMessage` 命中 stale ctx 同步抛错 → Bun 无人接 → 进程 exit 1 → session 死亡。**设计时点该 bug 存在**（tool.ts:183/187 裸调用；已由 U1 接入 guardStaleCtx 修复，见 §3.3 D1）；同构现场还有 [plan/compact.ts:218-229](../../../../extensions/universal/plan/src/compact.ts)（`onComplete`/`onError` 同样裸调 `pi.sendUserMessage`）。

**事件 E2（9/5 17:29，七 session 同秒连坐）**：runtime 日志 09:29:41Z 同一秒内 7 个 session 的 pi 全部 exit 143（SIGTERM），而 runtime 自身未 shutdown（之后继续日志输出）。同份日志显示 dev worktree（`fix-zcode-subagent-failed`）的 runtime 实例在用 **prod 数据目录** `~/.xyz-agent` 运行（fallback 到系统 PATH 的 pi）。归因为「dev 实例与打包版共享数据目录 + 重启/收割级联」的混合事件；确切触发者无法从现有日志定论——**这本身就是取证缺口的证据**（无内存水位、无收割决策日志、无主谋记录）。

**事件 E3（9/9 10:57，renderer OOM）**：macOS 崩溃报告 `Electron Helper (Renderer)-2026-09-09-105723.ips`：渲染进程启动 **0.31 秒**后在 libuv `uv__malloc` 帧 SIGTRAP（V8 对分配失败的处理是立即 crash）。当时系统状态：32GB 物理内存、**swap 已用 11GB/12GB**、空闲物理页约 170MB、机器 uptime 20 天。直接诱因是系统级内存耗尽，但 app 侧无任何「渲染进程死亡」的恢复与告知（见 2.4）。

**背景噪音（非崩溃但佐证）**：9/9 当天 `plugin-host worker trusted-1 exited with code 1` 出现 13 次（worker 有重建机制但无崩溃取证落盘）；runtime stderr 大量 `relay connection lost, killing child`（主 pi 死亡后经 relay kill-on-disconnect 连坐杀 subagent 子进程，[relay-registry.ts:437-442](../../../../packages/runtime/src/infra/relay/relay-registry.ts)，属预期内级联）。

### 2.3 根因分析（症状 → 根因）

| 根因 | 症状 | 根因陈述 | 证据 |
|---|---|---|---|
| **R1 extension 错误无隔离** | E1 | pi 的 extension 同进程模型下，「跨 session 生命周期存活的异步回调」在 stale ctx 上抛错即杀进程。GUI 高频触发 session 替换，把 CLI 下几乎不存在的失效窗口变成主路径。仓内已有经过验证的防御范式（scheduler 的 G1 代际检查 + F2 catch 分诊 + STALE_CTX_MARKER，[scheduler/runtime.ts:203-230](../../../../extensions/universal/scheduler/src/runtime.ts)），但设计时点**尚未共享化**，smart-context、plan 等包未接入（U1 已落地共享守卫 guardStaleCtx 并完成接入，见 §3.3 D1） | 9/3 crash log；scheduler 先例注释明确写「若无人接住即 unhandledRejection，直接崩掉 pi 主进程」 |
| **R2 renderer 零防护零恢复** | E3 的用户感知 | renderer 无 `app.config.errorHandler` / `window.onerror` / `unhandledrejection`（[main.ts:25-35](../../../../packages/renderer/src/main.ts)），任何渲染错误 = 白屏且无日志；main 对 `render-process-gone` 只打一行日志（[window-factory.ts:187-197](../../../../apps/electron/main/window/window-factory.ts) W7 注释自证「只打日志便于诊断」），无自动 reload、无用户提示。**（设计时点存在，已由 U2 修复——三件套 + renderer-log 落盘，见 §3.3 D2；行号为 v1 基线时点锚，终态 render-process-gone 恢复链挂点 = window-factory.ts render-process-gone handler）** | 代码普查；E3 崩溃后用户只能手动重开 |
| **R3 大数据传输/加载无预算** | E3 的 app 侧放大器 | session 历史加载路径无界（见 2.4 数据流图）：活跃 session 全量下发、离线 fallback 全量读、restore 附着无条件全量读；server→client 出站帧无大小限制（`maxPayload` 只管入站，[connection-manager.ts:86](../../../../packages/runtime/src/transport/connection-manager.ts)；[constants.ts:124](../../../../packages/shared/src/constants.ts) 校准注释只算了上行贴图场景）；renderer 入站 `JSON.parse` 无守卫（[ws-client.ts:224](../../../../packages/core/src/transport/ws-client.ts)）；`entryStates` 保留未截断的 tool output 全文与 base64 图片（[truncate-tool-output.ts:191](../../../../packages/core/src/domain/chat/truncate-tool-output.ts) 注释明言刻意保留）。**（设计时点存在，已由 U4 出站守卫/读取预检 + U6 分页协议 + U7 累积态截断修复，见 §3.3 D3/D4/D5 与 D6 中期项；行号为 v1 基线时点锚）** | 代码普查；单 session 累计 tee 流量 198MB 证明长会话高频大 entry 真实存在（单条体积另受 pi 工具上游约束，见术语表） |
| **R4 崩溃取证盲区** | E2 无法归因 | pi 侧取证好（pi-crash log 全量 stderr，[rpc-client.ts:811-824](../../../../packages/runtime/src/infra/pi/rpc-client.ts)），但 renderer 无任何错误落盘、main 无日志落盘通道、无内存水位打点、plugin worker 无 stderr 取证、runtime 收割/杀链动作无决策日志；且日志保留期清理只在 runtime 启动时跑一次（[logger.ts:120](../../../../packages/runtime/src/infra/logger.ts) initLogger 唯一调用点），桌面 app 长开（E3 场景 uptime 20 天）下超龄日志无任何清理触发。**（设计时点存在，已由 U5 修复——main 落盘/水位打点/pi-crash 上下文头/plugin-crash/杀链决策日志/每日清理定时器，见 §3.3 D6；行号为 v1 基线时点锚）** | 本次调研 E2 归因失败的直接体验；logger 清理触发点代码实证 |

### 2.4 物理数据流：session 历史从磁盘到用户眼前

```
磁盘 ~/.xyz-agent/pi/agent/sessions/<cwd-slug>/<ts>_<sid>.jsonl（实测最大 6MB；
pi-*.jsonl tee 累计流量达 198MB = 长会话高频大 entry 真实流入的证据；
单条工具结果体积受 pi 工具上游约束：read/bash 类工具自截输出 50KB/2000 行、图片 ≤16MB）
│
├─【活跃 session】pi 进程内存 entry 树
│    → RPC get_entries（不截断）
│    → history-rebuild-cache.ts:229-241 doGetHistory 全量重建 Message[]，truncated:false
│
└─【离线 session】session-history.ts 尾读窗口 640KB
     → 窗口内凑不够 20 个 user turn → fallback readFile 全量 + parseJsonl（:170-181）
     →「加载更多」（现状已存在，use-session.ts:272-276）getFullHistory 永远全量读全量传（:78-98）
     →【restore 附着】services/session/restore-seeding.ts:135-148
       normalizeInactiveSessionFileIfNeeded 每次附着无条件 readFileSync 全量读（:140）
       （session-lifecycle.ts:707/:898 调用）
       ★ D7 自动 respawn 会把它变成崩溃后 5 秒自动触发的内存尖峰（恢复侧恶性循环）
     → 每次 pi 退出时 extractSessionOutcome 的 findLastEntryField
       32KB 尾读未命中 → fallback readFileSync 全量同步读（session-file-utils.ts:522-530）
       ★ 崩溃收尾动作本身变成内存尖峰触发器（退出侧恶性循环）
│
→ session.history 单条 JSON reply（message-broker.ts:76 send，无大小限制）
→ renderer ws-client.ts:224 JSON.parse（V8 内 UTF-16 双倍膨胀 + 对象图数倍放大，
  峰值可达文件体积 4-8 倍）
→ ChatStore.hydrate 全量进 messages Map + entryStates 全量累积（LRU=8 是唯一总量帽）
→ Virtualizer 虚拟滚动渲染（DOM 侧已窗口化，健康；瓶颈在内存对象图，不在 DOM）
```

**无界点标注（设计时点状态，①-⑥ 均已由终态治理取代）**：① 活跃路径全量不截断（已由 U4 双预算截断修复）；② 离线 fallback 全量（已由 U4 ②档分块扩窗修复）；③ 出站帧无上限（已由 U4 出站帧守卫修复）；④ 入站 parse 无守卫（随 ③ 上游帧大小有界而消除）；⑤ entryStates 无截断（已由 U7 累积态截断 + 图片落盘治理修复）；⑥ restore 附着无条件全量读（已由 U4 ⑤档最小规范化修复，v9 降级形态）。①②③④⑥ 属本方案短中期治理，⑤ 属中期治理（上文数据流图与本节行号均为 v1 基线时点快照）。

### 2.5 现有防线盘点（保留并复用，不重造）

| 已有防线 | 位置 | 本方案态度 |
|---|---|---|
| runtime supervisor：退避重启（1-16s×5）、liveness 30s×3、孤儿 pi 收割（三重防误杀：argv --session-dir 精确相等 + ppid=1 + 单实例锁） | apps/electron/main/supervisor/ | 复用，不动 |
| uncaughtException 分级策略（流错误续命/其余 graceful shutdown） | runtime/index.ts:771-778 | 复用，不动 |
| pi 工具上游自截（read/bash 类工具自选截断输出 50KB/2000 行、图片 ≤16MB） | pi 实装（truncate.js、bash.js） | 复用——单条消息体积现状的第一道既有防线；D3 是它身后的纵深 |
| pi-crash log（全量 stderr 落盘，靠 `pi-` 前缀被保留期清理覆盖） | infra/logger.ts:489 写入、:329-330/:476-477 清理 | 增强（补 runtime 侧上下文头，D6） |
| WS 断连 10s 宽限 + ring 回放 + gap 检测 + resubscribe | core/transport/use-connection.ts | 复用，不动；**与 D3 的交互是设计要点**（见 D3） |
| finalizeAllStreaming（isGenerating 不卡死） | core/domain/chat/store.ts | 复用，不动 |
| 消息列表虚拟滚动 + markdown 增量缓存 + LRU=8 | renderer/core | 复用，不动 |
| renderer 侧 truncateToolCall 投影（read/bash/cat/grep/glob/list 六类工具 4KB；write/edit 刻意不截） | core/src/domain/chat/truncate-tool-output.ts:32-34 | 复用——D3 代价 C 的前提（见 D3） |
| scheduler stale-ctx 防御范式（G1+F2+STALE_CTX_MARKER） | scheduler/runtime.ts | **泛化提取到 ext-guards**（D1） |
| ext-guards 共享守卫包（oncePerProcess 等，零依赖纯函数） | extensions/shared/ext-guards | 作为新守卫的落点 |
| 错误 envelope 收口（type:'error' 且 id 命中 pending 的 reply 使前端 Promise reject，不悬挂） | core/transport/api/pending.ts:186-214 | 复用——D3 截断档的 reply 替换走此既有链路 |

---

## 3. 解决方案

### 3.1 终态（使用者视角先行）

**本章结论：五个崩溃场景的用户体验从「无声死亡/白屏」变为「自动恢复 + 可见提示 + 可查日志」。**

**场景 T1（extension 回调出错，对应 G1）**：用户在 session A 触发 `compact_context` 压缩，压缩进行中切到 session B。压缩失败回调触发时 ctx 已失效——守卫捕获 stale 错误，写一条扩展 debug 日志，pi 进程**继续存活**。用户切回 session A，对话照常；唯一的痕迹是 `~/.pi/agent/logs/` 里一条守卫降级日志。失败路径：若压缩本身失败（非 stale），用户仍在对话流收到「压缩失败：…可稍后重试」steer 消息（现有行为保留）。

**场景 T2（renderer 崩溃，对应 G2/G5）**：用户打开一个超大 session，renderer 内存打穿死亡。窗口在 1 秒内自动 reload，顶部出现一次性提示条「界面已从崩溃中恢复（原因：内存不足），你的会话数据未丢失」；main 进程日志有 `render-process-gone reason=oom` 与崩溃前 renderer 自报的 JS 错误、内存快照（`logs/main-<date>.log` + `logs/renderer-error-<date>.log`）。失败路径：reload 后 60 秒内同一窗口再次崩溃，按窗口计数熔断（3 次），该窗口停在静态错误页：「界面反复崩溃，请尝试重启应用。诊断日志位于 ~/.xyz-agent/logs/」，附「重试」按钮；其他窗口不受影响。

**场景 T3（大 session 历史与大消息，对应 G3）**：用户打开历史 6MB 的 session。runtime 按预算（20 turns / 640KB 起，可配）返回最近历史 + `truncated: true`；对话流顶部显示「已加载最近 N 轮 · 加载更早」按钮；点「加载更早」按分页游标向前翻页，已翻到的历史在切出再切入后仍在（不丢）。会话进行中出现超限单帧（如 MCP 外部工具的大结果、未来上游截断失效）时，该条消息在 runtime 发送前被原地截断为占位内容（「内容过大（XX MB）已在传输层截断，完整内容见 session 文件：<路径>」），**其余消息照常送达、seq 连续、断连重连后回放到的也是同一份截断内容**；runtime 日志记一条大帧告警。失败路径：renderer 收到截断占位或超限错误 envelope 时正常渲染降级提示，不抛错不白屏。

**场景 T4（pi 崩溃自动恢复，对应 G4）**：活跃 session 的 pi 进程被 kill。runtime 检测到非主动退出 → 写 pi-crash log（含 sessionId、历史文件路径、最后 RPC 命令、内存水位头）→ 标记 session dead → **5 秒后自动 respawn**（总恢复耗时约 5-10 秒，含 spawn 与附着）并附着原历史文件（附着走预算化的 restore 路径，不再无条件全量读）→ 对话流插入系统提示条「会话引擎已从崩溃中恢复。中断的回合未保留；崩溃时进行中的后台任务与子代理已终止、不会自动恢复。可继续发消息。」。恢复进行中用户恰好发消息：消息等待恢复完成后继续发送（不报错、不双跑）。失败路径：respawn 连续失败 2 次（同参数再起再崩，或附着遇 cwd 死路径硬拒绝）→ 停止重试，提示条变为「引擎恢复失败，点此重试或新建会话」，session 保持 dead 但不影响其他 session；用户**手动强制退出**的 session 不触发自动恢复。

**场景 T5（崩溃后取证，对应 G5）**：任何一层崩溃后，用户/开发者打开 `~/.xyz-agent/logs/`：runtime 日志有每 5 分钟一行的内存水位（rss/heapUsed）与杀链决策日志（谁触发、杀了谁、为什么）；main 日志有 render-process-gone 详情与自身水位；pi-crash log 有上下文头；renderer-error log 有 JS 栈；plugin worker 崩溃有 plugin-crash log。**logs/ 目录全部文件**（含既有 stderr 文件）纳入清理/轮转策略且清理在 app 长寿运行期间持续触发（不只启动时），目录体积不失控。五类日志交叉可回答「哪层、哪个 session、为什么」。

### 3.2 总体方案对比

| 方案 | 长期架构 | 短期成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A 分层防线（选）**：按崩溃面分五道防线，每道独立落地独立验收；短期形态先做止血（守卫/恢复/预算/打点），中期形态做协议级治理（分页/引用化/自动恢复） | 高：每道防线对应一个真实崩溃面，防线间无耦合；中期形态是长期架构（session 隔离）的地基——先有取证（G5）才知道隔离是否必要 | 中：5+3 个实施单元可并行 2-3 个；复用既有范式（scheduler 守卫、supervisor、LRU、envelope 收口） | 各防线独立失败不互相拖累；主要风险是历史分页协议的前后端联动改动面与 seq/ring 语义的正确性（D3 专门设计） | 采用 |
| B 单点修补：只修 smart-context bug + render-process-gone reload | 低：其余实锤根因（R3 传输无预算、R4 取证盲区）原样保留，下一个大 session 或下一次 E2 型事件仍然无解 | 最低 | 治标不治本；E2/E3 类崩溃复发率无变化 | 否决——若用它，§2.2 的 E3 场景（系统内存紧张 + 大 session）下用户依旧白屏无痕 |
| C 一步到位：runtime 多进程 session 隔离 + 全量遥测体系 | 最高（理论） | 极高：WS 网关/状态聚合全重写；且没有崩溃遥测数据支撑，隔离粒度只能拍脑袋 | 大改动引入新故障面的风险大于收益；无取证数据时做隔离是盲动 | 否决（降为长期项）——先落地 G5 取证，用真实崩溃数据论证隔离方案 |

### 3.3 关键决策与权衡

**D1：extension 异步回调守卫——泛化 scheduler 范式到 ext-guards（短期，对应 R1/G1）**

- **采用**：在 `extensions/shared/ext-guards`（零依赖纯函数共享包，既有定位即「pi 运行环境隐式坑的守卫集中一处」）新增守卫函数 `guardStaleCtx(fn, opts)`：① 前置代际检查（调用方注入 `isCtxStale()`，同 scheduler G1——模块级代数计数器，session_start 递增，旧代闭包捕获值小于模块值即 stale）；② `fn` 同步执行，抛错时按消息是否含 `stale after session replacement` 分诊——stale 类静默降级（调 `opts.onStale`，默认写 debug 日志），非 stale 类**原样上抛**（守卫不吞真实 bug）；③ 所有 fire-and-forget 异步回调（`compact` 的 onComplete/onError、timer tick、延迟 setTimeout 回调）接入。首批改造 smart-context（tool.ts:183/187 两处实锤崩溃点 + index.ts 三处 `pi.sendUserMessage` 已接入守卫）与 plan/compact.ts:218-229 两处；scheduler 迁移到共享守卫（语义等价性由 U1 普查逐条比对：G1 前置检查、F2 catch 分诊、retireStaleTimer 自停三件套缺一不可）；subagent-workflow 的 notifyDone/sendDelivery 已接入守卫（实施期审计发现的 E1 同机制崩溃面，impl-plan 偏差 D6 闭环）；其余 extension 按 §5 普查清单逐项确认或排除（接入终态 SSOT = extensions/shared/ext-guards/docs/stale-ctx-audit.md §2）。**每包接入时必须填写「stale 静默语义」判定**（stale 时静默意味着什么——smart-context：压缩结果不投递，用户可重试 `/compact`；plan：执行消息不投递，用户可手动 Read plan 文件执行），判定表是 U1 的交付物之一。
- **降级语义声明**：无代际计数器的接入方完全依赖错误文案子串兜底分诊。该文案是 pi 的实装行为（当前 0.84.4 实装匹配，runner 层 assertActive 抛出），属 pi 语义断言——**必须登记进 C-proc-08 pi 版本门禁的探针族**（`scripts/check-pi-semantics.mjs`），pi 升级时自动重验文案稳定性；文案变更时守卫退化为「全部上抛」（回到现状，不更安全但也不更危险——上抛的崩溃链路与 E1 相同，有 pi-crash log 取证），门禁探针报红提示更新分诊词。该退化是**有痕退化**（门禁红 + 崩溃日志在），不构成静默失效。
- **被否**：① 各 extension 各自内联 try/catch——防线散落正是 ext-guards 的存在理由（其包注释明言「防线不再散落各包内联」），且 21 个包各自实现必然漂移；② 在 pi 上游修——违反仓规 [MANDATORY] 不改 pi；③ runtime 适配层兜底——做不到，extension 跑在 pi 进程内，runtime 管不到 pi 进程内异常；④ 守卫吞掉所有错误（不只 stale 类）——会把真实 bug 静默成日志，违反「失败要出声」。
- **证据**：9/3 pi-crash log 实锤堆栈（E1）；scheduler/runtime.ts:203-230 已验证范式（其注释即上一次同类崩溃的事后固化）；pi 实装 assertActive 同步抛错行为（崩溃堆栈帧 `assertActive → sendUserMessage`）。
- **效果**：G1 成立——extension 回调错误不再杀 pi 进程；T1 场景成立。

**D2：renderer 错误边界 + main 进程自动恢复（短期，对应 R2/G2）**

- **采用**：三件套 + 一条恢复链。① renderer 全局错误捕获：`app.config.errorHandler` + `window.onerror` + `unhandledrejection`（实现为 addEventListener('error') 等价捕获面，不覆盖第三方 onerror 注册），捕获后写日志并抑制 Vue 默认整树卸载（errorHandler 内不再上抛）；② 新增 IPC 通道 `renderer-log`（沿用 preload 既有 `ipcRenderer.invoke` 惯例，[preload.ts:189](../../../../apps/electron/preload/preload.ts) 模式），main 进程接收后落盘 `logs/renderer-error-<date>.log`（每条含时间戳/错误栈/`performance.memory` 快照/当前 sessionId/windowId）；**风暴防护：IPC 按 windowId 限流（每窗口每分钟最多 100 条，超限计数合并为一条汇总行）**——renderer 错误风暴不能分钟级刷 GB；③ main 的 `render-process-gone` 处理器从「只打日志」改为：详情落盘 + **按窗口自动 reload**（熔断计数器以 windowId 为键，60 秒滑动窗口内 ≤3 次），超限停静态错误页 + 手动重试按钮（T2 失败路径），多窗口互不影响。
- **被否**：① 错误经 WS 转发 runtime 落盘——renderer 崩溃/断连时 WS 恰好不可用，崩溃瞬间的最后一错必丢；main 是四层中生命周期最长的进程，是最可靠的落盘点；② 无限自动 reload——OOM 类崩溃 reload 后大概率再崩，无熔断 = 崩溃循环烧内存；③ 启用 Electron `crashReporter` 收 minidump——无上传通道，本地 dump 解读成本高，`render-process-gone` 的 reason + renderer 自报 JS 栈已够分诊，列为未来可选项不进本方案。
- **证据**：window-factory.ts:187-197 现状（W7 注释「只打日志」）；main.ts:25-35 无任何错误处理；9/9 E3 崩溃报告（reason 可由 details 字段获取）；main 无 console 落盘通道（2.1 结构事实）——故落盘 writer 需新建（见 D6-①）。
- **效果**：G2、G5（renderer 侧）成立；T2 场景成立。
- **已接受代价 A（量化四要素）**：崩溃瞬间正在执行的 JS 错误可能来不及经 IPC 送达 main——量级：崩溃前最后一帧的错误，概率低且每次崩溃最多丢一条；恢复路径：main 侧 `render-process-gone` 的 reason/exitCode 落盘兜底分诊；重审触发：若出现「白屏但两侧日志都无记录」的实际案例，升级为 crashReporter 本地 dump；显式判定：可接受。
- **已接受代价 B**：自动 reload 丢失该窗口未发送的输入草稿（composer 草稿现状只持久化 model/thinking 配置，文本草稿不进 KV）——量级：每次 reload 至多丢当前窗口一条草稿；恢复路径：无自动恢复，用户重输；重审触发：用户反馈草稿丢失即把「草稿进 KV 持久化」升级为独立改进项；显式判定：可接受（reload 是唯一恢复通道，不 reload 的代价是白屏）。

**D3：server→client 出站帧大小守卫（短期，对应 R3/G3）**

- **定位校准（防过度设计）**：单条消息体积现状已有 pi 工具上游自截兜底（read/bash 类 50KB/2000 行、图片 ≤16MB，2.5 防线表），**32MB 截断档不是高频路径而是防御纵深**——超限风险面 = MCP 外部工具的大结果（`tool_call_end` 与 `message_end` 双路下发）、write 类工具的大参数（写入全文在 `tool_call_start` 帧的 `entry.arguments`，toolResult 本身只是小确认）、pi 未来行为变化、注册表 miss。8MB 告警档的价值是**哨兵**：上游截断一旦失效（新工具类型、pi 升级），告警立即暴露。
- **采用**：按消息通路分两种守卫形态，**判别依据 = 消息是否带 pending 请求 id（reply）还是 push**：
  - **RPC reply 通路**（message-broker.ts:76 send 中带请求 id 的回复，典型 `session.history` 响应）：序列化后超截断档（默认 32MB）→ 替换为错误 envelope（`code: 'payload_too_large'`，message 含恢复指引：「该内容过大无法传输，请用『加载更早』分页查看或查阅 session 文件」）。前端 pending.ts:186-214 既有逻辑对 type:'error' 且 id 命中 pending 的 reply 走 reject，**Promise 正常收口不悬挂**（代码已核实）。
  - **push 通路**（message-bus.ts publish，session 级推送，帧形态 `{payload:{sessionId, entry}}`——大内容在 entry 内部字段，不在 payload 顶层）：守卫挂 publish 入口（topicOf 三分类流转之前，:290 附近；**实现时序 = seq 预写 → 守卫判定 → drop 时 rollbackSeq 回滚**——同步单线程内可观察等价于「seq 分配前判定」，论证见 impl-plan 偏差 D2 与 outbound-frame-registry.ts JSDoc）。超限消息按「契约保持式截断」原地替换：消息类型不变，按**帧内字段路径注册表**定位大字段并替换为占位文案（「内容过大（XX MB）已在传输层截断，完整内容见 session 文件：<路径>」），截断版正常占 seq、按三分类流转（stream 类入 ring 随 seq 回放；state 类更新订阅快照；transient 类直发）、广播。效果：客户端收到截断版，ring 存截断版，断连回放与重订阅拉到的都是同一份截断版——seq 连续性、gap 检测、live≡reload 三者的语义全部不被破坏。
  - **大字段注册表（帧内路径坐标系）**：注册表登记的是 **WS 帧内的字段路径**（`payload.entry.*` 等），不是 runtime/renderer 内部的归一化对象——归一产物（normalize-tool-result 的 output/outputRaw/images/details 四字段）是 renderer 侧投影，**不进 wire 帧**，登记它们截不到任何东西。**替换形态（block 级契约）**：`entry.message.content` 是 block 数组（text/image/thinking 等），截断时整个 content 字段替换为 `[{type:'text', text:'<占位文案>'}]`——对齐仓内权威先例（event-interpreter.ts 的 hook 改写分支即整字段替换为 text block 数组，注释明言「保持 pi 持久化形态」）；不逐 block 部分替换（保数组结构合法 + reducer 对 content 形态的既有兼容）。**初始注册表（源码实证的帧形态；终态 8 条）**：
    - `message.message_end` 帧的 `payload.entry.message.content`——**全部持久化 entry（user/assistant/toolResult/custom）的实时权威载体**（event-adapter.ts:944-950，注释自证「live≡reload 协议层依据」）；图片在 content 数组的 Image block 内（entry 无独立 images 字段）；贴图消息的超限大字段就在此帧。
    - `message.tool_call_end` 帧的 `payload.entry.message.content`（工具结果文本/聚合内容，event-interpreter.ts:1088-1096）——与 message_end 双路下发的同一 tool result，两帧都注册、占位文案一致，保证帧间一致。
    - `message.tool_call_start` 帧的 `payload.entry.arguments`（工具参数全文，event-interpreter.ts:1031-1038）。**非 content 条目的形态契约（类型保持）**：`arguments` 是 record 类型（「畸形值不得以谎报类型进 wire 帧」的注释约束），占位替换为类型保持的 record `{truncated: true, reason: string, originalBytes: number}`——与 content 的「整字段替换为 text block 数组」同构：类型不变、只换载荷。
    - `session.traceEntryAppended` 的 `payload.entries[]`（数组形态——整体替换为单元素占位数组，元素形态与原元素同型）；`session.subagentEntriesAppended` 的 `payload.entries[]` 与 `subagent.stream_delta` 的 `payload.lines`（**U4 穷举新发现补入**：subagentEntriesAppended 是与 traceEntryAppended 同构的 subagent entry 增量帧，relay-tee.ts:120；stream_delta 的 lines = 累积全文 split('\n')，字符串数组——单元素占位）。
    - `message.bashResult` 的 `payload.output`、`terminal.data` 的 `payload.data`（**U4 穷举新发现补入**，message-dispatcher.ts:1042 / terminal-service.ts:113）。**string 类形态契约（类型保持）**：字符串类大字段的占位替换为**占位文案字符串本体**——与 content/record/数组占位同构（类型不变、只换载荷），设计未预定义 string 类形态，按 impl-plan 偏差 D3「类型保持同构」原则收口。
    **终态注册表 SSOT = `packages/runtime/src/services/message-bus/outbound-frame-registry.ts` 文件头穷举表**（8 条登记 + 判定不登记逐类留痕），本表为设计时点快照——新增 publish 点引入新的大字段帧类型时以该文件为准。
    **完备性由 U4 实施期静态穷举保证**：grep 全部 publish 调用点（实测 40+），逐类型列出帧内大字段路径，穷举表固化进代码常量并作为 U4 交付物。**miss 兜底**：截断后仍超硬上限、或注册表未覆盖该类型的超限消息 → 整条丢弃 + error 日志。**miss 不占 seq**（可观察等价于 seq 分配前丢弃；实现为 seq 预写 + drop 时 rollbackSeq 回滚，同步单线程内无观察窗口——论证见 impl-plan 偏差 D2 与 outbound-frame-registry.ts JSDoc，不触发 gap）。
  - **告警档**（默认 8MB）两种通路共用：写 warn 日志（消息类型、sessionId、字节数）。
  - 阈值进 shared constants（与 MAX_WS_PAYLOAD_BYTES 并列，注释校准依据：renderer 堆上限 × 安全系数 ÷ UTF-16 膨胀系数）。
- **被否**：① 用 ws 库 `maxPayload` 管双向——ws 的 maxPayload 只限入站，出站无此能力（代码已证，见 §2.3 R3）；② 只告警不截断——超限帧打到内存紧张的 renderer 就是 E3 重演，告警不救命；③ 流式分片传输——改动协议层，属长期项；④ **守卫放广播点（seq 分配后）丢弃超限 push**——被反例击穿：该消息占着 seq 与 ring 槽位但客户端收不到 → gap 检测判丢帧 → 触发重订阅全量拉取 → 拉取回复仍含同一巨帧再被整体替换（连 stateSnapshot 一起丢）→ 重订阅失败 → 之后每条消息再触发 gap——该 session 进入永久「gap-重订阅失败」死循环。改为 seq 分配前的契约保持式截断后，反例各环均不成立（截断版正常占用 seq 并送达，无 gap 可判）。
- **证据**：ws-client.ts:224 入站裸 parse；connection-manager.ts:86 maxPayload 仅入站；message-bus.ts publish 先分配 seq + topicOf 流转（:238-262）后广播（:386-390）的顺序实证；pending.ts:186-214 错误 envelope 收口实证；push 帧形态与大字段位置的源码实证（event-adapter.ts:901-930 持久化 entry 权威载体、event-interpreter.ts:611-622/:673-681 工具帧）。
- **效果**：G3 的传输段成立——任何单帧不再能打穿 renderer；T3 的截断降级路径成立。
- **已接受代价 A（量化四要素）**：截断档触发时该条消息功能降级（用户看到占位文案而非内容）——量级：正常流量不触发（pi 上游自截约束单条体积），命中面 = MCP 大结果/write 大参数/上游失效，属低频防御场景；恢复路径：占位文案含 session 文件路径 + 「加载更早」分页入口；重审触发：截断告警周均 >10 次时重估阈值或上游截断；显式判定：可接受（降级 > 白屏）。
- **已接受代价 B（量化四要素，miss 兜底）**：注册表 miss 的超限消息整条丢弃，该消息用户不可见——量级：初始注册表已覆盖源码实证的全部已知帧形态（含 message_end 权威载体），miss 仅在「新增 publish 点未登记」时发生，且 8MB 告警档先于截断档暴露（miss 消息必然先打告警日志）；恢复路径：error 日志含消息类型与体积 → 补注册表后同类消息恢复；重审触发：任何一次 miss 类 error 日志出现即视为注册表维护流程失效，检查 U4 穷举表是否被绕过；显式判定：可接受（最后防线性质，且有告警前置暴露）。
- **已接受代价 C（live/reload 可见差异，诚实版）**：push 截断后，live 期 renderer 收到占位文案；重开重载时从文件读全量。**用户可见行为对六类截断工具（read/bash/cat/grep/glob/list）一致**（renderer 侧 truncateToolCall 投影同为截断形态——live 是占位、reload 是前 4KB，形态近似）；**对非六类工具（write/edit/MCP 等）存在可见差异**：live 显示占位文案、reload 显示完整大文本——且 reload 路径的内存压力回归（entryStates 累积全文）。量级：命中前提是该工具结果单帧 >32MB（低频防御场景，与代价 A 同域）；恢复路径：U7 中期统一截断层（reducer 累积态与 hydrate 路径应用同一截断，live≡reload 构造性恢复）；重审触发：**首个「重载后显示完整大文本且与在场时不同」的用户可见案例**；显式判定：短期可接受（可见差异仅在低频防御场景兑现，且 U7 是已排期的根治）。
- **负面行为声明**：push 截断不得影响 seq 连续性（gap 检测不得因截断误触发）；reply 截断不得导致前端 Promise 悬挂。两者在 §4 A10 验收。

**D4：session 历史字节预算（短期）→ 分页协议（中期）（对应 R3/G3）**

- **采用**：短期——活跃 session 的 `doGetHistory` 与离线尾读合并为同一预算逻辑：按「最近 N turns（默认 20）且总字节 ≤ 预算（默认 640KB，对齐现有离线窗口）」双条件截断，响应携带 `truncated`、`loadedTurns`、`totalTurnsEstimate`；renderer 据 `truncated` 显示「加载更早」按钮。**切分粒度声明**：预算作用于 turn 的选择；**单 turn 内 entry 不切分**（entry 原子性——切 entry 会破坏 reducer 幂等与 parentId 链）；若最近一个 turn 自身就超预算（如单条 3MB tool result 的 turn），该 turn 仍完整返回（保证对话可见性连续），响应的 truncated/字节统计如实反映超出——极端 turn 交给 D3 传输层帧守卫与 U7 累积态截断兜底。**与现状「加载更多」（getFullHistory 全量）的关系**：短期阶段「加载更多」按钮保留但底层走 D5 的预检+逆序分块读；中期分页协议落地后替换为游标翻页，getFullHistory 全量通路退役。中期——统一分页协议：`session.history` RPC 增加 `{cursor?, limitTurns?, maxBytes?}` 参数，游标 = turn 边界锚点（entryId），活跃/离线两路径共用；renderer「加载更早」按游标向前翻页并 prepend 进消息列表。
- **接管既有流程的副作用归属**（切入已 hydrate session 时的 reconcile 刷新，use-session.ts:267-281）：现状 reconcile 用全量响应整体覆盖 store；预算化后响应只含最近窗口——reconcile 遇 `truncated: true` 响应时语义改为「仅合并覆盖最近窗口内的消息，已加载的更早历史保留不动」，禁止整体替换（否则「加载更早」翻到的历史会在下次切入时被静默清掉）。该合并语义由 U6 实施期验证（探针 P-paging 同窗口覆盖）。
- **live≡reload 不变量 re-scope**：仓规规则 9 [HISTORICAL] 的 apply-entry-equivalence 守卫「在场累积 ≡ 重开重放」。预算化后该不变量的比较域从「全量历史」re-scope 为「预算窗口内」——窗口内两通路共用同一 reducer 与同一预算，等价性构造性成立；窗口外历史在场期间可见（累积）、重开后需翻页恢复，属行为变化而非等价性破坏；**例外**：D3 代价 C 声明的非六类工具超限帧 live/reload 可见差异（低频防御场景），在 U7 统一截断层落地后消除。等价性测试的断言域同步调整归 U6。
- **被否**：① 只截断不提供翻页——用户无法查看完整历史，功能倒退；② renderer 侧流式解析超大 JSON——WS 单帧模型下无真流式，且 parse 只是问题之一，对象图驻留才是内存大头；③ 提高预算硬扛（如全量加载 50MB）——E3 证明系统内存紧张时 renderer 堆余量可能只有几十 MB，硬扛无安全边际。
- **证据**：history-rebuild-cache.ts:229-241（活跃全量不截断）；session-history.ts:170-181（离线 fallback 全量）；use-session.ts:272-276（现状「加载更多」全量通路存在）；本机实测最大历史文件 6MB、单 session 累计流量 198MB。
- **效果**：G3 的加载段成立；T3 场景完整成立。
- **探针依赖**：活跃 session 按 turn 截断依赖 pi `get_entries` 返回的 entry 树可按 turn 边界切分——runtime 侧 entry→Message 重建已按 turn 聚合（history-rebuild-cache 既有逻辑），切分点在重建后的 Message[] 上做，不依赖 pi 行为，风险低。
- **已接受代价（量化四要素）**：默认视图从「全量历史」变为「最近 20 turns」——量级：本机最大历史 6MB（数百 turn），老 session 默认只显示尾部；恢复路径：「加载更早」翻页通道始终存在；重审触发：翻页操作成为高频用户抱怨时评估提高默认预算或做智能预取；显式判定：可接受（CLI 场景用户同样只看可见区域，且翻页通道存在；代价换来的是 OOM 免疫）。

**D5：runtime 全量读路径预检与逆序分块读（短期，对应 R3/G3）**

- **采用**：给五条全量读入口统一加 statSync 大小预检（阈值默认 32MB，constants 集中），超限行为按调用方语义分档：
  - ① `getHistoryFromFilePath`（session-history.ts:78-98）——消费方枚举：**getSubagentHistory / getAgentCallHistory（services/session/session-records.ts:325/:447 复用同链路——subagent 历史恰是巨型 JSONL 高发源）**。[u6] 全量通路退役后①档消费方收窄为 subagent/agent-call 历史（前端「加载更多」改走游标翻页，见 A11③）。超限 → 逆序分块读返回最近预算窗口 + truncated 标记（不拒绝——这些通路的价值就是给内容，拒绝等于功能缺失）。
  - ② 尾读 fallback（session-history.ts:170-181）——超限 → **分块扩窗**替代全量读：从尾部按 1MB 块向前扩窗扫描，直到凑够 20 turns 或读到文件头（总读取量上限 32MB，读到上限仍未凑够则返回已凑部分 + truncated 标记）。消除「凑不够就全量读」的现行 fallback。
  - ③ `findLastEntryField` fallback（session-file-utils.ts:522-530）——超限 → 逆序分块读（找「最后一条某字段」只需从尾向前扫，命中即止）。消除「每次 pi 退出都可能全量同步读巨文件」的恶性循环。
  - ④ `readSessionJsonlText`（infra/pi/session-store.ts:92-99）——消费方 = trace-sync 的 Trace 视图（services/session/trace-sync.ts:126/:260，既有契约：文件缺失返回 null → 空态视图）。超限 → 返回明确的 oversize 标记（**不返回 null**，不与「文件缺失」混淆），Trace 视图渲染降级态：「Trace 过大无法渲染（XX MB），源文件：<绝对路径>」。
  - ⑤ **restore 附着路径**（services/session/restore-seeding.ts:135-148 `normalizeInactiveSessionFileIfNeeded`，session-lifecycle.ts:707/:898 调用）——现状每次附着无条件 `readFileSync` 全量读（:140）。超限 → 跳过 normalize + warn 日志。**【实施期裁定（v9）】主形态经 P-restore-skip 交付门裁决不安全**（pi 0.84.4 实装 _buildIndex 对尾部无 id session_end → leafId=undefined 静默断链失忆），**已按本决策预设降级路径执行：逆序分块最小规范化**（尾扫 session_end 判定 + 首保留行 cwd fallback + 分块流式 strip，驻留有界）。**该路径与 D7 直接耦合**：自动 respawn 把附着变成崩溃后 5 秒自动触发的动作，不预检则「恢复动作变内存尖峰」的恶性循环只斩断了退出侧（③）、恢复侧被 D7 放大。
  - **⑤跳过的风险本质（必须完整声明，两个半边）**：normalize（restore-seeding.ts:135-148）做三件事——残留清扫（:139）、全量读+判定（:140-141）、变换落盘（strip legacy `session_end` + applyHeaderCwdFallback，:144-146）。
    - **失忆半边**：legacy `session_end` 行使全部旧历史不进 LLM 上下文（:49-55 注释明文，pi `_buildIndex` 断链）——**静默 AI 失忆**：session「看起来正常」（消息流、收发都好）但 AI 上下文缺旧历史。
    - **cwd 半边**：applyHeaderCwdFallback 修复 header 中已删除目录的 cwd 死路径——跳过后若 header 记录的 cwd 已不存在（本仓 worktree 大量删建下非罕见），pi switchSession 抛 `MissingSessionCwdError` **硬拒绝，附着直接失败**——不是静默，是显式失败，走 D7 的 restoreFailed 熔断链路（T4 失败路径）。
    - **残留清扫（:139）随跳过的归属**：cleanupMigrateResidues 是幂等清扫（残留文件留着，下次附着或常规路径再扫），跳过无累积风险，声明放弃本次执行即可。
    - 因此 P-restore-skip 的断言必须**双分支**：附着成功分支验「LLM 上下文含旧历史」（失忆半边），附着失败分支验「MissingSessionCwdError → D7 熔断提示」（cwd 半边）。降级路径：任一半边不安全 → ⑤档改逆序分块读做最小规范化——**尾部扫 legacy session_end + 首行单独读 header 做 cwd 修复**（首行是短 JSON，读它不构成内存压力；与尾部最小规范化同型，成本极低）。
- **被否**：① 全面换流式 JSONL 解析库——引入新依赖与新断言面，逆序分块读已覆盖真实高频路径（③每次 pi 退出触发、⑤每次附着触发）；② 不设阈值全量读到底——E3 同期的内存环境下，一次大文件全量读 + parse 就是 runtime OOM 的直接引信；③ ①④ 一律拒绝——subagent 历史与「加载更多」的内容供给被砍，功能倒退（逆序分块读能给出最近窗口，更优）。
- **证据**：五条路径代码已定位；③的触发频率证据：extractSessionOutcome 在每次 pi 退出时调用（session-service.ts:332）；⑤的触发证据与双半边风险：services/session/restore-seeding.ts:135-148（无条件 readFileSync :140）+ :49-55 失忆注释 + :144-146 cwd fallback + pi switchSession 硬拒绝语义（:78-107/:121-125 注释）；①的 subagent 消费方实证（services/session/session-records.ts:325/:447）；④的空态契约实证（services/session/trace-sync.ts:126/:260）；本机存在 104MB/198MB 级 tee 流量的大 session 佐证文件级风险真实。
- **效果**：G3 的 runtime 段成立（加载、退出收尾、恢复附着三侧的恶性循环全部斩断）；T4 的「附着走预算化 restore」成立。
- **已接受代价（量化四要素）**：超 32MB 文件的 Trace 视图不可用（降级为路径提示）——量级：当前观测最大历史文件 6MB，触发率现状为 0%，仅巨型 subagent 历史未来可能命中；恢复路径：提示含文件绝对路径，文件系统直接查看；重审触发：首个真实命中案例出现时评估 Trace 视图的流式渲染；显式判定：可接受（低频视图降级 > 整机 OOM 风险）。

**D6：崩溃取证与内存水位观测（短期打点 + 中期治理，对应 R4/G5）**

- **采用**：短期（纯打点，零行为变更）——
  - ① **main 进程日志落盘通道**（新建）：main 侧新增简易 writer（`logs/main-<date>.log`），**date+size 双策略轮转**（对齐 runtime logger 惯例——限流 100 条/分/窗口折算的持续风暴单日可写数百 MB，无 size 帽不行），承接 main 侧内存水位（每 5 分钟 `process.memoryUsage()`）、render-process-gone 详情、renderer-log IPC 的转发落盘。**事实修正**：main 现状无 console→文件重定向（打包版 stdout 无人收集），故 main 落盘必须显式新建，不能假设「console 已落盘」。
  - ② runtime 内存水位定时器：每 5 分钟一行（rss/heapUsed/heapTotal/external + 活跃 session 数 + pi 进程数），走既有 logger。
  - ③ renderer 每次 `renderer-log` IPC 附带 `performance.memory` 快照（探针 P-mem 验证可用性）。
  - ④ pi-crash log 头部补 runtime 侧上下文：sessionId、历史文件绝对路径、最后一个 RPC 命令类型、进程 uptime、当时内存水位。
  - ⑤ plugin worker 崩溃落 `plugin-crash-*.log`（对齐 pi-crash 形态，tee worker stderr）。
  - ⑥ runtime 杀链动作（reapOrphanPiProcesses、relay kill-on-disconnect、supervisor 重启决策）打决策日志（谁触发、杀了谁、为什么）——E2 归因失败的直接修复。
  - ⑦ **logs/ 目录写入面的清理通道全覆盖 + 持续触发（与写入同步落地，缺一不可）**：现状清理按文件名前缀白名单覆盖（`runtime-*`/`pi-*`，logger.ts:329-330；pi-crash 靠 `pi-` 前缀被覆盖，:476-477），**但 cleanExpiredLogs 唯一调用点是 initLogger（logger.ts:120）——只在 runtime 启动时跑一次**；桌面 app 长开（E3 场景 uptime 20 天）下，runtime-*/pi-*（tee 实测单 session 198MB）/plugin-crash-* 的超龄文件在长寿运行期间无任何清理触发——T5「目录体积不失控」穿帮。修复分两类动作，**按跨进程安全性分工**：
    - **超龄清理（unlink + mtime 判定）**：跨进程安全——**main 进程每日定时器复扫 logs/ 全部清理前缀**（`runtime-*`/`pi-*`/`plugin-crash-*`/`main-*`/`renderer-error-*`——**固定名 stderr 文件除外，见下**）；保留天数提升到 shared 暴露 `readLogKeepDays()`（**env 覆盖 || 默认**——现状 XYZ_LOG_KEEP_DAYS 是 env 可覆盖的进程内常量 logger.ts:50-55，两进程同调同一函数：既不丢用户 env 旋钮，也不出现两套值域漂移）；清理判定用 `statSync().mtimeMs < cutoff`（活跃文件 mtime 持续刷新，跨天长寿命 tee 不会被误删）。**固定名 stderr 文件（electron-runtime-stderr.log）不进超龄清单**：它是固定名 + writer 持有型 append fd 的兜底取证类（常态零输出即健康），mtime 超龄被 unlink 后 writer 仍写已 unlink 的 inode（写成功、盘上无文件、零错误信号），到 fd 重建前新 stderr 全部静默丢失——恰在 G5 崩溃取证时刻失效；治理唯一归 writer 侧 size 轮转。**zcode-appserver-stderr 终态不再适用固定名论证**：随 zcode 引擎自主化（W5）迁移为 pid 实例维度文件名 `zcode-appserver-stderr-<pid>.log`（见 size 轮转条），不命中超龄清理前缀白名单（天然不被 main 复扫误删），治理归 writer 侧三判据过期清理 + size 轮转。
    - **size 轮转（rename 换文件）**：**只由 writer 进程自做**——跨进程 rename 会打断写方 append fd（日志进孤儿 inode、主文件不再增长、size 帽失效）。归属：`electron-runtime-stderr.log` writer 是 main（supervisor/process-control.ts:73）→ main 侧 rename 轮转安全；`zcode-appserver-stderr` 的 writer 落点**终态 = packages/zcode-subagent-cli/src/connection.ts:612**（appendStderrLog），轮转经 `logs/stderr-rotation.ts`（**@zhushanwen/subagent-engine-sdk 单源**实现的薄包装），文件名 `zcode-appserver-stderr-<pid>.log`（pid 实例维度——同一路径双实例（pi 宿主 + runtime 各持引擎 CLI）并发 append 互不干扰），落 `<engineDataDir>/logs/`（经 SDK resolveEngineDataDir = getDataDir）；轮转与过期清理由 writer 侧自做（同进程 rename 安全 + 三判据过期清理：同前缀 + pid 已死 + mtime 过期），落点见 U5 文件地图——**随 zcode 引擎自主化（W5）迁移，原文「runtime 进程（subagent-core connection.ts:578）」落点已废弃**；`main-*`/`renderer-error-*` writer 是 main → D6-① 的 main writer 自带。
  - 中期（治理，依赖打点数据驱动）——⑧ `entryStates` 条目级截断（累积态单条 tool output 截到 64KB 并标注截断）；⑨ toolResult base64 图片落盘引用化（**纯缓存语义**，见下）；⑩ 按水位数据决定是否需要 LRU=8 调参或堆上限启动参数。
  - **⑨ cache/images 语义（纯缓存，可随时丢弃可幂等重建）**：目录 `~/.xyz-agent/cache/images/<sessionId>/<sha256(data)>.<ext>`（ext 按 mimeType 映射：.png/.jpg/.webp/.gif，缺省 .png——impl-plan 偏差 D11，非单一 .png）；**落盘执行方 = main 进程**（renderer 是浏览器环境无 fs，经 IPC 委托 main 异步写盘后回填路径引用——与 renderer-log 同一 IPC 通道族）。**落盘顺序（显式声明，帽满语义的根基）**：hydrate 时先收集预算窗口内的全部 base64，**按消息序新→旧有序落盘、超帽即停、更旧的图占位**（不是「处理链遇到即写」的正序——正序会把窗口内较旧图写满帽、最新的图占位，与「最新内容优先可见」的代价承诺相反）；live 期新到图片在剩余额度内即写。消息内引用 = 路径。**【实施口径（v9）：两步走】本阶段落地 = 落盘引用化 + 渲染层路径引用 + 幂等重建 + 三条清理通道；base64 本体从累积态剥离（真正消除内存驻留）挂数据驱动重审**——U5 水位打点证明图片 base64 驻留是 renderer 内存主要压力源时立项（协议级改动：hydrate/live 双通路经 IPC 读回）。已接受代价：本阶段图片内存收益止步渲染层（base64 仍在 messages/entryStates 驻留）。**LRU 驱逐不删盘文件**——驱逐只释放 renderer 内存分区，被逐出 session 重进是设计内流程（LRU_MAX_SESSIONS=8，lru.ts:34——注意它只约束 renderer 内存驻留数，**对磁盘总量无约束力**），重进时重新 hydrate：cache 命中直接用，未命中（被清理）则从 entry 的 base64 重新落盘（幂等重建，用户无感）。**清理判据全部是文件系统级（不依赖跨进程内存态）**，三条通道：session 删除级联删该 session 目录（现状 delete 是 session 文件的唯一清理点，session-lifecycle.ts:737——cache 级联补齐它）；启动孤儿扫描（mtime 超 30 天，判据 = 文件路径内 sessionId 在 pi sessions 目录无对应 session 文件——**文件级判据天然覆盖 subagent 虚拟分区**，因 subagent 历史同存于 sessions 目录）；**单 session 目录 size 帽（默认 64MB）**——超限时停止为该 session 落盘新图、后续图片消息显示「图片缓存已满」占位（不阻断消息流）；**全局软上限（512MB）**：超限时只对「孤儿判据已判死」的 session 目录按 mtime 从老到新清理——**不做「未在场分区引用」的文件级判定**：「在场分区」是各 renderer 窗口进程独立的 LRU 内存态，cache 目录全窗口共享，任何进程级在场集都有跨窗口不可见问题；收敛到 session 级判死豁免后，活 session 的文件永不命中清理。
- **被否**：① 一步到位上 heap snapshot 常态化采集——无数据支撑的先优化，snapshot 本身是高成本动作；先打点拿真实曲线再定治理强度；② 打点经 WS 上报集中——各进程就地落盘更简单，少一条依赖链（WS 断时不丢水位）；③ 新日志复用 runtime logger 进程内落盘——main 与 renderer 是独立进程，复用不了 runtime 的 logger 实例，必须各自显式落盘 + 统一前缀纳入清理；④ **LRU 驱逐时同步删 cache 文件**——被反例击穿：驱逐 ≠ session 死亡，重进是设计内流程；驱逐删文件 + 重进不重建 = 全部图片 404，重进重建 = 每次驱逐-重进都重写文件（缓存颠簸 + 双分区引用时的删除竞态）。纯缓存语义（驱逐不删、删除只挂 session 死亡级联 + 孤儿扫描）三环均不成立；⑤ **容量治理按「未在场分区引用」清文件**——被反例击穿：跨窗口可见性空洞（在场集是各 renderer 进程独立内存态，清理方无法可靠知道其他窗口在场引用；误删在场引用且已 hydrated 分区不重进、幂等重建不触发 → 在场 404）。收敛为「只清孤儿判据已判死的 session 目录」后，判据全在文件系统层，跨进程可见性问题构造性消失。
- **证据**：E2 归因失败体验（本次调研直接证据）；logger 既有轮转与按前缀清理基础设施（infra/logger.ts:329-330/:476-477）可复用；清理触发窗口缺口实证（cleanExpiredLogs 唯一调用点 initLogger :120）；entryStates 无界证据（truncate-tool-output.ts:191 注释）；9/9 当日 plugin worker 崩溃 13 次的频率实测；logs/ 目录实测存在两个无覆盖 stderr 文件（本机 ls 实证）；session 删除唯一清理点实证（session-lifecycle.ts:737）。
- **效果**：G5 成立；为长期 session 隔离决策提供数据基础（方案 C 的前置条件）。
- **已接受代价（量化四要素，cache 累积面）**：**不删 session 的重度贴图用户，cache 累积 = Σ 每活跃 session 贴图量，只增不减**（「LRU 8 分区」不约束磁盘；session 删除是唯一自动回收点）。**两个通道分开声明**——①磁盘回收通道：删 session 级联 / 孤儿扫描 30 天 / 全局软上限（512MB，只清孤儿判死目录）；②图片显示恢复通道：**单 session 64MB size 帽满后，session 内无自动缓解**（重进/翻页/清 cache 重落盘均无效——重落盘受同一上限约束），占位文案如实说明「该会话图片缓存已达上限（64MB），历史图片仍可见，新图片显示占位」；唯一手动出路 = 清理该 session 的 cache 子目录中旧图 + 重进（新落盘从最新图片开始，更旧的图变占位——时间换空间的用户自主权衡）。量级护栏 = 单 session 64MB × 活跃 session 数（**同时增长面 ≤8**——LRU 只约束「同时在内存驻留且可落盘」的分区数，历史累积的死 session 部分由 30 天孤儿扫描回收，不参与同时增长）+ 死 session 30 天回收；重审触发：size 帽占位在真实使用中出现（说明 64MB 不够真实工作流）时上调单 session 帽或引入引用计数；显式判定：可接受（硬帽封顶、显式占位非静默、用户有手动出路）。
- **已接受代价（量化四要素，E2 型连坐复发的登记）**：E2 的确切主谋在取证落地前仍可能复发且仍难瞬时归因——量级：9/5 一次（7 session 连带 SIGTERM）；恢复路径：受影响 session 经 D7 自动恢复 + 既有惰性恢复，历史文件完好；重审触发：**取证落地后再发生一次同类事件即升级「dev/prod 数据目录隔离」为独立治理项**（出本方案 scope，立项论证）；显式判定：短期可接受（D6-⑥ 落地后同类事件可归因，D7 落地后用户感知从「session 消失」变为「自动恢复」）。

**D7：pi 崩溃自动 respawn + 恢复可见（中期，对应 R1 残余/G4）**

- **采用**：pi 非主动退出后自动恢复，四个生命周期边界逐一声明：
  - ① **挂点 = ProcessManager 的 onSessionExit 链**（process-manager.ts:165-182，非主动退出才通知，intentional destroy 已跳过）——**不是** `session.exited` 消息的生产点（forceQuitSession 在 message-dispatcher.ts:470-490 手工编排，不经 onSessionExit；挂错挂点会把用户强制退出的 session 自动复活）。用户手动强制退出 → 不触发自动恢复（§4 A7 反向验收）。
  - ② **5 秒延迟 + 取消语义**：pending 恢复任务以 timer 挂在 SessionService；**runtime shutdown 序列必须先取消全部 pending 恢复 timer 再 destroyAll**（否则 shutdown 中途 spawn 出新孤儿 pi——收割器只在下次启动后 5s 跑一次，用户直接退出 app 则孤儿无限存活烧 token）；session 删除同样取消。
  - ③ **并发语义 = join 不是 throw**：`restoringSessions` 现状对并发 restore 直接 throw（session-service.ts:574-576）——U8 必须把它改为返回同一 in-flight Promise（join）：自动恢复进行中用户发消息 → ensureActive 等待同一 Promise 完成后继续（T4 场景的不报错不双跑）；自动恢复启动前先查 restoringSessions，已有 in-flight（用户先发消息触发的惰性恢复）则跳过自动恢复。
  - ④ **恢复承诺不跨 runtime 重启**：supervisor 退避重启后新 runtime 无 pending 恢复状态，dead session 保持「持久化未附着」，等用户交互走既有惰性恢复（ensureActive）。
  - 恢复的附着动作走 D5-⑤ 预算化后的 restore 路径（大历史文件走逆序分块最小规范化——v9 降级形态：P-restore-skip 主形态「跳过 normalize」经交付门裁决不安全；cwd 死路径被首行 header 修复后附着成功，附着显式失败仅在文件头损坏等极端形态）。
  - 恢复结果经 messageBus 推 `session.restored` / `session.restoreFailed`（连续失败 2 次熔断——含附着显式失败：文件头损坏等极端形态），renderer 在对话流插入系统提示条（T4 文案，**明示在途回合丢失 + 后台任务/子代理不复活**——relay kill-on-disconnect 与 reapSessionBackgroundTasks 已在崩溃时连坐终止它们，恢复不重建）。
- **被否**：① 立即无条件 respawn——同参数再起可能再崩（如坏 extension 配置），无退避无熔断 = 崩溃循环；② 保持现状（等用户下次发消息惰性恢复）——在途回合静默丢失，用户不知道 session 死过，重发消息后上下文已断却无任何提示；③ renderer 侧定时轮询 session 状态——推模式已有 messageBus，轮询是倒退；④ 恢复时连 subagent/后台任务一起复活——崩溃现场的任务状态已不可考（relay 子进程被杀后无 checkpoint），盲复活 = 状态错乱；明示不复活是诚实且安全的降级。
- **证据**：惰性恢复路径存在且已验证（session-service.ts:567-586）；并发语义现状 throw（:574-576）；双生产点实证（message-dispatcher.ts:470-490 vs process-manager.ts:165-182）；收割器触发点实证（reap-orphan-pi.ts:48-52 启动后 5s 单次）；restore 附着全量读实证（restore-seeding.ts:135-148）；9/3 E1 的实际体验 = session 死后无声消失。
- **效果**：G4 成立；T4 场景成立。
- **已接受代价 A（量化四要素）**：自动恢复重建的 pi 进程丢失在途回合与内存态（compact 状态、queued 消息），进行中的后台任务与子代理不复活——量级：每次崩溃至多丢失当前回合 + 该 session 的后台任务；恢复路径：提示条明示丢失范围，历史完整（JSONL 文件持久化完好），子代理任务可由用户重新发起；重审触发：若出现「恢复后上下文错乱」的实际案例，评估恢复时强制 compact；显式判定：可接受（现状是连提示都没有）。
- **已接受代价 B**：runtime 整机重启后 dead session 不自动恢复（④）——量级：仅 supervisor 重启场景（现状一周数次以内）；恢复路径：用户交互时惰性恢复（既有路径）；重审触发：supervisor 重启频率显著上升（D6 水位/决策日志可观测）时重估；显式判定：可接受。

### 3.4 错误规格表（准则 6：每个失败给出路）

| 失败 | 检测点 | 用户所见 | 恢复指引 |
|---|---|---|---|
| extension 回调 stale ctx | ext-guards 守卫 catch | 无感知（对话照常） | 无需恢复；debug 日志供排查 |
| extension 回调非 stale 错误 | 守卫原样上抛 → pi 崩溃链路 | T4 恢复提示条 | 自动 respawn；反复失败 → 提示重试/新建会话 |
| renderer JS 渲染错误 | errorHandler/onerror | 不白屏；错误现场自动落盘（renderer-error log），App 其余功能可用 | 日志自动落盘；影响持续 → 重启窗口 |
| renderer 进程死亡 | main render-process-gone | 1s 内自动 reload + 恢复提示条 | 60s 滑窗内前 3 次自动 reload、第 4 次熔断 → 静态错误页：「请重启应用，日志在 ~/.xyz-agent/logs/」 |
| 出站 reply 超 32MB | 出站帧守卫（reply 通路=message-broker.reply 内联） | 错误提示「内容过大无法传输」 | 提示含「加载更早」分页入口与 session 文件路径 |
| 出站 push 超 32MB | 出站帧守卫（push 通路=guardOutboundPushFrame@publish 入口，契约保持式截断；实现为 seq 预写 + drop 时 rollbackSeq，可观察等价于 seq 分配前判定——见 impl-plan 偏差 D2） | 该条消息显示占位文案，其余消息照常 | 占位文案含 session 文件路径 |
| push 注册表 miss / 截断后仍超限（病态兜底） | publish 入口兜底整条丢弃 + rollbackSeq 回滚（**miss 不占 seq**，等价于 seq 分配前丢弃） | 该条消息不出现 | error 日志含消息类型与体积 → 补注册表后同类消息恢复；8MB 告警档前置暴露 miss |
| 历史文件超 32MB | statSync 预检 | 最近窗口正常显示 + truncated 标记 | 「加载更早」翻页；Trace 视图降级为「文件过大，源文件：<路径>」（④档降级文案在离线/file 通路生效；**活跃态** Trace 走 RPC get_entries 通路，超限被 D3 reply 守卫拦截为错误 envelope——错误提示同样携带路径指引，不再只显示错误码；活跃态协议级降级为已知限制，挂数据驱动重审） |
| restore 附着超 32MB（最小规范化，v9 降级形态） | statSync 预检（⑤档） | 尾部 session_end 被流式 strip、首行 cwd 死路径被 fallback 修复 → session 正常附着可用（失忆防由 strip 保证、cwd 防由首行修复保证）；显式失败仅在文件头损坏等极端形态触发 | 分支二的根治：在原 worktree 路径重建目录（推荐）；或手工编辑 session 文件首行 header 的 cwd 字段指向现存目录——**pi 按 header 的 cwd 判定而非文件所在目录，只移动文件不改 header 无效** |
| pi 进程死亡 | ProcessManager onSessionExit 链 | T4 恢复提示条（含在途回合与后台任务丢失说明） | 自动 respawn（5s 延迟，2 次熔断）→ 手动重试按钮 |
| pi 恢复后 subagent/后台任务缺失 | 崩溃时已连坐终止（relay kill/reap） | T4 提示条明示「不会自动恢复」 | 用户重新发起子代理/后台任务 |
| 用户手动强制退出 session | forceQuitSession（不经 onSessionExit） | 现状 UI（dead 标记） | 不自动恢复（设计意图）；下次交互（点击 session 即惰性附着恢复，实测口径） |
| runtime 整机死亡 | supervisor（既有） | 「重启中…」过渡屏（既有） | 退避重启（既有）；5 次用尽 → 手动重试（既有）；重启后 dead session 等用户交互惰性恢复 |

### 3.5 探针清单（准则 7：运行时断言必须实锚）

| ID | 验证的行为断言 | 探针方式 | 状态 | 失败时降级路径 |
|---|---|---|---|---|
| P-stale-throw | stale ctx 上调 `sendUserMessage` 同步抛错且无人接则 pi 进程退出 | 9/3 真实崩溃堆栈（E1） | ✅ 已实测（事故即探针） | — |
| P-stale-wording | stale 错误文案含 `stale after session replacement`（分诊依据） | 当前 pi 0.84.4 实装崩溃堆栈实证（E1 堆栈帧文案）；实施时登记进 C-proc-08 探针族随版本门禁自动重验 | ✅ 已实测 + ✅ PS-30 已登记（docs/pi-semantics.json，随版本门禁自动重验） | 文案变更 → 守卫退化为全部上抛（不更危险），门禁报红提示更新分诊词 |
| P-guard-holds | `guardStaleCtx` 包裹后，同场景 pi 进程存活、stale 错误只落 debug 日志 | U1 实施期：pi CLI RPC 模式实测（`pi --mode rpc --extension <dev-link 路径>`，触发 compact 后立即 switchSession） | ✅ 已由 U1 交付（真机 PASS，记录 extensions/shared/ext-guards/docs/stale-ctx-audit.md §6） | 若 catch 仍不能保命（如 Bun 对特定 throw 语义特殊），改为回调入口先查 `isCtxStale()`、stale 则完全不调用任何 pi API |
| P-gone-reload | OOM 死亡的 renderer 触发 `render-process-gone` 且 reload 后应用回可用态 | U3 实施期：dev app（9222 调试口）执行 `webContents.forcefullyCrashRenderer()`，观察自动 reload 与提示条 | ⛔ U3 交付门 | reload 后状态异常 → 降级为静态错误页 + 手动重试（不自动 reload） |
| P-mem-api | renderer 的 `performance.memory` 在 Electron 当前版本可用且数值有效（含打包版复验） | U6 实施期：dev app 控制台读 `performance.memory.usedJSHeapSize` 验证非 undefined；打包版经 A8 日志内容复验 | ✅ dev 侧 pass（Gate B 组2a A8：renderer-error log 含 performance.memory 快照）；**打包版复验挂起**（随 A3 打包版复验挂 prerelease 流程，待用户裁决） | 不可用 → renderer 侧只上报错误栈，内存水位由 main/runtime 打点承担 |
| P-respawn-join | restoringSessions 改 join 后：kill pi 后 5s 窗口内手动发消息只 spawn 一个 pi 进程，消息在恢复完成后继续 | U8 实施期：kill pi 后立即手动发消息，核对日志进程数与 pid，确认消息最终送达 | ✅ pass（Gate B 组G 回流重验：恢复窗口内 spawning 计数=1 无双跑、消息经 message_start 收口送达——缺陷#1 修复后复验，见 impl-plan 变更历史） | join 改造遇阻 → 恢复窗口内发消息走「恢复完成后重发」排队（不 throw），双跑防线退化为启动前检查 |
| P-publish-trunc | push 通路截断后：seq 连续（无 gap 误触发；miss 侧 rollbackSeq 回滚不占 seq）、ring 回放与重订阅拉到同一份截断版 | U4 实施期：阈值校准法（A10）触发超限 push → 断连重连 → 核对客户端收到的截断版与 ring 回放版一致、无 gap 重订阅日志 | ✅ pass（Gate B 组2b A10 阈值校准法全链） | 一致性不成立 → 截断点上移至 event-adapter 入口（消息构建前截断字段），publish 只做兜底校验 |
| P-paging | 「加载更早」prepend 历史消息后 Virtualizer 滚动位置不跳变；reconcile 合并不清除已加载更早历史 | U6 实施期：dev app 打开 200+ turn 真实 session，点「加载更早」观察视口锚定；翻页→切出→切入核对更早历史仍在 | ✅ pass（Gate B 组2b A5b：prepend 锚定 + 切出切入更早历史保留） | 跳变 → prepend 前记录锚定消息 offset，插入后恢复 scrollTop（virtua 支持 size 补偿）；合并被击穿 → reconcile 遇 truncated 响应跳过合并仅更新 occupancy |
| P-restore-skip | restore 附着跳过 normalize 后的**双分支**：①附着成功 → LLM 上下文含旧历史（主断言 = 机械等价、两步：附着后**发送一条测试消息产生新增 entry**，再核对该新增 entry 的 **parentId 链回溯连通到文件尾旧 entry**——断链本质即后续 append 的 parentId 挂不上，附着刚完成时新增 entry 尚不存在，必须先产生再核对；零模型依赖；可选补充：让 agent 复述早期事实）；②cwd 死路径 → MissingSessionCwdError → D7 熔断提示 | U4 实施期：read restore-seeding.ts 语义定跳过安全性；A11 场景对 >32MB 文件（含 legacy session_end 变体 + cwd 死路径变体）走附着，分别验两分支 | ⛔ U4 交付门 | **已触发（实施期裁决，v9）**：失忆半边不安全 → ⑤档已改为逆序分块最小规范化（尾部扫 legacy session_end + 首行单独读 header 修 cwd，均不读全文），实现 = session-file-streaming.ts；分支②的「cwd 死路径 → 显式失败」在降级形态下不可达（首行 fallback 修复后附着成功，比主形态更安全） |
| P-ws-oneway | ws 库 server 侧无出站大小限制能力 | 代码实锚：connection-manager.ts:86 maxPayload 仅入站 | ✅ 已证 | — |
| P-hist-sizes | 生产数据目录 session 历史文件当前最大 6MB；单 session tee 累计流量最大 198MB（单条体积受 pi 工具上游约束） | `du -sh` 实测本机 `~/.xyz-agent/pi/agent/sessions/` 与 `logs/pi-*.jsonl` | ✅ 已实测 | — |

---

## 4. 验收（真实场景，非单测非 mock）

**本章结论：12 个真实场景覆盖全部 5 条设计目标 + 3 个负面行为 + 1 个邻居系统不变量；验收环境 = pi CLI RPC 实测（extension 层，遵循仓规「extension 改动优先在本地 pi CLI 实测」）+ dev app 实测（`pnpm dev`，9222 调试口）。单测只作回归辅助，不计入验收。**

**大帧验收的构造方法声明**：pi 工具上游已自截 read/bash 类输出（50KB/2000 行）与图片（≤16MB），「让 agent 自然产出 >32MB 单帧」在现网不可构造——这正是 D3 定位为防御纵深的依据（§3.3 D3 定位校准）。A10 采用**阈值校准法**：告警/截断阈值是 shared constants 常量（改值需重启生效），验收时临时调至可触发区（如告警 512KB / 截断 2MB），用真实数据与真实链路（pi → runtime → WS → renderer）验证守卫行为——与性能压测「调参到压力区」同型的标准做法，链路与数据全真实，仅防御线参数在测试配置内。

**A11 大文件构造声明**：>32MB session 文件由脚本复制真实 session 的 entry 拼接生成（真实 entry 内容、体积达标，置于独立测试 cwd 的 sessions 目录；scanPiSessions 按首行 header 识别，拼接文件可被正常扫描）。构造前提：**首行必须是 `type==='session'` 的 header（否则 parseHeaderFromFirstLine 返回 null、文件不被收录），大 payload entry 置于 header 之后、文件前中部，正常 user/assistant turn 轮次保持尾部密度**（保证②档分块扩窗「凑 20 turns」路径被真实触发，而非一上来就走 truncated 短路）；另备两份变体：**尾部含 legacy `session_end` 行的变体**（触发 normalize 失忆面场景）与 **header cwd 指向已删除目录的变体**（触发 cwd 硬拒绝场景），分别验 P-restore-skip 双分支。

| # | 回溯目标 | 场景（谁/什么上下文/做什么/看到什么） | 通过标准 |
|---|---|---|---|
| A1 | G1 | 开发者在 pi CLI RPC 模式加载 dev-link 的 smart-context：调 `compact_context` 工具，压缩进行中立即 `switchSession` 到新 session | pi 进程存活（RPC 连接不断）；`~/.pi/agent/logs/` 出现守卫降级日志；**无** assertActive 堆栈。plan 的 compact 隔离执行流同法验证 |
| A2 | G1（负面） | 同上但不切 session：压缩正常完成 | steer 结果消息正常注入对话流；守卫不改变正常路径行为（消息内容、投递时机与现状一致） |
| A3 | G2 | dev app 中对窗口执行 `forcefullyCrashRenderer()`（模拟 E3 的进程死亡）；多窗口时核对另一窗口 | 窗口 1 秒内自动 reload 回可用界面 + 一次性恢复提示条；main 日志有 `render-process-gone` 详情；同窗口 60 秒内连崩：前 3 次自动 reload、第 4 次熔断停静态错误页且有手动重试按钮（D2「≤3 次」口径：3 次 reload 预算）；**另一窗口不受影响** |
| A4 | G2/G5 | dev app 注入一个真实组件渲染错误（临时在组件 render 里 throw） | 不白屏；`logs/renderer-error-<date>.log` 有错误栈 + 内存快照 + sessionId/windowId；App 其余功能可用 |
| A5 | G3 | dev app 打开真实大 session（本机 6MB 历史文件，超 640KB 预算必然触发截断路径） | renderer 不崩；历史按预算截断显示「已加载最近 N 轮 · 加载更早」；runtime 日志无全量读巨文件的卡顿（事件循环不被秒级阻塞） |
| A5b | G3（D4 负面） | 承接 A5：点「加载更早」翻页 → 切出到其他 session → 切回 | 已翻到的更早历史**仍在**（reconcile 合并不清除）；最近窗口内容与实际一致 |
| A6 | G3（负面） | 打开普通小 session（历史 <1MB，日常规模） | 无任何截断提示，历史完整加载，行为与现状一致 |
| A7 | G4 | dev app 中 `kill -9` 活跃 session 的 pi 进程；恢复计时窗口内立即手动发消息；另起一场景用**强制退出**（forceQuit）终止另一 session | kill 后约 5-10 秒（5s 延迟 + spawn/附着）自动恢复；对话流出现恢复提示条（含在途回合与后台任务丢失说明）；恢复窗口内手动发消息不报错不双跑、恢复完成后消息继续（P-respawn-join）；**强制退出的 session 不触发自动恢复** |
| A8 | G5 | 依次触发 A1（stale 场景）、A3（renderer 崩溃）、A7（pi 崩溃），外加加载一个**运行时抛未捕获异常的 trusted dev plugin**（临时 fixture，复现 9/9 `trusted-1 exited with code 1` 场景——worker 是 Worker Thread 无 pid 可 kill，须以真实崩溃构造）后检查 `~/.xyz-agent/logs/` | 能交叉回答「哪层/哪个 session/为什么」：pi-crash log 含上下文头（sessionId/文件路径/内存水位）、renderer-error log 有 JS 栈、main log 有 render-process-gone 详情与水位行、runtime 日志有 5 分钟间隔水位行与杀链决策日志、**plugin-crash log 有 worker stderr（且既有重建机制触发）** |
| A9 | 邻居系统不变量 | ① pi CLI 单独使用（不经 xyz-agent）跑完整会话（**挂接 U1 交付时验**）；② 验收全程结束后对 `~/.xyz-agent/logs/` **全目录** `du` 扫描（**U5 落地后适用**）；③ `~/.xyz-agent/cache/` 检查（**U7 落地后适用**） | ① pi 行为无任何变化（ext-guards 守卫只在错误路径生效）；② logs/ 内**所有文件**要么匹配清理前缀/轮转策略，要么是当日内新文件，无失控增长；**长寿模拟**：经 `readLogKeepDays()` 的 env 旋钮临时调小保留天数 + 手动触发 main 清理（触发入口已定型：**DEBUG_RUN_LOG_RETENTION IPC 通道**——`apps/electron/main/logs/log-retention-ipc.ts` 暴露 `runLogRetentionNow()`，通道名常量在 shared `ipc-channels.ts`，renderer dev 控制台空参 invoke 即触发），断言超龄 runtime-*/pi-* 文件被清（验证清理不只启动时跑），**固定名 stderr 文件不被超龄清理误删**；**轮转不打断写方**（对齐 A10 阈值校准法）：临时调小 size 轮转帽 + 重启 dev app + 构造持续 stderr 产出，断言 zcode-appserver-stderr-<pid>.log（zcode-subagent-cli 引擎连接写，W5 终态落点见 D6-⑦）轮转后（rename 副本 + 流关闭）下次写入懒重开新文件继续落盘（无孤儿 inode）；③ cache/images 三条清理通道（session 删除级联/孤儿扫描/size 帽+软上限）有实证记录；LRU 驱逐-重进场景图片正常显示（cache 命中或幂等重建）；**size 帽满断言**：贴图至单 session 超 64MB → 新图显示占位 → 清理该 session cache 子目录旧图 → 重进 → 新图恢复落盘 |
| A10 | G3 传输段（含负面） | **阈值校准法**：告警/截断阈值临时调至 512KB/2MB（constants 改值 + 重启 dev app），dev app：① reply 截断档（游标世界口径，v9）：打开真实 6MB session 后连续「加载更早」直至游标页含单 turn 超预算放行的超大 turn（页级 reply 超 2MB 截断档；u6 分页协议落地后 getFullHistory 全量通路退役，原「加载更多」步骤由游标翻页承载）；② 贴一张 >2MB 的真实截图（图片走 message_end 帧的 content 数组 Image block，触发 push 截断档）；③ **miss 兜底专项**：临时摘除注册表中截图所在帧类型的条目后重放②（真实 miss 形态——本轮审查实证过 miss 面真实存在） | ① renderer 不崩；reply 截断时前端 Promise reject 收口（不悬挂）+ 降级提示渲染；② 截图消息显示截断占位文案（含 session 文件路径）；③ **seq 连续**——断连重连后无 gap 重订阅日志，回放版与在场版一致（P-publish-trunc）；④ miss 兜底消息整条丢弃 + error 日志（且告警档日志先于截断档出现）；⑤ runtime 日志有大帧告警；⑥ 恢复默认阈值重启后一切如常（守卫不误伤正常流量） |
| A11 | G3 读取段（D5 验收） | 构造 >32MB 的真实 session 文件（A11 构造声明：拼接生成 + 首行 header + 尾部 turn 密度 + legacy session_end / cwd 死路径两个变体）；dev app 打开该 session；再打开其 Trace 视图；再点「加载更多」；再 kill 该 session 的 pi 触发自动恢复（附着）**并在附着完成后发送一条测试消息**；对 cwd 死路径变体重复附着 | ① getHistory 走②档分块扩窗（runtime 日志无全量读、返回 truncated、消息流正常显示尾部）；② Trace 视图渲染④档 oversize 降级文案（含绝对路径，非空态混淆）；③「加载更早」游标翻页走②档扩展（cursor 路径，不拒绝、给出锚点前窗口 + truncated；①档消费方收窄为 subagent/agent-call 历史）；④ kill-respawn 过程**顺带验证③档**：pi 退出收尾的 findLastEntryField 无全量读 fallback 日志；⑤ attach（session_end 变体）走⑤档：最小规范化（流式 strip + warn 日志）+ session 可用**且该测试消息新增 entry 的 parentId 链回溯连通到旧 entry 尾**（P-restore-skip 分支一两步式——核对主体是新增 entry，不是文件内既有 entry）；⑥ attach（cwd 死路径变体）：首行 cwd fallback 修复后附着成功、session 可用（v9 降级形态口径——原主形态「附着显式失败」不再出现；显式失败 → D7 熔断仅在文件头损坏等极端形态）（P-restore-skip 分支二） |

---

## 5. 下一层拆分

**实施路径两阶段**：阶段一（短期止血，U1-U5）消灭已实锤崩溃源 + 建立取证；阶段二（中期治理，U6-U8）协议级改进。阶段一任意单元可独立交付、独立验收、独立回滚。

| 单元 | 内容 | 对应决策/验收 | justification（为什么这么拆） |
|---|---|---|---|
| **U1** extension 守卫 | ext-guards 新增 `guardStaleCtx`（含 isCtxStale 代际机制）；smart-context（tool.ts:183/187 + index.ts 三处普查确认）、plan/compact.ts:218-229 接入；scheduler 迁移到共享守卫（三件套语义等价逐条比对）；全仓普查清单（grep 模式：`ctx.compact(`、`setInterval`/`setTimeout` 回调内 `pi.`/`ctx.` 调用、`pi.events.on` 回调内捕获旧 ctx）逐包确认或排除，已知候选：structured-output loop-gate、pending-notifications、cw-tool；**subagent-workflow notifyDone/sendDelivery 已接入**（实施期审计发现后补入，impl-plan 偏差 D6 闭环）；**每包「stale 静默语义」判定表**；stale 文案登记进 C-proc-08 探针族（check-pi-semantics.mjs）；接入终态 SSOT = extensions/shared/ext-guards/docs/stale-ctx-audit.md §2 | D1 / A1+A2+A9① | 实锤崩溃源，最高优先级；守卫与接入同单元避免「有守卫无人用」；普查清单与判定表是本单元交付物的一部分（文档化到单元完成标准） |
| **U2** renderer 错误边界 + 落盘 | main.ts 三件套；preload 加 `renderer-log` IPC；main 侧 handler + 按 windowId 限流（100 条/分钟/窗口）+ 落盘 | D2 前半 + D6-①③ / A4 | 与 U3 共用 IPC 定义但行为独立，可同 PR 也可分 PR；不依赖其他单元 |
| **U3** renderer 自动恢复 | window-factory render-process-gone 改造：详情落盘 + 按 windowId 熔断的自动 reload + 静态错误页 | D2 后半 / A3 | 恢复链路与错误捕获是两个故障面（JS 错误 ≠ 进程死亡），分开可独立验收 |
| **U4** 传输与读取预算 | shared constants 加出站阈值；出站帧守卫双通路形态（reply envelope 替换=message-broker.reply 内联 / push seq 前契约保持式截断=guardOutboundPushFrame@publish 入口）+ **publish 调用点大字段注册表静态穷举（40+ 调用点，帧内路径坐标系，穷举表为交付物）**；session.history 双预算截断（活跃+离线合并，含单 turn 超预算放行语义）；runtime 五条全量读路径预检与分档（①逆序窗口②分块扩窗③逆序分块④oversize 标记⑤跳过 normalize） | D3+D4 短期+D5 / A5+A6+A10+A11 | 同一目标（G3）的不同段，但都是「加预算」同一动作模式，合并为一个单元避免协议常量多处定义漂移；注册表穷举与守卫实现同单元（穷举结果即实现依据） |
| **U5** 内存与取证打点 | main 日志落盘 writer（main-<date>.log，date+size 双策略轮转）+ main/runtime 水位定时器 + **main 每日定时器复扫 logs/ 全前缀（长寿运行清理）**；pi-crash 上下文头；plugin-crash log；杀链决策日志；清理覆盖扩展（runtime 侧 +plugin-crash- 前缀；既有 electron-runtime-stderr/zcode-appserver-stderr 纳入 size 轮转） | D6 短期①-⑦ / A8+A9② | 纯打点零行为变更，风险最低，可最先落地为后续所有单元提供观测；清理通道与写入同单元（有写入无清理 = 新债） |
| **U6** 历史分页协议 | session.history RPC 加 cursor/limitTurns/maxBytes；renderer「加载更早」翻页 + prepend 锚定 + reconcile 合并语义改造；getFullHistory 全量通路退役；apply-entry-equivalence 断言域 re-scope | D4 中期 / A5+A5b 完整版 | 依赖 U4 的预算语义先行；前后端联动 + 等价性测试调整，独立单元独立验收 |
| **U7** entryStates 与图片治理 | 累积态条目截断（64KB）；toolResult 图片落盘 cache/images/<sessionId>/ 纯缓存语义（main 经 IPC 落盘/幂等/LRU 驱逐不删/单 session 64MB size 帽/三条文件系统级清理通道/全局软上限）+ **live/reload 截断层统一**（D3 代价 C 的根治）；按 U5 水位数据决定 LRU/堆参数 | D6 中期⑧⑨⑩ / A5+A8 复验 + A9③ | 依赖 U5 的打点数据校准截断阈值，不拍脑袋 |
| **U8** pi 崩溃自动恢复 | onSessionExit 挂点接自动 restore（5s 延迟、2 次熔断）；restoringSessions throw 改 join；shutdown/删除取消 pending 恢复 timer；session.restored/restoreFailed 推送；renderer 恢复提示条（含丢失范围说明） | D7 / A7 | 依赖 U5 的 pi-crash 上下文（提示条展示崩溃原因）与 U4 的⑤档预算化附着；中期最后做，先有取证再有恢复 |

**依赖关系**：U5 无依赖可最先；U1 独立；U2/U3 弱耦合（IPC 定义，且 U2 落盘依赖 U5 的 main writer——同阶段建议 U5 先行）；U4 独立；U6 依赖 U4；U7 依赖 U5；U8 依赖 U4（⑤档）与 U5。

**文件改动地图**（实施者清单）：

- U1：`extensions/shared/ext-guards/src/index.ts`（新增守卫）· `extensions/universal/smart-context/src/tool.ts`（:183/:187）· `smart-context/src/index.ts`（:127/:144/:157 普查确认）· `extensions/universal/plan/src/compact.ts`（:218-229）· `extensions/universal/scheduler/src/runtime.ts`（迁移共享守卫）· `scripts/check-pi-semantics.mjs`（探针族登记）· 普查其余包
- U2：`packages/renderer/src/main.ts` · `apps/electron/preload/preload.ts` · `apps/electron/main/`（IPC handler + 限流 + 落盘）· `packages/shared/src/`（IPC 通道名常量）
- U3：`apps/electron/main/window/window-factory.ts`（:187-197）· 静态错误页 HTML/内联
- U4：`packages/shared/src/constants.ts` · `packages/runtime/src/transport/message-broker.ts`（:76）· `packages/runtime/src/services/message-bus/message-bus.ts`（publish 入口 :238 附近 + 帧内路径注册表）· `packages/runtime/src/services/session/history-rebuild-cache.ts`（:229）· `packages/runtime/src/services/session-history.ts`（:78/:170）· `packages/runtime/src/infra/pi/session-file-utils.ts`（:522）· `packages/runtime/src/infra/pi/session-store.ts`（:92）· `packages/runtime/src/services/session/restore-seeding.ts`（:135-148）· `packages/runtime/src/services/session/session-records.ts`（:325/:447 subagent 历史消费方）· `packages/runtime/src/services/session/trace-sync.ts`（:126/:260 oversize 降级）· renderer 截断提示 UI（`packages/core/src/domain/chat/store.ts` hydrate 路径 + 消息列表顶部条）
- U5：`packages/runtime/src/index.ts`（水位定时器）· `apps/electron/main/main.ts`（writer + 水位 + 每日清理定时器）· `packages/runtime/src/infra/logger.ts`（pi-crash 头/plugin-crash/清理前缀扩展 + 改调 shared readLogKeepDays）· `packages/shared/src/constants.ts`（**readLogKeepDays 落点**：env 覆盖 || 默认，两进程同调；**JSDoc 标注 Node-only、renderer 禁引**——该文件被 renderer 大量 re-export 且现状零 process.env，引入 env 函数须显式划界，防 renderer 误 import 引发 `process` 未定义 ReferenceError）· `apps/electron/main/supervisor/process-control.ts`（stderr 文件轮转）· `packages/zcode-subagent-cli/src/`（**zcode-appserver-stderr 自轮转落点（终态）**：connection.ts:612 appendStderrLog + logs/stderr-rotation.ts——@zhushanwen/subagent-engine-sdk 单源，文件名 `zcode-appserver-stderr-<pid>.log` pid 实例维度，落 `<engineDataDir>/logs/`；随 zcode 引擎自主化（W5）迁移，原文 subagent-core 落点已废弃）· `packages/runtime/src/services/reap-orphan-pi.ts`、`packages/runtime/src/infra/relay/relay-registry.ts`、`apps/electron/main/supervisor/`（决策日志）
- U6：`packages/runtime/src/transport/session-message-handler.ts` · `history-rebuild-cache.ts` · `packages/core/src/transport/api/domains/chat.ts` · `use-session.ts` 切入链与 reconcile（:267-281）· 消息列表 prepend · apply-entry-equivalence 测试断言域
- U7：`packages/core/src/domain/chat/truncate-tool-output.ts` · `apply-entry-utils.ts` · store.ts entryStates 路径 · cache/images 生命周期（新增，main 侧 IPC 落盘）
- U8：`packages/runtime/src/services/session/session-service.ts`（:295-346 链路 + :567-586 恢复 + :574-576 join 改造）· `packages/runtime/src/index.ts` shutdown 序列（取消 pending timer）· messageBus 新消息类型 · renderer 提示条组件

**实施期义务**（仓规）：① 新架构约束（出站帧守卫、render 进程熔断、stale 文案门禁）落地时登记 `docs/constraints.json` 并跑 `node scripts/render-constraints.mjs`；② 符号删除/改名同批清扫文档引用（`check-doc-symbol-drift.mjs`）；③ extension 改动先 pi CLI 实测再进 xyz-agent（A1/A2 即此约定）；④ 每个单元 PR 级别只跑相关测试，收尾走全量。

**待验证检查点**（设计期无法确定，实施期诚实验证）：① 出站告警/截断阈值 8MB/32MB 的取值需按 renderer 实际堆余量校准（U4 实施期用 A10 阈值校准法验证）；② 「加载更早」的游标在活跃 session 新增消息后的稳定性（cursor 基于 entryId 是否受新 entry 追加影响）；③ `performance.memory` 在打包版（非 dev）Electron 的可用性（P-mem 的打包版复验）；④ publish 调用点大字段注册表的静态穷举完备性——穷举表是 U4 交付物，miss 由 8MB 告警档前置暴露（D3 已接受代价 B）；⑤ D5-⑤ 跳过 normalize 的双分支安全性（P-restore-skip：read restore-seeding 语义后定，重点验 parentId 链连通与 cwd 硬拒绝；任一分支不安全则改逆序分块最小规范化）。

---

## 附录：版本与溯源

- v1（2026-09-09）：初版。依据：2026-09 本机崩溃取证（9/3 pi-crash log、9/5 runtime 日志七连 SIGTERM、9/9 renderer .ips 崩溃报告）+ 全仓代码普查。长期项（runtime 多进程隔离、统一遥测、系统内存看门狗、dev/prod 数据目录隔离）出 scope，待 G5 取证数据积累后另行论证。
- v2（2026-09-09）：第 1 轮审查修订（双报告 8 must-fix + 7 suggestion 全修）。决策改动与被否谱系：① D3 初版「守卫放广播点（seq 分配后）丢弃超限 push」被「gap-重订阅死循环」反例击穿，改为 seq 分配前的契约保持式截断；② D7 初版「restoringSessions 幂等 join 假设」与现状 throw 语义不符，改为显式 join 改造 + 补挂点/取消/跨重启/子代理不复活四个生命周期边界；③ D6 初版「main 走 console 落盘」为事实错误（main 无 console→文件重定向），改为显式新建 main writer + 全部新写入面配清理通道；④ D4 补 reconcile 合并语义与 live≡reload 不变量 re-scope；⑤ D5 补 ②档分块扩窗与 getSubagentHistory/trace-sync 消费方归属；⑥ D4/D5/E2 补「已接受代价」四要素登记。
- v3（2026-09-09）：第 2 轮复审修订（主审 3+1、影响面审 4+3，全修）。① D3 补「定位校准」——pi 工具上游自截实证后 32MB 档定性为防御纵深，198MB 校准为累计流量语义；A10 改阈值校准法；② D3 注册表从「猜测三类」改为「源码实证初始注册表 + U4 静态穷举」，miss 兜底登记代价 + 错误规格表补行；③ D6-⑨ cache/images 从「LRU 驱逐同步删」被「驱逐≠死亡」反例击穿，改为纯缓存语义；④ D5 新增⑤档 restore 附着路径 + P-restore-skip + A11；⑤ A8 改真实崩溃 fixture；⑥ D6-⑦ 补既有 stderr 文件纳入轮转；⑦ 三分类措辞与 D7 行号修正。
- v4（2026-09-09）：第 3 轮复审修订（主审 3+4、影响面审 2+4，全修）。① D3 注册表坐标系修正（归一化对象→WS 帧内路径）；② A10 载体修正（reply 改「加载更多」、write 3MB 删除、补 miss 专项）；③ A11 补③档断言与构造前提；④ D5-⑤ 补失忆风险声明；⑤ D6-⑨ 容量治理收敛为孤儿判死 + 软上限；main 经 IPC 落盘声明；⑥ D6-① main 文件自治清理；⑦ 时序/措辞/行号修正。
- v5（2026-09-09）：第 4 轮复审修订（主审 2+3、影响面审 3+4，全修）。① D3 注册表补 `message.message_end` 帧（**全部持久化 entry 的实时权威载体**，event-adapter.ts:901-930 实证）——v4 的注册表漏此帧会使贴图超限走 miss 整条丢弃、A10② 不可达成；「entry 内 images 数组」修正为「content 数组内 Image block」（entry 无独立 images 字段）；MCP 大结果双路下发（tool_call_end + message_end）帧间一致声明；② D3 代价 C 重写为诚实版——六类截断工具 live/reload 形态近似一致，**非六类工具（write/edit/MCP）存在可见差异**且 reload 有内存压力回归，重审触发改「首个用户可见案例」，U7 统一截断层为根治；D4 re-scope 交叉引用该例外；③ D5-⑤ 风险声明补全**两个半边**（失忆半边之外还有 cwd 半边——applyHeaderCwdFallback 跳过后 cwd 死路径触发 pi switchSession 硬拒绝、附着显式失败走 D7 熔断）；cleanupMigrateResidues 跳过归属声明；降级路径补「首行 header 单独读做 cwd 修复」；错误规格表⑤档行改双分支；④ D6-⑦ 清理触发窗口补全——main 每日定时器复扫扩为 **logs/ 全前缀**（cleanExpiredLogs 只在 runtime 启动跑一次的缺口，长寿运行下 runtime-*/pi-* 超龄无人清）；A9② 补长寿模拟断言与阶段标注；⑤ D6-⑨ 累积面代价重写——「LRU 8 分区约束磁盘」的量级依据错误被修正，补**单 session 64MB size 帽**（越限停落盘显式占位，硬帽封顶）+ 全局软上限；⑥ D6-① main writer 对齐 date+size 双策略（限流折算的单日数百 MB 风险）；⑦ P-restore-skip 主断言改 **parentId 链连通核对**（机械等价、零模型依赖；agent 复述降为可选）；⑧ A10③ 改「摘除注册表条目 + 重放真实消息」；A11 补首行 header 前提与 cwd 死路径变体；⑨ D4 补单 turn 超预算放行语义（entry 原子性不切分）；⑩ restore-seeding.ts 路径修正（services/session/）与行号（:135-148/:140）；A9① 挂接 U1。
- v6（2026-09-09）：第 5 轮复审修订（主审 1+1、影响面审 2+2，全修）。① P-restore-skip 分支一断言改两步式——附着后**先发测试消息产生新增 entry** 再核对 parentId 链回溯连通（附着刚完成时新增 entry 不存在，直接 get_entries 会走假阴性）；② D3 契约保持式截断补 **block 级替换形态**——content 整字段替换为 `[{type:'text',text:占位}]`，对齐 event-interpreter.ts hook 改写分支的「保持 pi 持久化形态」先例；③ 错误规格表⑤档恢复指引修正——pi 按**首行 header 的 cwd 字段**判定而非文件所在目录，「只迁文件不改 header 无效」，指引改「原路径重建目录（推荐）或手工编辑 header cwd」；④ D6-⑦ 清理与轮转按**跨进程安全性分工**——超龄清理（unlink+mtime）跨进程安全由 main 每日复扫全前缀；size 轮转（rename）只由 writer 进程自做（zcode-appserver-stderr 的 writer 是 runtime，subagent-core connection.ts:578，main 跨进程 rename 会打断 append fd 形成孤儿 inode）；保留天数提升 shared constants 两进程共读；⑤ D6-⑨ 磁盘回收与图片显示恢复两通道分开声明（帽满后 session 内无自动缓解 + 手动出路）；⑥ A9② 补「轮转不打断写方」断言与 shared 旋钮来源。
- v7（2026-09-09）：第 6 轮复审修订（主审 1+1、影响面审 3+3，全修）。① A11⑤ 场景步骤补两步式执行序列（附着后**发送测试消息**、通过标准的核对主体改为该新增 entry 的 parentId 链——与探针表字面对齐，消除场景层假阴性）；② D3 注册表补非 content 条目的**类型保持形态契约**（arguments → record 占位 `{truncated,reason,originalBytes}`、数组条目 → 单元素占位数组）+ tool_call_end/tool_call_start 行号互换修正；③ D6-⑦ **固定名 stderr 文件从超龄清理清单排除**（固定名 + 持有型 append fd 被 unlink 后写入已 unlink inode，新 stderr 静默丢失——恰在崩溃取证时刻失效；治理唯一归 writer 侧 size 轮转）；④ 保留天数 shared 化声明为 `readLogKeepDays()`（env 覆盖 || 默认，两进程同调——不丢用户 env 旋钮也不漂移两套）；⑤ U5 文件地图补两落点（shared/constants.ts + subagent-core connection.ts 自轮转）；⑥ A9② 轮转断言对齐阈值校准法（帽值调小 + 重启 + 持续产出构造）+ 固定名不误删断言；A9③ 补 size 帽满断言链（超帽→占位→清目录重进→恢复）；⑦ cache 量级护栏「8×64MB」改精确表述（同时增长面 ≤8，LRU 非磁盘约束）。
- v8（2026-09-09）：第 7 轮复审修订（主审 0+0 通过；影响面审 1+1 + INFO 一并修）。① D6-⑨ 落盘顺序**显式声明为新→旧有序落盘、超帽即停、更旧图占位**——消除「处理链遇到即写」正序与「新落盘从最新开始」承诺的矛盾（正序在重度贴图场景会把窗口内较旧图写满帽、最新图占位，与承诺相反）；② readLogKeepDays 落点补 Node-only 边界声明（shared/constants.ts 被 renderer 大量 re-export，JSDoc 划界防误 import）；③ A9② 长寿模拟补清理定时器触发入口（dev 注入或临时 IPC，U5 定型）。
- v9（2026-09-10）：阶段 4 一致性审查修订（4 区 reviewer 聚合：11 unreasonable 分 5 组修复、doc_errors 本版全修）。① D5⑤/P-restore-skip/§3.4 表/A11⑤⑥ 回写实施期裁决——主形态（跳过 normalize）经交付门裁决不安全，按预设降级路径实现最小规范化（session-file-streaming.ts）；② A3/§3.4 熔断口径统一（前 3 次 reload、第 4 次熔断）；③ A10①/A11③ 随 u6 全量通路退役 re-scope 为游标世界口径；④ §3.4 renderer JS 错误行删「顶栏提示」（A4 口径为准）；⑤ T3 顶部条文案与 D4/A5 统一；⑥ D6-⑨ 补 base64 剥离两步走实施口径；⑦ D1「普查确认」措辞更新为「已接入」。
- v10（2026-09-10）：design-code-sync 第 1 轮修订（5 区 reviewer 全量终态审聚合）。① 悬空路径修正 5 处（relay-registry infra/relay/、session-records 与 trace-sync services/session/、pending transport/api/——目录段笔误，基线起即错）；② §2.2/§2.3 时点敏感表述加交付状态标注（「当前仍在」→「设计时点存在，已由 U1 修复」）；③ 探针表 P-stale-wording/P-guard-holds 状态列更新为已交付；④ D7 附着行与熔断括注回写 v9 降级形态口径（实施期遗漏的同源残留）；⑤ D5① 消费方枚举删已退役 getFullHistory 并补 [u6] 收窄说明；⑥ guardOutboundFrame 示意名改为真实形态（reply=message-broker.reply 内联 / push=guardOutboundPushFrame@publish 入口）；⑦ D2-① 补 addEventListener('error') 等价捕获面括注。
- v11（2026-09-12）：design-code-sync 第 1 轮修复（R1 findings，code-right 文档侧回写终态）。① D3 push 通路时序表述对齐终态实现——seq 预写 + drop 时 rollbackSeq 回滚，可观察等价于 seq 分配前判定（impl-plan 偏差 D2；§3.4 表 push/miss 两行与 P-publish-trunc 断言同步）；② D3 注册表补 U4 穷举新发现 3 条目（session.subagentEntriesAppended / message.bashResult / terminal.data）与 string 类形态契约（占位文案字符串本体，偏差 D3），声明终态注册表 SSOT = outbound-frame-registry.ts 文件头穷举表；③ D6-⑦ 与 §5 U5 地图回写 zcode-appserver-stderr 终态落点（packages/zcode-subagent-cli connection.ts:612 + @zhushanwen/subagent-engine-sdk stderr-rotation 单源，文件名带 pid 实例维度，落 `<engineDataDir>/logs/`——subagent-core 旧落点随 zcode 引擎自主化（W5）废弃），固定名超龄豁免清单收窄为 electron-runtime-stderr.log（zcode 侧不命中前缀白名单 + 三判据自清理）；④ D6-⑨ 图片缓存路径改 `<sha256(data)>.<ext>` 按 mimeType 映射（缺省 .png，偏差 D11；shared ipc-channels.ts JSDoc 同步）；⑤ §2.3 R2/R3/R4 行与 §2.4 无界点①-⑥ 补「设计时点存在，已由 UX 修复」标注（对齐 v10 E1/R1 先例，行号标注为 v1 基线时点锚）；⑥ 探针表 P-publish-trunc/P-paging/P-respawn-join/P-mem-api 回写 Gate B 结果（P-mem 打包版复验挂起；P-gone-reload 维持 Gate B fail 待复验不动）；A9② 清理触发入口回写 DEBUG_RUN_LOG_RETENTION 通道（log-retention-ipc.ts），zcode 轮转断言句同步终态口径；⑦ D1/§5 U1 补 subagent-workflow notifyDone/sendDelivery 已接入（impl-plan 偏差 D6；接入终态 SSOT = stale-ctx-audit.md §2）。
