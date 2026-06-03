---
verdict: fail
must_fix: 2

review:
  type: spec_review
  round: 2
  timestamp: "2026-06-03T11:00:00"
  target: ".xyz-harness/2026-06-02-extension-user-install-and-settings/spec.md"
  summary: "Spec 评审 v2，v1 的 6 条 MUST FIX 中 5 条已解决，发现 2 条新 MUST FIX，需修改后重审"

statistics:
  total_issues: 12
  must_fix: 2
  must_fix_resolved: 5
  low: 4
  info: 1

issues:
  # === v1 issues ===
  - id: 1
    severity: MUST_FIX
    location: "spec.md:FR-5, D-4"
    title: "FR-5 ExtensionService 重构未解决现有双路径冲突"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 2
    severity: MUST_FIX
    location: "spec.md:FR-4"
    title: "FR-4 第 5 扫描源缺少优先级定义"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 3
    severity: LOW
    location: "spec.md:FR-8, D-1"
    title: "packages[] 条目格式未显式定义，D-1 兼容性声明未验证"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: MUST_FIX
    location: "spec.md:C-4"
    title: "isValidPiExtension 验证条件描述遗漏 pkg.pi 字段"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 5
    severity: MUST_FIX
    location: "spec.md:AC-6"
    title: "AC-6 回滚失败场景缺少降级策略"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 6
    severity: MUST_FIX
    location: "spec.md:FR-7"
    title: "ExtensionInfo.source 字段缺少类型定义"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 7
    severity: LOW
    location: "spec.md:FR-1, FR-2"
    title: "安装/卸载缺少并发控制方案"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 8
    severity: LOW
    location: "spec.md:AC-8"
    title: "'新会话生效'缺少具体机制描述"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 9
    severity: LOW
    location: "spec.md:FR-1"
    title: "npm install 网络依赖和长时间阻塞风险未评估"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 10
    severity: INFO
    location: "spec.md:D-4"
    title: "ExtensionResolver 同步 vs ExtensionService 异步的方法不匹配"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  # === v2 新增 issues ===
  - id: 11
    severity: MUST_FIX
    location: "spec.md:FR-6"
    title: "FR-6 WS 协议定义不完整，缺少 toggle 和 list/scan 消息"
    status: open
    raised_in_round: 2
    resolved_in_round: null
  - id: 12
    severity: MUST_FIX
    location: "spec.md:AC-5"
    title: "AC-5 built-in extension toggle 行为含'可能允许关闭'，语义模糊"
    status: open
    raised_in_round: 2
    resolved_in_round: null
---

# Spec 评审 v2

## 评审记录
- 评审时间：2026-06-03 11:00
- 评审类型：Spec 评审（模式一：计划评审 — 第 1 项 spec 完整性）
- 评审对象：`.xyz-harness/2026-06-02-extension-user-install-and-settings/spec.md`
- 评审轮次：第 2 轮（继承 v1 的 10 条 issues）
- 基于项目源码版本：`feat-integration-pi-extension` worktree

---

## v1 Issues 复查

### 已解决（5 条）

**#1 — FR-5 ExtensionService 重构未解决双路径冲突** → ✅ 已解决

spec 新增了完整的 `IExtensionService` 接口契约（`scanExtensions()`、`getExtensionPaths()`、`installExtension()`、`uninstallExtension()`、`toggleExtension()`），并明确描述了与 `session-service.ts` 的集成方式：`getExtensionPaths()` 路由到 `ExtensionResolver.resolve()` + settings packages[] 过滤禁用项。双路径合并问题已消除——新的 ExtensionService 统一了发现逻辑。

**#2 — FR-4 第 5 扫描源缺少优先级定义** → ✅ 已解决

spec 提供了完整的代码片段和 PRIORITY_ORDER 数组：`['npm', 'user', 'settings', 'third-party', 'bundled']`。settings 位于 user 和 third-party 之间，D-2 的优先级约束（settings < npm）得到满足。

**#4 — isValidPiExtension 遗漏 pkg.pi 字段** → ✅ 已解决

C-4 现在列出三个条件：`keywords` 含 `pi-package`、`peerDependencies` 含 `pi-coding-agent`/`pi-agent-core`、`package.json` 中有 `"pi"` manifest 字段。与源码 `extension-resolver.ts:210` 一致。

**#5 — AC-6 回滚失败无降级策略** → ✅ 已解决

AC-6 新增降级描述：npm uninstall 也失败时，记录 warning 日志，只从 settings.json packages[] 中移除条目，不清除磁盘文件，提示用户手动清理。

**#6 — ExtensionInfo.source 字段缺少类型定义** → ✅ 已解决

FR-7 明确写出 `source` 类型为 `'built-in' | 'user-installed'`，并定义了映射规则：ExtensionResolver 扫描结果中路径出现在 settings packages[] 的 → `user-installed`，其余 → `built-in`。

### 未解决（5 条，详见下方详细分析）

#3（降级为 LOW）、#7、#8、#9、#10

---

## Spec 完整性逐项检查

### 1. 目标是否明确

**通过。** 两段话可概括：支持用户安装第三方 pi extension + 重构 ExtensionService 统一状态管理。Background 章节清晰描述了现状痛点和期望目标。

### 2. 范围是否合理

**通过。** 边界明确：
- 安装源限定 npm（排除 git/本地路径）
- 一次一个（排除批量）
- 新 session 生效（排除热更新已有 session）
- 数据隔离在 `~/.xyz-agent/`（排除 `~/.pi/`）

范围不过大也不过小，与现有 ExtensionResolver 扩展能力匹配。

### 3. 验收标准是否可量化

**部分通过。** AC-1 到 AC-4、AC-6、AC-7、AC-8 均可写测试验证。但 **AC-5 存在语义模糊（MUST FIX #12）**。

### 4. [待决议] 项

AC-5 中的 "toggle **可能**允许关闭" 实质是一个未决议的决策点，但未标记为 `[待决议]`。

---

## 发现的详细问题

### MUST FIX

#### #11 — FR-6 WS 协议定义不完整（v2 新增）

**位置：** FR-6

**问题：** FR-6 仅列出 `extension.install` / `extension.uninstall` 两个 WS 消息类型。但对照 FR-3（启用/禁用）和 FR-5（`toggleExtension()` 接口），**toggle 操作没有对应的 WS 消息定义**。前端无法在无 WS 命令的情况下触发 toggle。

此外，前端 ExtensionsPane 需要在 Settings 页面加载时获取 extension 列表（`scanExtensions()` 的 WS 映射），spec 也没有定义这个消息（如 `extension.list` 或 `extension.scan`）。

完整的 WS 协议应至少包含：
- `extension.list` / `extension.scan` → 获取 extension 列表（对应 `scanExtensions()`）
- `extension.install` → 安装（已有）
- `extension.uninstall` → 卸载（已有）
- `extension.toggle` → 启用/禁用（**缺失**）

**修改方向：** 在 FR-6 中补充完整的 WS 消息列表，至少包含 toggle 和 list/scan。对于每条消息，说明请求参数和响应格式（或声明复用 `IExtensionService` 接口的参数签名）。

---

#### #12 — AC-5 built-in extension toggle 行为含"可能允许关闭"，语义模糊（v2 新增）

**位置：** AC-5

**问题：** AC-5 原文："@zhushanwen/pi-* 和 pi-subagents 在列表中显示 built-in 标注，toggle **可能**允许关闭但不可卸载。"

"可能允许关闭"是模糊表述，在 spec 中应做出明确决策。三种可能的行为对应不同的后端实现：

| 选项 | toggle 可操作？ | 后端影响 | disabled 状态存储 |
|------|---------------|---------|------------------|
| A: 可禁用 | 是，toggle 激活 | 需处理 built-in 的 disabled 状态 | 不在 settings.json packages[]（built-in 不在 packages[]），需另找位置 |
| B: 禁用不可操作 | toggle 灰显 | 无后端变更 | 无 |
| C: 不显示 toggle | 无 toggle 控件 | 无后端变更 | 无 |

选项 A 引入新的设计问题：built-in extension 不在 settings.json packages[] 中，disabled 状态存哪？需要额外的 `disabledBuiltIn[]` 字段或其他机制。这对 FR-5、FR-8 和 WS 协议都有影响。

"可能"不是 spec 语言。必须在 spec 中做出明确决策。

**修改方向：** 在 AC-5 中明确选择一种行为。如果是选项 A，需补充 disabled 状态的存储方案（哪个字段、在哪个文件中）；如果是选项 B 或 C，明确写出。

---

### LOW

#### #3 — packages[] 条目格式未显式定义，D-1 兼容性声明未验证（降级）

**位置：** FR-8、D-1

**问题（延续 v1，降级为 LOW）：** spec 描述了 packages[] 的语义（"定位 npm/ 目录下的实体"），但未显式说明条目格式是裸包名（`"pi-ask-user"`）、带版本（`"pi-ask-user@1.2.3"`）、还是含前缀（`"npm:pi-ask-user"`）。

D-1 声明 "与 pi 的 settings.json 一致，保持语义兼容"，但未验证 pi 是否确实有 packages[]/disabledPackages[] 字段及其格式。如果 pi 不使用这些字段，D-1 的声明是推测性的，应修改为 "xyz-agent 自定义字段"。

**降级理由：** 实现者可合理推断使用裸包名（npm install/uninstall 均使用裸包名，与 packages[] 对应），功能不受影响。但 D-1 的不准确声明可能在维护时误导开发者。

**修改方向：** 在 FR-8 中补充一条说明 packages[] 条目格式（如 "条目为 npm 包名，不含前缀和版本号"）。D-1 改为 "字段名参考 pi 的 settings.json 命名约定" 或直接声明为 xyz-agent 自定义。

---

#### #7 — 安装/卸载缺少并发控制方案（延续 v1）

**位置：** FR-1、FR-2

**问题：** 用户快速连续操作时，settings.json 的 read-modify-write 可能出现竞态。C-3 限制了一次一个操作（UI 层），但 sidecar WS handler 是 async 的，两个请求可能交错到达。如果 UI 在收到第一个请求响应前禁用了按钮（合理的 UX），则竞态风险极低。但 spec 未声明这一前提。

---

#### #8 — "新会话生效"缺少具体机制描述（延续 v1）

**位置：** AC-8

**问题：** "只影响新创建的 session" 的机制依赖 `createSession()` 每次调用 `getExtensionPaths()` 获取最新列表。当前代码已是这个模式。但 spec 未声明这个假设，也未说明前端是否需要提示用户"新会话生效"。

---

#### #9 — npm install 网络依赖和长时间阻塞风险未评估（延续 v1）

**位置：** FR-1

**问题：** npm install 是网络 + 子进程操作，弱网或大包时可能阻塞 sidecar WS 事件循环。spec 未定义超时策略或前端 loading 状态要求。

---

### INFO

#### #10 — ExtensionResolver 同步 vs ExtensionService 异步的方法不匹配（延续 v1）

**位置：** D-4

**问题：** ExtensionResolver 使用同步 fs 方法，ExtensionService 使用异步。重构时未声明统一策略。不影响功能，属于代码风格观察。

---

## 综合评估

### spec 质量提升

相比 v1，spec 在以下方面显著改善：
- **FR-5 接口契约明确化**：5 个方法签名、集成点描述、旧状态模型废弃策略，解决了最大的架构风险
- **FR-4 优先级定义完整**：代码片段 + PRIORITY_ORDER 数组，消除了解析歧义
- **C-4 验证条件完整**：三个条件与源码一致
- **AC-6 回滚降级**：定义了 uninstall 也失败的处理策略
- **FR-7 类型定义**：`'built-in' | 'user-installed'` union type + 映射规则

v1 的 6 条 MUST_FIX 中 5 条已解决，修复质量高。

### 剩余风险

1. **WS 协议缺口（#11）**：FR-6 是前后端协作的唯一接口定义层。缺失 toggle 和 list 消息意味着实现者需要自行推断 WS 协议，这通常导致前后端理解不一致。这不是"实现细节"——WS 消息是 sidecar 的公共 API，应在 spec 中定义。
2. **AC-5 决策悬而未决（#12）**：built-in extension 的 toggle 行为直接影响后端设计（是否需要新的 disabled 状态存储）和前端设计（toggle 是否可操作）。在 spec 阶段不做决策，会在实现阶段引发返工。

### 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | ~~MUST FIX~~ | spec.md:FR-5, D-4 | ~~双路径合并冲突~~ | ✅ v2 已解决 |
| 2 | ~~MUST FIX~~ | spec.md:FR-4 | ~~优先级定义缺失~~ | ✅ v2 已解决 |
| 3 | LOW | spec.md:FR-8, D-1 | packages[] 格式未显式定义，D-1 声明未验证 | 补充格式说明，修正 D-1 |
| 4 | ~~MUST FIX~~ | spec.md:C-4 | ~~验证条件遗漏~~ | ✅ v2 已解决 |
| 5 | ~~MUST FIX~~ | spec.md:AC-6 | ~~回滚降级缺失~~ | ✅ v2 已解决 |
| 6 | ~~MUST FIX~~ | spec.md:FR-7 | ~~source 类型缺失~~ | ✅ v2 已解决 |
| 7 | LOW | spec.md:FR-1, FR-2 | 并发控制未声明 | 声明 UI 禁用前提或加锁 |
| 8 | LOW | spec.md:AC-8 | 新会话生效机制未描述 | 声明 createSession 时的获取路径 |
| 9 | LOW | spec.md:FR-1 | npm install 阻塞风险 | 加超时/loading 说明 |
| 10 | INFO | spec.md:D-4 | 同步/异步不匹配 | 设计备忘 |
| **11** | **MUST FIX** | spec.md:FR-6 | WS 协议缺少 toggle 和 list/scan 消息 | 补充完整 WS 消息列表 |
| **12** | **MUST FIX** | spec.md:AC-5 | built-in toggle "可能允许关闭" 语义模糊 | 明确选择一种行为并补充存储方案 |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程
> - **LOW**：建议修复，但不阻塞
> - **INFO**：观察记录，无需操作

### 结论

需修改后重审。2 条 MUST FIX（#11 WS 协议完整性、#12 AC-5 决策明确化）需修复后方可通过。

<!-- MUST FIX 判定依据 -->
<!-- #11: WS 协议是前后端唯一接口定义层，缺失 toggle 和 list 消息导致前后端无法对齐 → 功能失效风险 -->
<!-- #12: AC-5 模糊决策直接影响后端存储设计和前端交互设计，实现时必然产生歧义 → 功能语义错误风险 -->

### Summary

Spec 评审 v2 完成，v1 的 6 条 MUST_FIX 中 5 条已解决，发现 2 条新 MUST_FIX，需修改后重审。
