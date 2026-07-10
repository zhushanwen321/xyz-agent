# 修复方案：Composer 模型/思考等级 per-session 隔离 + 跨体系思考等级映射

## 问题一：Split panel 时两个 composer 模型/思考等级全局共享（bug）

### 根因
`useComposerModelThinking.ts:45-60` 的 `currentThinkingLevel` / `currentModelId` 两个 computed 读的是 `sessionStore.active`（全局焦点 session，由模块级单例 `activeId` 派生），而非按组件自身的 `sessionId` prop 查真值。split 下 `activeId` 永远只指向聚焦的那个 panel，非聚焦 panel 的 Composer 显示的是另一个 panel 的值。

底层数据已 per-session（`SessionSummary.modelId/thinkingLevel` + `updateSessionState(id, ...)` + 按 sessionId 广播），只差读取层接对数据源。

### 修复
**文件：`packages/renderer/src/composables/panel/useComposerModelThinking.ts`**

`currentModelId` 和 `currentThinkingLevel` 改为按 `sessionId` 从 `sessionStore.list` 查真值：

```ts
// 按 sessionId 查 session 真值（split 下每个 panel 读自己的），landing 态（sessionId=null）返回 null
const sessionState = computed(() =>
  sessionId.value
    ? sessionStore.list.find((s) => s.id === sessionId.value) ?? null
    : null,
)

const currentModelId = computed(
  () => sessionState.value?.modelId
    || flow.currentModel.value
    || settingsStore.defaultModel
    || '',
)

const currentThinkingLevel = computed(
  () => sessionState.value?.thinkingLevel ?? localThinkingLevel.value,
)
```

`onModelSelect` / `onThinkingSelect` 的已建态分支已经是按 `sessionId.value` 调 RPC（`:80, :91`），不用改。

**文件：`packages/renderer/src/composables/features/useModel.ts:17`**
注释提到「乐观更新写 sessionStore.active.modelId」，实际代码是 `updateSessionState(sessionId, ...)`（按 id 写）。修正注释为「写 sessionStore 对应 session（按 id）」。

### 不动的部分
- `Sidebar.vue:189` 的 `session.active` —— sidebar 显示全局焦点 session，应跟着焦点，不改
- `useNewTaskFlowState.ts:94` 的 `pendingModel` 模块级单例 —— v1 双 panel 不会两个同时 landing（第二 session 来源 DEFERRED），是理论隐患不在本次修复范围

---

## 问题二：跨体系模型切换时思考等级映射不符合期望

### 期望语义（用户确认）
1. 先判断两个模型的思考体系是否一样
2. 体系一样 → 直接映射（保留当前档位）
3. 体系不一样 → 切换到目标体系的最高档

### 「体系」的定义
**两个 map 的可用档位 key 集合相同 → 同体系。** 不依赖 `ThinkingStrategy` 预设枚举（map 是自由格式 `Record<string, string | null>`，用户可自定义），对自定义 map 也成立。

验证覆盖：
- on-off `{off,high}` vs high-max `{off,high,max}` → key 集合不同 → 跨体系 → 重置到 high-max 最高档 max ✓
- on-off vs on-off → 同体系 → 直接映射 ✓
- all-levels(`undefined`) vs all-levels(`undefined`) → 都是全档 → 同体系 ✓
- on-off vs all-levels → 跨体系 → 重置 ✓

### 当前逻辑的问题
`useThinkingLevelSync.ts:53-68` 的 watch 只判断「当前 key 是否在新模型可用」，而 on-off 的 `high` 和 high-max 的 `high` 共享同一个 key → 被判定为可用 → 不重置 → on 不会升级到 max。

### 修复
**文件：`packages/renderer/src/composables/panel/useThinkingLevelSync.ts`**

watch 改为同时拿新旧 map，按体系判定：

```ts
watch(currentThinkingLevelMap, (map, oldMap) => {
  const current = currentThinkingLevel.value
  if (!current) {
    // landing 态初始无思考等级 → 设为新模型最高可用档（不变）
    const highest = highestAvailableLevel(map)
    onReset(resolveThinkingValue(highest, map))
    return
  }
  // 体系判定：新旧 map 可用 key 集合相同 → 同体系，直接映射当前 key 到新模型 value
  const sameScheme = isSameThinkingScheme(oldMap, map)
  if (sameScheme) {
    const currentKey = resolveThinkingKey(current, oldMap)
    const newValue = resolveThinkingValue(currentKey, map)
    // value 变了才重置（同体系同 value 时不触发冗余 RPC）
    if (newValue !== current) onReset(newValue)
    return
  }
  // 跨体系 → 重置到新模型最高可用档
  const highest = highestAvailableLevel(map)
  onReset(resolveThinkingValue(highest, map))
}, { immediate: true })
```

**文件：`packages/renderer/src/components/panel/thinking-levels.ts`**

新增纯函数 `isSameThinkingScheme`：

```ts
/**
 * 判断两个 thinkingLevelMap 是否属于同一思考体系（可用档位 key 集合相同）。
 * 用于模型切换时判定思考等级是否可直接映射：同体系直接映射，跨体系重置到最高档。
 * undefined/空 map 视为全档可用（all-levels），两个全档视为同体系。
 */
export function isSameThinkingScheme(
  a?: Record<string, string | null>,
  b?: Record<string, string | null>,
): boolean {
  const keysA = resolveAvailableLevels(a)
  const keysB = resolveAvailableLevels(b)
  return keysA.length === keysB.length && keysA.every((k) => keysB.includes(k))
}
```

复用已有 `resolveAvailableLevels`（按可用 key 判定，空 map → 全 6 档），不引入新概念。

### 为什么用 key 集合而非 ThinkingStrategy 枚举
`thinkingLevelMap` 是自由格式 `Record<string, string | null>`，`getStrategyFromMap` 只能识别三个预设。用户在 config 里写 `{off, high, xhigh}`（无 max）会被 `getStrategyFromMap` 误判为 on-off，但它和真正的 on-off `{off, high}` 是不同体系。key 集合判定对所有 map 都准确。

---

## 测试

### 问题一测试
**文件：`packages/renderer/src/__tests__/composables/use-composer-model-thinking.test.ts`**（新增或补充）

新增 split panel 场景：
- mount 两个 `useComposerModelThinking` 实例，传不同 sessionId
- 两个 session 的 modelId/thinkingLevel 不同
- 断言两个实例的 `currentModelId` / `currentThinkingLevel` 各自独立，不串读
- 切换其中一个的模型，另一个不受影响

### 问题二测试
**文件：`packages/renderer/src/__tests__/composables/use-thinking-level-sync.test.ts`**（补充）

新增用例：
- A(on-off, level=high 即"on") → B(high-max)：跨体系 → 重置到 max（value=`xhigh`）← **核心回归用例，当前会失败**
- A(high-max, level=xhigh) → B(on-off)：跨体系 → 重置到 high（已有，保留）
- A(on-off) → B(on-off)：同体系 → 直接映射，不重置
- A(high-max, level=high) → B(high-max)：同体系 → 直接映射，不重置
- A(all-levels) → B(all-levels)：同体系 → 直接映射，不重置
- A(on-off) → B(all-levels)：跨体系 → 重置到 max

**文件：`packages/renderer/src/__tests__/panel/thinking-levels.test.ts`**（补充）
- `isSameThinkingScheme` 单元测试：同 key 集合 → true；不同 → false；undefined 双方 → true；一方 undefined → false

测试框架 vitest，运行 `npx vitest run <file>`。

---

## 改动文件清单
| 文件 | 改动 |
|---|---|
| `composables/panel/useComposerModelThinking.ts` | currentModelId/currentThinkingLevel 改读 sessionState（按 sessionId 查） |
| `composables/panel/useThinkingLevelSync.ts` | watch 加体系判定逻辑 |
| `components/panel/thinking-levels.ts` | 新增 `isSameThinkingScheme` 纯函数 |
| `composables/features/useModel.ts` | 修正注释（active → 按 id） |
| `__tests__/composables/use-thinking-level-sync.test.ts` | 补充跨体系映射用例 |
| `__tests__/panel/thinking-levels.test.ts` | 补充 isSameThinkingScheme 用例 |
| `__tests__/composables/use-composer-model-thinking.test.ts` | 补充 split panel 隔离用例（如文件不存在则新建） |

## 执行顺序
1. 先改 `thinking-levels.ts`（新增纯函数，无依赖）
2. 改 `useThinkingLevelSync.ts`（依赖 1）
3. 改 `useComposerModelThinking.ts`（独立于 1/2）
4. 改 `useModel.ts` 注释
5. 补测试
6. `npx vitest run` 跑全量回归