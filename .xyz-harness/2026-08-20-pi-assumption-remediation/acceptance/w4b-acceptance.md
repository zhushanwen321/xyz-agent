# W4b 验收基线：textResult 间接 isError 收敛 + execute-agent-call stale 对齐

> 防篡改：W4 verifier 报告判定的 23 处（tool-workflow.ts 9 + tool-workflow-script.ts 14，真实可达 15 + 防御性 8，零合法非错误用途）为证据 SSOT。

## 交付物
1. `extensions/subagent-workflow/src/interface/tool-workflow.ts` + `tool-workflow-script.ts`：23 处 `textResult(..., true)` 全部改 throw（文案逐字保留）；**textResult helper 的 isError 参数删除**（签名收缩，编译器兜底防回潮）。
2. `extensions/subagent-workflow/src/orchestration/execute-agent-call.ts:49` STALE_CONTEXT_PATTERNS 对齐真实文案（含 scheduler 已验证的 `'stale after session replacement'` marker；"ctx is stale" 词序修正）——该处有生产调用方（:171 子进程重试分诊），修复后 stale 场景正确分诊。
3. 测试：23 处对应路径的 throw 语义用例（抽 5 个代表路径：not_found/reentry-busy/平铺检测/slug 护栏/generate 校验族各一）；stale 分诊用例（真实文案串触发 isStale 判定）。

## 验收条款
- C1：grep `textResult(` 无第二参 true 形态残留 + helper 签名无 isError 参数
- C2：stale patterns 与真实文案匹配（真实文案串测试）
- C3：`pnpm extensions:typecheck && pnpm extensions:lint && pnpm extensions:test` 全绿
- C4：本地 pi CLI 实测一条 textResult 路径（如 workflow not_found）isError=true

## 边界
只许改 subagent-workflow 的 interface/tool-workflow*.ts、orchestration/execute-agent-call.ts + 测试。禁 git 写。
