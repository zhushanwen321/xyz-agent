# P0 Gate 场景 1 前半：pi 层端到端验证报告（rename-session 防覆盖守卫）

- **日期**：2026-08-19（实验时间本地 03:55–03:56，日志 ISO 时间戳为 UTC）
- **验证者**：P0 gate 执行者 A
- **验证对象**：W1 修复本质链路「`set_session_name` RPC 更新 pi 内存后，rename-session 扩展的防覆盖守卫 skip」在真实 pi 子进程中成立
- **总结论：PASS**（实验组四条断言 + 对照组全部通过）

## 1. 环境与验证方法

| 项 | 值 |
|---|---|
| pi CLI | repo `node_modules/@earendil-works/pi-coding-agent@0.84.1/dist/cli.js`（`--mode rpc` + `--approve`） |
| 主模型 | `xiaomi-token-plan-cn/mimo-v2.5-pro`（真实 LLM 调用） |
| rename 标题模型 | 同上（经 tmp `PI_CODING_AGENT_DIR/config/rename-session-ext-config.json` 显式指定，不依赖全局配置） |
| 扩展 | `extensions/rename-session/`（入口 `index.ts`，本地源码直接加载） |
| 隔离 | 每组实验独立 `mkdtemp` tmpdir（agentDir + sessions），auth 从 `~/.pi/agent/auth.json` 迁移 |
| 驱动 | 复用扩展自带 e2e harness（`e2e/harness.mjs`：spawnPi + RPC client + stderr 日志轮询 + 精确 PID kill + tmp 清理），实验脚本放 /tmp（任务约束不改仓库） |
| 日志 | `XYZ_AGENT_DEBUG=1` → 扩展 debug 日志经 pi 子进程 stderr 输出（`[rename-session] t=<ISO> ...`），与 stdout RPC JSONL 交错记入 timeline |

关键代码位置（守卫链路）：

- 防覆盖守卫：`extensions/rename-session/src/index.ts` L67-74 —— `callRenameLLM().then()` 内 `if (pi.getSessionName()) { debugLog("skip: name exists"); return; }`
- 一次性语义前置守卫：同文件 L52-57 —— `countSuccessfulAssistantReplies(entries) !== 1` 时 `skip: count=<n>` 提前 return
- pi 侧 `setSessionName`：pi `agent-session.ts` L2718 —— `appendSessionInfo(name)`（JSONL append）+ 内存更新 + `session_info_changed` 事件

**与任务流程的一个必要偏差说明（断言 a 形态）**：任务预期「手动改名后的后续轮次出现 `skip: name exists`」。读代码确认：`skip: name exists` 只发生在 **rename LLM 调用窗口内**（首 turn 后 2-30s）手动命名的竞态命中点；后续 turn 2/3 因 `count!==1` 前置守卫提前 return（`skip: count=2/3`），根本不会发起第二次 rename LLM 调用，故该文案在「先等 auto-rename 完成再改名」的流程中不可能出现。两条路径的防覆盖效果等价，本验证对两者都做了真实实验：

- **主实验**（任务实验组严格流程）：验证「auto-rename 完成后手动改名 → 后续对话不覆盖」（count 守卫路径）
- **竞态实验**（任务断言 a 的真实载体，A3-3b 同构）：验证「rename LLM 窗口内手动改名 → 守卫打出 `skip: name exists`」（name-exists 守卫路径）

## 2. 实验组 · 主实验（任务流程严格版）

流程：tmpdir 起 pi → prompt「用一句话介绍 TCP 协议的核心作用」等 round 完成 → 等 auto-rename（`renamed to` 出现）→ `set_session_name`「重构计划」→ 再发 2 条 prompt 各等完成 + 10s 迟到覆盖观察窗。

### 2.1 时间线（日志摘录，t 为 UTC）

```text
03:55:30.000  pi spawned (tmp=rename-e2e-p0main.wxiUXw)
03:55:33.796  round 1 settled (agent_settled)
03:55:33.786  [rename-session] LLM request messages: [user:"用一句话介绍 TCP 协议的核心作用", assistant:"TCP 的核心作用是在不可靠的网络上…字节流传输。", user:<slug 指令>]
03:55:35.387  [rename-session] rename with model xiaomi-token-plan-cn/mimo-v2.5-pro
03:55:35.387  [rename-session] turnIndex=0 renamed to "TCP核心作用简介"        ← auto-rename 正常发生（改名前，预期）
03:55:35.391  set_session_name "重构计划" success=true                          ← W1 后 xyz 手动 rename 路径
03:55:40.357  round 2 settled（prompt：UDP 与 TCP 区别）
03:55:40.356  [rename-session] turnIndex=0 skip: count=2                        ← 后续轮守卫（一次性语义）
03:55:42.069  round 3 settled（prompt：三次握手目的）
03:55:42.069  [rename-session] turnIndex=0 skip: count=3
03:55:52.573  10s 迟到覆盖观察窗结束（无任何新 rename 活动）
```

### 2.2 四条断言结果

| 断言 | 结果 | 证据 |
|---|---|---|
| a. 守卫生效（本流程形态：count 守卫；`skip: name exists` 由竞态实验覆盖） | **PASS** | 后续轮次日志 `turnIndex=0 skip: count=2`、`turnIndex=0 skip: count=3`；改名后 LLM request 新增 0 条、`renamed to` 新增 0 条；`skip: name exists` 出现 0 次（符合代码路径预期，非缺失） |
| b. `get_state` 返回 sessionName=「重构计划」 | **PASS** | `get_state.data={sessionName:"重构计划", sessionId:01a01671-7a5d-7811-8a1e-4758b6f0a333, messageCount:6}` |
| c. JSONL 中手动改名后有且仅有一条新 session_info（无 LLM 覆盖） | **PASS** | 改名前 `["TCP核心作用简介"]` → 改名后 `["TCP核心作用简介","重构计划"]`，新增恰 1 条且 name=「重构计划」（id=e7bf53e8，timestamp=19:55:35.391Z）；最终条目 name 仍为「重构计划」 |
| d. 会话过程无错误 | **PASS** | 3 个 round 的 turn_end stopReason 全部 `["stop","stop","stop"]`；pi 全程存活；stderr 无 `rename LLM call failed` / `[pi-rename-session] failed:`；RPC 全部 success |

### 2.3 JSONL session_info tail 摘录

```jsonl
{"type":"session_info","id":"ffc16e29","timestamp":"2026-08-18T19:55:35.387Z","name":"TCP核心作用简介"}
{"type":"session_info","id":"e7bf53e8","timestamp":"2026-08-18T19:55:35.391Z","name":"重构计划"}
```

手动改名后新增且仅新增「重构计划」一条；此后 2 轮对话 + 10s 观察窗内 session_info 不再增长。

## 3. 实验组 · 竞态实验（断言 a「skip: name exists」真实载体）

流程：另起 tmpdir pi → prompt「用一句话介绍 HTTP 协议」→ 轮询 stderr 等 `LLM request messages:` 日志出现（rename LLM 调用进行中）→ **0ms 后**立即 `set_session_name`「重构计划」→ 等 rename 终态。attempt 1 直接命中，无重跑。

### 3.1 时间线（日志摘录，t 为 UTC）

```text
03:56:01.386  [rename-session] LLM request messages: [user:"用一句话介绍 HTTP 协议", assistant:"HTTP（超文本传输协议）…", user:<slug 指令>]
03:56:01.390  set_session_name "重构计划" success（LLM request 后 0ms 抢入）    ← W1 后 xyz 手动 rename 路径，落在 2-30s 窗口内
03:56:01.391  round settled (agent_settled)
03:56:03.217  [rename-session] rename with model xiaomi-token-plan-cn/mimo-v2.5-pro
03:56:03.217  [rename-session] turnIndex=0 skip: name exists                    ← 核心：守卫拦截，renamed to 不出现
03:56:13.727  10s 迟到覆盖观察窗结束
```

### 3.2 四条断言结果

| 断言 | 结果 | 证据 |
|---|---|---|
| a. 扩展日志出现 `skip: name exists`（守卫生效——核心） | **PASS** | `[rename-session] t=2026-08-18T19:56:03.217Z turnIndex=0 skip: name exists`（rename LLM 于请求发起 1.83s 后返回时命中守卫） |
| b. `get_state` 返回 sessionName=「重构计划」 | **PASS** | `get_state.data={sessionName:"重构计划", sessionId:01a01671-e802-78eb-9dcb-62c64b00feca}` |
| c. JSONL 有且仅有一条 session_info 且为「重构计划」 | **PASS** | session_info 全量 = `[{"id":"359766d8","timestamp":"2026-08-18T19:56:01.390Z","name":"重构计划"}]`——无任何 LLM 标题条目 |
| d. 会话过程无错误 | **PASS** | turn_end stopReason=`["stop"]`；pi 存活；无 rename 失败日志 |

**这正是 W1 修复本质链路的直接证据**：`set_session_name` RPC → pi 内存 sessionName 更新 → rename LLM 返回标题落库前 `pi.getSessionName()` 非空 → 守卫 skip，用户手动命名不被覆盖。（修复前 xyz 直写 JSONL 不通知 pi，pi 内存 sessionName 为空，守卫必过，LLM 标题覆盖手动名。）

## 4. 对照组（auto-rename 正常工作，防误伤）

另起 tmpdir pi（同配置），prompt「用一句话介绍 DNS 的作用」等 round 完成，**不做** `set_session_name`。

- **PASS** ctrl-1：auto-rename 正常触发——`[rename-session] t=2026-08-18T19:56:22.340Z turnIndex=0 renamed to "dns-域名解析原理"`
- **PASS** ctrl-2：`get_state.data.sessionName="dns-域名解析原理"`，与 JSONL 最后一条（也是唯一一条）session_info.name 一致
- **PASS** ctrl-3：turn_end stopReason=`["stop"]`、pi 存活、无错误日志

守卫逻辑没有破坏正常自动命名。

## 5. 清理验证

- 三个实验的 pi 子进程均按 PID 精确 SIGKILL（harness `proc.kill("SIGKILL")`，无宽泛 pkill）
- 三个 tmpdir（`rename-e2e-p0main.*` / `rename-e2e-p0race1.*` / `rename-e2e-p0ctrl.*`）cleanup 后 `existsSync` 均验证 false；`ls -d .../T/rename-e2e-p0*` 无匹配（zsh no matches found）
- /tmp 实验脚本与结果目录（`/tmp/p0-gate-s1/`）报告完成后删除
- 系统_tmp 下存在历史 e2e 残留目录（tag a1/a2/a4，2026-08-15 验收产物，非本次会话产生），按规则未动

## 6. 结论文本

**PASS**。W1 修复本质链路在真实 pi 子进程（pi-coding-agent 0.84.1 + 本地 rename-session 源码 + 真实 mimo LLM）端到端成立：

1. rename LLM 窗口内手动 `set_session_name` → 守卫 `skip: name exists` 拦截，手动名「重构计划」完整保留（JSONL 仅手动一条，无 LLM 覆盖条目）
2. auto-rename 完成后手动改名 → 后续轮次 `skip: count=2/3`（一次性语义），手动名不被覆盖，`get_state` 与 JSONL 一致
3. 对照组 auto-rename 正常工作，守卫无误伤
