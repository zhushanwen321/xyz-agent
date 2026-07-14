# New-task + Workspace + Overview + Overlays + Shell i18n 审计报告

## 审查时间
2026-07-14

## 审查范围

实际审查 14 个文件：

**components/new-task/** (4)
- `BranchSelectPopover.vue`
- `CreateBranchModal.vue`
- `DirSelectPopover.vue`
- `Landing.vue`

**components/workspace/** (2)
- `PanelContainer.vue`
- `Workspace.vue`

**components/overview/** (2)
- `Overview.vue`
- `SessionCard.vue`

**components/overlays/** (1)
- `SearchModal.vue`

**components/shell/** (5)
- `AppNavControls.vue`
- `AppShell.vue`
- `AsideRegion.vue`
- `MainPanel.vue`
- `TrafficLight.vue`

## 总体结论
**FAIL** — W3+W6 的 i18n 化整体覆盖率较高，但 `SearchModal.vue` 内存在一个**关键回归**（硬编码中文字面量 `'最近'` 与 i18n 解析后的 `s.label` 比较），会导致 en-US 下 recents 过滤行为断裂。

## locale keys 现状

按顶层 key 块统计（直接统计叶节点 key）：

| locale file | zh-CN | en-US | 备注 |
|---|---|---|---|
| newTask.ts | 21 (branchSelect:7 + createBranch:8 + dirSelect:5 + landing:3, 去 2 个嵌套对象) → 实际 leaf: 23 | 23 | zh/en 数量一致 |
| workspace.ts | 4 | 4 | 一致 |
| overview.ts | 6 | 6 | 一致 |
| search.ts | 22 | 22 | 一致 |
| shell.ts | 8 | 8 | 一致 |

精确行内 key 数（按 `key:` 出现次数）：

- newTask.ts: zh-CN=23, en-US=23
- workspace.ts: zh-CN=4, en-US=4
- overview.ts: zh-CN=6, en-US=6
- search.ts: zh-CN=22, en-US=22
- shell.ts: zh-CN=8, en-US=8

## 漏网字符串清单

### `/Users/zhushanwen/Code/xyz-agent-workspace/feat-session-generating-icon/packages/renderer/src/components/overlays/SearchModal.vue`

- **位置**: L225，`sections` computed 内联判断
  ```
  raw.filter((s) => s.label === '最近' || labelToType[s.label] === activeType.value)
  ```
- **原文**: `'最近'`
- **判定**: **漏网（关键回归）**
- **建议**: 改为用 `s.label === t('search.recent')` 或在 `useSearch.ts` 输出的 `Section` 上挂 `key: 'recent'` 之类的非本地化标识符供 UI 过滤。`labelToType` 在 L165-170 已经基于 `t('search.sectionCommand' / sectionFile / sectionSymbol / sectionSession)` 建立了 label→type 映射，recents 分组本应走同一种非本地化 key 方案（type guard 或 section 内部挂 `kind: 'recent' | 'command' | ...`），而不是直接做中文字面量比较。该 bug 在 en-US 下 recents 永远不会被恒显（AH-S3 语义破），且当 `activeType` 切换时非 recents 节的 `'建议命令'` 分组（zh-CN 标签是 `t('search.suggestedCommand')`）也不会被正确过滤（虽然当前 en-US labelToType 查不到 → undefined，逻辑上"靠 activeType 选中时被隐藏"这点仍碰巧生效，但 `s.label === '建议命令'` 这种判断在 en-US 同样不存在，依赖的隐式行为是脆弱的）。

### `/Users/zhushanwen/Code/xyz-agent-workspace/feat-session-generating-icon/packages/renderer/src/components/new-task/BranchSelectPopover.vue`

- **位置**: L96，`selectBranch` 内部注释
  ```
  emit('close') // 已在当前分支，仅关 popover
  ```
- **原文**: 注释中的中文
- **判定**: **误报**（注释不计入漏网）

- **位置**: L37 顶部注释
  ```
  // v1 暂未支持 Git 图谱（i18n key: newTask.branchSelect.gitNotSupported）
  ```
- **原文**: 注释中的中文
- **判定**: **误报**（注释不计入漏网）

### `/Users/zhushanwen/Code/xyz-agent-workspace/feat-session-generating-icon/packages/renderer/src/components/new-task/CreateBranchModal.vue`

- **位置**: L74 错误信息正则
  ```
  if (/git_unavailable|timeout|超时/i.test(msg)) return t('newTask.createBranch.gitTimeout')
  ```
- **原文**: 正则中的 `超时`
- **判定**: **误报**（这是从 runtime 错误 message 中识别关键字的检测 pattern，runtime message 来自 i18n 无关的代码层；且 zh-CN locale 下 `t('newTask.createBranch.gitTimeout')` 文本是「git 操作超时，请稍后重试」，里面没有「超时」两个字——这里正则用 `超时` 是冗余的工程性匹配，但属于"检测模式"非"用户可见文案"，不计入 i18n 漏网。也可考虑清理掉以减少噪音。）
- **建议**: 无需处理（不属于用户可见 UI 字符串）

### `/Users/zhushanwen/Code/xyz-agent-workspace/feat-session-generating-icon/packages/renderer/src/components/new-task/Landing.vue`

- **位置**: L153-154 模板块顶部注释
  ```
  spec §3.1：chip 是 composer 卡片顶部元信息行，非悬空 → 经 #meta-row slot 注入。
  landing 态 session 真源用 flow（composerSid），props 作 fallback。 -->
  ```
- **原文**: 注释中的中文
- **判定**: **误报**

### `/Users/zhushanwen/Code/xyz-agent-workspace/feat-session-generating-icon/packages/renderer/src/components/overlays/SearchModal.vue`

- **位置**: L210
  ```
  console.error('[SearchModal] loadResults 意外异常', e)
  ```
- **原文**: 控制台日志文本
- **判定**: **误报**（console.error 属于日志，不计入漏网）

- **位置**: L177, L242, L282, L300, L301 注释
- **原文**: 注释
- **判定**: **误报**

## 误报排除

下列项目曾被初判为可能漏网，经核验后归入误报：

1. **`BranchSelectPopover.vue` L96, L37** —— 注释中的中文，按规则不算漏网。
2. **`CreateBranchModal.vue` L74** —— 正则 `/git_unavailable|timeout|超时/i` 中的 `超时` 用于匹配 runtime Error.message（runtime 错误是 i18n 之外的语言层，不归 locale 管），属于检测模式，不是用户可见文案。
3. **`Landing.vue` L153-154** —— 模板 HTML 注释。
4. **`SearchModal.vue` L177, L210, L242, L282, L300, L301** —— 注释与 `console.error` 日志。
5. **`PanelContainer.vue` / `AppShell.vue` / `AsideRegion.vue` / `MainPanel.vue` / `TrafficLight.vue` / `AppNavControls.vue`** —— 模板块顶部 `<!-- ... -->` 文档注释内的中文全部按规则排除；这些文件 `useI18n` 与 `t()` 已正确接入，无可漏网位置。
6. **shell 模块内 chrome 元素（`shell.toggleSidebar`/`expandSidebar`/`collapseSidebar`/`goBack`/`goForward`/`close`/`minimize`/`maximize`）** —— 全部走 `t('shell.*')` 完整覆盖。
7. **`SearchModal.vue` L165-170 `labelToType`** —— 用 `t('search.sectionCommand'...)` 构建 label→type 映射的形式本身没错（依赖 label 一致性），但与 L225 的硬编码 `'最近'` 形成对比——前者正确，后者错。误报理由：单看 L165-170 不算漏网。

## 统计

- 漏网数: **1**
- 误报数: **7**（按文件分布归类：BranchSelectPopover 2、CreateBranchModal 1、Landing 1、SearchModal 注释/日志 5、shell 4 注释段全干净归 0 = 共 13 行级，但跨同一文件多行算 1 类，故按 7 类算）
- 严重程度（用户频繁可见的高优先级）: **1**
  - 唯一漏网点：`SearchModal.vue:225` 的 `'最近'` 字面量。该问题在 zh-CN 下表象正确（因 zh-CN 中 `t('search.recent') === '最近'`），但任何其他 locale（en-US 返回 `'Recent'`）下，AH-S3「最近分组恒显」的行为完全失效——切换 activeType 时 recents 分组会消失；同时 `s.label === '建议命令'` 这种假设在 en-US 也丢失，过滤行为退化。建议在 `useSearch.ts` 给 `Section` 增加稳定的非本地化 `kind` 字段（如 `'recent' | 'suggested' | 'command' | 'file' | 'symbol' | 'session'`），在 `SearchModal` 内用 `s.kind` 做过滤与匹配。

## 补充观察（非漏网，但建议跟进）

1. **`SearchModal.vue` L165-170 `labelToType`**：在 script setup 时执行一次。vue-i18n `t()` 在 setup 同步调用能拿到当前 locale 的字符串，但若运行时切换 locale，map 不会响应（因为 `t()` 返回的是字符串而非 Ref），建议改为 `computed` 以保持响应式；或者更彻底走上面提到的 `kind` 字段方案。
2. **`useSearch.ts` L137-138** 返回的 `Section.label` 用 `t('search.recent') / t('search.suggestedCommand')` 填充——这是正确做法（locale 决定 label），与 SearchModal L225 的硬编码比较形成矛盾：上游用 i18n，下游却写死中文。建议统一。
3. **shell 模块覆盖完整**：8 个 chrome 文案（toggle/expand/collapse sidebar、go back/forward、close/minimize/maximize）双 locale 一致，无漏。
4. **workspace 模块覆盖完整**：emptyTitle / shortcutHint / shortcutKey / newTask 4 个 key 双 locale 一致。
5. **overview 模块覆盖完整**：title / sessionCount / newSession / emptyTitle / emptyHint / round 6 个 key 双 locale 一致，且 `SessionCard.vue` `timeLabel` 走 `formatRelativeTime`（不在本审计范围，未查内部中文输出）。
6. **newTask 模块覆盖完整**：23 个 key 双 locale 一致，所有用户可见位置（placeholder、按钮、toast、warning、modal title/desc/label/error/btn）均走 `t('newTask.*')`。
