# ADR-0001: thinkingLevelMap key-based 判定 + value 映射语义

- **Status**: accepted
- **Date**: 2026-07-02
- **From**: `2026-07-02-thinking-level-and-model-select §issues I4, §decisions D1/D4`

## 背景

pi 的 `thinkingLevelMap` 有两组值：
- **key** = UI 可选档位（前端 ThinkingLevel 枚举值，含 max）
- **value** = 发给 runtime/pi 的实际 level（string = 可用，null = 不可用）

前端 `resolveAvailableLevels` 最初按 **value** 判定可用档位——遍历 map 的 value，非 null 的收集为 ThinkingLevel。这导致 high-max 预设 `{high:'high', max:'xhigh'}` 的可用档位被算成 `['high', 'xhigh']`（value 空间），而不是正确的 `['high', 'max']`（key 空间）。value-based 把 provider 值（如 'xhigh'）当成 UI 档位名，语义错乱。

## 核心原则

**展示是展示，传递 value 是 value——这是两回事。**

- **展示**：前端 UI 展示 ThinkingLevel 枚举值（off/low/medium/high/xhigh/max），max 显示「最高」
- **传递 value**：发给 runtime/pi 的是 thinkingLevelMap 的 **value**（如 max 档发 xhigh），不是 key
- `resolveThinkingValue` 做 key→value 映射，`resolveThinkingKey` 做 value→key 反查

## 决策

### 1. resolveAvailableLevels 按 key 判定

与 pi `getSupportedThinkingLevels`（`packages/ai/src/models.ts:50`）对齐：

```ts
for (const key of Object.keys(map)) {
  if (map[key] !== null && isThinkingLevel(key)) {
    available.add(key)  // key 是 UI 档位名（含 max）
  }
}
```

### 2. onSelect 发 value（通过 resolveThinkingValue）

```ts
emit('select', resolveThinkingValue(opt.level, props.levelMap))
// max 档 → emit 'xhigh'（pi 认识的值）
// high 档 → emit 'high'
```

**禁止直接发 key 给 pi**——pi 不认识 max（pi 枚举是 off/minimal/low/medium/high/xhigh），会 clamp 到其他档位。

### 3. 配套决策

- `useThinkingLevelSync` 的 watch 加 `{ immediate: true }`——Composer 挂载时立即对齐思考等级（landing 态初始设最高可用档）
- `ThinkingLevelPopover` 只渲染可用档位（`availableOptions` 过滤），不灰显不可用项
- `resolveThinkingKey` 把 runtime 返回的 value 反查回 UI key（如 xhigh→max），用于高亮 popover

## 备选方案

**前端枚举去掉 max，直接发 key**（被推翻）：pi 不认识 max，所以前端枚举去掉 max，直接发 key 给 pi。问题——spec 要求前端展示 max（「最高」），去掉 max 违反设计意图。正确做法是保留 max 作 UI 档位名，发 value（xhigh）给 pi。

## 后果

- 前端 `ThinkingLevel` 枚举保留 max（spec 要求展示「最高」）
- thinkingLevelMap 预设：`{off:'off', high:'high', max:'xhigh'}`——key 含 max，value 是 xhigh
- `resolveThinkingValue` 把 key 映射成 pi 认识的 value（max→xhigh）
- 切模型后思考等级自动重置逻辑可靠（key-based 判定 + value 映射）

## 残余风险

无。
