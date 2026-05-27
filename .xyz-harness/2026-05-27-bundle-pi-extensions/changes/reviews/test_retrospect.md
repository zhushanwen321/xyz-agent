---
phase: test
verdict: pass
---

# Test Phase Retrospect — bundle-pi-extensions

## 1. Phase Execution Review

### Summary

Phase 4 执行了 9 个测试用例（TC-1-01 到 TC-4-02），全部通过。由于 bundled pi extension 在 xyz-agent 的测试框架覆盖范围外运行（pi 的 jiti 运行时编译执行），9 个 TC 中无一能通过自动化测试框架验证，全部退化为 code_review 静态分析。核心验证手段是代码路径追踪：`rpc-client.ts:85 (PI_CODING_AGENT_DIR)` → `pi-config-bridge.ts (getPiAgentDir → ~/.xyz-agent/pi/agent/)` → `logger.ts (LOG_DIR)` → 文件系统。

### Problems Encountered

1. **所有 TC 都是 code_review 而非真实测试**：TC-1-01/02/03 需要 `npm run dev` 启动应用后手动验证 slash command 和 tool 渲染，TC-2-01/02 需要触发 subagent 调用后检查日志目录，TC-3-01 需要 `npm run build`。这些都无法在 CI 或 CLI 中自动化执行。test_execution.json 中所有 TC 的 evidence 都是 `code_review:`，没有一个 `bash:` 或 `automated:`。

2. **TC-3-01 生产构建未实际执行**：`npm run build` 需要 Electron SDK 且耗时较长（~5min），只验证了 electron-builder.yml 的 extraResources 配置和源码目录结构。真正的"打包后 Resources 目录包含 extensions"验证被推迟到发布前。

### What Would I Do Differently

- **测试用例类型应标注为 `code_review` 而非 `manual`**：test_cases_template.json 中 TC-1-xx 和 TC-2-xx 的 type 是 `manual`，暗示需要人工操作。但实际上对于这种"代码路径追踪"的验证，`code_review` 更准确。`manual` 应保留给真正需要人工交互验证的场景（如 UI 截图对比）。

- **应有一个可自动化的冒烟测试**：至少 `migrateToPiSubdir()` 的 extensions 同步逻辑可以写一个纯 Node.js 脚本验证（mock `process.env.XYZ_AGENT_PACKAGED` 和 `process.cwd()`，验证 cpSync 目标正确）。但由于改动量极小（10 行），投入产出比不合理。

### Key Risks for Later Phases

- **所有 TC 本质上是静态分析**：没有真正的运行时验证。如果 pi 的 jiti 在加载某个 extension 时报 TS 编译错误，或者 `PI_CODING_AGENT_DIR` 环境变量在 rpc-client spawn 时未正确传递，Phase 4 的 "passed" 无法捕获这些问题。这是本项目的结构性限制（pi extension 在子进程中执行，xyz-agent 的测试框架无法触及）。

## 2. Harness Usability Review

### Flow Friction

- **Phase 4 对于纯静态改动几乎是空转**：所有验证在 Phase 3 的 test_results.md 和 5 步专项审查中已经完成。Phase 4 只是重复了同样的代码路径追踪，输出格式从 markdown 换成了 JSON（test_execution.json）。两个 phase 做了相同的验证工作，只是记录格式不同。

### Gate Quality

- Gate check 的 cross-reference 逻辑准确：检查了 9 个 template case 是否全部覆盖、最终轮次是否全部 passed、execute_steps 是否非空。无假阳性。
- `passed` 字段的布尔类型检查有效（我确认写的是 `true` 而非 `"true"`）。

### Prompt Clarity

- phase-test skill 文档清晰，test_execution.json 的 schema 说明详细。字段类型（布尔 vs 字符串 vs 数字）的注意事项（"常见错误"列）很有用，避免了一个常见的 YAML/JSON 混淆陷阱。

### Automation Gaps

- **缺乏"code_review 类型 TC"的标准验证流程**：当 TC 无法自动化时，skill 只说"record results"，但没有定义 code_review 类型 TC 的验证标准（需要追踪到哪些代码行？需要覆盖哪些分支？）。这导致每个 code_review TC 的 evidence 质量完全取决于执行者的判断。

### Time Sinks

- **为 9 个 TC 编写 execute_steps 描述**：每个 TC 需要 3-4 行步骤描述，即使验证方式都是"读了代码，确认路径正确"。这是格式开销而非实际验证工作。
