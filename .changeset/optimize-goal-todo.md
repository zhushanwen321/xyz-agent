---
"@zhushanwen/pi-todo": minor
"@zhushanwen/pi-goal": minor
---

# pi-todo + pi-goal 全面优化

> type 初判 minor（0.x 语义下 breaking 升 minor/major，merge 时人工定最终版本——参见 AGENTS npm 发布 main 线人工版本判定）。两个包均为 breaking。

## @zhushanwen/pi-todo（breaking）

- **状态三态化**：删除 `cancelled` 状态（pending/in_progress/completed 三态）；`migrateTodo` 将历史 `cancelled` 映射为 `completed`（解除 auto-clear/completion steer 死锁）
- **删除 clear action**：auto-clear 已覆盖「全部完成自动清理」，clear 与 delete 重复
- **schema discriminated union**：`TodoParams` 改为按 action 区分的 union（list/add/update/delete），各分支 `additionalProperties:false`，缺失必填在 schema 层拒绝
- **突变结果附带完整列表**：add/update/delete 成功后 content 附带 `formatTodoList` 完整列表（消除突变后失明）
- **text 校验统一**：单条/批量/add 三处一致 trim + 空串 throw
- **reminder 单通道合并**：删除 stall/reminder 通道，保留 before_agent_start 每轮 context 注入
- **description 中文重写** + 删除 Examples/Don't 段
- **H1 reconstructState GC 修正**：删除无效 splice 段，变纯读

## @zhushanwen/pi-goal（breaking）

- **去时间预算**：删除 `time_limited` 状态 + `timeBudgetMinutes` 参数 + `/goal set --timeout` + 时间预算检查 + 时间进度条；保留 `timeUsedSeconds` 记账显示（对齐 Codex：time 仅记账不设限）
- **旧数据迁移**：升级时若历史持久化 entry 含已删除的 `time_limited` 状态（npm 0.7.x 时间预算格式），deserialize 自动归一化为 `budget_limited`（预算耗尽终态），避免僵尸 goal 功能死锁（`/goal clear` 抛 invalid transition / `goal_control create` 误报 already active / resume 拒绝）；遗留 `timeWarning70Sent`/`timeWarning90Sent` 字段被忽略。旧 goal-history entry 的 `time_limited` 仅影响历史列表图标展示，不参与状态机
- **schema discriminated union**：`goal_control` 按 create/complete/report_blocked 分支，各分支 `additionalProperties:false`
- **prompt 双通道合并**：`contextInjectionPrompt` 精简到 ≤600 chars（每轮锚定），`continuationPrompt` 保留审计细节（续跑详尽），去重收敛
- **description 中文重写** + §2.5 终态语义（complete 报 token / pause-resume 归用户 / blocked 时间维度 + 不反复报告）
- **删除 completedTasks 参数**（运行时消费方为 0）
- **死代码清理**：agent_start 死链路、acquireProcessing、isExternalInit、formatBudget 死函数、BUDGET_RATIO_TIGHT、GoalHistoryData/MessageEndLikeEvent 双份合并、buildPorts 6→1
- **架构修正**：H2 persist 合并、H3 EventEffect 删除（applyEvent void）、H4 gui 拆层（projection/gui.ts）+ getBudgetSeverity 阈值单源化
- **描述准确性修正**：A1 reason desc / A4 create 行 / A6 /goal pause / A7 every 小写 / slug 降级真 optional

## 测试

- pi-todo: 108 tests passed
- pi-goal: 316 tests passed（5 wave 累计，全量绿）
- tsc + extensions:typecheck/lint 全 clean
