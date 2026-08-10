# 设计文档：pi-goal / pi-todo 全面优化（plan.md）

> 状态：**待用户确认**（2026-08-09）。调研完成（四份深度报告：本地 goal/todo 审计 + Claude Code v2.1.88 + Codex CLI），方案未获确认前不实施。
> 基线分支：feat-optimize-todo-goal。

## 0. 基线状态与待定项

| 项 | 状态 |
|---|---|
| 优化基线分支 | feat-optimize-todo-goal（已确认） |
| budget policy | **已撤销**（bcbe054a6 已删，分支回到 025c5ca6d 与 origin/main 同步）。budget policy 将在 goal 改造中以中文版重做进 description |
| 已确认决策 | 删 cancelled 状态、删 clear action、去时间预算（§2.6）、description/guidelines 统一中文、schema 做强约束（discriminated union by action） |
| 待确认 | 架构项 H1-H4 + M1/M2/M3/M5（§2.7，审查报告已交付，建议采纳） |

## 1. pi-todo 优化（6 处改动）

### 1.1 三态化：删 cancelled 【必修 bug + 简化】

| 项 | 内容 |
|---|---|
| 文件 | `src/model.ts`（VALID_STATUSES、TodoStatus）、`src/tool.ts`（schema status 枚举 4→3）、`src/handlers.ts` |
| 改动 | 状态枚举 `pending/in_progress/completed/cancelled` → `pending/in_progress/completed`；`migrateTodo` 中历史 `cancelled` 项映射为 `completed`（不丢数据，且自动解除 auto-clear/steer 死锁） |
| 理由 | cancelled 使 `every(t=>completed)` 恒 false → auto-clear/completion steer 永不触发，且 isPending 排除它 → 对模型隐形，列表冻结。Claude/Codex 均为纯三态 |
| 测试 | `todo.test.ts` cancelled 用例删改（L161-177 附近） |

### 1.2 删 clear action 【去冗余】

| 项 | 内容 |
|---|---|
| 文件 | `src/tool.ts`（action 枚举、handler 分支、description）、`src/handlers.ts`（handleClear）、`src/component.ts`/`render.ts`（若有 clear 渲染）、`src/model.ts`（若有专用清理函数） |
| 改动 | 删除 clear；description 的 clear 条目删除 |
| 理由 | auto-clear 已覆盖「全部完成自动清理」；guideline[3] 自己宣称「无需手动 clear」；与 delete 全量删除重复 |
| 测试 | `tool-prompt.test.ts`、`todo.test.ts` 的 clear 用例删除 |

### 1.3 突变结果附带完整列表 【修失明】

| 项 | 内容 |
|---|---|
| 文件 | `src/tool.ts`（content 组装）、`src/model.ts`（新增 `formatTodoList()`，复用 formatTodoLine 序列化） |
| 改动 | add/update/delete 成功后 content = 原汇总行 + 换行 + 完整列表（每行 `#N [status] text`）；list 同样返回列表 |
| 理由 | 现 details.todos 模型不可见 → 突变后失明 → 被迫补调 list。附带列表后 list 降级兜底，调用次数净减（N 项 × 8-15 tok，不增反减） |

### 1.4 合并 context/reminder 单通道 【token 精简】

| 项 | 内容 |
|---|---|
| 文件 | `src/handlers.ts` |
| 改动 | 删 `buildMinimalReminder`（搁置提醒通道）；保留 before_agent_start 每轮 context 注入（已含「推进 pending + 完成后立即标记 completed」规则）；删 stall 相关状态计数（若仅服务于 reminder） |
| 理由 | 稳态下 reminder 与每轮 context 等价（审计 §5：交替注入同一信息），机制冗余 |

### 1.5 description 重写 【token + 准确性】

**已确认中文版**（`src/tool.ts`，同步改 `tool-prompt.test.ts` 断言）：

```
管理当前会话的 todo 列表。

动作：
- list: 查看全部 todo
- add: 批量添加 todo（texts 数组）
- update: 按 id 更新 todo——status 和/或 text；批量用 updates[]
- delete: 按 id 删除 todo（ids 数组）

规则：
- 同一时间只有一个 todo 处于 in_progress
- 完成一个 todo 立即标记 completed，不要攒到最后批量标记
- 未真正完成不得标记 completed：被阻塞或测试失败时保持 in_progress
```

删除原 Examples 段（3 个 JSON 正例）与 Don't 段（3 个反例）——错误消息已带 Correct 纠错正例，双形陷阱学习路径保留。

### 1.6b schema 强约束（discriminated union by action）【用户确认】

`TodoParams` 由单一 object 改为 `Type.Union`（discriminator: action）：每个 action 分支只声明自己的参数（add→texts；update→id/status/text/updates；delete→ids；list→空），必填关系由 schema 表达，去掉全部 "(for update action)" 类限定词。模型漏传从「运行时 throw + round trip」变为「schema 层拒绝」。

### 1.6 schema 与校验修正 【准确性】

| 项 | 改动 |
|---|---|
| `updates[].status` | `Type.String` → `StringEnum(VALID_STATUSES)`（类型层防错，省 61-char 描述） |
| text 校验统一 | 单条/批量统一：trim + 空串拒绝（现单条 throw、批量静默丢弃、add 会 trim，三种行为） |
| add 双形 | 同时传 `text`+`texts` → throw 提示（现静默忽略 text） |
| 收尾双通道 | tool 侧 "All todos completed. Please summarize your work." 删除，保留 agent_end completion steer（含「逐项核对交付质量」），两处不再重复 |

### 1.7 promptGuidelines 调整

- `[验证任务]` 与 promptSnippet 去重（保留 guidelines 一条，snippet 改为更短或删）
- 行为准则（单 in_progress 等）**不进 guidelines**——已在 description（工具自洽），guidelines 只留触发时机（3+ 步使用、批量优先、自动闭合、Not for）
- **待定**：guidelines 全中文（token 密度 ~2 倍英文）保留 or 精简措辞。默认保留中文（面向中文用户可读性）

## 2. pi-goal 优化（5 处改动）

### 2.1 双 prompt 合并 【token 最大项，~838→~650 tok/轮】

| 项 | 内容 |
|---|---|
| 文件 | `src/projection/prompts.ts`、`src/adapters/event-handlers/before-agent-start.ts`、`agent-end.ts` |
| 改动 | 职责分工：`contextInjectionPrompt`（before_agent_start，每轮）精简为「objective + successCriteria + Status/Turn/预算% + 3 条铁律」≤600 chars（现 1667）；`continuationPrompt`（agent_end，续跑）保留审计细节（Completion audit/Fidelity/Blocked） |
| 去重 | 「intent 不是 evidence」「预算耗尽≠完成」等规则两段只保留一处（continuation）；context 段删除 plan 提示与 todo 引导（改为一行引用） |
| 理由 | 现每轮双 `<goal_context>` 叠加，同一批规则两种措辞各付一次费（审计 C1） |

### 2.2 描述准确性修正（6 处）

| # | 位置 | 改动 |
|---|---|---|
| A1 | schema `reason` desc | "at least 3 approaches" → "describe the blocking condition and what you tried"（删零强制声明；guidelines[3] 保留 ≥3 作软指引） |
| A4 | description create 行 | "use /goal resume or /goal clear first" → "tell the user to run /goal resume or /goal clear first"（模型不可执行 slash 命令，消除不可达指令） |
| A5 | command-adapter handleSet | **不改**（判断：用户显式输 /goal 即用户指定，与 description 的 skip trivial 不矛盾；文档标注此决策） |
| A6 | index.ts /goal 命令 description | 补 `\| /goal pause`（现漏列） |
| A7 | description complete 行 | "meets EVERY successCriteria condition" → "meets every successCriteria condition"（去全大写强制感，防过度自证） |
| slug | schema + handleCreate | 降级 optional：desc 改 "Optional. Short kebab-case identifier for the status bar title."；不再 throw（engine 注释明说 slug 不注入 prompt） |

### 2.3 删 completedTasks + 死代码清理（8 处）

| 项 | 位置 |
|---|---|
| completedTasks | schema + handleComplete 参数 + history 写入（persistence `totalTasks` 恒 0，服务已删除的 task 系统） |
| formatBudget 两样式 | `prompts.ts` remaining/report 分支（零调用方） |
| isExternalInit | `service.ts` 参数 + `__goalInit` 调用 |
| acquireProcessing/releaseProcessing | `adapters/event-handlers/shared.ts`（无人调用，与手工锁并存） |
| agent_start 链路 | `index.ts` 注册 + `agent-start.ts` + `service.ts` 空分支 |
| MessageEndLikeEvent 双份 | 删 `index.ts` 副本，统一 `message-end.ts` |
| GoalHistoryData/GoalHistoryEntry | 合并为一（`command-adapter.ts` vs `ports.ts`） |
| BUDGET_RATIO_TIGHT | `constants.ts`（无使用点） |
| planAvailable 参数 | `contextInjectionPrompt` 签名 + 调用点（恒 true，分支死） |

### 2.4 工具定义压缩 1265→~500 tok/轮 【token】

| 项 | 改动 |
|---|---|
| 语言 | **description + 参数描述统一中文**（用户确认）——同义文本短 ~45% |
| budget 政策 | 重做为中文版进 description 段（原撤销的英文 commit 内容以中文重做）；删 promptGuidelines[1] |
| ≥3 approaches 三处 | 保留 guidelines[3]；删 schema "at least 3 approaches"（见 2.2 A1）；description "Only after genuine exhaustion" 保留 |
| Examples/Don't | description 删 Examples 与 Don't 段（guidelines 已含触发规则） |
| 「预算耗尽≠完成」「intent≠evidence」各 3 处 | 随 2.1 去重收敛到 continuation 一处 |
| schema 强约束 | goal_control 参数按 action 拆 discriminated union（create→slug/objective/successCriteria/tokenBudget；complete→evidence；report_blocked→reason） |

## 2.7 架构优化（架构审查 subagent 结论，用户已确认采纳）【新增】

| 级别 | 项 | 内容 | 改动量/风险 |
|---|---|---|---|
| H1 | todo reconstructState GC 修正 | 删 staleIndices splice 段（pi getEntries 返回 filter-copy，splice 无效）；同步修正 steer.test.ts 断言（stub 改 slice 语义，断言 entries 不被修改） | ~20 行 + 1 测试 / 低 |
| H2 | goal-state entries 无界增长 | agent_end 合并 persist（handleBudgetChecks + handleContinuation 共用一次 persistAndUpdate，预算终态检查点顺序不变）；ports.appendState 注释声明实际 | ~15 行 / 中 |
| H3 | EventEffect 僵尸类型收缩 | 5 kind 仅 updateWidget 被产生 → 收缩为单一类型或删除 effect 模式；applyEvent 改名/降级为 turn_end+message_end 专用 | ~30 行 / 低 |
| H4 | goal-control-adapter 拆层 | buildGoalGui + goalStatusSeverity 移入 projection/gui.ts；severity 映射与 widget.ts getBudgetColor 合并单源 | 新文件 ~100 行 / 中 |
| M1 | 双份类型合并 | MessageEndLikeEvent 唯一定义（index import）；handleHistory 复用 GoalHistoryEntry（补 successCriteria） | ~15 行 / 低 |
| M2 | 常量双源合并 | engine/budget.ts 内部常量改 import constants.ts | ~5 行 / 低 |
| M3 | agent-end 单次构造 ports | 6 次 buildPorts → 入口一次传参 | ~20 行 / 低 |
| M5 | 清理 3 处死参数 | isExternalInit / _ports / checkContextUsage 参数 | ~15 行 / 低 |

### 2.5 补 Codex 终态语义（4 条进 description/promptGuidelines）

| 语义 | 落点 |
|---|---|
| blocked 连续重复阈值 | guidelines[3] 改写："genuinely blocked after ≥3 distinct approaches **or the same blocker persisting across consecutive turns**"（补时间维度，与现方法维度互补） |
| 不得反复报告阻塞 | guidelines 补："Once the blocked threshold is met, report it — do not keep the goal active while repeatedly reporting the same blocker" |
| complete 报告 token 用量 | description complete 行补："If the goal had a budget, report the final token usage in your summary" |
| pause/resume/budget 归用户 | description 补："Pause/resume and budget changes are user-controlled via /goal — you cannot change them" |

### 2.6 去除时间预算 【用户指令 2026-08-09】

**决策**：删除 timeBudgetMinutes 维度（对齐 Codex——codex 只有 token_budget，time 仅记账不设限）。

| 项 | 内容 |
|---|---|
| 删参数 | schema `timeBudgetMinutes`（goal-control-adapter.ts:79-82）；`/goal set --timeout N`（command-adapter） |
| 删状态 | `time_limited`（engine/types.ts 枚举 + VALID_TRANSITIONS + TERMINAL_GOAL_STATUSES） |
| 删逻辑 | engine/budget.ts 时间预算检查分支；agent-end/service.ts 的 time 终态检查点 |
| **保留** | `timeUsedSeconds` 记账与耗时显示（widget/GUI/prompts 显示 "Time: Xm"，无预算概念）；对齐 Codex 的 time 只记账不设限 |
| 删渲染 | buildGoalGui/widget 的时间 progress-bar（无预算即无进度条） |
| 测试 | budget.test.ts / gui.test.ts / goal-control-adapter.test.ts 的 time 用例删除 |

## 3. 测试影响

- **todo**：`tool-prompt.test.ts`（description 断言整体重写）、`todo.test.ts`（cancelled/clear 用例删改）、`tool-detectors.test.ts`（报错文案若改则同步）、handlers/event 测试（reminder 通道删除）
- **goal**：`goal-control-adapter.test.ts`、`goal-control-rpc.test.ts`（completedTasks/slug 用例）、`prompts.test.ts`（模板文本）、`command-adapter.test.ts`、`gui.test.ts`、`event-adapter.test.ts`、`service.test.ts`、`index.test.ts`
- 每条改动后跑对应测试文件；全量 `extensions:typecheck` + 两包 vitest

## 4. 版本影响

- todo 0.6.0：删 action（clear）+ 删状态（cancelled）= **breaking** → changeset（0.x 语义，升 minor 或 major，merge 时定）
- goal 0.7.0：删 tool 参数（completedTasks）+ 行为文本变化 = **breaking**（LLM 若仍传 completedTasks 会被拒或忽略，取决于 strict 设置）→ changeset

## 5. 实施顺序（确认后）

1. pi-todo 全部改动 + 测试 + commit
2. pi-goal 全部改动 + 测试 + commit
3. 全量 typecheck + lint + 描述/行为逐条核对表
4. changeset 文件 + 汇总

## 6. 待确认清单

- [x] cherry-pick 恢复选项：**已撤销**（bcbe054a6 已删，分支与 origin/main 同步）
- [x] 删 cancelled 状态
- [x] 删 clear action
- [x] 去除时间预算（§2.6）
- [x] description/guidelines 统一中文
- [x] schema 做强约束（discriminated union by action）
- [ ] 架构项 H1-H4 + M1/M2/M3/M5（§2.7）——**待确认**
- [ ] **最终整体确认**：按上述确认项实施（todo 先、goal 后，各 commit + 测试全绿）
