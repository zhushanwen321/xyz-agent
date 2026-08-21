# W2 验收基线：值域/文案与 pi 0.84.1 对齐（SSOT 派生）

> 防篡改：本文件是 W2 验收 SSOT，builder/verifier 禁改。设计依据 = `docs/architecture/pi-assumption-remediation.md` §3.2；证据 = 审计 A-03/C#1（thinking max）、A-09/C#2（KnownApi）、C#7（system prompt）、A-07/C#4（包名）、A-06/A-08/A-12（注释）。

## pi 语义锚点（已核实）

- thinking 值域 0.84.1 = `["off","minimal","low","medium","high","xhigh","max"]`（`node_modules/@earendil-works/pi-coding-agent/dist/cli/args.js:6`）；xyz 协议文件 `packages/runtime/src/infra/pi/pi-protocol.ts:403` 的 `PiThinkingLevel` 已是全集。
- pi-ai 0.82.1 `KnownApi` 10 值（`node_modules/@pi-ai/*/dist/types.d.ts` KnownApi 定义——builder 现场核实精确路径与全集）。
- system prompt 0.84.1 新增 environment variables 文档路由行（`dist/core/system-prompt.js:81`）。

## 交付物

1. **thinking SSOT 派生**：shared `ThinkingLevel`（pi-preset.ts:27）改为从 `PiThinkingLevel` 全集派生/约束（`satisfies`/类型级，不允许再手写值域漂移）；runtime `VALID_THINKING_LEVELS`（session-lifecycle.ts:123）从全集派生（import 派生值，删手写数组）；确认 composer 档位表（thinking-levels.ts）与全集兼容（含 max）。
2. **KNOWN_PI_API_TYPES**：shared/constants.ts:53-57 对齐 pi-ai KnownApi 10 值全集（注释附锚点 + 同步维护注「升级 pi-ai 时 diff 此处」）。
3. **DEFAULT_PI_SYSTEM_PROMPT**：重提取 0.84.1（保留版本标注头 + diff 维护注格式）；diff 仅含 environment variables 行（若有其他差异如实带上）。
4. **包名文案**：process-manager.ts:228 恢复指引改 `@earendil-works/pi-coding-agent`。
5. **注释修正**：A-06（session-lifecycle strip 函数 `\n` 注释改为「pi 读取 trim 分行（session-manager.js parseSessionEntryLine），补 \n 为保守对齐」）、A-08（event-adapter user message_start 时序注释更新为 0.84.1 实态——**注意 event-adapter 是 W3 领地，本条只在 W3 完成后由主 agent 或 W3 一并处理，W2 不碰 event-adapter**；改为登记到交付报告移交 W3）、A-12（漂移行号锚点更新——限 shared 与 session-lifecycle 内的）。
6. 测试：thinking max 通过校验的用例（spawn 参数带 max 或校验函数返回 true）；KnownApi 全集用例。

## 验收条款

| # | 条款 | 证伪点 |
|---|------|--------|
| C1 | 三处 thinking 值域（shared 类型/runtime 白名单/composer 档位）单一 SSOT 派生，`max` 全通 | 源码 + 类型检查 |
| C2 | KNOWN_PI_API_TYPES = pi-ai KnownApi 全集（逐值对照） | 源码 + 注释锚点 |
| C3 | system prompt 与 dist 一致（diff 可复现） | diff 对照 |
| C4 | `cd packages/runtime && pnpm typecheck && pnpm exec vitest run` + `cd packages/core && pnpm test`（若 core 涉 ThinkingLevel）全绿 | 命令 |
| C5 | R1 exit 0 + `pnpm run lint` 零 error | 命令 |

## 边界

- 只许改：`packages/shared/src/`（pi-prompt/constants/pi-default-prompt 相关）、`packages/runtime/src/services/session/session-lifecycle.ts`（仅值域行与注释）、`packages/runtime/src/infra/pi/process-manager.ts`（仅 :228 文案行）、对应测试。
- **禁碰**：`event-adapter.ts` / `pi-protocol.ts`（W3 领地，A-08 移交 W3）、extensions/（W4）、core 的 apply-entry（W5）、pi-provider 域（W1b 已收）。
- 禁 git 写。
