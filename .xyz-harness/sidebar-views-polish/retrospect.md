# Retrospect: sidebar-views-polish

## 执行过程

critique → 用户确认全修 + subagent cancel 调研 → CW create → clarify (ADR 0033) → plan (5 Wave) → tdd_plan (13 case) → dev (W1-W5) → review → test (13/13 passed)

### 关键决策点

1. **subagent cancel 可行性确认**：调研 pi-subagent-workflow 扩展（feat-ask-user-gui 分支），确认 `/subagents cancel <id>` slash command 存在，底层 SIGTERM kill 子进程。runtime 侧完全缺失（三层未接），但改动小（对称 workflowAction 3 处增量）
2. **cancel 交互模式**：选 inline 两段式（复用 SessionItem 删除确认模式），不用 Dialog 弹窗
3. **subagent 无 pause/resume**：架构差异（single-shot 子进程 vs workflow worker_threads），ADR 0033 记录

### 流程问题

1. **认知外 commit 干扰**：开发过程中出现认知外 commit (245e22b0)，混入了部分 W2 实现代码 + 改了 subagent store 的 loadSubagents 行为（失败清空→失败不清空）但没同步改测试，导致 2 个预存测试失败。按 AGENTS.md 规则 #0 未碰这些改动，但需后续清理 git 历史
2. **replan 副作用**：为修正 U11 expected 调了一次 replan --test，导致 status 回退到 planned + waves 重置。replan 后需重走 tdd_plan，虽然实现已存在但红灯校验仍正常通过（renderer 测试还红着）
3. **W3/W4/W5 文件交织**：三个 Wave 改了同一批文件（sidebar.ts、Sidebar.vue），无法按 Wave 干净拆分 commit。合为一个 commit 但 message 标明 Wave。CW dev 接受同一 commitHash 映射多个 Wave

## 全绿质量自检

U1-U12 + E1 全 pass。逐条自检防线：
- U2/U4（两段式确认）：测了状态机（首次不 emit + 确认态出现 + 二次 emit），非纯 happy path
- U7（cancelSubagent 失败回滚）：异常路径，防「RPC 失败后 status 不回滚」bug
- U9（ghost session throw）：边界条件，防「session 不存在时空值崩溃」
- U11（handler 失败抛出）：异常路径，验证错误由 server.ts 外层 catch 处理

盲区：cancel 两段式的 mouseleave 重置（cancellingId=null）未测——交互态超时清理。但这是次要 UX 细节，不阻塞。
