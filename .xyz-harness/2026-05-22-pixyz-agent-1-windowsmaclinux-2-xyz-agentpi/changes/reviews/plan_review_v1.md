---
review:
  type: plan_review
  round: 1
  timestamp: "2026-05-22T22:15:00+08:00"
  target: ".xyz-harness/2026-05-22-pixyz-agent-1-windowsmaclinux-2-xyz-agentpi/{spec.md, plan.md, e2e-test-plan.md}"
  verdict: fail
  summary: "计划评审完成，第1轮，1条MUST FIX，需修改后重审"

statistics:
  total_issues: 4
  must_fix: 1
  must_fix_resolved: 0
  low: 2
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md:FR-1"
    title: "FR-1 声明的 6 架构与 Constraints 的 3 架构矛盾"
    status: open
    raised_in_round: 1
    resolved_in_round: null
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
---

# 计划评审 v1

## 评审记录
- 评审时间：2026-05-22 22:15
- 评审类型：计划评审
- 评审对象：
  - `.xyz-harness/2026-05-22-pixyz-agent-1-windowsmaclinux-2-xyz-agentpi/spec.md`
  - `.xyz-harness/2026-05-22-pixyz-agent-1-windowsmaclinux-2-xyz-agentpi/plan.md`
  - `.xyz-harness/2026-05-22-pixyz-agent-1-windowsmaclinux-2-xyz-agentpi/e2e-test-plan.md`

---

## 1. Spec 完整性

### 1.1 目标明确度 ✅
目标明确："Bundle pi Bun binary + preinstalled extensions/skills into xyz-agent's packaged app, replacing the external pi dependency with a self-contained binary。" 一句话清楚说明了要做什么。

### 1.2 范围合理性 ✅
- 9 条 Functional Requirements（FR-1 ~ FR-9），边界清晰
- 7 条 Acceptance Criteria（AC-1 ~ AC-7），每条都有验证方式
- 显式声明了 Out of Scope（自动更新、自定义 extension 管理、settings.json 迁移等）
- Constraints 表格定义了具体的技术约束

### 1.3 验收标准可量化 ✅
每条 AC 都有具体的"验证方式"描述，可操作：
- AC-1：启动打包应用 → 发消息 → 确认回复
- AC-2：发送 `/subagent` → 确认 extension 加载
- AC-3：触发 xyz-harness skill → 确认正常响应
- AC-4 ~ AC-7 同理

### 1.4 [待决议] 项检查 ✅
无 `[待决议]` 标记项。

---

## 2. Plan 可行性

### 2.1 任务拆分合理性 ✅
7 个 Task，分 2 个 Execution Group：
- **BG1** (4 tasks)：runtime 代码修改——process-manager 发现逻辑、rpc-client env 注入、runtime-manager env 注入、config-store 跳过
- **BG2** (3 tasks)：构建配置——submodule + electron-builder、本地构建脚本、CI 流程修改
- 每个 Task 聚焦单个文件/概念，粒度适中，可由 subagent 独立完成

### 2.2 依赖关系正确性 ✅
- BG1 内部：Task 1（runtime-manager 注入 env）→ Task 2（process-manager 读 env 发现 binary）→ Task 3（rpc-client 注入 PI_CODING_AGENT_DIR）→ Task 4（config-store 跳转）→ 顺序正确
- BG1 与 BG2 无依赖，可并行 ✅
- Wave 编排：Wave 1 (BG1 + BG2 并行) → Wave 2 (集成测试) → 正确

### 2.3 工作量估算 ✅
- 4 个 runtime 文件修改，含详细伪代码和变量名——合理
- CI + 构建脚本 + submodule 配置——合理
- 每个 Task 内含 `验证` 和 `Commit` 步骤——好习惯

### 2.4 对照 Spec 的覆盖率 ✅

| FR | 对应 Task | 覆盖 |
|----|----------|------|
| FR-1 (打包 binary) | Task 2, 5, 6, 7 | ✅ |
| FR-2 (打包 extension) | Task 5, 6, 7 | ✅ |
| FR-3 (打包 skill) | Task 5, 6, 7 | ✅ |
| FR-4 (运行时 binary 发现) | Task 1, 2 | ✅ |
| FR-5 (环境变量注入) | Task 1, 3 | ✅ |
| FR-6 (electron-builder 配置) | Task 5 | ✅ |
| FR-7 (Git submodule) | Task 5 | ✅ |
| FR-8 (CI 构建流程) | Task 7 | ✅ |
| FR-9 (本地构建脚本) | Task 6 | ✅ |

| AC | 对应机制 | 覆盖 |
|----|---------|------|
| AC-1 (pi 可启动) | Task 2 binary 发现 | ✅ |
| AC-2 (extension 可用) | Task 3 PI_CODING_AGENT_DIR | ✅ |
| AC-3 (skill 可用) | Task 3 PI_CODING_AGENT_DIR | ✅ |
| AC-4 (三平台构建) | Task 7 CI | ✅ |
| AC-5 (开发模式不受影响) | Task 2 保留原有逻辑 | ⚠️ 隐式覆盖 |
| AC-6 (不与系统 pi 冲突) | Task 2 打包模式隔离 | ✅ |
| AC-7 (Provider 通过 UI 注入) | Task 3 env + Task 4 跳过 ~/.pi | ✅ |

---

## 3. Spec 与 Plan 一致性

### 3.1 Plan 覆盖所有 Spec 需求项 ✅
所有 FR 都有对应 Task，所有 AC 都有对应实现机制。

### 3.2 Plan 无 Spec 未提及的额外工作 ✅
Plan 严格遵循 Spec 定义的范围，未引入不必要的功能。

### 3.3 AC 映射到 Task 实现步骤 ✅
每个 AC 都能找到对应的 Task 和代码变更。

---

## 4. Execution Groups 合理性

### 4.1 分组合理性 ✅
- **BG1**：4 个文件（4 modify），均属 runtime 层，关联紧密
- **BG2**：6 个文件（3 create + 3 modify），均属构建配置，关联紧密
- 两组文件数均 ≤ 10，无需拆分

### 4.2 类型划分 ✅
两组均为后端配置/Bash/TypeScript 类型，无混合类型问题。

### 4.3 功能关联度 ✅
同组 Task 功能关联度高：
- BG1 全部围绕"runtime 发现 bundled pi 并注入正确 env"
- BG2 全部围绕"构建时准备 pi resources"

### 4.4 依赖关系 ✅
BG1 和 BG2 无跨组依赖，可安全并行执行。

### 4.5 Wave 编排 ✅
- Wave 1：BG1 + BG2 并行 — 无文件冲突
- Wave 2：集成测试依赖两组完成 — 正确

### 4.6 Subagent 配置完整性 ✅
两组均有详细的 Subagent 配置表，含 Agent、Model、注入上下文、读取文件、修改/创建文件。

### 4.7 文件数预估合理性 ✅
- BG1：4 文件（0 create + 4 modify），合理
- BG2：6 文件（3 create + 3 modify），合理

---

## 5. E2E Test Plan 评审

### 5.1 AC 覆盖矩阵

| AC | 场景 | 覆盖状态 | 测试场景 |
|----|------|---------|----------|
| AC-1 | 打包后 pi 可启动 | ✅ | TS-1 |
| AC-2 | 预装 Extension 可用 | ✅ | TS-2 |
| AC-3 | 预装 Skill 可用 | ✅ | TS-3 |
| AC-4 | 三平台构建通过 | ✅ | TS-4 |
| AC-5 | 开发模式不受影响 | ✅ | TS-5 |
| AC-6 | 不与系统 pi 冲突 | ✅ | TS-6 |
| AC-7 | Provider 配置通过 UI 注入 | ✅ | TS-7 |

覆盖完整，7 条 AC 均有对应测试场景。

### 5.2 局限性
- 7 个场景全为 Manual 测试。对于 runtime 层的核心逻辑（binary 发现、env 注入），可以考虑增加单元测试（mocked env + mocked fs）以加速开发阶段的回归验证。
- TS-5（开发模式不受影响）验证方式比较薄弱——只验证了"不报错"，没有验证 dev 模式下 path 搜索优先级、fallback 行为等是否与改动前一致。

---

## 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | **MUST FIX** | spec.md:FR-1 | **FR-1 与 Constraints 矛盾**。FR-1 写"3 平台 6 架构全覆盖：darwin-arm64, darwin-x64, linux-arm64, linux-x64, windows-arm64, windows-x64"，但 Constraints 节"支持平台"明确写"macOS arm64, Windows x64, Linux x64（与当前 electron-builder 配置一致）"，Out of Scope 写"Windows arm64（当前 electron-builder 仅配置 x64）"。读者无法判断 CI 应该下载 6 个 binary 还是 3 个。 | 统一为 3 平台 3 架构：macOS arm64, Windows x64, Linux x64。将"6 架构"列为"pi 支持的完整变体（预留）"，与"当前构建目标"分开。FR-1 应该写实际构建目标。 |
| 2 | LOW | plan.md:Risk Notes 2/3 (p.14) | **pi binary 命名验证未作为显式前置 Task**。Risk Notes 正确指出了 Windows `.exe` 后缀和 binary 实际文件名的不确定性，并说明 Task 5 的执行 subagent"应先运行验证"。但 BG1 (binary 发现逻辑) 与 BG2 (验证) 在 Wave 1 并行执行，如果 binary 命名假设有误，BG1 的代码会被波及。 | 新增一个 Task 0（独立于 BG1/BG2）："验证 pi binary 命名约定"，在所有 Task 之前执行，输出确定性的 binary 文件名映射表。或至少在 BG1 的注入上下文中添加"需要先验证 binary 文件名"的显式指示。 |
| 3 | LOW | plan.md:Task 1 Step 1 (p.6) | **XYZ_AGENT_PACKAGED env 值 undefined 的兼容风险**。代码用 `undefined` 作为 env 值：`XYZ_AGENT_PACKAGED: app.isPackaged ? '1' : undefined`。Node.js `child_process.spawn` 环境变量为 `undefined` 在不同 Node 版本上行为不一致（低版本可能传递字符串"undefined"到子进程）。 | 使用条件性赋值：`...(app.isPackaged ? { XYZ_AGENT_PACKAGED: '1' } : {})` 或 `Object.assign(env, app.isPackaged ? { XYZ_AGENT_PACKAGED: '1' } : {})` |
| 4 | INFO | plan.md:Execution Groups BG1 | **BG1 Subagent 配置中 Agent 列符号不明确**。"general-purpose → general-purpose → general-purpose" 含义不清晰——是 3 个独立 subagent 串行、还是同一个 subagent 执行所有 task？ | 明确每个 Task 对应的 subagent 分配或说明是同一 subagent 串行执行。 |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程。
> - **LOW**：建议修复，但不阻塞。
> - **INFO**：观察记录，无需操作。

---

## 结论

**需修改后重审**。1 条 MUST FIX（spec 中 FR-1 与实际构建范围矛盾）必须在实施前解决。2 条 LOW 建议修复以降低实施风险。

### 必须修复的问题概述

**Issue 1 — Spec FR-1 vs Constraints 矛盾**：这是 spec 级问题，直接影响实现者的决策。若不修复，CI 实现者可能按 6 架构全部下载（浪费带宽/时间），或 process-manager 的 binary 命名逻辑与 CI 下载范围不一致。需要将 FR-1 明确化为实际构建目标的 3 架构，并在 spec 中明确"pi 支持的完整变体"与"当前构建目标"的关系。

---

## Summary

计划评审完成，第1轮，1条MUST FIX，需修改后重审。
