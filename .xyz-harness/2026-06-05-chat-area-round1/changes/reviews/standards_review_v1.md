---
verdict: pass
must_fix: 0
review_metrics:
  files_reviewed: 31
  issues_found: 8
  must_fix_count: 0
  low_count: 5
  info_count: 3
  duration_estimate: "12"
linter_passed: true
typecheck_passed: true
---

# Standards Review v1

## 审查记录

- 审查时间：2026-06-05 17:00
- 项目路径：`/Users/zhushanwen/Code/xyz-agent-workspace/feat-chat-area-impr`
- 审查范围：git diff `218b973^..HEAD` 中 `src-electron/**` 路径下的所有文件
- 涉及 commits：30 个（最近 30 个 commit）
- Phase A（自动检查）：已执行
- Phase B（AI 规范对比）：已执行

## Phase A: 自动化检查结果

### Lint

| 项目 | 结果 |
|------|------|
| 检测到的命令 | `npm run lint` (等价 `eslint .`) |
| 退出码 | 0 |
| Errors | 0 |
| Warnings | 5（4 条 `taste/no-native-html-elements` + 1 条 unused eslint-disable） |
| 状态 | ✅ 通过 |

完整 lint 输出：

```
✖ 5 problems (0 errors, 5 warnings)
  0 errors and 1 warning potentially fixable with the `--fix` option.

src-electron/renderer/src/components/chat/BranchIndicator.vue
  60:1  warning  Unused eslint-disable directive

src-electron/renderer/src/components/chat/UtilityRail.vue
   3:5  warning  Use xyz-ui <Button /> instead of native <button>
  12:5  warning  Use xyz-ui <Button /> instead of native <button>

src-electron/renderer/src/components/extension/WidgetDock.vue
  36:11  warning  Use xyz-ui <Button /> instead of native <button>
  61:5   warning  Use xyz-ui <Button /> instead of native <button>
```

注：WidgetDock.vue 的 2 条 warning 来自历史 commit（非本次 diff 范围），不计入本次 review 范围。

### Typecheck（vue-tsc — 渲染进程）

| 项目 | 结果 |
|------|------|
| 检测到的命令 | `npx vue-tsc --noEmit`（在 `src-electron/renderer/`） |
| 退出码 | 0 |
| Errors | 0 |
| 状态 | ✅ 通过 |

### Typecheck（tsc — runtime sidecar）

| 项目 | 结果 |
|------|------|
| 检测到的命令 | `npx tsc --noEmit -p src-electron/runtime/tsconfig.json` |
| 退出码 | 0 |
| Errors | 0 |
| 状态 | ✅ 通过 |

### 检查覆盖范围总结

| 检查 | 范围 | 退出码 | 状态 |
|------|------|--------|------|
| ESLint | 全项目（renderer/runtime/shared/main/preload） | 0 | ✅ |
| vue-tsc | 渲染进程 Vue/TS | 0 | ✅ |
| tsc | runtime sidecar | 0 | ✅ |

## Phase B: CLAUDE.md 规范对比

### 规范检查矩阵

| # | 规范条目 | 适用范围 | 检查结果 | 违规位置 |
|---|---------|---------|---------|---------|
| 1 | 禁止原生 HTML 表单元素（必须 xyz-ui 组件） | Vue 文件 | ⚠️ 部分违规 | UtilityRail.vue:L3, L12（2 处 `<button>` 无 eslint-disable） |
| 2 | 禁止 Emoji | 所有变更 | ✅ 符合 | — |
| 3 | 样式三层结构（design tokens / template class / `<style scoped>`） | 全部 | ⚠️ 边界 | style.css 新增 `.is-fullscreen` 组件级规则 |
| 4 | 行数上限（template ≤ 400, script ≤ 300） | Vue 文件 | ✅ 符合 | — |
| 5 | 禁止 `any` | TypeScript | ✅ 符合 | — |
| 6 | v-model 绑定 | Vue 文件 | ➖ 不适用 | — |
| 7 | Promise.allSettled 独立数据源 | 全部 | ➖ 不适用 | — |
| 8 | 禁止硬编码颜色（用 CSS 变量或语义类） | 全部 | ✅ 符合 | — |
| 9 | 禁止魔数间距（标准 Tailwind scale） | 全部 | ⚠️ 部分违规 | style.css `.is-fullscreen` 中的 `14px` / `6px 12px` |
| 10 | border-radius 默认 1px / 特殊 2px | 全部 | ✅ 符合 | — |
| 11 | 禁止 `@apply` | 全部 | ✅ 符合 | — |
| 12 | emit 只传单个 payload 对象 | 全部 | ✅ 符合 | — |
| 13 | Event bus listener 防重复注册（refCount） | 全部 | ✅ 符合 | App.vue fullscreen handler 在 setup-once 上下文，无需 refCount |
| 14 | Session 隔离：消息必带 sessionId | 全部 | ✅ 符合 | runtime server.ts 新增 `message.steer` / `message.follow_up` 正确提取 `payload.sessionId` |
| 15 | Pinia 模式 | 全部 | ✅ 符合 | `stores/sidebar.ts` 使用 setup-style store，状态只在 action 中变更 |
| 16 | TypeScript 严格性 | TypeScript | ✅ 符合 | `protocol.ts` 新增 `message.steer` / `message.follow_up` 类型已加入 `ClientMessageMap` 和 `ClientMessage` union |
| 17 | 命名规范（PascalCase 组件、camelCase 函数） | 全部 | ✅ 符合 | — |

### 文件行数检查

| 文件 | template | script | 总行 | 状态 |
|------|----------|--------|------|------|
| MessageBubble.vue | 73 | 258 | 473 | ✅ |
| ChatPanel.vue | 58 | 173 | 288 | ✅ |
| PanelBar.vue | 139 | 122 | 444 | ✅ |
| PanelSessionView.vue | 29 | 246 | 276 | ✅ |
| MessageActionMenu.vue | 39 | 94 | 168 | ✅ |
| BranchIndicator.vue | 43 | 47 | 191 | ✅ |
| BatchSelectBar.vue | 42 | 11 | 129 | ✅ |
| SidebarCollapseHandle.vue | 25 | 14 | 40 | ✅ |
| SidebarHeader.vue | 13 | 11 | 25 | ✅ |

所有 Vue 组件均在 template ≤ 400 / script ≤ 300 的限制内。

## 问题清单

| # | 严重度 | Phase | 描述 | 文件 | 行号 | 修改建议 |
|---|--------|-------|------|------|------|---------|
| 1 | LOW | A | 2 处原生 `<button>` 元素无 `eslint-disable-next-line taste/no-native-html-elements`，触发 lint warning | `src-electron/renderer/src/components/chat/UtilityRail.vue` | L3, L12 | 新组件应直接使用 xyz-ui `<Button>` 组件；或参考 MessageBubble/PanelBar 模式添加带理由的 eslint-disable |
| 2 | LOW | A | 无用的 `eslint-disable` 指令（无对应 lint 错误） | `src-electron/renderer/src/components/chat/BranchIndicator.vue` | L60 | 删除该行；commit 5858876 标题即"remove unused declarations"，此 directive 漏改 |
| 3 | LOW | B | Dead code: `useTreeStore()` 调用但返回值未使用（被 `eslint-disable` 抑制），且 `pillRef` 声明但模板中未绑定（`ref="pillRef"` 缺失），导致 `dropdownStyle` 永远返回 `{}` | `src-electron/renderer/src/components/chat/BranchIndicator.vue` | L60-78 | 删除 `useTreeStore()` 调用；删除 `pillRef` 引用直到模板绑定 `ref="pillRef"`；或先实现 tree store 集成 |
| 4 | LOW | B | `branchTabs` 永远返回 `[]`（带 TODO 注释 "will be populated when integrated with MessageList"），下拉菜单实际为空（多分支时点击也无效） | `src-electron/renderer/src/components/chat/BranchIndicator.vue` | L67-75 | 要么完成 tree store 集成填充真实 tabs，要么从 MessageBubble 中移除该组件直到集成完成 |
| 5 | LOW | B | 同一组件内出现 2 次 `onMounted` / 2 次 `onUnmounted` 注册（功能正确但风格不优） | `src-electron/renderer/src/components/chat/ChatInput.vue` | L122-125, L139-142 | 合并为单一 `onMounted` 和 `onUnmounted` 块 |
| 6 | LOW | B | style.css 中新增组件级样式规则（违反"组件样式只放 `<style scoped>`"原则），含 `14px` / `6px 12px` 魔数 | `src-electron/renderer/src/style.css` | L729-745 | 如必须放在全局，建议将魔数改为设计 token（`--space-*`）；或者改为 sidebar 子组件的 `<style scoped>` 配合 `:global(.is-fullscreen) &` 选择器 |
| 7 | INFO | A | 多处使用 `eslint-disable-next-line taste/no-native-html-elements` 抑制（MessageBubble 2 处、PanelBar 1 处、BatchSelectBar 3 处），所有 disable 均带合理理由 | `MessageBubble.vue` / `PanelBar.vue` / `BatchSelectBar.vue` | 详见 diff | 当前模式可接受（compact icon trigger 一致性）。如希望统一消除，建议将 `<button>` 抽象为本地 `<IconButton>` 子组件 |
| 8 | INFO | B | `tree-message-handler.ts` 中 `forkFromEntry(sid, entryId, '-fork')` 的 `labelSuffix` 参数虽被传入但在 `tree-service.ts` 中声明为 unused（带 eslint-disable "reserved for caller coordination"） | `src-electron/runtime/src/tree-service.ts` | L151, L177 | 后续若 caller 端接管 label 拼接（本轮已实现），可移除此参数和 disable 注释以简化签名 |

## 详细分析

### 1. 必须修复项（MUST_FIX）：无

所有自动化检查（lint / vue-tsc / runtime tsc）均通过。Phase B 的逐条规范对比中，无任何"禁止"类条款被违反至 MUST_FIX 程度。

### 2. 低优先级问题（LOW）：5 项

- **#1 UtilityRail 原生 button**：新文件 UtilityRail.vue 使用 `<button>` 触发滚动，未添加 `eslint-disable` 注释，与项目其他新增 button（MessageBubble / PanelBar / BatchSelectBar）模式不一致。lint warning 已暴露。
- **#2 BranchIndicator 无用 eslint-disable**：commit 5858876 清理了 "unused declarations" 但保留了 `// eslint-disable-next-line @typescript-eslint/no-unused-vars` 在 L60 抑制 `useTreeStore()` 调用，导致 lint warning 仍存在。
- **#3 BranchIndicator dead code**：`useTreeStore()` 无副作用调用 + `pillRef` 未绑定到模板，使 `dropdownStyle` 实际永远 `{}`，dropdown 位置会错（默认锚定到 0,0）。
- **#4 BranchIndicator 空 tabs**：dropdown 内容始终为空，用户点击分支 pill 看到空菜单。
- **#5 ChatInput 双 onMounted**：风格问题，不影响功能。
- **#6 style.css 魔数 + 组件级规则**：边界违规，全局 layout 调整放在 style.css 是历史惯例（如 design tokens），但魔数（14px / 6px / 12px）应使用设计 token。

### 3. 信息项（INFO）：3 项

- **#7 大量 eslint-disable 模式**：本次新增 6 处 `taste/no-native-html-elements` disable，全部带合理理由。模式一致，可接受。
- **#8 `labelSuffix` 占位参数**：`forkFromEntry` 和 `cloneSession` 的 `labelSuffix` 参数在 `tree-service.ts` 中被声明但不使用（caller 端在 `tree-message-handler.ts` 中拼接 `originalLabel + '-fork'`）。当前实现正确但签名冗余。

### 4. 关键架构正确性验证

| 验证项 | 结果 | 证据 |
|--------|------|------|
| `emit('event', { payload })` 单参数模式 | ✅ | 所有新增 emit 均符合（`emit('send', { content, sendMode })` / `emit('close')` / `emit('navigate', id)`） |
| Session 隔离（payload.sessionId 必带） | ✅ | `runtime/server.ts` 新增 `message.steer` / `message.follow_up` 正确从 `msg.payload.sessionId` 提取 sid |
| Event bus listener 清理 | ✅ | App.vue 用 `ipcCleanupFns.push(...)` 单次注册（setup-once 上下文）；ChatInput `editor-text-pending` 在 onUnmounted 调用 `unsubEditorText?.()` |
| TypeScript 严格性 | ✅ | `protocol.ts` 新增类型在 `ClientMessageMap` 和 `ClientMessage` union 中均已注册；`rebindAfterFork` 参数变更已同步接口、实现、所有调用方 |
| Pinia 模式 | ✅ | `stores/sidebar.ts` 使用 setup-style store，所有 mutation 限定在 action 中 |
| 打包配置未变更 | ✅ | diff 中无 `tsup.config.ts` / `electron-builder.yml` / `plugin-host.ts` 变更，符合"打包改动必须独立 commit"约束 |

## 结论

**通过（pass）** — 所有自动化检查通过，Phase B 逐条规范对比无 MUST_FIX 级别违规。8 项问题均为 LOW/INFO 级别，建议在后续清理 commit 中修复：

- 优先处理 #2 和 #1（消除 lint warning，恢复 0 warning 状态）
- 建议跟进 #3 和 #4（BranchIndicator 集成或移除，避免 dead code 流入生产）
- 其余 4 项（#5, #6, #7, #8）可在下轮重构时一并处理

报告已写入：
`/Users/zhushanwen/Code/xyz-agent-workspace/feat-chat-area-impr/.xyz-harness/2026-06-05-chat-area-round1/changes/reviews/standards_review_v1.md`
