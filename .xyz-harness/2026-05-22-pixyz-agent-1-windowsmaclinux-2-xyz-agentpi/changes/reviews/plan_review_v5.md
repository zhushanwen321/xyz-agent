---
verdict: pass
must_fix: 0
review:
  type: plan_review
  round: 5
  timestamp: "2026-05-22T23:30:00+08:00"
  target: ".xyz-harness/2026-05-22-pixyz-agent-1-windowsmaclinux-2-xyz-agentpi/{spec.md, plan.md, e2e-test-plan.md, test_cases_template.json}"
  summary: "第 5 轮计划评审，所有 MUST FIX 已修复（FR-1 架构矛盾 + loadPiConfig 守卫），无新 MUST FIX，低优先级问题维持，通过"

statistics:
  total_issues: 7
  must_fix: 0
  must_fix_resolved: 2
  low: 3
  info: 2

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md:FR-1"
    title: "FR-1 声明的 6 架构与 Constraints 的 3 架构矛盾"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 2
    severity: LOW
    location: "plan.md:Risk Notes 2/3"
    title: "pi binary 命名验证未作为显式前置 Task"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: LOW
    location: "plan.md:Task 1 Step 1"
    title: "XYZ_AGENT_PACKAGED env 值 undefined 的兼容风险"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: INFO
    location: "plan.md:Execution Groups BG1"
    title: "BG1 Subagent 配置中 Agent 列箭头符号含义不明确"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 5
    severity: MUST_FIX
    location: "plan.md:Task 4, spec.md:约束'不读~/.pi/'"
    title: "loadPiConfig() 在打包模式仍读取 ~/.pi/config.json，违反 spec 约束"
    status: resolved
    raised_in_round: 3
    resolved_in_round: 4
  - id: 6
    severity: LOW
    location: "plan.md:Task Dependency Table (BG1)"
    title: "Task 4 的依赖标注为 2（process-manager），实际只依赖 Task 1（XYZ_AGENT_PACKAGED env）"
    status: open
    raised_in_round: 5
    resolved_in_round: null
  - id: 7
    severity: INFO
    location: "plan.md:Risk Notes 4"
    title: "缺少 CLAUDE.md 更新 Task——submodule 初始化说明未纳入 Task 列表"
    status: open
    raised_in_round: 5
    resolved_in_round: null
---

# 计划评审 v5

## 评审记录
- 评审时间：2026-05-22 23:30
- 评审轮次：第 5 轮
- 评审对象：
  - `spec.md` — 已修复（FR-1 架构矛盾）
  - `plan.md` — 已修复（Task 4 loadPiConfig + readPiDefaultModel 双守卫）
  - `e2e-test-plan.md` — 未变更
  - `test_cases_template.json` — 未变更

---

## 1. 历史 MUST FIX 修复验证

### Issue 1: FR-1 架构矛盾（6 架构 vs 3 平台）— ✅ 仍保持修复状态

v1 发现 FR-1 写 "6 架构全覆盖" 而 Constraints 写 "3 平台"，已在 v2 验证修复。当前 spec.md 明确区分 "pi 提供 6 种 variant" 与 "xyz-agent 仅打包 3 种（darwin-arm64, windows-x64, linux-x64）"，并在「补充说明」章节完整解释了 CI 矩阵关系。**未回归。**

### Issue 5: loadPiConfig() 在打包模式仍读取 ~/.pi/config.json — ✅ 已修复

v3 发现 Task 4 仅修改了 `readPiDefaultModel()`，遗漏了 `loadPiConfig()`。当前 plan.md 的 Task 4 已扩展为 4 个 Step：

| Step | 函数 | 守卫逻辑 | 来源 |
|------|------|---------|------|
| Step 1 | `loadPiConfig()` | `if (process.env.XYZ_AGENT_PACKAGED === '1') return null` | `config-store.ts:37` |
| Step 2 | `readPiDefaultModel()` | `if (process.env.XYZ_AGENT_PACKAGED === '1') return null` | `config-store.ts:103` |
| Step 3 | 验证 | `npx tsc --noEmit` | — |
| Step 4 | Commit | — | — |

两个读 `~/.pi/` 的路径均已覆盖，spec 约束「不读 ~/.pi/」在打包模式下得到完整保证。**修复确认通过。**

---

## 2. 全新维度检查

### 2.1 Spec 完整性

| 维度 | 结论 |
|------|------|
| 目标明确 | ✅ "Bundle pi Bun binary + preinstalled extensions/skills into xyz-agent's packaged app" |
| 范围合理 | ✅ 9 条 FR 明确，Out of Scope 清晰（自动更新、自定义 extension 管理、settings.json 迁移等） |
| AC 可量化 | ✅ 7 条 AC 均有具体验证方式 |
| [待决议] 项 | ✅ 无 |

### 2.2 Plan 可行性

| 维度 | 结论 |
|------|------|
| 任务拆分粒度 | ✅ 7 个 Task，每个聚焦单一文件/概念，可由 subagent 独立完成 |
| 依赖关系正确性 | ⚠️ **Issue 6 (LOW)** — Task 4 "Depends on 2" 不准确（见下方详述） |
| 工作量估算 | ✅ 4 个 runtime 文件修改（BG1）+ 6 个构建文件（BG2），合理 |
| 遗漏 Task | ⚠️ **Issue 7 (INFO)** — 未包含 CLAUDE.md 更新 Task |

### 2.3 Spec-Plan 一致性

| FR | 对应 Task | 覆盖状态 |
|----|----------|---------|
| FR-1 (打包 binary) | Task 2, 5, 6, 7 | ✅ |
| FR-2 (打包 extension) | Task 5, 6, 7 | ✅ |
| FR-3 (打包 skill) | Task 5, 6, 7 | ✅ |
| FR-4 (运行时 binary 发现) | Task 1, 2 | ✅ |
| FR-5 (环境变量注入) | Task 1, 3 | ✅ |
| FR-6 (electron-builder 配置) | Task 5 | ✅ |
| FR-7 (Git submodule) | Task 5 | ✅ |
| FR-8 (CI 构建流程) | Task 7 | ✅ |
| FR-9 (本地构建脚本) | Task 6 | ✅ |

| AC | 对应实现机制 | 覆盖状态 |
|----|-------------|---------|
| AC-1 (pi 可启动) | Task 1 (注入 env) + Task 2 (binary 发现) | ✅ |
| AC-2 (extension 可用) | Task 3 (PI_CODING_AGENT_DIR) | ✅ |
| AC-3 (skill 可用) | Task 3 (PI_CODING_AGENT_DIR) | ✅ |
| AC-4 (三平台构建) | Task 7 (CI) | ✅ |
| AC-5 (开发模式不受影响) | Task 2 (保留原有 PATH 搜索逻辑) | ✅ |
| AC-6 (不与系统 pi 冲突) | Task 2 (打包模式严格隔离，抛异常而非 fallback) | ✅ |
| AC-7 (Provider 通过 UI 注入) | Task 3 (env) + Task 4 (跳过 ~/.pi/) | ✅ |

### 2.4 Execution Groups

| 维度 | BG1 (Runtime) | BG2 (Build + CI) |
|------|--------------|-----------------|
| 文件数 | 4 (0 create + 4 modify) ≤ 10 ✅ | 6 (3 create + 3 modify) ≤ 10 ✅ |
| 类型 | 后端 (TypeScript) ✅ | 后端 (Bash/YAML/配置) ✅ |
| 功能关联 | 全部围绕"runtime 发现 bundled pi + 注入正确 env" ✅ | 全部围绕"构建时准备 pi resources" ✅ |
| 跨组依赖 | 无（与 BG2 独立） ✅ | 无（与 BG1 独立） ✅ |
| 并行安全 | 修改 4 个不同文件，无冲突 ✅ | 修改 6 个不同文件/创建新文件 ✅ |
| Subagent 配置 | 含 Agent、Model、注入上下文、读写文件清单 ✅ | 含 Agent、Model、注入上下文、读写文件清单 ✅ |

---

## 3. 本轮新增 LOW/INFO 问题

### Issue 6 (LOW) — Task 4 的依赖标注不准确

**位置：** `plan.md:Task 4 依赖列`

**描述：** 依赖表标注 Task 4 "depends on 2"，但 Task 4（config-store 跳过 `~/.pi/` 读取）仅依赖 `process.env.XYZ_AGENT_PACKAGED`，该变量由 Task 1（runtime-manager）注入。Task 2 修改的是 `findPiExecutable()` 函数（binary 发现逻辑），与 config-store 的守卫无关。

**影响分析：** 如果 subagent 严格按依赖表串行执行，Task 4 会等待 Task 2 完成后才开始（而非仅等待 Task 1）。因 BG1 内所有 Task 通常由同一 subagent 串行执行（从 1→2→3→4），实际执行顺序不受影响。但如果未来有人将此依赖表作为并行调度的依据，可能会导致 Task 4 在 Task 1 完成后闲置等待 Task 2。

**修改建议：** 将 Task 4 的依赖从 "2" 改为 "1"（`process.env.XYZ_AGENT_PACKAGED` 由 Task 1 注入，Task 4 仅依赖该 env 的存在）。

---

### Issue 7 (INFO) — 缺少 CLAUDE.md 更新 Task

**位置：** `plan.md:Risk Notes 4`

**描述：** Risk Note 4 明确提到 "在 CLAUDE.md 中补充说明" submodule 初始化，但 Task 列表中没有包含更新 CLAUDE.md 的 Task。新增的 `.gitmodules` 声明、submodule 初始化命令、以及 `prepare-pi-resources.sh` 的使用说明，应在 CLAUDE.md 中记录以避免新贡献者遗漏。

**影响分析：** 对功能实现无影响。在 Phase 5（PR 阶段）之前补充即可，开发阶段可后续补充。

**修改建议：** 在 BG2 中增加一个 Step 或新建 Task 8："更新 CLAUDE.md，补充 submodule 初始化和 resources 准备步骤说明"。

---

## 4. 遗留 LOW/INFO 问题状态

以下为前几轮遗留的问题，本轮未修复，状态维持：

| # | 优先级 | 位置 | 描述 | 当前状态 |
|---|--------|------|------|---------|
| 2 | LOW | plan.md Risk Notes 2/3 | pi binary 命名验证未作为显式前置 Task（BG1 与 BG2 并行时，binary 命名假设不一致可能波及代码） | open |
| 3 | LOW | plan.md Task 1 Step 1 | `XYZ_AGENT_PACKAGED: app.isPackaged ? '1' : undefined` — `undefined` 作为 spawn env 值在不同 Node 版本上行为不一致 | open |
| 4 | INFO | plan.md BG1 Subagent 配置 | `general-purpose → general-purpose → general-purpose` 箭头不能清晰表达 subagent 分派模式 | open |
| 6 | LOW | plan.md Task 依赖表 | Task 4 "Depends on 2" 不准确，应改为 "Depends on 1" | **本轮新增** |
| 7 | INFO | plan.md Risk Notes 4 | 缺少 CLAUDE.md 更新 Task（submodule 初始化说明） | **本轮新增** |

---

## 5. E2E Test Plan & Test Cases 评审

### 5.1 AC 覆盖矩阵

| AC | 场景 | 覆盖状态 | 测试场景 | 测试用例 |
|----|------|---------|----------|---------|
| AC-1 | 打包后 pi 可启动 | ✅ | TS-1 | TC-1-01, TC-1-02 |
| AC-2 | 预装 Extension 可用 | ✅ | TS-2 | TC-3-01 |
| AC-3 | 预装 Skill 可用 | ✅ | TS-3 | TC-3-02 |
| AC-4 | 三平台构建通过 | ✅ | TS-4 | TC-4-01, TC-4-02, TC-4-03 |
| AC-5 | 开发模式不受影响 | ✅ | TS-5 | TC-5-01 |
| AC-6 | 不与系统 pi 冲突 | ✅ | TS-6 | TC-6-01 |
| AC-7 | Provider 配置通过 UI 注入 | ✅ | TS-7 | TC-7-01, TC-7-02 |

全部 7 条 AC 均有对应的 E2E 测试场景和具体测试用例。覆盖完整。

### 5.2 测试用例质量

| 维度 | 评价 |
|------|------|
| **结构清晰度** | ✅ 所有用例含 id/type/title/description/steps 五个字段，符合模板 |
| **步骤可操作性** | ✅ 步骤具体（设置 env、执行命令、检查输出） |
| **边界覆盖** | ✅ 含正常路径（binary 存在）和异常路径（binary 不存在 → 抛错）；dev 模式 vs 打包模式区分清晰 |
| **数据构造** | ✅ TC-7-02 显式验证 `readPiDefaultModel()` 在打包模式返回 null |

### 5.3 建议（非阻塞）

- TC-1-01 和 TC-7-02 标注为 manual，但实际上是单元测试级别的验证（mock env var + mock fs + 验证返回值）。建议在实施阶段作为自动化单元测试加入项目，加速回归验证。
- E2E test plan 所有场景均为 manual。对于 BG1 的 runtime 逻辑，可以考虑增加 mocked 单元测试覆盖 `findPiExecutable()` 和 `loadPiConfig()` / `readPiDefaultModel()` 的打包模式分支。

---

## 6. 架构约束合规性

对照项目 CLAUDE.md 的架构约定：

| 约束 | 合规状态 | 说明 |
|------|---------|------|
| Sidecar 通信: WebSocket | ✅ | plan 不涉及 WebSocket 变更 |
| 环境变量注入: 通过 spawn env | ✅ | Task 1, 3 均通过 spawnOptions.env 注入 |
| 外部系统先验证再编码 | ✅ | Risk Notes 明确要求先验证 pi binary 命名 |
| pi 适配层不信任外部格式 | ✅ | 不涉及 EventAdapter 变更 |
| Session 隔离 | ✅ | 不涉及 session 相关变更 |

---

## 7. 最终结论

**verdict: pass**（0 MUST FIX，无阻塞问题）

### 变更摘要

| 轮次 | 发现 MUST FIX | 本轮验证 | 累计待修复 |
|------|-------------|---------|-----------|
| v1 | 1（FR-1 架构矛盾） | — | 1 |
| v2 | —（验证修复） | ✅ | 0 |
| v3 | 1（loadPiConfig 遗漏） | — | 1 |
| v4 | —（验证修复） | ✅ | 0 |
| **v5** | **0（新增 LOW/INFO，无 MUST FIX）** | **✅ 全部前序修复保持** | **0** |

### 汇总统计

| 维度 | 统计 |
|------|------|
| 累计发现 MUST FIX | 2 条（Issue 1, Issue 5） |
| 已修复 MUST FIX | 2 条 |
| 遗留 LOW | 3 条（Issue 2, 3, 6） |
| 遗留 INFO | 2 条（Issue 4, 7） |
| 本轮新增 | 2 条（Issue 6 LOW, Issue 7 INFO） |

### 实施建议（非阻塞）

1. **Issue 6（LOW）— Task 4 依赖标注**：建议改 `depends on 2` 为 `depends on 1`，反映真实依赖关系。
2. **Issue 7（INFO）— CLAUDE.md 更新**：建议在 Phase 5（PR 阶段）前补充 submodule 初始化说明到 CLAUDE.md。
3. **Issue 3（LOW）— env undefined**：Task 1 实施时使用条件赋值形式避免跨 Node 版本兼容风险。
4. **TC 自动化潜力**：TC-1-01 和 TC-7-02 的验证逻辑适合作为自动化单元测试加入项目，减少 manual 测试依赖。

---

## Summary

计划评审完成，第5轮，0条MUST FIX，通过。
