# Plan Review · new-task-worktree

**审查方法**：基于 spec FR 清单逐条对照 plan 的 wave changes，确认覆盖度 + 架构合理性。

## 审查结论

plan 拆分合理（W1 后端垂直切片可独立 RPC 验证 / W2 前端接上 W1 / W3 集成测试 + 边界）。8 个 FR 全部有对应 wave changes 落地，spec_review 修复（SR1-SR5）也覆盖。架构遵循三层约束（port → infra → service）+ handler 独立文件。

## FR 覆盖度对照

| FR | Wave | 落点 | 状态 |
|----|------|------|------|
| FR-1 DirSelectPopover 条件显示动作项 | W2 | DirSelectPopover.vue + Landing.vue | 覆盖 |
| FR-2 form 态（分支名+base+校验+预览+SR1/SR4 修复） | W2 | CreateWorktreeModal.vue | 覆盖 |
| FR-3 progress 态（3步+loading bar+不可关闭+SR3 超时） | W1+W2 | worktree-service.ts(timeout) + CreateWorktreeModal.vue | 覆盖 |
| FR-4 success 态（2s自动关+selectWorkspace） | W2 | CreateWorktreeModal.vue | 覆盖 |
| FR-5 error 态（退出码+stderr+重试+SR2 exists 态） | W2 | CreateWorktreeModal.vue | 覆盖 |
| FR-6 setup 脚本契约 A（不存在跳过） | W1 | worktree-service.ts | 覆盖 |
| FR-7 runtime WorktreeService + RPC | W1 | protocol.ts + ports + infra + service + handler + server + index | 覆盖 |
| FR-8 submitFirstMessage 零改动 | 隐含 | 无 changes（设计目标，W3 验证 diff 为空） | 覆盖 |

## 架构合理性

- 三层架构：ports（IWorktreeService/IShellRunner）→ infra（ShellRunner/WorkspaceDetector）→ service（WorktreeService 编排）。符合 AGENTS.md 架构约定。
- handler 独立文件：worktree-message-handler.ts，仿 git-message-handler.ts 结构，不塞进 session-message-handler。
- DI 链清晰：index.ts composition root 构造 → server.setServices → route map。
- 复用 IGitExecutor（仅扩白名单加 worktree），不新写 spawn。
- submitFirstMessage 零改动是核心设计目标，W3-T1 用 diff 验证。

## 未发现问题

- FR 全覆盖（8/8）
- spec_review 修复全覆盖（SR1-SR5）
- 依赖链无环（W1 → W2 → W3）
- warning「涉及文件数 17 超 15」可接受——WorktreeService 是新功能，跨 shared/runtime/renderer 三层是必要的，文件数合理
- warning「FR 全部未覆盖」是 cw lite 格式的覆盖检查误报（changes 用 description 描述 FR 覆盖而非显式 ref），实际人工对照全部覆盖
