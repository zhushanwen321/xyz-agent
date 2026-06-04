---
review:
  type: spec_review
  round: 1
  timestamp: "2026-06-03T01:30:00"
  target: ".xyz-harness/2026-06-02-extension-user-install-and-settings/spec.md"
  verdict: fail
  summary: "Spec 评审完成，第1轮，6条 MUST FIX，需修改后重审"

statistics:
  total_issues: 10
  must_fix: 6
  must_fix_resolved: 0
  low: 3
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md:FR-5, D-4"
    title: "FR-5 ExtensionService 重构未解决现有双路径冲突"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: MUST_FIX
    location: "spec.md:FR-4"
    title: "FR-4 第 5 扫描源缺少优先级定义"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: MUST_FIX
    location: "spec.md:FR-8, D-1"
    title: "packages[] 包名 vs 路径语义与 pi 格式不一致"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: MUST_FIX
    location: "spec.md:C-4"
    title: "isValidPiExtension 验证条件描述遗漏 pkg.pi 字段"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 5
    severity: MUST_FIX
    location: "spec.md:AC-6"
    title: "AC-6 回滚失败场景缺少降级策略"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 6
    severity: MUST_FIX
    location: "spec.md:FR-7"
    title: "ExtensionInfo.source 字段缺少类型定义"
    status: open
    raised_in_round: 1
    resolved_in_round: null
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

---

# Spec 评审 v1

## 评审记录
- 评审时间：2026-06-03 01:30
- 评审类型：Spec 评审（模式一：计划评审 — 第 1 项 spec 完整性）
- 评审对象：`.xyz-harness/2026-06-02-extension-user-install-and-settings/spec.md`
- 基于项目源码版本：`feat-integration-pi-extension` worktree

---

## 1. 目标明确性

**通过。** 目标清晰可辨：支持用户自行安装第三方 pi extension + 重构 ExtensionService 统一状态管理。一句话能说清楚，前后一致。

---

## 2. 范围合理性

**通过，但存在范围漏项（见 MUST FIX #1）。** 边界明确：排除批量安装/卸载、排除 git/本地路径安装。但 FR-5 的"重构"范围缺少对已有消费者（`session-service.ts` 中双路径合并逻辑）的影响分析。

---

## 3. 验收标准可量化性

**基本通过，但有漏洞（见 MUST FIX #5, #6; LOW #8）。** AC-1 到 AC-8 整体可测试，描述了从 UI 操作到后端执行再到列表刷新的完整链路。但：
- AC-6 缺少回滚失败的降级定义
- AC-8 "新会话生效"缺少判断依据（如何检测新会话？需重启 runtime 吗？）
- AC-3 的 `disabledPackages[]` 更新→"列表刷新"步骤需要确认：刷新后 toggle 前的 enabled/disabled 状态是否能正确对应？

---

## 4. [待决议] 项

**无。** 未发现 `[待决议]` 标记。风险评估为低。

---

## 发现的详细问题

### MUST FIX

#### #1 — FR-5 ExtensionService 重构未解决现有双路径冲突（严重度：高）

**位置：** FR-5、D-4

**问题：** 当前 `session-service.ts` 在 `createSession()`（L133-135）和 `switchSession()`（L491-493）中**同时使用两个独立的路径源**：

```typescript
// session-service.ts:133-135
const bundleExtPaths = this.getExtensionPaths()              // → ExtensionResolver（四源扫描）
const userExtPaths = await this.extensionService.getExtensionPaths()  // → ExtensionService（旧状态模型）
const allExtPaths = [...bundleExtPaths, ...userExtPaths]
```

FR-5 和 D-4 说要废弃旧的 `ExtensionService`，让新的使用 `ExtensionResolver` 做发现。但 spec 没有描述以下关键点：

1. **新的 `IExtensionService` 接口契约**：`scanExtensions()`、`getEnabledExtensions()`、`toggleExtension()`、`getExtensionPaths()` 四个方法中，哪些保留、哪些废弃、哪些新增？
2. **`session-service.ts` 的双路径合并**：重构后是否只保留一个路径源（新的 ExtensionService）？还是仍然需要两个合并？
3. **D-4 中"新的 ExtensionService 使用 ExtensionResolver"** 是组合（Composition）还是继承？ExtensionService 是直接暴露 ExtensionResolver 的结果，还是做额外处理？

**修改方向：**
- 明确写出新的 `IExtensionService` 接口方法签名
- 描述 `session-service.ts` 中双路径合并的去留决策
- 补充架构图或伪代码展示 ExtensionService ↔ ExtensionResolver 的关系

---

#### #2 — FR-4 第 5 扫描源缺少优先级定义（严重度：高）

**位置：** FR-4

**问题：** `ExtensionResolver` 现有四个源及其优先级顺序（`extension-resolver.ts:23`）：

| 源 | 优先级（数值越小越高） |
|----|----------------------|
| npm | 0（最高） |
| user | 1 |
| third-party | 2 |
| bundled | 3（最低） |

去重逻辑是 `deduplicate()`（L168）按优先级 first-write-wins，高优先级覆盖低优先级。FR-4 要新增"settings 扫描源"，但**没有定义其在优先级顺序中的位置**。

D-2 说 "settings（用户安装）< npm（built-in）"，但用户安装的包在 settings 中配置，它应该比哪个源高/低？如果放在 npm 下面，用户安装的包可能被同名的 built-in 包覆盖（用户无法覆盖）。如果放在 third-party/bundled 下面，用户包会被这些源覆盖。

**修改方向：**
- 明确 settings 源在 `PRIORITY_ORDER` 中的位置
- 考虑用户预期：用户安装的 extension 应有最高或较高优先级

---

#### #3 — packages[] 包名 vs 路径语义与 pi 格式不一致（严重度：高）

**位置：** FR-8、D-1

**问题：** D-1 声明 "`packages[]` 和 `disabledPackages[]` 字段名与 pi 的 `settings.json` 一致，保持语义兼容"。但 spec 描述中：

- FR-8：`packages[]` 存的是 **npm 包名**（如 `"pi-ask-user"`）
- 实际 pi 的 `settings.json` **没有** `packages[]` 和 `disabledPackages[]` 字段（当前 `~/.xyz-agent/pi/agent/settings.json` 只有 `skills`、`defaultProvider`、`defaultModel`、`defaultThinkingLevel`）

如果未来 pi 官方引入 `packages[]` 且使用完整路径格式，xyz-agent 的包名格式与 pi 的路径格式不兼容。或者反过来——如果 pi 后续版本也使用包名格式，则无问题。但 spec 的断言 "与 pi 格式一致" 实际是推测，没有验证。

**修改方向：**
- 补充对 pi 源码的验证结果（确认 pi 的 settings.json 是否已有 `packages[]`/`disabledPackages[]` 字段及其格式）
- 或者在 xyz-agent 中明确声明这是一个**新定义的**字段，不与 pi 兼容（修改 D-1）

---

#### #4 — isValidPiExtension 验证条件描述遗漏 pkg.pi 字段（严重度：中）

**位置：** C-4

**问题：** C-4 描述验证条件为：
> `keywords` 含 `pi-package` 或 `peerDependencies` 含 `pi-coding-agent`/`pi-agent-core`

但实际代码 `isValidPiExtension()`（`extension-resolver.ts:210`）还有第三个条件：
```typescript
// pi manifest 字段
if (pkg.pi) return true
```

C-4 的描述缺少这个条件，可能导致实现者只按 spec 实现（遗漏 `pkg.pi`），与现有验证逻辑不一致。

**修改方向：**
- 在 C-4 中补充 "或 `package.json` 中存在 `pi` manifest 字段"

---

#### #5 — AC-6 回滚失败场景缺少降级策略（严重度：中）

**位置：** AC-6

**问题：** AC-6 定义了回滚策略：npm install 成功但 isValidPiExtension 失败 → npm uninstall + 提示错误。但**没有考虑 npm uninstall 也失败的场景**（网络、文件权限、磁盘满等情况）。此时磁盘残留无效包，settings.json 中 packages[] 已写入但包不可用，处于不一致状态。

**修改方向：**
- 定义 npm uninstall 失败的降级行为：写入一个 "orphaned" 标记以便后续清理？记录错误日志 + 提示用户手动清理？
- 考虑事务性写入：先验证再写 settings.json，或者使用临时状态标记

---

#### #6 — ExtensionInfo.source 字段缺少类型定义（严重度：中）

**位置：** FR-7

**问题：** FR-7 说 `ExtensionInfo` 增加 `source` 字段区分 `built-in` 和 `user-installed`。但：

1. 未定义字段类型：是 `'built-in' | 'user-installed'` 精确字符串 union？还是与 `ExtensionResolver` 的 `SourceName`（`'npm' | 'user' | 'third-party' | 'bundled'`）保持一致？
2. ExtensionResolver 内部有四源区分，而 ExtensionInfo 只暴露两态，映射关系未定义

**修改方向：**
- 在 spec 中明确写出 `source` 字段的类型定义（建议复用 `SourceName` 类型以避免另起一套）
- 或明确两态（built-in/user-installed）到四源（npm/third-party/bundled/settings）的映射规则

---

### LOW

#### #7 — 安装/卸载缺少并发控制方案

**位置：** FR-1、FR-2

**问题：** 用户可能快速连续点击安装/卸载多个包。sidecar 的 WS handler 是 async 串行处理，但 settings.json 文件写入（读取→修改→原子写入）在并发场景下可能出现 read-modify-write 竞态：两个 install 几乎同时读取旧状态的 settings.json，后一个写入覆盖前一个的变更。

**修改方向：**
- 考虑给 ExtensionService 增加队列/锁（进程内互斥）
- 或使用文件锁（虽然单进程内一般不需要）

---

#### #8 — "新会话生效"缺少具体机制描述

**位置：** AC-8

**问题：** AC-8 说 "安装/卸载/切换启用只影响新创建的 session。已有 session 不受影响"。但缺少：
1. 如何判断"新创建的 session"？是每次 `createSession()` 时重新调用 `getExtensionPaths()`（当前行为），还是需要额外检查？
2. 当前的 `extensionService.getExtensionPaths()` 在 session 创建时调用（L134, L492），已经在用最新的 state。如果新的 ExtensionService 使用 ExtensionResolver，这个机制是否变化？
3. 前端是否需要提示用户"重启会话以生效"？

**修改方向：**
- 明确新 session 如何获取更新后的 extension 列表
- 声明前端是否需要显示提示

---

#### #9 — npm install 网络依赖和长时间阻塞风险未评估

**位置：** FR-1

**问题：** npm install 是网络操作，大包或弱网环境下可能阻塞 sidecar 的 WS 事件循环数秒至数十秒（npm install 是同步子进程调用）。当前 spec 未评估这个风险。

**修改方向：**
- 考虑给 npm install 增加的 WS handler 设置超时
- 在前端显示安装进度/loading 状态
- 建议评估是否用子进程异步执行安装

---

### INFO

#### #10 — ExtensionResolver 同步 vs ExtensionService 异步的方法不匹配

**位置：** D-4

**问题：** `ExtensionResolver` 使用同步 fs 方法（`readFileSync`、`existsSync`、`statSync`、`readdirSync`）。`ExtensionService` 使用异步 fs 方法（`readFile`、`writeFile`、`mkdir`、`rename`）。如果新的 ExtensionService 封装 ExtensionResolver，两者风格不一致，应当在重构时统一。

**修改方向：**
- 建议新代码统一使用异步 fs（或保持同步但不影响，取决于调用上下文）。记录为设计备忘。

---

## 综合评估

**优点：**
- 目标清晰，边界明确，排除了大量非必要场景
- 8 条 AC 整体设计合理，可测试
- D-2（优先级规则）和 D-3（安装回滚）体现了良好的设计判断
- 数据路径隔离正确（`~/.xyz-agent/` 而非 `~/.pi/`）

**主要风险：**
1. **最大的架构风险（#1）**：FR-5 的 ExtensionService 重构会打破现有 `session-service.ts` 的双路径合并机制，但 spec 未描述新接口契约和集成方案。这是推倒重建而非增量重构，需要细致的接口设计。
2. **类型定义的缺失（#3, #6）**：packages[] 语义和 source 字段类型未精确定义，可能导致实现阶段才暴露问题。
3. **降级路径（#5）**：回滚的回滚没有定义，属于典型的"error handler of error handler"遗漏。

**结论：** 需修改后重审。6 条 MUST FIX 中，#1 和 #2 涉及架构决策，#3 和 #6 涉及类型定义，#4 和 #5 涉及细节遗漏。建议优先处理 #1（决策核心）和 #3（类型兼容性）。

### 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST FIX | spec.md:FR-5, D-4 | FR-5 重构未解决 session-service.ts 双路径合并冲突 | 明确新 IExtensionService 接口，描述 session-service.ts 集成点 |
| 2 | MUST FIX | spec.md:FR-4 | 第 5 扫描源缺少优先级定义 | 指定 settings 源在 PRIORITY_ORDER 中的位置 |
| 3 | MUST FIX | spec.md:FR-8, D-1 | packages[] 包名 vs 路径语义与 pi 格式不一致 | 验证 pi 格式或修改 D-1 声明 |
| 4 | MUST FIX | spec.md:C-4 | isValidPiExtension 遗漏 pkg.pi 字段 | 补充 "或 pi manifest 字段" |
| 5 | MUST FIX | spec.md:AC-6 | 回滚失败无降级策略 | 定义 npm uninstall 也失败时的行为 |
| 6 | MUST FIX | spec.md:FR-7 | source 字段缺少类型定义 | 明确类型定义和映射规则 |
| 7 | LOW | spec.md:FR-1, FR-2 | 安装/卸载缺少并发控制 | 加队列/锁或文档说明 |
| 8 | LOW | spec.md:AC-8 | "新会话生效"缺少机制 | 描述 session 创建时的获取路径 |
| 9 | LOW | spec.md:FR-1 | npm install 网络风险未评估 | 加超时、前端 loading |
| 10 | INFO | spec.md:D-4 | ExtensionResolver 同步 vs 异步不匹配 | 统一风格的设计备忘 |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过。涉及功能失效、数据一致性、类型兼容性
> - **LOW**：建议修复，但不阻塞。涉及并发控制、网络风险、提示信息
> - **INFO**：观察记录，无需操作

---

### 结论

需修改后重审。6 条 MUST FIX 需全部修复后方可通过。

<!-- 判断口诀：如果该问题在生产环境会导致功能不可用或数据错误，就必须标 MUST FIX。 -->
<!-- #1 导致 session 创建时 extension 列表不完整（数据丢失） → MUST FIX -->
<!-- #2 导致用户安装的包可能被系统包静默覆盖（功能失效） → MUST FIX -->
<!-- #3 导致 settings.json 格式与未来 pi 版本不兼容（数据语义错误） → MUST FIX -->
<!-- #4 导致实现者遗漏验证条件（功能失效） → MUST FIX -->
<!-- #5 导致磁盘残留和状态不一致（数据语义错误） → MUST FIX -->
<!-- #6 导致 source 字段在前后端间传递时类型不确定（数据语义错误） → MUST FIX -->

### Summary

Spec 评审完成，第1轮，6条 MUST FIX，需修改后重审。
