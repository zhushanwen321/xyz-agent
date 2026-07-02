---
verdict: pass
---

# 思考等级映射 + 模型选择联动 · 系统架构

## 1. 数据流（key-based 语义，pi 源码验证）

```
ProviderEditModal THINKING_PRESETS
  │  写入 models.json: thinkingLevelMap = { key: value | null }
  │  key = pi 档位（off/minimal/low/medium/high/xhigh）
  │  value = provider 实际值（string=可用, null=不可用）
  ▼
settingsStore.providers[].models[].thinkingLevelMap（runtime 广播）
  │
  ▼
resolveAvailableLevels(map)          ← 按 KEY 判定可用
  │  key 存在且 value≠null → 可用
  │  key omitted → 可用（除 xhigh 外，pi 默认全可用）
  │  value=null → 不可用
  ▼
ThinkingLevelPopover
  │  只渲染可用档位（availableOptions）
  │  label 用 getDisplayLabel：on-off 模式 high→「开」
  │  onSelect → emit KEY（pi 档位名，非 value）
  ▼
Composer.onThinkingSelect(level)     ← level 是 KEY
  │  session 已建 → sessionApi.setThinkingLevel(sid, key)
  │  landing 态 → localThinkingLevel = key（submitFirstMessage 后 apply）
  ▼
runtime rpc-client: set_thinking_level { level: key }
  │
  ▼
pi setThinkingLevel(key)             ← key 必须是 pi ThinkingLevel 枚举
  │  → getAvailableThinkingLevels() clamp
  │  → state.thinkingLevel = key
  ▼
pi provider 层（anthropic.ts:720）
  effort = thinkingLevelMap[key]      ← pi 自己查 map 取 value
  if typeof effort === 'string' → 发 value 给 API
  else → 用默认映射（key→effort）
```

## 2. 关键模块

| 模块 | 职责 | 文件 |
|------|------|------|
| thinking-levels.ts | 纯函数：resolveAvailableLevels/getDisplayLabel/resolveThinkingValue | `src/components/panel/thinking-levels.ts` |
| useThinkingLevelSync | 切模型后自动重置思考等级（immediate watch） | `src/composables/panel/useThinkingLevelSync.ts` |
| ThinkingLevelPopover | popover UI：只显示可用档 + 动态 label | `src/components/panel/ThinkingLevelPopover.vue` |
| ProviderEditModal | provider 配置：THINKING_PRESETS（3 模式） | `src/components/settings/ProviderEditModal.vue` |
| useNewTaskFlow | landing 态 pendingModel + pendingThinkingLevel | `src/composables/features/useNewTaskFlow.ts` |

## 3. 3 种预设模式

| 模式 | UI label | thinkingLevelMap | pi key | 可选档位 |
|------|---------|-----------------|--------|---------|
| all-levels | 全档 | undefined | off/minimal/low/medium/high/xhigh | 6 档 |
| on-off | 关/开 | {off:'off', high:'high'} | off, high | 2 档（high→「开」） |
| high-max | 关/高/最高 | {off:'off', high:'high', max:'xhigh'} | off, high, max | 3 档 |
