---
verdict: pass
---

# E2E Test Plan — Provider Thinking Level 快捷配置

## Test Scenarios

### Scenario 1: DeepSeek 预设按钮功能（AC-1）
1. 启动应用，打开 Settings → Provider Section
2. 编辑已有 provider（或创建新的）
3. 添加至少一个模型
4. 点击 "DeepSeek 预设" 按钮
5. 点击保存
6. 切换到聊天视图，选择该 provider 的模型
7. 验证 InputToolbar thinking picker 只显示 `off, high, xhigh`

### Scenario 2: 清空映射按钮功能（AC-2）
1. 在 Scenario 1 基础上，重新编辑同一 provider
2. 点击 "清空映射" 按钮
3. 点击保存
4. 切换到聊天视图，选择同一模型
5. 验证 InputToolbar 显示全部 6 个 level（off, minimal, low, medium, high, xhigh）

### Scenario 3: thinking picker 不显示 max（AC-3）
1. 检查 models.json 中 DeepSeek 模型的 thinkingLevelMap
2. 确认 `max` 只出现在 map 的 value 中，不在 key 中
3. 确认 InputToolbar picker 选项中没有 `max`

### Scenario 4: 发送消息时 thinking level 同步（AC-4）
1. 应用 DeepSeek 预设
2. 在聊天中选择 `xhigh`
3. 发送消息
4. 观察 WS 流量或 sidecar 日志，确认 `session.setThinkingLevel` 先于消息发送
5. 确认模型回复正常（thinking 生效）

### Scenario 5: 已有数据不受影响（AC-5）
1. 记录修改前 models.json 内容
2. 执行 Scenario 1 和 Scenario 2
3. 对比修改前后 models.json
4. 确认：应用预设 → 保存 → 清空映射 → 保存后，thinkingLevelMap 回到 undefined 状态
5. 确认其他 provider 的配置未受影响

## Test Environment

- 开发模式：`npm run dev`
- 需要至少一个配置好的 provider（可用 mock 模式 `VITE_MOCK=true` 或真实 provider）
- 验证 InputToolbar 需要创建或加载一个 session
