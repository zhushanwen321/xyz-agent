---
phase: pr
verdict: pass
---

# Overall Retrospect — plugin-system-frontend-dx

覆盖全部 5 个 Phase 的整体复盘。

## 1. Phase Execution Review（跨 Phase 全局视角）

### Summary

完整走完 xyz-harness 5 个 Phase，产出插件系统的前端集成 + 后端 stub 修复 + 质量补强 + Goal 插件类型修复。最终交付：

| 产出 | 量化 |
|------|------|
| Spec | 12 FR、15 AC、13 项实施范围 + 8 项延后 |
| Plan | 13 Task、7 Execution Group、11 接口方法、6 数据流 |
| 代码 | 30 文件变更 (+5028/-113 行)、7 新测试文件、110 新测试 |
| Goal 插件修复 | 3 文件重写（goal-tool/goal-hooks/index），9 tsc 错误清零 |
| 测试 | 338 后端测试全通过、20 TC 执行 (13 自动化 + 7 代码审查) |
| 文档 | CLAUDE.md 插件架构章节、README.md 更新 |
| PR | PR #57，Lint ✅ / Test ✅ / TypeCheck ✅（3 轮 CI 修复） |

### 各 Phase 执行质量

**Phase 1 (Spec) — 3/5**
- 调研充分（3 路并行 subagent 发现 18 个遗漏项），但 WS 协议清单分散在多个 FR 中导致 review 需要 3 轮才能收敛。核心教训：**协议消息应集中定义再被 FR 引用**。

**Phase 2 (Plan) — 4/5**
- L2 复杂度正确识别，子文档拆分合理。API 对齐审查发现 5 处前后端类型不一致是关键价值。
- 缺陷：`test_cases_template.json` 缺少 `planTaskId`/`ac_ref` 等字段；`plan_bl_review` 未在 skill 文档中标注为必需。

**Phase 3 (Dev) — 3/5（最复杂的 Phase）**
- Wave 并行调度效率高（3 Wave、7 Group、13 Task），但 BLR 审查发现 2 个严重逻辑错误：`togglePlugin` 激活全部插件、`bridge:tool_execute` 参数字段名错误。
- 5 步审查发现 11 个 MUST FIX，修复轮占 Phase 30% 时间。

**Phase 4 (Test) — 5/5**
- 最顺利的 Phase：20 TC 一轮全过，无需修复。4 个并行 subagent 验证不同 TC 组。

**Phase 5 (PR) — 4/5**
- 3 轮 CI 修复：lint unused vars → pre-existing Goal tsc errors → 最终全绿。
- Goal 插件修复是本轮最大贡献：将旧版 API 调用适配到当前 plugin system 架构（分离 handler/registration、sessionData → globalState、HookInterceptor 返回类型对齐），彻底消除了 9 个 pre-existing tsc 错误。

### Phase 5 详细复盘

#### Problems Encountered

1. **CI Round 1: 2 个 lint error（unused vars）**
   - `plugin-rpc-server.ts` L162: `for (const [id, pending] of ...)` 中 `id` 未使用 → 改用 `.values()`
   - `plugin-service.ts` L633: `entries` 变量构建后未使用（bridge flush 代码被注释掉）→ 注释掉变量声明
   - **根因**：Dev Phase 结束时没有跑 `npm run lint`，PR Phase 才发现

2. **CI Round 2: 9 个 pre-existing TypeCheck errors in Goal plugin**
   - `goal-tool.ts`: `ToolRegistration` 不包含 `handler` 字段，`api.sessionData.get` 接收 2 参数而非 1，`api.tools.register` 返回 `Promise<string>` 而非 `Disposable`
   - `goal-hooks.ts`: hook 方法返回 `Promise<Disposable>` 而非 `Disposable`，`onPiEvent` callback 签名是 `(eventName, data)` 而非 `(data)`，`sessionData` 同样的参数问题
   - **根因**：Goal 插件代码是基于旧版 API 编写的，Phase 2 实现 plugin system 后 API 签名变了，但 Goal 插件没有同步更新
   - **修复**：
     - 分离 `registerGoalTool`（只注册 schema）和 `executeGoalAction`（独立执行函数）
     - 从 `api.sessionData`（需要 sessionId）切换到 `context.globalState`（插件级存储，不需要 sessionId）
     - `await` 所有 `Promise<Disposable>` hook 返回值
     - 修正 `onPiEvent` callback 签名
     - 返回 `InterceptorResult`（`{ proceed, modifiedData }`）而非裸 `{ injectedMessages }`
   - **改动**：4 文件，325 行新增 / 294 行删除，测试重写

3. **CI Round 3: 全绿** ✅

#### What Would You Do Differently

- **Dev Phase 结束时必须跑完整 CI 预检** — lint + tsc + test，不应等到 PR Phase
- **API 变更时同步更新所有消费者** — plugin-types.ts 签名变更后，Goal/Todo 插件应同步修改
- **在 CI 中对 `resources/plugins/` 也执行 typecheck** — 避免这类 pre-existing 错误积累

### Cross-Phase Patterns

1. **协议/接口一致性是最大风险源** — Phase 1 命名矛盾、Phase 2 前后端类型不一致、Phase 3 参数字段名错误、Phase 5 Goal 插件 API 不匹配。根因都是"接口定义分散，缺乏单一 truth source"。

2. **Subagent 上下文质量 = 产出质量** — Phase 3 BG1 的 2 个严重错误根因是 task prompt 缺少方法签名。Phase 3 FG2 产出完全合规因为 prompt 包含了组件限制。

3. **Gate check 是可靠的安全网** — 5 个 Phase 的 gate 都正确检查了必需交付物，无 false positive。

4. **Parallel subagent 是效率关键** — Phase 2 的 2 路并行子文档、Phase 3 的 3 路并行 Wave、Phase 4 的 4 路并行 TC 验证，都显著缩短了执行时间。

### What Would You Do Differently（全局）

1. **Phase 1 先写协议清单 section 再写 FR**
2. **Phase 2 先检查 gate 脚本的检查项**
3. **Phase 3 task prompt 标准模板** — 强制包含：接口签名、已知约束、禁止事项
4. **Phase 3 Dev 结束时跑一次完整 CI 预检** — lint + tsc + test
5. **API 签名变更时同步更新所有消费者** — 避免 PR Phase 才发现 pre-existing errors

### Key Risks Remaining

1. **plugin:permissionRequest 和 plugin:messageDecoration 无服务端发送方** — 前端监听代码完整但无触发源。Phase 4 scope，当前是死代码路径。
2. **UI 组件未经运行时验证** — PluginsPane、MessageDecoration、SlashMenu 集成只在代码层面验证。
3. **Tool execution Worker 端 handler 路由未实现** — `plugin.tool.execute` RPC 从主线程 invoke 到 Worker，但 Worker 端没有注册 handler 来路由到 `executeGoalAction`/`executeTodoAction`。这是后续需要补充的基础设施。

## 2. Harness Usability Review（全局视角）

### Flow Friction

- **Phase 1→2→3→4 过渡流畅**
- **最大摩擦点在 Phase 3 的审查→修复→更新 review 循环** 和 Phase 5 的 3 轮 CI 修复
- **Phase 2 和 Phase 4 的"gate 要求但 skill 未强调"的交付物** — `plan_bl_review`、`test_cases_template.json` 字段要求

### Gate Quality

- **Gate 是整个流程中质量最高的组件** — 5 个 Phase 都正确检查，无 false positive
- **Gate 格式要求严格但合理** — boolean 类型检查防止 `true` vs `"true"` 常见错误

### Prompt Clarity

- **Phase 1 (spec) 和 Phase 2 (plan) 的 skill 描述最清晰**
- **Phase 3 (dev) 对 subagent task prompt 的指导不足** — 没有要求"包含完整方法签名"
- **Phase 5 (PR) 的 CI 预检步骤很实用** — 应该在 Dev Phase 结束时也要求

### Automation Gaps

| Gap | Phase | 建议 |
|-----|-------|------|
| 审查→修复→更新 review 循环无自动化 | Dev | Review 产出 fix list → auto-fix subagent → auto-update review |
| test_execution.json 手动编写 | Test | vitest 输出 → 自动生成 JSON |
| CI 预检应在 Dev Phase 结束时自动运行 | Dev/PR | Dev gate 通过后自动触发 lint + tsc + test |
| Goal 插件类型不匹配在 PR Phase 才发现 | PR | API 变更时自动扫描所有消费者 |

### Time Sinks（全局排序）

1. **Phase 3 审查→修复循环**（~25% 总时间）
2. **Phase 5 Goal 插件重写**（~20% 总时间）— 4 文件重写 + 测试重写
3. **Phase 1 spec review 3 轮**（~15% 总时间）
4. **Phase 2 API 对齐修复**（~10% 总时间）

### Harness 整体评价

xyz-harness 5 Phase 流程对这个 L2 复杂度的 feature 是合适的。Gate check 严格性保证交付物完整性，parallel subagent 显著提升效率。主要改进方向：

1. **前置声明 gate 必需交付物** — skill 文档与 gate 脚本同步
2. **Dev Phase 结束时 CI 预检** — 避免在 PR Phase 才发现 lint/tsc 问题
3. **API 变更同步机制** — 签名变更时自动扫描所有消费者
4. **Subagent task prompt 标准模板** — 强制包含接口签名、约束、禁止事项
