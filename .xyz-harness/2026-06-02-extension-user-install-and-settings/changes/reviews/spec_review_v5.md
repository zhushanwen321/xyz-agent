---
review:
  type: spec_review
  round: 5
  timestamp: "2026-06-03T12:30:00"
  target: ".xyz-harness/2026-06-02-extension-user-install-and-settings/spec.md"
  verdict: pass
  summary: "Spec 评审第5轮，0条 MUST FIX，v4 的 MUST FIX 已在 spec 中解决，剩余 LOW/INFO 建议采纳"

statistics:
  total_issues: 12
  must_fix: 0
  must_fix_resolved: 1
  low: 8
  info: 3

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md FR-5 + FR-7"
    title: "xyz-agent-extension.js 文件型 extension 在新 ExtensionService.getExtensionPaths() 中无出处"
    status: resolved
    raised_in_round: 4
    resolved_in_round: 5
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
    title: "push 顺序代码块注释误导，push 顺序与最终优先级无关"
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
  - id: 9
    severity: LOW
    location: "spec.md FR-6"
    title: "WS 协议未定义安装/卸载失败的错误响应格式"
    status: open
    raised_in_round: 5
    resolved_in_round: null
  - id: 10
    severity: LOW
    location: "spec.md FR-1"
    title: "npm 包名解析规则未明确（npm:xxx → xxx 前缀剥离）"
    status: open
    raised_in_round: 5
    resolved_in_round: null
  - id: 11
    severity: LOW
    location: "spec.md FR-5 IExtensionService"
    title: "installExtension 接口注释缺少 isValidPiExtension 校验步骤"
    status: open
    raised_in_round: 5
    resolved_in_round: null
  - id: 12
    severity: INFO
    location: "spec.md FR-6 / FR-7"
    title: "'source' 一词两层含义（安装源 'npm:xxx' vs 来源标识 'built-in'），可能误导"
    status: open
    raised_in_round: 5
    resolved_in_round: null
---

# Spec 评审 v5

## 评审记录
- 评审时间：2026-06-03 12:30
- 评审类型：Spec 评审（计划评审方法论 §1 spec 完整性检查）
- 评审对象：`.xyz-harness/2026-06-02-extension-user-install-and-settings/spec.md`
- 评审依据：SKILL.md 模式一「spec 完整性」维度 + CLAUDE.md 架构约束

---

## 1. spec 完整性检查

### 1.1 目标明确性 — ✅ 通过

> 让用户在 xyz-agent Settings → Extensions 页面安装/卸载/启用禁用第三方 pi extension，统一 ExtensionService 状态管理。

一段话可说清。Background 节交代了现状和缺口（built-in 通过 npm dependencies 管理，但无用户安装能力），不模糊。

### 1.2 范围合理性 — ✅ 通过

边界清晰：只做 `npm:<pkg>` 安装源（C-2），不做搜索/批量/版本管理/多源（git/local/registry）。8 个 FR 覆盖完整 CRUD 生命周期 + WS 协议 + 数据隔离。不过大不过小。

### 1.3 验收标准可量化 — ✅ 基本通过

8 条 AC 大部分可写测试验证。两处措辞偏模糊（AC-4 "明确显示"、AC-5 "禁用/灰色状态"），但不影响核心逻辑正确性，记为 INFO（#7）。

### 1.4 待决议项 — ✅ 无

4 条 Decisions（D-1 ~ D-4）均已做出明确选择，无 `[待决议]` 项。

---

## 2. 逐条 FR 审查

### FR-1 用户安装 ✅

安装目录初始化（`~/.xyz-agent/pi/agent/npm/`）、安装命令、`package.json` 自动创建逻辑清晰。

**发现问题 #10**：用户输入 `npm:pi-ask-user`（FR-1 + C-2），但安装命令写 `npm install <name>`。如果 `<name>` 直接传入 `npm:pi-ask-user`，npm 会报错（不是合法包名）。spec 需明确：installExtension 需剥离 `npm:` 前缀后传给 npm install。当前实现者需自行推导这一转换，应在接口注释中显式说明。

### FR-2 卸载 ⚠️

流程描述清晰。但与 FR-3/FR-8 的交互有遗漏。

**发现问题 #2（继承 v4）**：卸载只说"从 settings.json packages[] 移除 → npm uninstall"，未提及清理 `disabled-packages.json`。如果被卸载的包恰好被禁用过，`disabled[]` 中会残留幽灵条目。

### FR-3 启用/禁用 ⚠️

**发现问题 #5（继承 v4）**：FR-3 说"已安装的 extension 可以切换启用/禁用"，措辞暗示所有 extension 都可禁用。但 AC-5 明确 built-in 不可禁用。两处语义不一致。FR-3 应限定为 user-installed。

### FR-4 ExtensionResolver settings 扫描源 ✅（含注意项）

`PRIORITY_ORDER` 新增 `settings` 的位置（third-party 与 user 之间）明确合理——用户安装的包不应覆盖 built-in（npm 源），也不应被 bundled 覆盖。

**发现问题 #3（继承 v4）**：代码块中 `// 最低` / `// 最高` 注释暗示 push 顺序决定优先级。但 `deduplicate()` 按 `PRIORITY_ORDER` 索引重排序，push 顺序与最终结果无关。建议删除这些注释，只保留 PRIORITY_ORDER 数组作为唯一权威来源。

### FR-5 ExtensionService 重写 ✅

**v4 MUST FIX 已解决**：spec 新增了 `xyz-agent-extension.js` 文件型 extension 的完整处理描述——ExtensionService 在 ExtensionResolver.resolve() 返回后追加文件型 extension 路径，检查文件存在性，不经过去重/过滤。逻辑与现有 session-service 代码一致，迁移路径清晰。

**发现问题 #4（继承 v4）**：`scanExtensions()` 注释说"对 settings 源的扩展读取 packages[] 判断启用状态"，但启用状态的来源是 `disabled-packages.json`，不是 `packages[]`。packages[] 只存储安装列表，enabled/disabled 判断发生在 ExtensionService 层而非 ExtensionResolver 层。spec 应明确分层：Resolver 扫描全部 packages[]（不过滤禁用）→ ExtensionService 读 disabled-packages.json → 标记 enabled 字段 / 过滤 getExtensionPaths。

**发现问题 #11**：`installExtension` 接口注释写"安装 npm 包 → 写入 settings.json packages[] → 刷新"，但完整流程应包含 `isValidPiExtension` 校验（C-4）和失败回滚（AC-6）。当前接口注释省略了校验步骤，实现者可能直接写入 packages[] 而跳过校验。

### FR-6 WS 协议 ⚠️

**发现问题 #9**：协议只定义了成功响应（返回 `config.extensions`），AC-6 要求"npm install 失败 → 返回错误消息提示"，但 WS 协议章节没有定义错误响应格式。spec 明确说"不需要额外结果类型——前端靠收到最新列表来确认操作完成"，这指的是成功场景。失败时列表不变，前端如何区分"操作失败"和"网络延迟"？实现者需要知道是用已有的 server.ts 错误机制（如标准 error 消息），还是为 extension 操作定义专用错误响应。

**发现问题 #12**：`extension.install` 的 payload 字段名 `source`（值如 `"npm:pi-ask-user"`）与 FR-7 的 ExtensionInfo.source 字段（值如 `"built-in"` / `"user-installed"`）同名但语义不同。前者是安装源标识，后者是来源类型。虽然不会导致运行时错误（不同层级），但会让代码阅读者混淆。建议 install payload 改用 `package` 或 `packageRef`。

### FR-7 ExtensionInfo 标识来源 ✅

判断逻辑清晰：Resolver 扫描结果中 source === 'settings' 的 → user-installed，其余 → built-in。映射规则简单无歧义。

### FR-8 Extension 安装信息隔离 ✅

数据路径隔离（`~/.xyz-agent/pi/agent/`）与 C-1 一致。`disabled-packages.json` 独立文件避免污染 pi 的 settings.json schema。

**发现问题 #6（继承 v4）**：settings.json 的并发写入风险。xyz-agent 写 packages[]，pi 子进程的 SettingsManager 可能同时写其他字段（如 defaultModel）。两者都执行 read-modify-write，极端时序下可能互相覆盖。实际风险极低（install/uninstall 低频，xyz-agent 控制 pi 生命周期），但应在 Constraints 中记录此已知限制。

---

## 3. CLAUDE.md 架构约束一致性

| 约束 | 检查结果 |
|------|---------|
| 数据隔离 `~/.xyz-agent/` vs `~/.pi/` | ✅ FR-8 + C-1 明确 `~/.xyz-agent/pi/agent/` |
| WS 命名约定 | ✅ `extension.install` 点号格式，`config.extensions` 冒号格式 |
| Session 隔离 | ✅ AC-8 只影响新 session |
| emit 单 payload 对象 | ✅ WS payload 均为对象 |
| pi 适配层唯一 | ✅ FR-5 收敛为 session-service → ExtensionService → ExtensionResolver 单链 |
| ExtensionResolver 不信任外部格式 | ✅ C-4 isValidPiExtension 校验 |

---

## 4. 数据流覆盖验证

### 安装流程
```
用户输入 "npm:pi-ask-user" → WS extension.install
→ ExtensionService.installExtension("npm:pi-ask-user")
  → 剥离 "npm:" 前缀 → "pi-ask-user"       ⚠️ (#10: 需显式说明)
  → npm install pi-ask-user --prefix ...
  → isValidPiExtension 校验 (C-4)           ⚠️ (#11: 接口注释遗漏此步)
  → 写入 settings.json packages[]
  → scanExtensions() 刷新
→ WS config.extensions 或错误               ⚠️ (#9: 错误格式未定义)
```
主路径完整，三处标注点为 spec 描述不够显式的地方。

### 卸载流程
```
WS extension.uninstall → ExtensionService.uninstallExtension("pi-ask-user")
  → 从 settings.json packages[] 移除
  → npm uninstall pi-ask-user               ⚠️ (#2: 未清理 disabled-packages.json)
  → 刷新
```

### 新 Session 启动
```
session-service.create() → ExtensionService.getExtensionPaths()
  → ExtensionResolver.resolve()（5 个源，含 settings）
  → 过滤 disabled-packages.json 中的禁用项
  → 追加 xyz-agent-extension.js（文件型）   ✅ (v4 MUST_FIX 已解决)
→ pi --extension <paths>
```

---

## 5. 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | ~~MUST FIX~~ | FR-5 | ~~xyz-agent-extension.js 在新架构中无出处~~ | **已解决**：spec 已补充文件型 extension 处理描述 |
| 2 | LOW | FR-2 | 卸载未清理 disabled-packages.json 残留条目 | uninstallExtension 步骤追加"同时从 disabled-packages.json disabled[] 中移除该包名" |
| 3 | LOW | FR-4 | push 顺序代码块 `// 最低` / `// 最高` 注释与实际机制无关 | 删除优先级注释，只保留 PRIORITY_ORDER 数组作为唯一权威来源 |
| 4 | LOW | FR-5/FR-8 | disabled-packages.json 过滤时机未明确 | 补充分层描述："Resolver 扫描全部 packages[] 不过滤 → Service 读 disabled-packages.json 标记 enabled → getExtensionPaths 过滤 enabled=false" |
| 5 | LOW | FR-3 | "已安装的 extension 可以切换启用/禁用"措辞过于宽泛 | 改为"已安装的 **user-installed** extension 可以切换启用/禁用。built-in extension 不支持此操作" |
| 6 | LOW | FR-8 | settings.json 并发写入风险未记录 | Constraints 追加已知限制说明（实际风险极低） |
| 7 | INFO | AC-4/AC-5 | "明确显示"、"禁用/灰色状态"不可量化 | 改为可测试描述 |
| 8 | INFO | D-1 | packages[] 未说明是否忽略 pi 原生 object 形式 | 补充说明 |
| 9 | LOW | FR-6 | WS 协议未定义安装/卸载失败的错误响应格式 | 补充错误响应格式，或显式引用已有 server.ts 错误机制 |
| 10 | LOW | FR-1 | `npm:xxx` → `xxx` 前缀剥离规则未说明 | installExtension 注释补充："剥离 `npm:` 前缀后得到实际包名，传给 npm install" |
| 11 | LOW | FR-5 | installExtension 接口注释缺少 isValidPiExtension 校验步骤 | 补充完整流程："npm install → isValidPiExtension 校验 → 失败则 npm uninstall 回滚 → 成功则写入 packages[] → 刷新" |
| 12 | INFO | FR-6/FR-7 | "source" 一词两层含义（安装源 vs 来源标识） | install payload 字段改用 `package` 或 `packageRef` |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程
> - **LOW**：建议修复，但不阻塞
> - **INFO**：观察记录，无需操作

---

## 6. 结论

**通过。**

v4 的 MUST_FIX（xyz-agent-extension.js 处理逻辑遗漏）已在当前 spec 中解决。FR-5 现在完整描述了文件型 extension 的处理：ExtensionService 在 ExtensionResolver.resolve() 返回后追加 `xyz-agent-extension.js` 路径，检查文件存在性，不经过去重/过滤。

本轮新增 4 条问题（#9 ~ #12），均为 LOW/INFO 级别，集中在接口注释完整性和 WS 协议细节。不阻塞实现，但建议采纳以提高 spec 的自包含性——尤其是 #9（WS 错误响应）和 #11（installExtension 完整步骤），能避免实现者遗漏关键流程。

### Summary

Spec 评审完成，第5轮，0条 MUST FIX，通过。建议采纳 8 条 LOW 改进项。
