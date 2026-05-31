---
review:
  type: spec_review
  round: 2
  timestamp: "2026-05-29T19:30:00"
  target: ".xyz-harness/2026-05-29-plugin-remaining-phases/spec.md"
  verdict: fail
  summary: "Spec 评审完成，第2轮，1条 MUST FIX（Constraint #4 未同步修复），需修改后重审"

statistics:
  total_issues: 9
  must_fix: 1
  must_fix_resolved: 3
  low: 4
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md → AC-1"
    title: "AC-1 'listSessions() 返回非空数组' 无条件成立不可测试"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 2
    severity: MUST_FIX
    location: "spec.md → FR-4 + Constraint #4"
    title: "FR-4 UI 弹窗组件策略自相矛盾：'复用' vs '复用或新建'"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 3
    severity: MUST_FIX
    location: "spec.md → FR-3 + AC-3"
    title: "getModel/setModel 数据源优先级未定义，AC-3 语义断裂"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 4
    severity: MUST_FIX
    location: "spec.md → FR-7"
    title: "'最多重试 3 次' 作用域未定义（per-Worker/per-process/per-plugin）"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 5
    severity: LOW
    location: "spec.md → FR-2"
    title: "SessionData 持久化未指定文件损坏恢复行为"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 6
    severity: LOW
    location: "spec.md → AC-1"
    title: "'RPC 往返延迟 < 50ms' 是性能目标，不适合作为功能 AC"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 7
    severity: LOW
    location: "spec.md → Constraint #9"
    title: "'不修改已通过的测试' 边界模糊，hook 改动可能波及已有测试 setup"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 8
    severity: LOW
    location: "spec.md → 优先级分档"
    title: "未说明部分交付条件——仅完成第一档是否可接受"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 9
    severity: INFO
    location: "spec.md → 全文"
    title: "v1 的 4 条 MUST FIX 中 3 条已修复，修复质量良好"
    status: open
    raised_in_round: 2
    resolved_in_round: null
---

# Spec 评审 v2（增量审查）

## 评审记录
- 评审时间：2026-05-29 19:30
- 评审类型：计划评审（spec 完整性）— 第 2 轮增量审查
- 评审对象：`.xyz-harness/2026-05-29-plugin-remaining-phases/spec.md`
- 审查模式：验证 v1 的 4 条 MUST FIX 修复情况 + 检查回归

## v1 MUST FIX 逐条验证

### Issue #1: AC-1 无条件非空 → ✅ FIXED

**v1 原问题**: `listSessions() 返回非空数组` 无条件成立不可测试。`getModel() 返回非空字符串` 同理。

**当前 spec**:
- AC-1: `listSessions()` 返回 `SessionInfo[]`（无 session 时返回空数组是正确行为）
- AC-1: `getSession(knownId)` 返回 `SessionInfo | undefined`（找到时非 undefined）
- AC-3: `getModel()` 始终从 `IConfigService` 读取，返回格式 `{ provider: string, modelId: string }` 或默认值
- AC-3: `getActiveTools()` 返回 schema 列表（无注册 tool 时返回空数组是正确行为）

**评价**: 所有断言都加上了合理的前提条件或 fallback 语义。空数组/undefined/默认值在无数据时均为正确行为。AC 可测试。

---

### Issue #2: FR-4 组件策略矛盾 → ⚠️ PARTIALLY FIXED

**v1 原问题**: FR-4 同时写「复用 ExtensionUIDialog」和「新建 PluginUIDialog」，Constraint #4 也含糊。

**当前 spec FR-4 正文**（清晰）:
> 前端 `usePlugin` composable 监听 `plugin:uiRequest`，**复用 `ExtensionUIDialog` 组件**渲染弹窗

**当前 spec FR-4 涉及文件**（明确）:
> `ExtensionUIDialog.vue`（直接复用，通过 props 区分 extension/plugin 来源）。**不新建 PluginUIDialog 组件。**

**当前 spec Constraint #4**（未修复）:
> UI 弹窗复用 ExtensionUIDialog 模式 — **新建 `PluginUIDialog` 或复用同一组件**，不走 pi extension 通道

**问题**: FR-4 body 已做出明确选择（"不新建 PluginUIDialog 组件"），但 Constraint #4 仍保留旧措辞 "新建 `PluginUIDialog` 或复用同一组件"。两处直接矛盾。

Spec 内部自相矛盾是实质性缺陷——执行者读到 Constraint #4 时会困惑于哪个是权威描述。修复量极小：将 Constraint #4 改为 "直接复用 ExtensionUIDialog 组件，通过 props 区分来源，不新建 PluginUIDialog"。

---

### Issue #3: getModel/setModel 数据源 → ✅ FIXED

**v1 原问题**: getModel 读 session，setModel 写 session，但"或从 config 读取"导致数据源二义性，AC-3 读己之写一致性无法保证。

**当前 spec FR-3**:
- `getModel()` → **从 `IConfigService` 读取**（`configService.get('defaultModel')`），无活跃 session 时也返回有效值
- `setModel(provider, modelId)` → **写入 `IConfigService`**（`configService.set('defaultModel', ...)`），同时如果有活跃 session 则调用 `sessionService.switchModel()`

**当前 spec AC-3**:
- `getModel()` 始终从 `IConfigService` 读取
- `setModel(...)` 写入 config 后 `getModel()` 立即返回新模型（读己之写一致性）

**评价**: 数据源统一为 `IConfigService`。getModel 和 setModel 同读同写 config，读己之写一致性有保障。setModel 额外调 sessionService.switchModel() 是副作用，不影响主数据流语义。清晰。

---

### Issue #4: 重试 3 次作用域 → ✅ FIXED

**v1 原问题**: "最多重试 3 次" 未定义作用域——per-Worker/per-process/per-plugin。

**当前 spec FR-7**:
> 同一 plugin 在一次 sidecar 生命周期内最多重建 3 次（**per-plugin 计数器**），超过后该 plugin 标记 `CRASHED` 不再重试，**直到 sidecar 重启计数器清零**

**评价**: 三个维度全部明确——per-plugin（不是 per-Worker-slot）、per-sidecar-lifecycle（重启清零）、超出后行为（标记 CRASHED 不再重试）。实现者不会产生歧义。

---

## 回归检查

逐项检查修复是否引入新问题：

| 检查项 | 结果 | 说明 |
|--------|------|------|
| AC-1 修改是否影响其他 AC | ✅ | AC-1 修改仅限条件化措辞，不涉及数据流变更 |
| FR-3 数据源改为 configService 是否与 Constraint #1 冲突 | ✅ | Constraint #1 限制的是 ISessionService 接口签名不改，configService 注入是新增引用，不冲突 |
| FR-3 setModel 同时写 config + switch session 是否引入双写问题 | ⚠️ 可接受 | 双写语义清晰：config 是持久默认值，session 是运行时切换。AC-3 只测 config 路径的读己之写，session 路径作为副作用不影响一致性 |
| FR-7 per-plugin 计数器的存储位置是否合理 | ✅ | 由 PluginService 管理（它管理所有 Worker 和插件状态），自然归属 |
| AC-7 "连续崩溃 3 次" 与 FR-7 "最多重建 3 次" 措辞是否一致 | ✅ | 语义一致，3 次重建机会对应 3 次崩溃后停止 |

**无回归引入。**

---

## 发现的问题

### MUST FIX（延续自 v1）

| # | 位置 | 描述 | 修改建议 |
|---|------|------|---------|
| 2 | Constraint #4 | **Constraint #4 未同步更新，与 FR-4 body 直接矛盾。** FR-4 已明确选择 "不新建 PluginUIDialog 组件"，但 Constraint #4 仍写 "新建 `PluginUIDialog` 或复用同一组件"。Spec 内部矛盾会导致执行者困惑。 | 将 Constraint #4 改为：`UI 弹窗直接复用 ExtensionUIDialog 组件，通过 props 区分 extension/plugin 来源，不新建 PluginUIDialog`。与 FR-4 涉及文件段落保持一致。 |

### [FIXED] v1 已修复项

| # | 位置 | 修复评价 |
|---|------|---------|
| 1 | AC-1 | 条件化断言，空值场景有明确定义。修复质量好。 |
| 3 | FR-3 + AC-3 | 数据源统一为 IConfigService，读己之写一致性有保障。修复质量好。 |
| 4 | FR-7 | per-plugin per-sidecar-lifecycle 三个维度全部明确。修复质量好。 |

### LOW / INFO（不重评，保留 v1 记录）

v1 的 LOW 项（#5~#8）本轮不重新评估，保留原有状态。

## 结论

需修改后重审。1 条 MUST FIX 为 v1 Issue #2 的残余——FR-4 body 已修复但 Constraint #4 未同步。修复量极小（改一行文字）。其余 3 条 MUST FIX 均已妥善修复，无回归引入。

## Summary

Spec 评审完成，第2轮，1条 MUST FIX（Constraint #4 未同步 FR-4 的设计决策），需修改后重审。
