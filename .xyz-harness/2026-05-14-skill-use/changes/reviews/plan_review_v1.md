# Plan 评审 v1

## 评审记录
- 评审时间：2026-05-14 (时间省略)
- 评审类型：Plan 独立评审（Phase 1 阶段⑤）
- 评审对象：spec.md + plan.md
- 评审轮次：第 1 轮

## Spec 完整性检查

| 维度 | 覆盖状态 | 说明 |
|------|---------|------|
| 目标明确性 | ✅ | 一段话说清了：用户输入 `/` → SlashMenu 弹出 skill 列表 → 选择后输入参数 → 以 `/skill:name text` 格式传给 pi |
| 范围合理性 | ✅ | In/Out Scope 清晰，out-of-scope 包含了热更新、自然语言触发等容易自行扩展的方向 |
| 验收标准可量化 | ✅ | 10 条 AC 全部可量化、可测试，且标注了已实现状态（✅/⬜） |
| 技术约束 | ✅ | 7 项技术约束 + 5 项功能约束 + 3 项兼容性约束 |
| 已有基础设施 | ✅ | 详细的代码位置表 + 数据流图 + 接口定义位置表 |
| 实现状态标注 | ✅ | 实现状态总览表清晰标注了每个功能的完成状态 |

## Plan 可行性检查

| 维度 | 覆盖状态 | 说明 |
|------|---------|------|
| 任务拆分合理性 | ✅ | 7 个 Task 按层级拆分：sidecar 链路(T1/T4) → 前端 UI(T2/T3) → 测试(T5/T6) → 数据源(T7) |
| 依赖关系正确性 | ✅ | T6(E2E) 依赖 T1-T5 全部完成；T7(argHint 数据源) 是 T2(Todo) 的前置 |
| 工作量估算 | ✅ | 标注为 L1 复杂度，合理——6/7 个 Task 已实现，剩余 T6 为手动验证 |
| 遗漏 task | ✅ | 无遗漏。spec 中所有功能点都有对应 Task |
| 已实现标注 | ✅ | 每个已实现的 Task 标注 ✅ 并列出具体代码位置和行号 |

## Spec-Plan 一致性对照

逐条对照 spec 验收标准与 plan task 的映射关系：

| Spec AC | Plan Task | 覆盖状态 | 说明 |
|---------|-----------|---------|------|
| AC1: pi 启动传 `--skill` 路径 | Task 1 | ✅ | rpc-client + session-pool 均已实现 |
| AC2: SlashMenu 展示名称、描述和参数提示 | Task 2 + Task 7 | ✅ | Task 2 提供 UI 容器，Task 7 提供 argumentHint 数据源 |
| AC3: `parseSkillMd()` 提取 argument-hint | Task 7 | ✅ | skill-scanner.ts 已实现 |
| AC4: ScannedSkillInfo/SkillInfo 含 argumentHint | Task 7 | ✅ | shared/provider.ts 已实现 |
| AC5: `importSkills()` 透传 argumentHint | Task 7 | ✅ | stores/provider.ts 已实现 |
| AC6: `mergeSkillCommands()` 使用 argumentHint | Task 7 | ✅ | useSlashCommands.ts 已实现 |
| AC7: 选择 skill 后输入框预填 argumentHint | Task 3 | ✅ | ChatInput.vue 已实现 |
| AC8: 发送 `/skill:name text` 后 pi 正确展开 | Task 6 (E2E) | ✅ | E2E-11/E2E-12 覆盖 |
| AC9: Settings 变更后新 session 用更新后的 skill 列表 | Task 6 (E2E) | ✅ | E2E-14 覆盖 |
| AC10: 无 enabled skill 时 SlashMenu 仅展示内置命令 | Task 5 + Task 6 | ✅ | 单元测试 + E2E-02/E2E-06 覆盖 |

E2E 测试计划覆盖度：15 个用例完整覆盖了所有 AC，包括正向路径、边界条件（路径不存在、空 skill 列表）和隔离验证（新旧 session 行为不一致）。

## 类型签名抽查

抽查 5 个标识符，验证签名准确性：

| 标识符 | spec/plan 中的描述 | 代码库实际 | 一致性 |
|--------|-------------------|-----------|--------|
| `RpcClientOptions.skillPaths` | `string[]` (L21) | `skillPaths?: string[]` (rpc-client.ts L21) | ✅ 一致 |
| `SlashCommand.argumentHint` | `string` (L18) | `argumentHint?: string` (useSlashCommands.ts L17) | ✅ 一致 |
| `SkillInfo.argumentHint` | `argumentHint?: string` (L30) | `argumentHint?: string` (provider.ts ~L32) | ⚠️ 行号偏差 ~2 行，类型一致 |
| `parseSkillMd()` 返回值 | 返回 `{ description, triggers, argumentHint }` | 返回 `{ description, triggers, argumentHint }` (skill-scanner.ts ~L55) | ✅ 一致 |
| `getSkillPaths(cwd)` | `private getSkillPaths(cwd: string): string[]` | `private getSkillPaths(cwd: string): string[]` (session-pool.ts ~L549) | ✅ 一致 |

## 发现的问题

| # | 优先级 | 维度 | 位置 | 描述 | 修改建议 |
|---|--------|------|------|------|---------|
| 1 | LOW | plan 一致性 | plan.md Task 2 描述 | Task 2 描述写道"argumentHint 恒为 undefined"，与 Task 7（argumentHint 数据源已实现）矛盾。Phase 2 agent 可能困惑：到底是 undefined 还是有值？ | 更新 Task 2 描述，注明"Task 7 实现后 argumentHint 已有数据源" |
| 2 | LOW | spec 准确性 | spec.md L59-61 | `rpc-client.ts` 中 `--skill` args 追加实际在 L67-71（spec 引用 L59-61），偏差约 8 行。同样，`shared/provider.ts` L30/L49 的 argumentHint 行号也有 2-3 行偏差 | 行号标注为近似值即可，不影响实现。如追求精确可重新校准 |
| 3 | LOW | plan 完整性 | plan.md Task 6 | Task 6 风险点提到"需要本地 pi 进程可运行且有有效 API key"，但未说明如果 pi 不可用时的 fallback 策略。对于依赖外部进程的 E2E 测试，这可能导致 Phase 2 agent 无从下手 | 补充说明：pi 不可用时跳过 Task 6，记录为"环境不满足" |

### 无 MUST FIX 问题

逐项检查：

1. **数据丢失**：无。所有 skill 路径传递链路完整（create + restoreSession 都覆盖）
2. **功能失效**：无。argumentHint 数据链路从 scanner → shared → store → composable 完整闭合
3. **数据语义错误**：无。`dirname(sourcePath)` 传目录而非文件路径，语义正确
4. **重复副作用**：无。每个 Task 职责不重叠
5. **时序错误**：无。skill 列表在 session 创建时读取，不依赖异步加载

## 结论

**通过**

## Summary

Plan 评审完成，第 1 轮，0 条 MUST FIX，3 条 LOW，通过。

spec 与 plan 对齐度高，所有 10 条 AC 都能追溯到具体 Task 和 E2E 用例。主要原因是绝大部分功能已实现，plan 本质上是"验证 + 手动 E2E"。3 条 LOW 分别是 Task 2 描述与 Task 7 状态的矛盾、行号偏差、以及 E2E 环境不可用时的 fallback 策略缺失——均不阻塞 Phase 2 agent 执行。
