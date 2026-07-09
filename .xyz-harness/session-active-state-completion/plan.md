---
---

# 补全 session active state 收尾（isCompacting + E1-E4 集成测试）

## 业务目标

承接已 closed 的 `cw-2026-07-09-unify-session-active-state`。核心改动（deriveStatus isActive、useSessionDerivations 去 activeId、Panel isGenerating 改用 chat.isActive）已在分支上且 846 tests 全绿。本次补全两个遗留项：

1. **Panel.vue isCompacting 缺失**：compact 期 `showPanelComposer` 不含 isCompacting 分支 → Composer 不渲染 → 用户看不到压缩态 UI
2. **E1-E4 集成测试完全缺失**：现有测试全是 store 层和纯函数层，mount 组件断言 DOM 的集成测试一条没有

成功标准：
1. Panel.vue 新增 `isCompacting` computed，`showPanelComposer` 含 `|| isCompacting.value` 分支
2. 新建 `session-active-state.test.ts` 覆盖 E1-E4（mount SessionItem/Panel + store 断言）
3. 全量 vitest + vue-tsc 通过

约束：测试框架 vitest（renderer happy-dom + @vue/test-utils），运行从 `packages/renderer` 目录。遵循「一致性 > 品味」+「emit 单 payload」。

不做：
- 不改 Panel.vue 变量名 isGenerating→isExecuting（命名优化非阻塞，遗留）
- 不改 deriveStatus / useSessionDerivations（已完成）
- 不跑 E1-r real 层（需真 LLM 延迟，手动验证）

## 技术改动点

- 修改 `packages/renderer/src/components/panel/Panel.vue` — 新增 `isCompacting` computed（基于 `chat.isCompacting(props.sessionId)`）；`showPanelComposer` 加 `|| isCompacting.value` 分支；更新注释说明 compact 互斥态与 isActive 的关系。
- 新建 `packages/renderer/src/__tests__/panel/session-active-state.test.ts` — 4 条 mock 层集成测试（E1-E4）。

## Wave 拆分与依赖

| Wave | 改动文件 | 依赖 | 并行组 | 说明 |
|------|---------|------|--------|------|
| W1 | Panel.vue | - | - | isCompacting computed + showPanelComposer 分支 |
| W2 | session-active-state.test.ts | W1 | - | E1-E4 集成测试 |

串行：W2 的 E3 断言 Panel 渲染 Composer 依赖 W1 的 showPanelComposer isCompacting 分支。

## 单测用例清单（AC 级）

| 用例ID | 覆盖改动点 | 输入 | 预期 | 类型 |
|--------|-----------|------|------|------|
| U1 | Panel.vue:isCompacting | chat.isCompacting('s1')=true | isCompacting computed 返回 true | 正常 |
| U2 | Panel.vue:showPanelComposer | sessionId='s1', isCompacting=true, isActive=false | showPanelComposer=true | 正常 |
| U3 | session-active-state.test.ts:E1-E4 | E1-E4 集成测试覆盖 addPendingSend/compact/landing | 4 条用例全 pass | 正常 |

## E2E 用例清单

测试栈：vitest + @vue/test-utils（mount 组件树集成测试，happy-dom）。

| 用例ID | 场景 | 测试层 | 前置 | 步骤 | 预期 | 执行方式 |
|--------|------|--------|------|------|------|---------|
| E1 | 提交后空窗期圆点显示 running（核心 bug 回归） | mock | setActivePinia；初始化 chat store 含 session s1 | store.addPendingSend('s1')；断言 derivedStatus('s1') | derivedStatus=running | `cd packages/renderer && npx vitest run` |
| E2 | 多 panel 非焦点 session 提交后圆点 running | mock | setActivePinia；chat store 含 A+B；activeId=A | store.addPendingSend('B')；断言 derivedStatus('B') | derivedStatus(B)=running | `cd packages/renderer && npx vitest run` |
| E3 | compact 期圆点 running + Panel 渲染 Composer | mock | setActivePinia；mount Panel(sessionId='s1') | store.setCompacting('s1',true)；断言 derivedStatus + Panel DOM | derivedStatus=running；Panel 渲染 composer | `cd packages/renderer && npx vitest run` |
| E4 | Panel landing 态不被其他 session 流式误伤（回归） | mock | setActivePinia；mount Panel(sessionId=null) | store.applyMessageEvent('session-A', message_start)；断言 Panel DOM | Panel 渲染 Landing（data-testid='landing'） | `cd packages/renderer && npx vitest run` |
| E1-r | 提交消息后观察侧边栏圆点在 pi 返回前显示 running（真实时序空窗期） | real | dev 模式连真实 pi 子进程 + 真实 LLM | 发消息后肉眼观察提交瞬间到首 token 前圆点 | running（accent 呼吸），非 done（绿色静态） | 手动验证 [需集成环境] |

## 覆盖率 gate

- gate 命令：`cd packages/renderer && npx vitest run --coverage`
- 增量算法：改动文件为 Panel.vue + session-active-state.test.ts，覆盖率按 Panel.vue 的行/分支统计
- 阈值：Panel.vue 增量覆盖率 ≥ 80%（computed 状态派生，高覆盖率门槛合理）

## 实现步骤

1. [W1] Panel.vue 新增 isCompacting computed + showPanelComposer 分支 → 跑 `cd packages/renderer && npx vitest run` 确认无回归 → 提交
2. [W2] 新建 session-active-state.test.ts 写 E1-E4 → 跑该文件确认全绿 → 跑全量 vitest + typecheck → 提交
