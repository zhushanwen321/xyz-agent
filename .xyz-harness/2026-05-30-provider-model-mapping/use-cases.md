---
verdict: pass
---

# Provider Model Thinking Level Mapping — Use Cases

## UC-1: 为 DeepSeek 模型配置 thinking level 映射

- **Actor**: 用户
- **Preconditions**:
  - 已打开 Settings → Providers 页面
  - DeepSeek provider 已配置，包含 ds-flash 等模型
  - ds-flash 当前无 thinkingLevelMap 或有旧配置

### Main Flow

1. 用户点击 DeepSeek provider 的编辑按钮，打开 ProviderModal
2. Modal 加载 DeepSeek 的模型列表（含 ds-flash）
3. 用户点击 ds-flash 模型行左侧的 chevron 图标
4. 系统展开 thinking level 配置面板，显示 7 个 level 行
5. 用户点击 "DeepSeek" 预设按钮
6. 系统自动配置：off~medium toggle OFF，high→"high"，xhigh→"max"，max→"max"
7. 用户点击保存按钮
8. 系统将 thinkingLevelMap 随 models 数据发送到 ConfigService
9. ConfigService 将 thinkingLevelMap 写入 models.json
10. Modal 关闭，provider store 刷新
11. 用户切换到聊天界面，选择 ds-flash 模型
12. InputToolbar 根据 thinkingLevelMap 过滤，只显示 high/xhigh/max

### Alternative Paths

- **3a**: ds-flash 已有旧 thinkingLevelMap → UI 正确恢复现有配置，用户可在预设基础上微调
- **7a**: WS 断连 → 保存失败，显示错误提示，Modal 不关闭
- **7b**: 用户未修改任何配置直接保存 → 透传模式，models.json 不写入 thinkingLevelMap

### Postconditions

- models.json 中 ds-flash 包含正确的 thinkingLevelMap
- 聊天界面选择 ds-flash 时只显示启用的 level

### Module Boundaries

| 步骤 | 模块 | 数据流 |
|------|------|--------|
| 2-4 | ProviderModal + ThinkingLevelConfig | props.models → UI 渲染 |
| 5-6 | ThinkingLevelConfig | applyPreset → levels state |
| 7-9 | ProviderPane → useProvider → ConfigService | emit save → WS → models.json |
| 10 | provider store | store 更新 → UI 刷新 |
| 12 | InputToolbar | store → computed 过滤 |

---

## UC-2: 为新模型快速应用预设

- **Actor**: 用户
- **Preconditions**:
  - 已打开 ProviderModal，正在编辑 provider
  - 已通过自动发现或手动添加了一个新模型（无 thinkingLevelMap）

### Main Flow

1. 用户新增模型 "deepseek-v3"
2. 点击该模型行左侧 chevron 展开配置
3. 系统显示 7 个 level 行，所有 toggle 默认 ON，输入框为空
4. 用户点击 "通用映射" 预设按钮
5. 系统配置：所有 toggle ON，high→"high"，xhigh→"max"，max→"max"，其余为空
6. 用户微调：将 "low" toggle 切为 OFF
7. 用户点击保存
8. 系统写入 models.json，deepseek-v3 的 thinkingLevelMap 为 `{low: null, high: "high", xhigh: "max", max: "max"}`
9. Modal 关闭，store 刷新

### Alternative Paths

- **4a**: 用户选择 "全开（透传）" → 所有 ON + 空 → 不写入 thinkingLevelMap
- **6a**: 用户不做微调直接保存 → 预设值完整写入

### Postconditions

- 新模型的 thinkingLevelMap 按预设+微调结果写入 models.json

### Module Boundaries

| 步骤 | 模块 | 数据流 |
|------|------|--------|
| 1 | ProviderModal | 手动/发现添加模型 |
| 2-5 | ThinkingLevelConfig | applyPreset → levels state → buildMap |
| 6 | ThinkingLevelConfig | toggle/input → buildMap |
| 7-8 | ProviderPane → ConfigService | emit save → WS → models.json |

---

## UC-3: 查看已有映射配置

- **Actor**: 用户
- **Preconditions**:
  - models.json 中 ds-flash 已有 `thinkingLevelMap: {off:null, high:"high", xhigh:"max", max:"max"}`
  - 打开 Settings → Providers

### Main Flow

1. 用户点击 DeepSeek provider 的编辑按钮
2. Modal 加载模型列表，ds-flash 显示 "mapped" badge
3. 用户点击 ds-flash 的 chevron 展开配置
4. 系统调用 ThinkingLevelConfig 的 `initLevels(ds-flash.thinkingLevelMap)`
5. UI 显示：off toggle OFF，minimal/low/medium toggle ON（不在 map 中 = 透传），high 输入 "high"，xhigh 输入 "max"，max 输入 "max"
6. 用户关闭 Modal（不做修改）

### Alternative Paths

- **3a**: 用户修改配置并保存 → 按 UC-1 流程处理
- **5a**: minimal/low/medium 不在 thinkingLevelMap 中 → 显示为 ON + 空（省略 key = 透传，FR-2 规则）

### Postconditions

- 无变更，models.json 不受影响

### Module Boundaries

| 步骤 | 模块 | 数据流 |
|------|------|--------|
| 2 | ProviderModal | provider store → ModalModel.thinkingLevelMap → badge 显示 |
| 3-4 | ProviderModal + ThinkingLevelConfig | props → initLevels |
| 5 | ThinkingLevelConfig | levels state → UI 渲染 |

---

## Coverage Mapping

| Use Case | AC-1 | AC-2 | AC-3 | AC-4 | AC-5 | AC-6 |
|----------|------|------|------|------|------|------|
| UC-1 | ✓ 展开/折叠 | ✓ toggle+输入 | ✓ 保存写入 | ✓ 失败路径 | ✓ 过滤联动 | ✓ 预设应用 |
| UC-2 | ✓ 展开 | ✓ 默认状态+toggle | ✓ 新模型写入 | | | ✓ 预设选择+微调 |
| UC-3 | ✓ 展开查看 | ✓ 状态恢复 | | | | |
