---
verdict: fail
must_fix: 1
review:
  type: plan_review
  round: 3
  timestamp: "2026-05-22T23:00:00+08:00"
  target: ".xyz-harness/2026-05-22-pixyz-agent-1-windowsmaclinux-2-xyz-agentpi/{spec.md, plan.md, e2e-test-plan.md, test_cases_template.json}"
  summary: "计划评审完成，第3轮，1条MUST FIX（loadPiConfig未跳过~/.pi/config.json读取），需修改后重审"

statistics:
  total_issues: 6
  must_fix: 1
  must_fix_resolved: 1
  low: 3
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md:FR-1"
    title: "FR-1 声明的 6 架构与 Constraints 的 3 架构矛盾"
    status: resolved
    resolution: "FR-1 已修改为明确区分'pi 提供 6 种 variant'与'xyz-agent 仅打包 3 种（darwin-arm64, windows-x64, linux-x64）'，并在补充说明章节补充了 CI 构建矩阵与 pi binary 的关系。"
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
    location: "plan.md:Task 4, spec.md:约束'不读~/.pi/', src-electron/runtime/src/config-store.ts:37-49 (loadPiConfig)"
    title: "loadPiConfig() 在打包模式仍读取 ~/.pi/config.json，违反 spec 约束"
    status: open
    raised_in_round: 3
    resolved_in_round: null

---

# 计划评审 v3

## 评审记录
- 评审时间：2026-05-22 23:00
- 评审轮次：第 3 轮
- 评审对象：
  - `spec.md` — 已修复（FR-1架构矛盾）
  - `plan.md` — 未变更
  - `e2e-test-plan.md` — 未变更
  - `test_cases_template.json` — 已存在

---

## 1. MUST FIX 修复验证

### Issue 1: FR-1 架构矛盾 — ✅ 已修复（v2 通过）

v1 提出的 MUST FIX（FR-1 写"6 架构全覆盖"而 Constraints 写"仅 3 平台"的矛盾）已在 v2 验证通过。本轮确认 spec.md 保持修复后的状态，未回归。

---

## 2. 本轮新发现的问题

### Issue 5（MUST FIX）— loadPiConfig() 在打包模式仍读取 ~/.pi/config.json

#### 问题描述

**位置：** `src-electron/runtime/src/config-store.ts:37-49` (`loadPiConfig()` 函数)

Plan 的 Task 4 仅修改了 `readPiDefaultModel()`（跳过 `~/.pi/agent/models.json` 的读取），但 config-store.ts 中还有第二个读 `~/.pi/` 的路径：

```typescript
// config-store.ts:37-49
function loadPiConfig(): Record<string, ProviderConfig> | null {
  try {
    const piJsonPath = join(homedir(), '.pi', 'config.json')   // ← 读 ~/.pi/config.json
    if (existsSync(piJsonPath)) {
      const raw = readFileSync(piJsonPath, 'utf-8')
      const parsed = JSON.parse(raw)
      if (parsed.providers && typeof parsed.providers === 'object') {
        return parsed.providers as Record<string, ProviderConfig>
      }
    }
  } catch (e) { ... }
  return null
}
```

`loadPiConfig()` 被 `loadConfig()` 在 fallback 路径中调用（`config-store.ts:54-72`）：

```typescript
// Fallback: try pi config
const piProviders = loadPiConfig()
if (piProviders) {
  return { defaults: { ...DEFAULTS.defaults }, providers: piProviders }
}
```

#### 违反的约束

Spec 明确声明（Constraints 表格）：

> pi 配置隔离：不读 `~/.pi/`，所有配置通过 xyz-agent UI + 环境变量注入

**这是整个 spec 的核心约束之一。**

#### 触发条件

仅当 `~/.xyz-agent/config.json` 不存在（新用户首次启动，尚未在 Settings 中保存任何 provider 配置）时，`loadConfig()` 会 fallback 到 `loadPiConfig()`，读取 `~/.pi/config.json`。如果用户之前安装过系统 pi 并配置了 provider，这些配置会被无意识地注入到打包版 xyz-agent 中。

#### 影响分析

- **功能不可用**（在生产环境）：新用户首次启动打包版 xyz-agent，如果机器上存在 `~/.pi/config.json`，provider 配置会从系统 pi 继承而非空白开始，与 spec 设计意图「完全隔离」矛盾
- **数据语义错误**：系统 pi 的 provider 配置（可能包含已弃用的 API key 或不同 baseUrl）被错误地当作打包版提供者的配置使用
- **配置泄露**：用户可能在系统 pi 中配置了 xyz-agent 不应使用的 provider（如 Claude 的 API key 指向旧 baseUrl），打包版偷偷使用了这些配置

#### 修改建议

在 `loadPiConfig()` 函数的开头添加打包模式守卫：

```typescript
function loadPiConfig(): Record<string, ProviderConfig> | null {
  // Packaged mode: do not read ~/.pi/config.json (spec constraint "不读 ~/.pi/")
  if (process.env.XYZ_AGENT_PACKAGED === '1') return null

  try {
    const piJsonPath = join(homedir(), '.pi', 'config.json')
    // ... rest unchanged
  }
```

这应与 Task 4 中对 `readPiDefaultModel()` 的修改放在同一个 Task 中（或添加为 Task 4 的额外步骤），因为两者处理的是同一类问题（打包模式跳过 `~/.pi/` 读取）。

---

## 3. LOW/INFO 问题状态复查

以下为 v1/v2 遗留的低优先级问题，本轮未修复：

| # | 优先级 | 位置 | 描述 | 状态 |
|---|--------|------|------|------|
| 2 | LOW | plan.md Risk Notes 2/3 | pi binary 命名验证未作为显式前置 Task，BG1 与 BG2 并行时可能因命名假设不一致导致代码与构建不匹配 | 仍 open |
| 3 | LOW | plan.md Task 1 Step 1 | `XYZ_AGENT_PACKAGED: app.isPackaged ? '1' : undefined` — Node `undefined` 作为 spawn env 值在低版本上可能传递字符串"undefined"到子进程 | 仍 open |
| 4 | INFO | plan.md BG1 | `general-purpose → general-purpose → general-purpose` 箭头不能清晰表达是 1 个 subagent 串行执行还是 3 个独立 subagent 派发 | 仍 open |

---

## 4. E2E Test Plan & Test Cases 评审

### 4.1 AC 覆盖矩阵

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

### 4.2 测试用例质量评价

| 维度 | 评价 |
|------|------|
| **结构清晰度** | ✅ 所有测试用例含 id、type、title、description、steps 五个字段，结构完整 |
| **步骤可操作性** | ✅ 步骤描述具体（设置什么 env、执行什么命令、检查什么输出） |
| **边界覆盖** | ✅ TC-1-01 同时覆盖了正常路径（binary 存在）和异常路径（binary 不存在 → 抛错）；TC-1-02 覆盖 dev 模式 fallback |
| **区分打包/开发模式** | ✅ TC-1-02 显式测试 dev 模式；TC-3-01 检查打包模式不读 ~/.pi；分类清晰 |

### 4.3 建议（非阻塞）

- TC-1-01 和 TC-7-02 标注为 manual，但实际上是单元测试级别的验证（mock env var + 验证返回值）。可以考虑在实施阶段 add 到项目中作为自动化单元测试，加速回归验证。

---

## 5. 结论

**fail**。本轮发现 MUST FIX 1 条——`loadPiConfig()` 在打包模式仍读取 `~/.pi/config.json`，违反 spec 核心约束「不读 ~/.pi/」。需在 plan.md 的 Task 4 中补充该函数在打包模式下的守卫逻辑后才能通过。

### 汇总

| 维度 | 结果 |
|------|------|
| v1 MUST FIX 修复验证 | ✅ 1/1 已修复（Issue 1） |
| 本轮新增 MUST FIX | ❌ 1 条（Issue 5） |
| 遗留 LOW | 2 条（Issue 2, 3） |
| 遗留 INFO | 1 条（Issue 4） |

### 必须修复的问题

**Issue 5**: Task 4 遗漏了 `loadPiConfig()` 的打包模式守卫。需要在 `loadPiConfig()` 函数开头添加 `if (process.env.XYZ_AGENT_PACKAGED === '1') return null`，与已实现的 `readPiDefaultModel()` 修改一致。可以在 Task 4 中增加一个 Step 来完成。

---

## Summary

计划评审完成，第3轮，1条MUST FIX（loadPiConfig在打包模式仍读取~/.pi/config.json），需修改后重审。
