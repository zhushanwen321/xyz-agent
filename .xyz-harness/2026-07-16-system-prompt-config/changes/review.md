# Review — system-prompt-config (W1-W9)

日期：2026-07-17 · 审查方法：6 维度（design-consistency 用禁读重建法）· 只读审查

## 1. 审查范围

### 1.1 实现文件清单（9 commit 增量）

| Wave | 文件 | 类型 |
|------|------|------|
| W1 | `xyz-system-prompt-extension.js`（plugin，repo root） | 新增 |
| W1 | `tools/verify-system-prompt-hook.cjs` | 新增 |
| W2 | `packages/shared/src/constants.ts`（`SYSTEM_PROMPT_MAX_LENGTH`） | 增量 |
| W2 | `packages/shared/src/protocol.ts`（3 ClientMessageType + 2 ServerMessageType + `SystemPromptConfig`/`SystemPromptSnapshot` + `ReplyPayloadMap`） | 增量 |
| W2 | `packages/shared/src/index.ts`（barrel 导出） | 增量 |
| W3 | `packages/runtime/src/services/config-service.ts`（4 新方法 + `mergeSystemPromptConfig`） | 增量 |
| W3 | `packages/runtime/src/transport/settings-message-handler.ts`（3 新 case） | 增量 |
| W3 | `packages/runtime/src/interfaces.ts`（`IConfigService` 4 新签名） | 增量 |
| W4 | `packages/runtime/src/utils/runtime-env.ts`（`getExtensionFilePath` 泛化 fileName 参数） | 增量 |
| W4 | `packages/runtime/src/services/extension-service.ts`（`systemPromptExtensionFilePath` + 追加顺序） | 增量 |
| W5 | `packages/runtime/src/infra/pi/rpc-client.ts`（`RpcClientOptions.systemPrompt` + `--system-prompt` 拼入） | 增量 |
| W5 | `packages/runtime/src/services/session/session-internal.ts`（`getReplaceSystemPrompt` 内部契约） | 增量 |
| W5 | `packages/runtime/src/services/session/session-service.ts`（`setConfigService` 注入 + `getReplaceSystemPrompt` 委托） | 增量 |
| W5 | `packages/runtime/src/services/session/session-lifecycle.ts`（create/restore/fork 三处 spawn 透传） | 增量 |
| W5 | `packages/runtime/src/index.ts`（`sessionService.setConfigService` 接线） | 增量 |
| W6 | `packages/renderer/src/api/domains/config.ts`（3 请求 + 1 订阅） | 增量 |
| W6 | `packages/renderer/src/api/mock/index.ts`（mock 同构） | 增量 |
| W6 | `packages/renderer/src/stores/settings.ts`（`systemPromptConfig` state） | 增量 |
| W6 | `packages/renderer/src/composables/features/useSettings.ts`（`onSystemPrompt` 常驻订阅） | 增量 |
| W6 | `packages/renderer/src/stores/chat-message-effects.ts`（payload cast 修复） | 连带增量 |
| W7 | `packages/renderer/src/components/settings/SystemPromptPage.vue`（新页面） | 新增 |
| W7 | `packages/renderer/src/components/settings/SettingsModal.vue`（菜单项 + 路由） | 增量 |
| W7 | `packages/renderer/src/i18n/locales/{zh-CN,en-US}/settings.ts`（文案） | 增量 |
| W8 | `apps/electron/electron-builder.yml`（extraResources） | 增量 |
| W8 | `scripts/postbuild-validate.sh`（产物校验） | 增量 |
| W9 | `docs/testing/10-settings-system-prompt.md` + `AGENTS.md` rule #11 | 新增/增量 |

### 1.2 测试文件清单

- `packages/runtime/test/system-prompt-extension.test.ts`（9 cases）
- `packages/runtime/test/system-prompt-config.test.ts`（10 cases）
- `packages/runtime/test/rpc-client-system-prompt.test.ts`（3 cases）
- `packages/runtime/test/extension-service-system-prompt.test.ts`（2 cases）
- `packages/runtime/test/settings-message-handler-system-prompt.test.ts`（5 cases）
- `packages/renderer/src/__tests__/settings/system-prompt-page.test.ts`（6 cases）

**测试运行结果**：runtime 29 + renderer 6 = 35 cases 全绿（已实跑验证）。

---

## 2. 六维度审查结论

### 2.1 type-safety — 良好（1 minor）

- 协议 SSOT 落实到位：`SystemPromptConfig`/`SystemPromptSnapshot` 定义在 `shared/protocol.ts`，runtime（`config-service`/`interfaces`/`handler`）与 renderer（`api/domains/config`/`stores`）全部 `import type` 引用，无重复定义。
- `SYSTEM_PROMPT_MAX_LENGTH` 在 `shared/constants.ts` 作 SSOT，runtime（校验 + 错误文案）与 renderer（UI 计数）共用同一常量（PR2 已采纳）。
- 前后端 reply 形状一致：handler reply `{ config, corrupted? }`，renderer `getSystemPrompt` 解包 `reply.corrupted ?? false`，对齐。
- **问题 RV3**（minor）：`PiSessionOptions`（`services/ports/pi-engine.ts:72-80`）缺 `systemPrompt?: string` 字段，但 `session-lifecycle.ts` 三处 `pm.createSession(...)` 传入 `systemPrompt` 字面量。类型不报错是 TS excess-property check 在此处的 quirk（具体复现见 issues 描述）；正确做法是补上字段声明，否则契约 port 与实现漂移。

### 2.2 error-handling — 优秀

- 插件 fail-safe 完整：`xyz-system-prompt-extension.js` 顶层 `try/catch` 吞所有异常返回 `undefined`（不阻断 agent loop），`readConfig` 文件缺失/损坏/字段类型错三级兜底，`writeSnapshot` 读旧失败也 fall through 写新。
- handler 失败走 D10 error envelope：`setSystemPrompt` 失败时 `sendError(ws, 'set_system_prompt_failed', ...)` + 不广播，与契约一致（测试 case "config.setSystemPrompt 失败" 覆盖）。
- `setSystemPromptConfig` 超长拒存：返回 `{ ok: false, error }` 不写盘；测试 case "超长拒绝时不会覆盖已有合法配置" 验证不覆盖既有文件。
- `getSystemPromptSnapshot` 文件不存在返回 `{ exists: false }`，存在时返回 content + updatedAt。
- 插件单测的 "配置损坏 → undefined"、"append 空白 → undefined" 覆盖到位。

### 2.3 edge-case — 良好（2 minor / 1 nit）

- 配置缺失/损坏/字段缺失兜底：runtime `mergeSystemPromptConfig` 字段级容错（corrupted=false），JSON.parse 失败 corrupted=true；插件 `readConfig` 同构兜底。两条消费方对称（spec §3 要求）。
- `append.prompt` 空白：插件 `cfg.append.prompt.trim()` 守卫，runtime `getReplaceSystemPrompt` `prompt.trim() !== ''` 守卫——一致。
- 快照防抖：插件 hash 对比（读旧 vs 新，相同则不写），测试 "相同内容第二次调用不更新 mtime" 验证。
- replace 仅新会话生效：spawn 三处（create/restore/fork）读 `getReplaceSystemPrompt()`，已运行 session 不重新 spawn——语义正确。
- **问题 RV4**（minor）：`append.prompt` UI 显示 `len/16000` 计数器（`SystemPromptPage.vue:87`），但 `setSystemPromptConfig` 只校验 `replace.prompt.length`，不校验 `append.prompt.length`。用户在 append 卡输入 17000 字符 → 计数器红区暗示超限 → 点保存却成功。计数器误导 + 校验不对称。注：append 不走 argv（无 32k 限制压力），但 UI 既显示 /16000 就应一致校验，或改显示不同的指导文案。
- **问题 RV5**（minor）：`restoreSession`/`forkSession` 也会读 `getReplaceSystemPrompt()` 注入 `--system-prompt`。spec §5 「生效语义备忘」+ §10 「恢复/分叉会话按当前配置取替换提示词」明确这是预期行为，但与 UI 文案「仅对新建会话生效」（SystemPromptPage replaceWarning + i18n）措辞不完全一致——restore/fork 也走 spawn，故也对 restore/fork 生效。文案应改为「仅对新建/恢复/分叉的会话生效」更准确。属 nit/沟通问题。
- **nit RV6**：`writeSnapshot` 用 `tmpPath = snapPath + '.tmp-' + process.pid`。多 session 并发写时 tmp 文件名含 pid 唯一，`renameSync` 原子，最后写入者胜出——符合 spec §4「快照为多 session 共享，最后写入者胜出」。无问题，仅记录。

### 2.4 test-quality — 良好（1 minor）

- 测试有用户可见断言：renderer 测试 mount `SettingsModal` + 切菜单 + 断言 10 个 testid 存在于 DOM（AGENTS.md 规则 #5/#8），保存流断言 `setSystemPrompt` payload + toast type，失败流断言 error toast。
- 边界 case 覆盖：配置缺失/损坏/字段类型错、append 空白、超长拒存 + 不覆盖既有、replace disabled、getReplaceSystemPrompt 三态（enabled 非空/空白/disabled）、快照 exists/false、corrupted=true 透出、env 回退（`PI_CODING_AGENT_DIR`）。
- **问题 RV7**（minor）：`rpc-client-system-prompt.test.ts` 只断言 args `toContain('--system-prompt')` + `indexOf + 1` 值正确，未断言 spec §5 #6 要求的「`--model` 后追加」顺序。测试 mock `getDefaultModel → null` 导致 args 里没有 `--model`，顺序断言无从验证。建议补一个 model 已设 + systemPrompt 同时设的 case，断言 `--system-prompt` 在 `--model` 之后。
- 其余 4 个 runtime 测试文件断言充分，无明显洞。

### 2.5 plan-completeness — 基本完整（1 minor）

对照 spec §5 runtime 改动表逐项核：

| # | spec 要求 | 落地 | 状态 |
|---|-----------|------|------|
| 1 | `runtime-env.ts` `getExtensionFilePath` 加 fileName 参数 | `getExtensionFilePath(projectRoot, packaged, fileName='xyz-agent-extension.js')` | ✓ |
| 2 | `extension-service.ts` 追加第二个文件型扩展（existsSync + 顺序） | `systemPromptExtensionFilePath` + `getExtensionPaths` 在 agent ext 后追加 + existsSync | ✓ |
| 3 | `config-service.ts` 加 get/set/snapshot 3 方法 | 实际加了 4 方法（+ `getReplaceSystemPrompt`）+ `mergeSystemPromptConfig` 私有 | ✓ 超额 |
| 4 | `interfaces.ts` 加签名 | `IConfigService` 加 4 签名 | ✓ |
| 5 | `settings-message-handler.ts` 加 3 case | ✓ reply + broadcast + sendError 路径完整 | ✓ |
| 6 | spawn 链路（lifecycle → process-manager → rpc-client）透传 systemPrompt | 三处 spawn + `RpcClientOptions.systemPrompt` + args 拼入 | ✓ |
| 6' | 值来源：session-service 委托 ConfigService（对称 getExtensionPaths） | `getReplaceSystemPrompt()` 委托 + `setConfigService` 注入 | ✓ |
| 7 | `electron-builder.yml` extraResources | ✓ 独立 commit（W8） | ✓ |
| 8 | `postbuild-validate.sh` 产物校验 | ✓ 同 commit | ✓ |

- **问题 RV2**（minor）：spec §6 明确 `config.systemPrompt` 是「reply + broadcast + 初始推送三用」，并要求「前端新连接初始状态推送在 `message-broker.ts` `sendInitialState` descriptor 加一段」。实际 `message-broker.ts:207-280` `sendInitialState` 的 steps 数组有 10 段（app.info/sessions/providers/defaults/skills/skillDirs/agents/agentDirs/plugins/extensions），**没有 config.systemPrompt 段**。后果：新 WS 连接时前端 `store.systemPromptConfig` 保持 `null`，直到用户打开 SystemPromptPage（onMounted 拉 RPC）或 runtime 广播（保存时）。因 SystemPromptPage 自带 RPC fallback，实际 UI 不坏，但偏离 spec 的「初始推送」契约。
- 其余 §1-9 项均落地。spec §9.5 SR1-SR5 修订全部覆盖：version 字段 ✓、JsonStore 原子写 ✓、corrupted 透出 ✓、超长拒存 ✓、append 关闭仍写快照 ✓（测试 case 验证）、保存失败 toast ✓、恢复默认=关开关不删文本 ✓（Switch 只改 enabled，不清 prompt）。

### 2.6 design-consistency — 基本一致（用禁读重建法）

禁读重建法：先只读 spec §1（目标）/§2（设计决策）/§3（schema）/§9.5（SR1-SR5）确认需求，再读实现反查每个 FR/AC。

| FR/AC | spec 要求 | 实现反查 | 状态 |
|-------|-----------|----------|------|
| FR-1 替换 pi 核心提示词 | `--system-prompt` CLI | rpc-client `args.push('--system-prompt', ...)` + 空白守卫 | ✓ |
| FR-2 追加注入 | `before_agent_start` hook 每轮读配置 | 插件 `readConfig` 每轮读 + append | ✓ |
| FR-3 Settings UI | 独立 section + 快照预览 | SystemPromptPage 三卡 + SettingsModal 菜单项 | ✓ |
| FR-4 配置读写 | `getSystemPrompt`/`setSystemPrompt` | ✓ + corrupted 透出 | ✓ |
| FR-5 快照读取 | `getSystemPromptSnapshot` | ✓ exists/content/updatedAt | ✓ |
| FR-6 持久化（SR1） | JsonStore 原子写 + version + fail-safe | `atomicWrite` + version:1 + 三级兜底 | ✓ |
| FR-7 校验（SR2/SR4） | replace.trim() 空视同未启用 + 16000 上限 + 超长拒存 + 失败 toast | `getReplaceSystemPrompt` trim 守卫 + `setSystemPromptConfig` 长度校验 + handler sendError + UI toast | ✓（但 append 无校验，见 RV4） |
| AC-8 roundtrip + corrupted + dataDir 跟随 | ✓（测试覆盖 roundtrip + corrupted=true） | ✓ |
| AC-9 超长拒存不写盘 | ✓（测试 "超长拒绝时不覆盖既有"） | ✓ |
| AC-10 append 关闭仍写快照（SR3） | 插件 `writeSnapshot` 无条件调用 | ✓（测试 case 验证） |
| AC-11 mock WS 保存失败 → 页内错误 | renderer 测试 "setSystemPrompt 失败时显示 error toast" | ✓ |

**设计决策对照**（spec §2）：
- D2 替换走 `--system-prompt` CLI（核心段替换，动态段保留）✓
- D3 追加走 hook 每轮读（热生效）✓
- D4 全局一份 `<dataDir>/system-prompt.json` ✓
- D5 独立 Settings section + 快照预览 ✓
- D6 单文件 builtin 扩展（无构建/无 npm deps）✓ —— 插件确为单文件 ESM，仅用 node:fs/node:path
- D7 强制加载、无禁用开关 ✓ —— `getExtensionPaths` 无条件 existsSync 追加
- D8 不用 `--append-system-prompt` ✓
- SR1 version 字段 ✓
- SR5 corrupted 透出 ✓
- D6（§9.5）恢复默认=关开关不删文本 ✓

**链式位置**（spec §4）：插件在 `getExtensionPaths` 中最后追加（在 npm 扩展 + xyz-agent-extension.js 之后），快照≈最终生效值 ✓。

**整体一致性**：实现忠实落地 spec 设计决策，无重大偏离。唯一偏差是 RV2（sendInitialState 缺初始推送段，属契约完整性 minor）。

---

## 3. 问题清单（按 severity 排序）

| id | severity | dimension | title |
|----|----------|-----------|-------|
| RV2 | minor | plan-completeness | `sendInitialState` 缺 `config.systemPrompt` 推送段（spec §6 要求「初始推送」三用之一） |
| RV3 | minor | type-safety | `PiSessionOptions` 缺 `systemPrompt?: string` 字段，port 契约与实现漂移 |
| RV4 | minor | edge-case | `append.prompt` UI 显示 /16000 计数器但后端不校验 append 长度，计数器误导 |
| RV5 | nit | edge-case | replaceWarning 文案「仅对新建会话生效」漏了 restore/fork（实际也生效） |
| RV7 | minor | test-quality | rpc-client 测试未断言 `--system-prompt` 在 `--model` 之后的顺序（spec §5 #6） |

**无 critical / major / must-fix / should-fix**。全部为 minor / nit。

---

## 4. 总结

### 整体评价

W1-W9 实现质量**良好**，是一份忠实落地 spec 的工程实现：

- **设计一致性高**：spec §2 的 7 个设计决策 + §9.5 的 SR1-SR5 修订全部落地，无重大偏离。两条独立链路（replace 走 CLI / append 走 hook）+ 独立配置文件 + 快照窗口的架构清晰、对称。
- **错误处理扎实**：插件三级 fail-safe（文件缺失/损坏/字段类型）+ 顶层 try/catch 不阻断 agent loop；handler 失败走 D10 envelope；超长拒存不写盘且不覆盖既有配置。
- **测试有真断言**：35 cases 全绿，renderer 测试有用户可见 DOM 断言（testid + toast + payload），边界 case（corrupted/空白/超长/env 回退）覆盖充分。
- **协议 SSOT 落实**：`SystemPromptConfig`/`SystemPromptSnapshot`/`SYSTEM_PROMPT_MAX_LENGTH` 全部 single source of truth，前后端 type-only import。
- **打包约束合规**：W8 独立 commit（规则 #12），electron-builder.yml + postbuild-validate.sh 对称。

### must-fix 数量：**0**

### should-fix 数量：**0**

全部为 minor（4）/ nit（1），不阻塞合并。建议后续顺手修：
1. RV2：`sendInitialState` 补 `config.systemPrompt` 段（对齐 spec §6 契约 + 让前端 store 新连接即有值）。
2. RV3：`PiSessionOptions` 加 `systemPrompt?: string`（类型契约完整）。
3. RV4：append 卡计数器要么改为不显示上限（append 无 argv 限制），要么后端补 append 长度校验（与 UI 一致）。
4. RV7：rpc-client 测试补 model + systemPrompt 同设的顺序断言。

RV5（文案）可在下次 i18n 修订时一起改。

### 并发改动排查

已注意 `session-service.ts` / `session-lifecycle.ts` 含 sidecar 相关预存改动（commit `0f8cc5d7` R1 restore/fork cleanup sidecar），本次审查只针对 W1-W9 增量（`getReplaceSystemPrompt` 委托 + spawn 三处透传 + `setConfigService` 注入），未混入 sidecar 改动评价。
