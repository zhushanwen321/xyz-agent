# W4 验收基线：extensions isError throw 范式（9 处 5 包）+ goal stale + 注释批

> 防篡改：本文件是 W4 验收 SSOT，builder/verifier 禁改。设计依据 = `docs/architecture/pi-assumption-remediation.md` §3.4；证据 = 审计 B-F2 / B-F6 / B 报告碰巧无害 6 条。

## pi 语义锚点（已核实）

- pi-agent-core `agent-loop.js:453-483/525-547`（0.84.2 实装）：工具 execute 正常 return 恒 `isError:false`，返回值里的 isError 字段被丢弃；**throw 才置错**（ToolResultMessage is_error / tool_execution_end 事件 / provider 侧）——pi 自带 bash.js:345-347 即 throw 范式。
- goal 真实 stale 文案 "This extension ctx is stale after session replacement..."；scheduler 用 `'stale after session replacement'` marker 可匹配（已验证）。

## 交付物

1. **9 处 return {isError:true} 改 throw**（错误信息保持原文案；逐处确认 throw 前的扩展内部收尾——原 return 路径的清理逻辑不能丢）：
   - `extensions/session-reader/src/index.ts:170-177`
   - `extensions/ask-user/src/index.ts:271,281,315`
   - `extensions/scheduler/src/index.ts:137,163` + `src/tool.ts:100`
   - `extensions/subagent-workflow/src/interface/tool-workflow.ts:442,501` + `tool-workflow-script.ts:402,432`
2. **goal stale 对齐**：STALE_CONTEXT_PATTERNS 对齐真实文案（复用 scheduler 已验证 marker 或完整文案），`isStaleContextError` 无生产调用方——调查后接线（若 goal 内确有捕获场景）或删除（禁留死函数），报告写明处置。
3. **6 条注释失实修正**（B 报告碰巧无害类）：permission index.ts:230 theme 注释、unified-hooks tool-error-handler.ts:36 ctx.ui、pending-notifications index.ts:76-84 EventBus 单例注释、session-reader parser.ts:64 data.id 死分支（删除）、ask-user channel-handler.ts:125 cancelled TypeError（json/print 路径加守卫或注释声明依赖 dialog-queue 兜底）、session-pending.ts:21 steer 注释。
4. **本地 pi CLI 实测**（仓库铁律）：构造一个错误路径（如 session-reader 读不存在文件）→ 真实 pi 跑一轮 → 证实 tool_execution_end / toolResult 带 isError=true（修复前为 false）。实测记录进报告。
5. 测试：各包既有 isError 断言按新行为更新（工具错误 → throw 语义）+ 关键处新增用例。

## 验收条款

| # | 条款 | 证伪点 |
|---|------|--------|
| C1 | 9 处全部改为 throw（grep `isError: true` 在 5 包 execute 路径零残留——非 execute 路径的合法 isError 返回不算，逐处指认） | grep + 源码 |
| C2 | goal patterns 与真实文案匹配（用真实文案串测）+ isStaleContextError 接线或删除 | 测试 |
| C3 | 本地 pi CLI 实测：错误路径 tool_execution_end isError=true | 实测记录 |
| C4 | `pnpm extensions:typecheck && pnpm extensions:lint && pnpm extensions:test` 全绿 | 命令 |

## 边界

- 只许改：`extensions/session-reader|ask-user|scheduler|subagent-workflow|goal|permission|unified-hooks|pending-notifications/` 的 src + 测试。
- **禁碰 model-switch**（W1a 已收）；**禁碰 ask-user 的 select 渲染适配**（W3 领地，若同文件冲突以函数为界：W4 只动 execute/channel 路径，W3 只动 select 渲染）。
- 禁 git 写；实测隔离（/tmp），用后清理。
