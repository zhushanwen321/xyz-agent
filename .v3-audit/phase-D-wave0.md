# Wave 0 · T00 前置调研

> Agent: worker (sync)
> 性质: 只读调研，不改代码
> 产出: 4 个事实结论，为 T10(Composer S6) 和 R7(FileChanges) 的方案分叉提供依据

## 目标

两个修复任务的方案取决于以下后端/配置事实。读真实代码之前不下结论（user-memory 铁律）。

## 调研点

### 1. pi fork 的 steer RPC 支持

- **源码**: `~/Code/pi-mono-workspace/`（bare repo + worktree，查 main 或最新 worktree 的 `packages/coding-agent/src/`）
- **关键文件**: `modes/rpc/rpc-mode.ts`、`core/agent-session.ts`、`core/slash-commands.ts`
- **查找**: 是否存在 `steer` 命令/RPC（可能叫 steer/queue/inject/interrupt/redirect）
- **查找**: followup 相关 RPC
- **结论要求**: 支持 / 不支持 / 部分支持。给证据（文件:行号 + 代码片段）
- **影响**: 决定 Composer isStreaming 时 Enter 走长期方案（实现 rt.steer() 提交）还是短期兜底（禁用输入）。DEC-03 分叉点

### 2. runtime 是否输出文件变更事件

- **源码**: 本 worktree 的 `src-electron/runtime/src/`
- **查找**: pi 的 tool_result/tool_call 是否含文件路径（新增/修改/删除）
- **查找**: runtime 的 EventAdapter / session-pool 是否解析 tool 调用提取文件变更
- **查找**: `shared/src/message.ts` 是否有 fileChanges 相关类型
- **结论要求**: 已输出 / 未输出 / 部分（有数据未解析）。给证据
- **影响**: 决定 FileChanges(R7) 是接现有数据 / 从零建通道 / 整体 defer 到 flow-2

### 3. Tailwind 配置方式（token → utility 映射）

- **查找**: 本 worktree 是否有 `tailwind.config.{js,ts,cjs,mjs}`（bash 未找到）
- **查找**: 是否用 `@tailwindcss/vite` 插件（查 vite.config + package.json）
- **查找**: `style.css` 的 CSS 变量如何暴露为 utility（`bg-surface` → `var(--surface)` 的映射在哪定义）
- **查找**: 现有 utility 如 `bg-surface`、`bg-surface-hover`、`text-fg`、`border-border` 在哪配置（colors 扩展？@theme？@layer？）
- **结论要求**: 说明配置机制 + 新增 token（如 `bg-surface-2`）需改哪些文件
- **影响**: 决定 T01 token 落地改法（config colors vs @theme vs 纯 CSS 变量 + 手写 utility class）

### 4. ⌘K 快捷键冲突核实（RC-11）

- **查找**: 前端是否注册 ⌘K 全局快捷键（grep `cmd+k`、`meta+k`、`key==='k'`、`KeyK`）
- **查找**: 设计稿中 ⌘K 用途（全局搜索 SearchModal vs Settings 内置搜索）
- **结论要求**: 真冲突 / 无冲突（两者都未实现）
- **影响**: 决定 RC-11 是真问题还是可忽略

## 产出格式

每个调研点一段：**事实结论 + 证据（文件:行号）+ 对修复方案的影响**。不写代码改法，只给事实。
