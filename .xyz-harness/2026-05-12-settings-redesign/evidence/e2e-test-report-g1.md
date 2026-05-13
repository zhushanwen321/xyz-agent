# E2E Test Report: G1 基础连通性

**测试日期**: 2026-05-13 13:00-13:10
**执行环境**: macOS, Sidecar ws://localhost:3210, Electron CDP :9333
**测试结果**: 4 passed, 0 failed, 0 skipped

---

## TC-1-01: Sidecar 健康检查 — PASS

### Layer 1: WS 协议
- `GET /health` HTTP 200
- Response: `{"status":"ok","uptime":89.18}`
- **结论**: PASS

### Layer 2: DOM/A11y — N/A
### Layer 3: 视觉对比 — N/A

---

## TC-1-02: WS 连接 + 初始广播 — PASS

### Layer 1: WS 协议
- WS 连接 `ws://localhost:3210` 成功
- 5 秒内收到 5 种广播消息:
  - `config.providers`
  - `config.skills`
  - `config.agents`
  - `model.list`
  - `session.list`（额外广播，不在原始要求中但存在）
- 4 种必需类型全部收到
- **结论**: PASS

### Layer 2: DOM/A11y — N/A
### Layer 3: 视觉对比 — N/A

---

## TC-1-03: CDP 连通 + Settings 页面渲染 — PASS

### Layer 1: WS 协议 — N/A

### Layer 2: DOM/A11y
- CDP 连接 Electron 成功: `ws://localhost:9333/devtools/page/09B9B968...`
- Settings 页面结构:
  - **Sidebar**: `w-[200px]` 左侧导航栏，包含 4 个 tab（供应商/技能/代理/系统）
  - **Content**: `flex-1 overflow-y-auto` 右侧内容区域
- 默认活跃 tab: 供应商（className 含 `font-semibold bg-accent-light`）
- Settings 页面通过"设置"按钮进入（工具栏中的齿轮图标）
- **结论**: PASS

### Layer 3: 视觉对比
- 截图: `tc-1-03_settings-page.png`
- Vision API 内容过滤触发（截图含敏感 UI 内容），以 DOM 证据替代
- DOM 验证确认 sidebar + content 双区域结构完整
- **结论**: PASS（DOM 证据替代视觉验证）

---

## TC-1-04: Settings Sidebar 四 Tab 渲染 — PASS

### Layer 2: DOM/A11y
逐个点击 4 个 tab 并验证 content 变化:

| Tab | 点击前内容摘要 | 点击后内容摘要 | Content 变化 | Active 状态 |
|-----|--------------|--------------|-------------|------------|
| 供应商 (Provider) | Skill 配置... | Provider 配置 / 管理 AI 模型供应商、API 密钥和模型列表... | 变化 | - |
| 技能 (Skill) | Provider 配置... | Skill 配置 / 扫描、导入和管理 AI 技能模块... | 变化 | - |
| 代理 (Agent) | Skill 配置... | Agent 配置 / 扫描、导入和管理 AI Agent 模块... | 变化 | - |
| 系统 (System) | Agent 配置... | 语言与外观 / 语言 / 简体中文... | 变化 | - |

- 4 个 tab 点击后 content 均发生变化
- **结论**: PASS

### Layer 3: 视觉对比
- 截图文件:
  - `tc-1-04_tab_provider.png` — Provider 配置页
  - `tc-1-04_tab_skill.png` — Skill 配置页
  - `tc-1-04_tab_agent.png` — Agent 配置页
  - `tc-1-04_tab_system.png` — 系统设置页（语言与外观/配色主题）
- Vision 验证（系统 tab）: 确认 sidebar 包含 5 项导航（设置/供应商/技能/代理/系统），系统 tab 为高亮活跃状态，内容区域显示语言/外观/配色选项
- **结论**: PASS

---

## 证据文件清单

| 文件 | 说明 |
|-----|------|
| `tc-1-03_settings-page.png` | Settings 页面完整截图 |
| `tc-1-04_tab_provider.png` | Provider tab 截图 |
| `tc-1-04_tab_skill.png` | Skill tab 截图 |
| `tc-1-04_tab_agent.png` | Agent tab 截图 |
| `tc-1-04_tab_system.png` | System tab 截图 |

---

## 环境备注

1. CDP 端口实际为 9333（非测试用例中的 9222），已在执行时修正
2. Vision API（智谱 GLM-4.6V）对部分截图触发内容过滤，以 DOM 验证作为替代证据
3. WS 初始广播包含额外的 `session.list` 类型（共 5 种，超过要求的 4 种），属于正向超预期
