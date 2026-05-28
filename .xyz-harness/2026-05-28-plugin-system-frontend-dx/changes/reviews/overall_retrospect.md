---
phase: pr
verdict: pass
---

# Overall Retrospect — plugin-system-frontend-dx

覆盖全部 5 个 Phase 的整体复盘。

## 1. Phase Execution Review（跨 Phase 全局视角）

### Summary

完整走完 xyz-harness 5 个 Phase，产出插件系统的前端集成 + 后端 stub 修复 + 质量补强。最终交付：

| 产出 | 量化 |
|------|------|
| Spec | 12 FR、15 AC、13 项实施范围 + 8 项延后 |
| Plan | 13 Task、7 Execution Group、11 接口方法、6 数据流 |
| 代码 | 30 文件变更 (+5028/-113 行)、7 新测试文件、110 新测试 |
| 测试 | 340 后端测试全通过、20 TC 执行 (13 自动化 + 7 代码审查) |
| 文档 | CLAUDE.md 插件架构章节、README.md 更新 |
| PR | PR #57，Lint ✅ / Test ✅ / TypeCheck ⚠️ (pre-existing) |

### 各 Phase 执行质量

**Phase 1 (Spec) — 3/5**
- 调研充分（3 路并行 subagent 发现 18 个遗漏项），但 WS 协议清单分散在多个 FR 中导致 review 需要 3 轮才能收敛。核心教训：**协议消息应集中定义再被 FR 引用**。
- Review 质量：5 条 MUST FIX 全部真实（2 命名矛盾 + 3 协议遗漏），无 false positive。

**Phase 2 (Plan) — 4/5**
- L2 复杂度正确识别，子文档拆分合理。API 对齐审查发现 5 处前后端类型不一致是关键价值。
- 缺陷：`test_cases_template.json` 缺少 `planTaskId`/`ac_ref`/`fr_ref`/`verification_method` 字段，在 Phase 4 才发现并补全。`plan_bl_review` 文件在 gate 检查时才知是必需交付物。
- 核心教训：**先写 API contract 再写子文档**（而非并行生成后对齐）。

**Phase 3 (Dev) — 3/5（最复杂的 Phase）**
- Wave 并行调度效率高（3 Wave、7 Group、13 Task），但 BLR 审查发现 2 个严重逻辑错误：
  1. `togglePlugin` 激活全部插件而非单个（`handleEvent` vs `activatePlugin` 语义混淆）
  2. `bridge:tool_execute` 传 `params` 而非 `parameters`（unsafe cast 绕过类型检查）
- 5 步审查发现 11 个 MUST FIX，修复轮占 Phase 30% 时间。
- 核心教训：**subagent task prompt 必须包含完整方法签名**；**`as unknown as X` 是红色信号**。

**Phase 4 (Test) — 5/5**
- 最顺利的 Phase：20 TC 一轮全过，无需修复。4 个并行 subagent 验证不同 TC 组，总耗时约 30s。
- 7 个 UI TC 通过代码审查验证（无 Playwright E2E），风险可控。
- 唯一摩擦：模板字段补全（Phase 2 的遗留问题）。

**Phase 5 (PR) — 4/5**
- CI 预检发现 2 个 lint error（unused vars），一轮修复后 Lint + Test 通过。
- TypeCheck 有 9 个 pre-existing error（Goal 插件 API 兼容问题，`resources/plugins/goal/` 未被本分支修改），正确识别为非本次变更导致。
- 核心教训：**CI 预检应在 Dev Phase 结束时做**，不应等到 PR Phase 才发现 lint 问题。

### Cross-Phase Patterns

1. **协议/接口一致性是最大风险源** — Phase 1 的命名矛盾、Phase 2 的前后端类型不一致、Phase 3 的参数字段名错误，根因都是"接口定义分散，缺乏单一 truth source"。API contract first（Phase 2 的教训）是关键改进。

2. **Subagent 上下文质量 = 产出质量** — Phase 3 BG1 的 2 个严重错误根因是 task prompt 缺少方法签名。Phase 3 FG2 的产出完全合规因为 prompt 包含了组件限制和 xyz-ui 约束。**Task prompt 应该包含：完整接口签名 + 已知约束 + 禁止事项**。

3. **Gate check 是可靠的安全网** — 5 个 Phase 的 gate 都正确检查了必需交付物。唯一的 "意外" 是 Phase 2 的 `plan_bl_review` 和 Phase 4 的模板字段，都是"gate 要求但 skill 文档未强调"的交付物。

4. **Parallel subagent 是效率关键** — Phase 2 的 2 路并行子文档、Phase 3 的 3 路并行 Wave、Phase 4 的 4 路并行 TC 验证，都显著缩短了执行时间。

### What Would You Do Differently（全局）

1. **Phase 1 先写协议清单 section 再写 FR** — 避免协议消息分散在多个 FR 中导致 review 多轮返工
2. **Phase 2 先检查 gate 脚本的检查项** — 确保所有必需交付物在 plan 中就有计划，而非等 gate 报错
3. **Phase 3 task prompt 标准模板** — 强制包含：接口签名、已知约束、禁止事项、测试场景
4. **Phase 3 Dev 结束时跑一次 CI 预检** — 避免 PR Phase 才发现 lint error
5. **Phase 2 模板包含 planTaskId/ac_ref** — 避免 Phase 4 补全模板字段

### Key Risks Remaining

1. **Goal 插件 pre-existing tsc 错误（9 个）** — `resources/plugins/goal/src/` 有 API 兼容问题。CI TypeCheck 会持续失败直到修复。建议下一个 PR 专门修复。
2. **plugin:permissionRequest 和 plugin:messageDecoration 无服务端发送方** — 前端监听代码完整但无触发源。Phase 4 scope，当前是死代码路径。
3. **UI 组件未经运行时验证** — PluginsPane、MessageDecoration、SlashMenu 集成只在代码层面验证。首次 Electron 运行时需要手动确认渲染和交互。

## 2. Harness Usability Review（全局视角）

### Flow Friction

- **Phase 1→2 过渡流畅**，Phase 2→3 过渡流畅（L2 子文档模式成熟）
- **Phase 3→4 过渡流畅**，Phase 4→5 过渡流畅
- **最大摩擦点在 Phase 3 的审查→修复→更新 review 循环** — 11 个 MUST FIX 分布在 5 个 review 文件中，更新 verdict/must_fix 是机械性工作
- **Phase 2 和 Phase 4 的"gate 要求但 skill 未强调"的交付物** — `plan_bl_review`、`test_cases_template.json` 的字段要求，都是 gate 报错后才知道

### Gate Quality

- **Gate 是整个流程中质量最高的组件** — 5 个 Phase 的 gate 检查项都准确、无 false positive（Phase 4 的 untracked file 是真实的流程错误）
- **Gate 正确阻止了 2 次不合格交付**：Phase 2 缺 `plan_bl_review`、Phase 4 有 untracked file
- **Gate 格式要求严格但合理** — YAML frontmatter 的 boolean 类型检查防止了 `true` vs `"true"` 的常见错误

### Prompt Clarity

- **Phase 1 (spec) 和 Phase 2 (plan) 的 skill 描述最清晰** — 六要素检查、L2 子文档模式、Execution Group 模板都有详细指引
- **Phase 3 (dev) 的 skill 描述对 subagent task prompt 的指导不足** — 没有明确要求"在 task prompt 中包含完整方法签名"。这导致了 BG1 的 2 个严重错误。
- **Phase 5 (PR) 的 CI 预检步骤很实用** — 避免了 PR 创建后才发现 lint 问题（虽然我们的 lint 问题确实在 PR Phase 才发现）

### Automation Gaps

| Gap | Phase | 严重程度 | 建议 |
|-----|-------|---------|------|
| 审查→修复→更新 review 循环无自动化 | Dev | 高 | Review 产出 fix list → auto-fix subagent → auto-update review |
| test_execution.json 手动编写 | Test | 中 | vitest 输出 → 自动生成 JSON |
| 协议一致性无自动检查 | Spec/Plan | 中 | 自动提取 spec 中 WS 消息 → 与 protocol.ts 交叉比对 |
| Gate 必需交付物未在 skill 中前置声明 | Plan/Test | 中 | Skill 文档的交付物清单应与 gate 脚本同步 |
| CI 预检应在 Dev Phase 结束时自动运行 | Dev/PR | 低 | Dev gate 通过后自动触发 `npm run lint` + `npx vitest run` |

### Time Sinks（全局排序）

1. **Phase 3 审查→修复循环**（~30% 总时间）— 11 个 MUST FIX 的修复很快，但更新 5 个 review 文件的 verdict/must_fix 是机械性工作
2. **Phase 1 spec review 3 轮**（~15% 总时间）— 协议消息分散导致的返工
3. **Phase 2 API 对齐修复**（~10% 总时间）— 5 处前后端类型不一致
4. **Phase 4 模板字段补全**（~5% 总时间）— 20 TC × 4 字段的机械性补全

### Harness 整体评价

xyz-harness 5 Phase 流程对这个 L2 复杂度的 feature 是合适的。Gate check 的严格性保证了每个 Phase 的交付物完整性，parallel subagent 调度显著提升了执行效率。主要改进方向是：

1. **前置声明 gate 必需交付物** — skill 文档应列出所有 gate 检查项，而非让 gate 报错后补齐
2. **Subagent task prompt 标准模板** — 强制包含接口签名、约束、禁止事项
3. **审查修复自动化** — 减少 Phase 3 的机械性 review 更新工作
4. **Dev Phase 结束时 CI 预检** — 避免 PR Phase 才发现 lint 问题
