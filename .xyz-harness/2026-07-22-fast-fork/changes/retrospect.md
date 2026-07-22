# Retrospect · fast-fork

> 复盘日期：2026-07-22
> Topic：cw-2026-07-22-fast-fork（批 1：基础薄层 + 痛点1 fork 主线）

## 1. 做了什么

实现 fast-fork 功能批 1（4 wave / 20 FR / 22 AC / ~2500 行）：
- **W1 基础层**：SessionSummary 4 字段 + active/磁盘两路径血缘透传 + JSONL forkEntryId 写入 + handedOffTo append + parentSession fallback（FR-20 源 sessionFile 未落盘时用 sessionId）
- **W2 入口+行为层**：门控放开（streaming/pending 可 fork）+ 双按钮（fork 后台/fork 提问）+ forkSessionAsk 原子操作（失败回滚）+ 删 ForkConfirmModal + ForkNotice 反馈行 + protocol session.forkNotice 广播
- **W3 composer fork 模式**：useComposerForkMode 状态机（enter/exit/三重视觉/Esc/切 session 自动退出/发送后退出）+ useForkModeChannel 跨组件通道 + ⌘G/⌘⇧G 快捷键 + composer focus 禁用全局快捷键
- **W4 分支管理**：ForkGroup 分支小列表（fresh 高亮/两步停止确认）+ SessionList 接入 + SessionItem 血缘元信息 + useForkBranchNotify 后台通知

review 阶段发现并修复 5 个集成接线缺陷（RV1-RV5）：ForkNotice 渲染订阅、useForkBranchNotify 实例化、Sidebar stopBranch 绑定、Turn onForkAsk 接 composer 通道、branchesOf key 竞态。

## 2. 做得好的

- **设计文档六轮迭代是最大的效率杠杆**。spec.md + handoff + plan.md 精确到文件:行号 + 代码片段，explorer 验证 14 类锚点全部对齐。clarify/spec_review/plan_review 阶段几乎零返工——设计已穷尽决策，CW 流程只验证对齐性。
- **W1 基础层质量最高**。FR-20 parentSession fallback 逻辑（多级 fork 透传 header.parentSession ?? fallbackParentId ?? sourceFilePath）设计严谨，active/磁盘两路径字段对齐（ScannedSessionMeta 两处定义一致含 outcome），无需返工。
- **TDD 红灯→绿灯流程有效**。3 个 worker 并行写红灯测试，实现时按测试断言精确对齐 testid/class/函数名，减少了 guesswork。

## 3. 做得不好的（processIssues）

### PI1：跨 wave 集成接线系统性缺失（最严重）
**现象**：review 发现 5 个集成缺陷（RV1-RV5），全部是"各 wave 内部组件/composable 写好了，但跨 wave 挂接没做"。ForkNotice 组件建了但没人 import 渲染；useForkBranchNotify composable 写了但没人实例化；Turn onForkAsk 留了 TODO 占位没接 W3 通道。

**根因**：各 wave 派给独立 worker 并行实现，worker 只关注自己 wave 的 changes 列表（dev-plan 的 file-level description），没有"跨 wave 衔接"的显式任务。dev-plan 的 changes 是文件级粒度，不包含"组件 A 订阅事件 B"这类跨文件接线。

**教训**：对于多 wave 并行实现的大型功能，dev-plan 需要一个**集成 wave**（或 changes 里显式列出接线任务），专门处理跨 wave 挂接。或在 review 前主 agent 做一次"接线检查"（grep 确认每个新建组件/composable 都有消费方）。

### PI2：测试因 mock 了订阅层而漏掉集成 bug
**现象**：21 个 testCase 全绿，但 5 个集成缺陷全部漏检。根因：测试 mock 了 useSidebar/useChat/events 等依赖，每个组件/composable 在隔离环境下行为正确，但"组件 A 是否真的被组件 B import 并渲染"这类集成问题，单元测试无法覆盖。

**根因**：TDD 测试设计聚焦"组件/composable 单元行为"（构建者视角），缺少"集成接线验证"（使用者视角）。测试没有断言"ForkNotice 出现在 MessageStream 的 DOM 里""点 fork 提问按钮后 composer 进 fork 模式"等端到端旅程。

**教训**：TDD 红灯测试应至少包含 1 条"集成冒烟"（mount 顶层组件，断言跨组件接线生效），而非全部是隔离单元测试。review 阶段的"禁读重建"发现了 spec 层的遗漏，但"接线检查"需要额外的集成测试或人工 grep 确认。

### PI3：并行 worker 工作区交叉
**现象**：W3 和 W4 worker 并行运行在同一 worktree，工作区文件混合。commit W4 时需精确 `git add` 只选 W4 文件（不能 `git add -A`），否则会把 W3 未完成的改动一起提交。

**根因**：多 worker 共享同一 worktree，git working tree 不隔离。

**教训**：并行 worker 适合"文件不重叠"的 wave，但主 agent commit 时必须精确选择文件（按 wave 的 changes 列表）。或考虑给每个 worker 用独立 worktree（git worktree）彻底隔离。

## 4. 全绿质量自检

test 全 pass 后自检（按 CW guidance 要求）：

- **异常路径覆盖**：U9（forkSessionAsk send 失败回滚）、U11（ForkConfirmModal 删除验证）、U22（反馈行删除降级）覆盖了错误路径。但 streaming 中 fork 的 JSONL 读取竞态（spec §10.5）没有专门 testCase——这是设计标注的"实现时缓解"项，parseJsonl 跳坏行兜底可接受。
- **盲区**：RV1-RV5 修复后补了集成接线，但没有补对应的集成测试。review 发现的 5 个缺陷如果复发，现有 testCase 无法捕获。**这是已知测试盲区**，留待后续补集成测试或 E2E。
- **故意改坏测试**：如果删掉 useForkNoticeEffect 的 session.forkNotice 订阅，U10（ForkNotice 渲染）会变红——这条有防线。但如果删掉 useForkBranchNotify 实例化，没有 testCase 会变红——这条是覆盖率填充盲区。

## 5. 未验证风险（knownRisks）

| 风险 | 状态 | 说明 |
|------|------|------|
| streaming 中 fork JSONL 竞态 | 未缓解（可接受） | parseJsonl 跳坏行兜底，⌘G 末条 streaming 可能静默丢失末尾 entry。设计 §10.5 标注"实现时二选一"缓解方案，未实现。 |
| handoff action-oriented 注入效果 | 不在本 topic | 批 2 范围 |
| merge structured-output 未装 | 不在本 topic | 批 3 范围 |
| 多级 fork 递归展示 | outOfScope 明确 | v1 只展示直接子一层 |
| fresh 高亮 3.2s 定时 vs 点过才消 | Open Question | demo 值 3.2s，实现时观察用户行为再定 |

## 6. 后续建议

1. **补集成测试**：为 RV1-RV5 的接线补"集成冒烟"testCase（mount MessageStream 断言 ForkNotice DOM、点 fork 提问按钮断言 composer forkMode）。
2. **集成 wave 模式**：后续批 2/3 的 dev-plan 考虑加"集成 wave"或 changes 里显式列接线任务。
3. **streaming fork 缓解**：批 1 后续迭代实现 §10.5 的缓解方案（回退上一条完整 assistant / 反馈行明示）。
