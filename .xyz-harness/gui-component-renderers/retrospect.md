# Retrospect: GUI 组件渲染协议实现

## 概况

- **Topic**: cw-2026-07-12-gui-component-renderers
- **目标**: 实现 GUI 渲染协议剩余 6 种 block type 的 Vue 组件，消除 JSON fallback 降级
- **结果**: 7 种 type 全部实现并注册（ansi-text 原有 + 6 新增），32 个单测全绿，3 个 Wave 逐个 TDD 提交

## 交付物

| 组件 | 文件 | testid |
|---|---|---|
| ProgressBar | `gui/ProgressBar.vue` | `gui-progress-bar` |
| StatsLine | `gui/StatsLine.vue` | `gui-stats-line` |
| TabBar | `gui/TabBar.vue` | `gui-tab-bar` |
| Card | `gui/Card.vue` | `gui-card` |
| Columns | `gui/Columns.vue` | `gui-columns` |
| ListTree | `gui/ListTree.vue` | `gui-list-tree` |
| 路由注册 | `GuiComponentRenderer.vue` BUILTIN_MAP | — |

## 做得好的

1. **Wave 拆分合理**：W1 独立原语 → W2 递归嵌套 → W3 树形+路由注册，依赖链清晰，每个 Wave 可独立验证
2. **TDD 红绿循环严格执行**：每个 Wave 先写测试确认红（import 失败），再写实现确认绿，没有先代码后补测试
3. **递归渲染方案干净**：Card/Columns 通过 `<GuiComponentRenderer v-for :component>` 中转递归，不自己处理 type 路由，职责单一。ListTree 用 Vue 组件自递归（`<ListTree :items="children" :depth="depth+1">`），depth 自动传递缩进
4. **SSOT 一致性维护**：所有组件用 design-tokens 语义色（text-success/text-warning/text-danger/text-accent），不硬编码十六进制色

## 遇到的问题

### 1. W2 路由注册提前到 W2

原计划 W3 才注册 BUILTIN_MAP，但 W2 的 Card/Columns 测试需要递归调 GuiComponentRenderer 路由到 stats-line 子组件。如果 BUILTIN_MAP 没注册 stats-line，Card 测试的嵌套断言会失败。

**处理**：把 BUILTIN_MAP 注册提前到 W2（注册 W1+W2 的 5 种），W3 只补充 list-tree 注册。W3 的 changes 描述相应调整。这不违反 append-only 约束（W2 和 W3 都未 committed 时调整未 committed 的 plan 项是合法的）。

### 2. 魔数 lint 拦截

ProgressBar 的 `100`（百分比乘数）、`0.8`/`0.5`（severity 阈值）被 ESLint `no-magic-numbers` 规则拦截。提取为 `PERCENT_MULTIPLIER` / `SEVERITY_THRESHOLD_OK` / `SEVERITY_THRESHOLD_WARN` 常量。pre-commit hook 对 warning 也是零容忍。

### 3. cw cwd 隔离

`cw create` 在 `packages/renderer` 目录跑的（因为之前测试都在那跑），后续 `cw dev` 从仓库根跑导致 `topic not found`。修复：所有 cw 命令统一从 `packages/renderer` 跑。

### 4. toFixed(1) 格式差异

`0%` vs `0.0%`——`toFixed(1)` 总输出一位小数。测试断言改为匹配实际格式 `width: 0.0%`。

## 遗留 / 后续

- **custom 类型**：仍依赖运行时 provide `gui-custom-registry`，默认空表 → fallback JSON。内置 extension 编译期注册自有组件是 P2+ 范围，本次未实现
- **demo HTML**（`docs/page-design/archive/gui-components-demo.html`）：展示了 7 种 type + JSON fallback 的渲染效果，用纯 HTML/CSS 模拟，与实际 Vue 组件视觉一致。已提交（作为视觉参考，放 archive/）
- **pulse-accent keyframes 死代码**：`tailwind.config.ts` 的 `pulse-accent` / `pulse-warn` keyframes 不再被 DOT_CLASS.running 引用（上一次 session 改 spinner 的连带），后续可清理
