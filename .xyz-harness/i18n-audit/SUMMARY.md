# xyz-agent 前端 i18n 覆盖度二次审查（漏网之鱼）

## 审查时间
2026-07-14

## 审查方式
5 个 subagent 并行审计（每个模块一份报告），主 agent 汇总 + 抽样核实关键漏网点。

## 总体结论

**FAIL** — 上一轮 CW `i18n-frontend` topic (6 waves) 已完成 571 key 双 locale 对齐、~70 文件 ~320 处替换；但本次"漏网之鱼"审查发现 **30 处用户可见的硬编码字符串**（含 1 处真正的功能回归），按高/中/低优先级分布如下：

| 优先级 | 数量 | 主要场景 |
|---|---|---|
| 高（用户高频可见） | 17 | 按钮 / tab 标签 / 弹窗 / 状态 pill / overlay label / 数据源 label |
| 中 | 8 | 系统提示 / 计数 / 摘要 / 单位 |
| 需人工判断（数据源问题） | 2 | CommandPopover `'目录'` 字面量 / WorkflowDetail `'default'` ID |
| 低（英文单位/缩写） | 4 | `tok` / `in` / `out` / `turns` |

## 漏网清单总表（按模块）

### sidebar（9 处漏网）
- **Sidebar.vue:90** — `>重试<` 按钮（高）
- **SegmentedTab.vue:74-75** — `'Agents' / 'Flows'` tab title（高）
- **SubagentList.vue:59,130** — `turns` / `tok` 单位（中）
- **WorkflowList.vue:91,184-185** — `agents` / `tok` 单位（中）
- **WorkflowDetail.vue:70,103-106** — `agent(s)` / `in` / `out` / `turns` 单位（中-低）
- **WorkflowDetail.vue:97** — `'default'` 模型占位（需人工判断）

### panel + message-stream + detail-renderers（19 处漏网）
**高优先级（13 处）**：
- DetailPane.vue:24 `>Diff<` 按钮
- GitPanel.vue:86/93/99 `Stage / Unstage / Commit` 三按钮
- GitPanel.vue:151 git 状态 pill `Clean / Staged / Dirty / Conflict`
- Panel.vue:186-190 `Agent call · ${id}` / `Subagent` overlay 标签
- SideDrawer.vue:211/218/225/232/239 五个 tab label `Terminal / Browser / Git / Doc / Detail`
- AmbiguousFilePopover.vue:29 「X」有 N 个匹配... 标题
- Block.vue:49 `Subagent` 块 header

**中优先级（6 处）**：
- QueueBubble.vue:33 `{{ totalCount }} 条`
- BgNotifyCard.vue:131 patchHint
- SystemNotice.vue:32,37 压缩/分支系统提示
- Block.vue:64,250 `工具 ×N` / `X 等 N 个`
- Turn.vue:145,148 `思考 ×N` / `工具 ×N`

**需人工判断（1 处）**：
- CommandPopover.vue:190 `f.kind === '目录'` —— 数据源应改 enum 而非 UI i18n

### overlays/search（1 处关键回归）
- **SearchModal.vue:225** — `s.label === '最近'` 硬编码字面量与 i18n 后的 `s.label === t('search.recent')` 比较
  - **影响**: zh-CN 下表象正确（因为 `t('search.recent') === '最近'`），但 en-US 下 `t('search.recent') === 'Recent'`，AH-S3「最近分组恒显」语义破
  - **根因**: 上游 `useSearch.ts` 用 i18n 填充 label，下游 SearchModal 写死中文比较
  - **修复方向**: 给 `Section` 加稳定非本地化 `kind: 'recent' | 'suggested' | 'command' | 'file' | 'symbol' | 'session'` 字段，UI 用 `s.kind` 而非 label 比较

### new-task / workspace / overview / shell（0 漏网）
完整覆盖。`createBranchModal:74` 正则 `超时` 是检测 runtime 错误 message 的模式，非用户可见文案（误报）。

### extension（0 漏网）
完整覆盖。Extension 推送的运行时数据（question/option）属 extension 侧本地化责任。

### composables + stores（1 处跨范围漏网）
- **thinking-levels.ts:21-26, 85-86** — 8 个中文字面量 `'关/低/中/高/极高/最高/开/思考'` 作为 `THINKING_LEVELS[].label` / `mapThinkingLevel` fallback
- **消费点**: ProviderEditModal.vue:243 / 316 `s.fullLabel` 直接渲染该 label → en-US 下仍显示中文
- **影响**: Settings → Provider Edit 弹窗（高）、ThinkingLevelPopover / Composer（高）三处
- **修复方向**: 将 `label: '关'` 改为 `labelKey: 'composable.thinkingLevel.off'`，消费点 `t(s.labelKey)`

## 关键回归（影响功能正确性）

### 1. SearchModal "最近分组恒显" 失效 [HIGH]
- en-US 下用户切换 activeType 时，recents 分组不显示（因为 `s.label === '最近'` 永远 false）
- 期望：recents 跨类型恒显（AH-S3 设计意图）
- 根因：上下游对 section 标识不一致（上游 i18n、下游硬编码）
- 修复：Section 加 `kind` 字段（非本地化），UI 用 `kind === 'recent'` 比较

### 2. thinking-levels 数据源未国际化 [HIGH]
- en-US 下 Settings → Provider Edit 的"思考级别"下拉框仍显示中文"关/低/中/高/极高/最高"
- 根因：数据源 `THINKING_LEVELS` 直接存中文字面量 `label` 字段
- 修复：改为 i18n key 字段 + 消费点 `t()`

## 误报统计（避免重复审视）

| 模块 | 误报数 | 主要类型 |
|---|---|---|
| sidebar | 22 | 注释 / 数据值 / 内部 ID / design-token class / 状态枚举 / testid / 快捷键符号 |
| panel | 8 | 注释 / git 业内单字母 badge / 技术术语 / 跨范围备注 |
| multimodule | 7 | 注释 / console.error / 正则检测模式 |
| extension | 5 | 注释 / i18n 表达式被误抓 |
| composables | 8 | 开发者 invariant guard / 注释 / 内部枚举 |

合计误报约 50 类，全部按规则排除。

## locale keys 现状（双侧对齐）

| 文件 | zh-CN | en-US | 对齐 |
|---|---|---|---|
| app.ts | 6 | 6 | ✓ |
| common.ts | 25 | 25 | ✓ |
| composable.ts | 24 | 24 | ✓ |
| connection.ts | 10 | 10 | ✓ |
| extensionUI.ts | 8 | 8 | ✓ |
| newTask.ts | 23/31* | 23/31* | ✓ |
| overview.ts | 6 | 6 | ✓ |
| panel.ts | 216 | 216 | ✓ |
| search.ts | 21/22* | 21/22* | ✓ |
| settings.ts | 180 | 180 | ✓ |
| shell.ts | 8 | 8 | ✓ |
| sidebar.ts | 70 | 70 | ✓ |
| workspace.ts | 4 | 4 | ✓ |

*（行内 key 计数 vs 顶层 key 块数差异，详情见 multimodule.md 表格说明）

## 建议处理顺序

### P0 — 关键回归修复
1. **SearchModal.vue:225** — Section 加 `kind` 字段 + UI 用 kind 比较
2. **thinking-levels.ts** — 改 i18n key 字段 + ProviderEditModal 消费点确认

### P1 — 高优先级用户可见硬编码（按钮 / tab / 弹窗）
3. **Sidebar.vue:90** "重试" 按钮（复用顶层 `sidebar.retry`）
4. **SegmentedTab.vue:74-75** Agents/Flows tab
5. **GitPanel.vue:86/93/99** Stage/Unstage/Commit 三按钮 + 4 个状态 pill
6. **SideDrawer.vue:211/218/225/232/239** 五个 tab label
7. **Panel.vue:186-190** Agent call / Subagent overlay 标签
8. **DetailPane.vue:24** Diff 按钮
9. **Block.vue:49** Subagent 块 header
10. **AmbiguousFilePopover.vue:29** 歧义文件标题

### P2 — 中优先级（系统提示 / 计数 / 单位）
11. **QueueBubble.vue:33 / BgNotifyCard.vue:131 / SystemNotice.vue:32,37** 系统提示
12. **Block.vue:64,250 / Turn.vue:145,148** 计数 badge
13. **Sidebar 模块的单位（turns/tok/agents/in/out）** — i18n 业界惯例单位不翻译，但跨 locale 体验一致性需要决策

### P3 — 需人工判断（数据源设计问题）
14. **CommandPopover.vue:190 `f.kind === '目录'`** — 应改 file-candidates.ts 数据源返回 enum
15. **WorkflowDetail.vue:97 `'default'`** — 是 ID 还是 UI 文案需确认

## 子报告

- [sidebar.md](sidebar.md) — 10 个文件 / 9 处漏网 / 22 类误报
- [panel.md](panel.md) — 30 个文件 / 19 处漏网 / 8 类误报
- [multimodule.md](multimodule.md) — 14 个文件 / 1 处关键回归 / 7 类误报
- [extension.md](extension.md) — 3 个文件 / 0 漏网 / 5 类误报
- [composables.md](composables.md) — ~60 个文件 / 1 处跨范围漏网 / 8 类误报

## 结论

i18n-frontend CW topic（之前 6 waves）的覆盖率确实很高（571 key + 320 处替换 + 26 个 locale 文件），但本次审查暴露了**两类系统性盲点**：

1. **数据源层漏网**：`thinking-levels.ts` 存中文字面量、`CommandPopover` 用 `'目录'` 作为枚举判定 — 这种"不是 UI 直接渲染但被 UI 消费的字符串"是 W1-W6 阶段按"组件模板 + composable 文案"切片时漏掉的层
2. **下游对上游的隐式耦合**：`SearchModal` 假设上游返回的 label 是中文 — 上游 i18n 化后下游写死中文比较就成了 bug。这种"上下游口径不一致"在 i18n 化阶段不会自动暴露，需要在 commit 后做回归测试或静态分析才能发现

建议下一轮 CW topic 名为 `i18n-frontend-p2`（或 `fix-i18n-pass2`），按 P0 → P1 → P2 → P3 顺序补漏。