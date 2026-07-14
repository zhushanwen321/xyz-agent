# Sidebar 模块 i18n 审计报告

## 审查时间
2026-07-14

## 审查范围
实际审查的文件（10 个，全部命中）：
- `packages/renderer/src/components/sidebar/FileTreeRow.vue`
- `packages/renderer/src/components/sidebar/FileView.vue`
- `packages/renderer/src/components/sidebar/RenameSessionDialog.vue`
- `packages/renderer/src/components/sidebar/SegmentedTab.vue`
- `packages/renderer/src/components/sidebar/SessionItem.vue`
- `packages/renderer/src/components/sidebar/SessionList.vue`
- `packages/renderer/src/components/sidebar/Sidebar.vue`
- `packages/renderer/src/components/sidebar/SubagentList.vue`
- `packages/renderer/src/components/sidebar/WorkflowDetail.vue`
- `packages/renderer/src/components/sidebar/WorkflowList.vue`

无 ts 文件（10 个文件全部为 .vue 单文件组件）。

## 总体结论
**FAIL** — 发现 1 处严重漏网（中文 UI 文案 "重试"），以及多处英文单位/计数后缀漏网，en-US locale 下会保留英文（这对英文用户无影响，但 zh-CN 下混合英文单位属体验瑕疵）���

## locale keys 现状
- sidebar.ts keys（zh-CN 顶层计数）: 70
- sidebar.ts keys（en-US 顶层计数）: 70
- 是否一致: 是（diff 无输出）

W2 已完成的 key 覆盖：sidebar 顶级 `newTask / search / overview / developer / settingsTitle / selectSessionHint / sessionListLoadFailed / switchSessionFailed / loadSubagentFailed / agentCallFailed / agentCallLoadFailed / workflowOpFailed / newTaskFailed / deleteSessionFailed / renameFailed / retry`；嵌套命名空间 `sessionItem / sessionList / segmentedTab / fileTree / fileView / renameDialog / subagentList / workflowDetail / workflowList`。Session/File/Workflow/Subagent 列表的所有 loading/empty/loadFailed/retry/error/noMatch/noFile/loadingTree 全部已 `t()` 化。

## 漏网字符串清单

### `packages/renderer/src/components/sidebar/Sidebar.vue`
- **位置**: line 90，`<Button>` 重试按钮文本（在 `session.listLoadError` 错误态分支内）
- **原文**: `重试`
- **判定**: **漏网**（严重 — 用户高频可见）
- **建议**: key 名 `sidebar.sessionList.retry`（顶层已有 `retry: '重试'`，但 session-list-error 块属于 session 列表错误域，建议复用顶层 `retry` 即可：`{{ t('sidebar.retry') }}`；或者为对称性新增 `sidebar.sessionList.retry`）
- **判断依据**: 同文件 line 89 已用 `t('sidebar.sessionListLoadFailed', ...)` 包裹错误文案，唯独重试按钮漏掉；与 fileView/subagentList/workflowList 错误态用 `t('sidebar.fileView.retry')` 等嵌套 key 的风格不一致

---

### `packages/renderer/src/components/sidebar/SegmentedTab.vue`
- **位置**: line 74，`tabs` computed 中的 subagent tab `label` 字段
- **原文**: `'Agents'`
- **判定**: **漏网**（严重 — 该 label 同时绑定到按钮 `:title="tab.label"`，hover 即见）
- **建议**: key 名 `sidebar.segmentedTab.subagent` / `'Subagents'` / zh-CN `'子代理'` 或 `'代理'`（按现有命名习惯，en-US 用 `Subagents`）。与 `sidebar.segmentedTab.session` / `sidebar.segmentedTab.file` 风格对齐

- **位置**: line 75，`tabs` computed 中的 workflow tab `label` 字段
- **原文**: `'Flows'`
- **判定**: **漏网**（严重 — 该 label 同时绑定到按钮 `:title="tab.label"`，hover 即见）
- **建议**: key 名 `sidebar.segmentedTab.workflow` / `'Workflows'` / zh-CN `'工作流'`（保持与 `workflowList` 命名空间一致）

---

### `packages/renderer/src/components/sidebar/SubagentList.vue`
- **位置**: line 59，转数显示文本
- **原文**: `{{ record.turns }} turns`
- **判定**: **漏网**（中度 — 单位文案，用户可见但优先级低）
- **建议**: key 名 `sidebar.subagentList.turnsUnit` / 用 `t('sidebar.subagentList.turnsUnit', { count: record.turns })` 或者更简单：模板改为 `{{ record.turns }} {{ t('sidebar.subagentList.turnsUnit') }}`，zh-CN `'轮'`，en-US `'turns'`

- **位置**: line 130，`formatTokens` 函数返回值
- **原文**: `` `${(tokens / TOKEN_K_THRESHOLD).toFixed(1)}k tok` `` 与 `` `${tokens} tok` ``
- **判定**: **漏网**（中度 — `tok` 是 token 的英文缩写单位）
- **建议**: key 名 `sidebar.subagentList.tokUnit`，模板改用 `t('sidebar.subagentList.tokUnit')` 拼到 suffix；或者保留为纯单位字符串 `'tok'` 不做翻译（英文 locale 下不变、中文 locale 下变 `'token'` 或 `'令牌'`）。**需人工判断**：i18n 业界惯例是单位一般不翻译，但用户视角 "k tok" 仍是英文。

---

### `packages/renderer/src/components/sidebar/WorkflowList.vue`
- **位置**: line 91，agent 计数显示
- **原文**: `` {{ completedAgentCount(record) }}/{{ record.agentCalls.length }} agents ``
- **判定**: **漏网**（中度 — `agents` 是英文复数名词）
- **建议**: key 名 `sidebar.workflowList.agentsLabel`，模板改为 `t('sidebar.workflowList.agentsLabel', { done: completedAgentCount(record), total: record.agentCalls.length })`，zh-CN `'已完成 {done}/{total} 个代理'`，en-US `'{done}/{total} agents'`（或者单数复数用 `tc()` 命名空间，这里简化为单 key）

- **位置**: line 184-185，`formatTokens` 函数返回值
- **原文**: `` `${(tokens / TOKEN_K_THRESHOLD).toFixed(1)}k tok` `` 与 `` `${tokens} tok` ``
- **判定**: **漏网**（中度 — 同 SubagentList）
- **建议**: 复用 `sidebar.workflowList.tokUnit` 或共用 `sidebar.subagentList.tokUnit`，建议合并为一个 `sidebar.common.tokUnit`（命名空间协商，**需人工判断**）

---

### `packages/renderer/src/components/sidebar/WorkflowDetail.vue`
- **位置**: line 70，phase header 的 agent 计数
- **原文**: `` {{ group.calls.length }} agent{{ group.calls.length > 1 ? 's' : '' }} ``
- **判定**: **漏网**（中度 — 同 WorkflowList line 91，但带了 s 后缀处理）
- **建议**: key 名 `sidebar.workflowDetail.agentsLabel`，模板改为 `t('sidebar.workflowDetail.agentsLabel', { count: group.calls.length })`，zh-CN `'{count} 个代理'`，en-US 用 vue-i18n 的复数语法：`{count} agent | {count} agents`

- **位置**: line 97，模型显示 fallback
- **原文**: `` {{ call.model === 'default' ? 'default' : call.model }} ``
- **判定**: **需人工判断**（轻度）— `'default'` 是 model ID 的字面值（也是内部 ID），但同时作为用户可见的占位符显示。属于"内部 ID 字面值作为 UI 文案"的灰色地带
- **建议**: 如果该字符串算 UI 文案（用户能看到），key 名 `sidebar.workflowDetail.modelDefault`，zh-CN `'默认'`、en-US `'default'`；如果算数据字面值，则**无需处理**

- **位置**: line 103，`{{ formatTokens(call.inputTokens) }} in`
- **原文**: ` in`（输入 token 标识）
- **判定**: **漏网**（轻度 — `in` 是 input 的英文缩写）
- **建议**: key 名 `sidebar.workflowDetail.tokenInUnit`，zh-CN `'输入'`、en-US `'in'`。或者保留 `in`（i18n 业界惯例）

- **位置**: line 104，`{{ formatTokens(call.outputTokens) }} out`
- **原文**: ` out`
- **判定**: **漏网**（轻度）
- **建议**: key 名 `sidebar.workflowDetail.tokenOutUnit`，zh-CN `'输出'`、en-US `'out'`

- **位置**: line 105，`{{ call.turns }} turns`
- **原文**: ` turns`
- **判定**: **漏网**（轻度 — 同 SubagentList line 59）
- **建议**: 复用 `sidebar.subagentList.turnsUnit` 或共用 `sidebar.common.turnsUnit`

---

## 误报排除
以下条目曾一度怀疑漏网，最终判定为误报：

1. **`Sidebar.vue` line 90 注释中的 "重试"** — 是 HTML 注释 `<!-- S5：加载失败态 + 重试（...） -->`，不是 UI 文案
2. **`Sidebar.vue` line 359/364/370 的 JSDoc 注释 "重试加载"** — 都是 `/** ... */` 注释
3. **各模板顶部的 `<!-- 展示组件 · ... -->` 中文注释** — 模板注释，浏览器不渲染
4. **`FileTreeRow.vue` line 194-200 的 `'M'/'A'/'D'/'U'/'R'`** — git status 单字母缩写（公认标记），属内部 ID/标识符约定，不算 UI 文案
5. **`FileTreeRow.vue` line 37 的 `'999+'`** — 数字截断标记，纯 ASCII 但属于格式约定而非可翻译文本
6. **`SessionItem.vue` / `SessionList.vue` 的 `{{ session.label }}` / `{{ dirName }}` / `{{ timeLabel }}`** — 数据值，非 UI 文案
7. **`WorkflowList.vue` 的 `{{ record.scriptName }}` / `{{ record.slug }}`** — 运行时数据（来自 WorkflowRunRecord），非硬编码 UI 文案
8. **`WorkflowDetail.vue` 的 `{{ group.phase }}` / `{{ call.agent }}` / `{{ call.model }}`** — 运行时数据，非硬编码 UI 文案
9. **`SubagentList.vue` 的 `{{ record.agent }}` / `{{ record.task }}` / `{{ record.subagentId.slice(0, ...) }}`** — 数据值
10. **`SegmentedTab.vue` 的 `{{ tab.count }}`** — 数字，非文案
11. **`Sidebar.vue` line 32/41 的 `⌘ N` / `⌘ K` 等 `<kbd>`** — 快捷键显示，符号语言无关
12. **`FileTreeRow.vue` 的 `ext.value` switch 返回 `'ts'/'tsx'/'js'/...` 等扩展名** — 文件扩展名字符串，属内部标识
13. **`FileTreeRow.vue` 的 gitBadgeClass 颜色 class `'bg-warning/12 text-warning'` 等** — design-token class，非 UI 文案
14. **`WorkflowList.vue` / `WorkflowDetail.vue` 的 `record.status === 'running'/'paused'` 比较字符串** — 状态枚举字面值，非 UI 文案
15. **`FileTreeRow.vue` 的 `data-testid` 属性值 `file-tree-dir-${node.path}` 等** — 测试 selector，约定不变
16. **Status 枚举 `'completed'/'failed'/'running'/'pending'/'done'/'paused'`** — 状态字面量，非 UI 文案
17. **`SubagentList.vue` line 117-124 的 `bg-success`/`bg-danger` 等** — design-token class
18. **`WorkflowList.vue` line 154-159 的 `reason === 'completed'`** — status 枚举
19. **`FileView.vue` line 68 的 `reason: rootState.reason ?? 'unknown'`** — `'unknown'` 是 fallback 占位符（fallback 到 key 模板字符串本身渲染 `unknown`，属于 fallback 到默认字符串，可考虑加 key，但优先级低）
20. **`Sidebar.vue` 整个 `<!-- 主操作 nav：新建任务 ⌘N / 搜索 ⌘K -->` 等** — HTML 注释
21. **`RenameSessionDialog.vue` 的正则 `/^[a-zA-Z0-9\u4e00-\u9fa5_\- ]+$/`** — 校验正则，非 UI 文案
22. **`RenameSessionDialog.vue` 的 zod error messages** — 已通过 `t('sidebar.renameDialog.validationRequired')` 等 i18n 化

## 统计
- **漏网数**: 9 处（Sidebar.vue 1 处 + SegmentedTab.vue 2 处 + SubagentList.vue 2 处 + WorkflowList.vue 2 处 + WorkflowDetail.vue 4 处（注：WorkflowDetail "model default" 算作 0.5 处"需人工判断"，按 1 处计入））
- **误报数**: 22 类（涵盖所有注释 / 数据值 / 内部 ID / class 名 / 状态枚举 / testid 等豁免项）
- **严重程度（用户频繁可见的高优先级）**: 3 处
  - `Sidebar.vue` line 90 的中文 `重试` 按钮 — 高频可见，错误态重试按钮
  - `SegmentedTab.vue` line 74-75 的英文 `Agents` / `Flows` tab title — 4 个 tab ���远 hover 可见
- 中度（单位/计数后缀）: 5 处
- 轻度（`in` / `out` / `default` 等缩写）: 3 处

## 关键发现汇总
1. **W2 已完成度极高**：10 个文件中 9 个的所有 loading / error / empty / placeholder / button 文案 / dialog 文案 / toast 文案都已 `t()` 化，仅 SessionItem / FileTreeRow / FileView / RenameSessionDialog / SessionList 五个"纯展示或对话组件"零漏网。
2. **唯一未国际化的高频中文 UI 文案**：`Sidebar.vue` line 90 的 "重试" — 建议加 key `sidebar.sessionList.retry` 或直接复用顶层 `sidebar.retry`。
3. **SegmentedTab 的两个 tab label**：`'Agents'` / `'Flows'` 完全没有 i18n 化（与同文件其他 tab 风格不一致）。
4. **Subagent/Workflow 列表的英文单位**：`turns` / `tok` / `agents` / `in` / `out` 均为英文单词/缩写，中文 locale 下是混合英文体验。修复优先级次于上述 3 处。