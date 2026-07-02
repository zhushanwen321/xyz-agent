---
verdict: pass
---

# 思考等级映射 + 模型选择联动 · 非功能设计

## 工程约束（已代码验证）

### N1: 展示是展示，传递 value 是 value
- **约束**：前端 UI 展示 ThinkingLevel 枚举值（含 max），发给 runtime/pi 的是 thinkingLevelMap 的 **value**（如 max 档发 xhigh），不是 key
- **为什么**：pi 不认识 max（pi 枚举是 off/minimal/low/medium/high/xhigh），直接发 max 会被 pi clamp 到其他档位。`resolveThinkingValue` 把 UI 档位 key 映射成 pi 认识的 value
- **验证**：`ThinkingLevelPopover.onSelect` emit `resolveThinkingValue(opt.level, map)`。`[from: 2026-07-02-thinking-level-and-model-select §nfr N1]`
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

### R2: xhigh 特殊逻辑未实现
pi 的 `getSupportedThinkingLevels` 对 xhigh 有特殊判定：`mapped !== undefined`（key 必须显式存在）。前端 `resolveAvailableLevels` 对所有档位统一处理，没区分 xhigh。在 xhigh 省略的配置下前端会判定可用，但 pi 判定不可用 → 不一致。
