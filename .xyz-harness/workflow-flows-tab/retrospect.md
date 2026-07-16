# Retrospect — cw-2026-07-13-workflow-flows-tab

## 做了什么

实现 Flows tab 的完整功能链：workflow 列表 + phase/agent call 详情 + agent call 对话流 Panel 切换 + 实时推送 + pause/resume/abort 操作按钮。

4 个 Wave：
- W1：runtime 数据链（workflow-extractor + SessionService.getWorkflows/getAgentCallHistory + RPC）
- W2：前端只读视图（workflow store + WorkflowList/WorkflowDetail 组件 + Panel agent call overlay）
- W3：实时推送（event-interpreter 捕获 workflow-result + workflow toolCall → 广播 session.workflowUpdate）
- W4：操作按钮（SessionService.workflowAction + WorkflowList/WorkflowDetail Pause/Resume/Abort 按钮）

## 做得好的

1. **风险前置排除**：开发前用真实 workflow-state 文件验证 RunSnapshot 格式（10 个 trace key 一致）、agent call JSONL 定位（文件名 sessionId glob 可行）、worktree 清理不影响 JSONL。三个风险全部排除后才进开发，零返工。

2. **扩展侧已就绪的发现**：调研发现 pi-subagent-workflow feat-ask-user-gui 分支已实现全部 RPC 适配（/workflows pause/resume/abort + workflow-result 推送），W4 从「跨仓库开发」降为「调 client.prompt」，节省大量协调成本。

3. **与 subagent 同构**：workflow store / useWorkflowListSync / extractor / event-interpreter 推送 全部镜像 subagent 模式，reviewer 一致性检查零偏差。新人读 subagent 就能理解 workflow。

4. **类型分离**：session.workflowUpdate（增量推送）与 session.workflows（RPC reply 全量）用不同 ServerMessageType，避免 payload 结构冲突。这是设计时发现的，不是事后补的。

5. **TDD 执行**：每个 Wave 先写测试（红）再写实现（绿）。workflow-extractor 4 测试、event-interpreter push 5 测试、store 9 测试、WorkflowList 6 测试，全部先红后绿。

## 做得不好的

1. **CW test expected.text 精确匹配踩坑**：U1/U3/E1 首次提交时 actual.text 与 plan expected.text 引号格式不一致（无引号 vs 单引号），导致 3 个 case 首次 fail。CW 做精确字符串比较，expected 里写的引号格式必须原样复制。应在提交前用 plan 原文逐字符核对。

2. **W4 lint warning 一轮**：onWorkflowAction 初版用 console.error（触发 taste/no-silent-catch），commit 被 pre-commit hook拦。改为 toastError 后通过。应在写 catch 时直接想到「用户可见错误用 toast」，不是等 lint 提醒。

3. **cwd 不持久踩坑 2 次**：cw review 和 npx vitest 都因 bash cwd 回到 worktree 根而非 packages/runtime 失败。AGENTS.md 规则 #8 说的就是这个——每条命令都要带 cd，「刚才 cd 过了」不成立。

## 可复用的经验

1. **扩展对接前先查扩展源码**：本次最大的效率提升来自「先读 pi-subagent-workflow 源码确认 RPC 分支已实现」。如果直接按 extension-adaptation.md（旧文档说需开发）写跨仓库 task，会浪费一个 agent 的时间。对接文档可能是过时的，源码不会。

2. **RunSnapshot 格式用真实文件验证**：不从扩展的类型定义正向推导字段，而是 `cat state.jsonl | python3 -m json.tool` 看真实数据。这样发现的字段（如 result.sessionId 与顶层 sessionId 一致、旧文件无版本号）比读类型定义更可靠。

3. **增量推送 + RPC 拉取 > 全量推送**：W3 的 session.workflowUpdate 只推 {runId, status, reason} 增量信号，前端收到后调 loadWorkflows RPC。比在 event-interpreter 读 state 文件推全量简单得多（零 IO 逻辑），且复用现有 loadWorkflows 链路。

## 改进建议

1. **WorkflowDetail 组件测试**：phase 分组逻辑（aggregatePhaseStatus）+ agent call 点击 emit 应补单测。本次只测了 WorkflowList。
2. **scanPiSessions 性能**：agent call JSONL 定位可用文件名 glob 替代全扫，这是 subagent + workflow 共有的优化机会。
3. **CW expected.text 模板**：plan 写 expected 时避免用引号包裹值（如写 wf-test-001 而非 'wf-test-001'），减少 test 阶段的精确匹配摩擦。
