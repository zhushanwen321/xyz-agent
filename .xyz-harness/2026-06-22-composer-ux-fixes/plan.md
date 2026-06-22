# Composer UX 修复计划

## 目标

修复 Composer 组件的 3 个 UX 问题：Textarea 拖拽手柄、缺失 `+` 按钮、工具栏按钮不可交互。

## 涉及文件

| 文件 | 改动 |
|------|------|
| `src-electron/renderer/src/components/panel/Composer.vue` | 主要改动 |

## Task 1: Textarea 补 `resize-none`

**问题**：shadcn-vue Textarea 默认无 `resize: none`，浏览器原生显示右下角拖拽手柄。

**改动**：Composer.vue 的 `<Textarea>` class 列表加 `resize-none`。

一行改动，无需拆分。

## Task 2: 工具栏左侧补 `+` 按钮

**问题**：spec 设计了 `+ 添加内容`（左锚定），实现时跳过。

**改动**：
- 在 `<div class="composer-bar">` 最前面加一个 `<Button>`，用 lucide 的 `Plus` 图标
- 样式：ghost variant，`size-[28px]`，hover 浮 `bg-surface-hover`
- `title="添加内容"`，点击 handler 暂不实现（`// TODO: + 浮层`）

## Task 3: 工具栏右侧三按钮改为可交互

**问题**：上下文/模型/思考三个元素是 `<span>` 纯展示，`cursor-default`、无 hover。

**改动**：

### 3a: 元素类型 `<span>` → `<button>`

三个元素从 `<span>` 改为 `<button>`，加 `cursor-pointer`。

### 3b: 样式对齐 spec `.c-text`

spec 设计稿的 `.c-text` 样式：
```css
border: 0; background: transparent; color: --text-tertiary;
padding: 6px 8px; border-radius: --radius-sm;
hover: bg-hover, color text-secondary;
transition: 220ms ease;
```

当前是 `px-2 py-1.5`，改为 `px-2 py-1.5`（保持，接近 spec）。关键改动：
- 移除 `cursor-default select-none`
- 加 `cursor-pointer`、`rounded-sm`、`transition-colors`
- hover 加 `hover:bg-surface-hover hover:text-muted`

### 3c: click handler（壳）

- 上下文：`@click` 空 handler + `// TODO: 上下文容量 popover（§2a）`，hover 显示 title
- 模型：`@click` 空 handler + `// TODO: 模型切换 popover（§2b）`
- 思考：`@click` 空 handler + `// TODO: 思考等级 popover（§2c）`

popover 实现是后续迭代，本轮只做按钮可交互。

### 3d: 导入 Plus 图标

`import` 加 `Plus` from `@lucide/vue`。

## 验证

```bash
cd src-electron && npm run dev:mock
```

检查：
1. Textarea 右下角无拖拽手柄
2. 工具栏左侧有 `+` 按钮，hover 有背景变化
3. 上下文/模型/思考三个按钮 hover 有背景变化，cursor 为 pointer
