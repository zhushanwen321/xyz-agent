---
verdict: pass
must_fix: 0
review_metrics:
  files_reviewed: 1
  issues_found: 4
  must_fix_count: 0
  low_count: 3
  info_count: 1
---

# Standards Review — ProviderModal.vue

## 审查结果

**整体判定: PASS** — 未发现 must_fix 级别问题。组件整体符合项目编码规范。

## 逐项检查

| 规则 | 结果 | 说明 |
|------|------|------|
| 禁止原生 HTML 表单元素 | PASS | 使用 xyz-ui Button/Input/Select 组件 |
| 禁止 Emoji | PASS | 无 Emoji 字符 |
| 禁止硬编码颜色 | PASS | 使用语义色（bg-success/bg-danger）和 CSS 变量 |
| 行数上限 | PASS | template: 131 行 ≤ 400，script: 289 行 ≤ 300 |
| 禁止 any | PASS | 无 `any` 类型使用 |
| v-model 绑定 | PASS | 表单元素均使用 v-model |
| emit 单 payload | PASS | emit 调用均传递单个对象 |
| Promise.allSettled | N/A | 无并行请求场景 |

## 发现问题

### LOW-1: `rounded-full` 违反 border-radius 规范

**位置**: L337

```html
<span :class="['w-[7px] h-[7px] rounded-full ...']">
```

CLAUDE.md 规定 `border-radius` 默认 1px（`rounded-sm`），特殊场景用 2px（`rounded-md`/`rounded-lg`），禁止其他值。`rounded-full` 是 9999px。

**建议**: 状态指示器圆点用 `rounded-sm` 即可，7px 的圆点视觉差异极小。

### LOW-2: 魔数尺寸值（arbitrary Tailwind 值）

**位置**: L301, L337, L377, L382, L401

```html
w-[600px]          <!-- L301 modal 宽度 -->
w-[7px] h-[7px]    <!-- L337 状态圆点 -->
min-w-[160px]      <!-- L377 模型名 -->
min-w-[50px]       <!-- L382 context 窗口 -->
!max-w-[120px]     <!-- L401 context 选择框 -->
```

CLAUDE.md 禁止魔数间距。对于非标准尺寸，建议：
- `w-[600px]` → 考虑用 `max-w-xl` (576px) 或 `max-w-2xl` (672px)，或定义为设计 token
- 状态圆点 7px → `w-1.5 h-1.5` (6px) 足够
- `min-w-[160px]` / `min-w-[50px]` → 用 `min-w-40` (160px) / `min-w-12` (48px)
- `!max-w-[120px]` → `max-w-28` (112px) 或 `max-w-32` (128px)

### LOW-3: 重复的 section label 样式可提取

**位置**: 多处出现

```html
<div class="text-xs font-semibold text-muted mb-1.5 uppercase tracking-[0.04em]">
```

这段 label 样式出现 5 次以上（providerName、providerType、Base URL、API Key、Model Config header）。建议提取为设计 token 或 tailwind `@apply` utility class（在 `style.css` 中定义）。虽然不算违反规范（Tailwind 类在模板中使用是合规的），但大量重复增加维护成本。

### INFO-1: `tracking-[0.04em]` 和 `tracking-[0.06em]` 使用 arbitrary 值

**位置**: label 行和 L342

Tailwind 默认 scale 中有 `tracking-wide` (0.025em) 和 `tracking-wider` (0.05em)，但缺少精确的 0.04em。这是合理的 arbitrary 使用，无需修改。

## ThinkingLevelConfig.vue 删除

该文件被删除，无需审查。从 ProviderModal.vue 中可以看到 thinking level 预设功能已内联（`applyThinkingPreset` 函数），设计合理。
