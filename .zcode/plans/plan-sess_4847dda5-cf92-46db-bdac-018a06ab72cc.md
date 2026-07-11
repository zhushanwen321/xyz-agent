# 修复 Composer 视觉行 ↓ 跨行失败 + 光标水平位置保持

## 问题根因（CDP 实测确认）

`moveCaretVerticalOf`（useContenteditableInput.ts:70-178）用 `fullRange.getClientRects()` 构建视觉行 map。但 `<br>` 硬换行元素会产生**零宽度 line box**（`left === right`），这些零宽 rect 被当作独立视觉行计入 `lineRects`，且其 `top` 与相邻真实行相同。

实测数据（release 版 `file://` 环境，3 行文本含 2 个 `<br>`）：
- 实际 4 个视觉行，但 `getClientRects()` 返回 6 个 rect（rect[1]、rect[4] 是 `<br>` 零宽 line box）
- 光标在 rect[3]（top=452.875）按 ↓ → `targetLine=4`（零宽 br rect，top 也是 452.875）→ `caretRangeFromPoint(451, 455.875)` 命中同一视觉行 → 返回 `moved` 但光标 Y 没变
- 实际按 ↓ 后 caret.top: 452.875 → 452.875（**没跨行**），offset 75 → 52（同行内水平跳）
- 用户现象：按 ↓ 需要按两次才跨行

## 修复内容

### 修复 1：过滤零宽 rect（核心 bug 修复）

**文件**: `packages/renderer/src/composables/panel/useContenteditableInput.ts`

在 `moveCaretVerticalOf` 中，构造 `lineRects` 后过滤掉零宽 rect（`left >= right`）。两处需要过滤：
- 行 81：初始 `lineRects = fullRange.getClientRects()`
- 行 143-146：scroll 后重读的 `freshRects`

过滤方式：`Array.from(...).filter(r => r.right > r.left)`，将 DOMRectList 转 array 后过滤。过滤后 `lineRects` 只含真实视觉行，`currentLine` / `targetLine` 计算正确。

单行场景（过滤后 ≤1 行）保持原有 `return 'at-edge'` 行为不变。

### 修复 2：preferred X 光标水平位置保持

**文件**: 同上

当前代码用固定 `targetX = elRect.left + paddingLeft + 20`（行 151），每次跨行都跳到行首附近。浏览器/VSCode 原生行为是：连续 ↑/↓ 保持光标水平位置，水平移动后重置。

**设计**（架构正确归位）：
- `moveCaretVerticalOf` 从**模块级纯函数**改为 **composable 内部闭包函数**，访问 composable 内的 `preferredCaretX` ref（`number | null`）。这是正确归位——preferred X 是 contenteditable 输入状态的一部分，属于 composable 闭包；且 split 模式多实例不能共享模块级变量。
- preferred X 逻辑（在 `moveCaretVerticalOf` 内）：
  - 进入函数时：若 `preferredCaretX === null`，记录当前 `caretRect.left`
  - 跨行定位时：用 `preferredCaretX` 作为 targetX（若为 null 用兜底值）
  - 返回 `'at-edge'` 或 `'moved'` 但处于首/末行时**不清除** preferredX（允许反复在边缘尝试）
- 重置时机（在 `onKeydown` 和相关操作中 `preferredCaretX = null`）：
  - `onKeydown`：ArrowLeft / ArrowRight / Home / End（水平移动键）
  - `onInput`：用户输入文本
  - `setText`：程序化写入（历史回填/草稿恢复）
  - 鼠标点击：ComposerInput.vue 的 `@mouseup="saveSelection"` 已存在，追加重置（通过新增 `resetPreferredX` 暴露给组件，或直接在 composable 内的 `saveSelection` 里重置）

### 修复 3：更新文档

**文件**:
- `.xyz-harness/2026-07-10-composer-history-navigation/spec.md`：在「已知实现缺陷」章节追加「缺陷 5: `<br>` 零宽 line box 污染 lineRects」，记录根因和修复
- `useContenteditableInput.ts` 行 46-68 的 doc 注释：更新实现方案描述（加零宽过滤 + preferred X），行 209-212 `moveCaretVertical` 签名注释中的 "利用浏览器原生 Selection.modify" 已陈旧（与实际 caretRangeFromPoint 实现脱节），一并修正

### 不新增单元测试（沿用现有测试策略）

`moveCaretVerticalOf` 依赖 `getClientRects()` / `caretRangeFromPoint()` 等 DOM 布局 API，jsdom/happy-dom 不支持（现有测试注释 use-composer-history.test.ts:239-242 已标注此缺口）。修复通过 CDP 实测验证（开发时手动验证 + 本次已实测确认）。`useComposerHistory` 的纯状态机逻辑不变，现有单测继续覆盖。

## 验证方式

修复后用 CDP 连接 release 版（`--remote-debugging-port=9222`）实测：
1. 注入含 `<br>` 的多行文本 + 长文本软换行混合场景
2. 光标放 br 相邻行按 ↓，验证一次跨行成功（caretRect.top 变化）
3. 光标在某行中间按 ↓，验证到下一行停在相近水平位置（preferred X 生效）
4. ←/→ 移动后按 ↓，验证水平位置重置为新位置

## 改动文件清单

| 文件 | 改动 |
|------|------|
| `packages/renderer/src/composables/panel/useContenteditableInput.ts` | 零宽 rect 过滤（2处）+ moveCaretVerticalOf 改为闭包函数 + preferredX 状态 + 重置逻辑 + doc 注释更新 |
| `.xyz-harness/2026-07-10-composer-history-navigation/spec.md` | 追加缺陷 5 记录 |
| `packages/renderer/src/components/panel/ComposerInput.vue` | （可能）mouseup 重置 preferredX，视 composable 内部实现而定 |