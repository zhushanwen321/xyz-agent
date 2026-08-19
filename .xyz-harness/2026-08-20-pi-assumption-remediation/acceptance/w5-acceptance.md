# W5 验收基线：core images 双修 + R1 createWriteStream 缺口

## 交付物
1. `packages/core/src/domain/chat/apply-entry.ts` normalizePiToolResult（:160-182）：补 images 提取，行为对齐 runtime 版 `packages/runtime/src/infra/pi/normalize-tool-result.ts`（toolResult content 的 ImageContent part → images 字段）；文件头分叉注释登记「images 差异已消除」。
2. 同文件 convertMessageBody（:270-299）：补 user 消息 image content part 处理（转出不丢——渲染层若无消费则保字段，数据不丢优先）。
3. `.githooks/check_pi_direct_write.py`：WRITE_CALL_PATTERNS 补 `createWriteStream`（写目标判定复用现有条件 A/B 框架；logger.ts 等合法用例靠 NON_SESSIONS_DERIVATIONS 豁免——验证 logger 路径不误报）；脚本自测（若 node --test 形态）补用例。
4. C#8 版本标签顺手更新：`extensions/subagent-workflow/src/execution/types.ts:418-424` 锚点标签 0.84.0 → 0.84.2（行为锚点已验证成立）。

## 验收条款
- C1：构造含 images 的 toolResult entry → core reducer 路径产出含 images（live≡replay 恢复）
- C2：R1 对 `createWriteStream(<sessions 路径>)` 形态报错、对 `createWriteStream(getLogsDir()...)` 豁免（脚本自测或探针）
- C3：`cd packages/core && pnpm test` + `cd packages/runtime && pnpm typecheck` 全绿 + R1 exit 0
- C4：`pnpm extensions:test`（types.ts 标签改动包）全绿

## 边界
只许改 core/src/domain/chat/apply-entry.ts + core 测试、.githooks/check_pi_direct_write.py + 其自测、extensions/subagent-workflow/src/execution/types.ts（仅注释标签行）。禁 git 写。
