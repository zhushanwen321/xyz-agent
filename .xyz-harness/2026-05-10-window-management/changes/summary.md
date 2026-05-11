# 窗口管理系统 - 全流程追溯

## 基本信息
- 需求描述: 将 xyz-agent 窗口管理从"单窗口+布尔分栏"升级为"多窗口+二叉树分栏"模型
- 开始时间: 2026-05-10
- 当前阶段: 编码实现已完成，架构清理已完成

## 阶段状态

| 阶段 | 状态 | 评审轮次 | 备注 |
|------|------|---------|------|
| 1 需求分析 | ✅ 通过 | 1轮 | 2026-05-10 |
| 2 需求评审 | ✅ 通过 | 1轮 | 2026-05-10，修正9个MUST FIX |
| 3 编码实现 | ✅ 完成 | - | 6个Phase全部完成，commit 982203f |
| 4 编码评审 | ✅ 通过 | 2轮 | 第一轮：9个MUST FIX修正；第二轮：zoom-out架构清理 |
| 5-11 | ⬜ 跳过 | - | 无测试基础设施，手动验证构建通过 |

## 评审摘要

### 需求评审（阶段 2）
- 独立评审发现 9 个 MUST FIX，已全部修正到 spec.md 和 plan.md
- 关键修正：Cmd+W 行为区分、快捷键覆盖、agentViews 分区、WindowState 类型、IPC handler 注册

### 编码实现（阶段 3）
- 10 个 subagent 按依赖关系分批执行（Phase 0→1→2→3→4→5，Phase 5 与 Phase 2 并行）
- 新建 10 个文件，修改 32 个文件，净增 ~2700 行

### 编码评审（阶段 4）— 交互式迭代

#### 第一轮：Bug 修复（用户反馈）
1. **useChat 事件处理器读全局 ref**：handler 内 `store.streamingMessage` 读的是 `__default__` 分区，而非按 sessionId 分区的数据。修复：所有 handler 改为 `store.getSessionState(sid).streamingMessage`
2. **useChat 事件绑定模型错误**：`listenerRefCount` 只让第一个实例注册全局 handler，第二个 Pane 事件无人处理。修复：事件处理器改为模块级全局函数，从消息 `payload.sessionId` 直接提取路由
3. **点击 panel 不触发聚焦**：PaneTreeRenderer 的 `.ptr-pane` 缺少 mousedown handler。修复：添加 `@mousedown="paneStore.navigateToPane(node.id)"`
4. **横向滚动条**：`.chat-msgs` 缺少 `overflow-x: hidden`
5. **PanelBar 无 session 标识**：添加目录名+session label 显示，关闭按钮在多 pane 时始终可见
6. **Statusbar 信息冗余**：简化为只显示连接状态+模型+token
7. **Panel 聚焦色条不一致**：所有 pane 都有 `border-top: 2px`，focused 用 accent 色，unfocused 用 border 色

#### 第二轮：Zoom-out 架构清理
用户触发 zoom-out-rethink，分析发现所有 bug 的根因是 **ChatStore 双状态模型**：
- 12 个全局 ref + `chatSessions` Map 并存
- 每个方法内 `if (sessionId === '__default__')` 双路径分支

执行架构清理：
1. **ChatStore 删除全局 ref**：~350 行 → ~180 行，所有方法统一走 `getSessionState(sid)`
2. **删除 ChatView.vue**：已被 PaneSessionView 替代
3. **修复引用组件**：AppHeader、ContextBar、Statusbar 改为从分区读取

## 异常记录

| 异常 | 原因 | 处理 |
|------|------|------|
| glm-5.1 额度用尽 | API 配额限制 | 切换到 ocg-deepseek/deepseek-v4-pro，后改为 llm-simple-router/deepseek-v4-flash |
| useChat 全局 ref bug | 双状态模型导致读/写路径不一致 | 架构清理，消除双状态 |
| 面板点击不聚焦 | PaneTreeRenderer 缺少 mousedown handler | 添加事件绑定 |
| focus mode 残留 | settingsStore 迁移不彻底 | 移除 focusMode ref 和相关逻辑 |

## 变更统计

```
commit 982203f
43 files changed
+2717 / -678 lines
10 new files, 1 deleted (ChatView.vue)
```

### 新建文件
| 文件 | 用途 |
|------|------|
| `shared/src/pane.ts` | PaneTree / WindowState 类型定义 |
| `renderer/src/stores/pane.ts` | PaneStore（二叉树 CRUD） |
| `renderer/src/stores/window.ts` | WindowStore（多窗口状态） |
| `renderer/src/components/panel/PaneTreeRenderer.vue` | 递归 PaneTree 渲染 |
| `renderer/src/components/panel/PaneSessionView.vue` | Pane-Session 绑定容器 |
| `renderer/src/components/panel/EmptyPane.vue` | 空面板引导 |
| `renderer/src/components/overview/WindowCard.vue` | 窗口缩略图卡片 |
| `renderer/src/components/overview/PaneTreeMini.vue` | 缩略 PaneTree 渲染 |
| `renderer/src/main/window-manager.ts` | WindowManager（主进程） |

### 快捷键
| 快捷键 | 功能 |
|--------|------|
| Cmd+D | 水平分栏 |
| Cmd+Shift+D | 垂直分栏 |
| Cmd+W | 清空当前 Pane session |
| Cmd+1 | 恢复单 Pane |
| Cmd+B | 切换 Sidebar Drawer |
| Cmd+J | 切换 Overview |

## 架构清理收益

| 指标 | 清理前 | 清理后 |
|------|--------|--------|
| ChatStore 行数 | ~350 | ~180 |
| 数据源 | 双套（全局 ref + Map） | 单一（Map） |
| 方法内分支 | 每个 if/else 双路径 | 统一 getSessionState(sid) |
| 死代码 | ChatView.vue + 12 个全局 ref | 已清除 |
| 未来新增功能心智负担 | 需判断走哪条路径 | 只有一条路径 |
