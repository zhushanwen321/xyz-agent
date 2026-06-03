---
review:
  type: spec_review
  round: 4
  timestamp: "2026-06-03T01:10:00"
  target: ".xyz-harness/2026-06-02-extension-user-install-and-settings/spec.md"
  verdict: fail
  summary: "Spec 评审第4轮，1条 MUST FIX：xyz-agent-extension.js 文件型 extension 在新 ExtensionService 架构中无出处"

statistics:
  total_issues: 8
  must_fix: 1
  must_fix_resolved: 0
  low: 5
  info: 2

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md FR-5 + FR-7"
    title: "xyz-agent-extension.js 文件型 extension 在新 ExtensionService.getExtensionPaths() 中无出处"
    status: open
    raised_in_round: 4
    resolved_in_round: null
  - id: 2
    severity: LOW
    location: "spec.md FR-2"
    title: "卸载流程未提及清理 disabled-packages.json 残留条目"
    status: open
    raised_in_round: 4
    resolved_in_round: null
  - id: 3
    severity: LOW
    location: "spec.md FR-4"
    title: "push 顺序代码块注释误导，与实际优先级排序无关"
    status: open
    raised_in_round: 4
    resolved_in_round: null
  - id: 4
    severity: LOW
    location: "spec.md FR-5 / FR-8"
    title: "disabled-packages.json 过滤时机未明确（ExtensionResolver 层 vs ExtensionService 层）"
    status: open
    raised_in_round: 4
    resolved_in_round: null
  - id: 5
    severity: LOW
    location: "spec.md FR-3"
    title: "启用/禁用应显式限定为仅适用于 user-installed extension"
    status: open
    raised_in_round: 4
    resolved_in_round: null
  - id: 6
    severity: LOW
    location: "spec.md FR-8"
    title: "settings.json 并发写入风险（xyz-agent 与 pi 子进程同时 write）"
    status: open
    raised_in_round: 4
    resolved_in_round: null
  - id: 7
    severity: INFO
    location: "spec.md AC-4 / AC-5"
    title: "UI 状态描述不够精确（'明确显示'、'禁用/灰色状态'）"
    status: open
    raised_in_round: 4
    resolved_in_round: null
  - id: 8
    severity: INFO
    location: "spec.md D-1"
    title: "packages[] 只使用 string 形式，未说明是否忽略 pi 原生 object 形式"
    status: open
    raised_in_round: 4
    resolved_in_round: null
---

# Spec 评审 v4

## 评审记录
- 评审时间：2026-06-03 01:10
- 评审类型：Spec 评审（计划评审方法论 §1 spec 完整性检查）
- 评审对象：`.xyz-harness/2026-06-02-extension-user-install-and-settings/spec.md`
- 评审依据：SKILL.md 模式一「spec 完整性」维度 + CLAUDE.md 架构约束 + 现有源码交叉验证

---

## 1. spec 完整性检查

### 1.1 目标明确性 — ✅ 通过

> 用户在 xyz-agent 中安装/卸载/启用禁用第三方 pi extension，统一 ExtensionService 状态管理。

一段话能说清楚，不模糊。

### 1.2 范围合理性 — ✅ 通过

范围边界清晰：只做 npm 安装源（C-2），不做搜索/批量/版本管理/多源。8 个 FR 覆盖了完整的 CRUD 生命周期。不过大不过小。

### 1.3 验收标准可量化 — ⚠️ 基本通过

8 条 AC 大部分可量化（安装/卸载/启禁/列表刷新/新会话生效），但有两处措辞偏模糊：

- AC-4 "列表中的每行**明确显示** `built-in` 或 `user-installed`" —— "明确显示" 不可量化，需指定 UI 元素（标签/badge/文本）
- AC-5 "toggle 为**禁用/灰色状态**" —— 是 disabled attribute 还是视觉灰色？影响前端实现

→ 降级为 INFO（#7），不阻塞。

### 1.4 待决议项 — ✅ 无显式 `[待决议]`

4 条 Decisions（D-1 ~ D-4）均已做出明确选择。

---

## 2. 逐条 FR 交叉验证（对比现有源码）

以下审查对照 `extension-resolver.ts`、`extension-service.ts`、`session-service.ts`、`interfaces.ts`、`shared/src/protocol.ts` 和 pi 的 `settings-manager.ts` 进行。

### 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | **MUST FIX** | FR-5 + FR-7 | **xyz-agent-extension.js 在新架构中无出处** — FR-5 要求 `session-service` 不再直调 `ExtensionResolver`，只调 `ExtensionService.getExtensionPaths()`。当前 `session-service.getExtensionPaths()` 有特殊逻辑：检测 `xyz-agent-extension.js` 为**文件型** extension（非目录），直接 append 到 `ExtensionResolver` 结果末尾。新 `ExtensionService.getExtensionPaths()` 封装 `ExtensionResolver.resolve()` + 过滤禁用项，但 `ExtensionResolver` 不扫描文件型 extension，也不会在 `resolve()` 结果中包含它。若实现者严格按 spec 编码，`xyz-agent-extension.js` 会被遗漏，导致新 session 丢失该核心 extension。 | FR-5 的 `getExtensionPaths()` 实现说明中需补充：「对 `xyz-agent-extension.js` 文件型 extension，ExtensionService 在 ExtensionResolver 结果基础上追加该文件路径（逻辑从 session-service 迁移）。」 |
| 2 | LOW | FR-2 | **卸载未清理 disabled-packages.json** — `uninstallExtension` 描述为 "从 settings.json packages[] 移除 → npm uninstall → 刷新"。若被卸载的包恰好在 `disabled-packages.json` 的 `disabled[]` 中，卸载后该条目变成幽灵数据（包已不存在但条目残留）。 | FR-2 或 `uninstallExtension()` 步骤中追加：「同时从 disabled-packages.json disabled[] 中移除该包名」。 |
| 3 | LOW | FR-4 | **push 顺序代码块注释误导** — 代码块展示 `sources.push` 顺序并在每行标注 `// 最低` / `// 最高`，但 `deduplicate()` 按 `PRIORITY_ORDER` 索引重排序，push 顺序与最终优先级无关。实现者可能误以为需要按特定顺序 push。 | 删除代码块中的优先级注释（`// 最低` / `// 最高`），只保留 `PRIORITY_ORDER` 数组声明作为优先级的唯一权威来源。 |
| 4 | LOW | FR-5 / FR-8 | **disabled-packages.json 过滤时机未明确** — ExtensionResolver settings 源扫描 `packages[]` 时是否感知禁用状态？从 FR-5 注释推测是 ExtensionService 层过滤（Resolver 扫描全部，Service 读 disabled-packages.json 标记 enabled），但 spec 没有写明这个分层。 | 在 FR-5 的 `scanExtensions()` 和 `getExtensionPaths()` 实现说明中补充数据流：「ExtensionResolver 扫描所有 packages[] 条目（不过滤禁用）→ ExtensionService 读取 disabled-packages.json → scanExtensions 标记 enabled 字段 → getExtensionPaths 过滤 enabled=false」。 |
| 5 | LOW | FR-3 | **启用/禁用未限定适用范围** — FR-3 说 "已安装的 extension 可以切换启用/禁用"，措辞暗示所有 extension 都可禁用。但 AC-5 明确 built-in 不可禁用。两个地方语义不一致。 | FR-3 改为 "已安装的 **user-installed** extension 可以切换启用/禁用。built-in extension 不支持此操作。" |
| 6 | LOW | FR-8 | **settings.json 并发写入风险** — xyz-agent 写 `packages[]` 到 `settings.json`，而 pi 子进程的 `SettingsManager` 可能同时写其他字段（如模型切换时 `setPackages`/`setDefaultModel`）。两者都执行 read-modify-write 整个文件，极端时序下可能互相覆盖。实际风险极低（install/uninstall 低频操作，pi 在 xyz-agent 控制下运行），但应在 Constraints 中记录此已知限制。 | C-1 后追加 C-5：「ExtensionService 写入 settings.json 时，不持有文件锁。与运行中 pi 子进程的并发写入存在理论上的数据竞争风险。缓解措施：install/uninstall 操作为用户主动触发的低频操作，且 xyz-agent 拥有 pi 子进程的完整生命周期控制。若未来出现数据丢失问题，考虑改用独立文件 + 启动时合并策略。」 |
| 7 | INFO | AC-4 / AC-5 | UI 状态描述措辞模糊。"明确显示" 和 "禁用/灰色状态" 不可量化。建议改为可测试的描述，如 "每行包含一个 `<span>` 标签显示 'built-in' 或 'user-installed' 文字" 和 "built-in 行的 toggle 组件设置 `disabled` attribute"。 | — |
| 8 | INFO | D-1 | pi 的 `PackageSource` 类型支持 string 和 object 两种形式。D-1 说 "字符串 'npm:xxx'"，未说明如果 settings.json 中已有 object 形式的条目（用户通过 pi `/package` 命令添加），ExtensionResolver 的 settings 源如何处理。 | 建议在 FR-4 或 Constraints 中补充：「ExtensionResolver settings 源只处理 string 形式的 packages[] 条目，忽略 object 形式。」 |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程
> - **LOW**：建议修复，但不阻塞
> - **INFO**：观察记录，无需操作

---

## 3. spec 与 CLAUDE.md 架构约束一致性

| 约束 | 检查结果 |
|------|---------|
| 数据隔离（`~/.xyz-agent/` vs `~/.pi/`） | ✅ FR-8 + C-1 明确限定 `~/.xyz-agent/pi/agent/` 路径 |
| WS 命名约定（client→server 点号，server→client 冒号） | ✅ `extension.install` → `config.extensions` 符合约定 |
| session 隔离（所有消息带 sessionId） | ✅ AC-8 明确只影响新 session |
| emit 只传单个 payload 对象 | ✅ WS 协议中 payload 为对象 |
| ExtensionResolver 不信任外部格式 | ✅ C-4 isValidPiExtension 校验与现有逻辑一致 |
| pi 适配层唯一 | ⚠️ FR-5 正确收敛为单调用链，但 xyz-agent-extension.js 处理逻辑未迁移（见 #1） |

---

## 4. 数据流覆盖验证

### 安装流程
```
用户输入 "npm:pi-ask-user" → WS extension.install → server.ts 
→ ExtensionService.installExtension("npm:pi-ask-user")
  → npm install pi-ask-user --prefix ~/.xyz-agent/pi/agent/npm/
  → isValidPiExtension 校验 (C-4)
  → 写入 settings.json packages[] ("npm:pi-ask-user")
  → scanExtensions() 刷新
→ WS config.extensions 返回最新列表
```
✅ 完整，回滚路径在 AC-6 中描述充分。

### 卸载流程
```
用户点击卸载 → WS extension.uninstall → server.ts
→ ExtensionService.uninstallExtension("pi-ask-user")
  → 从 settings.json packages[] 移除
  → npm uninstall pi-ask-user --prefix ~/.xyz-agent/pi/agent/npm/
  → scanExtensions() 刷新
→ WS config.extensions 返回最新列表
```
⚠️ 缺少 disabled-packages.json 清理（见 #2）。

### 新 Session 启动
```
用户点击 New Chat → session-service.create()
→ ExtensionService.getExtensionPaths()
  → ExtensionResolver.resolve() (5 sources)
  → 过滤 enabled=false
→ pi --extension <paths>
```
⚠️ xyz-agent-extension.js 在此流程中丢失（见 #1）。

---

## 5. 结论

**需修改后重审。**

核心问题是 #1：spec 设计了 "session-service 只调 ExtensionService" 的单调用链架构，但遗漏了 `xyz-agent-extension.js` 这个文件型 extension 的处理。当前代码中它在 `session-service.getExtensionPaths()` 里有特殊逻辑（stat 文件 → append），新架构中这个逻辑没有迁移目的地。如果实现者严格按 spec 编码，`xyz-agent-extension.js` 会被遗漏。

其余 5 条 LOW 是完善性问题，不阻塞但建议采纳以提高 spec 的自包含性。

### Summary

Spec 评审完成，第4轮，1条 MUST FIX（xyz-agent-extension.js 架构遗漏），需修改后重审。
