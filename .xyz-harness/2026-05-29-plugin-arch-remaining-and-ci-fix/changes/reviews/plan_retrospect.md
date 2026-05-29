---
phase: plan
verdict: pass
---

# Plan Phase Retrospect — plugin-arch-remaining-and-ci-fix

## 1. Phase Execution Review

### Summary

Phase 2 产出 5 个交付物（plan.md、e2e-test-plan.md、test_cases_template.json、use-cases.md、non-functional-design.md），经过 2 轮 plan review 后通过 gate。

复杂度评估为 L1——4 个独立修复点，无新领域建模、无跨服务数据流、无特殊非功能性要求。Execution Groups 分为 FG1（前端接线 4 文件）、BG1（RPC handler 4 文件）、BG2（CI 修复 2 文件），三个 Group 完全独立，Wave 1 可全部并行，Wave 2 做回归验证。

关键决策：ADR 评估结果为空——本次改动都是已有架构的自然延伸，无"难以逆转 + 无上下文会惊讶 + 真实权衡"的决策。

### Problems Encountered

1. **MUST_FIX #1: `ToolRegistration.execute` 可选性遗漏**。初版 plan 将 `execute` 定义为必填字段，但忽略了主线程侧 `tool-api.ts:62` 构造 `{ name, description, parameters }` 对象字面量时没有 execute 函数（不可序列化）。TypeScript 严格模式下必填字段缺失会编译报错。Review v1 正确指出，改为 `execute?: ToolExecuteHandler`。这是"写了实现代码但没考虑调用方类型兼容性"的典型遗漏。

2. **MUST_FIX #2: `handleMessage` 未 export**。Plan Step 4 的测试代码需要 `import { handleMessage }`，但 Step 2 只声明 export `registerToolHandler`，遗漏了 `handleMessage` 本身也需要从内部函数改为 export。这是一个步骤间的连贯性缺口。

3. **LOW #3: Windows `elif` 分支缺 `chmod`**。`mv pi.exe "${BINARY_NAME}"` 后没有 `chmod +x`，与 `pi/` 目录分支行为不一致。Review v1 捕获并修复。

### What Would You Do Differently

- 在写 Task 2 Step 1（类型定义）时，应该同步检查该类型在**所有消费方**的使用方式：主线程 `registerToolRpcHandlers` 构造 schema 对象时不包含 execute → 必须可选。这个遗漏本可以在写 plan 时就发现，不需要等 review 指出。
- Interface Contracts 章节的方法签名表可以更早用于发现类型不一致——如果签名表和 Step 代码同步写而不是先写 Step 再补签名表，MUST_FIX #1 在自审时就能捕获。

### Key Risks for Later Phases

- **Task 2 测试 mock 复杂度**：`plugin-bootstrap.ts` 顶层有副作用（`import { parentPort }` 立即使用、`new PluginRpcClient()` 实例化）。测试需要 mock `node:worker_threads` 和 `plugin-rpc-client.js`。ESM 环境下 `vi.mock` 的 hoisting 行为可能与 CJS 不同，执行时可能需要调整 mock 策略。
- **Task 2 `execute?` 可选导致的类型守卫**：`tool-api.ts` 中 `registerToolHandler(toolKey, registration.execute)` 传入的可能是 `undefined`（execute 改为可选后），需要在实现时加 `if (!registration.execute) throw` 守卫。
- **Task 4 参数名假设**：`mockImplementation((path: string | Buffer | URL) => {...})` 中的参数名 `path` 取决于 Vitest mock 机制，实际执行时可能需要用 `arguments[0]` 或解构方式。

## 2. Harness Usability Review

### Flow Friction

- **L1 场景下交付物偏多**：对于 4 个 <50 行的独立修复，要求产出 5 个独立文件（plan + e2e-test-plan + test_cases_template + use-cases + non-functional-design）显得重了。`use-cases.md` 和 `non-functional-design.md` 各只有 2-3 个实质内容段落。建议 L1 级别允许合并这些到 plan.md 的附录章节。

### Gate Quality

- Gate 检查正确识别了所有问题（未 commit 的文件、缺失 review 文件）。无 false positive。Review subagent 的 MUST_FIX 判断准确——两个问题都是真实的设计遗漏，不是误报。

### Prompt Clarity

- writing-plans SKILL.md 的 L1/L2 分级标准清晰，Execution Groups 模板格式明确。Interface Contracts 和 Spec Coverage Matrix 模板也很实用，帮助在 plan 阶段就建立 AC → method → task 的追溯链。
- 一个改进建议：Task 结构模板中的 TDD 5 步（写失败测试 → 验证失败 → 写实现 → 验证通过 → commit）在 harness 模式下被简化为"每个 Task 对应一次 subagent 链"，但模板仍保留 5 步格式，容易产生混淆。

### Automation Gaps

- **Self-Review checklist 手工执行**：placeholder scan（grep TBD/TODO）、type consistency 检查（对比多个 Step 中的类型签名）可以做成脚本自动检测。
- **ADR 评估可自动化**：扫描 plan.md 中是否有"决定"/"选择"/"采用"等关键词，提示可能需要 ADR。

### Time Sinks

- 无明显时间浪费。Plan 编写 ~1 轮，review 2 轮（v1 发现 2 个 MUST_FIX，v2 确认修复）。每轮改动量很小（3 处 1-2 行的修改）。总体流程顺畅。
