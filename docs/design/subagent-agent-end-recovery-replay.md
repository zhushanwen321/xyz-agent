# subagent 通知恢复能力在新架构上的重放移植设计（replay port）

> **一句话结论**：dev-0.9.16 的新架构（pi-subagent-cli + engine protocol）已结构性消灭「subagent 完成后不通知」的挂死病根——agent_end 无条件终结 + 核心侧双 watchdog + RoundSupervisor 兜底，事故链每一环都有对应熔断；真正需要移植的只剩两件：**S2 握手悬挂 bug 修复**（重试轮丢失）与 **sessionFile 获取链补强**（D2 的精简重放：agent_end 惰性查询 + close 兜底扫描）。D1（迟到接受）已等价覆盖无需移植，D3/D3a/D4 的问题域在新架构不存在，判定不移植并给出证据。本文档是线 B 设计 [`subagent-agent-end-recovery.md`](subagent-agent-end-recovery.md) 在架构分叉后的重放移植裁决书。
>
> **层声明**：当前层 = 技术方案（重放移植裁决 + 落点设计）；下一层 = 实现计划（§5 拆分单元，供 dev-flow / coding-workflow 消费）。不跨层写代码。
>
> **状态**：设计完成，待用户审查（本轮不走对抗式审查，用户自审）。

---

## 1 背景目标

### 1.1 SCQA

- **S（情境）**：2026-09-09 carbon PROD 四次复现：6 路并发 subagent 派发全部 90 分钟墙钟超时耗尽，串行同任务 36s 正常。根因定案：get_state 握手一次性 7s 窗口失败 → `record.sessionFile` 永久缺失 → `agent_end` 时累积通知条目返 error → 旧 inproc session-runner 保守 keep-alive（永不 kill）→ `runSpawn` 永挂 → 通知链整条冻结。fix-subagent-no-notification 分支据此实现了四项机制并完整走过质量闭环（设计对抗收敛 → dev-flow 双 Gate → design-code-sync）：**D1** 握手迟到接受（迟到 response 幂等回填 sessionFile）、**D2** sessionDir 扫描兜底（按 identity entry 内容匹配找回 sessionFile）、**D3** agent_end 处置翻转（读不出 sessionFile 时开 15s/3 轮回补窗口，耗尽 kill 并按成功语义通知；**D3a** 无后代能力工具时零判定快路径）、**D4** spawn-channel 门面（spawn 七件原语归一收拢）。
- **C（冲突）**：合并时发现架构分叉——dev-0.9.16 提交 `0df9ef8b3`（W3）删除了 D1-D4 的全部宿主（`packages/subagent-core/src/execution/engine/engines/pi/` 整目录），新架构改为 `packages/pi-subagent-cli/` 独立引擎进程 + engine protocol。cherry-pick 物理不可行，直接 merge 撞架构分叉（已 merge --abort 一次）。**用户已拍板：以 dev-0.9.16 为主，在新架构上重新落地本分支功能。**
- **Q（问题）**：D1-D4 四项机制在新架构上哪些还有对象、哪些已无对象？无对象的如何证明其问题域被覆盖？有对象的以什么形态重放？
- **A（答案）**：逐项判定（§3.2 移植判定表）——D1 等价覆盖不移植；D2 精简重放（匹配键更换）；D3/D3a 问题域结构性消失不移植；D4 目标已由进程边界达成不移植。新增移植面收敛为 S2 修复 + agent_end 惰性回补 + close 兜底扫描三件。

### 1.2 系统是什么（受众补认知）

新架构的 subagent 执行链是**两层进程嵌套**（与旧架构单进程内 spawn 的本质差异）：

```
主 pi 进程（xyz-agent 宿主）
 └─ subagent-core 作为 extension 运行：SubagentService 编排、notify、RoundSupervisor
     └─ spawn① 引擎 CLI 进程（packages/pi-subagent-cli，NDJSON stdio 说 engine protocol v1）
         └─ spawn② pi rpc 任务子进程（--mode rpc，stdout 出 SdkEvent 流）
```

- **core ↔ 引擎**：10 个正向方法（initialize/run/read/…）+ 9 个反向通道（host/askUser、host/childSpawned 等），帧形态 SSOT 在 `packages/subagent-engine-sdk/src/protocol/frames.ts`
- **引擎 ↔ pi 子进程**：stdin 写命令（`prompt` / `get_state` / `extension_ui_response`），stdout 逐行 NDJSON 事件（`agent_end` / `message_end` / `response` 等），经 `spawn-event-translator.ts` 翻译成 AgentEvent 上抛
- **通知主 agent 的通路不经引擎协议**：run 终态 → core 进程内 `pi.sendMessage({customType:"subagent-bg-notify", triggerTurn:true})` 直投主会话（`packages/subagent-core/src/execution/notifier.ts:411-426`），另有 notify-ledger 四步兜底（写账 → settled 边沿投递 → 回执销账 → 重放幂等）

关键协议事实（理解后文的前提）：**rpc 模式 pi 子进程无 header 行，sessionFile 唯一正常获取通道是 get_state 问答**；pi 的 session 文件延迟落盘（首条 assistant 消息前不存在），所以 get_state 早期应答可能带 sessionId 但 `sessionFile` 为空——这正是 S2 bug 的触发形态。

### 1.3 设计目标

从使用者（派发 subagent 的主 agent / 最终用户）体验倒推：

- **G1（根除不通知）**：任何 subagent run——无论握手成败、进程死活、引擎崩否——终态必然到达主 agent（完成/失败/终止通知三选一），不存在无限等待。
- **G2（通知质量）**：完成通知携带结果正文与 `session_read` 截断指针行；sessionFile 尽最大努力获取（它决定 chat 域「Full transcript」指针、冷续 resume 锚点、session-reader 取证能力），但**其缺失不得阻塞通知**。
- **G3（防复发）**：失败类抽象为「一次性获取 + 失败不可恢复 + 下游无限保守等待」——新架构每环都必须有不依赖运气的外部熔断，且本文档把判定证据固化，防止未来重构时旧病根借尸还魂。

### 1.4 in / out scope

**in scope**：

1. S2 握手悬挂 bug 修复（`pi-subagent-cli/src/get-state-handshake.ts:82-91`，dev-0.9.16 review 已登记）
2. D2 精简重放：agent_end 惰性 get_state 回补（one-shot 域）+ close 收尾兜底扫描（总 miss 场景）
3. D1-D4 逐项移植判定书（含不移植的证据链，本文档 §3.2 即交付物）
4. 线 B 三份文档的重放移植修订登记（C-proc-10 纪律）

**out of scope**（显式排除，防蔓延）：

- keep-alive 后代保活编排迁回（W7 显式裁决域，重审触发条件未满足，见 §3.3 决策 3）
- runtime rpc-client 双轨调和的机制改造（仅作合并检查项，见 §3.3 决策 5）
- W 系列机制的任何改动（已 committed 且验收，只做只读核验）
- 线 B 已登记遗留 ① NotifyDomainPorts 加固（独立任务）与 ④ carbon 升级到含修复版本（部署侧动作）

---

## 2 现状与问题分析

> **本章结论**：事故六环链在新架构被逐环核验——主干（agent_end 保守处置 → 永挂 → 通知冻结）已结构性消灭，残留的活缺陷只有一个（S2 握手悬挂），外加 sessionFile 兜底强度不足（总 miss 场景无最后防线）。
>
> 本章全部行号基于 dev-0.9.16 worktree（HEAD `b1b0840a9`）实读。缩写：`CLI` = `packages/pi-subagent-cli/src`，`CORE` = `packages/subagent-core/src`。术语：**identity tracker** = 引擎侧会话身份追踪器（`CLI/spawn-run-pump.ts` 内，负责 sessionFile/sessionId 的回填与广播）；**LC-4** = dev-0.9.16 liveness 设计中「close 收尾按 sessionId 文件名后缀反查 sessionFile」的兜底项；**keep-alive** = 旧架构「agent_end 后为潜在后台后代保活子进程」的编排（判定依据 = session 文件内 `pending:register`/`pending:unregister` 条目差集）。

### 2.1 事故链在新架构的重放推演（逐环核验）

把 2026-09-09 事故的六环链逐环放到新架构上，验证每一环的现状：

| # | 事故环（旧架构） | 新架构对应环节 | 现状判定 |
|---|---|---|---|
| 1 | 6 路并发下 get_state 握手 7s 窗口全超时 | `CLI/get-state-handshake.ts:17-21`（3 次 × 2s 超时 + 500ms 间隔）同样一次性 | **残留缺陷 S2**：应答缺 sessionFile 时 Promise 永挂、剩余重试丢失（§2.2） |
| 2 | 迟到 response 被丢弃 → sessionFile 永久缺失 | identity tracker 监听表驻留至 close（`CLI/spawn-run-pump.ts:105-127`），迟到 response 走**同步路径**回填 sessionFile 并重发 handleReady（`:73-85`） | **已覆盖且强于旧 D1**（D1 是 `.then` 微任务回填，新架构是同一 data chunk 内同步可见） |
| 3 | agent_end 处置链读不出 sessionFile → error | `CLI/spawn-event-translator.ts:74-87`：agent_end（非 willRetry）→ `onAgentEnd()` → **无条件 kill**（`CLI/spawn-runner.ts:274-276`），不读 session 文件、无保守分支 | **病根环被删除**——旧架构把「读不出」当「可能有后代」无限保守；新架构 agent_end 即终态，kill 触发 close → run 应答 → 通知照发（结果从 stdout 事件累积，`CLI/output-collector.ts:233`，不依赖 sessionFile） |
| 4 | 保守 keep-alive → close 永不到 → runSpawn 永挂 | kill 链 SIGTERM → 30s grace → SIGKILL（`CLI/spawn-runner.ts:330-336`）保证 close 必达；run 帧不设墙钟但 close 是物理必然 | **已覆盖** |
| 5 | 通知链整条冻结（主 agent 永不知情） | run 终态 → core `finalizeEngineOutcome` → CollectCoordinator → notify-ledger 四步兜底 | **已覆盖**（正常终态 + 崩溃路径都有通知，见 §2.4） |
| 6 | 引擎/进程死亡后 record 无人管 | core 侧三层兜底（§2.4） | **已覆盖** |

**结论**：事故主干（环节 3-6）在新架构被结构性消灭。G1 在新架构上的既有达成度已经很高，本设计要补的是环节 1 的残余缺陷和环节 2 的兜底强度（G2）。

### 2.2 残留缺陷 S2：握手 Promise 悬挂（唯一活缺陷）

现场：`CLI/get-state-handshake.ts:82-91`——response 到达但 `collected.sessionFile` 为空时：

```ts
addResponseListener(reqId, (data) => {
  if (resolved) return;
  clearTimeout(timer);              // :84 本轮唯一驱动源被清除
  if (pendingRetry) clearTimeout(pendingRetry);
  extractGetStateFields(data, collected);
  if (collected.sessionFile) {
    resolved = true;
    resolve(collected);
  }
});                                 // :91 else 分支缺失：什么都不做
```

时序：应答缺 sessionFile（pi 首 flush 前的常态应答形态）→ listener 已被 `dispatchStateResponse` 一次性消费（同 reqId 不再触发）→ `:84` 清掉 2s timer，而 retry 只在 timer 超时回调里排（`:70-79`）→ `resolved` 未置位、不 resolve、不再有 timer → **Promise 永久悬挂**，与头注「最多重试 3 次」契约冲突。登记原文：dev-0.9.16 `.review/reports/round1/business-logic.md:27`。

影响面实测口径（不过度恐慌，也不过度轻描）：

- 调用点 `CLI/spawn-runner.ts:385` 是 `void ...then` fire-and-forget，timer 全 unref → **run 不阻塞、进程不挂**（不是旧事故的挂死形态）
- identity 的同步包裹路径（`spawn-run-pump.ts:106-111`）已尽力回填
- 净损失 = **剩余 2 次重试轮丢失** + 握手 promise 悬挂（若调用方将来改成 await 则变阻塞）→ sessionFile 缺失概率放大 → 下游降级（§2.3）
- 现存行为已被专测锁死：`CLI/__tests__/get-state-handshake.test.ts:163-192`（推进 20s writes 恒 1、settled 恒 false）——修复时需改写为契约断言

### 2.3 sessionFile 缺失的下游代价（G2 的量化）

新架构 sessionFile 三路获取（`CLI/spawn-run-pump.ts:65-129`）：header 行（rpc 模式无）→ get_state 应答（主体）→ close 时 LC-4 后缀反查（`findSessionFileByHeaderId`，按 `_<sessionId>.jsonl` 后缀扫 sessionDir，`spawn-event-adapter.ts:349-360`）。全 miss（连 sessionId 都没拿到）时 sessionFile 为 undefined，下游代价逐项：

| 下游消费点 | 缺失后果 | 严重度 |
|---|---|---|
| chat 域通知「Full transcript」指针行（`CORE/notifier.ts:287-288`，仅 chatMode 透传） | 整行省略，主 agent 无法定位全文 | 低（one-shot 域本来就没有此行） |
| `session_read {"action":"result","session":"<recordId>"}` 截断指针（`CORE/notifier.ts:202-204`） | 主 agent 按指针取全文失败/降级——长结果只剩通知里的截断正文 | **中**（这是主 agent 消化长结果的主通道） |
| chat 冷续 resume 锚点（`CORE/subagent-service.ts:1454,1493-1499`：record.sessionFile → run.params.chat.resume → `--session`） | 引擎死亡被 supervisor 纳管为 resumable 后，唤醒续跑无法 resume → 2h 决策看门狗最终以失败终态化 | **中**（崩溃恢复能力打折） |
| read ①级 pi 原生重建（session-view-service） | 降级到 ②级 journal 重放（core 侧 journal 一直在写）→ **读基本不丢** | 低 |
| session-reader 取证（事故复盘时唯一证据链） | 无法归档定位 | 低频高值 |

结论：sessionFile 缺失在新架构**不致命但真实伤质量**，且原事故的取证痛点（sessionFile 永久缺失）会原样复现。这是 D2 精简重放的全部理由。

### 2.4 通知必达的既有兜底核验（G1 只读验证项）

新架构「任何 run 必有终态通知」的证据链（全部只读核验，本设计不改）：

1. **正常终态**：agent_end → kill → close → run 应答帧 → `finalizeEngineOutcome` → notify。
2. **pi 子进程静默挂死**（agent_end 永不到）：core 侧 `armMidRoundNoProgress` 挂 30min 无进展检测，刷新源 = 协议事件（含 text_delta）——**arm 点在 chat/one-shot 分支之外**（`CORE/subagent-service.ts:2677`，kickOffChatRound 的 engine.run 派发前，函数同时服务两种形态，注释明示「非 chatMode = 一次性 run」）→ fire 即 kill + 该轮失败终态化 → 失败通知。
3. **引擎进程死亡（宿主存活）**：`engine_crashed` → `adoptResumableAfterEngineDeath`（`CORE/subagent-service.ts:2346,2402`，条件 `chatMode !== true` 即覆盖 one-shot）→ RoundSupervisor 三态（该等/该唤醒/该放弃，2h 决策看门狗 env 可关）→ steer 通知或终止通知。
4. **宿主重启**：`bootPartition` 重认领（initSession 挂点）→ 同 supervisor 流。
5. **通知投递本身**：notify-ledger 四步（写账 → settled 边沿投递 → 回执销账 → 重放幂等）。

### 2.5 物理数据流（sessionFile 获取链现状 → 本设计后）

```
现状（三路）：
spawn② pi 子进程 (--session-dir <engine dataDir 派生的 sessionDir>)
  │ stdout: response{get_state, data:{sessionId, sessionFile?}}   ← 主体通道（S2 缺陷在此）
  │         header 行（rpc 模式无）
  ▼
identity tracker (CLI/spawn-run-pump.ts)
  ├─ 应答同步回填 sessionFile/sessionId → host/handleReady → core record
  └─ close 时：clearStateListeners → LC-4 后缀反查（需 sessionId 已知）
                                  └─ 全 miss → sessionFile undefined（§2.3 代价）

本设计后（五路，新增两路标注 ★）：
  ① spawn 期握手 3×2s（S2 修复：重试轮不再丢失 ★）
  ② 握手窗口后的迟到 response（既有，同步回填）
  ③ agent_end 惰性 get_state 1s（★ M2，one-shot 域，子进程存活且空闲时点）
  ④ close 时 LC-4 后缀反查（既有）
  ⑤ close 时 mtime 窗口 + prompt 键扫描（★ M3，总 miss 最后兜底，安全放弃语义）
```

### 2.6 根因类抽象（防复发的靶子）

事故类 = **「一次性获取 + 失败不可恢复 + 下游无限保守等待」** 三件套。新架构已拆掉第三件（无保守等待）；本设计拆前两件（获取可重试 + 自然时点可再获取）。防复发的守卫姿势：① 获取链每一段的失败都必须是「有界放弃 + 降级可见（warn 日志）」，不得是「悬挂」或「无限重试」；② 下游消费 sessionFile 的代码一律按 optional 处理（现状已满足，验收守护）。

---

## 3 解决方案

### 3.1 终态（使用者视角）

**成功路径（one-shot workflow run，握手一切正常）**：与现状零差异——主 agent 收到 `subagent-bg-notify` 完成通知，通知正文形态（`CORE/notifier.ts:280-288`）：

```
Subagent "coder" (rec-8f3a) completed.

<结果正文（超预算时截断，并追加指针行）>
[truncated 12.3k of 45.6k chars — full result: session_read {"action":"result","session":"rec-8f3a"}]
```

主 agent 按指针行调用 `session_read` 即可取回全文。

**降级路径（复现事故形态：spawn 期握手 3 轮全超时）**：

1. 若迟到 response 在 run 存续期到达 → 同步回填（现状已有），后续与成功路径一致。
2. 若直到 agent_end 仍缺 → agent_end 时刻补一次 get_state（子进程刚完成 turn、空闲、负载已过，成功率远高于 spawn 时刻）→ 命中则 outcome 携带 sessionFile，通知质量与成功路径一致。
3. 若子进程对补查也不应答（stdin 断/楔死）→ close 时后缀反查 + prompt 键扫描 → 命中则 record 补上 sessionFile。
4. 全部 miss → 按现状语义收尾：run 正常终态、通知照发（结果正文来自 stdout 累积），`session_read` 指针行仍生成但 session-reader 侧降级（返回明确的「session file not found」而不是悬挂），warn 日志留痕 `[sessionfile] unobtainable for <recordId> (all 5 acquisition paths missed); record finalized without transcript anchor`。

**失败路径（pi 子进程楔死静默）**：30min 无进展 watchdog kill + 失败通知（现状已有，验收守护）。

**恢复指引（错误 → 权威源 → 重试）**：上述第 4 步 warn 文案中附下一步——「若需 transcript 取证，用 session-reader 列 sessionDir 内 mtime 窗口文件人工归档；若需完整结果，重派任务」。

### 3.2 D1-D4 移植判定表（本设计的核心裁决）

| 项 | 旧机制 | 新架构现状 | 判定 | 证据 |
|---|---|---|---|---|
| **D1 握手迟到接受** | resolver 在 resolved 后回调 `onLateResponse`，幂等回填 `!record.sessionFile` 守卫 | identity 监听表驻留至 close，迟到 response 同步回填 + handleReady 重发 | **不移植（等价覆盖且更强）** | `CLI/spawn-run-pump.ts:105-127`（驻留）`:73-85`（同步回填）；旧 D1 的 alive-marker 属已删 keep-alive 心跳体系，无对应物非缺口 |
| **D2 sessionDir 扫描兜底** | `locateSessionFileByScan`：mtime 降序 + identity entry（`subagent-identity` custom entry）内容匹配 | 仅 LC-4 后缀反查（需 sessionId 已知）；identity entry **结构性不再写入**（见决策 6） | **精简重放（M2+M3），匹配键更换** | 数据源消亡证据：`CLI/spawn-runner.ts:165-180` buildChildEnv 不注入 `PI_SUBAGENT_SELF_RECORD_ID`；引擎 CLI 以 `args:[]` 启动（`CORE/engine/engine-inspect-package.ts:190`）→ argv-mirror 无 extension flag → pi 子进程不加载 subagent-workflow extension → `appendSubagentIdentityEntry`（extension 内）无从触发 |
| **D3 处置翻转 + 15s 窗口** | error 分支开 15s/3 轮回补窗口，耗尽 kill 成功语义 | agent_end 无条件 kill 即正常路径；「读不出 → 保守永挂」失败模式连同处置链一起不存在 | **不移植（问题域结构性消失）** | `CLI/spawn-event-translator.ts:76-87` 头注（F1.2 根修记录 + keep-alive 未迁移登记）；窗口要守护的「保守等待」已无宿主 |
| **D3a descendantCapable 快路径** | 无后代能力工具时 agent_end 零判定直接杀 | 所有 run 都零判定直接杀 | **不移植（被整体包含）** | 同上；且默认部署下子进程无 subagent/workflow 工具（extension 不加载），「有后代」场景本身不成立 |
| **D4 spawn-channel 门面** | 七件原语 + 四维策略收拢为受控子入口 | 单一家园已由进程边界达成（原语全部住在 pi-subagent-cli + SDK） | **不移植（目标已达成，方式更彻底）** | 门面文件随 engines/pi 删除；线 B 自评「七件仅 LF 行读取实际被 runtime 消费」（impl-plan R4），该消费随合并放弃（决策 5） |

### 3.3 关键决策与权衡

**决策 1：S2 修复选「应答不完整视同未应答」（方案 A），不选显式 else 排 retry（方案 B）**

- 方案 A：`clearTimeout(timer)` 移入 sessionFile 命中分支——应答缺 sessionFile 时保留本轮 timer，由既有 2s 超时回调驱动 retry（`CLI/get-state-handshake.ts:70-79` 现成逻辑）。
- 方案 B：`:90` 后补 else 分支立即排 `pendingRetry`。
- 选 A 理由：retry 的排定权威只有一个（timer 超时回调），B 会造出第二条排定路径，未来改节奏时两处易漂移；A 的代价仅是该轮慢 ≤2s（对 7s 总窗无关痛痒）。长期方案。
- 同批改写锁死现存行为的专测 `get-state-handshake.test.ts:163-192` 为契约断言（缺 sessionFile 应答 → 剩余重试照发 → 3 轮耗尽 resolve）。

**决策 2：M2 = agent_end 惰性 get_state 回补（消费零调用方的 `requestGetStateOnce`）**

- `CLI/get-state-handshake.ts:105-138` 的 `requestGetStateOnce` 注释自述「agent_end 决策点惰性回补专用」，随迁后零生产调用方（其消费者 session-runner 已删）——M2 就是给它接上消费面。
- 落点：`buildTranslatorOpts` 非 chatMode 的 `onAgentEnd` 分支（`CLI/spawn-runner.ts:274-276`）改为 async 编排：同步段先置 `runEnd.endedCleanly = true`（保住「end 与收尾之间被杀」的 exit 0 口径），随后 `void (async () => { 回补; killChild(); })()`——kill 延后 ≤1s（`LAZY_GET_STATE_TIMEOUT_MS` 量级，控制面单请求秒级，合规规则 19），对已完成 turn 的子进程无副作用。
- 回补结果走 identity tracker 既有 `applyGetStateFields` + handleReady 通路（与迟到 response 同一条回填面，幂等语义免费继承）。
- 竞态清单（重演过）：① 查询期间子进程自行退出 → close finalizer 照跑（`endedCleanly` 已置位，exit 0），监听表被 `clearStateListeners` 清空 → `requestGetStateOnce` 超时 resolve 空对象 → `killChild` 落在已死进程上必须幂等 no-op（实现检查点 K2）；② 查询应答与 kill 竞速 → 应答先到则回填生效，kill 先到则 close 清监听、resolve 空对象，无害；③ chat 域不经此分支（chatMode 在 `onAgentEnd` 另一分支，不 kill，靠存活期迟到回填 + LC-4）。
- 被否方案：15s/3 轮窗口整体重放——窗口守护的「处置决策」已不存在，重放 = 为不需要决策的场景造决策，违反减法原则。

**决策 3：D3/D3a 不迁回 keep-alive（尊重 W7 显式裁决）**

- 协议化 impl-plan 合理偏差登记表原文（dev-0.9.16 `docs/design/subagent-engine-protocolization.impl-plan.md` §5 W7 行）：「后台 pi 后代保活/steer 唤醒场景为行为差异……重审触发 = 用户报告后台任务静默/失联；G5『现有能力零回归』在该场景域不适用（显式裁决记录）2026-09-09」。
- 重审触发条件（用户报告后台任务静默/失联）至今未满足；且 §2.4 的三层兜底已覆盖「静默必终态」。「后代保活」是另一个产品能力问题（子进程要能先有后代工具才谈得上保活——默认部署连工具都没有），若未来要做属新设计，不是本移植的欠账。

**决策 4：M3 兜底扫描的匹配键 = prompt 内容（替代已消亡的 identity entry）**

- 键设计：close finalizer 内（LC-4 之后、`resolveExit` 之前），若 sessionFile 仍缺 → 扫 sessionDir 内 mtime ∈ [spawnStartedAtMs, close] 的 `.jsonl` 候选 → 逐候选前向读头部（首 ~64KB）→ `includes(promptHead)`（任务 prompt 前 ~200 字符）→ **单命中才采纳，零命中/多命中一律放弃 + warn**（误配比漏配危险：错文件会污染 resume 锚点与取证）。
- 选 prompt 键理由：引擎侧天然持有（run params 的 task prompt），零协议改动、零 extension 依赖；两并发任务前 200 字符相同才会多命中（≈ 重复派发同一任务），此时放弃是正确语义。
- 线 B 的 `session-file-locator.ts` 骨架可参考（mtime 过滤 + 前向读 + 候选级容错），但匹配键与命中语义按本节重写，不做逐字 cherry-pick。
- 诚实成本声明：M2 之后全 miss 概率是 rare²（握手总失 × agent_end 补查又失）。M3 的价值主要是取证完整性与「根本性」的收口，实现摩擦超预期（如 prompt 非逐字落盘）可降级放弃，见检查点 K3。

**决策 5：runtime rpc-client 合并取向 = dev-0.9.16 版为准**

- 线 B 曾把 runtime `rpc-client.ts` 切到共享 spawn-channel 行读取（D4 唯一兑现的消费）。dev-0.9.16 的 rpc-client 独立演进（含 W7 `lastEventAt` 信号面）。合并时取 dev-0.9.16 版，放弃线 B 的切换——归一已由进程边界达成，runtime↔主 pi 长驻通道与引擎 spawn 通道是两个对象（真差异）。
- 检查点 K4：diff 两版 rpc-client，确认线 B 侧无独立 bug 修复需要重放（已知线 B 改动仅为消费切换 + CRLF 防御测试，预期无欠账）。

**决策 6：不恢复 identity entry 数据源（显式记录被否谱系）**

- 被否方案：buildChildEnv 注入 `PI_SUBAGENT_SELF_RECORD_ID` + 协议 v1.x 增加 extension 路径传递——需要 run 协议加字段、argv 传递链全通、子进程加载 extension 带来 pending relay 等副作用面，为 rare² 场景引入协议演进，不成比例。
- 击穿反例：即使注入 env，extension 不加载 `appendSubagentIdentityEntry` 依然不触发（它读 env 后由 extension 的 session_start hook 写盘）——数据源恢复的最小代价也要动 extension 加载链，非 env 一行。

**决策 7：实施基底 = 本分支 merge dev-0.9.16 后在其上实现**

- 本 worktree（fix-subagent-no-notification）无 `packages/pi-subagent-cli`（实测确认），移植代码无处落。推荐顺序：先 `git merge dev-0.9.16`（架构面整体取 theirs：packages/* 全取 dev-0.9.16；冲突集中在文档归位与少量双改文件，按决策 5 取向解），再在其上实现 M1-M4，完成后 dev-merge 回 dev-0.9.16（届时接近 fast-forward）。
- 被否方案：另开基于 dev-0.9.16 的全新 worktree——分支叙事断裂、线 B 文档与实现分离在两个分支上，合并时还要二次归位。
- 风险与缓解：大 merge 冲突面比上次小（上次撞的是「直接合并旧实现」，本次架构面定向取 theirs）；merge 后先跑全量测试三连确认基底绿，再动手。

**决策 8：文档处置（C-proc-10 同步纪律）**

- 线 B 三份文档（`subagent-agent-end-recovery.md` + `.impl-plan.md` + 涟漪 `subagent-core-unbounded-wait-audit.md`、`troubleshooting.md` §12）随合并带入 dev-0.9.16，头部加「架构分叉后的重放移植」修订记录：D1-D4 判定结论、新落点（M1-M3）、旧实现文件已随 engines/pi 删除。
- 本文档（replay.md）是重放的权威 SSOT；`node scripts/check-doc-symbol-drift.mjs` 必须过（pre-commit 按路径触发）。

### 3.4 错误规格（新增/改动面）

| 边界 | 行为 | 恢复指引 |
|---|---|---|
| 握手应答缺 sessionFile（S2 修复后） | 保留 timer，2s 后照常排 retry，3 轮耗尽 resolve 已收集字段 | 无需恢复——这是正常降级 |
| agent_end 补查超时/写 stdin 失败 | resolve 空对象，照常 kill，不重试 | 交 M3 兜底 |
| M3 扫描零命中/多命中 | 放弃 + warn（含 recordId、候选数、放弃原因） | warn 文案附「session-reader 人工归档 / 重派任务」指引 |
| kill 落在已退出子进程 | 幂等 no-op（K2 验证 killChain 既有守卫） | — |
| M2 期间子进程自行退出 | endedCleanly 已置位，close 走 exit 0，补查自然落空 | — |

---

## 4 验收

> 全部场景映射 §1.3 目标；真实场景优先，单测只作契约守护。实施完成后逐条执行并回填结果。
>
> **验收分层声明**：V2-V4 的被测系统 = 引擎 CLI 真实进程 + 真实 spawn/stdio/时序边界，仅 pi 对端用可控协议脚本进程替代（dev-0.9.16 conformance 测试的 fake-engine 同先例）——S2/M2/M3 验证的是握手与收尾的时序行为，需要可控构造「应答缺字段/不应答/延迟」形态，真实 pi 无法确定性构造；V1 用真实 pi 端到端兜底事故形态。

| # | 场景 | 步骤 | 通过标准 | 回溯 |
|---|---|---|---|---|
| V1 | 事故形态重放（6 路并发 one-shot） | dev app（`pnpm dev`）真机，主会话派发 6 路并发 workflow subagent（同 carbon 任务形态），等待完成 | 6 条完成通知全部到达（分钟级，无 90min 挂死）；通知含结果正文；抽 1 条 record 验证 sessionFile 非空且 session-reader 能读全文 | G1、G2、M2 |
| V2 | S2 契约（应答缺 sessionFile） | 协议脚本对端（conformance fake-engine 先例）：首答在 2s 超时后到达且 payload 不含 sessionFile（模拟 pi 首 flush 前应答形态） | 日志显示 attempts 继续推进到 3；最终 collected 带 sessionId；close 后 sessionFile 经 LC-4 落位 | G2、M1 |
| V3 | agent_end 补查（握手总失 + agent_end 恢复） | 协议脚本对端：spawn 期 get_state 三轮全部不应答（对端扣住应答），正常跑完任务出 agent_end，agent_end 时刻对端恢复应答 | outcome.sessionFile 非空；主会话通知可 session_read 取回全文；总耗时较正常路径 +≤1s | G2、M2 |
| V4 | M3 兜底（全程不应答） | 协议脚本对端：get_state 全程不应答（spawn 期 + agent_end 期），对端正常落盘 session 文件后跑完 | close 后 record.sessionFile 经 prompt 键扫描补上（单命中）；若构造多命中（同 prompt 双开）则放弃 + warn，run 仍正常终态、通知照发 | G2、M3 |
| V5 | 通知必达回归（楔死形态） | 协议脚本对端：出完 turn 前段后停止输出（静默楔死） | 30min watchdog 路径 fire（fake timers 单测守护 + 代码核验 arm 点覆盖 one-shot），失败通知到达 | G1（只读守护） |
| V6 | 常规回归 | 正常单路 one-shot + 一条 chat 域 subagent（含冷续一次） | 行为与现状零差异：通知、结果、sessionFile、resume 全部正常 | G2 |
| V7 | 机器门 | `pnpm --filter @zhushanwen/pi-subagent-cli test` + core 全量 + tsc + pre-commit 全守卫 + `node scripts/check-doc-symbol-drift.mjs` | 全绿 | G3 |

V2-V5 的协议脚本对端 = 独立验证脚本进程（按 pi rpc 协议应答，形态可控），用完归档移除（对齐 AGENTS.md「外部系统对接先验证再编码」惯例）。V1 是真实 pi 端到端。V5 的 watchdog 30min 不真跑，以单测 + arm 点代码核验代替（量级依据已有 P-T2c 探针先例）。

---

## 5 下一层拆分

### 5.1 实施单元

| 单元 | 内容 | 文件改动地图 | justification / 验收挂钩 | 依赖 |
|---|---|---|---|---|
| **M0 合并基底** | 本 worktree `git merge dev-0.9.16`：packages/* 取 theirs；文档冲突保两套（线 B 三份 + dev-0.9.16 全部）；决策 5 取向解 rpc-client | 无新改动，纯合并 + 冲突解决 | 合并后全量测试三连绿才动手——基底不绿后续无从归因 | — |
| **M1 S2 修复** | 决策 1：clearTimeout 移入命中分支；改写锁行为专测为契约断言 | `packages/pi-subagent-cli/src/get-state-handshake.ts:82-91`；`__tests__/get-state-handshake.test.ts:163-192` | 独立可验收（V2 + 单测）；最小 diff 先行，与 M2/M3 解耦 | M0 |
| **M2 agent_end 惰性回补** | 决策 2：onAgentEnd 非 chatMode 分支 async 编排 + requestGetStateOnce 接线 + killChild 幂等核验（K2） | `packages/pi-subagent-cli/src/spawn-runner.ts:274-276`（+ 新增惰性回补小函数）；测试：agent-end 补查用例（fake timers + fake child） | V3；消费死导出即「欠账清偿」，接口已备 | M0（不依赖 M1，可并行） |
| **M3 close 兜底扫描** | 决策 4：prompt 键扫描器（参考线 B locator 骨架重写）+ close finalizer 接线（LC-4 之后） | `packages/pi-subagent-cli/src/session-file-locator.ts`（新）；`spawn-run-pump.ts:201-216`（close finalizer 插入点）；`index.ts` barrel 按域插入；测试：单命中/零命中/多命中/坏行容错 | V4；rare² 场景 + 取证价值，允许依 K3 降级 | M0 |
| **M4 文档与守卫** | 决策 8：线 B 三份文档头部修订记录 + troubleshooting §12 同步 + check-doc-symbol-drift 过 | `docs/design/subagent-agent-end-recovery.md`、`.impl-plan.md`、`subagent-core-unbounded-wait-audit.md`、`docs/troubleshooting.md`；本文档回填验收 | V7 | M1-M3 |

### 5.2 待验证检查点（设计阶段无法定死，实施期核验）

- **K1**：`requestGetStateOnce` 的 `addResponseListener` 参数接线——用 identity tracker 的 `addStateListener`（自动过 `applyGetStateFields`）还是裸路由注册；倾向前者（回填面统一），实施时核对签名。
- **K2**：`killChild`（→ killChain）对已退出子进程的幂等性——预期既有守卫（`child.exitCode !== null` 判活先例），实施时核实并补测试。
- **K3**：pi session 文件里 user prompt 是否逐字落盘（M3 匹配键前提）——V4 harness 顺带验证；若非逐字（截断/转义），M3 降级为「只做 mtime 窗口 warn 留痕不自动采纳」，修订记录登记。
- **K4**：两版 rpc-client diff 核验（决策 5 残余风险）。
- **K5**：M0 合并冲突实际面（预期：eslint.config.mjs、测试文件位置、文档；若 packages/ 出现大面积冲突说明取向判断有误，停下重估）。

### 5.3 线 B 已登记遗留的处置（随本设计闭环）

| 遗留项 | 处置 |
|---|---|
| ① NotifyDomainPorts 端口缺席加固 | 维持独立任务，不并入（out of scope） |
| ② S6 session_read 指针行端到端 | M2/M3 直接改善其数据面（sessionFile 命中率↑）；V1/V3 验收覆盖，观察项可关闭 |
| ③ 存量测试 flake 三项 | 随 engines/pi 删除消亡（M0），无需处理 |
| ④ carbon 需升级 | 部署侧提醒：修复生效前提是宿主升级到含本设计的 xyz-agent 版本 |

### 5.4 超时哲学合规声明（规则 19）

本设计新增的全部时限均为控制面/回收层量级：M2 补查 1s（单请求）；M3 扫描有界（候选数 × 64KB 头读）；未引入任何任务级墙钟。任务执行正常路径（run 帧）维持不设超时现状。
