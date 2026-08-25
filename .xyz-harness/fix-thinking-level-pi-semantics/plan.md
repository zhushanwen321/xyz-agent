# Plan: 前端思考档位复刻 pi getSupportedThinkingLevels 语义

## 业务目标

Settings 页 provider 从 pi 导入后，模型 thinking level 档位显示与 pi CLI 不一致。
实测（pi-ai 0.84.1 实装版探针）：`xiaomi-token-plan-cn/mimo-v2.5-pro` 在 pi 中可用档为
`off/minimal/low/medium/high` 五档；xyz-agent 前端显示全 6 档（off/low/medium/high/xhigh/max）。

根因链：

1. pi catalog 中该模型**无** `thinkingLevelMap` 字段；生成脚本 `gen-builtin-providers.mjs`
   用 `m.thinkingLevelMap ?? null` 把「字段缺失」归一成 `null` 落盘快照
   （1220 个 builtin 模型中 832 个为 null）。
2. runtime `toProviderModel`: `null ?? undefined` → 前端收到 undefined。
3. 前端 `resolveAvailableLevels(undefined)` 走「all-levels 全档」预设 → 全 6 档开放。

pi 权威语义（node_modules/@earendil-works/pi-ai/dist/models.js `getSupportedThinkingLevels`）：
`reasoning=false` 只 off；`mapped===null` 显式禁用；`xhigh/max` 需 map 显式定义才解锁；
其余档位（含 map 缺失时的 off..high）默认可用。pi 的 map 是**叠加禁用/映射**语义，
xyz-agent 现实现是**key 白名单**语义——例：`{"max":"max"}` 的模型 pi 下有 6 档可用，
xyz-agent 现状只显示 max 一档，同属本次修复范围。

方案决策（用户已确认 A1：忠实 pi 五档，不做 on/off 归并）：不做 deepseek-format
归并开/关——实测 39 个 deepseek-format 模型中 19 个经 getCompat 继承
`supportsReasoningEffort=true`（effort 作为 reasoning_effort 参数真实发出），归并会砍掉
真实分辨率。现有 `isOnOffMap`（显式二档 map → high 显示「开」）保持不动。

## 技术改动点

1. `packages/core/src/domain/composer/thinking-levels.ts`：
   - `THINKING_LEVELS` 枚举补 `minimal`（对齐 pi 7 值枚举；LEVEL_STRENGTH 补 minimal）
   - `resolveAvailableLevels(map?, reasoning?)` 复刻 pi 规则（见上）
   - `isSameThinkingScheme` / `highestAvailableLevel` 基于 resolveAvailableLevels 自动继承
   - `resolveThinkingKey` fallback 由硬编码 `'max'` 改为 `highestAvailableLevel(map)`
2. `packages/core/src/domain/composer/model-thinking.ts` + `thinking-level-sync.ts`：
   deps 增加可选 `getModelReasoning(modelId)` 注入；返回值增加 `currentModelReasoning`
3. `packages/renderer/src/composables/panel/composer-shell.ts`：同源新增
   `getThinkingReasoning` 回调（settingsStore.providers models[].reasoning 解析）并导出
4. `packages/renderer/src/components/panel/Composer.vue`：popover 新增 `:reasoning` 透传
5. `packages/renderer/src/components/panel/ThinkingLevelPopover.vue`：
   props 加 `reasoning?: boolean`，availableOptions 经 `resolveAvailableLevels(levelMap, reasoning)` 计算
6. i18n zh-CN/en-US 补 `composable.thinkingLevel.minimal`（zh「极简」/ en「Minimal」）

明确不做：不改 gen-builtin-providers.mjs 与快照 JSON；不做 on/off 归并；
不改 settings 写路径（isValidThinkingLevelMap 等）。

## Wave 拆分

| Wave | 改动文件 | 依赖 | 并行组 |
|------|----------|------|--------|
| W1 | packages/core/src/domain/composer/thinking-levels.ts, packages/core/src/domain/composer/__tests__/thinking-levels.test.ts | 无 | g1 |
| W2 | packages/core/src/domain/composer/model-thinking.ts, packages/core/src/domain/composer/thinking-level-sync.ts, packages/renderer/src/composables/panel/composer-shell.ts, packages/renderer/src/components/panel/Composer.vue, packages/renderer/src/components/panel/ThinkingLevelPopover.vue, packages/renderer/src/i18n/locales/zh-CN/settings.ts, packages/renderer/src/i18n/locales/en-US/settings.ts | W1 | g2 |

## 实现步骤

### W1: core 纯逻辑修复

1. THINKING_LEVELS 数组 minimal 插入 off 之后（level:'minimal', label:'极简', labelKey:'composable.thinkingLevel.minimal', en:'minimal'）；LEVEL_STRENGTH 补 minimal:1 并顺移后续档位
2. resolveAvailableLevels 增加 reasoning 可选参数，实现 pi 判定规则：reasoning===false → ['off']；map 缺失/空 → [off,minimal,low,medium,high]；逐档 mapped===null 跳过、xhigh/max 且 mapped===undefined 跳过；结果空 fallback ['off']
3. resolveThinkingKey 第三参 fallback 默认值改为 undefined 时取 highestAvailableLevel(map)
4. 新增/更新 core 单测覆盖 TC1 七条断言

### W2: renderer 接入 + i18n

1. model-thinking.ts ModelThinkingDeps 加 getModelReasoning?: (modelId) => boolean | undefined；返回对象加 currentModelReasoning computed（staging 态读快照模型）
2. thinking-level-sync.ts deps 同步加透传（如需在 sync 内判定可用档时用）
3. composer-shell.ts 从 settingsStore.providers 解析 models[].reasoning 注入回调；导出 currentModelReasoning 给 Composer.vue
4. Composer.vue 模板 ThinkingLevelPopover 加 :reasoning="currentModelReasoning"
5. ThinkingLevelPopover.vue props 加 reasoning?: boolean；availableOptions 改用 resolveAvailableLevels(props.levelMap, props.reasoning)
6. zh-CN/en-US i18n 文件补 composable.thinkingLevel.minimal
7. 修正受影响测试断言

## 单测用例清单（AC 级）

| 用例ID | 覆盖改动点 | 输入 | 预期 | 类型 |
|--------|-----------|------|------|------|
| U1 | thinking-levels.ts:resolveAvailableLevels | resolveAvailableLevels(undefined) | ['off','minimal','low','medium','high']（map 缺失默认五档，无 xhigh/max） | 正常 |
| U2 | thinking-levels.ts:resolveAvailableLevels | resolveAvailableLevels(undefined, false) | ['off']（non-reasoning 只 off） | 正常 |
| U3 | thinking-levels.ts:resolveAvailableLevels | resolveAvailableLevels({max:'max'}) | 含 off,minimal,low,medium,high,max 六档（叠加规则非白名单） | 正常 |
| U4 | thinking-levels.ts:resolveAvailableLevels | 所有 key 均为 null 的 map | ['off'] fallback（不返回空数组） | 边界 |
| U5 | thinking-levels.ts:isOnOffMap | isOnOffMap({off:'x',high:'y',minimal:null,low:null,medium:null}) | true（显式二档 on/off 不回归） | 正常 |
| U6 | thinking-levels.ts:resolveAvailableLevels | {xhigh:'xhigh',max:'max',其余未定义} | xhigh/max 两档可用；{high:'h'} 时两档不可用 | 边界 |
| U7 | thinking-levels.ts:THINKING_LEVELS | 遍历 THINKING_LEVELS | 含 level==='minimal' 且 LEVEL_STRENGTH.minimal 介于 off 与 low 之间 | 正常 |
| U8 | thinking-levels.ts:resolveThinkingKey | resolveThinkingKey('unknown-value',{low:'l'}) | 返回 highestAvailableLevel 结果 'high' 而非硬编码 'max' | 异常 |
| U9 | ThinkingLevelPopover.vue:availableOptions | mimo 场景 props.levelMap=undefined | 渲染 off/minimal/low/medium/high 五项，不含 xhigh/max | 正常 |
| U10 | i18n composable.thinkingLevel.minimal | 读 zh-CN/en-US locale 文件 | 两文件均存在 minimal key | 正常 |
| U11 | model-thinking.ts:useThinkingLevelSync | 模型从全档模型切到 mimo（map undefined） | 当前档位不可用时重置到 high（新语义最高档）而非报错 | 边界 |

用例落盘位置：U1-U8 → packages/core/src/domain/composer/__tests__/thinking-levels.test.ts；U9 → packages/renderer/src/__tests__/panel/thinking-levels.test.ts；U10 → packages/renderer/src/__tests__/i18n/thinking-levels-i18n.test.ts；U11 → packages/core/src/domain/composer/model-thinking.test.ts

## E2E 用例清单

本次为纯前端展示逻辑修复，vitest 组件级断言已覆盖用户可见行为（popover 渲染档位列表
即 DOM 断言），不新增 E2E。手工验收路径：dev 模式选中 xiaomi-token-plan-cn/mimo-v2.5-pro，
思考档位 popover 应显示 关/极简/低/中/高 五项（无 极高/最高）。

## 覆盖率 gate

```bash
cd packages/core && npx vitest run src/domain/composer --coverage --coverage.include='src/domain/composer/**' --coverage.thresholds.lines=60
cd packages/renderer && npx vitest run src/__tests__/panel/thinking-levels.test.ts --coverage --coverage.include='src/components/panel/**' --coverage.thresholds.lines=60
```

lines ≥ 60% 即通过（thinking-levels.ts 为纯函数域，TC1 七条断言覆盖全部分支）；两个包的 vitest 全绿是硬性前提，现有测试基线不回退。
