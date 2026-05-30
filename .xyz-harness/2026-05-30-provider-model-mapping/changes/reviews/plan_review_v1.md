---
review:
  type: plan_review
  round: 1
  timestamp: "2026-05-30T16:00:00"
  target: ".xyz-harness/2026-05-30-provider-model-mapping"
  verdict: fail
  summary: "计划评审第1轮，1条MUST FIX（原生button违反组件规范），需修改后重审"

statistics:
  total_issues: 4
  must_fix: 1
  must_fix_resolved: 0
  low: 2
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "plan.md:Task 4 Step 5 — chevron 展开按钮"
    title: "使用原生 <button> 违反项目编码规范"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: LOW
    location: "use-cases.md:UC-3 Step 5"
    title: "minimal/low/medium 状态描述与 FR-2 矛盾"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: LOW
    location: "plan.md:Task 2 — setProvider 参数类型"
    title: "SetProviderData 类型重复定义，未引用共享类型"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: INFO
    location: "plan.md:Task 3 — ThinkingLevelConfig.vue"
    title: "组件设计合理，数据模型与 spec FR-2 一致"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 计划评审 v1

## 评审记录
- 评审时间：2026-05-30 16:00
- 评审类型：计划评审
- 评审对象：`.xyz-harness/2026-05-30-provider-model-mapping/` 下所有交付物

## 1. Spec 完整性

**目标明确性**: ✅ 通过。一句话概括：在 Provider 设置 UI 中为每个模型提供 `thinkingLevelMap` 可视化编辑能力。目标清晰，无歧义。

**范围合理性**: ✅ 通过。范围聚焦于 Settings UI 组件改造 + 类型扩展 + 后端透传，不涉及新 API 端点、数据库变更、外部依赖。复杂度评估为 Medium 合理。

**验收标准可量化**: ✅ 通过。6 个 AC 均可写测试验证：
- AC-1（展开折叠）→ 可通过 UI 交互验证
- AC-2（Toggle/输入）→ 可验证 DOM 状态和交互
- AC-3（数据持久化）→ 可读取 models.json 验证
- AC-4（保存失败）→ 可模拟 WS 断连验证
- AC-5（过滤联动）→ 可验证 InputToolbar 选项列表
- AC-6（预设模板）→ 可逐个验证预设输出

**[待决议] 项**: 无。

**结论**: Spec 完整性通过。

## 2. Plan 可行性

**任务拆分**: ✅ 合理。5 个 Task 粒度适中：
- Task 1-2（后端）: 类型扩展 + 透传修复，各 ~5 行变更
- Task 3（前端新建）: ThinkingLevelConfig 组件，~120 行
- Task 4-5（前端改造）: Modal 集成 + Pane save 流程，各 ~30 行变更

每个 Task 可由一个 subagent 独立完成。

**依赖关系**: ✅ 正确。Task 1 → Task 2（类型先改再用），Task 3 → Task 4（组件先建再集成），Task 4 → Task 5（Modal 接口变更后 Pane 才能对齐）。Task 3 可与 BG1 并行，合理。

**工作量估算**: ✅ 现实。前端核心工作量在 ThinkingLevelConfig.vue（~120 行），其余是接口扩展和集成点。总体可控。

**遗漏检查**: ✅ 无明显遗漏。逐条对照：
- FR-1（展开折叠）→ Task 4
- FR-2（数据结构）→ Task 3
- FR-3（保存到 models.json）→ Task 1 + Task 2 + Task 5
- FR-4（过滤联动）→ AC-5 标注为已有，E2E TS-7 覆盖验证
- FR-5（预设模板）→ Task 3

**行数限制验证**: ✅ 通过。
- ProviderModal.vue 现状：`<script>` 274 行 / `<template>` 117 行
- Task 4 新增估算：script +20 行（expandedModels ref、toggleExpand、import、ModalModel 扩展、watch 修改）→ 294 行 ≤ 300 ✅
- Task 4 新增估算：template +15 行（chevron、ThinkingLevelConfig wrapper、mapped badge）→ 132 行 ≤ 400 ✅
- ThinkingLevelConfig.vue 为独立新组件，不受 ProviderModal 行数限制约束

**结论**: Plan 可行性通过。

## 3. Spec 与 Plan 一致性

**逐条覆盖**: ✅ 通过。

| Spec 需求 | Plan Task | 状态 |
|-----------|-----------|------|
| FR-1: 模型行展开/折叠 | Task 4 | ✅ |
| FR-2: 映射数据结构 | Task 3（buildMap/initLevels） | ✅ |
| FR-3: 保存到 models.json | Task 1 + Task 2 + Task 5 | ✅ |
| FR-4: 前端过滤联动 | 无新 task（已有） | ✅ E2E 覆盖 |
| FR-5: 预设模板 | Task 3（applyPreset） | ✅ |
| AC-1: 展开/折叠 | Task 4 | ✅ |
| AC-2: Toggle/输入 | Task 3 | ✅ |
| AC-3: 数据持久化 | Task 1 + 2 + 5 | ✅ |
| AC-4: 保存失败 | Task 5 Step 3 | ✅ |
| AC-5: 过滤联动 | 已有，E2E TS-7 验证 | ✅ |
| AC-6: 预设模板 | Task 3 | ✅ |

**Plan 额外工作**: 无。所有 Task 均可追溯到 spec 需求。

**结论**: 一致性通过。

## 4. Execution Groups 合理性

**分组**:
- BG1: Task 1 + Task 2，2 files modified → ✅ 文件数 ≤ 10
- FG1: Task 3 + Task 4 + Task 5，1 created + 2 modified → ✅ 文件数 ≤ 10

**类型划分**: ✅ 正确。BG1 为后端（shared types + ConfigService），FG1 为前端组件。

**功能关联度**: ✅ 合理。BG1 内 Task 1（类型）和 Task 2（使用类型）紧密关联；FG1 内三个 Task 围绕 ProviderModal 改造展开。

**依赖关系**: ✅ 正确。BG1 → FG1，Wave 编排合理。

**Wave 并行性**: ✅ Wave 1（BG1 串行）和 Wave 2（FG1 串行），无并行冲突。Task 3 可与 BG1 并行的设计合理。

**Subagent 配置**: plan.md 未包含完整的 subagent 配置（Agent/Model/注入上下文/读取文件/修改文件），但这是 L1 plan，详细 subagent 配置在执行阶段指定，可接受。

**结论**: Execution Groups 通过。

## 5. 接口契约审查

plan.md 包含 Interface Contracts 章节，逐项检查：

**AC 覆盖矩阵**: ✅ 完整。6 个 AC 均在矩阵中有对应行。AC-5 标注为"无新 task（已有，验证）"，原因合理。

**方法签名一致性**: ✅ 通过。`buildMap`、`applyPreset`、`initLevels`、`setProvider`、`toggleExpand`、`handleSave` 签名与实现代码一致。

**结论**: 接口契约审查通过。

## 6. 代码级预检

在审查 plan 时，同步检查了现有代码库的实际情况：

### 6.1 ToggleSwitch API 兼容性 ✅

现有 `ToggleSwitch.vue` 接口：
```typescript
defineProps<{ modelValue: boolean }>()
defineEmits<{ 'update:modelValue': [value: boolean] }>()
```
plan Task 3 使用 `:model-value` + `@update:model-value`，Vue 3 自动处理 kebab-case ↔ camelCase 转换，兼容性无问题。

### 6.2 ConfigService 现状确认 ✅

- `getProviders()` 已读取 `m.thinkingLevelMap`（config-service.ts:86）
- `setProvider()` 不写入 `thinkingLevelMap`（config-service.ts:105-111 的 `rawModels.map` 回调缺失该字段）
- plan Task 2 准确识别了此 bug，修复方向正确

### 6.3 ModelInfo 类型确认 ✅

`shared/src/provider.ts` 的 `ModelInfo` 接口已包含 `thinkingLevelMap?: Record<string, string | null>`，plan 无需修改此文件，只需修改 `SetProviderData` 和 `ConfigService`。

### 6.4 design-system 导入路径 ✅

现有 ProviderModal.vue 使用 `import { Button, Input, Select } from '../../design-system'`。plan Task 3 使用相同路径，正确。

---

## 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST FIX | plan.md:Task 4 Step 5 — chevron 按钮 | 使用原生 `<button>` 元素，违反项目编码规范"禁止原生 HTML 表单元素，必须使用 xyz-ui 组件" | 改用 `<Button variant="ghost">` 包裹 SVG 图标，与现有 ProviderModal 的关闭按钮模式一致（参见 ProviderModal.vue:289 的 × 按钮实现） |
| 2 | LOW | use-cases.md:UC-3 Step 5 | 描述称 minimal/low/medium 不在 thinkingLevelMap 中时显示为 OFF，但 FR-2 规定 key 不存在 = 透传（Toggle ON，输入框为空） | 修正为"minimal/low/medium 不在 thinkingLevelMap 中 → 显示为 Toggle ON，输入框为空（透传模式）" |
| 3 | LOW | plan.md:Task 2 — setProvider 参数类型 | `setProvider` 方法的 `data` 参数类型与 `SetProviderData`（protocol.ts:29）重复定义，修改时需要同步两处 | 考虑让 `setProvider` 直接接受 `SetProviderData` 类型，避免重复定义和同步风险 |
| 4 | INFO | plan.md:Task 3 — ThinkingLevelConfig.vue | ThinkingLevelConfig 的 `buildMap()` 逻辑正确实现了 FR-2 的三种状态（ON+空=省略、ON+有值=映射、OFF=null），`initLevels()` 正确处理了 map 为 undefined 的默认状态 | 无需操作 |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程
> - **LOW**：建议修复，但不阻塞
> - **INFO**：观察记录，无需操作

### MUST FIX #1 详细说明

plan Task 4 Step 5 的展开按钮代码：

```html
<button
  class="shrink-0 w-5 h-5 flex items-center justify-center rounded-sm hover:bg-foreground/5 transition-colors"
  :class="{ 'rotate-90': expandedModels.has(mm.id) }"
  @click="toggleExpand(mm.id)"
>
  <svg ...>...</svg>
</button>
```

项目 CLAUDE.md 前端编码规范第一条："**禁止原生 HTML 表单元素 — 必须使用 xyz-ui 组件（Button/Input/Select/Dialog 等）**"。且自动检查工具 taste-lint 的 `no-native-html` 规则会在 pre-commit 阶段拦截。

建议修改为：

```html
<Button
  variant="ghost"
  size="sm"
  class="!w-5 !h-5 !p-0 shrink-0 transition-transform duration-200"
  :class="{ '!rotate-90': expandedModels.has(mm.id) }"
  @click="toggleExpand(mm.id)"
>
  <svg ...>...</svg>
</Button>
```

这与现有 ProviderModal.vue 第 289 行的关闭按钮使用模式一致。

## 结论

需修改后重审。修复 MUST FIX #1（原生 `<button>` → xyz-ui `<Button>`）后可通过。

## AC 覆盖矩阵

| AC | 场景 | 覆盖状态 | Plan Task |
|----|------|---------|-----------|
| AC-1 | 模型行展开与折叠 | ✅ 完整覆盖 | Task 4 |
| AC-2 | Toggle 与 API 参数输入 | ✅ 完整覆盖 | Task 3 |
| AC-3 | 数据持久化 | ✅ 完整覆盖 | Task 1, 2, 3, 5 |
| AC-4 | 保存失败处理 | ✅ 完整覆盖 | Task 5 |
| AC-5 | Thinking Level 过滤联动 | ✅ 验证（已有实现） | E2E TS-7 |
| AC-6 | 预设模板 | ✅ 完整覆盖 | Task 3 |

### Summary

计划评审完成，第1轮需重审，1条MUST FIX。
