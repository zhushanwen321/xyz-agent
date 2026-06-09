# Phase 1: Hello pi — 设计规格 v3

**日期**: 2026-05-06 | **阶段**: P1 (共 6 阶段) | **代号**: Hello pi
**基于**: spec-v2.md + arch-optimization-v2.md (五项目综合分析) + arch-frontend.md + arch-backend.md

> 目标：搭建 Tauri + Vue 3 + Node.js Sidecar 的完整三层架构，实现单 Agent 对话的完整桌面应用。
> 这是 xyz-agent 的最小可交付产品——一个 pi 的 Tauri GUI 壳。
> v3 变更：融入五项目分析 (Claude Code / Codex CLI / Aider / OpenCode / Crush) 的 10 项核心设计优化。

---

## 一、交付标准

Phase 1 结束后，用户可以：

- [ ] 在桌面应用中与 AI Agent 正常对话（流式输出，稳定列表 + 流式容器分离渲染）
- [ ] 看到 Agent 的工具调用，使用专用渲染器（Bash 终端风格 / Edit diff 视图 / Read 文件预览 / 默认 JSON）
- [ ] 看到 Agent 的思考过程（thinking），默认折叠
- [ ] 工具调用需要审批时看到内联审批卡片（Allow / Deny / Always Allow），60s 超时自动拒绝
- [ ] 使用 `/compact`、`/clear`、`/help`、`/model` 等 Slash 命令
- [ ] 在输入框切换模型（分组下拉：常用 / Anthropic / OpenAI / ...）
- [ ] 在设置页配置 Provider（添加/编辑/删除 API Key）+ 工具权限配置
- [ ] 在左侧 Sidebar 查看按工作目录分组的 Session 列表
- [ ] 新建 Session（选择工作目录） / 删除 Session / 切换 Session
- [ ] 中断当前生成
- [ ] 上下文用量条展示实时百分比（accent < 40%, warning 40-70%, danger > 70%），> 85% 自动触发压缩
- [ ] 切换明/暗主题
- [ ] 切换标准/专注两种视图模式
- [ ] 在底部状态栏看到连接状态、cwd、模型、token 用量
- [ ] 通过键盘快捷键切换视图模式（Cmd+1 / Cmd+3）和打开设置（Cmd+,）
- [ ] Toast 通知提示操作结果和错误信息
- [ ] Agent 启动时自动读取项目根目录的 CLAUDE.md / xyz-agent.md 作为上下文

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
│   │   │   └── SettingsView.vue  # 设置全屏视图（Tab: 供应商 / 工具权限 / SKILL预留 / AGENT预留）
│   │   ├── sidebar/
│   │   │   ├── SessionSearch.vue # 搜索框
│   │   │   ├── SessionGroup.vue  # 按目录分组的会话列表
│   │   │   └── SessionItem.vue   # 单个会话（状态点 + 标题 + 时间 + 右键菜单）
│   │   ├── chat/
│   │   │   ├── ChatView.vue      # 对话主容器
│   │   │   ├── MessageList.vue   # 稳定消息列表（completedMessages，静态，不重渲染）
│   │   │   ├── StreamingMessage.vue # 流式消息容器（streamingMessage，响应式 + rAF 批处理）
│   │   │   ├── MessageBubble.vue # 消息气泡（user / assistant / system 三态）
│   │   │   ├── ToolCallCard.vue  # 工具调用卡片（注册表分发器，按工具名查找渲染器）
│   │   │   ├── ToolApprovalCard.vue # 工具审批内联卡片（Allow / Deny / Always Allow）
│   │   │   ├── ThinkingBlock.vue # 思考折叠块
│   │   │   ├── StreamingText.vue # 流式文本（逐字 + 光标闪烁）
│   │   │   ├── ChatInput.vue     # 输入区（textarea + toolbar）
│   │   │   ├── ModelPicker.vue   # 模型选择下拉（分组：常用/按Provider）
│   │   │   ├── ContextBar.vue    # 上下文用量进度条（三级颜色 + 自动压缩触发）
│   │   │   └── SlashMenu.vue     # / 命令浮层菜单（注册表驱动）
│   │   ├── chat/tools/           # [v3 新增] 工具渲染器组件
│   │   │   ├── BashToolRenderer.vue    # Bash 工具：终端风格输出
│   │   │   ├── EditToolRenderer.vue    # Edit 工具：diff 视图
│   │   │   ├── ReadToolRenderer.vue    # Read 工具：文件预览
│   │   │   ├── WriteToolRenderer.vue   # Write 工具：文件预览
│   │   │   └── DefaultToolRenderer.vue # 默认：JSON 折叠视图
│   │   └── settings/
│   │       ├── ProviderList.vue  # Provider 列表（状态 + 编辑/删除）
│   │       ├── ProviderForm.vue  # 添加/编辑 Provider 表单
│   │       └── ToolPermissions.vue # [v3 新增] 工具权限配置列表
│   ├── composables/
│   │   ├── useChat.ts            # 消息收发、流式事件处理（stable list + streaming split）
│   │   ├── useSession.ts         # 会话 CRUD + 切换
│   │   ├── useProvider.ts        # Provider 配置管理
│   │   ├── useModel.ts           # 模型列表 + 切换
│   │   ├── useConnection.ts      # WebSocket 连接管理（断线重连）
│   │   ├── useRafBatcher.ts      # [v3 新增] rAF 批处理（16ms 合并 delta 刷新）
│   │   ├── useToolRenderer.ts    # [v3 新增] 工具渲染器注册表（Map<string, DefineComponent>）
│   │   └── useSlashCommands.ts   # [v3 新增] Slash 命令注册与处理
│   ├── stores/
│   │   ├── chat.ts               # 对话状态（completedMessages + streamingMessage 分离）
│   │   ├── session.ts            # 会话列表、当前会话 ID
│   │   └── settings.ts           # 全局设置（语言、主题、默认模型、currentView、工具权限）
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
│   │   ├── session-pool.ts       # Session 池：Map<sessionId, AgentSession>
│   │   ├── pi-bridge.ts          # pi SDK 集成（createAgentSession / prompt / abort / setModel）
│   │   ├── event-adapter.ts      # pi AgentSessionEvent → WS 协议事件 转换
│   │   ├── config-store.ts       # xyz-agent 自身设置（~/.xyz-agent/config.toml）
│   │   ├── provider-store.ts     # Provider API Key 管理（读写 + 传递给 pi 子进程）
│   │   └── project-context.ts    # [v3 新增] 项目级记忆读取（CLAUDE.md / xyz-agent.md）
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
- `MessageList.vue` — 稳定消息列表虚拟滚动
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

### 3.5 [v3 新增] 项目级记忆

**目标**：Agent 启动时自动获取项目上下文，无需用户手动指定文件。

**实现机制**：

1. Session 创建时（`session.create`），Sidecar 的 `project-context.ts` 读取项目根目录下的 `CLAUDE.md` 或 `xyz-agent.md` 文件
2. 查找顺序：`CLAUDE.md` → `xyz-agent.md` → `.claude/CLAUDE.md` → 跳过
3. 将内容通过 pi SDK 的 `session.prompt()` 的系统上下文注入（或作为首条 system 消息）
4. 注入格式：`[Project Context from CLAUDE.md]\n{content}`，截断到 10K 字符

**Sidecar `project-context.ts`**：

```typescript
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

const MAX_PROJECT_CONTEXT_CHARS = 10_000

const PROJECT_FILES = ['CLAUDE.md', 'xyz-agent.md', '.claude/CLAUDE.md']

export function loadProjectContext(cwd: string): string | null {
  for (const file of PROJECT_FILES) {
    const path = join(cwd, file)
    if (existsSync(path)) {
      const content = readFileSync(path, 'utf-8')
      if (content.length > MAX_PROJECT_CONTEXT_CHARS) {
        return content.slice(0, MAX_PROJECT_CONTEXT_CHARS) + '\n... (truncated)'
      }
      return content
    }
  }
  return null
}
```

**注入时机**：`pi-bridge.ts` 创建 session 后、用户首次发消息前，如果有项目上下文，通过 `session.prompt()` 注入一条系统上下文消息。

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
│            │  │  ── Streaming Area (rAF batched) ──     │    │
│  📁 proj-b │  │  🤖 assistant (streaming) + 🔧 tools   │    │
│    └─ ⚪ C │  │                                        │    │
│            │  ├────────────────────────────────────────┤    │
│  + 新建    │  │ Textarea                               │    │
│            │  │ [+] [sonnet@anthropic ▾] [上下文 34%] [发送] │
│            │  └────────────────────────────────────────┘    │
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
| 工具调用 | 独立卡片，工具渲染器注册表分发，按工具名查找专用渲染器 | `ToolCallCard.vue`（分发器）→ 专用渲染器 |
| 工具审批 | 内联卡片，Allow / Deny / Always Allow 按钮 | `ToolApprovalCard.vue` |
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

### 4.4.1 [v3 新增] 流式渲染架构

**核心原则**：稳定列表 + 流式容器分离。已完成的消息永不重渲染，流式消息在独立容器中高效更新。

**Chat State 分离**（`stores/chat.ts`）：

```typescript
interface ChatState {
  completedMessages: Message[]                          // 冻结列表，追加后不再更新
  streamingMessage: StreamingAssistantMessage | null    // 唯一活跃更新点
  isGenerating: boolean
  pendingToolCalls: ToolCall[]
}

interface StreamingAssistantMessage {
  id: string
  textContent: string
  thinkingContent: string
  toolCalls: ToolCall[]
  startedAt: number
}

function finalizeStreamingMessage(usage: Usage, stopReason: string) {
  const streaming = chatState.streamingMessage
  if (!streaming) return
  const finalMessage: Message = {
    id: streaming.id,
    role: 'assistant',
    content: streaming.textContent,
    thinking: streaming.thinkingContent ? [{ id: 'thinking', content: streaming.thinkingContent }] : undefined,
    toolCalls: streaming.toolCalls.length > 0 ? streaming.toolCalls : undefined,
    usage,
    timestamp: Date.now(),
  }
  chatState.completedMessages = [...chatState.completedMessages, finalMessage]
  chatState.streamingMessage = null
}
```

**组件拆分**：

- `MessageList.vue`：渲染 `completedMessages`（静态列表，虚拟滚动，新消息追加触发增量渲染）
- `StreamingMessage.vue`：渲染 `streamingMessage`（响应式，高频更新仅此一个组件）

```vue
<!-- ChatView.vue -->
<template>
  <div class="flex flex-col h-full">
    <!-- 稳定列表区域：不因流式更新重渲染 -->
    <MessageList :messages="chatStore.completedMessages" />

    <!-- 流式容器区域：仅生成中存在 -->
    <StreamingMessage
      v-if="chatStore.streamingMessage"
      :message="chatStore.streamingMessage"
    />

    <!-- 工具审批区域 -->
    <ToolApprovalCard
      v-for="pending in chatStore.pendingToolCalls"
      :key="pending.id"
      :tool-call="pending"
      @approve="handleApprove(pending.id)"
      @deny="handleDeny(pending.id)"
      @always-allow="handleAlwaysAllow(pending.toolName)"
    />

    <ChatInput />
  </div>
</template>
```

**rAF 批处理**（`useRafBatcher.ts`）：

收集每个动画帧内的所有流式 delta，在下一个 rAF 时一次性刷新，减少 60% 的 Vue 重渲染次数：

```typescript
// src/composables/useRafBatcher.ts
export function useRafBatcher() {
  let buffer = ''
  let rafId: number | null = null
  const flushed = ref('')

  function flush() {
    if (buffer.length > 0) {
      flushed.value += buffer
      buffer = ''
    }
    rafId = null
  }
  function append(delta: string) {
    buffer += delta
    if (rafId === null) {
      rafId = requestAnimationFrame(flush)
    }
  }
  function reset(value = '') {
    if (rafId !== null) cancelAnimationFrame(rafId)
    rafId = null
    buffer = ''
    flushed.value = value
  }
  onUnmounted(() => { if (rafId !== null) cancelAnimationFrame(rafId) })
  return { flushed, append, reset }
}
```

**数据流**：WS 事件 → eventBus → useChat handler → `rafBatcher.append(delta)` → rAF flush → `streamingMessage.textContent` 更新 → StreamingMessage.vue 重渲染

### 4.4.2 [v3 新增] 工具渲染器注册表

**核心设计**：`ToolCallCard.vue` 变为分发器，根据工具名查找注册表中的专用渲染器组件。未注册的工具使用 `DefaultToolRenderer.vue`。

**注册表**（`useToolRenderer.ts`）：

```typescript
// src/composables/useToolRenderer.ts
import type { DefineComponent } from 'vue'
import { inject, provide, ref } from 'vue'

export interface ToolRendererProps {
  toolName: string
  input: Record<string, unknown>
  output?: string
  status: 'running' | 'completed' | 'error'
  expanded: boolean
}

const TOOL_RENDERER_KEY = Symbol('tool-renderer-registry')

export function provideToolRenderer() {
  const registry = new Map<string, DefineComponent<ToolRendererProps>>()

  function registerToolRenderer(name: string, component: DefineComponent<ToolRendererProps>) {
    registry.set(name, component)
  }

  function getRenderer(name: string): DefineComponent<ToolRendererProps> | undefined {
    return registry.get(name)
  }

  provide(TOOL_RENDERER_KEY, { getRenderer })
  return { registerToolRenderer, getRenderer }
}

export function useToolRenderer() {
  const ctx = inject<{ getRenderer: (name: string) => DefineComponent<ToolRendererProps> | undefined }>(TOOL_RENDERER_KEY)
  if (!ctx) throw new Error('ToolRenderer not provided')
  return ctx
}
```

**ToolCallCard 分发器**：

```vue
<!-- src/components/chat/ToolCallCard.vue -->
<script setup lang="ts">
import { useToolRenderer } from '@/composables/useToolRenderer'
import DefaultToolRenderer from './tools/DefaultToolRenderer.vue'

const props = defineProps<{ toolCall: ToolCall }>()
const { getRenderer } = useToolRenderer()
const renderer = computed(() => getRenderer(props.toolCall.toolName))
</script>

<template>
  <div class="tool-call-card">
    <component
      :is="renderer ?? DefaultToolRenderer"
      :tool-name="toolCall.toolName"
      :input="toolCall.input"
      :output="toolCall.output"
      :status="toolCall.status"
      :expanded="isExpanded"
    />
  </div>
</template>
```

**内置渲染器**：

| 渲染器组件 | 工具名 | 特化展示 |
|-----------|--------|---------|
| `BashToolRenderer.vue` | `bash` | 终端风格：深色背景 + 等宽字体 + 命令高亮 + 输出折叠 |
| `EditToolRenderer.vue` | `edit` | Diff 视图：红色删除行 + 绿色新增行 + 文件路径标题 |
| `ReadToolRenderer.vue` | `read` | 文件预览：文件路径标题 + 行号 + 语法着色标题栏 |
| `WriteToolRenderer.vue` | `write` | 文件预览：目标路径 + 新建/覆盖标识 + 内容折叠 |
| `DefaultToolRenderer.vue` | 其他 | JSON 折叠视图：工具名 + 输入/输出 JSON 格式化 |

**注册时机**（`ChatView.vue` setup）：

```typescript
const { registerToolRenderer } = provideToolRenderer()
registerToolRenderer('bash', BashToolRenderer)
registerToolRenderer('edit', EditToolRenderer)
registerToolRenderer('read', ReadToolRenderer)
registerToolRenderer('write', WriteToolRenderer)
```

### 4.4.3 [v3 新增] 工具审批工作流

**三级权限模型**：每个工具可配置为 `allow`（自动批准）/ `ask`（需确认）/ `deny`（禁止）。

**默认权限配置**：

| 工具 | 默认权限 | 说明 |
|------|---------|------|
| `read` | `allow` | 只读操作，安全 |
| `grep` | `allow` | 只读搜索，安全 |
| `find` | `allow` | 只读搜索，安全 |
| `ls` | `allow` | 只读目录，安全 |
| `bash` | `ask` | 可执行任意命令，需确认 |
| `edit` | `ask` | 修改文件，需确认 |
| `write` | `ask` | 创建/覆盖文件，需确认 |
| 其他 | `deny` | 未知工具默认拒绝 |

**WS 协议新增消息**：

```typescript
// Sidecar → 前端：工具调用等待审批
interface ToolCallPendingEvent {
  type: 'message.tool_call_pending'
  payload: {
    sessionId: string
    toolCallId: string
    toolName: string
    input: Record<string, unknown>
    dangerLevel: 'safe' | 'caution' | 'danger'
    autoApproved: boolean   // 权限为 allow 时为 true
  }
}

// 前端 → Sidecar：批准工具调用
interface ToolApproveMessage {
  type: 'tool.approve'
  payload: { sessionId: string; toolCallId: string }
}

// 前端 → Sidecar：拒绝工具调用
interface ToolDenyMessage {
  type: 'tool.deny'
  payload: { sessionId: string; toolCallId: string; reason?: string }
}

// 前端 → Sidecar：会话内同类工具始终批准
interface ToolAlwaysAllowMessage {
  type: 'tool.always_allow'
  payload: { sessionId: string; toolName: string }
}
```

**内联审批卡片**（`ToolApprovalCard.vue`）：

```
┌─ 🔧 bash ──── ⚠ caution ────────────────────┐
│  rm -rf node_modules && npm install            │
│                                                │
│  [Deny]  [Always Allow for this session]  [Allow] │
│                                ⏱ 53s remaining  │
└────────────────────────────────────────────────┘
```

- **内联展示**：直接嵌入对话流，不使用模态对话框
- **倒计时**：60 秒自动拒绝（`timeout = 60s auto-deny`）
- **三个操作**：Deny（拒绝）、Always Allow（会话内该工具自动批准）、Allow（单次批准）
- **dangerLevel 颜色**：safe = success 绿色，caution = warning 黄色，danger = danger 红色

**审批流程**：

```
Agent 循环检测到工具调用
  → Sidecar 检查权限配置
    → allow: 自动批准，发送 message.tool_call_start + message.tool_call_pending(autoApproved: true)
    → ask: 发送 message.tool_call_pending(autoApproved: false)，等待前端响应
      → 前端展示 ToolApprovalCard
      → 用户点击 Allow → 发送 tool.approve → Sidecar 执行工具
      → 用户点击 Deny → 发送 tool.deny → Sidecar 跳过工具，返回拒绝结果
      → 用户点击 Always Allow → 发送 tool.always_allow → 更新会话权限 + 执行工具
      → 60s 超时 → 自动发送 tool.deny(reason: "timeout")
    → deny: 发送 message.tool_call_end(isError: true, output: "Tool denied by policy")
```

**配置持久化**：工具权限存储在 session 配置中，通过 Sidecar `config-store.ts` 持久化到 `~/.xyz-agent/config.toml`。

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
| `ContextBar` | token 用量进度条，三级颜色 + 自动压缩触发 |
| `[⬆]` 发送按钮 | Enter 发送，Shift+Enter 换行 |
| `[■]` 中断按钮 | 生成中才显示，替代发送按钮 |
| `SlashMenu` | 输入 `/` 触发浮层，注册表驱动命令列表 |

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

### 4.5.1 [v3 新增] Slash 命令系统

**命令注册表**（`useSlashCommands.ts`）：

```typescript
// src/composables/useSlashCommands.ts
export interface SlashCommand {
  name: string           // '/compact'
  description: string    // '压缩上下文'
  handler: (args: string) => void | Promise<void>
}

const commands = ref<SlashCommand[]>([])

export function useSlashCommands() {
  function registerCommand(cmd: SlashCommand) {
    // 防止重复注册
    if (commands.value.some(c => c.name === cmd.name)) return
    commands.value = [...commands.value, cmd]
  }

  function executeCommand(name: string, args: string) {
    const cmd = commands.value.find(c => c.name === name)
    if (cmd) cmd.handler(args)
  }

  function filterCommands(query: string): SlashCommand[] {
    return commands.value.filter(c => c.name.startsWith(query))
  }

  return { commands, registerCommand, executeCommand, filterCommands }
}
```

**内置命令**（P1）：

| 命令 | 功能 | 实现 |
|------|------|------|
| `/compact` | 触发上下文压缩 | `wsClient.send('session.compact', { sessionId })` |
| `/clear` | 清空当前上下文 | `chatStore.clearMessages()` + `wsClient.send('session.clear', { sessionId })` |
| `/help` | 列出所有可用命令 | 显示 SlashMenu（过滤 = 全部） |
| `/model <name>` | 切换模型 | `wsClient.send('model.switch', { sessionId, modelId: name })` |

**SlashMenu 更新**：

```vue
<!-- SlashMenu.vue — 从空框架变为注册表驱动 -->
<script setup lang="ts">
import { useSlashCommands } from '@/composables/useSlashCommands'

const props = defineProps<{ visible: boolean; query: string }>()
const { filterCommands } = useSlashCommands()

const filteredItems = computed(() =>
  filterCommands(props.query).map(cmd => ({
    label: cmd.name,
    description: cmd.description,
  }))
)
</script>
```

**扩展性**：后续 Phase 可注册新命令（如 `/agent`、`/skill`、`/memory`），无需修改 SlashMenu 组件。

### 4.5.2 [v3 更新] ContextBar — 上下文窗口管理

**增强的颜色状态和自动压缩**：

```typescript
// src/components/chat/ContextBar.vue
const usagePercent = computed(() => chatStore.contextUsagePercent)

const barVariant = computed(() => {
  const pct = usagePercent.value
  if (pct > 85) return 'danger'       // 红色，即将触发自动压缩
  if (pct > 70) return 'warning'      // 黄色，上下文紧张
  if (pct > 40) return 'warning'      // 黄色，开始注意
  return 'accent'                     // 正常
})

// 自动压缩触发
watch(usagePercent, (pct) => {
  if (pct > 85 && chatStore.isGenerating) {
    // 通过 useSlashCommands 的 /compact 命令触发
    wsClient.send('session.compact', { sessionId: currentSessionId.value })
    toast.info(t('chat.compacting'))
  }
})
```

**WS 协议新增**：

| 消息 | 方向 | 说明 |
|------|------|------|
| `context.update` | Sidecar → 前端 | `{ sessionId, usagePercent, inputTokens, contextLimit }` |
| `session.compact` | 前端 → Sidecar | `{ sessionId }` — 手动触发压缩 |
| `session.compacting` | Sidecar → 前端 | `{ sessionId, status: 'compacting' }` — 压缩进行中 |

**ContextBar UI**：

```
上下文 ██░░░░░░░░ 34%           ← accent 绿色，正常
上下文 █████░░░░░ 52%           ← warning 黄色，注意
上下文 ████████░░ 82%           ← warning 黄色，紧张
上下文 ██████████ 93%  ⚡ 压缩中  ← danger 红色，自动压缩已触发
```

**用户手动压缩**：通过输入 `/compact` 命令触发，或点击 ContextBar 条触发。

### 4.6 Settings View (`SettingsView.vue`)

点击 Header 齿轮按钮，全屏替代主界面（与 Chat 同级，不是弹窗）。由 `settingsStore.currentView` 状态驱动切换。

```
┌─────────────┬──────────────────────────────────┐
│ 设置         │  供应商                           │
│              │                                  │
│ > 供应商     │  已配置的供应商                    │
│   工具权限   │  ┌─────────────────────────────┐│
│   SKILL      │  │ Anthropic      ✅ 已连接     ││
│   AGENT      │  │ claude-sonnet, opus, haiku   ││
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
- ✅ 工具权限 Tab：[v3 新增] 工具权限配置列表（见 §4.6.1）
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

### 4.6.1 [v3 新增] 工具权限配置

**SettingsView 新增 "工具权限" Tab**（`ToolPermissions.vue`）：

```
┌──────────────────────────────────────────────┐
│  工具权限                                      │
│                                                │
│  工具名称      权限                             │
│  ──────────── ────────────────                │
│  read          [✅ Allow     ▾]                │
│  grep          [✅ Allow     ▾]                │
│  find          [✅ Allow     ▾]                │
│  ls            [✅ Allow     ▾]                │
│  bash          [⚠ Ask       ▾]                │
│  edit          [⚠ Ask       ▾]                │
│  write         [⚠ Ask       ▾]                │
│                                                │
│  重置为默认                                     │
└──────────────────────────────────────────────┘
```

**权限类型**：

```typescript
type ToolPermission = 'allow' | 'ask' | 'deny'

interface ToolPermissionsConfig {
  [toolName: string]: ToolPermission
}
```

**数据流**：

1. 加载时从 `settingsStore` 读取工具权限配置
2. 用户通过 Select 下拉切换权限
3. 修改后通过 WS 发送 `config.setToolPermissions` 到 Sidecar 持久化
4. Sidecar 保存到 `~/.xyz-agent/config.toml` 并更新运行时权限配置

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
| `session.compact` | `{ sessionId }` | [v3 新增] 手动触发上下文压缩 |
| `session.clear` | `{ sessionId }` | [v3 新增] 清空会话上下文 |
| `message.send` | `{ sessionId, content }` | 发送用户消息 |
| `message.abort` | `{ sessionId }` | 中断当前生成 |
| `tool.approve` | `{ sessionId, toolCallId }` | [v3 新增] 批准工具调用 |
| `tool.deny` | `{ sessionId, toolCallId, reason? }` | [v3 新增] 拒绝工具调用 |
| `tool.always_allow` | `{ sessionId, toolName }` | [v3 新增] 会话内始终批准该工具 |
| `config.getProviders` | `{}` | 获取 Provider 配置 |
| `config.setProvider` | `{ providerId, apiKey?, baseUrl?, ... }` | 设置 Provider |
| `config.deleteProvider` | `{ providerId }` | 删除 Provider |
| `config.setToolPermissions` | `{ permissions: Record<string, ToolPermission> }` | [v3 新增] 设置工具权限 |
| `model.list` | `{}` | 获取可用模型列表 |
| `model.switch` | `{ sessionId, modelId }` | 切换当前会话模型 |
| `ping` | `{}` | 心跳 |

### 5.3 Sidecar → 客户端

下表包含 WS 协议事件名称以及对应的 pi SDK 事件源。Sidecar 的 `event-adapter.ts` 负责将 pi SDK 的 `AgentSessionEvent` 转换为 WS 协议事件——**WS 协议的事件名称和格式保持不变，翻译工作在 sidecar 内部完成**。

| type | payload | pi SDK 事件源 | 说明 |
|------|---------|-------------|------|
| `session.created` | `{ sessionId, label, cwd }` | — | 会话创建成功 |
| `session.deleted` | `{ sessionId }` | — | 会话已删除 |
| `session.list` | `{ groups: Array<{ cwd, sessions: SessionSummary[] }> }` | — | 会话列表（按 cwd 分组） |
| `session.history` | `{ sessionId, messages: Message[] }` | `sessionManager.getEntries()` | 历史消息 |
| `session.compacting` | `{ sessionId, status }` | `compaction_start` | [v3 新增] 压缩进行中 |
| `message.text_delta` | `{ sessionId, delta }` | `message_update`（text_delta） | 流式文本片段 |
| `message.thinking_delta` | `{ sessionId, delta }` | `message_update`（thinking_delta） | thinking 片段 |
| `message.thinking_start` | `{ sessionId }` | `message_update`（thinking_start） | thinking 开始 |
| `message.thinking_end` | `{ sessionId, content }` | `message_update`（thinking_end） | thinking 结束 |
| `message.tool_call_start` | `{ sessionId, toolCallId, toolName, input }` | `tool_execution_start` | 工具调用开始 |
| `message.tool_call_end` | `{ sessionId, toolCallId, toolName, output, isError }` | `tool_execution_end` | 工具调用结束 |
| `message.tool_call_pending` | `{ sessionId, toolCallId, toolName, input, dangerLevel, autoApproved }` | — | [v3 新增] 工具等待审批 |
| `message.complete` | `{ sessionId, stopReason, usage }` | `message_end`（assistant） | 消息生成完毕 |
| `message.error` | `{ sessionId, error }` | pi 异常 / 进程退出 | 生成出错 |
| `message.status` | `{ sessionId, status, message? }` | `auto_retry_start` / `compaction_start` | 状态通知 |
| `config.providers` | `{ providers: ProviderInfo[] }` | — | Provider 列表 |
| `config.providerUpdated` | `{ providerId }` | — | Provider 已更新 |
| `context.update` | `{ sessionId, usagePercent, inputTokens, contextLimit }` | — | [v3 新增] 上下文用量更新 |
| `model.list` | `{ models: ModelInfo[] }` | `modelRegistry.getAvailable()` | 模型列表 |
| `model.switched` | `{ sessionId, modelId }` | — | 模型已切换 |
| `pong` | `{}` | — | 心跳响应 |
| `error` | `{ message, code? }` | — | 通用错误 |

**事件适配说明**：

1. Sidecar 为每个 session 维护一个 pi AgentSession（通过 `createAgentSession()`）
2. pi SDK 通过 `session.subscribe()` 推送 `AgentSessionEvent`
3. `event-adapter.ts` 将 pi 事件名映射为 WS 协议事件名（如 `message_update` + `text_delta` → `message.text_delta`）
4. P1 处理核心事件（text_delta / thinking_delta / tool_call_start / tool_call_end / message_end），新增工具审批事件
5. pi SDK 的其他事件（`compaction_start/end`、`auto_retry_start/end`、`session_info_changed`）映射为 `message.status`

**StopReason 映射**（在 `event-adapter.ts` 中完成）：

| pi SDK StopReason | WS 协议 `stopReason` |
|-------------------|---------------------|
| `"stop"` | `"stop"` |
| `"length"` | `"length"` |
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

### 6.1 集成方式：pi SDK Direct

**Sidecar 直接调用 pi SDK 的 `createAgentSession()` API**，通过 `session.subscribe()` 监听事件。

**选择理由**（基于 arch-backend.md 调研）：

| 维度 | Direct SDK (v3 选择) | Subprocess RPC (v2 方案) |
|------|---------------------|-------------------------|
| 进程模型 | Sidecar 内直接创建 AgentSession | Sidecar spawn pi 子进程 |
| 事件传递 | `session.subscribe()` → 直接回调 | stdin/stdout JSONL 解析 |
| 错误处理 | try/catch 直接捕获 | 需要进程崩溃检测 + 重启 |
| 代码复杂度 | 低（一个 pi-bridge.ts 桥接） | 高（rpc-client.ts + event-adapter.ts + process-manager.ts） |
| 性能开销 | 零 IPC | ~700ms 进程启动 + JSON 序列化 |
| 扩展性 | P5 可通过多 AgentSession 实现子 Agent | 每个 SubAgent 独立进程 |

**架构决策**：v3 采用 Direct SDK 集成，减少 IPC 层和进程管理复杂度，同时与 pi SDK 的最新 API 对齐。

### 6.2 模块职责

| 模块 | 职责 |
|------|------|
| `index.ts` | 入口：解析端口参数，启动 WS 服务器 + HTTP health endpoint |
| `server.ts` | WS 连接管理（单客户端）、消息路由、心跳 |
| `session-pool.ts` | `Map<sessionId, AgentSession>`，管理所有活跃的 pi AgentSession |
| `pi-bridge.ts` | pi SDK 集成：`createAgentSession()` / `session.prompt()` / `session.abort()` / `session.setModel()` |
| `event-adapter.ts` | pi `AgentSessionEvent` → WS 协议事件翻译（事件名映射 + StopReason 转换） |
| `config-store.ts` | xyz-agent 自身设置读写（`~/.xyz-agent/config.toml`，TOML 格式，使用 `smol-toml`） |
| `provider-store.ts` | Provider API Key 管理（存储、通过 `AuthStorage` 同步到 pi SDK） |
| `project-context.ts` | [v3 新增] 项目级记忆读取（CLAUDE.md / xyz-agent.md），注入到 session 系统上下文 |

**核心流程**：

```
前端 WS 消息 → server.ts 路由 → session-pool.ts 查找 AgentSession
  → pi-bridge.ts 调用 session.prompt() / session.abort() / session.setModel()
  → pi SDK 通过 session.subscribe() 推送 AgentSessionEvent
  → event-adapter.ts 翻译为 WS 协议事件
  → server.ts 通过 WS → 前端
```

### 6.3 pi SDK 集成

**初始化序列**：

1. Tauri `sidecar.rs` spawn Node.js sidecar，传递 WS 端口（`--port 3210`）
2. Sidecar `index.ts` 解析端口，调用 `server.start(port)`
3. `server.ts.start()`:
   - `config-store.ts` 加载 `~/.xyz-agent/config.toml`
   - `pi-bridge.ts` 初始化共享单例：`AuthStorage` + `ModelRegistry`
   - 启动 WS 服务器
4. 前端连接 WS
5. 前端发送 `session.list` → `SessionManager.listAll()` → 返回分组列表
6. 前端发送 `session.create { cwd }` → `pi-bridge.ts.createSession()` → `createAgentSession({ cwd, authStorage, modelRegistry })` → `session.subscribe(adapter)` → WS 推送事件

**`createAgentSession` 调用**：

```typescript
const { session } = await createAgentSession({
  cwd: "/path/to/project",
  authStorage,       // 共享 AuthStorage 实例
  modelRegistry,     // 共享 ModelRegistry 实例
  thinkingLevel: "high",
});
```

**Session 生命周期映射**：

| WS 消息 | pi SDK 调用 |
|---------|------------|
| `session.create` | `createAgentSession({ cwd, authStorage, modelRegistry })` |
| `session.delete` | `session.dispose()` + 删除 JSONL 文件 |
| `session.list` | `SessionManager.listAll()` |
| `session.history` | `sessionManager.getEntries()` → 转换为 `Message[]` |
| `message.send` | `session.prompt(content)` |
| `message.abort` | `session.abort()` |
| `model.switch` | `session.setModel(modelRegistry.find(provider, modelId))` |
| `model.list` | `modelRegistry.getAvailable()` |

### 6.4 Sidecar 生命周期

1. Tauri 启动时 `sidecar.rs` spawn Node.js sidecar 进程，通过 CLI 参数传递 WS 端口（`--port 3210`）
2. Sidecar 启动 WS 服务器 + HTTP `/health` endpoint
3. Sidecar 通过 Tauri event 将端口号通知前端（`app.emit("sidecar-port", port)`）
4. 前端监听 `sidecar-port` 事件，使用收到的端口创建 WS 连接
5. 前端 WS 连接后，Sidecar 扫描已有 Session 目录，发送 `session.list`
6. 用户发消息时，Sidecar 为该 session 创建 AgentSession（如尚未创建）
7. AgentSession 通过 `session.subscribe()` 推送事件，经 event-adapter 翻译后推送到前端
8. Tauri 关闭时发送 SIGTERM，Sidecar 优雅关闭（dispose 所有 AgentSession、断开 WS）

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

**pi AgentSession 错误**：

- Sidecar 的 `pi-bridge.ts` 通过 try/catch 捕获 `session.prompt()` 异常
- 错误时通过 WS 发送 `message.error` 通知前端
- 前端显示 Toast 错误提示，用户可重新发起对话

### 6.8 错误处理策略

| 场景 | Sidecar 行为 | 前端表现 |
|------|-------------|---------|
| pi SDK 调用失败 | 发送 `message.error` | Toast 错误提示（`toast.error()`） |
| pi SDK 自动重试 | 发送 `message.status { status: "retrying" }` | Toast "正在重试 (2/3)…" |
| 上下文溢出 | 发送 `message.error { code: "CONTEXT_OVERFLOW" }` | Toast + 建议压缩 |
| WS 断开 | — | Statusbar 显示断开状态，`useConnection` 自动重连 |
| Sidecar 进程崩溃 | Rust 检测到退出 | 自动重启 Sidecar + 前端自动重连 |
| Provider API Key 无效 | pi SDK 返回 401 → `message.error` | Toast + 引导去设置页配置 |
| WS 断连期间发出的消息 | `ws-client.ts` 消息发送队列（离线缓冲） | 连接恢复后自动重发 |
| 工具审批超时 | Sidecar 60s 超时自动拒绝 | ToolApprovalCard 显示 "已自动拒绝" |

**AppError 类型**（`shared/types.ts`）：

```typescript
interface AppError {
  message: string
  code?: 'CONNECTION_LOST' | 'PROVIDER_ERROR' | 'SESSION_NOT_FOUND' | 'PROCESS_CRASHED' | 'TIMEOUT' | 'CONTEXT_OVERFLOW' | 'AUTH_ERROR' | 'RATE_LIMIT'
  retryable?: boolean
}
```

### 6.9 配置管理

**配置文件**：`~/.xyz-agent/config.toml`（TOML 格式，使用 `smol-toml` 解析）

```toml
# ~/.xyz-agent/config.toml

[defaults]
model = "anthropic/claude-sonnet-4-20250514"
thinking_mode = "high"
temperature = 0.7

# Provider API keys
[providers.anthropic]
api_key = "sk-ant-..."

[providers.openai]
api_key = "sk-..."

# [v3 新增] 工具权限配置
[tool_permissions]
read = "allow"
grep = "allow"
find = "allow"
ls = "allow"
bash = "ask"
edit = "ask"
write = "ask"
```

**配置优先级链**：

1. `~/.xyz-agent/config.toml` — xyz-agent 主配置
2. `~/.pi/agent/auth.json` — pi CLI 凭证（兼容已有 pi 用户）
3. 环境变量 — `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` 等
4. 硬编码默认值 — `model: "anthropic/claude-sonnet-4-20250514"`, `thinking_mode: "high"`

**同步到 pi auth.json**：当 `config.setProvider` 时，Sidecar 同时写入 `~/.xyz-agent/config.toml` 和 pi 的 `~/.pi/agent/auth.json`，确保 pi CLI 也能使用相同凭证。

### 6.10 生产模式打包

- **开发模式**：`node sidecar/dist/index.js --port <port>`
- **生产模式**：使用 `pkg` 或 Node.js SEA (Single Executable Application) 编译为单二进制
- 编译后的二进制放入 `src-tauri/binaries/` 目录，通过 Tauri sidecar API 管理
- P1 先以开发模式交付，生产打包在 P1 后期或 P2 解决

---

## 七、前端状态管理（Pinia）

### 7.1 Store 划分

| Store | 状态 | 关键 actions |
|-------|------|-------------|
| `useChatStore` | 已完成消息列表（`completedMessages`）、流式消息（`streamingMessage`）、生成中标志、待审批工具调用 | `addMessage()`, `appendDelta()`, `clearStream()`, `finalizeStreamingMessage()`, `addPendingApproval()`, `removePendingApproval()` |
| `useSessionStore` | 所有 Session 列表（按 cwd 分组）、当前活跃 Session ID | `loadSessions()`, `createSession()`, `deleteSession()`, `switchSession()` |
| `useSettingsStore` | 语言、主题、默认模型、`currentView`、`focusMode`、工具权限配置（持久化到 localStorage） | `setTheme()`, `setLocale()`, `setDefaultModel()`, `setCurrentView()`, `setToolPermission()` |

### 7.1.1 [v3 核心] ChatState 分离设计

```typescript
// stores/chat.ts
interface ChatState {
  // 稳定列表：追加后不再更新，虚拟滚动优化
  completedMessages: Message[]

  // 流式消息：生成中唯一的更新点
  streamingMessage: StreamingAssistantMessage | null

  // 状态标志
  isGenerating: boolean
  isLoading: boolean

  // 工具审批队列
  pendingApprovals: PendingApproval[]

  // 用量追踪
  usage: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
  }
  contextLimit: number              // [v3 新增] 上下文窗口大小
  error: string | null
}

interface StreamingAssistantMessage {
  id: string
  textContent: string
  thinkingContent: string
  toolCalls: ToolCall[]
  startedAt: number
}

interface PendingApproval {
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
  dangerLevel: 'safe' | 'caution' | 'danger'
  createdAt: number              // 用于 60s 超时计算
}

// Actions
function addMessage(msg: Message): void                    // 追加到 completedMessages
function replaceMessages(msgs: Message[]): void            // 替换全部（session 切换）
function appendDelta(delta: string): void                  // 追加到 streamingMessage.textContent
function appendThinkingDelta(delta: string): void          // 追加到 streamingMessage.thinkingContent
function addStreamingToolCall(tc: ToolCall): void           // 追加到 streamingMessage.toolCalls
function updateStreamingToolCall(id: string, output: string): void
function finalizeStreamingMessage(usage: Usage, stopReason: string): void  // streaming → completed
function clearStream(): void                               // 重置 streamingMessage
function addPendingApproval(pending: PendingApproval): void
function removePendingApproval(toolCallId: string): void
function startGenerating(): void
function stopGenerating(): void
function startLoading(): void
function stopLoading(): void
function updateUsage(usage: Usage): void
function updateContextInfo(usagePercent: number, inputTokens: number, contextLimit: number): void
function setError(error: string | null): void
function clearMessages(): void

// Getters
const messageCount: ComputedRef<number>                    // completedMessages.length
const lastMessage: ComputedRef<Message | undefined>        // completedMessages.at(-1)
const hasError: ComputedRef<boolean>                       // error !== null
const contextUsagePercent: ComputedRef<number>             // usage.totalTokens / contextLimit * 100
const allMessages: ComputedRef<Message[]>                  // completedMessages + [streamingMessage?] 用于虚拟滚动
```

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
  const toolPermissions = ref<Record<string, ToolPermission>>({
    read: 'allow', grep: 'allow', find: 'allow', ls: 'allow',
    bash: 'ask', edit: 'ask', write: 'ask',
  })

  // ... actions

  return { theme, locale, defaultModel, currentView, focusMode, toolPermissions, /* actions */ }
}, {
  persist: {
    pick: ['theme', 'locale', 'defaultModel', 'toolPermissions'],
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

示例：流式文本（rAF 批处理）
  WS: { type: "message.text_delta", payload: { sessionId, delta: "你好" } }
  → ws-client.ts 接收
  → event-bus.ts 分发
  → useChat composable 处理
  → rafBatcher.append("你好")              ← 合并到 buffer
  → requestAnimationFrame(flush)           ← 下一个动画帧刷新
  → chatStore.streamingMessage.textContent += "你好"
  → StreamingMessage.vue 更新（仅此一个组件重渲染）
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
| `ToolPermission` | `'allow' \| 'ask' \| 'deny'` | 工具权限三级模型 |

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
| Agent 引擎 | @mariozechner/pi-coding-agent（Direct SDK） | latest |
| 后端通信 | WebSocket (ws) + HTTP (health check) | latest |
| 配置解析 | smol-toml | latest |
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
| 多 Provider 支持（OpenAI 兼容复用） | P2 |
| Anthropic Prompt Caching | P2 |
| Post-Compact 恢复注入 | P2 |
| Microcompact 层 | P2 |
| 会话级审批缓存 + 级联取消 | P2 |
| Hook 系统（PreToolUse / PostToolUse） | P2-P3 |
| 流式工具执行（`execute_batch_streaming`） | P2 |
| Repo Map 代码图谱（tree-sitter + PageRank） | P3 |
| LSP 集成（编辑后诊断） | P3 |
| SessionMemory（会话级笔记） | P3 |
| 项目级记忆（MEMORY.md + 自动提取） | P3-P4 |
| JSONL + SQLite 双层持久化 | P3 |

---

## 十、关键风险

| 风险 | 缓解措施 |
|------|---------|
| pi SDK API 变化 | Sidecar 的 `pi-bridge.ts` + `event-adapter.ts` 封装了所有 pi 交互，API 变化只需修改这两个文件 |
| WS 连接不稳定 | 前端自动重连 + 消息发送队列缓冲 + Statusbar 状态提示 |
| Design System 组件不够用 | P1 只做需要的 12 个，后续按需扩展 |
| 虚拟滚动性能 | 使用 `@tanstack/vue-virtual` + `measureElement` 动态测量 |
| Markdown XSS | markdown-it 渲染必须通过 DOMPurify 消毒，防止工具输出中的恶意 HTML |
| Tailwind v3 色彩别名 | `tailwind.config.ts` 中 `theme.extend.colors` 映射 CSS 变量到 shadcn-vue 期望的色名 |
| 多 Session 内存占用 | 每个 pi AgentSession ~30-50MB，限制最大并发 Session 数 |
| 生产打包 Sidecar | 开发模式用 `node sidecar/dist/index.js`，生产用 pkg/SEA 编译为单二进制 |
| Cmd+, 快捷键冲突 | macOS 系统保留 Cmd+,，如遇冲突改为 Cmd+Shift+, |
| 共享类型同步 | `shared/` 目录 + TypeScript path alias，前后端和 sidecar 从同一源导入 |
| rAF 批处理延迟 | 16ms 最大延迟对人眼不可感知，但需要确保 flush 不会累积大量文本导致卡顿 |
| 工具审批超时竞态 | 60s 超时与用户操作可能竞态，使用工具调用 ID 作为唯一标识，超时响应后忽略后续用户操作 |
| 流式渲染分离的边界条件 | streamingMessage finalize 时需要正确合并 toolCalls 和 thinking，使用不可变追加模式 |

---

## 附录 A：v2 → v3 变更摘要

| 变更项 | v2 | v3 | 来源 |
|--------|----|----|------|
| 流式渲染 | 单一 `messages` 数组 + streamingText | `completedMessages` + `streamingMessage` 分离 | arch-optimization §2.2 (Claude Code) |
| rAF 批处理 | 无 | `useRafBatcher.ts` — 16ms 合并 delta | arch-optimization §2.2 |
| 工具渲染 | 单体 `ToolCallCard` | 注册表 + 分发器 + 5 个专用渲染器 | arch-optimization §2.4 (Aider) |
| 工具审批 | 无 | 三级权限 + 内联审批卡片 + 60s 超时 | arch-optimization §2.6 (OpenCode) |
| Slash 命令 | `SlashMenu` 空框架 | 注册表驱动 + 4 个内置命令 | arch-optimization §2.10 (Codex CLI) |
| ContextBar | 简单进度条 | 三级颜色 + 自动压缩 + 手动 /compact | arch-optimization §2.8 (Claude Code) |
| 工具权限 | 无 | Settings → 工具权限 Tab + 持久化 | arch-optimization §2.6 |
| 项目记忆 | 无 | 自动读取 CLAUDE.md / xyz-agent.md | arch-optimization §2.9 (Claude Code) |
| Sidecar 集成 | Subprocess RPC (stdin/stdout JSONL) | Direct SDK (`createAgentSession()`) | arch-backend.md |
| WS 协议 | 基础消息类型 | 新增 tool.approve/deny/always_allow + context.update + session.compact | arch-optimization §2.6, §2.8 |

## 附录 B：优先级矩阵（P1 范围内实施顺序）

| 周 | 任务 | 依赖 | 影响范围 |
|----|------|------|---------|
| W1 | Stable List + Streaming Split | 无 | chat store, MessageList, StreamingMessage |
| W1 | rAF Batching | Stable List | useRafBatcher, useChat |
| W2 | Tool Renderer Registry | 无 | useToolRenderer, ToolCallCard, 5 个渲染器 |
| W2 | Slash Command Registry | 无 | useSlashCommands, SlashMenu |
| W3 | ContextBar 增强 + 自动压缩 | Slash Commands | ContextBar, useChat |
| W3 | 项目级记忆 | 无 | project-context.ts, pi-bridge.ts |
| W3 | 工具权限配置基础 | 无 | settings store, ToolPermissions.vue |
| W4 | Tool Approval Workflow | Tool Renderer + 权限配置 | ToolApprovalCard, WS 协议, event-adapter |

## 附录 C：i18n 新增键（v3）

```typescript
// 在 MessageSchema 中新增的键：
chat: {
  // ... existing keys ...
  compacting: string               // "压缩上下文中…"
  compactDone: string              // "上下文压缩完成"
  compactManual: string            // "手动压缩"
  contextAutoCompact: string       // "上下文超过 85%，自动压缩中…"
  toolPending: string              // "等待审批"
  toolDenied: string               // "已拒绝"
  toolAutoDenied: string           // "审批超时，已自动拒绝"
  toolAlwaysAllow: string          // "会话内始终允许"
  allow: string                    // "允许"
  deny: string                     // "拒绝"
  dangerLevelSafe: string          // "安全"
  dangerLevelCaution: string       // "注意"
  dangerLevelDanger: string        // "危险"
}

settings: {
  // ... existing keys ...
  toolPermissions: string           // "工具权限"
  toolPermissionAllow: string       // "允许"
  toolPermissionAsk: string         // "询问"
  toolPermissionDeny: string        // "拒绝"
  resetToDefaults: string           // "重置为默认"
}

slashCommands: {
  compact: string                   // "压缩上下文"
  clear: string                     // "清空对话"
  help: string                      // "显示帮助"
  model: string                     // "切换模型"
}
```
