# Retrospect: Extension GUI 渲染协议 P0+P1

> **Topic**: cw-2026-07-11-extension-gui-protocol
> **Date**: 2026-07-11
> **Scope**: P0+P1（协议骨架打通），xyz-agent 侧，不含 extension 迁移

---

## 1. 完成了什么

5 个 Wave，6 个 commit，6 个 testCase 全绿：

| Wave | 内容 | Commit |
|------|------|--------|
| W1 | shared 类型补全（WIDGET_GUI / Message.details / ToolCall.outputRaw）| c2e3d006 |
| W2 | @xyz-agent/extension-protocol 协议包（类型 + helper + 15 测试）| 45b1ed01 |
| W3 | runtime F1/S5/marker/outputRaw 修复（3 处 event-adapter + 1 处 message-converter + 类型）| 952cc4dc |
| W4 | AnsiText.vue + Block.vue ANSI 兜底渲染 | c8243aa7 |
| W5 | ExtensionUIDialog + useExtensionUI + ui_response 回传 | 4aa8bf8c |

测试统计：runtime 1170（含 10 新增）+ extension-protocol 15 + renderer 6 新增，无回归。

## 2. 协议设计验证结论

文档假设经两路 subagent 验证全部成立（14 个假设 × 一致/部分一致）：

- **F1 前提验证**：pi JSONL 确实持久化了 details（ToolResultMessage.details 有类型声明 + 实际数据），get_messages 原样返回。修 message-converter 即有效，不需换方案。
- **details 透传链路**：pi agent-session 零过滤 → RPC JSON.stringify 零裁剪 → event-adapter details 原样透传 → 前端消费。整条链路验证通过。
- **NUL marker 安全性**：pi RPC setWidget 零预处理 + JSON.stringify 原样输出 + NUL 在 JSON 合法转义。
- **shim 不需要**：helper 直编码方案（guiSetWidget 内部调原生 setWidget）走通整条链路，无 monkey-patch。

## 3. 实现中的偏差与修正

| 计划 | 实际 | 原因 |
|------|------|------|
| W3 无 tsup.config.ts 改动 | 额外改了 tsup.config.ts（加 noExternal）| 规则 #12：新增 npm 依赖必须加 noExternal。pre-commit hook 拦截发现 |
| event-adapter-new-events.test.ts FR-4 不改 | 更新了 FR-4 断言 | S5 改变了 detail 行为（提取 details 而非整体对象），旧断言不再成立。修正后增加了一个 fallback 路径测试 |
| ExtensionUIDialog 用原生 textarea | 改用 Textarea 组件 | 规则：禁止原生 HTML 表单元素 |
| AnsiText v-html 报 XSS lint | 加 eslint-disable-next-line + 安全理由注释 | ansi_up 默认 escape_html=true，与 MermaidRenderer/MarkdownRenderer 同论证。项目既定约定 |

## 4. 遗留问题（P2+ 范围）

| 问题 | 严重度 | 说明 |
|------|--------|------|
| GuiComponentRenderer + 12 个前端组件未实现 | P2 | 当前只有 AnsiText（兜底），结构化组件（TaskList/Card/StatsLine 等）是 P2 范围 |
| widgetGui 路由未接入前端 | P2 | event-adapter 已发 extension:widgetGui WS 帧，但 SideDrawer 尚未订阅和渲染 |
| useExtensionStatus composable 未提取 | P2 | status 仍绑死 SideDrawer footer |
| guiInteract 未端到端验证 | P3 | ExtensionUIDialog 已就绪，但需真实 extension（ask-user）调用才验证 |
| custom 组件编译期注册机制 | P2 | GuiComponentRenderer 未创建，custom 注册表未实现 |
| WS payload 体积防御 | P2 | 协议层未约定体积上限 + widget 更新未节流 |
| multiSelect 降级体验差 | P3 | guiInteract RPC 分支多选走逐选项 confirm |

## 5. 对协议文档的反哺

实现过程中发现的与文档的差异，已在代码注释中标注：
- `extension:widgetGui` 的 `gui` 字段在 ServerMessageMap 中用 `unknown`（非 GuiComponent）——shared 包不能依赖 extension-protocol（避免循环依赖），前端用 extractGui() 做类型守卫
- `outputRaw` 的产出逻辑：handleToolExecutionEnd 只在有 ANSI 时设置（`output !== rawText` 判定），无 ANSI 时 outputRaw 为 undefined，前端回退纯文本 output

## 6. 下一步建议

1. **P2 前端渲染器**：GuiComponentRenderer + 5 个基础组件（TaskList/Card/StatsLine/GoalStatus/ProgressBar）+ widgetGui 路由
2. **迁移 pi-todo 验证协议**：端到端最小验证（extension 构造 __gui__ → 前端渲染 task-list）
3. **发布 @xyz-agent/extension-protocol 到 npm**：当前是 workspace:* 引用，extension repo 需从 npm 安装
