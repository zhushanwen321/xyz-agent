---
verdict: pass
---

# 思考等级映射 + 模型选择联动 · 决策账本

## D1: thinkingLevelMap key-based 判定 [D-不可逆, confirmed]

**决策**：resolveAvailableLevels 按 thinkingLevelMap 的 **key** 判定可用档位（key 存在且 value≠null），不按 value。

**备选**：value-based（遍历 value，非 null 的收集为可用档位）。

**取舍**：
- value-based 的致命问题：value 是 provider 值（发给 API 的），不是 pi 档位名。high-max 配置 `{high:'high', xhigh:'max'}` 的 value 是 'high' 和 'max'，但 pi 的档位是 high 和 xhigh。value-based 收集到 ['high','max'] 把 provider 值当档位名，语义错乱
- key-based 与 pi `getSupportedThinkingLevels`（models.ts:50）完全一致，pi 怎么判定前端就怎么判定

**后果**：所有预设/逻辑都基于 key 空间。前端枚举需对齐 pi key（off/minimal/low/medium/high/xhigh）。

**confirmed_by**：pi 源码 `packages/ai/src/models.ts:50` + `packages/agent/src/types.ts:284`
**source**：`[from: 2026-07-02-thinking-level-and-model-select §issues I4]`

---

## D2: 3 种思考模式预设 [D-可逆, confirmed]

**决策**：
- on-off: `{off:'off', high:'high'}` → UI 显示「关」「开」
- high-max: `{off:'off', high:'high', max:'xhigh'}` → UI 显示「关」「高」「最高」
- all-levels: `undefined` → 全档可用

**备选**：保留旧的 on-off 预设 `{minimal:null, low:null, medium:null, high:null, xhigh:'xhigh'}`（只有 xhigh 一档）。

**取舍**：旧 on-off 语义不明确（只有一档不叫"开/关"），用户明确要求「关和开」。

**confirmed_by**：用户 2026-07-02 确认「on/off 要改成开和关」
**source**：`[from: 2026-07-02-thinking-level-and-model-select §requirements G2]`

---

## D3: on-off 模式 high 档 label 动态显示「开」[D-可逆, confirmed]

**决策**：getDisplayLabel(level, map) 函数，当 map 只有 off+high 两档时 high→「开」，其余用通用 label「高」。

**备选**：所有模式统一用通用 label（high=高），on-off 模式显示「关」「高」。

**取舍**：用户明确要求 on/off 显示「开」而非「高」。动态 label 比 per-preset label 表更简单。

**confirmed_by**：用户 2026-07-02 确认
**source**：`[from: 2026-07-02-thinking-level-and-model-select §issues I6]`

---

## D4: useThinkingLevelSync watch immediate [D-不可逆, confirmed]

**决策**：watch currentThinkingLevelMap 加 `{ immediate: true }`，Composer 挂载时立即触发。

**备选**：不 immediate，只在 map 变化时触发。

**取舍**：landing 态 Composer 挂载时 currentThinkingLevelMap 首次求值，不 immediate 则 localThinkingLevel 保持 undefined，popover 显示 fallback 'max'（可能不在当前模型可用集）。immediate 保证挂载即对齐。

**confirmed_by**：单测 `use-thinking-level-sync.test.ts` 验证 landing 态初始设最高档
**source**：`[from: 2026-07-02-thinking-level-and-model-select §issues I3]`

---

## D5: input 字段全链路持久化 [D-可逆, confirmed]

**决策**：input 字段从 ProviderEditModal → SetProviderData 类型 → runtime setProvider 全链路传递。

**备选**：不持久化 input（只存配置文件，不通过 WS 传）。

**取舍**：行级 toggle 改 input 后保存丢失（全链路缺）。用户明确要求修复。

**confirmed_by**：WS 验证 5/5 passed（input 持久化 + 二次保存更新）
**source**：`[from: 2026-07-02-thinking-level-and-model-select §issues I7]`
