# W1a 验收报告：model-switch setModel 真切（verifier 对抗式独立验收）

> 验收人：verifier（独立会话，builder 自报一律待证实）。基线：commit `5481b2e9d` 的 `w1a-acceptance.md`。
> 日期：2026-08-20。**总结论：PASS**（C1-C4 全过，无 must-fix；2 个 observation 不阻塞）。

## 1. 防篡改检查

| 检查 | 结果 |
|------|------|
| `git diff 5481b2e9d -- .xyz-harness/.../w1a-acceptance.md` | **空**（无篡改） |
| 基线 sha256 | `7a6fe1ddf55bcc3f8c4b816728f578f92d176a407aa2387a61aec0f3debcde6e` |
| 当前分支 | `fix-chat-flow-order`，HEAD `3af2baa71` |

## 2. 越界判定

`git status --porcelain -uall` 全量对照：

- **builder 改动恰 2 文件，全部在边界（`extensions/model-switch/`）内**：
  - `M  extensions/model-switch/src/index.ts`
  - `?? extensions/model-switch/tests/switch-model.test.ts`（新增，7 用例）
- 任务给定豁免清单内：`attach-lifecycle.test.ts`、`session-file-utils.ts`、`startup-background-init.ts`、`session-file-utils-tmp-migrate.test.ts`、`chat-app/` —— 均在 status 中，未触碰未评审。
- **清单外发现 3 个文件**：`packages/runtime/src/infra/pi/pi-provider-repair.ts`、`pi-provider-store.ts`、`packages/runtime/src/__tests__/sanitize-invalid-providers.test.ts`。逐行读 diff：改动全部标注 `[W1b 语义变更]`（isInvalidProvider 八字段判定对齐 pi 0.84.1），内容与 model-switch/W1a 零交集 —— **判定为并行 W1b builder 会话产物，非 W1a builder 越界**（内容证据明确；清单未更新属协调遗漏）。按认知外改动规则不提交、不修改、不评审，留主协调处理。

**判定：W1a builder 无越界。**

## 3. 命令实跑（C4）

根目录 `pnpm extensions:typecheck && pnpm extensions:lint && pnpm extensions:test` → **exit 0 全绿**。
model-switch 域明细：`tests/resolveModelForScene.test.ts (7)` + `tests/switch-model.test.ts (7)` = 2 files / 14 tests 全过。
单跑：`cd extensions/model-switch && pnpm exec vitest run tests/switch-model.test.ts` → **7/7 passed**。

## 4. pi 锚点独立复核（对照 `node_modules/@earendil-works/pi-coding-agent/dist/` 实源）

| builder 引用锚点 | 复核结果 |
|---|---|
| `core/extensions/types.d.ts:954` `setModel(model: Model<any>): Promise<boolean>` | **真**。注释原文 "Returns false if no API key available"，直接印证 false 路径语义 |
| `core/agent-session.js:1204` host setModel 自写原生 entry | **真**。`AgentSession.setModel` 内 `this.sessionManager.appendModelChange(model.provider, model.id)`（另含 `setDefaultModelAndProvider` + `_emitModelSelect`，与 builder 注释描述一致） |
| `core/agent-session.js:1885-1890` 未配置 auth 返回 false | **真**。extension host wrapper：`if (!this._modelRuntime.hasConfiguredAuth(model.provider)) return false;` |
| `core/session-manager.js:146-160` 恢复只认原生形态 | **真**。`getSessionContextSettings` 仅匹配 `entry.type === "model_change"` 取 `{provider, modelId}`；紧随注释 "Plain custom entries are display/state entries and do not participate in context" |
| `core/session-manager.js:790-799` appendModelChange 实现 | **真**。写 `{type:"model_change", id, parentId, timestamp, provider, modelId}` 原生 entry |
| `core/model-registry.d.ts:28` find 返回 Model | **真**。`find(provider: string, modelId: string): Model<Api> | undefined` |

**4 组锚点全部为真，无编造。**

## 5. 对抗式代码审查

### 5.1 plan≠provider 连带修复（真实 bug，修复自洽）

旧实现 `handleSwitch` 传 `match.plan` 给 `switchToModel(pi, ctx, match.plan, ...)`，内部 `ctx.modelRegistry.find(provider, modelId)` 拿 quota-plan cache key 当 provider 名查 registry。以 `setup.ts` 的 `PROVIDER_TO_PLAN` 为证（`"zhipu-coding-plan" → "zhipu"` 等 8 条映射，`"opencode-go" → "opencode-go"` 同名例外）：对多数 provider，`find("zhipu", ...)` 在 registry（真实 key `zhipu-coding-plan[-router]`）必然落空 → 永远 "not available"。**bug 真实存在**。

新解析链 `find(provider) ?? find(provider+"-router") ?? find(plan)` 语义自洽：
- `provider`（config key）：setup 生成时 `m.provider.replace(/-router$/, "")`（setup.ts:82）剥后缀的 key —— 对应 registry 的非 router 形态；
- `-router` 变体：**有仓内依据非拍脑袋** —— setup.ts:82 剥后缀逻辑的反向补全 + `PROVIDER_TO_PLAN` 成对条目（`zhipu-coding-plan` / `zhipu-coding-plan-router` 并列）即 models.json 真实注册形态的记录；
- `plan` 兜底：覆盖 plan 与 provider 同名场景（`opencode-go`）。兜底顺序（router 变体先于 plan）合理：前者同 provider 语义，后者跨 provider 语义。

### 5.2 appendEntry 删除破坏面（零破坏）

关键事实（源码级确证）：`pi.appendEntry(customType, data)` host 实现为 `sessionManager.appendCustomEntry`（agent-session.js:1864-1870），写出 entry 的 **`type` 恒为 `"custom"`**（`customType` 只是字段，session-manager.js:820-831）。因此旧 `appendEntry("model_change", {...})` 从未产出原生形态 —— B-F1「切换从未生效/持久化」在源码层确证。

全仓消费方清点（`rg "model_change"` + `rg "customType"` packages/ + extensions/）：
- **`customType === "model_change"` 消费方：0 个**。所有 customType 消费方均为其他常量（goal-context / plan-state / subagent-record / workflow-record / pending:* / xyz-client-msg-id / pi-scheduler:* 等）。
- model-switch 自身 `advisor.ts:79`（computeStickiness）匹配的是 `e.type === "model_change"` **原生形态** —— 旧 custom entry 本来就匹配不上（旧 stickiness 同样受害）；新实现 pi host 写原生 entry，advisor 功能反而修复。
- core `apply-entry.ts:365/590`：model_change 属未建模类型 no-op 透传，无 alias 消费 —— builder 该声称核实为真。
- session-reader / subagent-workflow / runtime 等消费的均为原生形态 entry，与被删 custom 写入无关。

**判定：删除零破坏。**

### 5.3 throw / false 路径状态清理

`SessionState` 仅 `config` / `injectedModelTable` 两字段，`switchToModel` 全路径不修改任何共享状态，false/throw 路径仅 `return res(..., {error:true})`。无状态泄漏。附加核实：host wrapper 先 `hasConfiguredAuth` 再调 `AgentSession.setModel`（后者 `checkAuth` 竞态下会 throw），新实现外层 try/catch 已覆盖该 throw 路径 —— 报错路径完备。

## 6. 本地 pi CLI 独立实测（C3，防谎报关键项）

隔离环境（与真实 `~/.pi` 完全隔离，凭证经副本、真实文件零触碰）：
`PI_CODING_AGENT_DIR=/tmp/w1a-verify-agent`（auth.json 仅含 xiaomi-token-plan-cn key 副本、models.json 空 providers 继承内置 catalog、config/model-switch-ext-config.json 为 plan≠provider 形态：key `xiaomi-token-plan-cn` / plan `xiaomi`、两模型）+ `--session-dir /tmp/w1a-verify-sessions` + `--extension <repo>/extensions/model-switch`。

**阶段 1（切换生效）**：`pi --mode rpc --model xiaomi-token-plan-cn/mimo-v2.5 --approve`，stdin JSONL 发 prompt 驱动 LLM 真实调用 tool：
```
BEFORE model: xiaomi-token-plan-cn/mimo-v2.5
EV: message_end:assistant tools=[{'name': 'switch_model', 'arguments': {'action': 'switch', 'query': 'mimo-pro'}}]
AFTER model: xiaomi-token-plan-cn/mimo-v2.5-pro
```
真实 LLM 调用 switch_model → get_state().model 变为目标。（实测同时覆盖 plan≠provider 解析链：config key 直命中 registry。）

**持久化形态**：session JSONL entry 序列 `['session','model_change','thinking_level_change','message','message','model_change','message','message']` —— 原生 `type:"model_change"` 2 条（启动元数据 + 切换写入，后者 `{provider:"xiaomi-token-plan-cn", modelId:"mimo-v2.5-pro"}`），**custom entry 0 条**（builder「custom entry 0 条」声称核实）。隔离 settings.json 被 host 写入 `defaultModel: "mimo-v2.5-pro"`（双通道持久化），真实 `~/.pi/agent/settings.json` 未触碰。

**阶段 2（重启附着恢复）**：kill 后 `pi --mode rpc --continue`（不带 --model）附着同 session：
```
REATTACH model: xiaomi-token-plan-cn/mimo-v2.5-pro
sessionFile: /tmp/w1a-verify-sessions/2026-08-19T16-43-07-237Z_01a01ae7-….jsonl（同一文件）
```
恢复为目标模型 ✓。

**verifier 实测弯路（如实记录）**：首次阶段 2 带 `--model xiaomi-token-plan-cn/mimo-v2.5` 显式参数，REATTACH 回到 mimo-v2.5 —— 此为 pi 既有语义（CLI 显式 --model 优先于 session/settings 恢复），非本次改动缺陷；去掉 --model 后恢复正确。builder 报告的「严格隔离 settings+CLI 双通道」与此一致。

**判定：C3 通过。**

## 7. 红性验证

- 验证前 diff 指纹（`git diff 5481b2e9d -- extensions/model-switch/`）：`2d2af02252d8d931a36102ce41713890971e565cac6c4b7acf49c79d649607ae`
- 临时把 `const ok = await pi.setModel(model);` 改为 `const ok = true;` → 跑 `tests/switch-model.test.ts`：**4 failed | 3 passed**（4 个 setModel 依赖用例红：calls-setModel / false-path / router-variant / exception-path；appendEntry 禁止、registry 缺失、unknown alias 3 用例不依赖该调用仍绿）—— 测试对「setModel 真切调用」敏感，非凑数。
- 字节还原后 diff 指纹：`2d2af022…07ae` **与验证前一致**，测试复绿 7/7。

## 8. 条款结论

| # | 条款 | 结果 | 关键证据 |
|---|------|------|---------|
| C1 | 真实 pi.setModel 调用 + false 报错 | **PASS** | index.ts:351 `await pi.setModel(model)`；false → error 文案；单测 3 用例 + 红性 4 红 |
| C2 | appendEntry 处置与调查结论一致 + 注释含锚点 | **PASS** | custom 写入已删；注释含 types.d.ts:954 / agent-session.js:1204+1885 / session-manager.js:146-160+790-799 全部锚点（逐一复核为真） |
| C3 | 切换生效 + 重启附着恢复 | **PASS** | 独立实测三阶段：mimo-v2.5 → mimo-v2.5-pro；JSONL 原生 entry 2 / custom 0；--continue 附着恢复 mimo-v2.5-pro |
| C4 | 三连全绿 | **PASS** | 根目录三连 exit 0；model-switch 域 14/14 |

## 9. Observations（不阻塞）

1. `find(plan, modelId)` 兜底理论上可命中与目标 provider 同名模型的跨 provider 条目（如手工编辑 config 导致 key 失真且 plan 名恰为另一 provider 名）——仅兜底路径、风险低，且错误信息已含 provider 名可诊断。建议后续在 config 加载时校验 key 形态（长期）。
2. 阶段 2 实测确认的「CLI 显式 --model 覆盖恢复」是 pi 既有语义；xyz-agent 桌面侧若依赖重启附着恢复模型，需注意不要总带显式 --model 参数（超 W1a 范围，记录备查）。

## 10. 探针清理

`/tmp/w1a-verify-agent`（含 auth key 副本）、`/tmp/w1a-verify-sessions`、`/tmp/w1a-verify-drive.py`、`/tmp/w1a-verify-stderr.log` 已在报告完成后删除（见 verifier 最终回复）。除本报告外零文件改动、零 git 写。
