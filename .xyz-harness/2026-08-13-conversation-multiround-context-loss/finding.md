# Conversation 多轮对话丢上下文 — 排查结论

> **排查日期**：2026-08-13
> **涉及代码**：`extensions/subagent-workflow/`（pi-subagent-workflow extension）
> **关联设计**：`extensions/subagent-workflow/docs/design/subagent-continuous-chat-v2.md`

## 结论（先行）

**该 bug 已被 `e7a6c0d3d`（V2 核心范式 commit）修复。当前代码（HEAD `ef27a4c5b`）conversation 多轮对话正常工作。**

排查中三次复现，都是因为 pi 进程加载了 `e7a6c0d3d` **之前**的旧版 extension（M1/M2/M3 阶段，v1 `resumeRound` 范式——每轮 `pi --session` 重开 session）。重启 pi 进程加载新版（含 `e7a6c0d3d` 的 deliverMessage 热路径）后，两次重现均未复现。

**不需要新增修复**。残留风险与收尾建议见末尾。

---

## 现象

`conversation: true` 启动 subagent，第一轮正常；用 `action: "message"` 续话（第二轮），subagent 明确报告「没有上一轮上下文」，把第二轮当全新会话处理。

参数调用符合契约（`conversation: true` 启动 + `action: "message"` 续话，`messageResponse.delivered: true`）。

---

## 排查过程（三层证据链）

### 事实层：session 文件 message tree 断两棵

故障 session `019ff5b1`（旧版 extension 下产生）的 entry 级 id/parentId 链：

**第一棵树（T000，第一轮）**：`ba664be5(model_change, parentId:null)` → … → `fb1f56a4(assistant 总结)` ← 叶

**第二棵树（T001，第二轮 message 续话）**：`c3933c28(model_change, parentId:【字段缺失】)` → … → `eff94494` ← 叶

断裂点：第二轮首条 entry `c3933c28` 的 `parentId` **字段整个不存在**（不是 `null`，是 undefined 序列化省略；第一棵树根是显式 `null`，两者不同）。两棵树无 parentId 连接 → message tree 断成两棵。

pi 加载 session 历史构建 LLM 上下文时，从当前 leaf 回溯 parentId 链，第二轮只能回溯到第二棵树根 `c3933c28`，**永远到不了第一棵树** → subagent 报「无上一轮上下文」。

### 代码层：续话实现依赖 pi `--session` 原生续写

旧版（M1/M2/M3）的 `resumeRound`（`subagent-service.ts`）：每轮用 `pi --session <file>`（`session-runner.ts` spawn args）重开 session，**不手动注入前轮历史**，完全依赖 pi 原生 `--session` 续写恢复 leaf 指针与上下文。

### pi core 层：`--session` 续写 leafId 时序 bug

`session-manager.js` 的 `appendModelChange`（:790-800）：`parentId: this.leafId`。`load()` 加载已有 session 时调 `_buildIndex()`（:636）遍历后 `leafId = 最后一条 entry.id`。

矛盾：load 成功则 leafId 应 = 旧叶，model_change parentId 应指向它。但故障 session 第二轮 model_change parentId 缺失 → 写入时 `leafId === undefined`（`_buildIndex` 还没把旧叶赋给 leafId，或新进程续写时序问题）。这是 pi core `--session` 续写的 leaf 继承时序缺陷——**冷路径（重开 session）必然触发**。

---

## 关键反转：bug 复现 = 进程加载了旧版 extension

排查中一直假设「V2 保活失效，进程自行 close，退回冷路径」。加诊断日志（`ef27a4c5b`，fs.appendFileSync 落盘）重现后，**证据推翻了这个假设**：

| 事件 | 时间（北京时间） | pi 进程加载的 extension |
|---|---|---|
| sa-428a6ac4 测试（丢上下文） | 08-12 09:16 | `e7a6c0d3d` **之前 18 小时** → M1/M2/M3（v1 resumeRound） |
| **`e7a6c0d3d` V2 核心范式 commit** | **08-13 03:24** | deliverMessage 统一投递（热路径不重开 session） |
| sa-79fc9087 重现（丢上下文） | 08-13 ~10:50 | 同一个旧 pi 进程（08-12 起一直跑），仍加载旧版 |
| 用户重启 pi session | 08-13 ~11:10 | 进程重启，加载新版（含 `e7a6c0d3d`） |
| sa-d5df5dfe 重现（**没丢**） | 08-13 11:17 | 新进程 → deliverMessage 热路径 → 保活生效 |
| sa-b6de0ec4 重现（**没丢**） | 08-13 11:21 | 同上（稳定性二次验证） |

**时间线铁证**：sa-428a6ac4 的 session 在 `e7a6c0d3d` commit 之前 18 小时创建，那个 pi 进程加载的是 M1/M2/M3（v1 范式）。sa-79fc9087 复用同一个未重启的 pi 进程，仍加载旧版。重启后加载新版，bug 消失。

---

## `e7a6c0d3d` 如何修复

V2 核心范式引入 `deliverMessage` 统一投递（`subagent-service.ts:717-731`）：

```ts
// 热路径（进程活）：prompt + streamingBehavior（V2 决策 3，pi 权威裁决 busy/idle）
sendPromptCommand(child, text, { streamingBehavior: interrupt ? "steer" : "followUp" });
// 冷路径（进程死）：复用 resumeRound 重开 session（仅崩溃/timeout/跨重启命中）
```

**热路径不重开 session** → 绕开 pi core 的 `--session` 续写 leafId bug。进程跨轮次保活（lifecycle-manager idle timer + agent_settled 信号），第二轮 message 直接投递给活进程，不 spawn 新进程、不重开 session、不触发 pi bug。

commit message 自述：「identity entry written by child process session_start hook via pi.appendEntry (fixes message tree split…)」「deliverMessage unified delivery (prompt+streamingBehavior by process liveness, not status)」，测试「1874 passed, tsc exit 0」。

---

## 稳定性验证（重启后两次重现）

| 重现 | 第一轮任务 | log（进程 close？） | session tree | 第二轮记忆 |
|---|---|---|---|---|
| sa-d5df5dfe | ls | **不存在**（没 close） | 连续（单 model_change，parentId 链不断） | ✅ 记得「上一轮 ls 了顶层」 |
| sa-b6de0ec4 | 读 AGENTS.md 总结 | **不存在**（没 close） | 连续（单 model_change，parentId 链不断） | ✅ 引用第一轮总结的具体规则内容 |

两次都：进程没 close（V2 保活生效）、tree 连续（没重开 session）、第二轮记得第一轮。**bug 稳定未复现**。

---

## 诊断误判复盘

排查中途派出的诊断 subagent 给出结论「第一轮子进程自行 close → V2 保活闭环（押 agent_settled）失效 → 退回冷路径」。这个结论**基于 sa-428a6ac4 的 session（旧版 M1/M2/M3）**，把 M1/M2/M3 的「每轮 kill + idle」**设计行为**（v1 范式）误判为「V2 保活失效的 bug」。

**误判根因**：诊断时没有先确认「故障 session 产生时 pi 进程加载的 extension 版本」。sa-428a6ac4 产生于 `e7a6c0d3d` 之前 18 小时，加载的是 v1 范式旧版。诊断 subagent 读的是当前最新代码（含 V2），用 V2 的视角解释旧版行为，得出「V2 保活失效」的错误结论。

**教训**（规则 13 的延伸）：排查 bug 前，**必须先确认故障产生时环境加载的代码版本**（进程启动时间 vs 关键 commit 时间）。仅看当前代码 + 故障产物，会用新视角误判旧行为。本次排查在这个误判上花了大量轮次（诊断进程 close 的物理触发），实际上那是旧版的正常设计。

---

## 残留风险与收尾建议

### 1. pi core `--session` 续写 leafId bug 仍存在（根治待办）
`e7a6c0d3d` 是**绕过**（热路径不重开 session），不是**修复** pi core。冷路径 `resumeRound`（进程崩溃 / idle timeout / 跨重启命中）仍会 `pi --session` 重开，仍会触发 leafId 时序 bug → tree 断 → 丢上下文。
- **建议**：向上游 [pi-mono](https://github.com/badlogic/pi-mono) 报 issue。位置：`SessionManager` 的 `--session` 续写加载逻辑（`_buildIndex` 与首条 meta entry appendEntry 的时序）。附本排查的 session 文件铁证（两棵树断裂点）。

### 2. xyz-agent mandatory npm 版是旧版（用户环境风险）
`~/.pi/agent/npm/node_modules/@zhushanwen/pi-subagent-workflow/`（xyz-agent mandatory 安装源）version 标 `7.3.1` 但**内容是 `e7a6c0d3d` 之前的旧码**——`subagent-actions.ts` action 仅 `start|list|cancel`（无 message/close）、`notifier.ts` 无 idle 状态、无 `--session` resume / deliverMessage。
- **影响**：xyz-agent 桌面环境（mandatory 装 npm 版）跑 conversation 模式会丢上下文 / notify 失效。这很可能是用户最初观察到的「conversation 模式 pending-notification 失效」的根因。
- **建议**：发 npm 新版（含 `e7a6c0d3d` + `0cfb8cb0a`），更新 xyz-agent mandatory 列表指向新版本。

### 3. V2 Step 5 控制流改造 pending
`0cfb8cb0a`（V2 Step 5）commit message 自述「Step 5 (delete V1 complications: .idle sidecar / ack-based delivery / notifier round exemption) is pending — involves control-flow rework… will be planned separately」。`.idle` sidecar 已删，但 notifier 轮次豁免移除、chatMode close 终态处理、idle 状态机移除等控制流改造未完成。
- **建议**：按 `extensions/subagent-workflow/docs/design/v2-impl-gap.md` 的「组 1 + 组 3」收尾。

### 4. 临时诊断日志待清理
本次排查加了两个临时诊断 commit，**应在合并前清理**：
- `4afc00c3d`：`session-runner.ts` 的 `[close-diag]` logger.warn（stdin/exit/close 监听）
- `ef27a4c5b`：上述 logger.warn 改为 `fs.appendFileSync("/tmp/conversation-close-diag.log")`

这两个 commit 仅排查用，不影响逻辑，但留在历史里会误导。建议 `git revert` 或在收尾 commit 中删除这些诊断代码。

### 5. git 工作区遗留
- `.xyz-harness/2026-08-12-scheduler-session-scope/design.md`（scheduler v1→v3 演进，认知外改动，非本次排查产物）—— 来源待用户确认后处理。
- `origin/main`（bare repo）滞后于 `github/main` 4 个 commit（subagent-workflow worktree guidance 修复 + version bump），与本次根因无关，合并时机待定。

---

## 证据索引

| 证据 | 位置 |
|---|---|
| 故障 session（旧版，tree 断两棵） | `~/.pi/agent/subagents/.../sessions/2026-08-12T11-17-52-763Z_019ff5b1-*.jsonl` |
| 稳定性验证 session（新版，tree 连续） | `~/.pi/agent/subagents/.../sessions/2026-08-13T03-17-10-575Z_019ff91f-*.jsonl`、`2026-08-13T03-21-41-055Z_019ff923-*.jsonl` |
| V2 核心范式 commit（修复） | `e7a6c0d3d`（2026-08-13 03:24） |
| V2 Step 5 commit | `0cfb8cb0a`（2026-08-13 10:15） |
| 临时诊断 commit（待清理） | `4afc00c3d`、`ef27a4c5b` |
| pi core appendModelChange | `~/.nvm/.../pi-coding-agent/dist/core/session-manager.js:790-800` |
| deliverMessage 热路径 | `extensions/subagent-workflow/src/execution/subagent-service.ts:717-731` |
| V2 设计文档 | `extensions/subagent-workflow/docs/design/subagent-continuous-chat-v2.md` |
| V2 实施 gap 分析 | `extensions/subagent-workflow/docs/design/v2-impl-gap.md` |
