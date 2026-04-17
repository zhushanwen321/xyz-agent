# Design System — xyz-agent

全局设计规范。颜色 token 注册在 `tailwind.config.js` 的 `theme.extend.colors`，shadcn-vue 变量在 `src/assets/main.css` 的 `:root`。

## 1. 色彩体系

### 项目自定义色（Tailwind class）

| Class | 值 | 用途 |
|-------|-----|------|
| `bg-base` | `rgb(10 10 11)` | 最底层背景 |
| `bg-surface` | `rgb(17 17 19)` | 页面/面板背景 |
| `bg-elevated` | `rgb(24 24 27)` | 卡片/弹出层 |
| `bg-inset` | `rgb(31 31 35)` | 凹陷区域（代码块、输入框） |
| `bg-ai` | `rgb(19 21 23)` | AI 消息背景 |
| `bg-user` | `rgb(28 26 20)` | User 消息背景 |

### 边框

| Class | 值 |
|-------|-----|
| `border-border-default` | `rgb(39 39 42)` |
| `border-border-hover` | `rgb(63 63 70)` |

### 文本

| Class | 值 | 用途 |
|-------|-----|------|
| `text-foreground` | `var(--foreground)` = `#fafafa` | 正文 |
| `text-muted-foreground` | `var(--muted-foreground)` = `#a1a1aa` | 次要信息 |
| `text-tertiary` | `rgb(113 113 122)` | 占位符、标签 |

### 功能色（semantic 命名空间）

| Class | 值 | 语义 |
|-------|-----|------|
| `bg-semantic-green` | `rgb(34 197 94)` | 主强调/成功 |
| `bg-semantic-green/15` | 同上 15% 透明度 | 弱化背景 |
| `bg-semantic-blue` | `rgb(59 130 246)` | 信息/链接 |
| `bg-semantic-yellow` | `rgb(234 179 8)` | 警告 |
| `bg-semantic-red` | `rgb(239 68 68)` | 错误/危险 |

支持 `/opacity` 修饰符：`bg-semantic-red/10`、`text-semantic-blue/80`。

### shadcn-vue 标准色

| Class | CSS 变量 |
|-------|---------|
| `bg-primary` / `text-primary-foreground` | `--primary` = `#22c55e` |
| `bg-secondary` / `text-secondary-foreground` | `--secondary` = `#1f1f23` |
| `bg-muted` / `text-muted-foreground` | `--muted` = `#1f1f23` |
| `bg-accent` / `text-accent-foreground` | `--accent` = `rgba(34,197,94,0.15)` |
| `bg-destructive` / `text-destructive-foreground` | `--destructive` = `#ef4444` |

## 2. 排版体系

### 字体栈

| Class | 值 |
|-------|-----|
| `font-sans` | Inter, SF Pro Text, system-ui |
| `font-mono` | JetBrains Mono, Fira Code, Cascadia Code |

## 3. 组件规范

### UI 组件库

所有表单元素使用 shadcn-vue，禁止原生 HTML 元素：

| 原生元素 | shadcn-vue 组件 | 导入路径 |
|---------|----------------|---------|
| `<button>` | `<Button>` | `@/components/ui/button` |
| `<input>` | `<Input>` | `@/components/ui/input` |
| `<select>` | `<Select>` + `<SelectTrigger>` / `<SelectContent>` / `<SelectItem>` | `@/components/ui/select` |
| `<textarea>` | `<Textarea>` | `@/components/ui/textarea` |
| `<input type="checkbox">` | `<Checkbox>` | `@/components/ui/checkbox` |

### ESLint 强制规则

- `taste/no-hardcoded-colors` — 禁止 `[#hex]`、Tailwind 默认色名（`red-400`、`blue-500` 等）
- `taste/no-native-form-elements` — 禁止原生 `<button>/<input>/<select>/<textarea>`
- `taste/no-magic-spacing` — 禁止任意值间距（`p-[17px]` 等）

## 4. 设计原则

1. **终端 x IDE 风格** — 深色背景、等宽字体标签、色条指示器
2. **紧凑优先** — 最小化不必要的空白，最大化信息密度
3. **一致性** — 所有组件使用同一套 token，禁止硬编码颜色/尺寸
4. **功能色即信息** — 绿色=成功、蓝色=信息、红色=错误，不用于装饰
