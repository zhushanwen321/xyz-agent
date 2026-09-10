# Coding Plan 额度查询配置交互重构（方案 B）实施计划

基线: 4b42f85a2（设计 v8 终版） | 来源设计: [coding-plan-quota-config-ux.md](coding-plan-quota-config-ux.md) | 日期: 2026-09-10

> 审查证据：主审 [coding-plan-quota-config-ux.review.md](coding-plan-quota-config-ux.review.md)（r4 复审 0 must-fix）+ 影响面审 [coding-plan-quota-config-ux.impact-review.md](coding-plan-quota-config-ux.impact-review.md)（r7 复审 0 must-fix），均随 4b42f85a2 提交。

## 0 章节映射

| 内容 | 本文实际位置 |
|------|--------------|
| 背景/目标 | §1 背景：被设计的系统是什么；§2 设计目标（含 In-scope / Out-of-scope） |
| 终态/机制 | §5 终态：使用者眼里将是什么样的；§6 关键决策与权衡（D1-D13）；§7 实现机制（§7.1 契约 / §7.2 齐备性 / §7.3 runtime 改动 1-6 / §7.4 UI 改动 / §7.5 文件改动地图） |
| 验收场景表 | §8.2 验收场景（S1-S16，含 8 个反向场景；S5 探针为实施期门） |
| 下一层拆分 | §10 下一层拆分（U1-U6 + justification）；§9.1 迁移路径（M0-M3 分期） |
| 待验证检查点 | §11 待验证检查点（5 项，含 ⛔ 实施期门探针） |

## 1 目标快照（逐字摘录自设计 §2）

**改造后使用者在配置这个能力时，全程不需要猜测 —— 缺什么看得见、能不能测看得见、测的结果说得清、系统用的凭证就是界面上说的那份。**

1. **填参数时立刻知道还差什么**，不必先点一下按钮才知道错。
2. **一次点击完成「落盘 + 验证」**，不需要理解保存和测试的先后顺序。
3. **「启用」开关只表达「要不要在浮层里展示」**，不给它附加任何网络副作用。
4. **界面上说的凭证就是实际用的凭证**，任何时候都不出现「显示用 A、实际用 B」。
5. **不制造坏状态**：不产生「配置写进去了但永远查不到」，不把凭证写坏或静默删掉。

Out-of-scope：新增平台类型 / 修改任何 fetcher 的解析逻辑与端点；`ContextCapacityPopover` 的展示形态（成功态与无数据态不动）；额度缓存的 TTL / 10s throttle / pending 并发去重策略；provider 表单其余字段的「草稿 + 底部保存条」提交模型（D10）；`quota-cache.json` 的存储格式与磁盘清理。

## 2 单元列表

设计 §10 给出 U1-U6；本表把 §7.5 文件地图落到精确路径。单元与设计一一对应，不改拆分；派发批次见「批注」列（>5 文件的单元拆多批串行派发，单元仍一次 commit）。

| Unit | 职责 | 领地（精确文件路径） | 依赖 | 隔离 | 验收条款 | 批注 |
|---|---|---|---|---|---|---|
| U1 数据模型与错误规格（M0） | shared 枚举 `'no-credential'` + `QuotaCredentialSource` + `resolveQuotaCredentialSource` + `QuotaConfigurePayload`（protocol 引用）+ `ProviderInfo.quota.credentialSource` + renderer 穷举映射 + 双语 i18n key | `packages/shared/src/quota-types.ts`<br/>`packages/shared/src/provider.ts`<br/>`packages/shared/src/index.ts`<br/>`packages/shared/src/protocol.ts`<br/>`packages/renderer/src/composables/features/model/useQuotaQuery.ts`<br/>`packages/renderer/src/i18n/locales/zh-CN/settings.ts`<br/>`packages/renderer/src/i18n/locales/en-US/settings.ts`<br/>`packages/renderer/src/i18n/locales/zh-CN/panel.ts`<br/>`packages/renderer/src/i18n/locales/en-US/panel.ts`<br/>`packages/renderer/src/__tests__/i18n/quota-reason-i18n.test.ts`<br/>`packages/shared/src/__tests__/quota-credential-source.test.ts`（**2026-09-11 追溯授权**：按 shared `src/__tests__` 惯例新增，一致性审查 D-4 指出计划初版既未列领地也未登记偏差） | — | plain | ① `cd packages/shared && npx tsc --noEmit` 绿；② `cd packages/renderer && npx vue-tsc --noEmit` 绿（穷举映射漏 key = 编译错，即验证）；③ i18n 存在性测试 `npx vitest run src/__tests__/i18n/quota-reason-i18n.test.ts` 绿；④ protocol 的 `quota.configure` payload 类型改为引用 `QuotaConfigurePayload`（grep 可证）；⑤ 零行为变更：shared/renderer diff 仅类型、导出、文案 key | 2 批：t1 shared 4 文件 → t2 renderer 5 文件 |
| U2 runtime 凭证与清理（M1） | 设计 §7.3 改动 1-6：no-credential 返回；cookie 空串=清除；删除顺序重排与失败语义；按 `credentialSource` 解析（扩 `ProviderInfoLike.quota`）；`lastFailure`/`QuotaCache` 清理（`removeEntry`）；provider 删除清理钩子（三落点）；`credentialSource` 落盘继承链；`QuotaService.configure` 签名切 payload + handler 整对象透传（保留 providerId 防御校验） | `packages/runtime/src/services/quota-service.ts`<br/>`packages/runtime/src/transport/quota-message-handler.ts`<br/>`packages/runtime/src/services/provider-extras-store.ts`<br/>`packages/runtime/src/services/quota-cache.ts`<br/>`packages/runtime/src/services/provider-config-helper.ts`<br/>`packages/runtime/src/services/config-service.ts`<br/>`packages/runtime/src/index.ts`<br/>`packages/runtime/test/services/quota-service.test.ts`（扩既有 36 用例 + configure 签名机械更新）<br/>`packages/runtime/test/services/quota-cache.test.ts`（新建）<br/>`packages/runtime/src/services/__tests__/provider-config-helper.test.ts`（扩）<br/>`packages/runtime/src/services/__tests__/quota-service-workspace.test.ts`（configure 直调消费方，**2026-09-10 追溯授权**：计划初版漏列，签名切换不更新则 tsc 不可能绿）<br/>`packages/runtime/src/services/__tests__/provider-write-side-switch.test.ts`（**同上追溯授权**，8 处直调） | U1 | plain | ① `cd packages/runtime && npx tsc --noEmit` 绿；② `npx vitest run test/services/quota-service.test.ts` 绿，新增用例覆盖设计 §7.5 清单全项（no-credential / cookie 空串清除 / 按 source 解析 / lastFailure 清理 / 删除顺序 / credentialSource 继承链——setEnabled 式缺省 payload 不覆盖既存显式值 / 在途 fetch 守卫含「新类型首个 fetch 不被 throttle 压制」/ 失败路径节流不断）+ §7.5 分段验收 M1 形式（带 credentialSource 的 payload 直调 configure 断言 providers.json 落盘）；③ `npx vitest run test/services/quota-cache.test.ts` 绿（removeEntry 三语义：writeChain 串行化 / memoryCache 同步删 / 幂等）；④ `npx vitest run src/services/__tests__/provider-config-helper.test.ts` 绿（新增三排序用例：cleanProviderExtras 失败→主流程仍成功+secrets 保留；extras 成功+cleaner 失败→warn-only 惰性孤儿；三落点各一条）；⑤ handler configure 分支单 payload 整对象透传 + 保留 `!data.providerId` 防御（diff 可证） | 3 批：t1 核心（quota-service + extras-store + handler + quota-cache + cache 测试，5 文件）→ t2 删除链（helper + config-service + runtime index + helper 测试，4 文件）→ t3 quota-service 测试扩用例并全量跑绿收口 |
| U3 core 契约重构 | `QuotaConfigureState` 按设计 §7.1 重写（readiness / credentialSource / saveAndTest / setEnabled / 类型草稿 / 去掩码 / loadCached reason）；`NOOP_FACTORY` 完整字面量同步 | `packages/core/src/domain/settings/quota-configure-state.ts`<br/>`packages/ui/src/features/settings/injection-keys.ts` | U1 | plain | ① `cd packages/core && npx tsc --noEmit` 绿；② `cd packages/ui && npx vue-tsc --noEmit` 绿（NOOP_FACTORY 是契约完整字面量，漏成员即编译错，即验证）；③ 契约成员与设计 §7.1 列出的成员一一对应（审查面） | 1 批 |
| U4 renderer composable 重构（M2-a） | `useQuotaConfigure` 实现新契约（齐备性判定 + 凭证归属、saveAndTest 参数构造、setEnabled 无请求、类型进草稿且同值短路、去掩码、D9 十处硬编码中文 i18n 化、loadCached 修 reason）+ core `domains/quota.ts` / mock 的 `configure` 签名切 payload（M2 原子） | `packages/renderer/src/composables/features/model/useQuotaConfigure.ts`<br/>`packages/core/src/transport/api/domains/quota.ts`<br/>`packages/core/src/transport/mock/index.ts`<br/>`packages/renderer/src/__tests__/composables/use-quota-configure.test.ts`（重写）<br/>`packages/renderer/src/__tests__/api/quota-domain.test.ts`（更新）<br/>`packages/core/src/transport/api/__tests__/domains.test.ts`（更新）<br/>`packages/core/src/transport/mock/__tests__/mock-domains.test.ts`（更新，`:452` 位置参数断言改 payload 形） | U3 | plain | ① renderer `vue-tsc --noEmit` 绿 + core `tsc --noEmit` 绿；② `cd packages/renderer && npx vitest run src/__tests__/composables/use-quota-configure.test.ts` 绿（readiness 矩阵含 D13 判定/保存规则与 D5 同值短路、凭证归属、saveAndTest payload 构造、setEnabled 不发请求（mock client 断言零调用）、无掩码、configureError 走 i18n）；③ `npx vitest run src/__tests__/api/quota-domain.test.ts` + `cd packages/core && npx vitest run src/transport/api/__tests__/domains.test.ts src/transport/mock/__tests__/mock-domains.test.ts` 绿（payload 形状断言，mock-domains 改 `quota.configure({ providerId: 'p', enabled: true })`） | 2 批：t1 实现 3 文件 → t2 测试 4 文件 |
| U5 ui 区块重写 + 浮层入口（M2-b） | `CodingPlanSection` 按设计 §7.4 重写（未选类型态 D8 / 单按钮置灰 D1 / 分段控件 D3 / 字段级提示）；`ProviderEditBody` prop 拆分 + `providerCredentialPendingSave`；`ContextCapacityPopover` 失败态补「配置」（D11） | `packages/ui/src/features/settings/coding-plan/CodingPlanSection.vue`<br/>`packages/ui/src/features/settings/provider/ProviderEditBody.vue`<br/>`packages/renderer/src/components/panel/ContextCapacityPopover.vue`<br/>`packages/ui/src/features/settings/__tests__/coding-plan-section.test.ts`（重写）<br/>`packages/ui/src/features/settings/__tests__/provider-edit-body.test.ts`（更新）<br/>`packages/renderer/src/__tests__/settings/provider-edit-body-phase-b.test.ts`（更新，真实 composable 接线）<br/>`packages/renderer/src/__tests__/panel/context-capacity-quota.test.ts`（更新，失败态「配置」入口） | U4 | plain | ① ui `vue-tsc --noEmit` 绿 + renderer `vue-tsc --noEmit` 绿；② `cd packages/ui && npx vitest run src/features/settings/__tests__/coding-plan-section.test.ts` 绿（字段级提示 / 单按钮置灰矩阵 / 分段控件 / 未选类型只渲染下拉+说明）；③ `npx vitest run src/features/settings/__tests__/provider-edit-body.test.ts` 绿（prop 拆分）；④ `cd packages/renderer && npx vitest run src/__tests__/settings/provider-edit-body-phase-b.test.ts src/__tests__/panel/context-capacity-quota.test.ts` 绿（真实接线 / 失败态刷新+配置双按钮） | 2 批：t1 组件 3 文件 → t2 测试 4 文件 |
| U6 收尾与文档回写（M3） | 清残留硬编码中文（D9 终扫）、移除 U5 接线后无消费方的旧 prop、回写 `archive/v3/coding-plan-quota/design.md:322/339` [HISTORICAL] 标注与 `docs/troubleshooting.md`、设计附录 A 处置全部落地 | `docs/page-design/archive/v3/coding-plan-quota/design.md`<br/>`docs/troubleshooting.md`<br/>（若终扫发现残留：U1/U4/U5 领地内的 quota 相关源文件，属串行尾批无并行冲突） | U2,U4,U5 | plain | ① `grep -rn` 前端 quota 相关文件无硬编码中文错误消息残留；② design.md 322/339 行带 `[HISTORICAL]` 与指向本设计的引用；③ troubleshooting.md 有对应回写；④ `node scripts/check-doc-symbol-drift.mjs` 绿；⑤ `pnpm lint` 绿 | 1 批 |

**U3/U4/U5 合并为单个 M2 原子 commit**（设计 §9.1：`QuotaConfigureState` 三方共享 + `NOOP_FACTORY` 完整字面量，契约增删成员后消费方必须同批切换）。计划初版「串行落地于同一分支即满足同一 PR」**有误**——分开 commit 会留下 ui/renderer 编译红的中间态且被 pre-commit vue-tsc 拦截；修正为三个单元工作批次分离、**一次 commit 收口**（U5 额外依赖 U4 的真实 composable，phase-b 测试）。

## 3 DAG 图

```mermaid
graph TD
  subgraph W1[Wave1]
    U1["U1 数据模型与错误规格 M0<br/>领地: shared×4 + useQuotaQuery + i18n×4"]
  end
  subgraph W2[Wave2]
    U2["U2 runtime 凭证与清理 M1<br/>领地: quota-service/handler/cache/helper/config-service/index + 测试×3"]
    U3["U3 core 契约重构<br/>领地: quota-configure-state + injection-keys"]
  end
  subgraph W3[Wave3]
    U4["U4 renderer composable + core/mock 签名 M2a<br/>领地: useQuotaConfigure + domains/quota + mock + 测试×4"]
  end
  subgraph W4[Wave4]
    U5["U5 ui 区块 + 浮层 M2b<br/>领地: CodingPlanSection/ProviderEditBody/ContextCapacityPopover + 测试×4"]
  end
  subgraph W5[Wave5]
    U6["U6 收尾与文档回写 M3<br/>领地: archive design.md + troubleshooting.md"]
  end
  U1 -->|"QuotaCredentialSource/QuotaConfigurePayload/枚举被消费"| U2
  U1 -->|"QuotaCredentialSource 进契约与 NOOP_FACTORY"| U3
  U3 -->|"实现新 QuotaConfigureState 契约"| U4
  U4 -->|"phase-b 测试消费真实 useQuotaConfigure；M2 同批原子"| U5
  U2 -->|"收尾须覆盖全部已落地改动"| U6
  U4 -->|"收尾须覆盖全部已落地改动"| U6
  U5 -->|"收尾须覆盖全部已落地改动"| U6
```

关键路径 U1→U3→U4→U5→U6 深度 5：UI 栈（类型→契约→逻辑→视图→收尾）是**真串行链**——U5 的 phase-b 测试消费 U4 的真实实现、U6 终扫须在全部代码落地后——非纯平移场景，契约先行压扁不适用（设计是行为变更，无上游行为锚点）。宽度补偿：U2（本计划最大单元）与 U3/U4 前半并行。

## 4 测试策略

命令从各包 package.json scripts 实读；vitest 一律**从子包目录运行**（项目约定）。

**增量（单元开发期，每单元收口）**：

| 包 | typecheck | 单测 |
|---|---|---|
| shared | `cd packages/shared && npx tsc --noEmit` | `npx vitest run src/__tests__/quota-credential-source.test.ts`（**订正**：shared 有独立 vitest 基建——`vitest.config.ts` include `__tests__/**/*.test.ts` + `src/__tests__/**/*.test.ts`，`package.json` 的 `test: vitest run`，`src/__tests__` 下已有 30+ 测试文件，且被根 `pnpm test` 的 `--filter './packages/**'` 覆盖；一致性审查 D-4 订正） |
| core | `cd packages/core && npx tsc --noEmit` | `npx vitest run src/transport/api/__tests__/domains.test.ts src/transport/mock/__tests__/mock-domains.test.ts` |
| runtime | `cd packages/runtime && npx tsc --noEmit` | `npx vitest run test/services/quota-service.test.ts test/services/quota-cache.test.ts src/services/__tests__/provider-config-helper.test.ts` |
| renderer | `cd packages/renderer && npx vue-tsc --noEmit` | `npx vitest run src/__tests__/composables/use-quota-configure.test.ts src/__tests__/api/quota-domain.test.ts src/__tests__/settings/provider-edit-body-phase-b.test.ts src/__tests__/panel/context-capacity-quota.test.ts src/__tests__/i18n/quota-reason-i18n.test.ts` |
| ui | `cd packages/ui && npx vue-tsc --noEmit` | `npx vitest run src/features/settings/__tests__/coding-plan-section.test.ts src/features/settings/__tests__/provider-edit-body.test.ts` |

**全量（阶段 5 Gate A）**：根目录 `pnpm test`（--no-bail 全包）+ 各触包包 typecheck + `pnpm lint`。

**测试红线**（项目 AGENTS.md）：vitest（禁 node:test）；timer 测试用 fake timers；三视角缺一不可（每条用例至少一个用户可见 DOM 断言，ui/renderer 层）；runtime 测试禁触真实数据目录（写删目标必须 `mkdtempSync(join(tmpdir(), ...))`，既有 quota-service.test.ts 已是范本）。

**Gate B（阶段 5 真实场景）**：设计 §8.2 S1-S16，`pnpm run dev` + Playwright 连 9222 执行。机器可独立执行：S4/S5/S6/S8/S10/S13/S15（反向行为 + 状态机，不依赖有效凭证）与 S16（类型往返）。需真实凭证：S1/S2/S3/S11/S12/S14 的成功路径断言——dev 数据目录若无可用的智谱/小米/opencode 凭证，列为 blocked 上报用户，不伪造通过。

## 5 合理偏差登记表

| 编号 | 偏差 | 设计出处 | 判定为合理的理由 | 落地形态 |
|---|---|---|---|---|
| R1 | 改动 4 的 `lastFailure.delete` / `cache.removeEntry` 锚定 **persist 成功**，而非设计字面「configure 成功后」 | §7.3 改动 4 | secrets 段失败返回 error 但**不回滚 persist**（设计 :781 登记的半提交方向）；若清理延后到 secrets 之后，该路径会漏清理——persist 已提交新 fetcher 而旧类型缓存行仍在，旧行会以新类型标签展示（正是改动 4 要消除的现象） | `quota-service.ts:316-319`（清理块在 `ensureSecretsDir`(:323) 之前），注释写明判定依据。**注：初版实现把清理块排在 secrets 段三个早退之后，与 R1 声明不符（一致性审查 U-runtime-1 报出），已在阶段 4 修复并补半提交断言用例（mutation 验证：把清理块移回 secrets 之后 → 新用例变红），commit `ec6ea70ce`** |
| R2 | 存在性检查移进 `extrasStore.modify` 回调后，file-lock 的 `ensureFileExists` 在加锁前无条件物化空的 providers.json；两个「provider 不存在」用例的 extras 文件断言由 `false` 翻转为 `true`（并新增 `providers[pid] undefined` 断言） | §7.3 :769 指定方案 | 物化机制是 file-lock 既有行为（`provider-extras-store.ts:86-103` 锁前 ensure），**但经本次改动在「拒绝保存」这条路径上变为可达**（旧检查在 `modify` 之前直接 return、从不触文件；订正自一致性审查 D-runtime-4——初版 R2 理由「非新增副作用」不准确）：新增副作用面 = 一次被拒绝的保存会创建一个空 providers.json；僵尸 quota 条目**未产生**（回调抛 ProviderGoneError → 写入跳过），正是该检查的目标 | quota-service.test.ts:266 区域 / provider-write-side-switch.test.ts:101 断言方向更新 |
| R10 | cookie 空串清除 / apiKey 清除 / `clearProviderState` 三处删除语义收敛为单一 helper `removeSecretFile` | §7.3 改动 2「两处必须一致」+ 改动 5「幂等：ENOENT 视为成功，不做 existsSync 预检」 | 三处一致性由「清单纪律」升级为「结构保证」（ENOENT/非 ENOENT 分支只有一处实现），未改变任何设计声明语义 | `quota-service.ts:378-389`，调用点 `:359-362` / `:400-403` / `:797-798` |
| R11 | 收尾 helper 取「守卫 + `lastFetchTime` 单点、`cache.update`/`lastFailure` 以 commit 闭包由出口自带」形态（(而非把三件套全部内联进 helper） | §7.3 改动 4「五出口的守卫与三件套写收口为单一收尾 helper」 | 达成同一目标（新出口不经 helper 即不写时间戳，遗漏在结构里可见），且避免 helper 退化为按出口分支；守卫与时间戳对所有出口同构，故只这两项上提 | `quota-service.ts:616-630`（helper）、出口 ②-⑤ 各自传 commit 闭包 |
| R12 | fetcher 变更锚点 `prevFetcher` 显式在 **persist 之前**读，并注释说明读点不可后移 | §7.3 改动 4「若本次 fetcher 与既存值不同 → 清该 provider 的条目」 | 设计未规定读取时点；persist 后再读即新值、比较恒相等、清除永不触发（改动 4 完全失效）——是对设计意图的必要精确化 | `quota-service.ts:298-299`（读点）、`:327-329`（比较与 removeEntry） |
| R3 | 既有用例断言方向随设计行为变更翻转（`no-credential` reason 断言、「专属 Key 优先」用例补 `quota.apiKeySet: true` mock、`persist 失败 → secrets 不触碰`、4 个用例补 `providerExists: () => true` 注入） | §7.3 改动 1/2（行为变更本身） | 每条都是设计行为变更的必然后果；mock 注入对齐生产形态（生产 index.ts:723 恒注入聚合层判定）；用例覆盖范围与断言目标未变 | U2-t1 deviations 逐条登记（quota-service.test.ts 等 3 文件） |
| R4 | `providerCredentialPendingSave` 实现为 **carry-in 可写 ref**（composable 不自算） | §7.4（证据来源 = provider 表单草稿 `form.apiKey`） | composable 工厂签名（U3 冻结）为 `(preset, providerRef)` 两参，看不到 provider 表单草稿；U3 契约文件不在 U4 领地，本批不可扩参。语义由 U5 接线达成 | 初始 false 的 ref；**U5-t1 已接线**：`ProviderEditBody.vue:365` import `API_KEY_CLEAR_SENTINEL`、`:477` `watch(form.apiKey, immediate)` 计算（排除哨兵）；U5-t2 补哨兵排除用例 |
| R5 | `workspaceConfigured` / `providerCredentialAvailable` / `quotaApiKeyConfigured` 实现为**基于 `providerRef` 快照的 computed** | §7.1 契约只要求 `Ref<T>` | `Readonly ComputedRef` 兼容 `Ref<T>`；派生消除「同一事实两份可变状态」的失真面（广播后自动跟随磁盘真相），语义与 §7.4/§11 的证据来源一致 | `useQuotaConfigure.ts` computed 派生 |
| R6 | `cleanProviderExtras` 在 **`extrasStore` 未注入**时返回 `false`（设计只定义了「删除成功/条目不存在 = true；IO 异常 = false」两态） | §7.3 改动 5（boolean 失败信号） | 无法确认 extras 标记已清时取保守方向（宁留一致残留，不造幽灵标记）；生产恒注入（`index.ts:285`），该分支仅测试可达；对既有直调删除链测试零行为影响 | `provider-config-helper.ts:1284`；三处落点共享 `cleanDeleteTail`（`:1308-1322`，设计 §7.3 明确许可抽共享尾函数） |
| R7 | 凭证来源分段控件用**两个既有 `Button` 组合**（ghost + `aria-pressed` + 选中态），未新增 ui 原语 | §7.4（分段控件） | `packages/ui/src/primitives` 无 Tabs/ToggleGroup，方案 B 的分段控件是新元件；用现有原语组合、视觉对齐 demo-b 的 `.seg`，避免为单点需求新增设计系统原语 | `CodingPlanSection.vue:89-107`（`role="group"` + `aria-pressed`，无原生表单元素） |
| R8 | 「已配置 / 必填」badge 用新 key `quotaConfiguredBadge` / `quotaRequiredBadge`，**未复用** cookie 专用的 `quotaCookieSet` / `quotaCookieNotSet` | §7.4（字段级提示） | 该 badge 同时用于 cookie / 专属 Key / workspace 三类字段，cookie 命名会误导；术语一致性优先 | 21 个新 locale key 的一部分（U5-t2 补齐） |
| R9 | 类型下拉 update 事件加**运行时 guard**（`typeof value !== 'string'` 直接 return），替代 `String($event)` 强转 | 项目规范（禁 any / 断言须有运行时 guard） | `String(undefined)` 会产出 `"undefined"` 这一看似合法的类型值，让 readiness 误判为已选类型 | `CodingPlanSection.vue` 的 `onSelectFetcher` |

## 6 状态表

| Unit | 状态(pending/in-progress/committed/blocked) | 轮次 | 证据指针 |
|---|---|---|---|
| U1 | committed | 1 | t1: shared/core/runtime `tsc --noEmit` 三绿 + `quota-credential-source.test.ts` 5/5（新文件，按 shared `__tests__` 惯例条件授权）；t2: renderer `vue-tsc --noEmit` 绿（穷举映射完备即编译过）+ `quota-reason-i18n.test.ts` 8/8 + locale-sync 163/163；deviations 4+3 条全为注释级/边界声明，无机制偏离。commit `858fe45c5` |
| U2 | committed | 3 | t1（核心改动 1/2/3/4/6 + 签名切换 + 顺序重排）：runtime tsc 绿、5 文件 73/73；t2（删除链三落点 + `cleanDeleteTail` + 组合根回填 `index.ts:734`）：helper 39/39（+6）、回归 60/60 + 49/49；t3（13 条新用例）：quota-service 49/49、8 文件 167/167。五出口覆盖逐行登记（`finishFetch` 收口，`!fetcher`/失配不写）。commit `7304a152e` |
| U3 | committed | 1 | 契约移除 7 / 新增 7+1 逐条对 §7.1 两表；core tsc 绿；injection-keys 零错误（NOOP_FACTORY 完整字面量编译器级对齐）；消费方红仅 ProviderEditBody.vue（U5 领地，设计用编译错强制切换）。随 M2 原子提交 `66d415f41` |
| U4 | committed | 2 | t1（composable 重构 + core/mock 签名切 payload）：ProviderEditBody 外零编译错、readiness 逐条对 §7.2、payload 快照在 await 前（`:349`→`:364`）、setEnabled 双键（`:298`）；t2（测试重写 + 修 2 条签名断言 + 补 2 个 i18n key）：core 整包转绿、core 96/96、renderer 44/44、locale-sync 163/163、165 个 key 引用 0 缺失。随 M2 原子提交 `66d415f41` |
| U5 | committed | 2 | t1（组件重写 3 文件，ProviderEditBody 7 条契约红清零、renderer vue-tsc 全绿、单按钮 `quota-save-test-btn` 就位、哨兵排除接线、D11 双按钮）：eslint 零输出、行数合规；t2（21 key 双语 + 4 测试文件收敛 + search-modal 存量红微修）：ui 77/77、renderer 198/198、**ui 与 renderer vue-tsc 双绿**。随 M2 原子提交 `66d415f41`（存量红微修独立提交 `82b31b736`） |
| U6 | committed | 1 | D9 终扫 13 个 quota 源文件零残留（未改源码）；无孤儿 prop/emit（26 props/7 emits、3 props/5 emits 逐条核消费）；附录 A 四处 `[HISTORICAL]` 标注逐条对上（design.md:322/339/340/382）+ troubleshooting.md 新增 §13；i18n 断言缺口补 2 条（171/171）；doc-symbol-drift 绿；ui+renderer vue-tsc 绿。commit `7f676e961` |

## 7 残留风险与变更历史

**残留风险**：

1. ~~设计 §11 检查点 5（存量幽灵文件差集探针）是 ⛔ 实施期门——U2 落地后跑一次性只读脚本对 dev 数据目录求差集，结果记入本节。~~ **已执行（U1 期，2026-09-10，只读探针）**：严格差集（quota 行存在 ∧ `apiKeySet` 未设 ∧ `*-apikey.txt` 文件在 = 升级后静默切 provider 凭据的集合）在 `~/.xyz-agent-dev` 与 `~/.xyz-agent` **均为空**；幽灵标记两向（`apiKeySet=true` 无文件 / `cookieSet=true` 无文件）均空。唯一残留：dev 目录存在 `zhipu-router-apikey.txt` 孤儿文件（provider 条目已不存在，属已删 provider 的 secrets 残留 = D12 修复的历史实例），新逻辑下无人读取（`'provider'` 来源不读该文件），惰性无害。**判定：无需编辑体提示，检查点关闭。**
2. 设计 §11 检查点 1（`provider.apiKeySet` 聚合不区分凭证类型）依赖 S11② 真实验证——若凭证不可得，登记为待验并上报。
3. Gate B 凭证依赖场景（§4）可能部分 blocked——逐场景登记，不静默跳过。
4. ~~**U1-t2 发现的前批遗留缺口**：`quota-reason-i18n.test.ts` 的两个断言数组历史上就不含 `not_configured` 的 key（`quotaFetchFailNotConfigured` / `quotaFailNotConfigured`——locale 双侧存在但断言数组缺）→ 归 U6 终扫批补齐。~~ **已关闭（U6，commit `7f676e961`）**：两个 key 补入断言数组，`quota-reason-i18n.test.ts` 8/8 + locale-sync 163/163 绿。
5. ~~**ui 包存量编译红（疑似与本设计无关，U3 期发现）**：`packages/ui/src/overlays/__tests__/search-modal.test.ts:386/391/396` 三处 TS18048。~~ **已关闭（独立微修 commit `82b31b736`）**：逐字节确认与 HEAD 相同 = 存量红，用运行时 guard 修复，ui vue-tsc 整包转绿。
6. **设计阶段 demo 资产的存量 lint 红**（U6 期发现，Gate A 阻塞项）：`docs/design/coding-plan-quota-ux.demo.js:120`（`onChange` 未使用）+ `:155`（短路表达式语句）两个 error，由设计批 `8766d71d3` 引入、非本次实现代码。U6 续做批处理中（禁 eslint-disable）。

**变更历史**：

- 2026-09-10 计划创建（基线 4b42f85a2）。与设计 §10 的两处计划级澄清（非偏差，是精确化）：① 测试清单中 `quota-service.test.ts` / `provider-config-helper.test.ts` 实为**扩既有文件**（36 用例 / 既有文件），`quota-cache.test.ts` 为新建；② D9 十处硬编码中文的**执行点归 U4**（文件即 U4 重写对象），U6 保留终扫职责（设计 §10 把「清硬编码中文」写在 U6，§7.5 文件地图与 D9 行号证明其实际落点在 U4 领地）。
- 2026-09-10 **M2 原子性修正（U3 期发现）**：U3/U4/U5 由「串行三次 commit」改为**单次原子 commit**——契约与消费方分开提交会留下编译红中间态并被 pre-commit 拦截，与设计 §9.1「M2 必须原子」一致。单元工作批次不变，状态表三者同轮收口。
- 2026-09-10 U3 验收条款②「ui vue-tsc 绿」按原子性修正重述为「injection-keys/quota-configure-state 自身零错误 + ui 红仅剩 U5 领地的 ProviderEditBody.vue」（消费方红是设计用编译错强制切换的机制，非缺陷）。
- 2026-09-10 **U2 领地追溯授权 + 落批裁决（U2-t1 上报 blockers）**：① `quota-service-workspace.test.ts` / `provider-write-side-switch.test.ts` 两个 configure 直调消费方补入 U2 领地（机械签名更新，不补则 tsc 不可能绿）；② 设计 §7.3 改动 2 的「删除顺序重排（先校验计算 → persist → 成功后写/删 secrets）+ provider 存在性检查移进 `extrasStore.modify` 回调」归 U2（计划 U2 职责行「删除顺序重排与失败语义」本已声明），指派原 dev 会话续聊定向实施，随附既有「persist 失败 → secrets 不回滚」用例断言方向翻转。
