# pi-cw 嵌套 subagent 递归编排失活 — 排查 handoff

> **交接对象**：排查 pi / pi-subagent-workflow 平台机制的 agent。这不是 scheduler 业务问题，是 pi-cw 递归编排依赖的 pi subagent keep-alive 机制在嵌套场景下失效。
>
> **产出要求**：定位根因 → 给修复方案（pi-subagent-workflow 侧 / pi core 侧 / pi-cw 编排策略侧）→ 可选实现修复。

---

## 结论先行（根因假设，高度可疑）

pi 的 subagent keep-alive 机制（`@zhushanwen/pi-subagent-workflow` 的 `session-pending.ts`）通过**读取磁盘 session 文件**计算活跃后代数（`pending:register` − `pending:unregister` 差集），count=0 则在 `agent_end` kill 父进程。但 pending entry 的写入受 **pi 延迟写入策略**影响（`SessionManager._persist` 在首个 assistant 消息前**不落盘**）。

**当父 subagent 在首个 turn 内派子 subagent 后结束 turn**（`agent_end`）：
1. 子 subagent 启动时调 appendEntry 写 `pending:register`（进内存 fileEntries）
2. 父 subagent 此刻还没收到 assistant 消息 → `_persist` 不 flush → **磁盘 session 文件没有 pending:register**
3. `session-pending.readActivePendingFromSessionFile()` 读磁盘 → count=0
4. `runSpawn` 在 agent_end 判定"无活跃后代" → **kill 父进程**
5. 子完成时 `notifyDone` 发 `sendMessage({triggerTurn:true, deliverAs:'steer'})` → 送不到已 kill 的父 → **递归树断裂**

关键矛盾：`session-pending.ts` 注释声称"其进程内 appendEntry **同步写盘**，见 pi SessionManager._persist"，但 design.md D5（源码实测）+ AGENTS.md 规则 6 都确认 `_persist` 在首个 assistant 前**不落盘**。**`session-pending.ts` 的"同步写盘"假设是错误的**，这是 keep-alive 静默失效的根因。

这正是 pi-cw `design-v4.md` §10.2「subagent 空闲保活——close 了 steer 送不到。**需查 pi session 保活**」列为**待验证风险、未实际验证**的点。

---

## 现象（两次失活，同模式）

### 触发场景
scheduler extension 重构走 pi-cw 递归编排：主 agent → planning-agent(slice 层主) → wave-agent → dev-agent/review-agent。4 层嵌套。5 个 wave（once-echo / custom-entry-store / readme-docs / legacy-importer / e2e-verify）。

### 第 1 次失活（one-shot planning-agent）
- planning-agent（`sa-dd6d7f33`，one-shot 模式）完成 slice design + execute（拆 5 wave），派第一批 wave-agent，合并 once-echo / custom-entry-store / readme-docs。
- 派 custom-entry-store v2 wave-agent（gate 时序问题修复后）后 **completed**。
- custom-entry-store v2 实际完成合并了（commit `dfadd191c` 在主分支），但 planning-agent 没被唤醒继续派 legacy-importer / e2e-verify。
- **证据**：`cw frontier` 显示 legacy-importer / e2e-verify 一直 `created`（无人推进）；`pending_notifications` 为空；planning-agent session 已终止。

### 第 2 次失活（conversation planning-agent）
- 改用 conversation 模式重派 planning-agent（`sa-b0c5c1b8`），task 明确"持续推进到子树全 closed 才报告"。
- planning-agent 成功推进 legacy-importer（合并 `e5a824578`），派出 e2e-verify wave-agent（`sa-2db085c9`）。
- e2e-verify wave-agent 完成 design + design-review（cw 状态 `design-reviewed` @ 2026-08-12T15:16:41Z），派 dev-agent（session `019ff68d`）跑实测。
- dev-agent 写了实测脚本 `tools/verify-scheduler-e2e.cjs`（未提交），跑了 16 个 bash（多为探查），**没跑通实测就终止**。
- dev-agent 完成后 **wave-agent 没被唤醒**（cw 停在 design-reviewed，无 execute），planning-agent 也没被唤醒。
- **证据**：
  - `cw status e2e-verify`：statusHistory 最后一条 `2026-08-12T15:16:41 design-review -> design-reviewed`，之后再无推进；`executeResult.commitHash` = none
  - `session_read outline 019ff68d`（dev-agent）：仅 2 turns（T000 + T001），T001 跑完 read×12/bash×16/write/edit 后终止，无 T002
  - `session_read outline 019ff676-5ac4`（wave-agent）：仅 2 turns，T001 派 4 个 subagent 后无新 turn
  - `pending_notifications`：No pending operations（整条链路无活跃 agent）

### 共同模式
**嵌套 subagent 的"子完成 steer 唤醒父"在某一层断裂**。父 subagent 派子后结束 turn，子完成时 notify 送不到父（父已被 kill 或 session 失活）。不是单一 wave-agent 的 bug，是平台级 keep-alive / steer 投递机制问题。

---

## 机制分析

### pi-cw 设计假设（design-v4.md §1.2，"全源码确证"）
> 子完成注入 `subagent-bg-notify` + `triggerTurn:true`（`notifier.ts:195-206`），pi 给空闲父**开新 turn**（`agent-session.js:1087`）。回溯自底向上链式，事件驱动，无轮询。

**问题**：design-v4.md 引用的 `notifier.ts:195-206` 在当前版本**不存在**。实际 notify 实现在：
- workflow 完成：`@zhushanwen/pi-subagent-workflow/src/interface/helpers.ts` `notifyDone()`（:144-151）`pi.sendMessage({customType:'workflow-result',...}, {triggerTurn:true, deliverAs:'steer'})`
- subagent 完成：subagent-actions.ts 注册的完成回调（`BG_MESSAGE = "detached, will notify on completion"`）

### pi core 的 triggerTurn 处理（agent-session.js:1058-1098 `sendCustomMessage`）
```
if (deliverAs === 'nextTurn') → push _pendingNextTurnMessages
else if (isStreaming) → agent.steer / agent.followUp
else if (triggerTurn) → await _runAgentPrompt(appMessage)  // 开新 turn
else → 只 append，不开 turn
```
**triggerTurn 只在 `!isStreaming` 时开新 turn**。若父 session 已 kill/终止，`sendMessage` 调用要么抛错要么静默失败（源码无 close-state 兜底）。

### keep-alive 机制（session-pending.ts — 失活核心）
`@zhushanwen/pi-subagent-workflow/src/execution/session-pending.ts`：

```ts
// 背景（v4 递归编排）：层主 planning-agent 派子 subagent 后结束 turn 等待被唤醒。
// 若 runSpawn 在 agent_end 无条件 kill，进程被回收、steer 唤醒送不到，递归树断。
// 判定依据：子进程的 session 文件里 pending:register entry 减去 pending:unregister 的差集。

const RECENT_UNREGISTER_WINDOW_MS = 60_000;

export function readActivePendingFromSessionFile(sessionFile) {
  // fs.readFileSync(sessionFile) —— 读磁盘文件
  // 逐行 JSON.parse，统计 pending:register / pending:unregister
  // countActiveFromEntries(entries) 算差集
  return { count, recentUnregister, error? }
}
```

**关键注释**（session-pending.ts [S-4]）：
> count=0 → keep-alive **静默失效** → recursive tree 被杀、steer 丢失。

[S-4] 已意识到 count=0 的致命性，但它针对的是**序列化格式匹配**问题（冒号空格导致过滤失效），修复用"按值字符串匹配"。**这个修复解决不了"延迟写入导致 entry 根本没落盘"的 count=0**。

### 致命矛盾：appendEntry 同步落盘假设 vs pi 延迟写入
- **session-pending.ts 注释假设**：「其进程内 appendEntry **同步写盘**，见 pi SessionManager._persist」
- **design.md D5（源码实测，本仓库 `.xyz-harness/2026-08-12-scheduler-session-scope/design.md`）**：「`appendEntry` → `_appendEntry` → `_persist`（session-manager.js:724-731）——fileEntries **无 assistant entry 时不落盘**（flushed=false，等 assistant 到达全量写）」
- **AGENTS.md 规则 6**：「pi 的 `SessionManager._persist()` 在收到第一个 assistant 消息之前不会写入 session 文件」

三者矛盾。若 design.md D5 准确（appendEntry 首个 assistant 前不落盘），则 session-pending.ts 的"同步写盘"假设错误 → keep-alive 在首 turn 窗口失效。

### 失活时序（根因假设的具体化）
```
T0  wave-agent 启动（新 session，尚无 assistant 消息）
T1  wave-agent 派 dev-agent（background）
      → dev-agent 进程内 appendEntry('pending:register') 进 wave-agent 内存 fileEntries
      → wave-agent session 此时无 assistant 消息 → _persist 不 flush → 磁盘无 pending:register
T2  wave-agent 结束 turn（agent_end）
T3  runSpawn 调 session-pending.readActivePendingFromSessionFile(wave-agent.sessionFile)
      → fs.readFileSync 读磁盘 → 无 pending 行 → count=0
T4  runSpawn 判定"无活跃后代" → kill wave-agent 进程
T5  dev-agent 完成 → notifyDone → sendMessage({triggerTurn:true,deliverAs:'steer'})
      → wave-agent session 已 kill → 送不到 → 递归树断
```

---

## 排查方向（接力 agent 执行）

### 必验项 1：pi `_persist` 落盘时机（核实矛盾）
读 pi core `SessionManager._persist` 源码，确认 `appendEntry` 是否同步落盘。
```bash
PI=/Users/zhushanwen/.nvm/versions/node/v24.11.1/lib/node_modules/@earendil-works/pi-coding-agent/dist
grep -n "_persist\|flushed\|appendEntry\|fileEntries" "$PI/core/session-manager.js" | head -30
# 重点：_persist 的 flush 条件（是否要求 assistant entry）；appendEntry 是否调 _persist 且强制 flush
```
- 若 `_persist` 首 assistant 前不 flush → **根因确认**（session-pending 假设错误）
- 若 `_persist` 对 custom entry 强制 flush → 根因假设证伪，需另找原因（见必验项 3）

### 必验项 2：runSpawn agent_end 调 session-pending 的时机
找 runSpawn（subagent 进程管理）在 agent_end 调 `readActivePendingFromSessionFile` 的代码，确认：
- 读取的是**磁盘文件**还是**内存 fileEntries**（若内存则不受延迟写入影响）
- count=0 时的行为（kill？保守保留？RECENT_UNREGISTER_WINDOW 60s 窗口是否覆盖首 turn 派子场景）
```bash
PKG=/Users/zhushanwen/.pi/agent/npm/node_modules/@zhushanwen/pi-subagent-workflow/src
grep -rn "readActivePendingFromSessionFile\|agent_end\|agentEnd\|runSpawn\|kill\|reap" "$PKG/execution/" | head -20
```

### 必验项 3：最小复现实验
构造 3 层嵌套：主 agent → A(conversation) → B(background)。A 在**首个 turn 内**（无 assistant 消息）派 B 后结束 turn。观察：
- A 进程是否被 kill（`ps aux | grep pi`）
- B 完成后 A 是否被唤醒（A session 有无新 turn）
对照组：A 在**已有 assistant 消息后**派 B（绕过延迟写入窗口），看是否正常唤醒。
```bash
# 主 agent 派 A（conversation），A 的 task：第一个 turn 立即派 B(background, sleep 10s 后 return) 然后结束 turn
# 观察 A 进程存活 + B 完成后 A 的 session_read outline 有无 T002
```

### 必验项 4：subagent register pending 的实际写入路径
确认 subagent 启动时谁调 appendEntry('pending:register')，写到哪个 session 文件（父的还是子的）。
```bash
PKG=/Users/zhushanwen/.pi/agent/npm/node_modules/@zhushanwen/pi-subagent-workflow/src
grep -rn "pending:register\|registerPending\|pending-notifications\|appendEntry.*pending" "$PKG/" | head
```
关键：register 写在**父 session 文件**还是**子 session 文件**？session-pending.ts 注释说"读子进程的 session 文件"——若 register 写在父文件，session-pending 读子文件就永远 count=0。

### 修复方向（根因确认后）
1. **session-pending.ts 读内存而非磁盘**：若 runSpawn 能拿到子进程的内存 fileEntries（经 IPC），用内存 count 替代磁盘读取，绕过延迟写入。
2. **pending:register 强制 flush**：appendEntry pending 类型时强制 `_persist`（绕过 assistant 等待）——需 pi core 支持。
3. **首 turn 窗口保护**：session-pending 对"session 无 assistant 消息"（首 turn）的场景采取保守策略（不 kill，等首个 assistant 后再判）。
4. **pi-cw 编排策略规避**：planning-agent/wave-agent 派子前先确保自己 session 有 assistant 消息（如先做一个轻量 read 再派子）——这是 application 层 workaround。

---

## 当前工作区状态（scheduler 重构）

### cw 子树（`slice:scheduler-session-scope`）
| wave | 状态 | commit |
|---|---|---|
| once-echo | ✅ closed | `a3319fb41`（主分支） |
| custom-entry-store | ✅ closed | `dfadd191c`（主分支） |
| readme-docs | ✅ closed | `9536ab4a5`（主分支） |
| legacy-importer | ✅ closed | `e5a824578`（主分支） |
| **e2e-verify** | 🔒 **卡在 design-reviewed**（execute 从未发生） | — |

**主分支 HEAD**：`e5a824578`（refactor-schedule-architecture），git 工作区有 1 个未提交文件。

### 未提交产出（dev-agent 写的实测脚本）
- `tools/verify-scheduler-e2e.cjs`（1190+ 行，未提交，`git status` 显示 `??`）
- 脚本设计完整（spawn pi rpc + S1-S17 场景 + 副作用隔离），但**未跑通**（/tmp/e2e-sched* 无残留，dev-agent 终止前没成功执行实测）
- 脚本质量待 review（复用前先读 `tools/verify-pi-client-msg-id-mapper.cjs` 对照）

### 失活 agent（需清理 / 已清理）
- planning-agent `sa-b0c5c1b8`（conversation）：已 `close` 释放
- e2e-verify wave-agent `sa-2db085c9`：session 已终止（`session_read` 无 record / pending 空）
- dev-agent `019ff68d`：session 已终止（record 可读，2 turns）

### scheduler 业务代码状态（4 wave 合并产物，已验证）
- `replay.ts`（新增）+ `backend.ts`（委托 replay）+ `runtime.ts`（4 类 op appendEntry）+ `importer.ts`（新增）+ `store.ts`（已删）
- vitest 188 passed / typecheck EXIT 0（主分支 e5a824578 实测）

---

## 恢复建议（scheduler 重构收尾，独立于平台排查）

e2e-verify 是验证型 wave（不写产品代码）。平台 bug 修复前，建议**主 agent 亲自完成**（不依赖嵌套 subagent）：
1. review `tools/verify-scheduler-e2e.cjs` 脚本质量
2. 主 agent 直接跑关键 A 类场景（S1 once 回显 / S2 recurring / S3 session 隔离 / S5 resume / S9 删 session / S17 entry 增长）
3. B/C 类（fork / kill 进程 / xyz-agent dev app）标 followupActions
4. 手工推进 cw：`cw execute`（记实测脚本 commit）→ `cw test` → `cw exec-review` → `cw closeout` → slice `retrospect` + `closeout`

或等平台 bug 修复后用 pi-cw 重跑 e2e-verify wave。

---

## 关键文件索引

| 用途 | 路径 |
|---|---|
| **keep-alive 机制（根因所在）** | `~/.pi/agent/npm/node_modules/@zhushanwen/pi-subagent-workflow/src/execution/session-pending.ts` |
| workflow 完成通知 | `~/.pi/agent/npm/node_modules/@zhushanwen/pi-subagent-workflow/src/interface/helpers.ts` `notifyDone()` :114-151 |
| subagent 工具（BG_MESSAGE） | `~/.pi/agent/npm/node_modules/@zhushanwen/pi-subagent-workflow/src/interface/subagent-actions.ts` :43 |
| pi core triggerTurn 处理 | `~/.nvm/versions/node/v24.11.1/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js` `sendCustomMessage` :1058-1098 |
| pi core SessionManager._persist（待验证） | 同上 `dist/core/session-manager.js`（grep `_persist`） |
| pi-cw 递归编排设计 | `~/.pi/agent/npm/node_modules/@zhushanwen/pi-cw-tool/skills/pi-cw/design-v4.md`（§1.2 / §10.2） |
| scheduler design（D5 延迟窗口实测） | `.xyz-harness/2026-08-12-scheduler-session-scope/design.md` §3.3 D5 |
| 未提交实测脚本 | `tools/verify-scheduler-e2e.cjs` |
