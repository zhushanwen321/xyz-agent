---
phase: test
verdict: pass
---

# Test Phase Retrospect

## 1. Phase Execution Review

### Summary

测试阶段执行了 20 个测试用例（11 个 API 测试 + 9 个集成测试），覆盖 spec 中全部 9 个 FR 和 10 个 AC 分组。46 个 runtime vitest 测试全部通过，`tsc --noEmit` 零类型错误，`npm run build` 全阶段通过。

最终测试评审（test_review_v1.md）给出 0 MUST FIX、4 LOW、1 INFO，一轮通过。

关键数据：
- 20 个测试用例，22 次执行（2 个用例需 R2 修复）
- vitest: 7 文件 / 46 用例 / 100% 通过
- server.ts: 569L → 365L（超标但已 code review 接受）
- session-pool.ts: 已删除
- 3 个 dead composable: 已删除
- 新增 message-converter.test.ts（3 用例）

### Problems Encountered

1. **TC-7-02 R1 失败 — server.ts 行数 365L 超出 spec 目标 ≤250L。** R2 以 code review 结论（全部是 Transport 路由代码，无业务逻辑）为由接受。测试用例的验收标准被隐含放宽，但未更新 test_cases_template.json。做法合理但不规范——应在测试执行记录中明确标注偏差原因。

2. **TC-11-01 R1 失败 — `vue-tsc` 类型错误。** SystemNotification.vue 的 `type` prop 只声明了 `'done' | 'alert'`，缺少 `'info'` 变体。这是 dev 阶段引入的遗漏（新增了 `info` 类型通知但未同步组件 prop 定义）。修复简单（补一个字面量），但说明 dev 阶段的 TypeScript 编译检查不够充分——应在每个 task 完成时跑 `npm run build` 而非等到 test 阶段才发现。

3. **4 个前端测试文件持续失败（pre-existing）。** 原因是 Vite 配置缺少 `@vitejs/plugin-vue`，在 base commit 上就存在。不算本 phase 的问题，但记录在案。

### What Would You Do Differently

1. **dev 阶段强制 build 检查**：每个 subagent task 完成后加一步 `npm run build`，而不是把编译验证全部压到 test phase。本次 TC-11-01 的类型错误本应在 dev 阶段就被发现。
2. **测试计划与实际执行对齐**：test_cases_template.json 中集成测试步骤描述的是"启动 Runtime → WS 连接 → 发送消息"，实际执行用的是 vitest mock 测试。应在测试计划阶段就明确测试方式，而不是执行时替换。对纯重构项目风险可控，但方法论上不一致。
3. **AC 覆盖度缺口前置**：AC-6（Config Store 拆分）和 AC-7（Scanner Base）只有间接覆盖，应在写测试计划时补充直接测试用例。

### Key Risks

1. **server.ts 行数 365L，未来新增 handler 会继续膨胀。** 当前 27 个 case 全是 Transport 路由，但如果后续需要新增消息类型，建议先拆分（如按 domain 分 handler 文件）再添加。
2. **无端到端 WS 集成测试。** 所有集成测试都是 vitest mock service layer，未验证实际 WebSocket 连接、消息序列化、心跳断连等传输层行为。纯重构阶段可以接受，但如果未来修改传输层，需要补充真实的 WS 集成测试。
3. **4 个前端测试文件的 Vite 配置问题未修。** 虽然是 pre-existing，但会导致前端测试长期不可用，应在后续迭代中修复。

## 2. Harness Usability Review

### Flow Friction

测试阶段流程顺畅。从 dev phase 交付 → 编写测试用例 → 执行测试 → 评审 → 复盘，没有需要 workaround 的地方。test_cases_template.json 的结构（id + type + steps）指导性很强，AI 可以直接按步骤执行。

### Gate Quality

测试评审（test_review_v1.md）质量高。评审发现了 5 个有意义的问题，尤其是 AC 覆盖度缺口（AC-6/AC-7 仅有间接覆盖）和测试计划与实际执行不一致，这些是有价值的观察。评审正确区分了 MUST FIX 和 LOW，没有误报。

### Prompt Clarity

测试阶段的 prompt 描述清晰。test_cases_template.json 的 steps 字段足够具体（指定了 grep 命令、文件路径、检查项），AI 几乎不需要猜测。唯一不足是集成测试的 steps 描述与实际执行方式不一致（描述用 WS 连接，实际用 vitest mock），这不是 prompt 问题而是计划阶段的设计选择。

### Automation Gaps

1. **测试执行记录需要手动构造 JSON。** 每个测试用例的 execute_steps、evidence 都需要逐条填写。如果测试执行脚本能自动生成 JSON 结构（记录命令 + 输出 + 通过/失败），效率会更高。
2. **AC 覆盖矩阵缺少自动生成。** 目前需要人工（AI）将测试用例与 AC 逐一映射，如果 test_cases_template.json 中每个用例标注覆盖的 AC ID，矩阵可以自动生成。

### Time Sinks

无显著时间消耗点。20 个测试用例的执行和评审在合理时间内完成。最大的时间消耗是 TC-11-01 R1 失败后的排查和修复，但这属于正常测试工作。
