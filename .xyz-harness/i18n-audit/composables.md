# Composables + Stores 模块 i18n 审计报告

## 审查时间
2026-07-14

## 审查范围

按子目录分组：

**composables/panel/** (8 个)
- useMarkdownInteractions.ts
- useComposerModelThinking.ts
- useCodeblockCopy.ts
- useCommandPopoverTrigger.ts
- useComposerHistory.ts
- useContenteditableInput.ts
- useTurnElapsed.ts
- useThinkingLevelSync.ts

**composables/new-task/** (3 个)
- useNewTaskFlowState.ts
- useNewTaskBranch.ts
- useNewTaskDirSelect.ts

**composables/features/** (21 个)
- useFileChangeInvalidation.ts
- useChat.ts
- useModel.ts
- useSessionDerivations.ts
- useNewTaskFlow.ts
- useFileTree.ts
- useSubagentListSync.ts
- useSearch.ts
- useCommandRegistry.ts
- useWorkflowListSync.ts
- useAppCommands.ts
- useProviderEdit.ts
- useSearchJump.ts
- useDetailPane.ts
- useSettings.ts
- useGitStatus.ts
- useSidebar.ts
- useSessionEvents.ts
- useSideDrawer.ts
- useFileSearch.ts
- useRecents.ts

**composables/logic/** (12 个)
- path.ts
- formatTime.ts
- markdown.ts
- messageFormat.ts
- parseDiff.ts
- file-tree-utils.ts
- messageTurns.ts
- popover-styles.ts
- useFlatListNav.ts
- sessionStatus.ts
- mermaid.ts
- file-type.ts

**composables/** (顶层)
- useExtensionUI.ts
- useToast.ts
- useComposerChipCommands.ts
- useConnection.ts
- slashIcons.ts

**composables/effects/** (4 个)
- useChatScroll.ts
- usePlatformChrome.ts
- useMermaidZoom.ts
- useCopy.ts

**stores/** (15 个)
- fileSearch.ts
- panel.ts
- workspace.ts
- navigation.ts
- workflow.ts
- settings.ts
- chat.ts
- chat-changeset.ts
- chat-store-types.ts
- chat-chunk-processor.ts
- session.ts
- fileTree.ts
- chat-message-effects.ts
- command.ts
- subagent.ts
- chat-readers.ts
- sidebar.ts

## 总体结论

**FAIL** — W5 已覆盖 ~24 个 `composable.*` key（含 `agentProcessing` / `sendFailed` / `supplementSendFailed` / `nextTurnSendFailed` / `stopFailed` / `compactFailed` / `modelNameRequired` / `modelAlreadyExists` / `yesterday` / `daysAgo` / `dateFormat` 等）。整体覆盖度高，但 `thinking-levels.ts` 内 8-11 个中文字面量作为 `thinkingStrategies.fullLabel` 仍硬编码未走 i18n，导致上游 ProviderEditModal.vue（line 243、316）以及下游 ThinkingLevelPopover / Composer 等所有消费方在 en-US 下仍渲染中文。本质是**数据源（label 字段）而非 composable 调用点**漏网，composable 层无新增代码。

## locale keys 现状

- composable.ts (zh-CN): 24
- composable.ts (en-US): 24
- 是否一致: 是

W5 已覆盖 keys: agentProcessing / sendFailed / supplementSendFailed / nextTurnSendFailed / stopFailed / compactFailed / modelNameRequired / modelAlreadyExists / yesterday / daysAgo / dateFormat 等。

## 漏网字符串清单

### `components/panel/thinking-levels.ts` (跨范围备注，但与本审计强相关)

> 注：panel subagent 因该文件不在 30 文件清单内而归为"误报"。但本审计范围内 `composables/panel/` 不直接引用它，引用点在 `components/settings/ProviderEditModal.vue` line 243 / 316，列入主审计范围。

- **位置**: line 21-26 `THINKING_LEVELS` 数组
  ```ts
  { level: 'off', label: '关', en: 'off', available: true },
  { level: 'low', label: '低', en: 'low', available: true },
  { level: 'medium', label: '中', en: 'medium', available: true },
  { level: 'high', label: '高', en: 'high', available: true },
  { level: 'xhigh', label: '极高', en: 'xhigh', available: true },
  { level: 'max', label: '最高', en: 'max', available: true },
  ```
- **位置**: line 85-86 `mapThinkingLevel` fallback
  ```ts
  if (level === 'high' && isOnOffMap(map)) return '开'
  return THINKING_LEVELS.find((o) => o.level === level)?.label ?? '思考'
  ```
- **原文**: `'关' / '低' / '中' / '高' / '极高' / '最高' / '开' / '思考'`
- **判定**: **漏网（关键回归）**——ProviderEditModal.vue line 243 / 316 的 `s.fullLabel` 直接渲染该 label，en-US 下仍显示中文"关/低/中/高/极高/最高/开/思考"
- **建议**: 将 `THINKING_LEVELS` 改为引用 i18n key：
  ```ts
  { level: 'off', labelKey: 'composable.thinkingLevel.off', available: true },
  ...
  ```
  消费点改为 `t(s.labelKey)`。en-US 翻译：`off / low / medium / high / very_high / max`（中文保持原值）。
  或更彻底：把 `labelKey` 改成 `i18n.t` 直接调用的 derived computed。

### `composables/logic/formatTime.ts` 

已 W5 完整覆盖（`yesterday / daysAgo / dateFormat`），无漏网。

### `composables/features/useChat.ts`

已 W5 完整覆盖（`agentProcessing / sendFailed / supplementSendFailed / nextTurnSendFailed / stopFailed / compactFailed`），无漏网。

### `composables/features/useProviderEdit.ts`

已 W5 完整覆盖（`modelNameRequired / modelAlreadyExists`），无漏网。

### `composables/useConnection.ts`

已 W5 完整覆盖，无漏网。

### `composables/features/useSearch.ts` / `useSearchJump.ts` / `useAppCommands.ts` / `useWorkflowListSync.ts` / `useDetailPane.ts` / `useNewTaskFlow.ts` / `composables/useComposerChipCommands.ts` / `composables/logic/markdown.ts` / `composables/logic/messageFormat.ts` / `composables/logic/sessionStatus.ts` / `stores/chat-message-effects.ts`

W5 已完整覆盖，无漏网。

### `composables/panel/*` (8 个文件)

`useMarkdownInteractions / useComposerModelThinking / useCodeblockCopy / useCommandPopoverTrigger / useComposerHistory / useContenteditableInput / useTurnElapsed / useThinkingLevelSync` — 全部为 DOM 交互 / 状态同步 composable，无用户可见字符串，0 漏网。

### `composables/effects/*` (4 个文件)

`useChatScroll / usePlatformChrome / useMermaidZoom / useCopy` — 全部为副作用 composable，无用户可见字符串，0 漏网。

### `stores/*` (17 个文件)

所有用户可见文案均通过 composable 中转后注入 store，无 store 直接持有 UI 文案。0 漏网。

### `composables/features/useGitStatus.ts:190` / `useSidebar.ts:387` / `useSessionEvents.ts:66` / `useNewTaskBranch.ts:65/81/91/102/116` / `useNewTaskFlow.ts:154`

这些 `throw new Error(...)` 均为**开发者编程错误**（invariant guard），触发时是开发者 bug 而非用户可见错误。中文内容是开发诊断信息，不应 i18n 化（i18n 仅面向终端用户）。按规则豁免。

## ProviderEditModal.vue 同步消费点（重要）

文件：`components/settings/ProviderEditModal.vue`

- **位置**: line 243（左侧分组"模型级别"）
  ```vue
  <SelectItem v-for="s in thinkingStrategies" :key="s.key" :value="s.key">{{ s.fullLabel }}</SelectItem>
  ```
- **位置**: line 316（右侧分组"默认模型"）
  ```vue
  <SelectItem v-for="s in thinkingStrategies" :key="s.key" :value="s.key">{{ s.fullLabel }}</SelectItem>
  ```
- **判定**: **漏网（高优先级）** — `thinkingStrategies` 数组中的 `fullLabel` 直接来自 `thinking-levels.ts` 的硬编码中文字面量
- **建议**: 修复 `thinking-levels.ts` 后，此处消费点自动生效；不需要单独改 ProviderEditModal

> 旁证：panel subagent 报告中"高优先级漏网"提到 `CommandPopover.vue` 第 190 行的 `f.kind === '目录'`，与本审计范围内 composables 无关，但同属"数据源 i18n 化"问题，应一并修复。

## 误报排除

以下条目曾一度怀疑漏网，经核验归入误报：

1. **`composables/new-task/useNewTaskBranch.ts` line 65/81/91/102/116 `throw new Error('NewTaskFlow: 非 git 目录不可打开分支选择')` 等** — 开发者 invariant guard，触发时是编程错误而非用户场景。i18n 不覆盖此类诊断信息。
2. **`composables/features/useGitStatus.ts:190` `throw new Error('useGitStatusOrFail: GIT_STATUS_KEY 未注入')`** — 同上，组件架构错误，开发者诊断。
3. **`composables/features/useSidebar.ts:387` `throw new Error('fork: 该 session 缺少 piEntryId')`** — 同上。
4. **`composables/features/useSessionEvents.ts:66` `throw new Error('useSessionEvents 必须在组件 setup 同步阶段调用')`** — 同上。
5. **`composables/features/useNewTaskFlow.ts:154` `throw new Error('NewTaskFlow: 非 landing 态不可首发提交')`** — 同上。
6. **所有 composable 文件中的中文 JSDoc 注释** — 注释按规则豁免。
7. **`composables/logic/path.ts` / `file-tree-utils.ts` / `parseDiff.ts` / `messageTurns.ts` / `popover-styles.ts` / `useFlatListNav.ts` / `sessionStatus.ts` / `mermaid.ts` / `file-type.ts` / `slashIcons.ts`** — 中文仅出现在注释 / 类型定义 / 内部枚举，无用户可见文案。
8. **`stores/*` 中所有中文注释** — 注释按规则豁免。

## 统计

- **漏网数**: 1 处（`thinking-levels.ts` 的 8 个中文字面量作为 1 类漏网）
- **跨范围相关**: `ProviderEditModal.vue` line 243 / 316 是上述漏网的消费点（不算独立漏网，但需在修复时确认传导路径）
- **误报数**: 8 类（开发者 invariant + 注释 + 内部枚举）
- **严重程度（用户频繁可见的高优先级）**: 1 处
  - `thinking-levels.ts` 8 个中文 label — Settings → Provider Edit 弹窗与 ThinkingLevelPopover 用户高频可见

## 关键发现汇总

1. **W5 完成度极高**：24 个 `composable.*` key 完整覆盖所有 toast / error / time format 文案。
2. **唯一漏网根源在数据源**：`thinking-levels.ts` 用 `label` 字段直接存中文 label，没有走 i18n key 体系。修复方式是将 `label: '关'` 改为 `labelKey: 'composable.thinkingLevel.off'`，消费点改为 `t(s.labelKey)`。
3. **跨模块影响**：此漏网导致 `ProviderEditModal.vue` line 243/316 与 `ThinkingLevelPopover` 等所有渲染 `thinkingStrategies.fullLabel` 的位置在 en-US 下仍显示中文。
4. **invariant 错误不应 i18n 化**：所有 `throw new Error('NewTaskFlow: ...')` 等开发守卫保留中文作为开发者诊断信息是正确设计，无需改。
5. **stores 全部正确**：17 个 store 文件无直接持有 UI 文案，全部通过 composable 注入。