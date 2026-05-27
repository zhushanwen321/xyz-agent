---
phase: dev
verdict: pass
---

# Dev Phase Retrospect — bundle-pi-extensions

## 1. Phase Execution Review

### Summary

Phase 3 实际编码工作量极小：修改 logger.ts 1 个常量 + 1 个 try-catch 结构调整，删除 evolution-engine 目录（14 文件）。总改动约 10 行代码。5 步专项审查全部通过，仅 taste review 发现 1 个 MUST_FIX（ensureLogDir 在 try 块外），修复后第二轮通过。

### Problems Encountered

1. **ensureLogDir 异常传播**（taste review 发现）：`ensureLogDir()` 在 `write()` 函数的 try 块外调用，如果日志目录无法创建（权限不足、路径错误），异常会传播到 pi 主进程。修复方案：将 `ensureLogDir()` 移入 try 块，与 `appendFileSync` 共享同一个静默 catch。这是一个真实的健壮性改进，不是品味问题。

2. **无自动化测试**：bundled pi extension 源码在 xyz-agent 的测试框架覆盖范围外（由 pi 的 jiti 运行时编译执行），无法写单元测试。只能通过静态分析和手动集成测试验证。这在 test_results.md 中已如实记录。

### What Would I Do Differently

- **logger 修复应一次性做对**：改 LOG_DIR 时就应该同时把 ensureLogDir 移入 try 块，而不是等 review 发现。这两个改动是同一个安全改进的两个方面。
- **无其他可改进之处**：对于这个规模的改动（10 行代码），流程已经足够精简。

### Key Risks for Later Phases

- **无 Phase 4（test）的实际内容**：E2E test plan 的 4 个场景都需要手动执行（启动 dev mode、触发 slash command、检查日志文件）。Phase 4 可能只是确认"已手动验证"的仪式性步骤。
- **生产构建未实际验证**：AC-4（npm run build 成功 + Resources 包含 extensions）只做了静态代码确认（migrateToPiSubdir 逻辑正确），未实际执行 build。这是 Phase 4 或发布前的必要验证。

## 2. Harness Usability Review

### Flow Friction

- **5 步专项审查对于 10 行改动的性价比极低**：dispatch 了 5 个 review subagent（4 并行 + 1 串行），每个 subagent 都要读取相同文件、输出结构化报告。实际有效的审查发现只有 1 个 MUST_FIX（taste review 的 ensureLogDir 问题）。对于这种规模的改动，一个 code-review-worktree skill 的单步审查就足够了。
- **Pre-commit hook 警告**：gate 每次都提示 "Git pre-commit hook 未安装"，但这是 bare repo worktree 模式的正常状态（hooks 安装在 .bare/ 下，.git/hooks/ 是文件不是目录）。属于 false positive。

### Gate Quality

- Gate check 脚本准确检查了 17 项，全部 PASS。无假阳性。
- 自动选择了 ts_taste_review（非 rust_taste_review 或通用 taste_review），与项目 TypeScript 技术栈匹配正确。

### Prompt Clarity

- phase-dev skill 的简单路径/复杂路径判断清晰（< 4 tasks → 简单路径，主 agent 直接编码）。
- 5 步专项审查的 dispatch 编排文档清晰（Batch 1 四并行 + Batch 1 BLR 完成后 Batch 2 Integration）。

### Automation Gaps

- **Review 间的信息传递依赖文件系统**：BLR 需要产出"模拟业务数据和执行路径"供 Integration Review 消费。但 Integration Review subagent 是独立进程，需要重新读文件。如果 BLR 的产出格式不标准，Integration Review 可能找不到需要的数据。实际上 BLR 的产出格式完全由 subagent 自由发挥，没有 schema 约束。

### Time Sinks

- **5 个 review subagent 的 dispatch + 等待**占据了 Phase 3 的大部分时间。实际编码 2 分钟，审查 dispatch + 等待 + 修复 + 重新 dispatch 约 10 分钟。比例严重失衡。
