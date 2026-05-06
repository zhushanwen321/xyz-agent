# Phase 1: Hello pi — 设计规格

**日期**: 2026-05-06 | **阶段**: P1 (共 6 阶段) | **代号**: Hello pi

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

---

## 二、项目结构

```
xyz-agent/
├── src-tauri/                    # Tauri Rust 壳
│   ├── src/
│   │   ├── main.rs               # Tauri 入口
│   │   ├── sidecar.rs            # Sidecar 进程生命周期（spawn/kill/health check）
│   │   ├── commands/
│   │   │   ├── mod.rs
│   │   │   ├── dialog.rs         # 原生文件选择器、确认对话框
│   │   │   └── fs.rs             # 文件系统操作（读目录等）
│   │   └── lib.rs
│   ├── Cargo.toml
│   └── tauri.conf.json
│
├── src/                          # Vue 3 前端
│   ├── App.vue                   # 根组件：路由 Header/SettingsView/MainView
│   ├── main.ts
│   ├── design-system/            # 组件库（独立目录，未来可抽包）
│   │   ├── tokens/
│   │   │   ├── colors.ts         # oklch 色彩 token 定义
│   │   │   ├── spacing.ts        # 间距 token
│   │   │   ├── typography.ts     # 字体 token
│   │   │   └── index.ts          # 汇总导出 + CSS custom properties 注入
│   │   ├── theme/
│   │   │   ├── ThemeProvider.vue  # 主题提供者（light/dark + 系统跟随）
│   │   │   └── useTheme.ts       # 主题 composable
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
│   │   │   ├── MessageList.vue   # 虚拟滚动消息列表
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
│   │   └── settings.ts           # 全局设置（语言、主题、默认模型）
│   ├── lib/
│   │   ├── ws-client.ts          # WebSocket 客户端（连接/发送/事件分发）
│   │   ├── event-bus.ts          # 前端事件总线
│   │   └── protocol.ts           # WS 消息类型定义（前后端共享）
│   └── types/
│       ├── message.ts            # Message / ToolCall / Thinking 类型
│       ├── session.ts            # Session / SessionGroup 类型
│       ├── provider.ts           # Provider / Model 类型
│       └── protocol.ts           # WS 协议类型（与 lib/protocol.ts 对应）
│
├── sidecar/                      # Node.js Sidecar
│   ├── src/
│   │   ├── index.ts              # 入口：启动 WS 服务器
│   │   ├── server.ts             # WS 连接管理 + 消息路由
│   │   ├── session-pool.ts       # Session 池：Map<id, AgentSession>
│   │   ├── pi-bridge.ts          # pi SDK 封装（createAgentSession / send / abort）
│   │   ├── event-adapter.ts      # pi 事件 → WS 协议格式 转换
│   │   ├── config-store.ts       # Provider 配置读写（~/.xyz-agent/config.toml）
│   │   └── protocol.ts           # 消息类型定义
│   ├── package.json
│   └── tsconfig.json
│
├── .husky/
│   └── pre-commit                # lint + type-check + 自定义检查
├── eslint.config.mjs
├── package.json
├── tsconfig.json
├── tailwind.config.ts
├── vite.config.ts
└── index.html
```

---

## 三、地基层

### 3.1 Design System

**基础选型**：Radix Vue（headless UI）+ Tailwind CSS v4

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

**P1 组件清单**（12 个）：

| 组件 | 用途 | 核心 Props |
|------|------|-----------|
| `Button` | 通用按钮 | `variant: primary/ghost/danger`, `size: sm/md/lg` |
| `Input` | 单行输入 | `placeholder`, `disabled`, `error` |
| `Textarea` | 多行输入（自适应高度） | `autoResize`, `maxHeight` |
| `Select` | 下拉选择 | `options`, `multiple`, `searchable` |
| `ScrollArea` | 滚动容器（自定义滚动条） | `autoHide: boolean` |
| `Tooltip` | 悬浮提示 | `content`, `position: top/bottom/left/right` |
| `Dropdown` | 下拉菜单 | `trigger: click/hover`, `items` |
| `Dialog` | 模态对话框 | `open`, `title`, `onClose` |
| `Tabs` | 标签切换 | `items`, `activeKey`, `onChange` |
| `Badge` | 状态标记 | `variant: success/warning/danger/idle`, `dot: boolean` |
| `Toggle` | 开关 | `checked`, `onChange` |
| `ProgressBar` | 进度条 | `value: 0-100`, `variant: accent/warning/danger` |

所有组件：
- 通过 design token 消费颜色，零硬编码
- 支持暗色主题（通过 ThemeProvider 自动切换）
- 完整的 TypeScript props 类型
- 无障碍支持（aria-* 属性、键盘导航）
- 用户可见文案走 i18n

### 3.2 i18n

- `vue-i18n` v10 + Composition API 模式
- 类型安全：通过 Schema 类型导出实现 key 自动补全和缺失翻译编译时报错
- 初始支持 `zh-CN` 和 `en-US`
- 所有用户可见文案走 i18n，包括 design-system 组件内置文案
- 运行时切换语言，持久化到 localStorage

### 3.3 主题系统

- 内置 `light` / `dark` 两套主题
- `ThemeProvider.vue` 作为根级组件，注入主题上下文
- `useTheme()` composable：`theme`（当前主题）、`toggleTheme()`、`setTheme('dark')`
- 主题跟随系统偏好（`prefers-color-scheme`）或手动切换
- 持久化到 localStorage
- Token 通过 CSS custom properties 定义在 `:root` 和 `[data-theme="dark"]` 选择器上

### 3.4 Git Hooks + 代码规范

**Pre-commit 检查链**（husky + lint-staged）：

```
.eslint → vue-tsc --noEmit → 自定义检查脚本
```

**自定义 ESLint 规则**：

| 规则 | 级别 | 说明 |
|------|------|------|
| `no-hardcoded-colors` | error | 禁止 CSS/JS 中硬编码颜色值（hex/rgb/hsl），必须用 design token |
| `no-native-form-elements` | error | 禁止使用原生 `<button>/<input>/<select>/<textarea>`，必须用 design-system 组件 |
| `no-magic-spacing` | warn | 禁止 Tailwind 任意值如 `p-[17px]`、`gap-[3px]` |
| `no-hardcoded-strings` | warn | 提醒未走 i18n 的用户可见文案（允许 `/** */` 注释、`console.log`、`aria-*` 属性豁免） |

**其他规范**：
- `vue-tsc --noEmit` 类型检查必须通过
- `SKIP_LINT=1` 环境变量可跳过（紧急情况）
- Conventional Commits 提交格式

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
| 设置按钮 | ✅ `Cmd+,` 打开设置视图 | — |
| 主题切换 | ✅ 明/暗切换 | — |

### 4.3 Sidebar (`AppSidebar.vue`)

```
┌──────────────┐
│ 🔍 搜索会话   │  ← SessionSearch.vue
├──────────────┤
│ 📁 xyz-agent │  ← SessionGroup.vue（按 cwd 自动分组）
│   ├─ 🟢 A   │  ← SessionItem.vue（状态点 + 标题 + 相对时间）
│   ├─ ⚪ B   │     右键菜单：重命名 / 删除
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
- 虚拟滚动（大量 Session 流畅浏览）
- 可折叠（拖拽调整宽度或点击按钮收起）
- Session 状态：🟢 活跃 / ⚪ 闲置

### 4.4 Chat View (`ChatView.vue`)

**消息类型**：

| 类型 | 渲染方式 | 组件 |
|------|---------|------|
| 用户消息 | 右对齐气泡，基础 Markdown | `MessageBubble.vue` |
| 助手文本 | 左对齐气泡，基础 Markdown + 流式逐字显示 | `StreamingText.vue` |
| 工具调用 | 独立卡片，显示工具名 + 输入摘要 + 状态，可折叠 | `ToolCallCard.vue` |
| 思考过程 | 默认折叠块 "思考中…"，点击展开 | `ThinkingBlock.vue` |

**P1 Markdown 渲染策略**：
- 支持：**加粗**、*斜体*、`行内代码`、[链接](url)、有序/无序列表、引用块
- 暂不支持：代码块语法高亮（P3）、LaTeX 公式（P3）、图片（P3）
- 代码块使用 `<pre>` + 等宽字体，黑白底色

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

分组逻辑：常用（最近使用的 4 个）+ 按 Provider 分组。模型列表从 Sidecar 获取。

### 4.6 Settings View (`SettingsView.vue`)

点击 Header 齿轮按钮或 `Cmd+,`，全屏替代主界面（与 Chat 同级，不是弹窗）。

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
- ✅ 语言和主题设置（放在供应商 Tab 底部，或后续迁移到独立 Tab）

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

---

## 五、WebSocket 协议

### 5.1 消息格式

所有消息统一为 `{ type: string, id?: string, payload: any }`。

`id` 字段用于请求-响应配对（客户端发送带 id 的请求，服务端响应时回传相同 id）。

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

| type | payload | 说明 |
|------|---------|------|
| `session.created` | `{ sessionId, label, cwd }` | 会话创建成功 |
| `session.deleted` | `{ sessionId }` | 会话已删除 |
| `session.list` | `{ sessions: SessionSummary[] }` | 会话列表 |
| `session.history` | `{ sessionId, messages: Message[] }` | 历史消息 |
| `message.text_delta` | `{ sessionId, delta }` | 流式文本片段 |
| `message.thinking_delta` | `{ sessionId, delta }` | thinking 片段 |
| `message.tool_call_start` | `{ sessionId, toolCallId, toolName, input }` | 工具调用开始 |
| `message.tool_call_end` | `{ sessionId, toolCallId, output }` | 工具调用结束 |
| `message.complete` | `{ sessionId, stopReason, usage }` | 消息生成完毕 |
| `message.error` | `{ sessionId, error }` | 生成出错 |
| `config.providers` | `{ providers: ProviderInfo[] }` | Provider 列表 |
| `config.providerUpdated` | `{ providerId }` | Provider 已更新 |
| `model.list` | `{ models: ModelInfo[] }` | 模型列表 |
| `model.switched` | `{ sessionId, modelId }` | 模型已切换 |
| `pong` | `{}` | 心跳响应 |
| `error` | `{ message, code? }` | 通用错误 |

---

## 六、Sidecar 架构

### 6.1 模块职责

| 模块 | 职责 |
|------|------|
| `index.ts` | 入口：解析端口参数，启动 WS 服务器 |
| `server.ts` | WS 连接管理（单客户端）、消息路由、心跳 |
| `session-pool.ts` | `Map<sessionId, AgentSession>`，CRUD + 列表查询 |
| `pi-bridge.ts` | pi SDK 封装：`createSession()`、`sendMessage()`、`abort()`、`switchModel()` |
| `event-adapter.ts` | pi `AssistantMessageEventStream` → WS 事件的转换层 |
| `config-store.ts` | 读写 Provider 配置，兼容 pi 配置 |

### 6.2 pi 兼容性策略

```
配置读取优先级：
1. ~/.xyz-agent/config.toml      ← xyz-agent 自己的配置
2. ~/.pi/config.toml             ← pi 已有配置（复用，不覆盖）
3. 环境变量                       ← ANTHROPIC_API_KEY 等

Session 存储：
- 使用 pi SDK 的 SessionManager
- Session 文件存放在 pi 默认位置
- xyz-agent 创建的 Session 在 pi CLI 中可通过 /resume 访问

模型列表：
- 使用 pi SDK 的 ModelRegistry 获取可用模型
- 不自建模型列表

工具系统：
- 直接使用 pi 内置工具（read/bash/edit/write/grep/find/ls）
- 不自定义工具（P1）
```

### 6.3 Sidecar 生命周期

1. Tauri 启动时 `sidecar.rs` spawn Node.js 进程，通过 CLI 参数传递 WS 端口
2. Sidecar 启动 WS 服务器，等待前端连接
3. 前端 WS 连接后，Sidecar 扫描 pi Session 目录，发送 `session.list`
4. Tauri 关闭时发送 SIGTERM，Sidecar 优雅关闭（保存 Session、断开 WS）

### 6.4 错误处理

| 场景 | Sidecar 行为 | 前端表现 |
|------|-------------|---------|
| pi SDK 调用失败 | 发送 `message.error` | Toast 错误提示 |
| WS 断开 | — | Statusbar 显示断开状态，自动重连 |
| Sidecar 进程崩溃 | Tauri 检测到退出 | 自动重启 Sidecar + 重连 |
| Provider API Key 无效 | pi SDK 抛错 → `message.error` | Toast + 引导去设置页配置 |

---

## 七、前端状态管理（Pinia）

### 7.1 Store 划分

| Store | 状态 | 关键 actions |
|-------|------|-------------|
| `useChatStore` | 当前对话的消息列表、生成中标志、流式缓冲 | `addMessage()`, `appendDelta()`, `clearStream()` |
| `useSessionStore` | 所有 Session 列表、当前活跃 Session ID | `loadSessions()`, `createSession()`, `deleteSession()`, `switchSession()` |
| `useSettingsStore` | 语言、主题、默认模型 | `setTheme()`, `setLocale()`, `setDefaultModel()` |

### 7.2 数据流

```
WS 事件 → ws-client.ts → event-bus.ts → composable → store → Vue 响应式更新 → 组件渲染

示例：流式文本
  WS: message.text_delta { delta: "你好" }
  → ws-client.ts 接收
  → event-bus.ts 分发
  → useChat composable 处理
  → chatStore.appendDelta("你好")
  → StreamingText.vue 自动更新
```

---

## 八、技术栈汇总

| 层 | 技术 | 版本 |
|----|------|------|
| 桌面壳 | Tauri v2 | latest |
| 前端框架 | Vue 3 | 3.5+ |
| 状态管理 | Pinia | latest |
| UI 基础 | Radix Vue + Tailwind CSS v4 | latest |
| Markdown | markdown-it（P1 基础渲染） | latest |
| i18n | vue-i18n | v10+ |
| 类型检查 | vue-tsc | latest |
| Lint | ESLint flat config + 自定义规则 | v9+ |
| Agent 引擎 | @mariozechner/pi-coding-agent | latest |
| 后端通信 | WebSocket (ws) | latest |
| 构建工具 | Vite | latest |
| Git Hooks | husky + lint-staged | latest |

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
| RPC 桥接交互式通信 | P6 |
| Session Tag 系统 | P2 |
| 文件上传 | P3+ |
| Skill 管理 UI | P3+ |
| Agent 管理 UI | P5+ |
| Overview 全局总览 | P4 |
| Drawer 右侧面板 | P5 |

---

## 十、关键风险

| 风险 | 缓解措施 |
|------|---------|
| pi SDK API 不稳定 | P1 只用最稳定的 API（createAgentSession/send/abort），避免深度依赖 |
| pi SessionManager 接口变化 | 封装在 pi-bridge.ts 中，变更时只改一个文件 |
| WS 连接不稳定 | 前端自动重连 + 消息队列缓冲 + Statusbar 状态提示 |
| Design System 组件不够用 | P1 只做需要的 12 个，后续按需扩展 |
| 虚拟滚动性能 | 使用 `@tanstack/vue-virtual` 或 `vueuc` |
