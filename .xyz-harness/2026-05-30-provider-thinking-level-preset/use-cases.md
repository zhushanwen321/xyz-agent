---
verdict: pass
---

# Use Cases — Provider Thinking Level 快捷配置

## UC-1: 应用 DeepSeek 预设

- **Actor:** 用户
- **Preconditions:** 已配置至少一个 provider，provider 有至少一个模型
- **Main Flow:**
  1. 用户打开 Settings → Provider Section
  2. 用户点击编辑某个 provider
  3. ProviderModal 弹出，模型列表上方显示 "DeepSeek 预设" 和 "清空映射" 按钮
  4. 用户点击 "DeepSeek 预设"
  5. 系统将该 provider 所有模型的 thinkingLevelMap 设为 `{"minimal":null,"low":null,"medium":null,"high":"high","xhigh":"max"}`
  6. 用户点击保存
  7. 系统将 modalModels 写入 models.json
- **Postconditions:** 该 provider 模型的 InputToolbar 只显示 `off, high, xhigh`
- **Module Boundaries:** ProviderModal (UI) → ProviderPane (handleSave) → ConfigService.setProvider → models.json
- **AC Coverage:** AC-1

## UC-2: 清空映射

- **Actor:** 用户
- **Preconditions:** 已配置 provider，部分模型有 thinkingLevelMap
- **Main Flow:**
  1. 用户打开 Settings → Provider Section
  2. 用户点击编辑某个 provider
  3. 用户点击 "清空映射" 按钮
  4. 系统将该 provider 所有模型的 thinkingLevelMap 设为 undefined
  5. 用户点击保存
  6. 系统更新 models.json（移除 thinkingLevelMap 字段）
- **Postconditions:** InputToolbar 恢复显示全部 6 个 level
- **Module Boundaries:** ProviderModal (UI) → ProviderPane (handleSave) → ConfigService.setProvider → models.json
- **AC Coverage:** AC-2

## UC-3: 使用 thinking level 发送消息

- **Actor:** 用户
- **Preconditions:** 已配置 DeepSeek provider 并应用了预设
- **Main Flow:**
  1. 用户选择 DeepSeek provider 的模型
  2. InputToolbar 显示 thinking picker，可选 `off, high, xhigh`
  3. 用户选择 `xhigh`
  4. 用户输入消息并点击发送
  5. 系统先发送 `session.setThinkingLevel("xhigh")`
  6. 系统发送用户消息
  7. pi-agent-core 将 `xhigh` 通过 thinkingLevelMap 映射为 API 的 `max`
- **Postconditions:** 模型以最高思考强度处理消息
- **Module Boundaries:** InputToolbar → ChatInput → ws-client → sidecar → pi-agent-core → API
- **AC Coverage:** AC-4

## UC-4: 验证默认行为不受影响

- **Actor:** 用户
- **Preconditions:** 已有 models.json 中的 thinkingLevelMap 配置
- **Main Flow:**
  1. 用户打开 Settings
  2. 用户编辑其他 provider（未配置 thinkingLevelMap）
  3. 系统正确显示所有 6 个 thinking level
  4. 已有 thinkingLevelMap 的模型配置不变
- **Postconditions:** 已有数据完整保留
- **Module Boundaries:** InputToolbar (display) + ConfigService (merge)
- **AC Coverage:** AC-5

## Coverage Mapping

| UC | AC |
|----|-----|
| UC-1 | AC-1 |
| UC-2 | AC-2 |
| UC-3 | AC-3, AC-4 |
| UC-4 | AC-5 |
