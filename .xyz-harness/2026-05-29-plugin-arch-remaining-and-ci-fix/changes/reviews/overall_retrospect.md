---
phase: pr
verdict: pass
---

# Overall Retrospect — plugin-arch-remaining-and-ci-fix

覆盖全部 5 个 phase 的整体复盘。

## 1. 整体 Phase 执行 Review

### Summary

整个工作流处理了 4 个独立工作项（PluginsPane 接入、Worker tool execute RPC handler、Windows CI pi 脚本、Windows 测试路径），跨 5 个 phase 产出 15+ commits，最终通过 CI 并创建 PR #58。

最有价值的发现不在 spec 或 plan 阶段，而在 **Dev 阶段的 Integration Review**——发现了 `plugin-host.ts` 的 RPC response 路由 bug（嵌套 vs 扁平格式不匹配），这个问题在 plan 阶段的 Interface Contracts 中没有体现，说明 plan 对"消息在模块边界上的实际格式"审查不够深。

### 各 Phase 回顾

| Phase | 耗时 | 轮次 | 核心产出 | 最大问题 |
|-------|------|------|---------|---------|
| Spec | 中 | 2 轮 review | spec.md | FR-2 设计细节初版过于笼统 |
| Plan | 中 | 2 轮 review | plan.md + 4 辅助文件 | `execute?` 可选性遗漏 |
| Dev | 长 | 1 轮 + 4 must_fix | 8 commits + 5 reviews | plugin-bootstrap.ts Vitest import 失败 + plugin-host.ts 路由 bug |
| Test | 短 | 1 轮 | test_execution.json (11 TC) | 无 |
| PR | 短 | 1 轮 | PR #58 + CI 通过 | 无 |

### Problems Across Phases

1. **Plan→Dev 的接口契约验证缺口**：Plan 的 Interface Contracts 列出了方法签名，但没有画出 `postRpcResponse` 发出的消息格式与 `plugin-host.ts worker.on('message')` 检查逻辑的对应关系。导致一个真实的 bug（嵌套 response 被静默丢弃）在 Dev 的 Integration Review 才被发现。**教训：Interface Contracts 不仅要有签名，还要有消息格式示例。**

2. **Vitest + Worker Thread 模块兼容性**：`plugin-bootstrap.ts` 在 Vitest 中 exports 始终为空（6 轮调试确认），这是 Vite ESM transform 的限制。**教训：涉及 `node:worker_threads` 顶层 import 的模块，应默认假设 Vitest 无法正常 import，测试策略优先考虑独立逻辑复制或 integration test。**

3. **Review subagent 的 diff 感知缺失**：Standards Review 将已有代码的 `py-[9px]` 标记为本次 must_fix。**教训：Review subagent 应接收 `git diff` 输出作为上下文，只审查变更行。**

### What Would You Do Differently

- **Plan 阶段增加消息格式 walkthrough**：对每个跨模块的消息传递，写出完整的 JSON 示例（发送方构造的消息 vs 接收方检查的字段），可以在 plan review 就捕获 plugin-host.ts 的路由问题。
- **Dev 阶段测试策略前置验证**：对有 Worker Thread 依赖的模块，先写一个最小 import test（`import * as mod from './target'`），确认 Vitest 能正确加载后再写完整测试。
- **L1 复杂度精简交付物**：本次 4 个独立小修复被 L1 评估，但仍然产出了 10+ 个辅助文件（use-cases、non-functional-design、5 个 review 文件）。对于 <200 行总改动的 PR，考虑 L0 级别（只要求 spec + plan + test_execution）。

### Key Risks (Post-Merge)

- **plugin-host.ts 嵌套 response 路由未经 E2E 验证**：修复通过了类型检查和单元测试，但真实 Worker ↔ 主线程的 RPC invoke 链路需要运行时验证。建议 merge 后在开发环境手动触发一次插件 tool execute。
- **Windows CI 验证已通过**：PR CI 在 Windows runner 上成功，这个风险已解除。

## 2. Harness 体验 Overall

### Flow Friction

- **Spec→Plan 的交付物膨胀最明显**：Spec 阶段产出 1 个文件（spec.md），Plan 阶段产出 5 个文件。对于 L1 复杂度的 4 个小修复，这 5 个文件中有 2 个（use-cases.md、non-functional-design.md）内容较薄，感觉是为了满足模板要求而写。
- **Dev 阶段的 5 步 review 产出量大但价值不均**：BLR 和 Integration Review 发现了真实 bug（高价值），Robustness Review 发现了注册顺序问题（中价值），Standards 和 Taste Review 对小改动产出主要是"确认无误"（低价值）。建议根据改动量动态调整 review 步数——<100 行改动只做 BLR + Integration，>300 行才跑全部 5 步。

### Gate Quality

- 5 个 phase 的 gate 都正确工作，无 false positive，无遗漏。唯一接近误报的是 Standards Review 的 `py-[9px]`（已有代码被标记为本次 must_fix），但这是 review subagent 的问题，不是 gate 机制的问题。
- Gate 脚本的 YAML frontmatter 解析、cross-reference 检查（test_execution vs test_cases_template）稳定可靠。

### Prompt Clarity

- 5 个 phase skill 的步骤描述整体清晰，特别是 Phase 4（test）的字段 schema 说明详细，避免了格式错误。
- 改进建议：
  1. **Phase 1 brainstorming 增加 shortcut 路径**：当需求来自已有 status/TODO 文档时，允许跳过提问直接写 spec。
  2. **Phase 3 dev 增加 review 动态配置**：根据改动量（行数/文件数）推荐 review 步数，而非固定 5 步。
  3. **Phase 4 test 增加 verification_method 降级说明**：UI 类型 TC 在无运行环境时，明确允许 code_review 替代。

### Automation Gaps

| 缺口 | 影响 | 建议 |
|------|------|------|
| Review subagent 不感知 diff | 误报已有代码问题 | Review prompt 自动注入 `git diff HEAD~N` 输出 |
| FR→TC 覆盖矩阵手工检查 | Self-Check 遗漏 | 脚本解析 spec.md FR + template caseId 前缀 |
| CI 日志分析手动 grep | 定位失败原因耗时 | 专用 skill 自动拉取 CI 日志并结构化摘要 |
| Plan 阶段无消息格式验证 | 跨模块 bug 延迟到 Dev 才发现 | Interface Contracts 增加消息格式示例要求 |

### Time Sinks

| 阶段 | 时间消耗 | 原因 |
|------|---------|------|
| Spec | CI 日志过滤 ~15 min | Windows build 日志量大，关键信息埋在 300+ 行输出中 |
| Dev | Vitest mock 调试 ~6 轮 | Worker Thread 模块的 ESM import 限制，反复尝试不同 mock 策略 |
| Dev | Review must_fix 修复 + Integration bug | 4 个 must_fix（2 个真实 bug + 1 个误报 + 1 个类型转换），额外 1 轮修改-验证 |
| Test | ~10 min | 最顺滑阶段 |
| PR | ~5 min | CI 等 60s 即通过 |

### 总体评价

Harness 流程在这个 L1 小任务上的主要收益是 **Integration Review 发现了 plugin-host.ts 的真实 bug**——如果跳过 review 直接 merge，这个 bug 会在运行时表现为所有插件 tool 调用 30s 超时。按改动量（~200 行）来看，流程偏重（10+ 辅助文件、5 步 review），但质量收益是真实的。建议后续对 L1 任务精简交付物要求。
