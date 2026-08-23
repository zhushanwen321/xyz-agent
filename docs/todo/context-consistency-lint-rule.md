# 护栏 G1：taste-lint 规则 `no-instance-level-session-state` 设计

> 父文档：[context-consistency-design.md](./context-consistency-design.md) §3.3 D5。本文档深入 lint 规则的检测模式、误报面与豁免机制，粒度到可直接实现。

**一句话结论**：在 taste-lint 新增 error 级规则，检测「组件同时持有 sessionId prop、调用 useSessionEvents、并在 onMessage 回调内直写组件本地 ref」的反模式组合，pre-commit 拦截；豁免走 `taste:allow-` 行内登记注释（项目既有机制）。

## 1. 问题：这个规则挡什么

父文档层 3 根因：`ContextCapacityPopover` 把 session 级状态存组件实例 ref（`const stats = ref(...)`），切 session 不分区不重置 → 串台/丢失。ADR-0049 checklist 只覆盖 composable，组件内 ref 是 review 盲区。本规则把该反模式从 review 盲区变成 pre-commit 红灯。

**检测的理论依据**（不是「写了就一定有 bug」，而是「结构上无法自证安全」）：session 级消息 handler 写入实例级状态时，值的生命周期绑定的是**组件挂载周期**而不是**session 生命周期**。两者错位时（切 session 组件不卸载）必然产生跨 session 污染——除非作者显式处理了分区/重置，而显式处理的正确形态（useSessionScopedState）恰恰不会触发本规则（分区状态不是组件本地 ref）。

## 2. 检测模式（AST 级）

规则实现为 taste-lint 标准形态（参照 `taste-lint/rules/no-multi-arg-emit.mjs` 的 meta/create 结构 + `require-data-owner-annotation.mjs` 的登记豁免先例），只对 `.vue` 文件的 `<script setup>` 生效。

**触发条件 = 三个信号同时满足**（AND 组合，缺一不报——把误报面压到最小）：

| 信号 | AST 判定 |
|---|---|
| S1 组件接收 sessionId prop | `defineProps` 调用的类型/对象字面量中存在 `sessionId` key |
| S2 调用 `useSessionEvents(...)` | `<script setup>` 顶层存在该名称的 CallExpression（无论 import 自何处——按名匹配，防 alias 绕过的成本高于收益） |
| S3 onMessage 回调内直写本地 ref | `useSessionEvents` 返回值（任意接收名，常见 `onMessage`）被 CallExpression 调用，其 handler 参数（函数体）内存在 `X.value = ...` 或 `X.value.field = ...` 形式的 AssignmentExpression，且 `X` 是**本组件 setup 作用域声明的 ref**（`const X = ref(...)` / `useTemplateRef` 除外） |

报错消息（含恢复动作，遵守「错误信息必须可操作」）：

```
组件同时持有 sessionId prop、订阅 session 事件、并在 handler 内直写本地 ref（{{refName}}）。
session 级状态的生命周期与组件实例错位会导致切换 session 后丢值/串台（ADR-0049）。
迁移：状态迁入 useSessionScopedState 分区 composable（范式样本 useContextUsage），
handler 用第二参数 sid 调 updateFor(sid, ...)。确认无跨 session 风险的例外加
taste:allow-instance-level-session-state 登记注释。
```

**明确不检测的形态**（避免规则膨胀）：

- handler 内调用 `store.xxx(...)` / `composableApi.xxx(...)`（写入外部 owner 的合法形态——store 本身有分区）
- handler 内只读不写（如仅触发 emit）
- 非 `useSessionEvents` 的裸 `events.on(sid, ...)` 订阅——裸订阅已违反「api 调用只在 features 层」既有约束，归那条约束管（不重复立法）

## 3. 误报面分析与豁免

**预期误报源**（实施时用全仓跑一遍统计，登记进本节）：

1. **确实无跨 session 风险的临时 UI 态**：如「本 session 的 popover 开关」，handler 写 `showPopover.value = true`——但这类状态不该依赖 session 消息驱动，属设计味道，预期豁免数 ≤ 个位数。
2. **消息所属 sid 与组件 sid 恒同的组件**：理论上 split panel 下仍可能错位（订阅的是 props.sessionId，消息属于任一 sid），不存在真正安全的实例——若审查中发现声称安全的豁免，要求在登记注释里写明论证。

**豁免机制**：行内注释 `// taste:allow-instance-level-session-state <理由>`，与既有 `taste:allow-no-data-owner`（`require-data-owner-annotation` 规则的登记豁免）同机制——`no-eslint-disable` 规则禁止用 eslint-disable 绕过，登记注释是唯一出口，理由可审计。

**存量处理**：规则以 error 级上线，存量豁免一次性登记（预期主要是本次重构前的 `ContextCapacityPopover`，Phase 2 完成后其豁免随重构消失）。若存量命中出现**非预期组件**，先人工审计是否为同类 latent bug（父文档 §5 待验证检查点 3）。

## 4. 规则测试用例清单（`no-instance-level-session-state.test.mjs`）

沿用 `require-data-owner-annotation.test.mjs` 的测试形态（RuleTester 或项目内等价 runner）：

| # | 用例 | 期望 |
|---|---|---|
| T1 | 三信号齐备（sessionId prop + useSessionEvents + handler 内 `stats.value = ...`，stats 为本地 ref） | 报错，消息含 refName |
| T2 | 缺 S1（无 sessionId prop，其余齐备） | 不报 |
| T3 | 缺 S3（handler 内只调 store action / 只读） | 不报 |
| T4 | handler 内写 `updateFor(sid, ...)`（分区范式） | 不报（S3 判定不含外部函数调用） |
| T5 | S3 的目标 ref 来自 props 传入（非本地声明） | 不报（生命周期归父组件管） |
| T6 | 豁免注释存在 | 不报 |
| T7 | 多个 onMessage 注册，仅其一违规 | 精确报违规处 |
| T8 | `<script setup>` 外（普通 ts 文件） | 不报（规则仅 vue 文件生效） |

## 5. 验收（对齐父文档 A5.1）

1. 在临时测试组件写 T1 形态代码 → `pnpm run lint` 红灯且消息含迁移指引 → 删除临时组件后全绿。
2. 全仓扫描：命中清单 = 预期存量（ContextCapacityPopover 重构前）+ 豁免登记数，无意外命中。
3. pre-commit 钩子路径实测：`git commit` 一个含违规的临时改动被拦截（遵守项目「pre-commit 检出问题全部正面修复」纪律，不验证 --no-verify 路径）。
