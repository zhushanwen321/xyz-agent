---
verdict: pass
---

# Session Tree 导航 + Fork/Clone

## Background

pi 的 session 以 JSONL 格式存储，每行一个 entry，通过 `parentId` 构建树结构。同一文件内可以存在多个分支，唯一的可变状态是内存中的 `leafId` 指针。pi TUI 提供了 `/tree`、`/fork`、`/clone` 命令，但 RPC 模式仅暴露了 `fork` 和 `clone`，不暴露 `get_tree` 和 `navigate_tree`。

xyz-agent 当前没有 tree/fork/clone 的 GUI 支持。用户无法在 GUI 中查看 session 的分支结构、导航到历史节点、或从历史节点创建分支。

**UI 参考**: [views_session_tree_v2.html](../../docs/designs/views_session_tree_v2.html)

## Functional Requirements

### FR1: Session Tree 数据读取

sidecar 直接读取 pi 的 `.jsonl` session 文件，构建树结构并推送给前端。不依赖 pi RPC。

- 从 session 文件路径（`~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`）读取所有行
- 解析每行 JSON，跳过 `type: "session"` 的 header
- 用 `parentId` 构建 `byId` Map 和树结构
- 从 `type: "label"` entry 重建 `labelsById` Map
- leafId 从已有 RPC `get_state` 获取（或从文件最后一个 entry 推导）
- 逐行 `JSON.parse` 时 try-catch 跳过格式错误的行（可能因 pi 并发写入导致最后一行不完整）
- 通过 WS 以 `session.tree-data` 消息推送给前端

### FR2: Session Tree 展示

在聊天面板顶部 PanelBar 的 breadcrumb 区域新增 tree 入口，点击后向下展开树面板。

**入口**：breadcrumb 旁的树形图标 + 分支数 badge（仅当分支数 > 1 时显示 badge）

**面板样式**（覆盖聊天区域上方，非侧边栏）：
- 扁平列表为主，只有某个 entry 有多个 children 时才出现缩进
- 当前 leaf 路径上的节点文字高亮，非活跃分支灰色
- 绿色脉冲点标记当前 leaf 位置
- 每个节点显示：类型图标（U/A/S）+ 消息首行截断
- 带 label 的节点显示 label 标签
- 底部有 filter 按钮（Default / No Tools / User / Labeled）
- 选中节点后显示操作栏：Navigate / Fork

### FR3: Navigate（在同一文件内移动 leaf 指针）

用户点击树中某个节点，选择 "Navigate here"，通过 pi extension 命令触发 `navigateTree`。

**前置验证**：实现前先写 `tools/verify-navigate-rpc.cjs` 独立验证脚本，确认 `sendMessage()` 在 RPC 事件流中的实际格式（message_start/content_block_delta/message_stop 的具体结构和类型）。遵循 CLAUDE.md 规则 #4（外部系统对接先验证再编码）。

**调用链**：
1. 前端发送 WS 消息 `session.tree-navigate { sessionId, targetEntryId }`
2. sidecar 转发为 RPC `prompt: "/xyz-navigate <targetEntryId>"`
3. pi 检测到 `/` 前缀 → 找到 extension 注册的 `xyz-navigate` 命令
4. Extension handler 调用 `ctx.navigateTree(targetEntryId, { summarize: false })`
5. Extension handler 调用 `ctx.sendMessage()` 返回结果 JSON（含 `__xyz_type: "navigate-result"` 标记）
6. RPC 事件流发出 message_start/content_block_delta/message_end → sidecar 的 EventAdapter 拦截
7. **结果拦截**：sidecar 在 EventAdapter 中检测 message 内容是否以 `{"__xyz_type":"navigate-result"` 开头。如果是，将该消息路由到 tree 处理逻辑而非 chat store，不插入聊天记录
8. sidecar 解析结果后通过 WS `session.tree-navigate-result` 通知前端

**超时处理**：sidecar 发送 `/xyz-navigate` prompt 后启动 5s 超时计时器。超时未收到 navigate-result → 取消 pending → 前端显示错误提示 "Navigate 超时"。AC 中增加对应验收条件。

**第一版不做 summarize**（跳过 LLM 调用，直接移动指针）。

**Navigate 后**：
- 前端收到 navigate-result 后，重新从 sidecar 获取树数据
- 聊天面板清空，从 pi 重新加载消息（get_messages），重新渲染从 root 到新 leaf 的消息
- 如果 navigate 到的是 user message，该 message 文本放入输入框供编辑

### FR4: Fork（从历史节点创建新 session）

用户右键/操作栏选择 "Fork from here"，通过已有 RPC `fork` 命令触发。

**调用链**：
1. 前端发送 WS 消息 `session.tree-fork { sessionId, entryId }`
2. sidecar 发送 RPC `{ type: "fork", entryId: "<id>" }`
3. pi 创建新 session 文件，复制 root→entry 的路径
4. sidecar 检查 RPC 返回的 `success` 字段（遵循 CLAUDE.md 规则 #5）。失败时向前端发送错误消息
5. sidecar 调用 `get_state` 获取新 sessionId
6. 前端 sidebar 新增 session 条目 + 自动切换到新 session

**Fork 失败场景**：entryId 不存在、pi 内部错误 → sidecar 检查 `success: false` → 前端显示 "Fork 失败: <error>" 错误提示

**Fork 后**：
- 输入框预填选中的 user message 文本（可编辑后发送）
- 旧 session 不受影响

### FR5: Clone（快照当前状态）

保留为 slash 命令 `/clone`，不需要 GUI 按钮。

- 发送 RPC `{ type: "clone" }` → pi 在当前 leaf 位置复制完整路径到新文件
- 获取新 sessionId → sidebar 新增 + 可选切换

### FR6: pi Extension 插件

编写一个 JS extension 文件，随 pi 进程启动时通过 `--extension` 参数加载。

```javascript
// xyz-agent-extension.js
export default {
  onInit(pi) {
    pi.registerCommand("xyz-navigate", {
      description: "Navigate session tree (xyz-agent internal)",
      handler: async (args, ctx) => {
        const entryId = args.trim();
        if (!entryId) return;
        const result = await ctx.navigateTree(entryId, { summarize: false });
        ctx.sendMessage(JSON.stringify({
          __xyz_type: "navigate-result",
          cancelled: result.cancelled,
          newLeafId: ctx.sessionManager.getLeafId(),
          editorText: result.editorText,
        }));
      }
    });
  }
};
```

该 extension 在 RPC 模式下可用，因为：
- `registerCommand` 注册的命令会在 `prompt()` 检测到 `/` 前缀时被查找执行（`agent-session.ts:970`）
- `commandContextActions` 在 `rpc-mode.ts:302` 的 `rebindSession()` 中绑定了 `navigateTree`
- `ctx.sendMessage()` 产生的事件通过 `session._emit()` 到达 RPC 客户端

**Extension 可用性检测**：sidecar 在 pi 进程启动后，通过 `get_commands` RPC 检查返回的命令列表是否包含 `xyz-navigate`（source: "extension"）。如果不存在，sidecar 输出 error log 并通知前端 navigate 功能不可用。前端收到不可用状态后，tree 节点操作栏不显示 Navigate 按钮（或显示灰色不可点击状态）。

## Acceptance Criteria

### AC1: Tree 数据读取
- [ ] sidecar 能正确读取 `.jsonl` 文件并构建 `byId` Map
- [ ] 正确处理 `parentId` 树结构（包括孤儿节点）
- [ ] 正确重建 `labelsById` Map
- [ ] 正确获取/推导 leafId
- [ ] 处理文件未 flush 的情况（第一条 assistant 消息前可能为空文件）

### AC2: Tree 展示
- [ ] 点击 tree 图标展开面板，再次点击或点击外部关闭
- [ ] 线性路径（单 child 链）无缩进，扁平展示
- [ ] 分叉点（多 children）正确缩进子节点
- [ ] 当前 leaf 路径高亮，非活跃分支灰色
- [ ] leaf 节点有绿色脉冲指示器
- [ ] 有 label 的节点显示 label 标签
- [ ] filter 按钮切换过滤模式
- [ ] 选中节点后底部操作栏显示 Navigate / Fork

### AC3: Navigate
- [ ] 点击 "Navigate here" → sidecar 发送 RPC prompt `/xyz-navigate <id>`
- [ ] pi extension handler 被正确触发
- [ ] `navigateTree` 执行成功后，`sendMessage()` 结果通过 RPC 事件流返回
- [ ] sidecar EventAdapter 正确拦截 `__xyz_type: "navigate-result"` 消息，不插入 chat store
- [ ] 前端收到结果后重新获取树数据 + 重新渲染消息
- [ ] navigate 到 user message 时文本放入输入框
- [ ] navigate 到当前 leaf 时 no-op
- [ ] navigate 失败时前端显示错误提示
- [ ] navigate 超时（5s）时前端显示超时提示，UI 不卡死

### AC4: Fork
- [ ] 点击 "Fork from here" → sidecar 发送 RPC fork 命令
- [ ] fork 失败时（entryId 不存在等）sidecar 检测到 success: false 并显示错误提示
- [ ] 新 session 在 sidebar 中出现
- [ ] 自动切换到新 session
- [ ] 输入框预填选中的 user message 文本
- [ ] 旧 session 不受影响

### AC5: Clone
- [ ] `/clone` slash 命令触发 RPC clone
- [ ] 新 session 在 sidebar 中出现

### AC6: Extension 加载与可用性检测
- [ ] pi 进程启动时通过 `--extension` 加载 xyz-agent extension
- [ ] sidecar 启动后通过 `get_commands` RPC 检查 `xyz-navigate` 是否在命令列表中
- [ ] `xyz-navigate` 不存在时 sidecar 输出 error log，前端不显示 Navigate 按钮
- [ ] Extension 不影响 pi 的其他功能

## WS 消息协议

### 新增消息类型

| 方向 | 消息类型 | Payload | 说明 |
|------|---------|---------|------|
| sidecar→前端 | `session.tree-data` | `{ sessionId, tree: TreeNode[], leafId: string, branchCount: number }` | 推送树结构数据 |
| 前端→sidecar | `session.tree-navigate` | `{ sessionId, targetEntryId }` | 请求导航到指定 entry |
| sidecar→前端 | `session.tree-navigate-result` | `{ sessionId, success: boolean, newLeafId?: string, editorText?: string, error?: string }` | navigate 结果 |
| 前端→sidecar | `session.tree-fork` | `{ sessionId, entryId }` | 请求从指定 entry fork |
| sidecar→前端 | `session.tree-fork-result` | `{ sessionId, success: boolean, newSessionId?: string, error?: string }` | fork 结果 |

### TreeNode 类型

```typescript
interface TreeNode {
  id: string
  parentId: string | null
  type: 'message' | 'branch_summary' | 'label' | 'compaction' | 'model_change' | 'thinking_level_change' | 'custom' | 'custom_message' | 'session_info'
  role?: 'user' | 'assistant'
  text: string          // 首行截断，最多 100 字符
  label?: string        // 用户标记
  timestamp: string
  children: TreeNode[]
}
```

## Constraints

### 技术约束
- **不改 pi 源码**：所有 tree/navigate 能力通过 extension 插件实现
- **JSONL 只读**：sidecar 只读取 `.jsonl` 文件，不写入（写入由 pi 进程负责）
- **leafId 内存状态**：不能从 JSONL 文件获取实时 leafId，必须通过 RPC 或事件
- **Extension 结果返回**：`navigateTree` 的结果不通过 RPC 事件流自动返回，必须由 handler 主动 `sendMessage()`

### 已有基础设施
- RPC 命令 `fork`、`clone`、`get_state`、`get_fork_messages` 已在 pi 中实现
- sidecar 的 `rpc-client.ts` 已有 `sendCommand` 方法
- 前端 PanelBar 已有 breadcrumb 区域和 AnchorDropdown 组件
- WS 协议 `session.compact`、`session.clear` 已在 server.ts 中路由

### 不在范围
- Summarize（branch summary，第一版不做）
- Label 编辑（后续可加）
- `/resume` 命令（和 sidebar 功能重叠）
- `/new` 命令（sidebar 已有创建按钮）
- `/name` 命令（sidebar 双击可重命名）
- 直接写入 JSONL 文件

## Complexity Assessment

**总体复杂度：中等偏高**

| 模块 | 复杂度 | 说明 |
|------|--------|------|
| Sidecar JSONL 读取 + 树构建 | 中 | 需要处理文件格式、parentId 树、edge case（未 flush、v1 格式） |
| pi Extension 插件 | 低 | 单个 JS 文件，~30 行代码 |
| 前端 Tree 组件 | 中 | 扁平 + 条件缩进的树渲染，节点交互 |
| Navigate 调用链 | 中 | 跨 3 层（前端→sidecar→pi），结果回传需额外处理 |
| Fork 调用链 | 低 | 已有 RPC 命令，只需串联 get_state + sidebar 更新 |
| WS 协议扩展 | 低 | 新增 2-3 个消息类型 |

**主要风险点**：
1. JSONL 文件未 flush 时读到的数据不完整（第一条 assistant 消息前）
2. Extension `sendMessage()` 的结果到达时间不确定，需要超时处理
3. Navigate 后前端需要正确刷新消息列表和树数据
