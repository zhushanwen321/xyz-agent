# 最高优先级功能规划

基于 2026-05-17 用户反馈，重新排列最高优先级。

核心诉求：**能实际用起来**。不是功能多，而是每个功能都真正改善日常使用体验。

---

## TOP 1：生产构建（Production Build）

**问题**：当前只有 `npm run dev` 开发模式，没有可分发、可安装的生产应用。项目无法脱离开发环境使用。

**当前状态**：

- `electron-builder` 已配置（`electron-builder.yml`），但 target 只有 `dir`（未打包成 dmg/zip）
- Sidecar 用 `tsx` 直接运行 TS 源码，没有编译步骤
- Renderer 有 `vite build`，可以产出前端静态文件
- `npm run build` 链路：`build:vite → build:main → build:preload → electron-builder`

**需要做的事**：

### 1.1 Sidecar 编译

Sidecar 当前依赖 `tsx` 运行时编译。生产模式需要：

- 用 `tsc` 编译 sidecar TS → JS（或用 `tsup`/`vite` 打包为单文件）
- Electron main 进程 spawn sidecar 时使用编译后的 JS（而非 tsx）
- sidecar 的 `package.json` 添加 `"build": "tsc -p tsconfig.json"` 脚本

### 1.2 Electron Builder 配置完善

`electron-builder.yml` 当前：

```yaml
files:
  - dist/**/*
  - package.json
  - node_modules/**/*
directories:
  output: dist/builder-output
mac:
  target: dir
```

需要：

- Sidecar 编译产物加入 files 列表
- `mac.target` 改为 `dmg`（macOS 安装包）+ `zip`（便携版）
- 配置 `asar: true`（将源码打包为 asar 归档）
- 添加 `appId`、`productName`、`copyright` 等元信息
- 添加应用图标（icns）
- 添加 Code Signing 配置（后续）

### 1.3 构建流程串通

完整的 `npm run build` 流程：

```
1. sidecar:  tsc 编译 → dist/sidecar/
2. renderer: vue-tsc + vite build → dist/renderer/
3. main:     vite build → dist/main/
4. preload:  vite build → dist/preload/
5. electron-builder → 打包为 dmg/zip
```

### 1.4 开发体验优化

- `npm run dev` 一键启动（当前已有）
- `npm run build && npm run start` 本地验证构建产物
- 添加 `.env.production` 配置区分开发/生产环境

**涉及文件**：
- 修改：`src-electron/package.json` — 添加 sidecar build 步骤
- 修改：`src-electron/electron-builder.yml` — 完善打包配置
- 修改：`src-electron/sidecar/package.json` — 添加 build 脚本
- 修改：`src-electron/main/sidecar-manager.ts` — 生产模式 spawn 编译后的 JS
- 新增：`src-electron/build/entitlements.mac.plist` — macOS 权限声明

---

## TOP 2：Markdown 渲染优化

**问题**：AI 的文本输出（尤其是 markdown 格式）在聊天对话中展示不友好。当前的 `markdown-it` + `dompurify` 只做了最基本的渲染，缺少代码高亮、表格、列表等关键排版。

**当前状态**：

`lib/markdown.ts` 只有 10 行代码，`markdown-it` 默认配置，`DOMPurify` 基础过滤。渲染效果：
- 代码块：黑白底色 `<pre>`，无语法高亮
- 表格：无样式
- 列表：缩进不明确
- 链接：可点击但无视觉区分
- 标题：无层次差异

**需要做的事**：

### 2.1 代码块语法高亮

- 集成 `shiki`（基于 VS Code TextMate 语法，支持 200+ 语言）
- 或用 `highlight.js`（更轻量，覆盖常用语言）
- 深色/浅色主题跟随应用主题切换
- 代码块右上角显示语言标签 + 复制按钮

### 2.2 Markdown 排版增强

- **表格**：添加边框、斑马纹、对齐样式
- **列表**：有序/无序列表缩进层级，嵌套列表清晰区分
- **引用块**：左侧色条 + 缩进背景色
- **链接**：下划线 + accent 色 + 外部链接图标
- **标题**：h1-h3 有大小和粗细差异
- **行内代码**：背景色 + 等宽字体 + 圆角
- **分割线**：细线 + 间距
- **粗体/斜体**：明确视觉区分

### 2.3 安全保持

- DOMPurify 继续过滤所有输出（防 XSS）
- 高亮库的输出必须在 DOMPurify 之前完成，统一消毒

### 2.4 性能考虑

- 大量消息时避免重复渲染：`renderMarkdown` 结果可缓存
- 长代码块默认折叠（超过 50 行显示前 10 + 最后 5 + 展开按钮）

**涉及文件**：
- 修改：`renderer/src/lib/markdown.ts` — 集成高亮 + 排版增强
- 新增：`renderer/src/lib/highlight.ts` — 语法高亮配置（shiki 或 highlight.js）
- 修改：`renderer/src/components/chat/MessageBubble.vue` — 代码块折叠、复制按钮
- 修改：`renderer/src/style.css` — Markdown 排版样式（prose 层）
- 修改：`renderer/package.json` — 添加 shiki/highlight.js 依赖

---

## TOP 3：文件变更总览 + Diff 查看

**问题**：Agent 一次任务修改多个文件后，用户无法快速看到全貌。EditToolRenderer 按单次 tool call 碎片化展示，缺少"这次对话改了哪些文件"的聚合视图。

**当前状态**：

- `EditToolRenderer`：展示单次 edit 的 old/new 文本
- `WriteToolRenderer`：展示写入内容
- 没有"变更文件列表"聚合视图
- 没有文件级别的 diff 浏览

**需要做的事**：

### 3.1 变更集数据收集

Agent 完成一轮响应后，Sidecar 需要知道哪些文件被修改了：

- **方案 A（轻量）**：在 event-adapter 中追踪所有 `tool_execution_start/end` 中的 edit/write/bash 工具调用，提取被修改的文件路径列表
- **方案 B（准确）**：在 agent 开始前记录 git HEAD，完成后运行 `git diff --stat` + `git diff` 获取真实变更

推荐方案 B：git diff 是唯一的真实来源，且能捕获 agent 通过 bash 间接修改的文件。

### 3.2 变更集 UI

在 agent 响应完成后（`message.complete` 后），在对话流中展示：

```
┌─ Changes ────────────────────────────────────┐
│  3 files changed, 42 insertions(+), 8 deletions(-)  │
│                                                │
│  M  src/auth/login.ts       +12 -3            │
│  M  src/auth/types.ts       +5 -1             │
│  A  src/auth/utils.ts       +25               │
│                                                │
│  [View Diff]  [Accept All]  [Reject All]      │
└────────────────────────────────────────────────┘
```

点击某个文件 → 展开 unified diff 视图：
```
┌─ src/auth/login.ts ────────────── +12 -3 ────┐
│  1  import { User } from './types'            │
│  2                                            │
│  3 - const oldFn = () => {                    │
│  3 + const newFn = async (user: User) => {    │
│  4 +   const result = await validate(user)    │
│  5 +   return result                          │
│  ...                                          │
└───────────────────────────────────────────────┘
```

### 3.3 Accept / Reject

- **Accept**：不做任何事（变更已在工作区）
- **Reject**：`git checkout HEAD -- <file>` 恢复该文件
- **Accept All**：保持现状
- **Reject All**：`git checkout HEAD -- .` 恢复所有

前提：项目必须是 git repo。非 git repo 时降级为仅展示变更列表，无 Accept/Reject。

**涉及文件**：
- 新增：`renderer/src/components/chat/ChangeSet.vue` — 变更集容器
- 新增：`renderer/src/components/chat/FileDiff.vue` — 单文件 diff 视图
- 新增：`renderer/src/components/chat/FileChangeList.vue` — 变更文件列表
- 新增：`sidecar/src/changeset-tracker.ts` — git diff 采集
- 修改：`sidecar/src/session-pool.ts` — agent 执行前后记录 git 状态
- 修改：`sidecar/src/event-adapter.ts` — 新增 `message.changeset` 事件
- 修改：`shared/src/protocol.ts` — 新增 `message.changeset` 类型

---

## TOP 4：Session Tree 可视化 + pi Tree 功能对接

**问题**：pi 有完整的 session tree 结构（`id`/`parentId` 树形 JSONL），支持回退到任意节点、分支导航、分支摘要等强大功能。但 GUI 中完全没有暴露这些能力。这是 GUI 相对 CLI 的重大缺失——pi CLI 中 `/tree` 是最常用的功能之一。

**当前状态**：

- `rpc-client.ts` 只暴露了 `prompt`、`abort`、`setModel`、`getAvailableModels`、`getMessages`、`compact`、`new_session`
- 没有 `navigate_tree`、`get_tree`、`branch`、`fork`、`clone` 等 RPC 命令
- 前端没有任何 tree 可视化组件
- 对话是线性的，无法回退或分叉

**pi 的 Tree 能力清单**（来自 SessionManager API 和 pi 文档）：

| 功能 | pi API | 说明 |
|------|--------|------|
| 获取树结构 | `sessionManager.getTree()` | 完整树结构（所有节点、分支） |
| 获取分支路径 | `sessionManager.getBranch(fromId?)` | 从某节点到根的路径 |
| 获取子节点 | `sessionManager.getChildren(parentId)` | 直接子节点 |
| 获取标签 | `sessionManager.getLabel(id)` | 节点标签（书签） |
| 导航到某节点 | `session.navigateTree(targetId, options)` | 回退到历史节点继续对话 |
| 带 summary 导航 | `navigateTree(id, { summarize: true })` | 导航时生成分支摘要 |
| 带 prompt 导航 | `navigateTree(id, { customInstructions })` | 导航时自定义摘要指令 |
| 获取用户消息列表 | `session.getUserMessagesForForking()` | 用于 fork 选择器 |
| 设置节点标签 | `sessionManager.appendLabelChange(targetId, label)` | 给节点加书签 |

**需要做的事**：

### 4.1 Sidecar RPC 扩展

在 `rpc-client.ts` 和 `server.ts` 中新增以下 RPC 命令：

| WS 命令 | 对应 pi 操作 | 说明 |
|---------|-------------|------|
| `get_tree` | `sessionManager.getTree()` | 获取完整树结构 |
| `navigate_tree` | `session.navigateTree(targetId, options)` | 导航到指定节点 |
| `fork_session` | pi `--fork` 模式 | 从某节点创建新 session |
| `label_entry` | `sessionManager.appendLabelChange()` | 设置/清除节点标签 |

注意：pi 的 RPC mode 可能不直接暴露 `getTree()` 和 `navigateTree()`。需要验证 pi RPC 协议是否支持这些命令。如果不支持，有两个方案：
- **方案 A**：直接在 sidecar 中读取 JSONL 文件解析树结构（`session-format.md` 定义了完整格式）
- **方案 B**：向 pi 项目贡献这些 RPC 命令

### 4.2 Tree 数据模型

```typescript
interface SessionTreeNode {
  id: string              // 8-char hex ID
  parentId: string | null
  timestamp: number
  role: 'user' | 'assistant' | 'toolResult' | 'compaction' | 'branchSummary' | 'custom'
  label?: string          // 用户设置的书签
  preview: string         // 消息摘要（前 80 字符）
  children: SessionTreeNode[]
}

interface SessionTree {
  sessionId: string
  root: SessionTreeNode   // 虚拟根节点
  activeLeafId: string    // 当前活跃节点
}
```

### 4.3 Tree 可视化 UI

参考 pi CLI 的 `/tree` 视图，在 GUI 中实现类似的树形可视化：

```
┌─ Session Tree ──────────────────────────────┐
│                                              │
│  ● "修复 auth 模块的 bug"                    │  ← 用户消息（根节点）
│  ├── ○ AI: 分析了 auth 模块...              │  ← 助手消息
│  │   ├── ○ edit: login.ts                    │  ← 工具调用
│  │   └── ○ AI: 修改完成                      │
│  │       └── ● "现在帮我加个测试"             │  ← 当前活跃分支
│  │           └── ○ AI: 正在写测试...          │
│  └── ○ AI: 另一种方案...                     │  ← 另一个分支（未被采用）
│                                              │
│  [Summary] [Summary with Prompt] [Navigate]  │
└──────────────────────────────────────────────┘
```

### 4.4 核心交互

| 操作 | 用户动作 | 效果 |
|------|---------|------|
| **查看树** | 点击 Drawer 中的 Tree Tab 或使用 `/tree` 命令 | 展示完整 session 树 |
| **回退到某节点** | 点击树中的用户消息节点 | 从该节点继续对话，后续历史保留为分支 |
| **带 Summary 回退** | 右键节点 → "Navigate with Summary" | 导航时 pi 自动生成被放弃分支的摘要 |
| **带 Prompt 回退** | 右键节点 → "Navigate with Custom Prompt" | 用户输入自定义摘要指令后导航 |
| **添加书签** | 右键节点 → "Add Label" | 给节点添加标签，方便快速跳转 |
| **查看节点详情** | 点击非用户消息节点 | 展示该节点的完整消息内容 |

### 4.5 在 DrawerRight 中展示

当前的 DrawerRight 组件可以承载 Tree 视图。在 DrawerTabs 中新增 "Tree" Tab。

**涉及文件**：
- 新增：`renderer/src/components/drawer/SessionTree.vue` — 树形可视化
- 新增：`renderer/src/components/drawer/TreeNodeItem.vue` — 树节点（已有，需扩展）
- 新增：`renderer/src/stores/tree.ts` — 树状态管理
- 新增：`renderer/src/composables/useSessionTree.ts` — 树操作 composable
- 新增：`sidecar/src/session-tree-parser.ts` — JSONL 树解析（如果 RPC 不支持）
- 修改：`sidecar/src/rpc-client.ts` — 新增 tree 相关命令
- 修改：`sidecar/src/server.ts` — 新增 tree 相关路由
- 修改：`shared/src/protocol.ts` — 新增 tree 相关消息类型
- 修改：`renderer/src/components/drawer/DrawerTabs.vue` — 新增 Tree Tab

---

## 实施顺序建议

```
Step 1: 生产构建        → 先解决"能不能用"的问题
Step 2: Markdown 渲染   → 解决"好不好看"的问题（每天都要看的东西）
Step 3: 文件变更总览     → 解决"改了什么"的问题（核心审查能力）
Step 4: Session Tree    → 解决"能不能回退"的问题（pi 核心能力对接）
```

Step 1-2 相对独立，可以并行。Step 3-4 依赖 Step 1（需要先有可运行的构建）。
