---
verdict: pass
---

# E2E Test Plan: AgentRunBlock

## 测试范围

验证 AgentRunBlock 三层结构的完整端到端行为，覆盖 spec AC-1 ~ AC-8。

## 前置条件

- compactStreaming 设置为 true
- standaloneTools 默认为 ['write', 'edit']

## 测试场景

### E2E-1: AgentRunBlock 容器渲染（AC-1）

**步骤**:
1. 发送一条消息触发 Agent 执行
2. 观察 streaming 过程中的 AgentRunBlock 容器
3. 等待执行完成

**预期**:
- streaming 时顶部有扫光动画（3px 状态条）
- complete 时状态条变为静默色
- footer 显示步骤数、总耗时、文件修改数
- 步骤数 = 可见 MergeBlock + StandaloneToolCard 数量（不含 text）

### E2E-2: ContentBlock 独立渲染（AC-2）

**步骤**:
1. 触发一个包含 text + write + edit 的 Agent 执行
2. 观察完成后的渲染

**预期**:
- text block 直接显示 markdown 内容
- write toolCall 显示为独立卡片，包含文件路径和修改量 badge
- edit toolCall 显示为独立卡片，包含文件路径和修改量 badge

### E2E-3: MergeBlock 折叠展开（AC-3）

**步骤**:
1. 触发一个包含 thinking + read + bash 的 Agent 执行
2. 观察完成后的 MergeBlock chip 条
3. 点击"过程"标签展开
4. 再次点击折叠

**预期**:
- chip 条显示 `思考 ×N · read ×N · bash ×N` 格式
- 展开/折叠正常工作
- 展开后可见 ThinkingBlock 和 ToolCallCard 组件

### E2E-4: MergeBlock Streaming 实时状态（AC-4）

**步骤**:
1. 发送消息触发 Agent 执行
2. 观察 streaming 中的 MergeBlock

**预期**:
- thinking 时显示"思考中..."
- tool running 时显示 `read src/main.ts` 格式
- 耗时实时更新（每秒刷新）

### E2E-5: 分组正确性（AC-5）

通过构造不同 contentBlocks 序列验证分组。4 组时序精确匹配 spec AC-5 定义：

**场景 A** `[T, tc-read, tc-bash, text, T, tc-read, T, tc-grep]`:
- MergeBlock: [thk, tc-read, tc-bash]
- TextBlock: text
- MergeBlock: [thk, tc-read, thk, tc-grep]

**场景 B** `[T, text, edit, text]` (edit 在 standaloneTools 中):
- MergeBlock: [thk]
- TextBlock: text
- StandaloneBlock: edit
- TextBlock: text

**场景 C** `[T, tc-read, write, T, tc-bash, text, subagent, text]`:
- MergeBlock: [thk, tc-read]
- StandaloneBlock: write
- MergeBlock: [thk, tc-bash]
- TextBlock: text
- CustomToolBlock: subagent
- TextBlock: text

**场景 D** (standaloneTools=['write','edit','bash']):
- bash 从 MergeBlock 移出变为独立 StandaloneBlock
- 验证: `[T, tc-bash]` → MergeBlock: [thk] + StandaloneBlock: bash

### E2E-6: 主题兼容（AC-6）

**步骤**:
1. 分别切换 light / dark / dim 主题
2. 每种主题下观察 AgentRunBlock 渲染

**预期**:
- 所有颜色通过 CSS 变量自适应
- 无硬编码颜色值

### E2E-7: 旧消息兼容（AC-7）

**步骤**:
1. 确保有不含 contentBlocks 的历史 assistant 消息
2. 观察 compactStreaming=true 时这些消息的渲染

**预期**:
- 历史消息走 groupByLegacyFields 逻辑，渲染不变
- user/system 消息不受影响

### E2E-8: Settings standaloneTools 配置（AC-8）

**步骤**:
1. 打开 Settings 页面
2. 找到"独立展示工具"设置区域
3. 取消 edit 的勾选
4. 返回聊天，触发 Agent 执行
5. 观察结果
6. 重新勾选 edit

**预期**:
- 7 个 pi 内置工具 checkbox，默认 write+edit 选中
- 取消 edit 后，edit 操作被折叠到 MergeBlock
- 勾选回 edit 后，edit 恢复为独立卡片
- 重启应用后设置保留
