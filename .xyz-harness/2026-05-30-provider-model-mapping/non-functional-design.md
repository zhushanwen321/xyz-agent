---
verdict: pass
---

# Provider Model Thinking Level Mapping — Non-Functional Design

## 1. 稳定性

本次变更仅扩展已有配置流程（`SetProviderData` 类型扩展 + `ConfigService.setProvider` 增加字段透传），不修改核心写入路径。`thinkingLevelMap` 是可选字段，缺失时不影响现有行为。前端 `ThinkingLevelConfig.vue` 是独立组件，组件崩溃不会导致 ProviderModal 整体不可用（展开区域不渲染不影响模型行的基本信息编辑）。

风险点：`ToggleSwitch` 组件的 props 签名如果与预期不符，会导致 ThinkingLevelConfig 渲染失败。通过开发阶段验证 ToggleSwitch 的 `modelValue` + `@update:model-value` 事件来规避。

## 2. 数据一致性

`pi-config-bridge` 已使用原子写入（先写临时文件再 rename），不存在写入中途崩溃导致文件损坏的风险。`thinkingLevelMap` 作为模型定义的可选字段，与 `id`、`name`、`contextWindow` 在同一个 `upsertProvider` 调用中写入，不存在部分写入问题。

前端 `buildMap()` 逻辑保证：所有 ON + 空 → `undefined`（不写入字段），任何 OFF 或有值 → 显式映射。这与 pi 原生的 `thinkingLevelMap` 语义一致，不会产生语义冲突。

## 3. 性能

ThinkingLevelConfig 是纯 UI 状态组件，不涉及文件扫描、网络请求或大量数据解析。7 个 level 行的渲染开销可忽略不计。`buildMap()` 遍历 7 个元素，O(1) 常数时间。每次 toggle/input 操作触发一次 `buildMap()` + emit，频率由用户交互决定（不可能高频），无需 debounce。

ProviderModal 的模型列表通常不超过 20 个模型，每个模型展开一个 ThinkingLevelConfig（最多 7 行），DOM 节点总量可控。不使用虚拟滚动。

## 4. 业务安全

`thinkingLevelMap` 控制 UI 级别到 API 参数的映射关系。值域为 `string | null`，写入 `models.json` 后由 pi 在发起 API 请求时读取。不涉及认证信息、权限控制或资金相关字段。恶意输入（如超长字符串）的最大影响是 API 请求参数异常，pi 层会做参数校验。

预设按钮是硬编码值（如 "high"、"max"），不涉及用户输入注入。

## 5. 数据安全

`thinkingLevelMap` 的值是 API 参数名称字符串（如 "high"、"max"），不包含敏感信息。`models.json` 存储在本地 `~/.pi/agent/` 目录，权限由文件系统控制。本次变更不改变 `models.json` 的存储位置或权限模型。

`thinkingLevelMap` 不涉及 API Key、用户数据或会话内容，不存在数据泄露风险。
