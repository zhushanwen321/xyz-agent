---
verdict: pass
---

# Use Cases — Session 生命周期管理

**覆盖**: session 创建、重命名、持久化、跨窗口导航、历史加载。

---

## UC-S1: 创建空对话 session

- **Actor**: 用户
- **Preconditions**: electron + runtime 已启动，WS 已连接
- **Main Flow**:
  1. 用户点击 "+ New Session"
  2. 选择项目目录
  3. runtime 启动 pi 进程，获取 `sessionId` 和 `sessionFilePath`
  4. **xyz-agent 主动写入最小 session 文件**（如果 pi 未创建）
  5. session 出现在侧边栏 "New session-01"
  6. 用户未发送任何消息，直接关闭应用
  7. 重新打开应用
  8. session 仍在侧边栏列表中
- **Failure Mode (已修复)**:
  - 4a. pi 延迟写入：如果 xyz-agent 不主动创建文件，空对话 session 重启后从侧边栏消失
- **Postconditions**: session 文件存在于 `~/.xyz-agent/pi/sessions/`，重启后可见
- **Module Boundaries**: session-service.create() → pi-config-bridge.ensureSessionFile()
- **数据流**: 前端 session.create → runtime createSession → pi 启动 → ensureSessionFile → refreshAll → session.list

## UC-S2: 重命名 session 并持久化

- **Actor**: 用户
- **Preconditions**: session 已存在（可能有或无对话）
- **Main Flow**:
  1. 用户在侧边栏双击 session 名称
  2. 输入新名称 "my-project"，按 Enter
  3. 前端乐观更新 store label
  4. runtime renameSession() 更新内存 label
  5. **新增的 session_info entry 被 append 到 session 的 jsonl 文件**
  6. broadcastSessionList 重新列出 session，新名称生效
  7. 关闭并重新打开应用
  8. session 显示为 "my-project"
- **Alternative Paths**:
  - 如果 session 的 pi 进程已退出（不在内存 Map 中）：从磁盘查找 jsonl 文件并写入 session_info
  - 如果 session 文件不存在（空对话）：自动创建文件并写入 session_info
- **Postconditions**: 重命名在重启后保留
- **Module Boundaries**: session-service.renameSession() → pi-config-bridge.persistSessionName()
- **数据流**: 前端 session.rename → runtime renameSession → persistSessionName → broadcastSessionList

## UC-S3: 加载闲置 session 的对话历史

- **Actor**: 用户
- **Preconditions**: session A 有大量对话但 pi 进程已退出（status=idle）
- **Main Flow**:
  1. 用户在侧边栏点击 session A
  2. 前端发送 `session.history` 命令
  3. runtime 检测到 session A 没有活跃 pi 进程
  4. **直接从磁盘 jsonl 文件读取历史消息**（getHistoryFromFile）
  5. 消息加载到聊天面板
- **Failure Mode (已修复)**:
  - 4a. 如果走 session.switch（RPC 路径）而不是 session.history（磁盘路径），
    在 session 驻留 Map 但 pi 进程已死时返回空
- **Postconditions**: 对话历史完整显示
- **数据流**: 前端 session.history → runtime getHistory → getHistoryFromFile → readFile(jsonl) → convertPiHistory → 前端 replaceMessages

## UC-S4: 创建新 session 后面板自动绑定

- **Actor**: 用户
- **Preconditions**: 当前 window 已有一个空 panel
- **Main Flow**:
  1. 用户创建新 session
  2. `openSessionSmart` 检测到只有一个空 panel
  3. session 直接绑定到该 panel
- **Alternative Paths**:
  - 如果当前有一个有内容的 panel：split 后绑定到新 panel
  - 如果已有 2 个 panel：创建新 window

## UC-S5: 跨 window 跳转到已打开 session

- **Actor**: 用户
- **Preconditions**: session A 在 Window 2 Panel 1 中打开，用户当前在 Window 1
- **Main Flow**:
  1. 用户在 Window 1 的侧边栏点击 session A
  2. `openSessionSmart` 先检查当前 window 的 panel tree → 未找到
  3. **调用 `findSessionWindow` 通过 Electron IPC 查询所有 window**
  4. 发现 session A 在 Window 2
  5. 聚焦 Window 2（不做任何 panel 变更）
- **Failure Mode (已修复)**:
  - 3a. 之前不检查其他 window，导致在当前 window 创建新 panel 或新窗口
- **Postconditions**: Window 2 被激活，panel 位置保持不变
- **数据流**: openSessionSmart → findSessionWindow(IPC) → focusWindow

## UC-S6: 重命名 session 边输入边预览

- **Actor**: 用户
- **Preconditions**: session 在侧边栏中
- **Main Flow**:
  1. 用户双击 session → 进入内联编辑模式
  2. 用户输入新名称
  3. 按 Enter 确认或 Esc 取消
  4. 确认后乐观更新 store + 发送 rename 命令

## UC-S7: 删除闲置 session

- **Actor**: 用户
- **Preconditions**: session 不在活跃状态
- **Main Flow**:
  1. 用户 hover session → 点击删除按钮 → 确认
  2. runtime 删除 session 的 jsonl 文件
  3. session 从侧边栏移除

---

## UC 与 bug 修复映射

| UC | 覆盖的 Bug | 修复位置 |
|----|-----------|---------|
| UC-S1 | 空 session 重启消失 | session-service.create() + ensureSessionFile() |
| UC-S2 | 重命名不持久化 | session-service.renameSession() + persistSessionName() |
| UC-S3 | 闲置 session 历史加载为空 | useSession.switchSession() → session.history (非 session.switch) |
| UC-S4 | 面板自动绑定 | panel.openSessionSmart() |
| UC-S5 | 跨 window 重复开 panel | panel.openSessionSmart() + findSessionWindow() |
| UC-S6 | 重命名单次不生效 | AppSidebar.onConfirmRename() 乐观更新 + broadcastSessionList |
| UC-S7 | 删除清理 | session-service.delete() + trash() |
