---
verdict: pass
---

# E2E Test Plan — Session Tree 导航 + Fork/Clone

## Test Scenarios

### Scenario 1: Tree 数据读取 (AC1)
- 启动 pi 进程，创建一个有多个分支的 session（通过多次 user/assistant 对话 + navigate）
- sidecar 读取该 session 的 JSONL 文件
- 验证树结构正确（parentId 关系、branchCount、leafId）
- 验证孤儿节点被正确处理
- 验证未 flush 文件（空文件或只有 header）不报错

### Scenario 2: Tree 面板展示 (AC2)
- 前端打开 PanelBar 的 tree 面板
- 验证扁平列表：线性路径无缩进
- 验证条件缩进：分叉点子节点正确缩进
- 验证 leaf 路径高亮
- 验证绿色脉冲指示器
- 验证 label 标签显示
- 验证 filter 按钮切换
- 验证操作栏在选中节点后显示

### Scenario 3: Navigate 操作 (AC3)
- 前端选中历史节点，点击 Navigate
- 验证 sidecar 发送 `/xyz-navigate <id>` RPC prompt
- 验证 extension handler 被触发
- 验证 EventAdapter 正确拦截 `__xyz_type` 消息
- 验证前端重新加载消息
- 验证 navigate 到 user message 时文本放入输入框
- 验证 navigate 到当前 leaf 时 no-op
- 验证超时场景（5s 无响应 → 错误提示）

### Scenario 4: Fork 操作 (AC4)
- 前端选中历史节点，点击 Fork
- 验证 sidecar 发送 RPC fork 命令
- 验证新 session 在 sidebar 出现
- 验证自动切换到新 session
- 验证输入框预填 user message 文本
- 验证旧 session 不受影响
- 验证 fork 失败场景（无效 entryId → 错误提示）

### Scenario 5: Clone 操作 (AC5)
- 通过 slash 菜单执行 `/clone`
- 验证新 session 在 sidebar 出现

### Scenario 6: Extension 加载检测 (AC6)
- 启动 pi 进程（带 extension）
- 验证 `get_commands` 返回 `xyz-navigate`
- 启动 pi 进程（不带 extension）
- 验证前端 Navigate 按钮不可用

## Test Environment

- **前置条件**: pi 进程可启动，有可用的 LLM provider 配置
- **数据准备**: 需要预先创建有多分支的 JSONL session 文件
- **Mock 模式**: tree 功能的 mock 数据在后续迭代补充（当前 VITE_MOCK 不覆盖 tree）
- **测试方式**: 手动 E2E 测试 + 单元测试覆盖核心逻辑（session-tree-reader、EventAdapter 拦截）
