---
verdict: pass
---

# 思考等级映射 + 模型选择联动 · 代码架构

## 调用链：切模型 → 思考等级自动重置

```
Composer.vue
  │ currentModelId computed (active.modelId || flow.currentModel || defaultModel)
  │
  ├─→ useThinkingLevelSync(currentModelId, currentThinkingLevel, onReset)
  │     │
  │     ├─ currentThinkingLevelMap computed
  │     │    └─ settingsStore.providers → 按 modelId 解析 thinkingLevelMap
  │     │
  │     └─ watch(currentThinkingLevelMap, immediate)
  │          │ current = currentThinkingLevel.value
  │          │ if !current → onReset(resolveThinkingValue(highest, map))  ← landing 初始
  │          │ currentKey = resolveThinkingKey(current, map)              ← 反查 value→key
  │          │ if !available.includes(currentKey) → onReset(...)
  │          │   └─ Composer.onThinkingSelect(level)
  │          │        ├─ session 已建 → sessionApi.setThinkingLevel(sid, level)
  │          │        └─ landing → localThinkingLevel = level
  │          ▼
  │     currentThinkingLevelMap（返回给 Composer，传给 ThinkingLevelPopover）
  │
  ├─→ ThinkingLevelPopover(:level, :levelMap)
  │     │ availableOptions = THINKING_LEVELS.filter(available)
  │     │ level = resolveThinkingKey(props.level, props.levelMap)
  │     │ onSelect → emit resolveThinkingValue(opt.level, map)
  │     ▼
  └─→ Composer.onModelSelect（landing 分支）
        └─ flow.setPendingModel('provider/modelId')
             └─ submitFirstMessage create session 后 apply
```

## pi 侧调用链（源码验证）

```
set_thinking_level { level: KEY }
  → rpc-mode.ts:491 session.setThinkingLevel(command.level)
  → agent-session.ts:1535 setThinkingLevel(level: ThinkingLevel)
       │ getAvailableThinkingLevels() → getSupportedThinkingLevels(model)
       │   └─ models.ts:50 EXTENDED_THINKING_LEVELS.filter(...)
       │      mapped = model.thinkingLevelMap?.[level]
       │      mapped === null → false (不可用)
       │      level === 'xhigh' → mapped !== undefined (xhigh 需显式存在)
       │      else → true (可用)
       │
       │ effectiveLevel = available.includes(level) ? level : clampThinkingLevel(model, level)
       │ state.thinkingLevel = effectiveLevel
       │ emit thinking_level_changed
       ▼
  → provider 层 streamSimple(model, context, options)
       │ mapThinkingLevelToEffort(model, level)  ← anthropic.ts:716
       │   mapped = model.thinkingLevelMap?.[level]
       │   if typeof mapped === 'string' → return mapped  ← 用 value
       │   else → 默认映射 (high→high, medium→medium, low→low)
       ▼
  → API 请求（effort 字段）
```
