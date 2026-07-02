# ADR-0001: thinkingLevelMap 采用 key-based 判定（对齐 pi 语义）

- **Status**: accepted
- **Date**: 2026-07-02
- **From**: `2026-07-02-thinking-level-and-model-select §issues I4, §decisions D1/D4`

## 背景

pi 的 `thinkingLevelMap` 有两组值：
- **key** = pi 内部思考档位（`off/minimal/low/medium/high/xhigh`）
- **value** = 发给 provider API 的实际值（string = 可用，null = 不可用，omitted = 可用默认）

前端 `resolveAvailableLevels` 最初按 **value** 判定可用档位——遍历 map 的 value，非 null 的收集为 ThinkingLevel。这在 high-max 预设 `{high:'high', xhigh:'max'}` 上碰巧工作（value 'high'/'max' 恰好等于前端枚举名），但 on-off 预设 `{xhigh:'xhigh'}` 只有 xhigh 一档，其余档位 value=null 被判不可用，导致用户只能选一档。

更严重的问题：value-based 把 provider 值（如 'max'）当成 pi 档位名，语义完全错乱。pi 的 `setThinkingLevel(level: ThinkingLevel)` 期望接收 key（pi 档位名），provider 层内部自查 `thinkingLevelMap[key]` 取 value 发给 API。前端发 value 会导致 pi 存错值。

## 决策

`resolveAvailableLevels` 改为按 **key** 判定，与 pi `getSupportedThinkingLevels`（`packages/ai/src/models.ts:50`）完全一致：

```ts
for (const key of Object.keys(map)) {
  if (map[key] !== null && isThinkingLevel(key)) {
    available.add(key)  // key 是 pi 档位名
  }
}
```

配套决策：
- `useThinkingLevelSync` 的 watch 加 `{ immediate: true }`——Composer 挂载时立即对齐思考等级（landing 态初始设最高可用档）
- `ThinkingLevelPopover` 只渲染可用档位（`availableOptions` 过滤），不灰显不可用项

## 备选方案

**value-based**（被推翻）：遍历 value 收集可用档位。问题——value 是 provider 值不是档位名，语义错乱，且与 pi 判定逻辑不一致。

## 后果

- 所有预设/逻辑基于 key 空间（off/minimal/low/medium/high/xhigh）
- 前端 `ThinkingLevel` 枚举需注意：当前仍含 `max`（pi key 空间没有），实际不产生 max key 的配置（high-max 预设用 `max:'xhigh'` 是 key=max value=xhigh，但 pi 不认 max key——见残余风险）
- 切模型后思考等级自动重置逻辑可靠（key-based 判定与 pi 一致，不会误判）

## 残余风险

1. **前端枚举 max 不在 pi key 空间**：high-max 预设的 `{max:'xhigh'}` 用 `max` 作 key，但 pi 的 ThinkingLevel 枚举无 max。pi provider 层查 `thinkingLevelMap['xhigh']`（pi 存的 key）会找不到 max 这个 key 的映射。实际能工作是因为前端发的是 value（xhigh），pi 存 xhigh，provider 层查 `map['xhigh']`——但 map 里没有 xhigh key（只有 max key），会 fallback 默认映射。
2. **xhigh 特殊逻辑未实现**：pi 对 xhigh 要求 key 显式存在（`mapped !== undefined`），前端对所有档位统一处理，xhigh omitted 时前端判定可用但 pi 判定不可用。
