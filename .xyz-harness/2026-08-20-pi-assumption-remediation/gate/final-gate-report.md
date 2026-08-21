# Final Gate 报告 — pi-assumption-remediation V1/V3/V4 真实 dev app 端到端抽查

- 执行日期：2026-08-20 04:55–06:32（local）
- 仓库：`/Users/zhushanwen/Code/xyz-agent-workspace/fix-chat-flow-order`，分支 `fix-chat-flow-order`，HEAD `c81c528f3`（工作区干净，`chat-app/` untracked 为认知外产物未触碰）
- 对应设计文档：`docs/architecture/pi-assumption-remediation.md` §4 Final gate
- pi 实装：`npm ls` 确认 `@earendil-works/pi-coding-agent@0.84.1`（所有 pi 语义断言基于 node_modules 实装 dist）

## 总结论

| 场景 | 判定 | 一句话结论 |
|------|------|-----------|
| V1 模型切换真实生效（G1） | **PARTIAL** | 切换机制四点全 PASS（含失败路径真错误），但**重启恢复 FAIL**：restore 路径恒带 `--model <默认>` 压过 pi 原生 entry 恢复（W1a 报告 116 行已预警的已知 gap，未修） |
| V3 thinking max（G3） | **PARTIAL** | xyz 链路「最高」=max 档真实存在并真实下发（WS payload `level:"max"` 一手证据）；但本环境唯一模型族 mimo 被 pi 钳制到 high（独立探针 + pi 源码双证据），get_state=max 在本环境不可达成 |
| V4 tool-call-index 真产出（G4） | **PASS** | `message.tool_call_start` 帧 `entry.contentIndex=1` 真实出现，toolCallId 与 pi JSONL toolCall.id、UI 块 testid 内嵌 id 三方一致，重开后工具卡片与结论完整保留 |

## 执行环境

| 项 | 值 |
|----|----|
| dev 启动 | 仓库根 `pnpm dev`（nohup 后台，共 5 轮生命周期，见下节） |
| 端口 | Vite 1420 / CDP 9222（Electron）/ runtime 3310（node），每轮启动前 `lsof -i :1420 -P -n` 核实归属 |
| CDP 页面 | `http://localhost:1420/?windowId=win-1`（dev renderer，无打包版混淆） |
| 模型起步 | `xiaomi-token-plan-cn/mimo-v2.5-pro`（ModelSelectPopover 实测仅此 provider 3 模型：MiMo-V2-Pro / MiMo-V2.5 / MiMo-V2.5-Pro） |
| dev 数据目录 | `~/.xyz-agent-dev/`（pi sessions JSONL 在 `~/.xyz-agent-dev/pi/sessions/`） |
| 探针 | ① CDP `Runtime.queryObjects` 复用页面已 auth 的 `ws://localhost:3310/` 挂 message listener（`gate-ws-hook.js`）；② 包装同 WS 的 `send` 抓 client→server 帧（`gate-ws-send-hook.js`）；③ 经同 WS 直发 RPC（`gate-rpc.js`）；④ 独立 pi CLI 探针（同 binary + `PI_CODING_AGENT_DIR` 隔离） |
| 收尾 | 全部 5 轮 PGID 精确 `kill -TERM`，1420/9222/3310 全空，/tmp 探针脚本与日志已清理 |

### dev 进程生命周期（5 轮）

| 轮 | PGID | 启动 | 终止 | 说明 |
|----|------|------|------|------|
| 1 | 43738 | 04:55:57 | ~05:00:0x 被 SIGTERM | 完成 V1 ①②④ 后死亡（对方启动抢占，见下节） |
| 2 | 36452 | 05:47:52 | ~05:48:3x 被 SIGTERM/SIGKILL | 启动 ~40s 再被杀；renderer 未完成 boot |
| 3 | 39191 | 05:53:03 | 05:53:3x 本方主动 kill | 与对方 05:53:01 重启竞态，本方 runtime 占 3310 致对方 bad token，立即归还 |
| 4 | 54529 | 06:14:0x | 06:27:0x 本方主动 kill | 完成全部三场景主体 |
| 5 | 57400 | 06:28:0x | 06:30:0x 本方主动 kill | V4 重开一致性验证 |

## 重大执行事件：并行 session 端口冲突（如实记录，全程未主动干扰对方）

背景：另一 worktree `fix-subagent-workflow-sidebar-sync` 同期在执行同名 pi-assumption-remediation 计划的 final gate（其 `.xyz-harness/2026-08-20-pi-assumption-remediation/` 存在）。双方共用 dev 端口 1420/9222/3310 与数据目录 `~/.xyz-agent-dev/`。

- 轮 1 死亡：05:00:0x 本方 dev 全树收 SIGTERM（vite exit 143 级联），05:00:25 对方 dev 启动接管三端口。时间线指向对方「启动前清理端口占用者」。
- 轮 2 死亡：05:47:36 对方 dev 退出（本方 watcher 确认后重启），~40s 后本方再被杀（对方 05:53:01 重启前的同款清理）。时间线指向对方「收尾/重启前清理」的连带伤害。
- 轮 3 竞态：与对方重启相差 2 秒，对方抢到 1420/9222、本方 runtime 占住 3310，对方 renderer 对本方 runtime 报 `auth failed: bad token`。本方立即 `kill -TERM -39191` 归还 3310，破坏窗口压到 ~30s。
- 后续策略：等待「端口释放 + 连续 180s 空闲」才启动轮 4（06:13:37 判定稳定空闲），此后无冲突。
- 期间本方 CDP 有 2 次误连对方页面（只读 evaluate + 一次空 subscribe RPC），零写操作。
- 另：本方一次 pi CLI 探针 `--continue <path>` 误用（pi 的 `--continue` 是布尔、按 cwd 取最近 session）在共享 sessions 目录创建了 1 个孤儿空 session 文件（01a01c1a，2 行），系本方探针产物非 app session，已删除并在此记录。

## V1 模型切换真实生效（G1）— 判定 PARTIAL

### 操作序列

| # | 操作 | 结果 |
|---|------|------|
| 1 | GUI 点「新建任务」 | session `01a01bd0-f6c1-78ac-84eb-62d042442b81` 创建（cwd `/Users/zhushanwen/Stock`） |
| 2 | 发「回复 ok」 | 基线正常：完整事件链 + assistant 回复（含 thinking 块） |
| 3 | 打开 ModelSelectPopover | 仅 1 provider 组（Xiaomi Token Plan CN）×3 模型——**无跨 provider 可选，按任务预案选同 provider 变体 MiMo-V2-Pro**（截图 `gate-v1-popover.png`） |
| 4 | 点选 MiMo-V2-Pro | ①②④ 见下 |
| 5 | （重启后被并行 session 打断，恢复后）重开该 session | 模型回到默认 MiMo-V2.5-Pro（⑤ FAIL，见下） |
| 6 | 重开后再切 MiMo-V2-Pro → 发消息 | provider 真实 400 报错 `Unsupported model mimo-v2-pro`（失败路径真反馈，截图 `gate-v1-error-surface.png`） |
| 7 | 改切 MiMo-V2.5 → 发消息 | 模型自报身份回复（③ 证据，截图 `gate-v1-switch-respond.png`） |

### 四点验证 + 重启恢复

① **UI 模型名变为目标** PASS：composer 芯片 MiMo-V2.5-Pro → MiMo-V2-Pro（切换后 3s DOM 断言；再切 MiMo-V2.5 同样生效）。

② **WS 权威状态确认** PASS：`session.state_changed` 广播（payload 来自 ReplicatedState 快照，fetch=get_state）：
```json
{"sessionId":"01a01bd0-...","modelId":"xiaomi-token-plan-cn/mimo-v2-pro","thinkingLevel":"high","usagePercent":4,"inputTokens":43609,"contextLimit":1048576}
```

③ **新模型真实响应** PASS：切 MiMo-V2.5 后发消息，`message.complete`：
```json
{"stopReason":"end_turn","usage":{"inputTokens":42608,"outputTokens":52,"totalTokens":43684},"content":"我是小米大模型 Core 团队开发的 MiMo-v2.5，拥有 1M token 上下文窗口。切换确认 ok"}
```
模型自报身份 MiMo-v2.5（state 字段之外的行为级证据）。附带失败路径实证：mimo-v2-pro 端点不支持，GUI 得到真实 400 错误浮出（`stopReason:"error"` + errorMessage 气泡），非假成功。

④ **JSONL 原生 model_change entry，无 custom 双写** PASS：最终 JSONL 4 条 model_change 全为原生形态（原文见 `v1-session-final.jsonl.snapshot`）：
```
MODEL_CHANGE#1: mimo-v2.5-pro 2026-08-19T20:57:55.068Z  (创建)
MODEL_CHANGE#2: mimo-v2-pro    2026-08-19T20:59:32.310Z  (首次 GUI 切换)
MODEL_CHANGE#3: mimo-v2-pro    2026-08-19T22:19:11.885Z  (重开后重切)
MODEL_CHANGE#4: mimo-v2.5      2026-08-19T22:20:16.975Z  (最终切)
```
全文件唯一 custom entry 为 `xyz.client-msg-id`，**无** `customType:"model_change"`（W1a 删除项确认未复现）。runtime 日志同步见 `[rpc] send: type=set_model`。

⑤ **重启恢复** **FAIL**：kill dev（轮 1 被 SIGTERM，等效冷重启）→ 轮 4 重启 → 重开 session →
- UI 芯片：**MiMo-V2.5-Pro**（非目标 MiMo-V2-Pro）
- `session.state_changed`：`modelId:"xiaomi-token-plan-cn/mimo-v2.5-pro"`（非目标）
- pi 子进程 args（ps 原文）：`--model xiaomi-token-plan-cn/mimo-v2.5-pro`

**根因链（全部一手证据）**：
1. pi 0.84.1 `main.js buildSessionOptions`：`if (parsed.model) → options.model = resolved`——CLI `--model` 恒优先于 session entry 恢复；
2. pi `session-manager.js getSessionContextSettings`：从 entry 路径恢复 model 的机制存在，但仅在无 CLI model 时生效（thinkingLevel 同理——本轮 restore 无 `--thinking` flag，`thinking_level_change` entry 的 high 恢复成功，模型未恢复，不对称恰好印证优先级）；
3. xyz `packages/runtime/src/infra/pi/rpc-client.ts:125-153`：`const model = this.options.model ?? getDefaultModel()`，**无条件**把 `--model`（显式或全局默认兜底）拼进 spawn args；
4. restore 路径（`session-lifecycle.ts restoreSession`）经 `buildPresetClientOptions(resolution, undefined, undefined)` 只带 preset 自身 model，pi 附着（switchSession）后无任何 set_model 补偿。
5. W1a 验收报告 116 行原文已预警：「CLI 显式 --model 覆盖恢复是 pi 既有语义；xyz-agent 桌面侧若依赖重启附着恢复模型，需注意不要总带显式 --model 参数（超 W1a 范围，记录备查）」——本 gate 实证该 gap 在 GUI 全链路真实存在。

（独立 CLI 探针对照：`pi --mode rpc --session-id <id>` 附着同 session，不带 --model 时 model 解析为 unknown 占位、get_state thinkingLevel=off——bare 探针环境无 provider 配置，未取得正向恢复证据；但 GUI 侧「带 --model → 恢复失败」已由 ①-④ 链条充分实证，且与 W1a 报告阶段 2 的「不带 --model 恢复正确」互为印证。）

## V3 thinking max（G3）— 判定 PARTIAL

### 操作序列

| # | 操作 | 结果 |
|---|------|------|
| 1 | 新建任务视图打开 ThinkingLevelPopover | 6 档实测：关/低/中/高/极高/最高（= off/low/medium/high/xhigh/max），「最高」可选中（截图 `gate-v3-popover-7levels.png`） |
| 2 | 保持「最高」发「想一下 17*23 等于多少，给出过程」 | session `01a01c1d` 创建，回复含 thinking 块 ×2 + 工具 ×1，结论 391 正确 |
| 3 | 会话内重选「最高」（send-hook 已装） | 完整链路捕获（下） |

### 双确认实测

① **ps args 含 `--thinking max`**：**不适用（链路形态差异）**——V3 session 的 pi 子进程 args 实测**无任何 `--thinking` flag**。GUI 创建流不传 thinkingOverride（renderer `useNewTaskFlow` 的 create 调用只带 cwd/label/presetId/projectId），thinking 在创建后经 `session.setThinkingLevel` WS RPC → pi `set_thinking_level` RPC 下发（runtime 日志 `[rpc] send: type=set_thinking_level` 佐证）。

② **get_state 返回 thinkingLevel 为 max**：**不可达成（pi 模型族钳制，非 xyz bug）**。证据链：

- xyz 下发值（client→server WS 帧原文，`gate-ws-send-hook.js` 捕获）：`{"type":"session.setThinkingLevel","payload":{"sessionId":"01a01c1d-...","level":"max"}}`——**「最高」=max 档真实下发**（thinkingLevelMap 为 null，UI 档位原样发送）；
- pi 实际生效（get_state 投影 `session.state_changed`，强制刷新新帧）：`"thinkingLevel":"high"`；
- JSONL `thinking_level_change` 仅创建时 1 条 high，set(max) 后**无新 entry**——pi `agent-session.js setThinkingLevel`：effectiveLevel=clamp(max)=high 与原值相同 → isChanging=false → 不写 entry 不发事件；
- 独立 pi CLI 探针（同 binary + PI_CODING_AGENT_DIR 隔离）：`get_available_thinking_levels` → `['off','minimal','low','medium','high']`（**mimo 模型族不含 xhigh/max**）；`set_thinking_level(max)` 后 `get_state` → `"high"`；
- pi 权威注释（types.d.ts:257）：`"xhigh" and "max" are only supported by selected model families`；pi-ai `models.js clampThinkingLevel` 对不支持的档位向上再向下找最近支持档。

**思考功能本身正常**：回复含 thinking 块（JSONL assistant content 首块 + UI「思考 ×2」徽标，截图 `gate-v3-thinking-block.png`）。

附带澄清（排查过程中的一手发现）：捕获到的 `session.thinkingLevelSet {level:"max"}` 帧是 runtime RPC handler 的 **reply 回显**（`settings-message-handler.ts:381` 用请求值 reply），不是 pi 事件——真 pi 事件因 isChanging=false 根本没发。该 reply 回显请求值（而非生效值）略有误导性，见问题清单 P3。

### 判定理由

- 「UI max 档缺失已修复」的可验部分（档位存在 + 真实下发）PASS；
- 「pi 侧 max 生效」在本环境唯一模型族上结构性不可验（pi 权威行为），如实记 PARTIAL 而非 FAIL——需一个支持 xhigh/max 的模型（如 GLM/Kimi 系）才能闭环 pi 侧验证。

## V4 tool-call-index 真产出（G4）— 判定 PASS

### 操作序列

| # | 操作 | 结果 |
|---|------|------|
| 1 | 新建 session 发「请务必使用 read 工具读取 /Users/.../fix-chat-flow-order/package.json …告诉我 name 字段」 | session `01a01c22`，模型真实调用 read 工具并给出正确答案 |
| 2 | WS 广播帧捕获（`gate-ws-hook.js`） | 下 |
| 3 | pi JSONL 对照 | 下 |
| 4 | UI 断言（展开 turn trace） | 下 |
| 5 | kill dev（轮 4）→ 重启（轮 5）→ 重开 session | 工具卡片与结论完整保留 |

### 事件流验证（核心）

`message.tool_call_start` 帧 `payload.entry`（原文）：
```json
{"toolCallId":"call_9a9a9b8415fd480392552b5b","toolName":"read","contentIndex":1,
 "messageId":"a-dab73c2f-7cb2-4592-8303-b8b4d4432fef",
 "arguments":{"path":"/Users/zhushanwen/Code/xyz-agent-workspace/fix-chat-flow-order/package.json"}}
```
- **`entry.contentIndex: 1` 真实出现**——W3 修复（toolcall_end 的 `sub.toolCall.id` + `contentIndex` 提取 → interpreter 缓存 → 附到 tool_call_start 帧）在生产 GUI 全链路真产出，非死代码；
- `messageId` 锚点同帧附带；
- `message.tool_call_end` 同 toolCallId，isError=false。

**id 对照（三方一致）**：
- WS 帧 `toolCallId` = `call_9a9a9b8415fd480392552b5b`
- pi JSONL assistant content 的 toolCall 块 `id` = `call_9a9a9b8415fd480392552b5b`（toolResult.toolCallId 同值）
- UI 工具卡片 `data-testid="block-tool-call_9a9a9b8415fd480392552b5b"`

**块序对照**：JSONL assistant content = `[thinking, toolCall]` → toolCall 位于 index 1 ≡ 帧 contentIndex=1；UI 展开后 4 块顺序 thinking → tool → thinking → text，工具卡片精确插在两 thinking 块之间（这正是顺序锚点的用途场景），无错位无丢失。

### UI 断言与重开一致

- 展开后 `.trace-blk` 列表（data-testid 原文）：
  `block-thinking-th-b60f4f0b…` / **`block-tool-call_9a9a9b8415fd480392552b5b`（read · /Users/…/package.json）** / `block-thinking-th-df079fd7…` / 末位 text「其中的 name 字段值是 xyz-agent。」（截图 `gate-v4-expanded.png`）
- 重开一致：kill dev → 重启 → 重开 session → 同 id 工具卡片 + 四块顺序 + 结论文本全部保留（截图 `gate-v4-reopened.png`）；折叠态只显末位 text + 「思考 ×2 工具 ×1」徽标为 D1 折叠作用域设计行为。

## 发现的问题（分级）

| # | 级别 | 问题 | 证据 | 建议 |
|---|------|------|------|------|
| P1 | **HIGH** | 模型切换重启恢复失效：GUI restore 路径恒带 `--model <全局默认>`（rpc-client.ts:125-153 无条件兜底），压过 pi 原生 model_change entry 恢复；用户切过的模型在重启重开后静默回退默认 | ⑤ 全套证据 + W1a 报告 116 行预警 | restore/spawn 附着路径不传 --model（让 pi entry 恢复生效），或附着后从 entry 读终态模型补偿 set_model；属长期方案 |
| P2 | MEDIUM | pi 侧 thinking max 档在本环境不可验：mimo 模型族 supported levels 止于 high，UI「最高」下发 max 被 pi 静默钳制（不写 entry 不发事件），用户无感知实际生效的是 high | 独立探针 + pi 源码 + JSONL | xyz 侧可调 `get_available_thinking_levels` 过滤 UI 档位或提示「该模型最高支持 high」；当前 UI 芯片在 session 建立后会回落显示「高」（pi 实际值），但下发瞬间的「最高」选中态与实际不符 |
| P3 | LOW | `session.setThinkingLevel` 的 RPC reply（`session.thinkingLevelSet` 帧的前身）回显**请求值**而非 pi 生效值，误导排查（本次实测被坑） | settings-message-handler.ts:381 | reply 生效值（pi get_state 或事件值），或文档标注 |
| P4 | LOW | GUI 创建流 thinking 不在 spawn args 下发（无 `--thinking` flag），改走创建后 RPC；与「--thinking max」类验收口径存在链路形态差异（非 bug，记录以免后续 gate 误判） | ps args 实测 + useNewTaskFlow 源码 | 验收口径区分「创建时档位」与「会话内切档」两条链路 |
| P5 | INFO | 环境事件：并行 worktree gate 共用端口互杀 3 次（本方 2 死 1 主动归还）；$TMPDIR 存在 5 个历史 `xyz-session-*.jsonl` 残留（历史 bug 证据，按要求未删，文件名见下） | 时间线 + `ls $TMPDIR` | 多 worktree gate 并行需端口/数据目录隔离机制（如 dev 端口参数化） |

$TMPDIR 残留清单（未删）：`xyz-session-019ffbea-a009-797b-a024-9b280dc3a309-1787154249451.jsonl`、`xyz-session-019ffd0c-18dc-750d-8892-65f2d5e26151-1787137829319.jsonl`、`xyz-session-019ffd0c-f84f-77bc-af1e-d1975be13bfe-1787136526690.jsonl`、`xyz-session-01a0095e-8952-77d3-b746-cab16da54989-1787154079514.jsonl`、`xyz-session-01a019c7-0c13-7508-8255-8986602bff2d-1787139239905.jsonl`

## 证据清单（gate/ 目录）

| 文件 | 内容 |
|------|------|
| `gate-v0-initial.png` | 初始空 session 视图（MiMo-V2.5-Pro + 最高） |
| `gate-v1-newsession.png` / `gate-v1-popover.png` | V1 新建 session / 模型弹层（单 provider 3 模型） |
| `gate-v1-error-surface.png` | mimo-v2-pro 真实 400 错误浮出 |
| `gate-v1-switch-respond.png` | MiMo-V2.5 自报身份回复 |
| `gate-v3-popover-7levels.png` / `gate-v3-thinking-block.png` | 思考档 6 选项 / thinking 块渲染 |
| `gate-v4-toolcard.png` / `gate-v4-expanded.png` / `gate-v4-reopened.png` | V4 工具卡片折叠态 / 展开四块 / 重开后 |
| `gate-ws-hook.js` / `gate-ws-send-hook.js` / `gate-rpc.js` | 三个探针脚本（可复现） |
| `v1-probe-outputs.txt` / `v3-v4-probe-outputs.txt` | 探针一手输出原文 |
| `v1-session-after-switch.jsonl.snapshot` / `v1-session-final.jsonl.snapshot` | V1 session JSONL 快照（含 4 条原生 model_change） |
| `v4-session.jsonl.snapshot` | V4 session JSONL 快照（toolCall id 对照源） |

## 收尾状态

- 全部 5 轮 dev 进程组精确 `kill -TERM -<PGID>`，无宽泛 pkill；1420/9222/3310 确认全空
- 打包版太极.app 及其 3 个历史 pi 进程（11:33PM/11:44PM/9:57PM 启动）全程未触碰
- /tmp 探针脚本、dev 日志已清理；仓库内唯一写入 = 本 gate/ 目录
