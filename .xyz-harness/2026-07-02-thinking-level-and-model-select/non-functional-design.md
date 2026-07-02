---
verdict: pass
---

# 思考等级映射 + 模型选择联动 · 非功能设计

## 工程约束（已代码验证）

### N1: 前端不做 key→value 映射，直接发 key 给 pi
- **约束**：sessionApi.setThinkingLevel 接收的 level 必须是 pi ThinkingLevel 枚举值（key），不是 map 的 value
- **为什么**：pi 内部 provider 层自查 map 取 value 发给 API（`thinkingLevelMap[level] ?? level`）。前端越权映射会导致 pi 存 value 而非 key，provider 层按 key 查不到
- **验证**：`ThinkingLevelPopover.onSelect` emit `resolveThinkingValue(opt.level, map)`——当前仍发 value（已知偏差，见残余风险 R1）
- **例外**：无

### N2: resolveAvailableLevels 按 key 判定（非 value）
- **约束**：thinkingLevelMap 的 key 存在且 value≠null → 可用；value=null → 不可用；key omitted → 可用（pi 默认）
- **为什么**：pi 的 `getSupportedThinkingLevels`（models.ts:50）就是按 key 判定。前端必须与 pi 一致
- **验证**：`thinking-levels.ts:resolveAvailableLevels` 遍历 `Object.keys(map)`，按 key 判定
- **例外**：xhigh 特殊——pi 要求 key 显式存在才可用（`mapped !== undefined`），前端未实现此特殊逻辑（见残余风险 R2）

### N3: useThinkingLevelSync watch immediate
- **约束**：watch currentThinkingLevelMap 必须 `{ immediate: true }`
- **为什么**：Composer 挂载时（landing 态）需立即设默认思考等级为当前模型最高可用档。不 immediate → localThinkingLevel 保持 undefined → popover 显示 fallback 'max'（可能不在当前模型可用集）
- **验证**：`useThinkingLevelSync.ts` watch 第三参数 `{ immediate: true }`
- **例外**：无

### N4: popover 只显示可用档位
- **约束**：availableOptions 过滤 THINKING_LEVELS 只保留 resolveAvailableLevels 返回的档位
- **为什么**：不可用档位灰显会让用户误以为可点。只显示可用的更干净
- **验证**：`ThinkingLevelPopover.vue:availableOptions` computed
- **例外**：无

## 残余风险

### R1: resolveThinkingValue 仍在用（发 value 而非 key）
当前 ThinkingLevelPopover.onSelect 仍调 `resolveThinkingValue(opt.level, map)` 发 value 给 runtime。这在 key≠value 的配置下（如 high-max 的 max 档 value=xhigh）会发错值给 pi。
**正确修法**：onSelect 直接 emit `opt.level`（key），不发 value。但当前未改（等用户确认全部对齐 pi 语义后再改）。

### R2: xhigh 特殊逻辑未实现
pi 的 `getSupportedThinkingLevels` 对 xhigh 有特殊判定：`mapped !== undefined`（key 必须显式存在）。前端 `resolveAvailableLevels` 对所有档位统一处理，没区分 xhigh。在 xhigh 省略的配置下前端会判定可用，但 pi 判定不可用 → 不一致。
