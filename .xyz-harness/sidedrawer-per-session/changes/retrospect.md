# Retrospect — sidedrawer-per-session

**日期**: 2026-07-23

## 第 1 段：derived 异常归因

derived 摘要：gateFailCount=3, devRetryCount=0, testRetryCount=1, firstTryPassRate=0.70, redLightConfirmed=true。

**gateFailCount=3 逐条归因**：

1. **plan gate fail（缺 `format:"lite"` + changes 结构不对）**：第一次提交 dev-plan.json 用了 `tasks` 字段和缺 `format`，与 CW 的 lite 格式 schema（`{file,action,description}[]` + `format:"lite"`）不符。归因：**对 CW dev-plan.json 的确切 schema 不熟，凭印象写**。改进：写 plan 前应先读 guidance 给的 schema 示例，或参照同项目其他 topic 的 dev-plan 结构。

2. **tdd_plan gate fail（expected 缺 `type` 字段 + 缺 testRunner）**：第一次提交 test.json 用了旧的 `{url?,text?}` 格式，新格式要求 `expected.type` 必填（exact/exit_zero/script）+ 顶层 testRunner 必选。归因：同上，**schema 演进了但我用的是旧记忆**。tdd_plan guidance 里有完整说明，但跳读没注意 type 必填。

3. **test gate fail（testRunner command 路径与 cwd 双重前缀）**：testRunner.command 写了 workspace-root-relative 路径（`packages/renderer/src/...`），cwd 写 `packages/renderer`，拼起来变双重前缀找不到文件。归因：**multi-package workspace 的路径相对基准歧义**——command 相对 workspace root 还是 cwd，CW 文档没明确，凭直觉选错了。

**testRetryCount=1**：直接对应 gate fail #3，testRunner 配置修正后重跑通过。

**firstTryPassRate=0.70**：spec_review / plan / tdd_plan 三处首次 fail（对应 gateFailCount 的前 2 条 + spec_review 的 must-fix 轮），核心都是 schema/格式不熟，不是设计或实现问题。

**红线确认 redLightConfirmed=true**：TDD 红灯真实跑过（测试文件未实现时 9/9 fail），非伪造。

## 第 2 段：可泛化流程模式（processIssues）

- **pattern**：CW 的 JSON schema（dev-plan / test.json / clarify / review 的 issues 等）有严格的字段要求（format/action/type/severity 等枚举与必填），且会演进。凭记忆写 schema 必然踩坑。改进：每个 gate 首次提交前，从 guidance 里**逐字复制 schema 示例**作为模板，不凭印象构造。这条适用于所有 CW topic。
- **pattern**：multi-package workspace（pnpm workspace，各包独立 vitest config + alias）里，测试命令的路径相对基准有歧义——CW testRunner 的 command + cwd 组合，以及 `cd <pkg> && <cmd>` 写法，需明确约定。改进：testRunner.command 统一用「相对 cwd」的路径，cwd 指向包根；或把 `cd` 合并进 command（同项目 fix-landing-dir-popover topic 的做法）。
- **oneOff**：spec_review 的禁读重建派了 subagent 但卡住（模型响应问题），改为主 agent 自审完成。一次性，非可泛化模式。

## 第 3 段：设计级风险（knownRisks）

- **[设计级] pendingOpen 消费的时序假设 unverified**：`consumePendingOpen` 挂在 `useSidebar.selectSession` 内部（context 拉取后），假设此时 `focusedSessionId` 已是新 sid（panelStore 已更新）。但 selectSession 内部 `panel.loadSession/setActive` 在前面（line 159-163），context 拉取在后面（line 196）——时序上 focusedSessionId 确实已更新。**未在真实双 panel + 后台事件场景下端到端验证**（单测用 mock panel store，未覆盖真实 store 的 computed 时序）。unverified=true。
- **[设计级] useSideDrawer 模块级单例 + useSessionScopedState 模块级调用的测试隔离**：controlState 的 cleanup 注册在模块加载时（单例语义），测试用 `_clearAllForTest` 清分区。这依赖测试不调 `__clearSessionCleanupRegistryForTest()`（否则单例的 cleanup 注册丢失）。**与 useExtensionUI 的 per-call 实例范式不同**，未来若有人按 useExtensionUI 范式给 useSideDrawer 测试加 clear registry 调用，会破坏 U5。unverified=false（已在本 topic 测试中验证，但范式冲突是潜在维护陷阱）。
- **[代码级] selectedCommandName/detailFilePath 未分区（FR-6 显式决定）**：这两个瞬时参数是模块级单例，跨 session 切换不隔离。设计上认为它们「消费后清空不构成持久状态」，但若未来 Doc/Detail tab 的打开逻辑改为「切回恢复」，会出现跨 session 残留。当前 spec 明确 out-of-scope，观察即可。unverified=false。

## 第 4 段：未闭环评估

review 阶段无 should-fix/nit 未闭环（review 传空 issues，Standards + Spec 双轴全过）。

spec_review 的 4 个 SR issue（SR1-SR4）已全部在 CL2 specSections 修复并闭环。

**无跳过的 should-fix/nit**。

## 全绿质量自检（test 阶段要求）

tdd_plan 阶段定义的 9 个 mock case 覆盖 9 个 AC。自检：
- 异常路径覆盖：U1（跨session不干扰）、U5（清理）、U6（不被重开）、U7（幂等）——非全 happy path，有防线。
- 盲区：实现里 `consumePendingOpen` 的「pendingOpen 不存在时 return」分支，U6 间接覆盖（无 pendingOpen 时 consume 无效）。`open()` 清 pendingOpen 的「sid 为 null 时跳过」分支未显式测（focusedSessionId=null 场景），但 useSessionScopedState 对 null sid 的 no-op 语义已在工具层保证。
- 故意改坏测试：若删掉 `open()` 里的 `clearPendingOpenForSid`，U8 会变红；若删掉 sid 守卫，U1 会变红。测试有防线，非覆盖率填充。

自检结论：测试有真实防线，但**未在真实 store + 真实 panel 组件场景下端到端验证**（见 knownRisks 第 1 条 unverified）。
