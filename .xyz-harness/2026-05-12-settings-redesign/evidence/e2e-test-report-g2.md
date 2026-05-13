# G2: Provider Tab E2E 测试报告

**执行时间**: 2026-05-13
**测试环境**: Electron CDP 9333, Sidecar WS 3210, Vite 1420
**前置条件**: G1 通过, Settings 页面已打开

---

## TC-2-01: Provider Section 渲染 — PASS

### L1: WS 协议 ✅
- `config.getProviders` 返回 providers 数组
- 1 个 provider: Router (id: router, status: connected, models: 6)
- 消息格式正确，无异常

### L2: DOM/A11y 验证 ✅
- Provider section 存在: `.border.rounded-lg.overflow-hidden`
  - roundedLg: true, border: true, overflowHidden: true
- Header 底色: `bg-[var(--section-bg)]` 类存在
- Switch 元素: 7 个 (1 个 provider toggle + 6 个 model toggle), 所有 aria-checked="true"
- 按钮: 编辑、删除

### L3: 视觉对比 ✅
- 截图保存: `tc-201_actual-provider.png`
- 圆角卡片、header 底色、model rows 平铺均可见
- AI 视觉分析确认 Section Groups 风格渲染

### 注意事项
- Sidebar "供应商" tab 切换需要通过 CDP Input.dispatchMouseEvent 实现，JS `.click()` 方法会错误激活相邻 tab
- Settings 页面各 tab panel 始终存在于 DOM 中，通过 display/opacity 控制可见性

---

## TC-2-02: Provider Toggle 启停 — PASS

### L2: DOM/A11y 验证 ✅
- Toggle OFF 后:
  - Section opacity: 0.5 (class `opacity-50` 添加)
  - Switch aria-checked: "false"
- Toggle ON 恢复后:
  - Section opacity: 1.0
  - Switch aria-checked: "true"
- 操作可逆，状态一致

### L3: 视觉对比 ✅
- 截图保存: `tc-202_toggle-off.png`
- Provider section 半透明状态可见

---

## TC-2-03: Provider 编辑 Modal — PASS (有 A11y 缺陷)

### L2: DOM/A11y 验证 ✅ (功能) / ⚠️ (A11y)
- 点击"编辑"按钮后 Modal 正确显示:
  - opacity: 1, display: flex
  - 标题: "编辑供应商"
  - 表单字段: 名称(Router)、类型(anthropic)、Base URL、API Key、模型添加、上下文长度
  - 按钮: ×、Anthropic、自动发现、添加、测试连接、取消、保存
- 点击 × 按钮后 Modal 正确关闭

### A11y 问题 ⚠️
- Modal 缺少 `role="dialog"` 属性
- Modal 缺少 `aria-modal="true"` 属性
- 建议补充以提升屏幕阅读器兼容性

### L3: 视觉 ✅
- 截图保存: `tc-203_edit-modal.png`

---

## TC-2-04: Provider 删除 — SKIP

### 原因
- 系统中仅有 1 个已配置的 provider (Router)
- 测试前置条件要求至少 2 个 provider
- 按 E2E 测试规则跳过，避免删除唯一的 provider 导致后续测试无法进行

---

## TC-2-05: Model Row Toggle — FAIL

### L2: DOM/A11y 验证 ❌
- 点击 model row 的 toggle switch 后:
  - Switch aria-checked 保持 "true"（未变为 "false"）
  - Model row opacity 保持 1.0（未变为 0.5）
  - `opacity-50` class 未添加

### 根因分析
`ProviderPane.toggleModel()` 发送的消息:
```typescript
send({ type: 'model.switch', payload: { modelId, enabled: !m.enabled } })
```

Sidecar 期望的消息格式:
```typescript
{ sessionId: string, provider: string, modelId: string }
```

**问题**: 前端发送的 payload 与 sidecar 处理逻辑不匹配:
1. 前端发送 `{modelId, enabled}` — sidecar 期望 `{sessionId, provider, modelId}`
2. 前端没有处理 `model.switched` 响应来更新 store 中的 model.enabled 状态
3. Model row 的 `opacity-50` class 依赖于 Vue 的 `enabled` prop，但该 prop 从未被更新

### 建议
需要统一 model toggle 的前后端协议，或在 ProviderPane 中直接更新 store 状态后再发送 WS 消息（类似 `toggleProvider` 的实现方式）。

---

## 总结

| 测试用例 | 结果 | 严重程度 | 说明 |
|---------|------|---------|------|
| TC-2-01 | PASS | 阻塞 | Provider Section 渲染正常 |
| TC-2-02 | PASS | 重要 | Provider Toggle 启停正常 |
| TC-2-03 | PASS | 重要 | 编辑 Modal 正常（有 A11y 缺陷） |
| TC-2-04 | SKIP | 重要 | 仅 1 个 provider，跳过删除测试 |
| TC-2-05 | FAIL | 一般 | Model Row Toggle 功能未实现 |

**通过: 3, 失败: 1, 跳过: 1**
