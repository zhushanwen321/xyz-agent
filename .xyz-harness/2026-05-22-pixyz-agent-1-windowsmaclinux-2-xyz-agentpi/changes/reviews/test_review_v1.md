---
review:
  type: test_review
  round: 1
  timestamp: "2026-05-22T12:00:00"
  target: "changes/evidence/test_execution.json, changes/evidence/test_results.md"
  verdict: pass
  summary: "测试评审完成，第1轮通过，0条MUST FIX"

statistics:
  total_issues: 2
  must_fix: 0
  low: 1
  info: 1

issues:
  - id: 1
    severity: LOW
    location: "test_cases_template.json:TC-3-02"
    title: "TC-3-02 标题/描述中的 skill 数量（19）与实际不符"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 2
    severity: INFO
    location: "test_execution.json"
    title: "所有 13 个测试用例均为手动验证步骤，无自动化断言框架"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 测试评审 v1

## 评审记录
- 评审时间：2026-05-22 12:00
- 评审类型：测试评审
- 评审对象：test_cases_template.json（13 TCs）、test_execution.json（执行记录）、test_results.md（自动化测试）、e2e-test-plan.md（E2E 场景）

## 检查维度

### 1. AC 覆盖矩阵

| AC | 场景 | 覆盖状态 | 测试位置 |
|----|------|---------|----------|
| AC-1 | 打包后 pi 可启动 — Sidecar 能 spawn bundled pi binary | ⚠️ | TC-1-01 (path 解析), TC-6-01 (无 fallback), TC-4-01 (extraResources config) |
| AC-2 | 预装 Extension 可用 — /subagent /goal /todo 命令直接可用 | ⚠️ | TC-3-01 (目录结构验证) |
| AC-3 | 预装 Skill 可用 — pi 能发现全部 19 个 skill | ⚠️ | TC-3-02 (18/18 存在，spec 的 19 为笔误) |
| AC-4 | 三平台构建通过 — CI 三平台均成功打包 | ⚠️ | TC-4-01, TC-4-02, TC-4-03 (config/script 验证，非实际 CI 执行) |
| AC-5 | 开发模式不受影响 — npm run dev 不依赖 resources/pi | ⚠️ | TC-1-02 (dev path fallback), TC-2-02 (env 不注入), TC-5-01 (app.isPackaged 条件) |
| AC-6 | 不与系统 pi 冲突 — 打包版使用 bundled pi | ⚠️ | TC-6-01 (无 fallback 逻辑验证) |
| AC-7 | Provider 配置通过 UI 注入 — bundled pi 不读 ~/.pi/ | ⚠️ | TC-7-01 (buildProviderEnv 无 guard), TC-7-02 (loadPiConfig/readPiDefaultModel 返回 null) |

**评估**：所有 7 个 AC 均有对应测试覆盖，均为 ⚠️ 部分覆盖。原因是 AC-1~7 中涉及实际打包应用交互的场景（spawn pi、加载 extension/skill、CI 构建产物验证）需要 E2E/集成测试，当前测试范围局限在单元/逻辑验证级别。E2E 测试计划（`e2e-test-plan.md`）已定义 TS-1~TS-7 七个 E2E 场景并标注为 manual，计划合理。无 ❌ 状态的 AC。

### 2. 测试质量

**断言充分性**：每个 TC 的执行记录均包含具体验证步骤和 evidence，如：
- TC-1-01：明确验证 `existsSync` 返回 true/false
- TC-2-01：明确验证 `PI_CODING_AGENT_DIR` 路径拼接结果
- TC-7-02：明确确认两个函数均返回 null

断言充分，不浮于"不抛异常"层面。

**测试意图正确性**：13 个 TC 覆盖了 9 个 FR 的核心逻辑（binary 发现、环境变量注入、extension/skill 打包、electron-builder 配置、CI 脚本、packaged guards、no ~/.pi/ reads）。意图与 spec 要求一致。

**脆弱性**：无依赖实现细节的脆弱测试。测试验证的是行为结果（路径解析、env 值、文件存在性），而非内部实现片段。

### 3. 测试可维护性

**结构**：TC 按 FR 分组编号（TC-1-xx ~ TC-7-xx），每组对应一个功能区域，结构清晰。

**独立性**：TC 之间无执行顺序依赖，可独立运行。

**Setup 抽取**：无共享 setup，是预期行为（每个 TC 自包含验证逻辑）。

### 4. 数据构造合理性

- 测试数据贴近实际场景（真实文件路径、真实 env 变量名、真实子模块路径）
- 无 magic number（路径构造使用标准 `path.join`）
- mock/stub 使用合理（模拟 `XYZ_AGENT_PACKAGED=1`、模拟目录结构）

### 5. 自动化测试结果

`test_results.md` 报告：
- 46 runtime unit tests → PASS
- 73 frontend unit tests → PASS
- TypeScript typecheck → PASS
- ESLint → 0 errors, 3 warnings (pre-existing)

自动化测试覆盖了代码变更的回归验证，119 个测试全部通过。

### 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | LOW | test_cases_template.json:TC-3-02 | TC-3-02 标题"All 19 xyz-harness skills load from bundled directory"中的 19 与实际不符。spec.md 列出 18 个 skill 但文字描述为 19。test_execution 正确报告了 18/18，但 TC 模板的描述未同步更新 | 将 TC-3-02 标题/描述中的 "19" 改为 "18"，或更新实际技能列表确认实际数量 |
| 2 | INFO | test_execution.json | 所有 13 个测试用例均为手动验证步骤（code scan、ls、inline Node.js），非自动化断言。在当前阶段作为功能验证是合理的，但后续需要转化为自动化测试以支持回归 | 建议在 Phase 5 或后续维护中将关键路径测试转化为 vitest 自动化测试 |

### 结论

通过

### Summary

测试评审完成，第1轮通过，0条MUST FIX
