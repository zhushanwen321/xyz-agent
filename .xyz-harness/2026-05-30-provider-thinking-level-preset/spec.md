---
verdict: pass
last_updated: 2026-05-30
---

# Provider Thinking Level 快捷配置

## Background

当前 `ProviderModal.vue` 不支持编辑模型的 `thinkingLevelMap`。用户只能手动改 `models.json`。

实际场景中，所有模型的 thinking level 只有两种形态：

| 形态 | 代表模型 | 配置需求 |
|------|---------|---------|
| **分级思考** | DeepSeek V4 | 仅展示 `high`/`xhigh`，xhigh 映射到 API 的 max |
| **二元开关** | GLM/Kimi/Qwen/MiMo | off = 关，其余 = 开（全等价）。无需配置。 |

不需要复杂的 7-level toggle+input 编辑器。两个预设按钮即可。

---

## Design

### 不需要做的事

- ❌ 不需要 `ThinkingLevelConfig.vue` 组件（删除已创建的文件）
- ❌ 不需要 ProviderModal 中的 chevron 展开/折叠逻辑
- ❌ 不需要 xyz-pi 任何改动（pi-ai 已有的 `thinkingLevelMap` 机制完全够用）

### InputToolbar 的 ALL_THINKING_LEVELS

```typescript
const ALL_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const
```

**不包含 `max`**。和 pi-ai 的 `EXTENDED_THINKING_LEVELS` 完全一致。

`thinkingLevelMap` 的过滤逻辑不变：key 为 `null` 的 level 不在 picker 中出现。

### ProviderModal 新增：两个按钮

在模型列表区域上方加两个按钮：

```
[DeepSeek 预设] [清空映射]
```

- **"DeepSeek 预设"**：将当前 provider 的**所有模型**的 thinkingLevelMap 设为：
  ```json
  {"minimal": null, "low": null, "medium": null, "high": "high", "xhigh": "max"}
  ```
- **"清空映射"**：将当前 provider 的**所有模型**的 thinkingLevelMap 移除（设为 undefined）。等价于默认行为——所有 6 个 level 都可用。

两个按钮只影响当前编辑中的 modalModels，不立即写入 models.json。用户点击 ProviderModal 的保存按钮时才持久化。

---

## Data Flow

### DeepSeek 模型

**thinkingLevelMap 配置**：
```json
{"minimal": null, "low": null, "medium": null, "high": "high", "xhigh": "max"}
```

**InputToolbar 展示**（过滤后）：
| level | thinkingLevelMap[level] | 展示？ |
|-------|------------------------|--------|
| off | undefined (不在 map 中) | ✅ |
| minimal | `null` | ❌ |
| low | `null` | ❌ |
| medium | `null` | ❌ |
| high | `"high"` | ✅ |
| xhigh | `"max"` | ✅ |

picker 显示：`off, high, xhigh`

**用户选 xhigh 后发送**：
```
InputToolbar: user picks "xhigh"
  → handleSend: setThinkingLevel("xhigh")
    → pi-agent-core: reasoning = "xhigh" (not "off" → passes through)
      → openai-completions provider:
        - compat.thinkingFormat = "deepseek"
        - reasoning_effort = thinkingLevelMap?.["xhigh"] ?? "xhigh"
        - = "max"
      → API: reasoning_effort: "max" ✅
```

### 二元开关模型（GLM, Kimi, Qwen, MiMo）

**thinkingLevelMap**: undefined（不配置，或"清空映射"）

**InputToolbar 展示**：全部 6 个 level（off..xhigh）

**用户选任意非 off 的 level 后发送**：
```
InputToolbar: user picks "xhigh"
  → handleSend: setThinkingLevel("xhigh")
    → pi-agent-core: reasoning = "xhigh"
      → provider: 
        - compat.thinkingFormat 未设置 (router 模型)
        - 走默认分支发送 reasoning_effort 或 enable_thinking
      → API: thinking enabled ✅
```

**注意**：对于二元开关模型，选 `high` 还是 `xhigh` 效果一样，都是 thinking enabled。这是正确的行为——模型本身不支持分级。

---

## Implementation Tasks

### Task 1: 清理已创建但不需要的代码

- 删除 `src-electron/renderer/src/components/settings/ThinkingLevelConfig.vue`
- 删除 `ProviderModal.vue` 中的 chevron 展开逻辑（expandedModels ref、toggleExpand 函数、chevron 按钮、对应的 template 部分）
- 恢复 `ProviderPane.vue` handleSave 的类型（移除 thinkingLevelMap 扩展，或保留简化版）
- 恢复 `ConfigService.setProvider` 的模型合并逻辑（保留现有所有字段即可，不需要 thinkingLevelMap 特殊处理）
- 保留 `settingsStore.currentThinkingLevel`（handleSend 需要用到）
- 保留 `PanelSessionView.handleSend` 中 `setThinkingLevel` 先于 `message.send` 的修复
- 保留 `InputToolbar` 的 thinkingLevelMap 过滤逻辑

### Task 2: InputToolbar ALL_THINKING_LEVELS 对齐 pi-ai

```typescript
// 当前
const ALL_THINKING_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

// 改为
const ALL_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const
```

### Task 3: ProviderModal 新增两个预设按钮

在模型列表区域（`<div class="models-list">` 附近）添加两个按钮：

```html
<div class="flex gap-2 mb-3">
  <Button variant="outline" size="sm" @click="applyThinkingPreset('deepseek')">
    DeepSeek 预设
  </Button>
  <Button variant="outline" size="sm" @click="applyThinkingPreset('clear')">
    清空映射
  </Button>
</div>
```

```typescript
function applyThinkingPreset(preset: 'deepseek' | 'clear') {
  for (const m of modalModels.value) {
    if (preset === 'deepseek') {
      m.thinkingLevelMap = {
        minimal: null, low: null, medium: null,
        high: 'high', xhigh: 'max'
      }
    } else {
      m.thinkingLevelMap = undefined
    }
  }
}
```

### Task 4: 保存时写入 thinkingLevelMap

修好的 `handleSend`（Task 1 中保留的）在写入 models.json 时自动带上 `thinkingLevelMap`。只要 `modalModels` 中有这个字段，保存就会写入。

---

## Acceptance Criteria

### AC-1: DeepSeek 预设
- [ ] 编辑 provider，点击"DeepSeek 预设"按钮
- [ ] 保存后在 InputToolbar 中该 provider 的模型只显示 `off, high, xhigh`
- [ ] 选 `xhigh` 发消息，模型使用最高思考强度

### AC-2: 清空映射
- [ ] 点击"清空映射"后保存
- [ ] InputToolbar 恢复显示全部 6 个 level
- [ ] 选任意非 off 的 level，thinking 都启用

### AC-3: InputToolbar 不展示 max
- [ ] ALL_THINKING_LEVELS 不包含 `max`
- [ ] 所有模型（包括 DeepSeek）的 picker 中不出现 `max`

### AC-4: 发送前自动同步 thinking level
- [ ] 发消息时自动先发 `session.setThinkingLevel`
- [ ] 选择 DeepSeek 模型，选 `xhigh`，发消息时 thinking 生效

### AC-5: 不影响已有数据
- [ ] 已有 models.json 中的 `thinkingLevelMap` 不丢失
- [ ] 未配置过 thinkingLevelMap 的模型行为不变
