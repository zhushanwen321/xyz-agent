---
phase: spec
verdict: pass
---

# Spec Phase Retrospect — plugin-arch-remaining-and-ci-fix

## 1. Phase Execution Review

### Summary

Phase 1 从已有 status 文档和 CI 日志出发，快速定位了 4 个独立工作项（2 个 P0 集成缺口 + 2 个 CI Windows 问题），产出 spec.md 通过 2 轮 review。

关键决策：
- **不走完整 brainstorming 流程**：需求来自前一个 PR 的 status 文档（`plugin-system-status.md`），所有工作项已明确定义，省略重复探索直接写 spec。
- **FR-2 设计补充**：初版 spec 对 Worker 端 tool execute handler 的描述过于笼统（"添加 msg.request 处理"），review 准确指出 `ToolRegistration` 缺少 execute 签名、`HostToWorkerMessage` 类型未变更等 3 个 MUST_FIX。第二轮补充了完整的 `ToolExecuteHandler` 类型、Worker 侧 handler Map 维护机制、测试策略。

### Problems Encountered

1. **Windows CI 根因定位耗时较长**：GitHub Actions 日志量大，Windows zip 没有外层 `pi/` 目录这个关键信息需要从海量 unzip 输出中找到 `pi.exe` 直接 inflate 的行才确认。最终下载了 Windows zip 到本地验证结构。
2. **extension-service 测试失败原因**：初看日志以为是 pi 解压问题（用户原始描述"预存的 pi 解压问题"），实际是两个独立问题——pi 解压脚本 Windows 不兼容 + 测试路径分隔符 `\` vs `/`。需要分开处理。

### What Would You Do Differently

- 初版 spec 直接写完整 FR-2 设计细节，避免 2 轮 review。MUST_FIX #1（execute handler 注册路径）是一个应该在写 spec 时就能预见的设计缺口，不应该等 review 提出。

### Key Risks for Later Phases

- **FR-2 的 `toolHandlers` Map 跨模块访问**：`tool-api.ts` 创建的 Worker 侧 register 函数需要访问 `plugin-bootstrap.ts` 中定义的 Map。具体 wiring 模式（回调注入 / 模块级共享变量 / 参数传递）留给 plan 阶段决定，但需注意不引入循环依赖。
- **Windows CI 验证**：本地无法运行 Windows 测试，只能 push 后在 CI 验证。plan 中应考虑先合并 `prepare-pi-resources.sh` 修复并触发一次 release workflow 看 Windows 是否通过。

## 2. Harness Usability Review

### Flow Friction

- **Quick Overview 阶段**合理省略了不需要的 brainstorming 提问环节（需求明确且已有前序文档），但 skill 流程定义中仍然要求 "ask one question at a time"。对于"执行已知 TODO 列表"类型的任务，这个流程偏重了。
- **Spec review 需要手动 dispatch subagent**：每次都是 copy-paste 类似的 task prompt 模板。可以考虑 gate 自动触发 review。

### Gate Quality

- Gate 正确识别了两个问题：untracked files（spec.md 未 commit）和缺失 spec_review 文件。都是合理的阻塞条件，无 false positive。

### Prompt Clarity

- xyz-harness-brainstorming SKILL.md 的 Step 2（Progressive Questioning）对这类"补完已知 TODO"任务不适用。建议在 skill 中增加一个 shortcut 路径："当需求来自已有 status/TODO 文档且用户确认 scope 时，可跳过提问直接写 spec"。

### Automation Gaps

- **CI 日志分析**：手动 grep `gh run view --log` 输出定位 Windows 失败原因。如果有 skill 能自动拉取 CI 失败日志并结构化摘要，会大幅提效。

### Time Sinks

- **CI 日志过滤**（~15 分钟）：Windows build 日志中 pi 解压步骤的输出混在 300+ 行 unzip 文件列表中，需要多次调整 grep pattern 才找到关键行。
- **Windows zip 结构验证**（~5 分钟）：确认 macOS tar.gz 有 `pi/` 子目录而 Windows zip 没有，需要下载 zip 到本地 `unzip -l`。
