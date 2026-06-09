# Phase 1: Hello pi — 设计规格 v2

**日期**: 2026-05-06 | **阶段**: P1 (共 6 阶段) | **代号**: Hello pi
**基于**: spec.md v1 + review-report.md 审查 + spec-corrections.md 修正 + integration-investigation.md 调研

> 目标：搭建 Tauri + Vue 3 + Node.js Sidecar 的完整三层架构，实现单 Agent 对话的完整桌面应用。
> 这是 xyz-agent 的最小可交付产品——一个 pi 的 Tauri GUI 壳。

---

## 一、交付标准

Phase 1 结束后，用户可以：

- [ ] 在桌面应用中与 AI Agent 正常对话（流式输出）
- [ ] 看到 Agent 的工具调用（read/bash/edit/write），可折叠查看详情
- [ ] 看到 Agent 的思考过程（thinking），默认折叠
- [ ] 在输入框切换模型（分组下拉：常用 / Anthropic / OpenAI / ...）
- [ ] 在设置页配置 Provider（添加/编辑/删除 API Key）
- [ ] 在左侧 Sidebar 查看按工作目录分组的 Session 列表
- [ ] 新建 Session（选择工作目录） / 删除 Session / 切换 Session
- [ ] 中断当前生成
- [ ] 切换明/暗主题
- [ ] 切换标准/专注两种视图模式
- [ ] 在底部状态栏看到连接状态、cwd、模型、token 用量
- [ ] 通过键盘快捷键切换视图模式（Cmd+1 / Cmd+3）和打开设置（Cmd+,）
- [ ] Toast 通知提示操作结果和错误信息

---

## 二、项目结构

```
xyz-agent/
├── shared/                       # 前后端共享类型
│   ├── protocol.ts               # WS 消息类型定义（前后端 + sidecar 共享）
│   └── types.ts                  # 共享域类型（Message / Session / Provider / Model）
│
├── src-tauri/                    # Tauri Rust 壳
│   ├── src/
│   │   ├── main.rs               # Tauri 入口 + 全局快捷键注册
│   │   ├── sidecar.rs            # Sidecar 进程生命周期（spawn/kill/health check/restart）
│   │   ├── shortcuts.rs          # Tauri global shortcut 注册与事件分发
│   │   ├── commands/
│   │   │   ├── mod.rs
│   │   │   ├── dialog.rs         # 原生文件选择器、确认对话框
│   │   │   └── fs.rs             # 文件系统操作（读目录等）
│   │   └── lib.rs
│   ├── Cargo.toml
│   └── tauri.conf.json
│
├── src/                          # Vue 3 前端
│   ├── App.vue                   # 根组件：状态驱动视图切换 + Toaster
│   ├── main.ts
│   ├── assets/
│   │   └── main.css              # Tailwind 入口 + CSS custom properties（light/dark）
│   ├── design-system/            # 组件库（独立目录，未来可抽包）
│   │   ├── tokens/
│   │   │   ├── colors.ts         # oklch 色彩 token 定义
│   │   │   ├── spacing.ts        # 间距 token
│   │   │   ├── typography.ts     # 字体 token
│   │   │   └── index.ts          # 汇总导出
│   │   ├── theme/
│   │   │   ├── ThemeProvider.vue  # 主题提供者（light/dark + 系统跟随）
│   │   │   └── useTheme.ts       # 主题 composable（读取 settings store）
│   │   ├── components/
│   │   │   ├── Button.vue
│   │   │   ├── Input.vue
│   │   │   ├── Textarea.vue
│   │   │   ├── Select.vue
│   │   │   ├── ScrollArea.vue
│   │   │   ├── Tooltip.vue
│   │   │   ├── Dropdown.vue
│   │   │   ├── Dialog.vue
│   │   │   ├── Tabs.vue
│   │   │   ├── Badge.vue
│   │   │   ├── Toggle.vue
│   │   │   └── ProgressBar.vue
│   │   └── index.ts              # 统一导出
│   ├── i18n/
│   │   ├── index.ts              # vue-i18n 配置 + 插件注册
│   │   ├── types.ts              # Schema 类型导出（类型安全 key 补全）
│   │   └── locales/
│   │       ├── zh-CN.ts
│   │       └── en-US.ts
│   ├── components/
│   │   ├── layout/
│   │   │   ├── AppHeader.vue     # Logo + 通知预留 + 视图切换 + 设置 + 主题
│   │   │   ├── AppStatusbar.vue  # 连接状态 + cwd + 模型 + token + 快捷键提示
│   │   │   ├── AppSidebar.vue    # 侧边栏容器（可折叠，拖拽宽度）
│   │   │   └── SettingsView.vue  # 设置全屏视图（Tab: 供应商 / SKILL预留 / AGENT预留）
│   │   ├── sidebar/
│   │   │   ├── SessionSearch.vue # 搜索框
│   │   │   ├── SessionGroup.vue  # 按目录分组的会话列表
│   │   │   └── SessionItem.vue   # 单个会话（状态点 + 标题 + 时间 + 右键菜单）
│   │   ├── chat/
│   │   │   ├── ChatView.vue      # 对话主容器
│   │   │   ├── MessageList.vue   # 虚拟滚动消息列表（@tanstack/vue-virtual）
│   │   │   ├── MessageBubble.vue # 消息气泡（user / assistant / system 三态）
│   │   │   ├── ToolCallCard.vue  # 工具调用卡片（折叠/展开）
│   │   │   ├── ThinkingBlock.vue # 思考折叠块
│   │   │   ├── StreamingText.vue # 流式文本（逐字 + 光标闪烁）
│   │   │   ├── ChatInput.vue     # 输入区（textarea + toolbar）
│   │   │   ├── ModelPicker.vue   # 模型选择下拉（分组：常用/按Provider）
│   │   │   ├── ContextBar.vue    # 上下文用量进度条
│   │   │   └── SlashMenu.vue     # / 命令浮层菜单（P1 先搭框架）
│   │   └── settings/
│   │       ├── ProviderList.vue  # Provider 列表（状态 + 编辑/删除）
│   │       └── ProviderForm.vue  # 添加/编辑 Provider 表单
│   ├── composables/
│   │   ├── useChat.ts            # 消息收发、流式事件处理
│   │   ├── useSession.ts         # 会话 CRUD + 切换
│   │   ├── useProvider.ts        # Provider 配置管理
│   │   ├── useModel.ts           # 模型列表 + 切换
│   │   └── useConnection.ts      # WebSocket 连接管理（断线重连）
│   ├── stores/
│   │   ├── chat.ts               # 当前对话状态（消息列表、生成中标志）
│   │   ├── session.ts            # 会话列表、当前会话 ID
│   │   └── settings.ts           # 全局设置（语言、主题、默认模型、currentView）
│   ├── lib/
│   │   ├── ws-client.ts          # WebSocket 客户端（连接/发送/事件分发/状态回调）
│   │   ├── event-bus.ts          # 前端事件总线
│   │   └── markdown.ts           # Markdown 渲染管线（markdown-it + dompurify）
│   └── types/
│       ├── message.ts            # Message / ToolCall / Thinking 类型
│       ├── session.ts            # Session / SessionGroup 类型
│       └── provider.ts           # Provider / Model / ProviderStatus 类型
│
├── sidecar/                      # Node.js Sidecar
│   ├── src/
│   │   ├── index.ts              # 入口：启动 WS 服务器 + HTTP health endpoint
│   │   ├── server.ts             # WS 连接管理 + 消息路由
│   │   ├── session-pool.ts       # Session 池：Map<sessionId, PiProcess>
│   │   ├── process-manager.ts    # pi 子进程生命周期（spawn/kill/restart/健康检查）
│   │   ├── rpc-client.ts         # RPC 协议客户端（stdin/stdout JSONL 通信）
│   │   ├── event-adapter.ts      # pi RPC 事件 → WS 协议事件 转换
│   │   ├── config-store.ts       # xyz-agent 自身设置（语言/主题/默认模型）
│   │   └── provider-store.ts     # Provider API Key 管理（读写 + 传递给 pi 子进程）
│   ├── package.json
│   └── tsconfig.json
│
├── .githooks/
│   ├── install-hooks.sh           # npm prepare 自动调用，生成 .git/hooks/pre-commit
│   └── vue_rules_checker.py       # Python 规范检查（行数/Emoji/CSS/Tab）
├── taste-lint/
│   ├── base.mjs                   # ESLint 基础配置 + 8 条品味规则
│   ├── vue.mjs                    # Vue 特有规则
│   └── rules/
│       ├── no-hardcoded-colors.mjs
│       ├── no-magic-spacing.mjs
│       ├── no-native-form-elements.mjs
│       ├── no-silent-catch.mjs
│       ├── no-unsafe-object-entries.mjs
│       └── prefer-allsettled.mjs
├── eslint.config.mjs
├── package.json
├── tsconfig.json
├── tailwind.config.ts             # Tailwind CSS v3 JS 配置（引用 CSS 变量）
├── vite.config.ts
└── index.html
```

### 共享类型机制

`shared/` 目录包含前后端和 sidecar 共享的类型定义。通过 TypeScript path alias 或 npm workspace 引用：

**package.json workspace 配置**：

```json
{
  "workspaces": ["shared", "sidecar"]
}
```

**tsconfig.json paths**（前端和 sidecar 的 tsconfig 中均配置）：

```json
{
  "compilerOptions": {
    "paths": {
      "@shared/*": ["./shared/*"]
    }
  }
}
```

前端和 sidecar 均通过 `import type { ... } from '@shared/protocol'` 引入共享类型，确保前后端类型始终一致，无需手工同步。

---

## 三、地基层

### 3.1 Design System

**基础选型**：Radix Vue（headless UI）+ Tailwind CSS **v3**

> **重要**：本项目使用 Tailwind CSS **v3**（JS 配置），不是 v4。v3 使用 `tailwind.config.ts` 定义主题扩展，不支持 CSS-first 的 `@theme` 指令。

**Design Tokens**（CSS custom properties，参考 HTML mockup 的 oklch 色值）：

```
--color-bg-base          : oklch(97% 0.018 70)   (light) / oklch(20% 0.015 50) (dark)
--color-surface          : oklch(99% 0.008 70)   / oklch(25% 0.015 50)
--color-text-primary     : oklch(22% 0.02 50)    / oklch(92% 0.008 70)
--color-text-muted       : oklch(50% 0.018 50)   / oklch(65% 0.015 50)
--color-border           : oklch(90% 0.014 70)   / oklch(35% 0.015 50)
--color-accent           : oklch(64% 0.13 28)    / oklch(68% 0.13 28)
--color-accent-light     : oklch(92% 0.04 28)    / oklch(30% 0.06 28)
--color-success          : oklch(70% 0.18 145)
--color-warning          : oklch(78% 0.15 85)
--color-danger           : oklch(62% 0.2 25)

--font-display           : 'Tiempos Headline', 'Newsreader', Georgia, serif
--font-body              : -apple-system, BlinkMacSystemFont, system-ui, sans-serif
--font-mono              : 'JetBrains Mono', 'IBM Plex Mono', ui-monospace, Menlo, monospace

--radius-lg              : 12px
--radius-md              : 8px
--radius-sm              : 4px

--sidebar-width          : 260px
--header-height          : 48px
--statusbar-height       : 32px
--ease-standard          : cubic-bezier(0.4, 0, 0.2, 1)
```

### 3.1.1 Tailwind CSS v3 配置

Tailwind v3 使用 `tailwind.config.ts` 进行 JS 配置，颜色通过 `theme.extend.colors` 映射到 CSS 变量。

**tailwind.config.ts**：

```typescript
import type { Config } from 'tailwindcss'

export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{vue,ts}'],
  theme: {
    extend: {
      // Design token 颜色 → CSS 变量引用
      colors: {
        'bg-base': 'var(--color-bg-base)',
        'surface': 'var(--color-surface)',
        'text-primary': 'var(--color-text-primary)',
        'text-muted': 'var(--color-text-muted)',
        'border': 'var(--color-border)',
        'accent': {
          DEFAULT: 'var(--color-accent)',
          light: 'var(--color-accent-light)',
        },
        'success': 'var(--color-success)',
        'warning': 'var(--color-warning)',
        'danger': 'var(--color-danger)',

        // shadcn-vue 组件库期望的标准色名别名
        'primary': {
          DEFAULT: 'var(--color-accent)',
          foreground: 'var(--color-primary-foreground)',
        },
        'destructive': {
          DEFAULT: 'var(--color-danger)',
          foreground: 'var(--color-destructive-foreground)',
        },
        'muted': {
          DEFAULT: 'var(--color-muted)',
          foreground: 'var(--color-muted-foreground)',
        },
        'background': 'var(--color-bg-base)',
        'foreground': 'var(--color-text-primary)',
        'ring': 'var(--color-accent)',
        'input': 'var(--color-border)',
        'border': 'var(--color-border)',
      },
      fontFamily: {
        display: 'var(--font-display)',
        body: 'var(--font-body)',
        mono: 'var(--font-mono)',
      },
      borderRadius: {
        lg: 'var(--radius-lg)',
        md: 'var(--radius-md)',
        sm: 'var(--radius-sm)',
      },
    },
  },
  plugins: [],
} satisfies Config
```

**src/assets/main.css** — CSS 变量定义 + 暗色主题：

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  /* Design token 颜色 */
  --color-bg-base: oklch(97% 0.018 70);
  --color-surface: oklch(99% 0.008 70);
  --color-text-primary: oklch(22% 0.02 50);
  --color-text-muted: oklch(50% 0.018 50);
  --color-border: oklch(90% 0.014 70);
  --color-accent: oklch(64% 0.13 28);
  --color-accent-light: oklch(92% 0.04 28);
  --color-success: oklch(70% 0.18 145);
  --color-warning: oklch(78% 0.15 85);
  --color-danger: oklch(62% 0.2 25);

  /* shadcn-vue 别名 */
  --color-primary-foreground: oklch(98% 0.005 70);
  --color-destructive-foreground: oklch(98% 0.005 70);
  --color-muted: oklch(96% 0.01 70);
  --color-muted-foreground: oklch(50% 0.018 50);
}

.dark {
  --color-bg-base: oklch(20% 0.015 50);
  --color-surface: oklch(25% 0.015 50);
  --color-text-primary: oklch(92% 0.008 70);
  --color-text-muted: oklch(65% 0.015 50);
  --color-border: oklch(35% 0.015 50);
  --color-accent: oklch(68% 0.13 28);
  --color-accent-light: oklch(30% 0.06 28);
  --color-danger: oklch(62% 0.2 25);

  --color-primary-foreground: oklch(22% 0.02 50);
  --color-destructive-foreground: oklch(98% 0.005 70);
  --color-muted: oklch(25% 0.015 50);
  --color-muted-foreground: oklch(65% 0.015 50);
}
```

**关键点**：
1. `tailwind.config.ts` 中的 `theme.extend.colors` 将颜色名映射到 CSS 变量（`var(--color-*)`）
2. 这使得 `bg-bg-base`、`text-text-primary`、`bg-primary`、`text-muted-foreground` 等 utility class 可用
3. shadcn-vue 组件期望的 `primary`、`destructive`、`muted`、`background`、`foreground` 等色名均已映射
4. 暗色主题通过 `.dark` class 覆盖 CSS 变量值（`darkMode: 'class'` 策略）
5. `design-system/tokens/` 目录保留作为 token 值的 TypeScript single source of truth，但最终通过 CSS 变量消费

### 3.1.2 P1 组件清单（12 个）

| 组件 | 用途 | 核心 Props |
|------|------|-----------|
| `Button` | 通用按钮 | `variant: primary/ghost/danger`, `size: sm/md/lg` |
| `Input` | 单行输入 | `placeholder`, `disabled`, `error` |
| `Textarea` | 多行输入（自适应高度） | `autoResize`, `maxHeight` |
| `Select` | 下拉选择 | `options`, `groups`, `multiple`, `searchable` |
| `ScrollArea` | 滚动容器（自定义滚动条） | `autoHide: boolean` |
| `Tooltip` | 悬浮提示 | `content`, `position: top/bottom/left/right` |
| `Dropdown` | 下拉菜单 | `trigger: click/hover`, `items` |
| `Dialog` | 模态对话框 | `open`, `title`, `@update:open` |
| `Tabs` | 标签切换 | `items`, `activeKey`, `onChange` |
| `Badge` | 状态标记 | `variant: success/warning/danger/idle`, `dot: boolean` |
| `Toggle` | 开关 | `checked`, `onChange` |
| `ProgressBar` | 进度条 | `value: 0-100`, `variant: accent/warning/danger` |

所有组件：
- 通过 design token 消费颜色，零硬编码
- 支持暗色主题（通过 ThemeProvider 自动切换 `.dark` class）
- 完整的 TypeScript props 类型
- 无障碍支持（aria-* 属性、键盘导航）
- 用户可见文案走 i18n
- Badge 组件使用 design token（`bg-success/15 text-success`），不硬编码 Tailwind 默认颜色

### 3.1.3 Markdown 渲染管线

**渲染引擎**：`markdown-it` + `dompurify`

**初始化**（`src/lib/markdown.ts`）：

```typescript
import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'

const md = new MarkdownIt({
  html: false,         // 禁止原始 HTML
  linkify: true,       // 自动链接化 URL
  typographer: true,   // 智能引号等排版
})

export function renderMarkdown(text: string): string {
  const raw = md.render(text)
  return DOMPurify.sanitize(raw, {
    ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'a', 'code', 'pre', 'ul', 'ol', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'span'],
    ALLOWED_ATTR: ['href', 'target', 'rel', 'class'],
  })
}
```

**P1 支持范围**：
- **加粗**、*斜体*、`行内代码`、[链接](url)、有序/无序列表、引用块
- 代码块使用 `<pre>` + 等宽字体，黑白底色
- 暂不支持：代码块语法高亮（P3）、LaTeX 公式（P3）、图片（P3）

**安全要求**：
- 所有工具输出必须通过 `DOMPurify` 消毒后渲染，防止 XSS
- `markdown-it` 禁用 `html: true`，防止用户/工具注入原始 HTML

### 3.1.4 Toast 通知系统

使用 `vue-sonner` 提供 Toast 通知。

**集成**（`App.vue`）：

```vue
<script setup>
import { Toaster } from 'vue-sonner'
</script>

<template>
  <Toaster position="top-right" :theme="isDark ? 'dark' : 'light'" />
  <!-- rest of app -->
</template>
```

**使用场景**：
- 操作成功/失败提示（Provider 配置保存、Session 删除等）
- 错误提示（WS 断连、pi 进程异常、API Key 无效）
- Agent 生成出错（`message.error` 事件 → toast.error()）
- 不用于对话消息（对话消息走 MessageBubble 渲染）

### 3.1.5 虚拟滚动

使用 `@tanstack/vue-virtual` 实现虚拟滚动。

**使用位置**：
- `MessageList.vue` — 消息列表虚拟滚动
- `AppSidebar.vue` — Session 列表（大量 Session 时保持流畅）

**配置**（MessageList.vue 示例）：

```typescript
import { useVirtualizer } from '@tanstack/vue-virtual'

const virtualizer = useVirtualizer({
  get count() { return messages.value.length },
  getScrollElement: () => scrollRef.value,
  estimateSize: () => 80,
  overscan: 5,
  measureElement: (el) => el?.getBoundingClientRect().height ?? 80,
})
```

**关键点**：
- `measureElement` 动态测量实际高度（消息高度差异大：短消息 ~40px，长消息 ~300px，工具调用 ~80-200px）
- 消息渲染后需调用 `measureElement` 更新缓存高度（处理 Markdown 渲染后的高度变化）

### 3.2 i18n

- `vue-i18n` v10 + Composition API 模式
- 类型安全：通过 Schema 类型导出实现 key 自动补全和缺失翻译编译时报错
- 初始支持 `zh-CN` 和 `en-US`
- 所有用户可见文案走 i18n，包括 design-system 组件内置文案
- 运行时切换语言，持久化到 localStorage（通过 Pinia persist）
- i18n schema 结构必须包含所有组件引用的 key（header / sidebar / chat / statusbar / settings / common），采用扁平或嵌套均可但必须与 `MessageSchema` 接口完全匹配

### 3.3 主题系统

- 内置 `light` / `dark` 两套主题
- `ThemeProvider.vue` 作为根级组件，根据 settings store 的 `theme` 值在 `<html>` 上添加/移除 `.dark` class
- `useTheme()` composable：读取 settings store，调用 `settingsStore.setTheme()`
- 主题类型统一为 `'light' | 'dark' | 'system'`（system 跟随 `prefers-color-scheme`）
- 持久化到 localStorage（通过 Pinia persist，由 `useSettingsStore` 统一管理）
- **不**在 useTheme 和 settings store 中重复管理主题——settings store 是唯一的状态源，ThemeProvider 和 useTheme 只是读取和代理

### 3.4 Git Hooks + 代码规范

**Pre-commit 检查链**（`.githooks/` + `npm prepare` 自动安装，零依赖）：

```
ESLint (--fix + --max-warnings=0) → vue-tsc --noEmit → vue_rules_checker.py
```

**自定义 ESLint 规则**（`taste-lint/` 插件，8 条）：

| 规则 | 级别 | 说明 |
|------|------|------|
| `no-hardcoded-colors` | error | 禁止 CSS/JS 中硬编码颜色值（hex/rgb/hsl），必须用 design token |
| `no-native-form-elements` | error | 禁止使用原生 `<button>/<input>/<select>/<textarea>`，必须用 design-system 组件 |
| `no-magic-spacing` | warn | 禁止 Tailwind 任意值如 `p-[17px]`、`gap-[3px]` |
| `no-hardcoded-strings` | warn | 提醒未走 i18n 的用户可见文案（允许 `/** */` 注释、`console.log`、`aria-*` 属性豁免） |
| `no-silent-catch` | warn | catch 块不能为空或仅 console，必须有实质错误处理 |
| `no-unsafe-object-entries` | warn | `Object.entries()` 动态构建前必须白名单过滤 |
| `prefer-allsettled` | warn | 独立数据源用 `Promise.allSettled` 而非 `Promise.all` |
| `no-magic-numbers` | warn | 魔法数字警告（豁免 0/1/-1） |

**Base ESLint 规则**（`taste-lint/base.mjs`）：

| 规则 | 级别 | 说明 |
|------|------|------|
| `@typescript-eslint/no-explicit-any` | error | 禁止 any 类型 |
| `max-lines` | warn | 单文件上限 500 行（不含注释和空行） |
| `max-lines-per-function` | warn | 单函数上限 300 行 |
| `no-eval` / `no-implied-eval` | error | 禁止 eval |
| `no-empty` | error | 空 block 必须有注释说明 |

**vue_rules_checker.py**（Python 脚本，ESLint 无法覆盖的结构性检查）：

| 检查 | 说明 |
|------|------|
| 禁止 Emoji | 必须用 `lucide-vue-next` 图标 |
| 禁止自定义 CSS | `<style scoped>` 内只允许 `@apply`，禁止手写选择器（`@keyframes`/`animation`/`transition` 例外） |
| `<template>` 上限 400 行 | 超限提示提取子组件 |
| `<script setup>` 上限 300 行 | 超限提示提取 composable 或子组件 |
| 禁止 Tab 缩进 | 仅允许 Space（2 空格） |

**Git hooks 安装方式**：
- 使用 `.githooks/` 目录 + `install-hooks.sh` 脚本
- `package.json` 中 `"prepare": "cd .githooks && ./install-hooks.sh"` 自动安装
- 零依赖（不需要 husky、lint-staged）

**其他规范**：
- `vue-tsc --noEmit` 类型检查必须通过
- Conventional Commits 提交格式
- 跳过检查：`SKIP_ALL_CHECKS=1`（全部）/ `SKIP_LINT=1`（ESLint）/ `SKIP_TYPE_CHECK=1`（tsc）/ `SKIP_CODE_RULES_CHECK=1`（Python 脚本）

---

## 四、功能层

### 4.1 App Shell 布局

```
┌─────────────────────────────────────────────────────────────┐
│ Header (48px): Logo | [通知预留] | [标准][专注] | [设置][主题] │
├────────────┬────────────────────────────────────────────────┤
│            │                                                │
│  Sidebar   │              Chat View                         │
│  (260px)   │                                                │
│            │  ┌────────────────────────────────────────┐    │
│  Session   │  │ Panel Bar (anchor 预留位)               │    │
│  Groups    │  ├────────────────────────────────────────┤    │
│            │  │                                        │    │
│  📁 proj-a │  │  Messages (虚拟滚动)                    │    │
│    ├─ 🟢 A │  │  👤 user → 🤖 assistant → 🔧 tool      │    │
│    └─ ⚪ B │  │                                        │    │
│            │  ├────────────────────────────────────────┤    │
│  📁 proj-b │  │ Textarea                               │    │
│    └─ ⚪ C │  │ [+] [sonnet@anthropic ▾] [上下文 34%] [发送] │
│            │  └────────────────────────────────────────┘    │
│  + 新建    │                                                │
├────────────┴────────────────────────────────────────────────┤
│ Statusbar (32px): 🟢 已连接 | ~/proj | sonnet:high | 12.3k │
└─────────────────────────────────────────────────────────────┘
```

**视图模式**：

| 模式 | 快捷键 | 说明 |
|------|--------|------|
| 标准模式 | `Cmd+1` | 左 Sidebar + 中 Chat + 底部 Statusbar |
| 专注模式 | `Cmd+3` | 仅 Chat，隐藏 Sidebar 和 Statusbar |

分屏模式（`Cmd+2`）和任务树模式（`Cmd+4`）在 P4 实现，Header 按钮保留但 disabled。

### 4.1.1 视图切换机制

**无 vue-router**：项目不使用 vue-router，通过响应式状态驱动视图切换。

**状态定义**（在 `useSettingsStore` 中）：

```typescript
type AppView = 'chat' | 'settings'

// settings store 中
currentView: ref<AppView>('chat'),
focusMode: ref(false),
```

**切换规则**：

| 触发 | 效果 |
|------|------|
| 点击 Header 齿轮按钮 | `currentView = 'settings'` |
| Settings 内点击关闭/返回 | `currentView = 'chat'` |
| `Cmd+,` | `currentView = 'settings'` |
| `Esc`（在 Settings 中） | `currentView = 'chat'` |
| `Cmd+1` | `focusMode = false`（标准模式） |
| `Cmd+3` | `focusMode = true`（专注模式） |

**渲染逻辑**（`App.vue` template）：

```vue
<template>
  <div class="h-screen flex flex-col" :class="{ 'focus-mode': settingsStore.focusMode }">
    <Toaster position="top-right" />
    <AppHeader
      v-if="!settingsStore.focusMode"
      @open-settings="settingsStore.currentView = 'settings'"
    />
    <div class="flex-1 flex overflow-hidden">
      <AppSidebar v-if="settingsStore.currentView === 'chat' && !settingsStore.focusMode" />
      <ChatView v-if="settingsStore.currentView === 'chat'" />
      <SettingsView
        v-if="settingsStore.currentView === 'settings'"
        @close="settingsStore.currentView = 'chat'"
      />
    </div>
    <AppStatusbar v-if="!settingsStore.focusMode" />
  </div>
</template>
```

### 4.2 Header (`AppHeader.vue`)

```
[ xyz-agent ]  [--- spacer ---]  [已完成·3] [请求回应·2]  |  [□][▣]  |  [⚙][🌙]
                                     ↑ P1 隐藏              ↑ 视图     ↑ 设置+主题
```

| 区域 | P1 实现 | 后续 Phase |
|------|---------|-----------|
| Logo | ✅ `xyz-agent` | — |
| 通知按钮 | ❌ 隐藏，但 DOM 结构预留 | P5 SubAgent |
| 视图切换 | ✅ 标准 + 专注（分屏 disabled） | P4 补充分屏 |
| 设置按钮 | ✅ 点击 → `settingsStore.currentView = 'settings'` | — |
| 主题切换 | ✅ 明/暗切换（调用 `settingsStore.setTheme()`） | — |

### 4.3 Sidebar (`AppSidebar.vue`)

```
┌──────────────┐
│ 🔍 搜索会话   │  ← SessionSearch.vue
├──────────────┤
│ 📁 xyz-agent │  ← SessionGroup.vue（按 cwd 自动分组）
│   ├─ 🟢 A   │  ← SessionItem.vue（状态点 + 标题 + 相对时间）
│   ├─ ⚪ B   │     右键菜单（Dropdown 组件）：重命名 / 删除
│   └─ ⚪ C   │     点击切换 Session
│              │
│ 📁 work-proj │
│   └─ ⚪ D   │
├──────────────┤
│  + 新建会话   │  ← 点击弹出 cwd 文件夹选择器（Tauri 原生）
└──────────────┘
```

**功能**：
- 按 cwd 自动分组（不需要手动 Tag，Tag 在 P2 实现）
- 显示最近 50 个 Session，按最后活动时间倒序
- 搜索过滤（过滤标题和首条消息内容）
- 虚拟滚动（`@tanstack/vue-virtual`，大量 Session 流畅浏览）
- 可折叠（拖拽调整宽度或点击按钮收起）
- Session 状态：🟢 活跃 / ⚪ 闲置
- SessionItem 右键菜单使用 design-system `Dropdown` 组件（不使用原生 `<div>` + Teleport）

### 4.4 Chat View (`ChatView.vue`)

**消息类型**：

| 类型 | 渲染方式 | 组件 |
|------|---------|------|
| 用户消息 | 右对齐气泡，基础 Markdown | `MessageBubble.vue` |
| 助手文本 | 左对齐气泡，基础 Markdown + 流式逐字显示 | `StreamingText.vue` |
| 工具调用 | 独立卡片，显示工具名 + 输入摘要 + 状态，可折叠 | `ToolCallCard.vue` |
| 思考过程 | 默认折叠块 "思考中…"，点击展开 | `ThinkingBlock.vue` |

**P1 消息数据模型**（扁平模型）：

```typescript
interface Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  toolCalls?: ToolCall[]
  thinking?: ThinkingBlock[]
  usage?: Usage
  timestamp: number
}

interface ToolCall {
  id: string
  toolName: string
  input: string
  output?: string
  status: 'running' | 'completed' | 'error'
}

interface ThinkingBlock {
  id: string
  content: string
}
```

> **注意**：P1 使用扁平消息模型（`content` + `toolCalls` + `thinking` 字段），不使用 segments 模型。`MessageBubble.vue` 基于此模型渲染。

**ToolCallCard 结构**：

```
┌─ 🔧 read ──────────────────────────┐
│  src/auth/interfaces.ts      ✅ 完成 │  ← 折叠态
└────────────────────────────────────┘
┌─ 🔧 edit ──────────────────────────┐
│  src/auth/interfaces.ts      ✅ 完成 │  ← 展开态
│────────────────────────────────────│
│  - export interface IAuthResponse { │
│  + export interface IAuthModule {   │
│  ...                               │
└────────────────────────────────────┘
```

### 4.5 Chat Input (`ChatInput.vue`)

```
┌──────────────────────────────────────────┐
│  输入消息… (Enter 发送, Shift+Enter 换行)  │  ← Textarea（自适应高度，最大 140px）
├──────────────────────────────────────────┤
│ [+] [sonnet @ anthropic ▾] [上下文 ██░ 34%]    [⬆] [■] │  ← Toolbar
└──────────────────────────────────────────┘
```

| 元素 | 功能 |
|------|------|
| `[+]` 上传按钮 | P1 仅占位，暂不实现上传 |
| `ModelPicker` | 点击展开分组下拉：常用 / Anthropic / OpenAI / DeepSeek / … |
| `ContextBar` | token 用量进度条，颜色随用量变化（accent → warning → danger） |
| `[⬆]` 发送按钮 | Enter 发送，Shift+Enter 换行 |
| `[■]` 中断按钮 | 生成中才显示，替代发送按钮 |
| `SlashMenu` | 输入 `/` 触发浮层，P1 先搭框架（空菜单） |

**ModelPicker 分组结构**：

```
┌─────────────────────────┐
│ 常用                      │
│  ● claude-sonnet  anthropic│
│    gpt-4o         openai  │
│    gemini-2.5-pro google  │
│    deepseek-v4    deepseek│
│ Anthropic                │
│    claude-opus    anthropic│
│    claude-haiku   anthropic│
│ OpenAI                   │
│    gpt-4o-mini    openai  │
│ DeepSeek                 │
│    deepseek-r1    deepseek│
└─────────────────────────┘
```

分组逻辑：常用（最近使用的 4 个）+ 按 Provider 分组。模型列表从 Sidecar 获取（`model.list` 命令）。

### 4.6 Settings View (`SettingsView.vue`)

点击 Header 齿轮按钮，全屏替代主界面（与 Chat 同级，不是弹窗）。由 `settingsStore.currentView` 状态驱动切换。

```
┌─────────────┬──────────────────────────────────┐
│ 设置         │  供应商                           │
│              │                                  │
│ > 供应商     │  已配置的供应商                    │
│   SKILL      │  ┌─────────────────────────────┐│
│   AGENT      │  │ Anthropic      ✅ 已连接     ││
│              │  │ claude-sonnet, opus, haiku   ││
│              │  │              [编辑] [删除]    ││
│              │  └─────────────────────────────┘│
│              │  ┌─────────────────────────────┐│
│              │  │ OpenAI         ❌ 未配置     ││
│              │  │ ──            [添加 API Key] ││
│              │  └─────────────────────────────┘│
│              │                                  │
│              │  [+ 添加供应商]                    │
│              │                                  │
│              │  默认配置                          │
│              │  默认模型    [claude-sonnet ▾]     │
│              │  思考模式    [high ▾]              │
│              │  温度        [0.7]                 │
│              │                                  │
│              │  语言        [中文 ▾]              │
│              │  主题        [跟随系统 ▾]          │
└─────────────┴──────────────────────────────────┘
```

**P1 实现**：
- ✅ 供应商 Tab：Provider 列表 + 添加/编辑/删除 + 默认模型配置
- ❌ SKILL Tab：仅显示 "即将推出" 占位
- ❌ AGENT Tab：仅显示 "即将推出" 占位
- ✅ 语言和主题设置（放在供应商 Tab 底部）

**ProviderInfo 类型**：

```typescript
type ProviderStatus = 'connected' | 'not_configured' | 'error'

interface ProviderInfo {
  id: string
  name: string
  status: ProviderStatus    // 统一使用 status 字段，不是 boolean connected
  models?: ModelInfo[]
}
```

`ProviderList.vue` 使用 `provider.status === 'connected'` 判断连接状态。

### 4.7 Statusbar (`AppStatusbar.vue`)

```
🟢 已连接 | ~/Code/xyz-agent | sonnet:high | 12.3k tokens |          | Cmd+J 总览 · Cmd+1 标准 · Cmd+3 专注
```

| 元素 | 数据源 |
|------|--------|
| 连接状态 + 圆点 | WS 连接状态（绿=已连接，红=断开，黄=重连中） |
| cwd | 当前 Session 的工作目录 |
| 模型 | 当前 Session 使用的模型 |
| token 用量 | 当前 Session 累计 token |
| 快捷键提示 | 静态文案（P1 只提示 Cmd+1 和 Cmd+3） |

### 4.8 快捷键

快捷键通过 Tauri 的 `tauri-plugin-global-shortcut` 在 **Rust 侧注册**，确保即使应用窗口不在焦点也能响应。

| 快捷键 | 功能 | P1 实现 |
|--------|------|---------|
| `Cmd+1` | 标准模式 | ✅ Rust globalShortcut → emit Tauri event → 前端监听 |
| `Cmd+3` | 专注模式 | ✅ Rust globalShortcut → emit Tauri event → 前端监听 |
| `Cmd+,` | 打开设置 | ✅ Rust globalShortcut → emit Tauri event → 前端监听 |
| `Cmd+J` | 总览模式 | ❌ P4 实现 |
| `Cmd+2` | 分屏模式 | ❌ P4 实现 |
| `Cmd+4` | 任务树模式 | ❌ P4 实现 |
| `Esc` | 退出设置/取消生成 | ✅ 前端 keydown 监听（应用内即可） |
| `Enter` | 发送消息 | ✅ ChatInput 内部处理 |
| `Shift+Enter` | 换行 | ✅ ChatInput 内部处理 |

**注册方式**（`src-tauri/src/shortcuts.rs`）：

```rust
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

pub fn register_shortcuts(app: &tauri::App) {
    let shortcut = app.global_shortcut();

    shortcut.on_shortcut("CmdOrCtrl+1", |app, _| {
        app.emit("shortcut:standard-mode", ()).ok();
    });
    shortcut.on_shortcut("CmdOrCtrl+3", |app, _| {
        app.emit("shortcut:focus-mode", ()).ok();
    });
    shortcut.on_shortcut("CmdOrCtrl+,", |app, _| {
        app.emit("shortcut:settings", ()).ok();
    });
}
```

**前端监听**（`App.vue`）：

```typescript
// 在 onMounted 中
const unlistenStandard = listen('shortcut:standard-mode', () => {
  settingsStore.focusMode = false
})
const unlistenFocus = listen('shortcut:focus-mode', () => {
  settingsStore.focusMode = true
})
const unlistenSettings = listen('shortcut:settings', () => {
  settingsStore.currentView = settingsStore.currentView === 'settings' ? 'chat' : 'settings'
})

// onUnmounted 中调用 unlisten
```

**Cargo.toml 依赖**：

```toml
[dependencies]
tauri-plugin-global-shortcut = "2"
tauri-plugin-shell = "2"
tauri-plugin-dialog = "2"
```

---

## 五、WebSocket 协议

### 5.1 消息格式

所有消息统一为 `{ type: string, id?: string, payload: any }`。

`id` 字段用于请求-响应配对（客户端发送带 id 的请求，服务端响应时回传相同 id）。

**类型定义在 `shared/protocol.ts` 中**，前端和 sidecar 均从此文件导入，确保类型一致。

### 5.2 客户端 → Sidecar

| type | payload | 说明 |
|------|---------|------|
| `session.create` | `{ cwd?: string }` | 新建会话 |
| `session.delete` | `{ sessionId }` | 删除会话 |
| `session.list` | `{}` | 获取会话列表 |
| `session.switch` | `{ sessionId }` | 切换当前会话（加载历史消息） |
| `session.history` | `{ sessionId }` | 获取会话历史消息 |
| `message.send` | `{ sessionId, content }` | 发送用户消息 |
| `message.abort` | `{ sessionId }` | 中断当前生成 |
| `config.getProviders` | `{}` | 获取 Provider 配置 |
| `config.setProvider` | `{ providerId, apiKey?, baseUrl?, ... }` | 设置 Provider |
| `config.deleteProvider` | `{ providerId }` | 删除 Provider |
| `model.list` | `{}` | 获取可用模型列表 |
| `model.switch` | `{ sessionId, modelId }` | 切换当前会话模型 |
| `ping` | `{}` | 心跳 |

### 5.3 Sidecar → 客户端

下表包含 WS 协议事件名称（保持不变）以及对应的 pi RPC 事件源。Sidecar 的 `event-adapter.ts` 负责将 pi 子进程的 RPC 事件转换为 WS 协议事件——**WS 协议的事件名称和格式保持不变，翻译工作在 sidecar 内部完成**。

| type | payload | pi RPC 事件源 | 说明 |
|------|---------|-------------|------|
| `session.created` | `{ sessionId, label, cwd }` | — | 会话创建成功 |
| `session.deleted` | `{ sessionId }` | — | 会话已删除 |
| `session.list` | `{ groups: Array<{ cwd, sessions: SessionSummary[] }> }` | — | 会话列表（按 cwd 分组） |
| `session.history` | `{ sessionId, messages: Message[] }` | `get_messages` 命令 | 历史消息 |
| `message.text_delta` | `{ sessionId, delta }` | `message_update`（text_delta） | 流式文本片段 |
| `message.thinking_delta` | `{ sessionId, delta }` | `message_update`（thinking_delta） | thinking 片段 |
| `message.tool_call_start` | `{ sessionId, toolCallId, toolName, input }` | `tool_call_start` | 工具调用开始 |
| `message.tool_call_end` | `{ sessionId, toolCallId, output }` | `tool_call_end` | 工具调用结束 |
| `message.complete` | `{ sessionId, stopReason, usage }` | `agent_end` | 消息生成完毕 |
| `message.error` | `{ sessionId, error }` | pi 异常 / 进程退出 | 生成出错 |
| `config.providers` | `{ providers: ProviderInfo[] }` | — | Provider 列表 |
| `config.providerUpdated` | `{ providerId }` | — | Provider 已更新 |
| `model.list` | `{ models: ModelInfo[] }` | `get_available_models` 命令 | 模型列表 |
| `model.switched` | `{ sessionId, modelId }` | — | 模型已切换 |
| `pong` | `{}` | — | 心跳响应 |
| `error` | `{ message, code? }` | — | 通用错误 |

**事件适配说明**：

1. Sidecar 为每个 session 维护一个 pi 子进程（RPC 模式：`pi --mode rpc`）
2. pi 子进程通过 stdin/stdout JSONL 协议通信
3. pi 的 `AgentEvent` 通过 stdout 推送，`rpc-client.ts` 解析 JSONL 并分发到 `event-adapter.ts`
4. `event-adapter.ts` 将 pi 事件名映射为 WS 协议事件名（如 `message_update` → `message.text_delta`）
5. P1 仅处理核心事件（text_delta / thinking_delta / tool_call_start / tool_call_end / agent_end），其余事件忽略但预留扩展接口
6. pi SDK 的其他事件（`compaction_start/end`、`auto_retry_start/end`、`session_info_changed`）在后续 Phase 处理

**StopReason 映射**（在 `event-adapter.ts` 中完成）：

| pi RPC `agent_end` reason | WS 协议 `stopReason` |
|--------------------------|---------------------|
| `"stop"` | `"end_turn"` |
| `"length"` | `"max_tokens"` |
| `"toolUse"` | `"tool_use"` |
| `"error"` | `"error"` |
| `"aborted"` | `"aborted"` |

### 5.4 Session 列表格式

`session.list` 的 payload 统一使用分组格式：

```typescript
interface SessionListPayload {
  groups: Array<{
    cwd: string
    sessions: SessionSummary[]
  }>
}

interface SessionSummary {
  id: string
  label: string
  cwd: string
  lastActiveAt: number    // Unix 时间戳（Date.now()），不是 ISO 字符串
  status: 'active' | 'idle'
}
```

所有使用处（`useSession.ts`、`session-pool.ts`、`server.ts`）统一使用此分组格式。

---

## 六、Sidecar 架构

### 6.1 集成方式：Path B — Subprocess RPC

**Sidecar spawn pi 子进程，通过 stdin/stdout JSONL 协议通信。**

**选择理由**（基于 integration-investigation.md 调研）：

| 维度 | Subprocess RPC | Direct SDK Import |
|------|---------------|-------------------|
| 进程隔离 | ✅ 完全隔离，崩溃不影响 Sidecar | ❌ 同进程，互相影响 |
| SubAgent 扩展性（P5/P6） | ✅ 每个 SubAgent 独立进程 | ❌ 需自建隔离层 |
| RPC 桥接兼容性（P6） | ✅ 原生支持 extension_ui_request/response | ❌ 需重造代理层 |
| pi 版本升级影响 | ✅ 只依赖 RPC 协议稳定性 | ❌ 内部 API breaking change 直接影响 |
| 全局状态风险 | ✅ pi 副作用隔离在子进程中 | ❌ chalk/stdout/env 污染 |
| 性能开销 | ⚠️ 进程启动 ~700ms + JSON 序列化 | ✅ 零 IPC 开销 |

**架构决策**：P1 采用 Subprocess RPC，与 P5/P6 天然兼容，避免 Phase 切换时的架构重构。

### 6.2 模块职责

| 模块 | 职责 |
|------|------|
| `index.ts` | 入口：解析端口参数，启动 WS 服务器 + HTTP health endpoint |
| `server.ts` | WS 连接管理（单客户端）、消息路由、心跳 |
| `session-pool.ts` | `Map<sessionId, PiProcess>`，管理所有活跃的 pi 子进程 |
| `process-manager.ts` | pi 子进程生命周期管理：spawn（`pi --mode rpc`）、kill（SIGTERM → SIGKILL）、崩溃检测、自动重启 |
| `rpc-client.ts` | RPC 协议客户端：stdin 命令发送、stdout JSONL 解析、请求-响应关联（`id` 字段）、事件分发 |
| `event-adapter.ts` | pi RPC 事件 → WS 协议事件翻译（事件名映射 + StopReason 转换） |
| `config-store.ts` | xyz-agent 自身设置读写（`~/.xyz-agent/settings.json`，JSON 格式） |
| `provider-store.ts` | Provider API Key 管理（存储、传递给 pi 子进程作为环境变量） |

**核心流程**：

```
前端 WS 消息 → server.ts 路由 → session-pool.ts 查找 PiProcess
  → PiProcess.rpcClient.sendCommand(...) → stdin JSONL → pi 子进程
  → pi stdout JSONL → rpc-client.ts 解析 → event-adapter.ts 翻译
  → server.ts 通过 WS → 前端
```

### 6.3 pi 子进程管理

**创建 Session = spawn pi 子进程**：

```typescript
// process-manager.ts
import { RpcClient } from '@mariozechner/pi-coding-agent'

export class ProcessManager {
  async createSession(sessionId: string, cwd: string, env: Record<string, string>): Promise<RpcClient> {
    const client = new RpcClient({
      cwd,
      env,   // { ANTHROPIC_API_KEY: "sk-ant-...", ... }
    })
    await client.start()
    // 内部执行：spawn("node", ["pi/cli.js", "--mode", "rpc", "--cwd", cwd])
    return client
  }

  async destroySession(client: RpcClient): Promise<void> {
    await client.stop()
    // 内部：SIGTERM → 等 1s → SIGKILL
  }
}
```

**Session 池**（`session-pool.ts`）：

```typescript
interface PiProcess {
  sessionId: string
  client: RpcClient
  cwd: string
  createdAt: number
}

const sessions = new Map<string, PiProcess>()
```

**配置传递**：

- API Key：从 `provider-store.ts` 读取，作为环境变量传递给 pi 子进程（`ANTHROPIC_API_KEY=...`）
- 模型选择：通过 RPC 命令 `set_model` 设置
- 工具集：pi 默认使用所有内置工具（read/bash/edit/write/grep/find/ls），P1 不自定义
- pi 子进程内部自行管理 AuthStorage/ModelRegistry/SessionManager，Sidecar 不直接使用这些 SDK 类

### 6.4 Sidecar 生命周期

1. Tauri 启动时 `sidecar.rs` spawn Node.js sidecar 进程，通过 CLI 参数传递 WS 端口（`--port 3210`）
2. Sidecar 启动 WS 服务器 + HTTP `/health` endpoint
3. Sidecar 通过 Tauri event 将端口号通知前端（`app.emit("sidecar-port", port)`）
4. 前端监听 `sidecar-port` 事件，使用收到的端口创建 WS 连接
5. 前端 WS 连接后，Sidecar 扫描已有 Session 目录，发送 `session.list`
6. 用户发消息时，Sidecar 为该 session spawn pi 子进程（如尚未启动）
7. pi 子进程通过 stdin/stdout JSONL 通信，事件经 event-adapter 翻译后推送到前端
8. Tauri 关闭时发送 SIGTERM，Sidecar 优雅关闭（SIGTERM 所有 pi 子进程、断开 WS）

### 6.5 Tauri Sidecar 配置

**tauri.conf.json 配置**：

```json
{
  "bundle": {
    "externalBin": ["binaries/sidecar"]
  },
  "plugins": {
    "shell": {
      "sidecar": true,
      "scope": [{ "name": "binaries/sidecar", "sidecar": true }]
    }
  }
}
```

**Cargo.toml 依赖**：

```toml
[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-shell = "2"
tauri-plugin-dialog = "2"
tauri-plugin-global-shortcut = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["full"] }
```

### 6.6 WS 端口发现机制

Sidecar 的 WS 端口通过以下机制传递给前端：

1. Rust `sidecar.rs` 启动时动态选择可用端口（从 `DEFAULT_PORT = 3210` 开始，被占用则递增 `3211`、`3212`…，最多尝试 10 个）
2. 选定端口通过 CLI 参数传给 sidecar：`node sidecar/dist/index.js --port 3210`
3. 同时将端口号写入临时文件 `~/.xyz-agent/sidecar.port`（作为前端冷启动时的备用发现方式）
4. Rust 通过 Tauri event 将端口号通知前端：`app.emit("sidecar-port", port)`
5. 前端优先监听 `sidecar-port` Tauri event 获取端口
6. 如果前端启动时未收到 event（如 sidecar 先于前端就绪），从 `~/.xyz-agent/sidecar.port` 文件读取端口
7. **所有端口引用统一为 `3210`**，消除之前 plan 中的不一致（9250 / 17777 / 3210）

### 6.7 健康检查与崩溃重启

**健康检查**：

- Sidecar `index.ts` 注册 HTTP `GET /health` endpoint（返回 200 OK）
- Rust 侧 `sidecar.rs` 每 200ms 轮询 `/health`，最多等待 10 秒
- 不使用 TCP connect 测试（WS 服务器可能已绑定但未 ready）

**Sidecar 崩溃重启**：

- Rust 侧监听 sidecar child process 的 exit 事件
- 非正常退出（code != 0）时自动重启，最多重试 3 次
- 重启时重新分配端口并通知前端（emit `sidecar-port` event）
- 前端收到新端口后自动重连

**pi 子进程崩溃**：

- Sidecar 的 `process-manager.ts` 监听 pi 子进程的 exit 事件
- 异常退出时通过 WS 发送 `message.error` 通知前端
- 前端显示 Toast 错误提示，用户可重新发起对话（Sidecar 重新 spawn pi 子进程）

### 6.8 错误处理策略

| 场景 | Sidecar 行为 | 前端表现 |
|------|-------------|---------|
| pi 子进程调用失败 | 发送 `message.error` | Toast 错误提示（`toast.error()`） |
| pi 子进程崩溃 | process-manager 检测 exit → 发送 `message.error` | Toast + 引导重新发起 |
| WS 断开 | — | Statusbar 显示断开状态，`useConnection` 自动重连 |
| Sidecar 进程崩溃 | Rust 检测到退出 | 自动重启 Sidecar + 前端自动重连 |
| Provider API Key 无效 | pi 子进程返回 error → `message.error` | Toast + 引导去设置页配置 |
| WS 断连期间发出的消息 | `ws-client.ts` 消息发送队列（离线缓冲） | 连接恢复后自动重发 |

**AppError 类型**（`shared/types.ts`）：

```typescript
interface AppError {
  message: string
  code?: 'CONNECTION_LOST' | 'PROVIDER_ERROR' | 'SESSION_NOT_FOUND' | 'PROCESS_CRASHED' | 'TIMEOUT'
  retryable?: boolean
}
```

### 6.9 生产模式打包

- **开发模式**：`node sidecar/dist/index.js --port <port>`
- **生产模式**：使用 `pkg` 或 Node.js SEA (Single Executable Application) 编译为单二进制
- 编译后的二进制放入 `src-tauri/binaries/` 目录，通过 Tauri sidecar API 管理
- P1 先以开发模式交付，生产打包在 P1 后期或 P2 解决

---

## 七、前端状态管理（Pinia）

### 7.1 Store 划分

| Store | 状态 | 关键 actions |
|-------|------|-------------|
| `useChatStore` | 当前对话的消息列表、生成中标志、流式缓冲 | `addMessage()`, `appendDelta()`, `clearStream()` |
| `useSessionStore` | 所有 Session 列表（按 cwd 分组）、当前活跃 Session ID | `loadSessions()`, `createSession()`, `deleteSession()`, `switchSession()` |
| `useSettingsStore` | 语言、主题、默认模型、`currentView`、`focusMode`（持久化到 localStorage） | `setTheme()`, `setLocale()`, `setDefaultModel()`, `setCurrentView()` |

### 7.2 Pinia 持久化配置

使用 `pinia-plugin-persistedstate` 实现 `useSettingsStore` 自动持久化到 localStorage。

**main.ts 注册**（合并 i18n + pinia + persist）：

```typescript
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
import { createI18n } from 'vue-i18n'
import App from './App.vue'
import { messages } from './i18n'

const pinia = createPinia()
pinia.use(piniaPluginPersistedstate)

const i18n = createI18n({
  legacy: false,
  locale: 'zh-CN',
  fallbackLocale: 'en-US',
  messages,
})

const app = createApp(App)
app.use(pinia)
app.use(i18n)
app.mount('#app')
```

**settings store 持久化**：

```typescript
export const useSettingsStore = defineStore('settings', () => {
  const theme = ref<'light' | 'dark' | 'system'>('system')
  const locale = ref('zh-CN')
  const defaultModel = ref('claude-sonnet')
  const currentView = ref<'chat' | 'settings'>('chat')
  const focusMode = ref(false)

  // ... actions

  return { theme, locale, defaultModel, currentView, focusMode, /* actions */ }
}, {
  persist: {
    pick: ['theme', 'locale', 'defaultModel'],
    // currentView 和 focusMode 不持久化，每次启动默认 chat + 标准模式
  },
})
```

### 7.3 数据流

```
WS 事件 → ws-client.ts → event-bus.ts → composable → store → Vue 响应式更新 → 组件渲染

ws-client.ts 接口：
  connect(url) / disconnect()
  send(message: ClientMessage)
  onStateChange(callback: (state: 'connected' | 'disconnected' | 'reconnecting') => void)
  onMessage(callback: (message: ServerMessage) => void)

event-bus.ts 接口：
  emit(message: ServerMessage)   // 统一传递 ServerMessage 对象
  on(type: string, handler: (message: ServerMessage) => void)  // handler 接收完整 ServerMessage
  off(type: string, handler)

示例：流式文本
  WS: { type: "message.text_delta", payload: { sessionId, delta: "你好" } }
  → ws-client.ts 接收
  → event-bus.ts 分发
  → useChat composable 处理（handler 内部解析 msg.payload）
  → chatStore.appendDelta("你好")
  → StreamingText.vue 自动更新
```

**事件处理器签名规范**：所有 composable 中的 eventBus handler 统一接收 `(msg: ServerMessage)`，在内部通过 `const data = msg.payload as XxxPayload` 解构 payload。不直接传递解构后的数据。

### 7.4 类型一致性规范

以下类型在 `shared/types.ts` 和 `shared/protocol.ts` 中定义，所有使用处必须对齐：

| 类型 | 规范 | 说明 |
|------|------|------|
| `ToolCall.status` | `'running' \| 'completed' \| 'error'` | 统一使用 `completed`，不是 `done` |
| `SessionSummary.lastActiveAt` | `number` | Unix 时间戳（`Date.now()`），不是 ISO 字符串 |
| `ProviderInfo.status` | `ProviderStatus` | 使用 `status: ProviderStatus` 字段，不是 `connected: boolean` |
| `SessionListPayload` | `{ groups: Array<{ cwd, sessions }> }` | 分组格式，不是扁平的 `{ sessions: [...] }` |
| `Dialog` 事件 | `@update:open` | 不是 `@close` |
| `Select` props | `options` + `groups` | 两种 prop 均支持，`ProviderForm.vue` 使用 `options` |

---

## 八、技术栈汇总

| 层 | 技术 | 版本 |
|----|------|------|
| 桌面壳 | Tauri v2 | latest |
| 前端框架 | Vue 3 | 3.5+ |
| 状态管理 | Pinia + pinia-plugin-persistedstate | latest |
| UI 基础 | Radix Vue + Tailwind CSS **v3** | v3.x |
| Markdown | markdown-it + dompurify（XSS 防护） | latest |
| Toast | vue-sonner | latest |
| 虚拟滚动 | @tanstack/vue-virtual | latest |
| i18n | vue-i18n | v10+ |
| 类型检查 | vue-tsc | latest |
| Lint | ESLint flat config + 自定义规则 | v9+ |
| Agent 引擎 | @mariozechner/pi-coding-agent（RPC 模式） | latest |
| 后端通信 | WebSocket (ws) + HTTP (health check) | latest |
| 进程通信 | stdin/stdout JSONL（pi RPC 协议） | — |
| 构建工具 | Vite | latest |
| Git Hooks | `.githooks/` + `install-hooks.sh` | 零依赖 |

---

## 九、不在 P1 范围内

以下能力在后续 Phase 实现：

| 能力 | Phase |
|------|-------|
| 代码块语法高亮 | P3 |
| LaTeX 公式渲染 | P3 |
| 图片预览 | P3 |
| 分屏模式 | P4 |
| SubAgent 拆分/Tab/任务树 | P5 |
| RPC 桥接交互式通信（extension_ui_request 代理） | P6 |
| Session Tag 系统 | P2 |
| 文件上传 | P3+ |
| Skill 管理 UI | P3+ |
| Agent 管理 UI | P5+ |
| Overview 全局总览 | P4 |
| Drawer 右侧面板 | P5 |
| pi SDK Direct Import 混合模式 | 按需 |

---

## 十、关键风险

| 风险 | 缓解措施 |
|------|---------|
| pi RPC 协议变化 | Sidecar 的 `rpc-client.ts` + `event-adapter.ts` 封装了所有 pi 交互，协议变化只需修改这两个文件 |
| pi 子进程启动延迟（~700ms） | P1 可接受（单 Session 场景）；P5 引入进程池预热 |
| WS 连接不稳定 | 前端自动重连 + 消息发送队列缓冲 + Statusbar 状态提示 |
| Design System 组件不够用 | P1 只做需要的 12 个，后续按需扩展 |
| 虚拟滚动性能 | 使用 `@tanstack/vue-virtual` + `measureElement` 动态测量 |
| Markdown XSS | markdown-it 渲染必须通过 DOMPurify 消毒，防止工具输出中的恶意 HTML |
| Tailwind v3 色彩别名 | `tailwind.config.ts` 中 `theme.extend.colors` 映射 CSS 变量到 shadcn-vue 期望的色名 |
| 多 Session 内存占用 | 每个 pi 子进程 ~30-50MB，限制最大并发 Session 数 |
| 生产打包 Sidecar | 开发模式用 `node sidecar/dist/index.js`，生产用 pkg/SEA 编译为单二进制 |
| Cmd+, 快捷键冲突 | macOS 系统保留 Cmd+,，如遇冲突改为 Cmd+Shift+, |
| 共享类型同步 | `shared/` 目录 + TypeScript path alias，前后端和 sidecar 从同一源导入 |
