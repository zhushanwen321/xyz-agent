# Code Review：respect-extension-display-field

commit: 12efd980（11 文件）

## 审查方法
禁读重建 + 逐文件核查（reviewer subagent）。覆盖 commit 改动文件 + 关键依赖链（event-adapter / pi-protocol / chat store / subagent store）。

## 逐 FR 核查
- FR-1 ✓ shared.Message 加 display?: boolean（message.ts:228-234）
- FR-2 ✓ customStart effect 读 payload.display，显式布尔窄化（chat-message-effects.ts:419-422）
- FR-3 ✓ message-converter custom 分支透传 cm.display（:175-186）
- FR-4 ✓ session-history custom_message 透传 e.display（:48-57）
- FR-5 ✓ filterDisplayableMessages 改 m.display !== false（messageTurns.ts:54）
- FR-6 ✓ HIDDEN_CUSTOM_TYPES 定义 + 导出 + import 全删（全仓库 grep 仅剩测试文件 1 行 HISTORICAL 注释）
- FR-7 ✓ 过滤只在渲染层（MessageStream computed），AC-3 双层断言验证 store 保留
- FR-8 ✓ 零误伤：display:true 保留 + 无 customType 的 compactionSummary 保留，测试覆盖

## AC 覆盖
- AC-1/2/3/6 ✓ 单测覆盖（message-converter.test.ts + message-turns.test.ts）
- AC-4 代码就绪（converter + session-history 双透传），待重启 dev app 后 manual 验证
- AC-5 ✓ 全仓库 grep HIDDEN_CUSTOM_TYPES 仅剩测试文件 HISTORICAL 注释（文档性，非引用）

## Issues

### Issue 1 — minor / completeness（已修复）
ADR 背景表格「现状」表头语义模糊（行号是修复前）。已改为「修复前缺口」表头 + 行号标注"修复前"。

### Issue 2 — minor / design-consistency（超 scope，记录备查）
PiMessageStartEvent.message 类型（pi-protocol.ts:169-178）不含 display 字段，event-adapter.ts:454 用 Record cast 绕过类型读取。运行时无 bug（cast 兜底），但类型契约有缺口。本次未引入（cast 早已存在），建议后续在 ADR-0033 范围统一收口 custom message 协议类型。

### Issue 3 — trivial / regression（信息性，非问题）
session-history.ts:55 用 `as boolean | undefined` 断言（信任 JSONL），对比实时路径 customStart 的显式布尔窄化（=== true || === false）。pi 协议保证 boolean，极端篡改场景外无差异。三路径一致性上，converter 也是直接信任 cm.display。若统一防御应三路径都加窄化，超 scope。

## verdict：pass
FR-1~FR-8 全部正确实现，测试覆盖充分（renderer 1642 + runtime 1501 全绿，vue-tsc EXIT 0）。无 critical/major。3 个 issue 均为 minor/trivial，Issue 1 已修，Issue 2/3 记录备查不阻塞。
