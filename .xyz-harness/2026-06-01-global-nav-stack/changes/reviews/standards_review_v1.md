---
verdict: fail
must_fix: 5
linter_passed: true
review_metrics:
  files_reviewed: 6
  issues_found: 7
  must_fix_count: 5
  low_count: 1
  info_count: 1
  duration_estimate: "8"
---

# Standards Review v1

## 审查记录
- 审查时间：2026-06-01
- 项目路径：`/Users/zhushanwen/Code/xyz-agent-workspace/feat-front-back-settings-impr`
- Phase A（自动检查）：已执行
- Phase B（AI 规范对比）：已执行

## Phase A: 自动化检查结果

### Lint

| 项目 | 结果 |
|------|------|
| 检测到的命令 | `npx eslint <files>` |
| 退出码 | 0 |
| Errors | 0 |
| Warnings | 4 |
| 状态 | ✅ 通过（exit 0，但 4 条 warning 需关注） |

**Warning 详情：**

| 文件 | 行 | 规则 | 消息 |
|------|-----|------|------|
| AppSidebar.vue | L79 | taste/no-native-html-elements | Use xyz-ui `<Button />` instead of native `<button>` |
| AppSidebar.vue | L87 | taste/no-native-html-elements | Use xyz-ui `<Button />` instead of native `<button>` |
| AppSidebar.vue | L93 | taste/no-native-html-elements | Use xyz-ui `<Button />` instead of native `<button>` |
| AppSidebar.vue | L96 | taste/no-native-html-elements | Use xyz-ui `<Button />` instead of native `<button>` |

### Typecheck

| 项目 | 结果 |
|------|------|
| 状态 | ➖ 未配置（项目无 `typecheck` script，`vue-tsc` 未安装为直接依赖） |

## Phase B: CLAUDE.md 规范对比

### 规范检查矩阵

| # | 规范条目 | 适用范围 | 检查结果 | 违规位置 |
|---|---------|---------|---------|---------|
| 1 | 禁止原生 HTML 表单元素（Rule 1） | AppSidebar.vue | ❌ 不符合 | L79, L87, L93, L96 |
| 2 | 禁止 Emoji（Rule 2） | 全部 | ✅ 符合 | — |
| 3 | 样式统一 Tailwind 类（Rule 3） | 全部 | ✅ 符合 | — |
| 4 | 行数上限：template ≤400, script ≤300（Rule 4） | 全部 | ✅ 符合 | — |
| 5 | 禁止 any 类型（Rule 5） | TypeScript 文件 | ✅ 符合 | — |
| 6 | v-model 绑定（Rule 6） | Vue 文件 | ➖ 不适用 | — |
| 7 | Promise.allSettled（Rule 7） | 全部 | ➖ 不适用 | — |
| 8 | 禁止硬编码颜色（Rule 8） | 全部 | ✅ 符合 | — |
| 9 | 禁止魔数间距（Rule 9） | SettingsView.vue | ❌ 不符合 | L58 `py-[9px]` |
| 10 | border-radius 默认 1px（Rule 10） | 全部 | ✅ 符合 | — |
| 11 | emit 只传单个 payload 对象 | AppSidebar.vue | ✅ 符合 | — |
| 12 | 视图切换状态驱动 | 全部 | ✅ 符合 | — |

## 问题清单

| # | 严重度 | Phase | 描述 | 文件 | 行号 | 修改建议 |
|---|--------|-------|------|------|------|---------|
| 1 | MUST_FIX | A+B | 原生 `<button>` 应替换为 xyz-ui `<Button>` | AppSidebar.vue | L79 | 改用 `<Button variant="ghost" size="icon">` |
| 2 | MUST_FIX | A+B | 原生 `<button>` 应替换为 xyz-ui `<Button>` | AppSidebar.vue | L87 | 改用 `<Button variant="ghost" size="icon">` |
| 3 | MUST_FIX | A+B | 原生 `<button>` 应替换为 xyz-ui `<Button>` | AppSidebar.vue | L93 | 新增的 Back 按钮，应使用 `<Button>` |
| 4 | MUST_FIX | A+B | 原生 `<button>` 应替换为 xyz-ui `<Button>` | AppSidebar.vue | L96 | 新增的 Forward 按钮，应使用 `<Button>` |
| 5 | MUST_FIX | B | 魔数间距 `py-[9px]`，非标准 Tailwind scale | SettingsView.vue | L58 | 改用 `py-2`（8px）或 `py-2.5`（10px） |
| 6 | LOW | B | `border-l-[3px]` 非标准 Tailwind border width | SettingsView.vue | L58 | 改用 `border-l-2`（2px）或 `border-l-4`（4px） |
| 7 | INFO | B | CLAUDE.md 架构约定引用 `settingsStore.currentView`，已变更为 `navigationStore` | CLAUDE.md | L271 | 更新架构约定为 `navStore.currentView` |

## 详细分析

### Issue 1-4: 原生 `<button>` 元素

AppSidebar.vue 中 4 个导航按钮（overview、settings、back、forward）使用原生 `<button>`。CLAUDE.md Rule 1 明确「禁止原生 HTML 表单元素，必须使用 xyz-ui 组件」。同等功能在 AppHeader.vue 中均使用 `<Button variant="ghost" size="icon">` 实现，风格应保持一致。

注意：L106 的 "New Session" 按钮已有 `eslint-disable-next-line` 注释抑制，本次不重复计入。但建议一并改为 `<Button>` 以保持一致性。

### Issue 5: 魔数间距 `py-[9px]`

SettingsView.vue L58 的 tab item 使用 `py-[9px]`。标准 Tailwind scale 中：
- `py-2` = 8px
- `py-2.5` = 10px

9px 是两者之间的非标准值，违反「禁止魔数间距，用标准 Tailwind scale」规则。建议选择 `py-2` 或 `py-2.5`。

### Issue 6: `border-l-[3px]`

SettingsView.vue L58 使用 `border-l-[3px]` 作为激活态的左侧指示条。标准 Tailwind 有 `border-l-2`（2px）和 `border-l-4`（4px）。视觉上 3px 可能更合适，但违反了标准 scale 约定。建议用 `border-l-2` 配合 `border-l-accent` 颜色实现类似效果，或接受此 deviation 并提取为 CSS 变量。

### Issue 7: CLAUDE.md 架构约定更新

CLAUDE.md L271 写「视图切换: 状态驱动（`settingsStore.currentView`）」。本次变更引入 `navigationStore`，`currentView` 已移至 `navStore.currentView`。建议更新 CLAUDE.md 保持文档与代码一致。

## 结论

**需修改**：5 条 MUST FIX 需修复后方可通过审查。核心问题是 AppSidebar 中 4 个原生按钮和 SettingsView 中 1 处魔数间距。
