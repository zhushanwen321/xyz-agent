---
verdict: pass
---

# Provider Model Thinking Level Mapping

## Background

xyz-agent 的 Provider 设置页面（`ProviderModal.vue`）目前支持配置 provider 的基本信息（名称、类型、Base URL、API Key）和模型列表（id、name、contextWindow）。但缺少对 **thinkingLevelMap** 的可视化配置能力。

`thinkingLevelMap` 是 pi `models.json` 中每个模型的可选字段，定义了 UI 级别到 API 级别的映射关系：

```json
{
  "thinkingLevelMap": {
    "off": null,
    "minimal": null,
    "low": null,
    "medium": null,
    "high": "high",
    "xhigh": "max",
    "max": "max"
  }
}
```

- **key**：UI 展示的 thinking level 名称（`off | minimal | low | medium | high | xhigh | max`）
- **value**：传给 API 的实际参数值（`string` 透传，`null` 表示禁用该级别）
- **字段不存在**：表示所有 level 都可用（透传）

当前的 `InputToolbar.vue` 已经读取 `thinkingLevelMap` 来过滤 UI 可选的 thinking level 列表。但用户无法在 Settings UI 中编辑这个映射——只能手动修改 `models.json`。

设计参考 demo：`docs/designs/views_settings-model-thinking.html`

## Functional Requirements

### FR-1: 模型行展开/折叠 Thinking Level 配置

在 `ProviderModal` 的模型列表中，每个模型行增加可展开/折叠的 thinking level 配置区域：

1. 模型行显示 chevron 图标，点击可展开/折叠 thinking level 配置面板
2. 展开后显示所有 7 个 level（`off, minimal, low, medium, high, xhigh, max`），每行包含：
   - **Toggle 开关**：启用/禁用该 level（启用 = 映射值非 null，禁用 = 映射值为 null）
   - **Level 名称**：只读展示
   - **API 参数输入框**：启用时可编辑，填入传给 API 的实际值；禁用时置灰
3. 模型行增加 `mapped` badge：当 `thinkingLevelMap` 存在且非空时显示

### FR-2: Thinking Level 映射数据结构

1. 每个模型独立维护自己的 `thinkingLevelMap`
2. 映射值规则：
   - **Toggle ON + 输入框有值**：`"level": "api_value"`（显式映射）
   - **Toggle ON + 输入框为空**：`thinkingLevelMap` 中**不写该 key**（省略 = 透传，pi 会使用 key 的原始值）
   - **Toggle OFF**：`"level": null`（显式禁用）
3. 未配置过 thinkingLevelMap 的模型，展示时所有 toggle 默认 ON，输入框为空（透传模式）

### FR-3: 保存到 models.json

1. 保存 provider 时，将每个模型的 `thinkingLevelMap` 一并写入
2. `SetProviderData` 的 `models` 字段需要扩展，支持携带 `thinkingLevelMap`
3. `ConfigService.setProvider` 和 `pi-config-bridge` 写入时保留 `thinkingLevelMap`
4. 保存后刷新前端 provider store，使 `InputToolbar` 的 thinking level 列表实时更新

### FR-4: 前端 Thinking Level 选项过滤

这是已有的行为（`InputToolbar.vue` 已实现），但需要确认与新增配置的配合：

1. 选择模型后，`InputToolbar` 根据 `model.thinkingLevelMap` 过滤可选 level
2. 过滤规则（已在 `InputToolbar.vue` 中实现）：
   - `thinkingLevelMap` 不存在 → 显示所有 level
   - `thinkingLevelMap` 中值为 `null` → 排除该 level
   - `thinkingLevelMap` 中值为 `undefined` 或有效字符串 → 保留该 level
3. 保存映射后无需刷新页面，store 更新自动触发重新计算

### FR-5: 预设模板（Quick Presets）

在 thinking level 配置面板底部提供快速预设按钮：

1. **"DeepSeek"**：仅启用 `high`/`xhigh`/`max`，其中 `xhigh → max`
2. **"全开（透传）"**：所有 level 启用，输入框为空（等同于不配置 thinkingLevelMap）
3. **"通用映射"**：所有 level 启用，`high → high`、`xhigh → max`、`max → max`，其余透传
4. 点击预设后覆盖当前配置，用户可在此基础上微调

## Acceptance Criteria

### AC-1: 模型行展开与折叠
- [ ] 每个模型行左侧显示 chevron 图标
- [ ] 点击模型行或 chevron 可展开/折叠 thinking level 配置区域
- [ ] 展开动画流畅（CSS transition）
- [ ] 多个模型行可同时展开

### AC-2: Toggle 与 API 参数输入
- [ ] 展开后显示 7 个 level 行（off → max，从上到下）
- [ ] 每行有 toggle 开关，默认状态反映模型当前的 `thinkingLevelMap`
- [ ] Toggle OFF 时，level 名称和 API 输入框置灰（disabled 样式）
- [ ] Toggle ON 时，API 输入框可编辑
- [ ] 新模型（无 thinkingLevelMap）所有 toggle 默认 ON，输入框为空

### AC-3: 数据持久化
- [ ] 点击保存后，`models.json` 正确写入每个模型的 `thinkingLevelMap`
- [ ] 已有 `thinkingLevelMap` 的模型（如 ds-flash）编辑后正确更新
- [ ] 无 `thinkingLevelMap` 的模型，如果所有 toggle 都是 ON 且输入框为空，**不写入 `thinkingLevelMap` 字段**（省略该字段 = 透传，与手动编辑 models.json 的行为一致）
- [ ] 保存后前端 store 刷新，`InputToolbar` 的 thinking level 选项立即更新

### AC-4: 保存失败处理
- [ ] 保存时如果 WS 断连或服务端返回错误，显示错误提示（toast 或 inline message），不关闭 Modal
- [ ] 保存成功后 Modal 自动关闭，provider store 刷新

### AC-5: Thinking Level 过滤联动
- [ ] 配置 ds-flash 的 thinkingLevelMap 为 `{"off":null, "high":"high", "xhigh":"max", "max":"max"}` 后
- [ ] 在聊天界面选择 ds-flash 模型时，InputToolbar 只显示 `high`、`xhigh`、`max` 三个选项
- [ ] 其他模型（无 thinkingLevelMap）仍显示所有 level

### AC-6: 预设模板
- [ ] 点击 "DeepSeek" 预设：`off`~`medium` toggle OFF，`high` 输入框 "high"，`xhigh` 输入框 "max"，`max` 输入框 "max"
- [ ] 点击 "全开（透传）" 预设：所有 toggle ON，所有输入框为空
- [ ] 点击 "通用映射" 预设：所有 toggle ON，`high` 输入框 "high"，`xhigh` 输入框 "max"，`max` 输入框 "max"

## Constraints

1. **数据格式**：`thinkingLevelMap` 的 key 必须是 `off | minimal | low | medium | high | xhigh | max`，value 是 `string | null`
2. **向后兼容**：已有 `models.json` 中可能没有 `thinkingLevelMap` 字段，UI 必须正确处理
3. **共享类型**：`SetProviderData.models` 需要扩展以支持 `thinkingLevelMap`，但必须是向后兼容的（可选字段）
4. **UI 组件**：必须使用 xyz-ui 组件库（Button、Input、ToggleSwitch 等），禁止原生 HTML 表单元素
5. **样式**：遵循 Tailwind 工具类规范，参考 demo HTML 的视觉设计
6. **ProviderModal 行数限制**：`<template>` ≤ 400 行，`<script setup>` ≤ 300 行。Thinking level 配置区域应抽取为独立组件（`ThinkingLevelConfig.vue`）

## 业务用例

### UC-1: 为 DeepSeek 模型配置 thinking level 映射
- **Actor**: 用户
- **场景**: DeepSeek 模型不支持低 thinking level，用户希望在 UI 中只显示有效的 level（high、xhigh、max），且 xhigh 映射为 API 的 max
- **预期结果**: 用户在 Provider 设置中展开 ds-flash 模型，关闭 off~medium 的 toggle，保留 high/xhigh/max 启用，设置 xhigh 的 API 值为 "max"。保存后聊天界面选择 ds-flash 时只显示 high/xhigh/max

### UC-2: 为新模型快速应用预设
- **Actor**: 用户
- **场景**: 用户添加了一个新的 DeepSeek 兼容模型，希望快速配置 thinking level
- **预期结果**: 用户展开模型 thinking 配置，点击 "DeepSeek" 预设按钮，配置自动填入，保存即可

### UC-3: 查看已有映射配置
- **Actor**: 用户
- **场景**: 用户打开 Provider 设置，查看 ds-flash 模型的 thinking level 配置
- **预期结果**: 正确显示当前配置（off~medium 禁用，high/xhigh/max 启用且显示 API 值）

## Complexity Assessment

**Medium** — 涉及 4 层变更（共享类型 → 后端 ConfigService → 前端组件 → 数据流），但每层变更量小且模式清晰。核心工作量在前端组件（`ThinkingLevelConfig.vue` + `ProviderModal.vue` 改造），后端只需透传 `thinkingLevelMap` 字段。无新 API 端点，无数据库变更，无外部依赖。
