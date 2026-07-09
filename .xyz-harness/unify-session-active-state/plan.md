---
scope_ensemble_overlap: not_triggered
reuse_ensemble_overlap: not_triggered
test_ensemble_overlap: not_triggered
reconstruct_blind_spot: not_triggered
---

# 统一 session 执行态信号（消除提交→流式空窗期状态不一致）

## 业务目标

消除"用户提交消息后到 pi 返回首个 message_start 之间"的空窗期状态不一致：该期间侧边栏圆点 / PanelHeader 状态点显示 done（绿色静态），正确应为 running（呼吸）。

将 `isActive`（isGenerating ∨ pendingSend）提升为 UI 层执行态 SSOT，`deriveStatus` 改消费 `isActive` 而非 `isStreaming`，移除 `activeId` 限定（多 panel 下非焦点 session 也真实反映执行态）。`Panel.vue` 自造的 per-session `isGenerating` computed 改用 `chat.isActive`。compact 保持独立互斥态不并入 isActive（pi 源码确认：compact 期 abort 无效、steer/followUp 入队不消费，故 compact 与"可干预的 isActive"语义相反）。

成功标准：
1. 提交消息后（addPendingSend 到 message_start 之间），当前 session 侧边栏圆点 + PanelHeader 状态点显示 running（accent 呼吸动画）
2. 多 panel 下 P2 提交后切到 P1，P2 圆点持续 running 直至完成
3. compact 期间圆点显示 running，Composer 显示压缩态（禁用输入/无 stop 按钮）
4. 全部现有相关测试（chat-isgenerating-scan / toolcall-anchor / panel-per-session-generating / chat-streaming-reset）通过或按新语义适配

约束：测试框架 vitest（renderer happy-dom + @vue/test-utils 集成），运行从 `packages/renderer` 目录。遵循「一致性 > 品味」+ 「emit 单 payload」+ 「stores 间禁止互 import」。

不做：
- 不暴露 pi 的 `abortCompaction` RPC（rpc-mode 未暴露，属 pi 侧改动，超出范围）
- 不改 useChat.ts 的 send/steer/followUp 守卫（已正确用 isActive）
- 不改 Composer 的 isCompacting/isSending 三态分支（已正确）
- 不改 MessageStream.isDispatching（已是 isActive && !isGenerating 的正确派生）
- 不引入 isExecuting 新名（与 isActive 同义，避免增加同义词）

## 技术改动点

- 修改 `packages/renderer/src/composables/logic/sessionStatus.ts` — `deriveStatus` 纯函数：第三参数 `isStreaming: boolean` 改为 `isActive: boolean`（语义"agent 在忙且可干预"），新增可选第四参数 `isCompacting?: boolean`；`isActive || isCompacting || last?.status === 'streaming' → running`。更新 JSDoc。
- 修改 `packages/renderer/src/composables/features/useSessionDerivations.ts` — `derivedStatus` computed：传 `chat.isActive(id)` + `chat.isCompacting(id)` 给 deriveStatus；**去掉 `&& session.activeId === id` 限定**（非焦点 session 也真实反映执行态）。
- 修改 `packages/renderer/src/components/panel/Panel.vue` — 自造 `isGenerating` computed 改名为 `isExecuting`，基于 `chat.isActive(sessionId)`（去掉 per-session isGenerating scan）；`showPanelComposer` 增加 `|| isCompacting` 分支（compact 期也渲染 Composer 显示压缩态）；模板 3 处 `isGenerating` 引用改 `isExecuting`。新增 `isCompacting` computed。更新 [HISTORICAL] 注释说明 activeId 限定已移除。
- 修改 `packages/renderer/src/stores/chat.ts` — 仅注释更新：明确 `isActive` 是 UI 层执行态 SSOT 的定位（"派生层/Panel/Composer 统一消费 isActive，不直接用 isGenerating"），isActive 定义不变（isGenerating ∨ pendingSend）。
- 适配 `packages/renderer/src/__tests__/stores/toolcall-anchor.test.ts` — `deriveStatus(sid, store, false)` 第三参数语义从 isStreaming 改为 isActive，调用处传参不变（false 仍表示"非活跃"），但加一条 isCompacting 参数的用例。

复用检查：无新建文件。所有改动都是对现有信号的贯通——`isActive` 已存在于 chat.ts（D-015 引入），只是派生层和 Panel 层漏接。deriveStatus 已是纯函数 SSOT，改签名不破坏调用契约（只新增可选参数 + 语义收窄）。

## Wave 拆分与依赖

| Wave | 改动文件 | 依赖 | 并行组 | 说明 |
|------|---------|------|--------|------|
| W1 | sessionStatus.ts, useSessionDerivations.ts, chat.ts(注释), toolcall-anchor.test.ts(适配) | - | - | 信号源 + 派生层：deriveStatus 改签名接收 isActive/isCompacting，useSessionDerivations 传新参去 activeId 限定。改完可独立测圆点状态派生 |
| W2 | Panel.vue | W1 | - | 消费层：Panel 自造 isGenerating 改用 isActive，showPanelComposer 加 isCompacting 分支。依赖 W1 的 isActive SSOT 定位 |

串行：W2 改 Panel.vue 内对执行态的判断，依赖 W1 确立的"isActive 是 UI SSOT"语义；不并行（W2 的设计输入来自 W1）。

## 单测用例清单（AC 级）

| 用例ID | 覆盖改动点 | 输入 | 预期 | 类型 |
|--------|-----------|------|------|------|
| U1 | sessionStatus.ts:deriveStatus | session 无消息，isActive=true（pendingSend 空窗），isCompacting=false | 返回 'running' | 正常 |
| U2 | sessionStatus.ts:deriveStatus | session 无消息，isActive=false，isCompacting=true | 返回 'running' | 正常 |
| U3 | sessionStatus.ts:deriveStatus | session 无消息，isActive=false，isCompacting=false（默认） | 返回 'done' | 边界 |
| U4 | sessionStatus.ts:deriveStatus | 末条 assistant 有 running toolCall，isActive=true | 返回 'waiting'（waiting 优先级高于 running） | 边界 |
| U5 | sessionStatus.ts:deriveStatus | 末条 message.status='error'，isActive=false | 返回 'error' | 异常 |
| U6 | useSessionDerivations.ts | session B 有 pendingSend，activeId=session A（B 非焦点） | derivedStatus(B) 返回 'running'（移除 activeId 限定后非焦点也反映） | 正常 |
| U7 | useSessionDerivations.ts | session 有 streaming 消息，activeId=其他 session | derivedStatus(该 session) 返回 'running' | 边界 |
| U8 | toolcall-anchor.test.ts(适配) | deriveStatus(sid, store, false) 第三参 isActive=false（原 isStreaming=false 调用不变） | 行为不变，仍返回正确态（兼容现有断言） | 正常 |
| U9 | Panel.vue | props.sessionId='s1'，chat.isActive('s1')=true（pending 空窗），messageCount=0 | 不渲染 Landing，渲染 MessageStream 或空对话态分支（isExecuting=true 走 v-else 最后分支或 MessageStream） | 正常 |
| U10 | Panel.vue | props.sessionId='s1'，chat.isActive=false，isCompacting=true，messageCount=0 | showPanelComposer=true（Composer 渲染显示压缩态）；不渲染 Landing | 正常 |
| U11 | Panel.vue | props.sessionId=null（landing），其他 session isActive=true | 渲染 Landing（per-session isActive，sessionId=null → isExecuting=false，不被误伤） | 边界 |
| U12 | chat.ts:isActive(回归) | 有 streaming 消息 + 无 pendingSend | isActive=true（定义不变，回归保护） | 正常 |
| U13 | chat.ts:isActive(回归) | 无 streaming + 有 pendingSend | isActive=true（定义不变） | 正常 |

## E2E 用例清单

测试栈：vitest + @vue/test-utils（mount 组件树集成测试，happy-dom）。Playwright _electron mock 轨存在但本功能改动是纯前端状态派生，集成测试（mount Panel）+ store 单测已覆盖核心逻辑，无需 Playwright 全链路。

| 用例ID | 场景 | 测试层 | 前置 | 步骤 | 预期 | 执行方式 |
|--------|------|--------|------|------|------|---------|
| E1 | 提交后空窗期圆点显示 running（核心 bug 回归） | mock | setActivePinia(createPinia())；mount SessionItem | store.addPendingSend('s1')；读取 derivedStatus('s1')；断言 SessionItem dot class 含 'animate-pulse' | derivedStatus='running'；SessionItem 渲染 dot 带 pulse 动画类 | `cd packages/renderer && npx vitest run` |
| E2 | 多 panel 非焦点 session 提交后圆点 running | mock | setActivePinia；session.activeId='A' | store.addPendingSend('B')；断言 derivedStatus('B') | derivedStatus('B')='running'（activeId 限定移除后非焦点也反映） | `cd packages/renderer && npx vitest run` |
| E3 | compact 期圆点 running + Panel 渲染 Composer | mock | setActivePinia；mount Panel(sessionId='s1') | store.setCompacting('s1',true)；断言 derivedStatus + Panel DOM | derivedStatus='running'；Panel 渲染 composer（showPanelComposer=true） | `cd packages/renderer && npx vitest run` |
| E4 | Panel landing 态不被其他 session 流式误伤（回归保护） | mock | setActivePinia；mount Panel(sessionId=null) | store.applyMessageEvent('session-A', message_start)；断言 Panel DOM | Panel 渲染 Landing（data-testid='landing'），不落兜底空态 | `cd packages/renderer && npx vitest run` |
| E1-r | 提交消息后观察侧边栏圆点在 pi 返回前显示 running 呼吸动画（真实时序空窗期） | real | dev 模式连真实 pi 子进程 + 真实 LLM | 发消息后肉眼观察提交瞬间到首个 token 出现前圆点 | running（accent 呼吸），非 done（绿色静态） | 手动验证 [需集成环境] |

> E1-E4 均为 mock 层（happy-dom + @vue/test-utils），requiresScreenshot=false（vitest 产出 test-results.json 即凭证，无真实浏览器视口）。
>
> E1-r 为 real 层降级手动：需真实 pi 子进程 + 真实 LLM 响应（引入网络/模型延迟才有空窗期可观察），happy-dom 集成测试无法复现真实时序空窗。**[需集成环境]** 手动验证：dev 模式连真实 pi 发消息，肉眼观察提交瞬间到首个 token 出现前圆点为 accent 呼吸而非 done 绿色。本功能改动是纯前端状态派生（isActive/pendingSend 已由 D-015 验证，本次只是贯通到派生层），real 层价值有限故降级。

## 覆盖率 gate

- gate 命令：`cd packages/renderer && npx vitest run --coverage`（vitest 原生 coverage，c8 provider）
- 增量算法：改动文件为 sessionStatus.ts / useSessionDerivations.ts / Panel.vue，覆盖率按这 3 个文件的行/分支统计（vitest coverage 报告 per-file）
- 阈值：改动文件增量覆盖率 ≥ 80%（状态派生纯函数 + computed，高覆盖率门槛合理；项目已有相关测试基线）

## 实现步骤

1. [W1] 先写 U1-U5 失败测试（deriveStatus 新签名：isActive + isCompacting）→ 改 sessionStatus.ts deriveStatus 实现 → 跑 `cd packages/renderer && npx vitest run src/__tests__/stores/toolcall-anchor.test.ts` 确认 U8 适配通过 → 写 U6-U7（useSessionDerivations 去 activeId 限定）→ 改 useSessionDerivations.ts → 更新 chat.ts isActive 注释 → 提交
2. [W2] 写 U9-U11 失败测试（Panel isExecuting + showPanelComposer isCompacting）→ 改 Panel.vue（isGenerating→isExecuting 基于 isActive，加 isCompacting computed，showPanelComposer 加 isCompacting 分支，模板 3 处引用改名）→ 跑 panel-per-session-generating.test.ts + chat-streaming-reset.test.ts 确认回归 → 提交
3. [验证] 全量 `cd packages/renderer && npx vitest run` + `pnpm --filter @xyz-agent/frontend run typecheck` 全绿
