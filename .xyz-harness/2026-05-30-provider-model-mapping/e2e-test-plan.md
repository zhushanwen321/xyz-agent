---
verdict: pass
---

# Provider Model Thinking Level Mapping — E2E Test Plan

## 测试范围

验证 `thinkingLevelMap` 从 UI 编辑到 `models.json` 持久化的完整链路，以及保存后 `InputToolbar` 过滤联动行为。

## 测试环境

- 开发模式：`npm run dev`，Electron 窗口操作
- 测试 Provider：使用已有的 DeepSeek provider（含 ds-flash 模型）
- 测试模型：ds-flash（已有 thinkingLevelMap）、新增测试模型（无 thinkingLevelMap）

## Test Scenarios

### TS-1: 模型行展开与折叠

**前置条件**: 打开 Settings → Providers → 编辑 DeepSeek provider

1. 验证每个模型行左侧有 chevron 图标
2. 点击 ds-flash 模型行的 chevron，展开 thinking level 配置区域
3. 验证展开动画平滑（无闪烁或跳变）
4. 再次点击 chevron，配置区域折叠
5. 展开 ds-flash 后，再展开另一个模型行，验证两行可同时展开

**预期结果**: 展开/折叠响应流畅，多行可同时展开

### TS-2: Toggle 与 API 参数输入交互

**前置条件**: 展开一个无 thinkingLevelMap 的模型

1. 验证 7 个 level 行（off → max）全部显示
2. 验证所有 toggle 默认 ON，所有输入框为空
3. 切换 "medium" toggle 为 OFF
4. 验证 "medium" 行的输入框置灰（disabled 样式），level 名称变灰
5. 切换 "medium" toggle 为 ON
6. 验证输入框恢复可编辑状态
7. 在 "high" 输入框中输入 "high"
8. 在 "xhigh" 输入框中输入 "max"

**预期结果**: toggle 状态正确控制输入框启用/禁用，输入框可正常编辑

### TS-3: 已有 thinkingLevelMap 模型的状态恢复

**前置条件**: 展开 ds-flash 模型（已有 `{"off":null, "high":"high", "xhigh":"max", "max":"max"}`）

1. 验证 off、minimal、low、medium 的 toggle 为 OFF，输入框置灰
2. 验证 high toggle 为 ON，输入框值为 "high"
3. 验证 xhigh toggle 为 ON，输入框值为 "max"
4. 验证 max toggle 为 ON，输入框值为 "max"
5. 修改 high 的输入框值为 "high-v2"

**预期结果**: UI 正确反映已有的 thinkingLevelMap 配置

### TS-4: 预设模板应用

**前置条件**: 展开一个新模型的 thinking level 配置

1. 点击 "DeepSeek" 预设按钮
2. 验证 off ~ medium toggle OFF，high 输入 "high"，xhigh 输入 "max"，max 输入 "max"
3. 点击 "全开（透传）" 预设按钮
4. 验证所有 toggle ON，所有输入框为空
5. 点击 "通用映射" 预设按钮
6. 验证所有 toggle ON，high 输入 "high"，xhigh 输入 "max"，max 输入 "max"，其余为空

**预期结果**: 预设正确覆盖当前配置，用户可在此基础上微调

### TS-5: 保存并验证 models.json

**前置条件**: 编辑一个模型的 thinkingLevelMap

1. 展开 ds-flash，配置为 DeepSeek 预设
2. 点击保存
3. 验证 Modal 自动关闭
4. 检查 `~/.xyz-agent/pi/agent/models.json` 中 ds-flash 的 `thinkingLevelMap` 字段：
   - `off: null`、`minimal: null`、`low: null`、`medium: null`
   - `high: "high"`、`xhigh: "max"`、`max: "max"`
5. 展开 ds-flash 验证 UI 重新加载后状态一致

**预期结果**: `models.json` 正确写入，UI 重载后状态一致

### TS-6: 全透传不写入 thinkingLevelMap

**前置条件**: 展开一个新模型

1. 保持所有 toggle ON、所有输入框为空（默认状态）
2. 点击保存
3. 检查 `models.json` 中该模型的 `thinkingLevelMap` 字段**不存在**（未写入）

**预期结果**: 全透传模式下省略 `thinkingLevelMap` 字段

### TS-7: InputToolbar 过滤联动

**前置条件**: ds-flash 已保存为 DeepSeek 预设配置

1. 切换到聊天界面
2. 选择 DeepSeek provider 下的 ds-flash 模型
3. 验证 InputToolbar 的 thinking level 下拉只显示 `high`、`xhigh`、`max`
4. 切换到另一个无 thinkingLevelMap 的模型
5. 验证 InputToolbar 显示所有 7 个 level

**预期结果**: `InputToolbar` 根据 `thinkingLevelMap` 正确过滤

### TS-8: 保存失败处理

**前置条件**: 模拟 WS 断连（可通过关闭 sidecar 进程）

1. 编辑 ds-flash 的 thinkingLevelMap
2. 点击保存
3. 验证错误提示出现（toast 或 inline message）
4. 验证 Modal **不关闭**，用户可继续编辑
5. 恢复 sidecar 后重新保存，验证成功

**预期结果**: 失败时 Modal 不关闭，用户不丢失编辑内容

## Risk Areas

1. **ToggleSwitch 组件兼容性**: 确认 `ToggleSwitch` 的 `modelValue` 和 `@update:model-value` 事件签名
2. **models.json 原子写入**: `pi-config-bridge` 已使用原子写入（先写临时文件再 rename），无需额外处理
3. **并发编辑**: 多个 panel 同时编辑同一 provider 的可能性极低，不处理
