---
verdict: pass
---

# E2E Test Plan — Markdown 渲染增强

## Test Scenarios

### TS1: 代码块语法高亮
覆盖 AC1。发送包含 Python/TypeScript/Bash/JSON/未知语言代码块的 AI 回复，验证高亮正确。

### TS2: 代码块 UI 功能
覆盖 AC2。验证语言标签、复制按钮、行号、文件名标签、折叠/展开功能。

### TS3: GitHub 排版样式
覆盖 AC3。发送包含标题、列表、引用块、表格、删除线的消息，验证视觉样式。

### TS4: 任务列表
覆盖 AC4。发送 `- [x] done` 和 `- [ ] todo` 内容，验证 checkbox 渲染。

### TS5: KaTeX 数学公式
覆盖 AC5。发送行内 `$...$` 和块级 `$$...$$` 公式，验证渲染。发送无效公式验证 fallback。

### TS6: Mermaid 图表
覆盖 AC6。发送 flowchart 和 sequence diagram，验证 SVG 渲染。发送无效语法验证 fallback。

### TS7: 流式渲染
覆盖 AC7。在 AI 流式输出过程中观察：代码块为纯文本、无 KaTeX/Mermaid 渲染。输出完成后切换到高亮渲染。

### TS8: 主题切换
覆盖 AC8。在亮/暗主题间切换，验证代码块高亮颜色、排版元素颜色正确跟随。

### TS9: 性能
覆盖 AC9。发送长消息（~5000 字符含 3 个代码块），验证完成渲染 < 100ms。验证流式阶段无卡顿。验证 100 条历史消息滚动流畅。

## Test Environment

| 项目 | 配置 |
|------|------|
| 运行方式 | `npm run dev` 启动 Electron 开发模式 |
| 数据来源 | 真实 AI 对话（通过 sidecar 连接 pi）或 Mock 模式 |
| Mock 方式 | 使用 `VITE_MOCK=true` 环境变量，在 ws-client 层拦截，注入预设 markdown 内容 |
| 主题测试 | 通过 Settings 视图切换亮/暗主题 |
| 浏览器 DevTools | 用于性能分析（Performance tab 记录渲染耗时） |
