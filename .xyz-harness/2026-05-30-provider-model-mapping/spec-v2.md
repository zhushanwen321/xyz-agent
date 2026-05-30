---
verdict: draft
last_updated: 2026-05-30
---

# Provider Thinking Level 快捷配置

## 设计修正记录

**v1（已废弃）**：全局两个按钮（DeepSeek 预设 / 清空映射），批量应用到 provider 下所有模型。理解有误，用户实际需求是 per-model 策略选择。

**v2（当前）**：per-model 策略选择 + hover 查看映射规则 + InputToolbar Off/On label 推断。

## Background

当前 `ProviderModal.vue` 不支持编辑模型的 `thinkingLevelMap`。用户只能手动改 `models.json`。

实际场景中，模型的 thinking level 有三种形态：

| 策略 | Badge | thinkingLevelMap | Picker 显示 | 适用模型 |
|------|-------|-----------------|-------------|---------|
| **On / Off** | `On / Off` | `{minimal:null, low:null, medium:null, high:null}` | **Off / On** | GLM/Kimi/Qwen/MiMo — binary thinker，只区分开/关 |
| **high / max** | `high / max` | `{minimal:null, low:null, medium:null, high:"high", xhigh:"max"}` | off, high, xhigh | DeepSeek V4 — 分级思考，xhigh 映射到 API max |
| **All Levels** | `All Levels` | `undefined` | off, min, low, med, high, xhigh | Claude/全级别模型 — 支持完整 6 级 |

**默认策略**：新添加/自动发现的模型默认 `On / Off`（大多数模型是 binary thinker）。

**Off/On label 推断**：当 picker 只剩 2 个 level（off + 1 个其他 level）时，InputToolbar 自动将 label 替换为 "Off" / "On"。不改 thinkingLevelMap schema。

---

## Design

### 不需要做的事

- ❌ 不需要 `ThinkingLevelConfig.vue` 组件（已删除）
- ❌ 不需要 ProviderModal 中的 chevron 展开/折叠逻辑（已删除）
- ❌ 不需要 xyz-pi 任何改动（pi-ai 已有的 `thinkingLevelMap` 机制完全够用）
- ❌ 不改 thinkingLevelMap schema（Option C：纯前端 label 推断）
- ❌ 不需要批量操作按钮
- ❌ 暂不需要 Custom 策略（等真实需求）

### InputToolbar 的 ALL_THINKING_LEVELS

```typescript
const ALL_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const
```

**不包含 `max`**。和 pi-ai 的 `EXTENDED_THINKING_LEVELS` 完全一致。

`thinkingLevelMap` 的过滤逻辑不变：key 为 `null` 的 level 不在 picker 中出现。

**新增 label 推断逻辑**（Option C）：

```typescript
function getThinkingDisplayLabel(level: string, visibleLevels: string[]): string {
  if (visibleLevels.length === 2 && visibleLevels.includes('off')) {
    return level === 'off' ? 'Off' : 'On'
  }
  return level
}
```

当 visible levels ≤ 2 且含 off 时，非 off 的 level 显示 "On"。不改变底层 level 值，只是 display label。

### ProviderModal 新增：per-model 策略选择

每个模型行新增策略 badge（彩色标签），点击弹出下拉选择：

```
deepseek-v4-0324   [high / max ▾]   128K   [×]
deepseek-chat      [On / Off ▾]     64K    [×]
deepseek-reasoner  [All Levels ▾]   128K   [×]
```

**badge 样式**：

| 策略 | 颜色 | CSS class |
|------|------|-----------|
| All Levels | 灰 | `strategy-badge--default` |
| On / Off | 蓝 | `strategy-badge--binary` |
| high / max | 橙红 | `strategy-badge--highmax` |

**hover tooltip**：显示映射规则预览（哪些 level 可见、哪些隐藏、xhigh→max 映射）。

**下拉选项**：

```
┌─────────────────────────┐
│ THINKING STRATEGY       │
│ ✓ All Levels            │
│     All 6 levels visible│
│   On / Off              │
│     Off / On (xhigh)    │
│   high / max            │
│     off + high + xhigh→max│
└─────────────────────────┘
```

**策略 → thinkingLevelMap 映射**：

```typescript
const THINKING_PRESETS = {
  'all-levels': undefined,
  'on-off': { minimal: null, low: null, medium: null, high: null },
  'high-max': { minimal: null, low: null, medium: null, high: 'high', xhigh: 'max' },
} as const

function getStrategyFromMap(map?: Record<string, string | null>): string {
  if (!map) return 'all-levels'
  if (map.xhigh === 'max') return 'high-max'
  return 'on-off'
}

function applyThinkingStrategy(model: ModalModel, strategy: string) {
  model.thinkingLevelMap = THINKING_PRESETS[strategy as keyof typeof THINKING_PRESETS] !== undefined
    ? structuredClone(THINKING_PRESETS[strategy as keyof typeof THINKING_PRESETS])
    : undefined
}
```

**新模型默认策略**：自动发现或手动添加的模型默认 `on-off`。

---

## Data Flow

### On / Off 模型（GLM, Kimi, Qwen, MiMo）

**thinkingLevelMap**: `{minimal:null, low:null, medium:null, high:null}`

**InputToolbar 过滤后**：off, xhigh（off 不在 map 中，xhigh 不在 map 中 → 都 visible）

**label 推断**：visible = 2 且含 off → 显示 **Off / On**

**用户选 On 后发送**：
```
InputToolbar: user picks "On" (实际值 xhigh)
  → handleSend: setThinkingLevel("xhigh")
    → pi-agent-core: reasoning = "xhigh"
      → provider: 走默认分支，thinking enabled
    → API: thinking enabled ✅
```

### high / max 模型（DeepSeek V4）

**thinkingLevelMap**: `{minimal:null, low:null, medium:null, high:"high", xhigh:"max"}`

**InputToolbar 过滤后**：off, high, xhigh（3 个 level，不触发 label 推断）

**用户选 xhigh 后发送**：
```
InputToolbar: user picks "xhigh"
  → handleSend: setThinkingLevel("xhigh")
    → pi-agent-core: reasoning = "xhigh"
      → openai-completions provider:
        - reasoning_effort = thinkingLevelMap?.["xhigh"] ?? "xhigh"
        - = "max"
      → API: reasoning_effort: "max" ✅
```

### All Levels 模型（Claude 等）

**thinkingLevelMap**: undefined

**InputToolbar 展示**：全部 6 个 level（off..xhigh），原名显示

---

## Acceptance Criteria

### AC-1: Per-model 策略选择
- [ ] 每个模型行显示策略 badge（On / Off | high / max | All Levels）
- [ ] 点击 badge 弹出下拉，选择后更新该模型的 thinkingLevelMap
- [ ] hover badge 显示映射规则 tooltip

### AC-2: On / Off 策略
- [ ] 选择 On / Off 后保存
- [ ] InputToolbar picker 显示 Off / On（不是 off / xhigh）
- [ ] 选 On 发消息，模型使用最高思考强度

### AC-3: high / max 策略
- [ ] 选择 high / max 后保存
- [ ] InputToolbar 显示 off, high, xhigh
- [ ] 选 xhigh 发消息，API 收到 max

### AC-4: All Levels 策略
- [ ] 选择 All Levels 后保存
- [ ] InputToolbar 显示全部 6 个 level（off, min, low, med, high, xhigh）

### AC-5: 新模型默认 On / Off
- [ ] 自动发现/手动添加的模型默认策略为 On / Off
- [ ] badge 显示 On / Off

### AC-6: 不影响已有数据
- [ ] 已有 models.json 中的 thinkingLevelMap 不丢失
- [ ] 未配置过 thinkingLevelMap 的模型行为不变

### AC-7: 发送前自动同步 thinking level
- [ ] 发消息时自动先发 `session.setThinkingLevel`
- [ ] 选 On（xhigh）发消息时 thinking 生效
