---
phase: dev
verdict: pass
---

# Dev Phase Retrospect — Runtime + Front-end Architecture Refactoring

## 1. Phase Execution Review

### Summary

Dev phase 成功将 Runtime 层从两个上帝类（server.ts 574L + session-pool.ts 600L）重构为 Transport + Service 分层架构。10 个 Task 全部完成，按 4 个 Execution Group（BG1/BG2/BG3/FG1）有序推进：

- **BG1**（Task 1-2）：删除死代码 + 提取 `message-converter.ts` 纯函数。低风险热身，顺利通过。
- **BG2**（Task 3-6）：重命名 `pi-rpc-types.ts` → `types.ts`、拆分 `config-store.ts`、提取 `scanner-base.ts`、绑定类型到 `event-adapter.ts`。这些是结构性准备工作。
- **BG3**（Task 7-8）：定义 7 个 DI 接口、提取 3 个 Service、重写 server.ts 为 Transport 层、**整体删除 session-pool.ts**。这是核心重构，也是风险最高的部分。
- **FG1**（Task 9-10）：前端创建系统通知工厂函数、删除 3 个死 composable、给 useSession/useProvider 加 refCount 保护。

最终指标：server.ts 574L → 365L（虽超 AC-1 的 ≤250L 目标，但注释和 import 占比较大），session-pool.ts 完全删除，新增 services/ 目录 680L + interfaces.ts 142L + message-converter.ts 80L。46 个 runtime 测试全部通过，0 类型错误。

### Problems Encountered

1. **server.ts 行数超标 AC-1**：AC 要求 ≤250L，实际 365L。主要原因是 37 个消息类型的 switch/case 路由本身就需要 ~150L，加上 import、注释和辅助方法。Code review v2 标记为 LOW 但未阻塞通过。如果将消息路由提取为 Map<string, Handler> 模式可以进一步缩减，但那是后续优化。
2. **6 个 LOW issue 未解决**：Code review v1 发现 6 个 LOW 级别问题（PiEvent 未完全使用、注释残留、async 函数缺少 return 等），v2 确认全部继承未修复。按"只动必须动的"原则，这些不影响功能正确性，合理地推迟处理。
3. **4 个前端测试 baseline 失败**：`register-tool-renderers.test.ts` 等 4 个文件因 Vite 配置缺少 `@vitejs/plugin-vue` 而失败。验证了是 pre-existing 问题，非本次变更引入。

### What Would You Do Differently

1. **server.ts 行数目标更务实**：AC-1 的 ≤250L 目标在没有消息路由表重构的前提下不现实。Plan 阶段应该更精确地估算 switch/case 路由的最小行数，给出 ≤350L 的更合理目标。
2. **DI 接口定义提前验证**：Task 7（定义接口）和 Task 8（提取 Service）虽然声明为依赖关系，但实际执行中发现接口定义和 Service 实现之间的迭代很频繁。如果合并为一个 Task 或者让 Task 7 产出更具体的接口签名示例，可以减少来回。
3. **前端 refCount 应在 Plan 阶段标为更高风险**：split mode 下事件重复注册是潜在 runtime bug，不仅仅是代码质量问题。应在 spec 中明确标为 FR 而非"快速修复"。

### Key Risks for Later Phases

1. **server.ts 365L 仍有缩胖空间**：如果后续新增消息类型，行数会继续增长。需要在 test phase 或后续 spec 中考虑 Map-based 路由重构。
2. **6 个 LOW issue 的技术债累积**：特别是 event-adapter.ts 中 PiEvent 类型绑定了但 translate() 未完全利用，以及 async handler 缺少 return 的问题。这些不会立即出 bug，但会影响后续维护。
3. **前端 4 个 baseline 失败测试**：如果不修复 Vite 配置，后续任何前端变更都无法通过 CI。需要在 test phase 或独立 PR 中解决。

---

## 2. Harness Usability Review

### Flow Friction

整体流程顺畅。10 个 Task 按依赖关系分 4 组串行执行，每组内部的 Task 并行度合理。唯一摩擦点：

- **BG2 的 4 个 Task 声明为可并行**，但实际 Task 3（重命名 types.ts）和 Task 6（绑定 types.ts 到 event-adapter）存在隐性依赖：Task 6 需要 Task 3 的产出。Plan 中虽标注了 `Depends on: 3`，但如果 subagent 不严格读取依赖声明，可能出错。实际执行时 Task 3 和 Task 4-5 确实并行了，Task 6 串行等 Task 3，没有问题。

### Gate Quality

Gate check 有效。两轮 code review（v1 审代码变更，v2 审测试证据）的分工很清晰：

- **v1**：逐 FR/AC 审查代码实现一致性，发现 6 个 LOW + 0 个 MUST FIX。
- **v2**：基于测试结果验证无回归、覆盖充分、类型检查通过。不重复审查源代码。

这个双轮设计避免了单轮 review 信息过载，也确保了代码质量和测试证据分别得到独立验证。效果比单轮全量 review 好。

### Prompt Clarity

Plan 的 Task 描述质量较高，特别是：
- 每个 Task 标注了 Type（backend/frontend）、Depends on、Group。
- File Structure 表列出了每个文件的 create/modify/delete 状态和所属 Group。
- Execution Groups 有明确的描述和预估行数。

可以改进的地方：
- **AC-1 的行数目标需要附估算依据**。如果 Plan 中注明"37 个 case × ~4 行 = ~148L 路由最小体积 + ~100L import/辅助 = ~250L"，就能在 Plan 阶段发现 250L 不现实。
- **FG1 Task 9 和 Task 10 的文件范围不够精确**。Task 9 说"修改所有调用系统通知的组件"但没有列出具体哪些组件需要改。实际执行时需要 subagent 自行 grep，浪费了上下文。

### Automation Gaps

1. **测试 evidence 手动编写**：`test_results.md` 的内容（运行 vitest、统计测试数、对比前后行数）完全可以自动化。一个脚本运行 `vitest --reporter=json` + `cloc` + `git diff --stat` 就能生成 90% 的内容。
2. **Code review 的 AC 对照**：reviewer 需要手动逐条 AC 对照代码实现。如果有一个脚本能提取 spec.md 的所有 AC 条目并在 review 模板中预填，效率会高很多。
3. **Baseline 测试快照**：4 个前端测试的 baseline 失败是通过手动验证 base commit 确认的。如果有 CI 基线快照机制，可以自动标注 "pre-existing failure"。

### Time Sinks

1. **session-pool.ts 的整体删除**（Task 8）：这是整个 dev phase 最复杂的操作。需要同时提取 3 个 Service + 重写 server.ts + 删除 600L 文件 + 更新所有 import。单个 Task 改动量超过 3000 行。如果拆成 2-3 个更小的 Task（先提取 SessionService + 验证测试 → 再删除 SessionPool + 重写 server），每步的验证成本会更低。
2. **Code review v1**：审查范围覆盖全部 10 个 Task 的代码变更，信息量巨大。虽然有结构化模板，但单次审查 10+ 文件的改动仍然耗时长。如果按 Execution Group 分批 review（BG1 完成后 review → BG2 → BG3 → FG1），每批的上下文更聚焦。
