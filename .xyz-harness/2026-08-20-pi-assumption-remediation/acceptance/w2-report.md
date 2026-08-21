# W2 验收报告：值域/文案与 pi 0.84.1 对齐（SSOT 派生）

> Verifier 对抗式独立验收（2026-08-20）。基线 = `w2-acceptance.md`（对 d48793a39 diff 为空，防篡改通过）。
> builder 自报一律待证实，以下全部为 verifier 独立复跑/攻击测试结果。

## 总结论：PASS（附 3 项如实报告事项，均不构成 W2 阻断）

| 验收条款 | 结论 | 关键证据 |
|---|---|---|
| C1 thinking 三处 SSOT 派生，max 全通 | PASS | 逐值对照 + 双向断言攻击 A/B 均触发编译错 |
| C2 KNOWN_PI_API_TYPES = pi-ai KnownApi 全集 | PASS | 两处 pi-ai 锚点现场核实逐值一致 |
| C3 system prompt 与 dist 一致 | PASS | 独立探针真函数全文对照 32/32 行一致 |
| C4 typecheck + vitest + shared/core test | PASS* | 全绿（*全量复跑存在环境性 flaky，见 §4） |
| C5 R1 exit 0 + lint 零 error | PASS* | R1 exit 0；W2 领地 0 error（*全仓唯一 error 在认知外 chat-app） |

## 1. 防篡改与越界判定

- `git diff d48793a39 -- .xyz-harness/2026-08-20-pi-assumption-remediation/acceptance/w2-acceptance.md` = 空。PASS。
- git status 全量判定（-uall）：
  - **W2 自报 12 文件全部命中**，diff 内容逐一审阅均在边界内（见 §5）。
  - 豁免确认：`extensions/` 22 文件（W4）、`event-adapter.ts` + `pi-protocol.ts`（W3）、`chat-app/` 13 文件（认知外）。
  - **越界候选 1 项**：`packages/runtime/src/__tests__/equivalence/tool-call-index.test.ts`（untracked，不在 W2 自报、不在任务豁免清单）。文件头自称「W3 等价锁定：tool-call-index 真实产出（审计 A-01）」，内容属 W3 波 builder 产物，**非 W2 越界**。单独复跑 7/7 绿。建议主 agent 将其纳入 W3 验收范围核对 W3 自报清单。
- verifier 攻击测试的临时改动已全部还原（还原后 runtime typecheck exit 0 + thinking 测试 11/11 绿复核）。

## 2. C1 SSOT 派生真实性（核心攻击面）

- **pi 实装值域**：`node_modules/@earendil-works/pi-coding-agent/dist/cli/args.js:6` = `["off","minimal","low","medium","high","xhigh","max"]`（verifier 现场读）。
- **shared**：`pi-preset.ts:33` `PI_THINKING_LEVELS` 7 值逐值一致；`ThinkingLevel = (typeof PI_THINKING_LEVELS)[number]` 类型派生，无手写联合残留。
- **runtime**：`session-lifecycle.ts:133` `VALID_THINKING_LEVELS: readonly PiThinkingLevel[] & AssertSharedCoversPi = PI_THINKING_LEVELS` 确为 import 派生。grep 全仓无生产代码手写七值数组残留（仅测试文件字面量断言 + W3 领地 `pi-protocol.ts:424` 的 `PiThinkingLevel` 类型联合——后者是基线认可的协议镜像）。
- **双向编译期断言攻击**（临时改 → 验证 → 还原）：
  - 攻击 A（删 shared 'max'）：runtime typecheck 红，`session-lifecycle.ts(133,7): error TS2322: ... not assignable to type 'never'`（AssertSharedCoversPi 方向真实咬合）。
  - 攻击 B（shared 加 pi 外值 'ultra'）：typecheck exit 2，`error TS2322: ... not assignable to type 'readonly PiThinkingLevel[]'`（反向咬合）。
- **composer 档位表**：`packages/core/src/domain/composer/thinking-levels.ts:16,28-35` 6 档（off/low/medium/high/xhigh/max）含 max 且 ⊆ pi 7 值全集（minimal 为 pi 侧档位，UI 不展示，属设计内）。renderer `panel/thinking-levels.ts` 为 core 的 re-export shim。

## 3. C2 KnownApi / C3 system prompt

- **KnownApi**：现场核实两处锚点逐值一致（嵌套 pi-ai 0.84.2 `pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/types.d.ts:15` 与根 pi-ai 0.82.1 `node_modules/@earendil-works/pi-ai/dist/types.d.ts:14`，两者同集 10 值）。`constants.ts` KNOWN_PI_API_TYPES 10 值与之完全一致（顺序亦与定义一致）。测试 `constants.test.ts` 用独立字面量数组做逐值对照 + 历史 3 值不丢 + ollama 不误收，非自证。
- **影响面（如实）**：KNOWN_PI_API_TYPES 唯一消费方 = runtime `pi-config-store.ts:108` warn 校验（8 种合法 api type 不再误报 warn）。前端不消费该常量（renderer 无引用），`PROVIDER_API_TYPES`（前端可选 2 值）未动——**前端 Select 不会因此自动扩**。
- **system prompt 独立对照**：verifier 探针（/tmp）用 pi dist 真函数 `createAllToolDefinitions` + `buildSystemPrompt` 构建默认段，与 shared `DEFAULT_PI_SYSTEM_PROMPT` 全文对照：**32/32 行逐行一致**，唯一差异为 pi 末尾无条件追加的 `Current working directory: /tmp` 动态行（shared 头注释已声明不含动态段，`pi-default-prompt.test.ts` 也有 `not.toContain('Current working directory:')` 守护）。environment variables 路由行、7 工具段、guidelines 段均含在全文一致内。
- 新建测试 `pi-default-prompt.test.ts` 5 用例：版本 0.84.1 + 三处 diff 不回退 + 占位符语义，合理。

## 4. C4/C5 命令实跑

| 命令 | 结果 |
|---|---|
| `cd packages/runtime && pnpm typecheck` | exit 0（两次全量 + 攻击后复核共 4 次） |
| `cd packages/runtime && pnpm exec vitest run` | 第 1 次 3221/3222（attach-lifecycle fork 路径 121s 超时）；第 2 次 3218/3222（attach-lifecycle 超时 + tool-call-index 3 用例）。**失败文件单独复跑全绿**（attach-lifecycle 4/4 @21.8s、tool-call-index 7/7 @5.2s）→ 全量并发下「真实 pi 子进程」equivalence 测试资源竞争超时，环境性非确定失败，与 W2 改动（shared 常量/值域行/文案行/mock 工厂）无因果路径 |
| W2 领地定向：session-lifecycle-thinking + skill-paths | 22/22 绿 |
| `cd packages/shared && pnpm test` | 172/172 绿 |
| `cd packages/core && pnpm test`（C4 附带，composer 档位表所在包） | 1024 passed + 6 todo，全绿 |
| R1 `python3 .githooks/check_pi_direct_write.py` | exit 0（扫描 240 文件，命中 0） |
| 定向 lint（W2 领地 12 文件） | 0 error；仅 constants.ts 3 个存量 unused eslint-disable warning（191/200/210 行——不在 W2 diff 区段 51-70 内，认知外存量） |
| 全仓 `pnpm run lint` | exit 1：**唯一 error 在认知外 `chat-app/src/components/ChatHistory.tsx:2`（no-unused-vars）**，W2 责任范围内零 error |

## 5. 边界 diff 审阅（W2 自报 12 文件）

- `process-manager.ts`：仅 :228 一行（`@mariozechner/pi-coding-agent` → `@earendil-works/pi-coding-agent`），全文件无 @mariozechner 残留。C4 包名 PASS。
- `session-lifecycle.ts`：import 两行 + A-06 strip 注释（与 pi `session-manager.js:91` `parseSessionEntries` 的 `content.trim().split("\n")` 实态吻合——注释本身经核实为真）+ 值域块 SSOT 化 + 校验处 widening cast（includes 类型收窄的配套，与 shared isPiLaunchPreset 同款惯例）。均在「值域行与注释」范围。
- `skill-paths.test.ts`：仅 mock 工厂补 `PI_THINKING_LEVELS` 一项。
- `constants.ts`/`pi-preset.ts`/`protocol.ts`/`index.ts`：分别为 KnownApi 10 值 + 锚点注释、SSOT 常量 + 派生类型 + 锚点注释、thinkingOverride 注释行、export PI_THINKING_LEVELS（runtime import 需要）。均在范围。
- A-12 锚点更新全部真实：args.ts:57→args.js:6、tools/index.ts:83-84→dist/core/tools/index.js:81-89（7 工具值集核实一致）、system-prompt.js:71-87。
- A-08：W2 未碰 event-adapter ✓；W3 已在其 `event-adapter.ts:559-562` 落 0.84.1 实态注释（本验收顺带确认移交闭环）。

## 6. 红性测试

`VALID_THINKING_LEVELS` 临时回退为缺 'max' 手写数组 → **typecheck 仍绿**（子集赋值类型合法——证明编译期断言抓不住运行时数组回退，测试不可替代）→ `session-lifecycle-thinking.test.ts` **4 用例红**（spawn 参数带 max / 全集透传 / preset max / override 优先级，exit 1）→ 还原后 11/11 绿。测试守护真实有效。

## 7. 如实报告事项（非阻断）

1. **全量 vitest 并发 flaky**：真实 pi 子进程类测试（attach-lifecycle、tool-call-index）在全量并发下偶发资源超时，本机两次复跑均未完整复现 builder 的「3222 全绿」；单独复跑全绿 + W2 领地全绿。建议 final gate 关注该类测试的并发稳定性（与 W2 无关）。
2. **全仓 lint 1 error**：位于认知外 `chat-app/`（豁免领地），建议认知外产物的 owner 处理；W2 领地 0 error。
3. **tool-call-index.test.ts 归属**：untracked、不在 W2 自报与任务豁免清单，内容属 W3（审计 A-01）且测试可绿，建议主 agent 核对 W3 自报清单后归档归属。
