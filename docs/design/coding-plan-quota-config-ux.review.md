# 设计文档审查报告（r4）· coding-plan-quota-config-ux.md

审查依据：`~/.agents/skills/tech-design/review/rubric-design-doc.md`（主审归口：P0-1~P0-11、P0-13~P0-18、P0-21、全部 P1）
审查快照：文档 v4（1076 行）。聚焦：① r3 的 1 must-fix + 4 suggestion 修复是否成立；② 新机制（payload 分期、删除链排序、`removeEntry` 语义、继承链）能否被新反例击穿（A1-A5）；③ 交叉引用一致性终检。已确认项不重查。

## Summary

0 must-fix, 1 suggestion.

（r3 全部 5 条已核实修复成立；本轮唯一新发现是 M2 原子切换漏了一处调用方，属测试清单完备性，不阻塞。）

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| SUGGESTION | §7.5 文件地图 + 测试改动清单（doc:877-940）+ §9.1 M2（doc:991） | P0-11 事实 / 调用方穷举（新发现，A1） | **M2 的「同批原子切换」漏了一处调用方**：`packages/core/src/transport/mock/__tests__/mock-domains.test.ts:452` 的 `expect(await quota.configure('p', true)).toEqual({ ok: true })` 用的是**位置参数**。M2 把 mock 签名切为 `(payload: QuotaConfigurePayload)` 后：① 该调用成为类型错（2 参对 1 参），但 pre-commit 的 vue-tsc 只查 `packages/renderer`（且 `exclude src/**/__tests__`），core 的测试文件**不在任何已声明的编译门内**；② 运行期它**仍然通过**（新 mock 收到 `'p'` 当 payload、忽略参数、照返 `{ok:true}`）—— 类型坏 + 测试假绿双重隐形，与 v3「handler 静默丢字段」同一族。该文件既不在 §7.5 文件地图，也不在测试改动清单（清单里有 `domains.test.ts` / `quota-domain.test.ts`，没有它）。另注：§7.5 mock 行的「`renderer/src/api/index.ts:55` 门面三元要求两侧同构」是**约定级**而非编译级（该三元只在有人经门面调用 `configure` 时才约束，当前无任何调用方经门面调它；`mock-domains.test.ts` 头注释「各域签名同构（facade 三元）」正是这条约定的测试形态）——结论不变，mock 仍应改，但守门依据应如实写 | 把 `mock-domains.test.ts` 加进 §7.5 测试清单（M2 批次，断言改 `quota.configure({ providerId: 'p', enabled: true })`）；mock 行的守门表述改为「同构是项目约定（mock-domains.test 的存在理由），非编译强制」 |

## r3 findings 复核（全部成立）

| r3 finding | 复核结论 |
|---|---|
| MF §4.1 路径 | **已修**：图改为 `<dataDir>/pi/agent/config/providers.json`（doc:211），图注补 `getDataDir()` 推导 + ADR-0009 隔离 + `shared/src/paths.ts:36-51` 引用（doc:240），与 `pi-paths.ts:32-35/61-69/101-103` 实测一致 ✅ |
| S1 Workspace 草稿误清 | **已修且论证充分**：§7.2 细节 2 改为「只清凭证草稿（Cookie/专属 Key），Workspace 不清」，理由（明文回显字段非凭证 / 凭证清空的理由对它不成立 / 清它制造「磁盘有屏幕无」）成立；细节 3、D13 采用、D5 代价、S16 opencode 变体四处交叉引用齐备；附录 B 把原型未跟进此修订登记为第 3 条局限（demo-b 的 `:203` 实为 `:195` 一带，行号小偏移）。**含广播序列的自洽性见 A2，成立** ✅ |
| S2 M1/U1 可执行 + payload 收敛 | **已修且采纳方案性建议**：①分段验收改写为「M1 用 runtime 单测直调 `QuotaService.configure` 断言落盘 + 继承链不覆盖显式值；段 3 由 M0 编译错守门；段 4 由参数数编译错守门；段 1-2 由 M2 的 S9 闭环」（doc:919-924）—— 与各阶段能力对齐，可执行 ✅；②`QuotaConfigurePayload` 四处共用 + handler 整对象透传（doc:587-604），端到端链守门列改写，v3 唯一「不报错静默丢字段」段结构性消除 ✅。**残留**：mock-domains.test.ts（本轮唯一新发现） |
| S3 credentialSource 写侧 | **已修**：新增改动 6 —— 继承链落盘 + 写侧禁用 `resolveQuotaCredentialSource`（含 `incoming ?? resolve(current)` 的反例），§7.2 参数表 credentialSource 行、§7.5 quota-service 行、M1 单测用例（「其余键缺省」payload 不覆盖既存显式值）三处同步 ✅ |
| S4 幽灵标记进入路径 | **已修**：删除链排序（`clearProviderState` 仅在 `cleanProviderExtras` 成功后执行，后者需返回 boolean 失败信号、warn-only 不变），两个残余方向按四要素登记（D12 代价块），「读时自愈」进被否并给减法理由；改动 1 影响面「幽灵标记」行的量级补排序保证 ✅ |

## 攻击点逐条回答（A1-A5）

| # | 结论 |
|---|---|
| **A1**（payload 分期每阶段断言） | **M1 wire 兼容成立，逐字段核实过**，且比修订摘要枚举的还要多两处：旧 renderer 不只发「undefined」—— `saveApiKey` 清除时发 **`apiKey: ''`**（`useQuotaConfigure.ts:315-322`）、`saveWorkspace` 清除时发 **`workspace: ''`**（`:357-364` 的 normalize 返回 `''`）。两者在新 runtime 下语义不变：`''`-清专属 Key 的分支被改动 2 保留（只修 fail-fast），workspace 的 `''`-清除 D13 明文保留给直接调用者 → **零行为差成立**。`cookie: ''` 旧 UI 从不发（客户端拦截），属改动 2 已登记的不可达路径。`enabled` 恒传 ✓、`fetcher` undefined → 继承 ✓。**M2 原子性**：漏了一处调用方 —— `mock-domains.test.ts:452`（见 Findings）。其余 composable 无（全仓 grep：`quotaApi.configure` 仅 `useQuotaConfigure.ts` 5 处，全部在 U4 重写范围内；门面 `@/api` 的 `quota` 导出无人调用 `configure`） |
| **A2**（Workspace 草稿 × 广播重置） | **自洽**。完整序列推演：①类型切换只写草稿、不发 RPC → 不触发广播 →「不清」生效；②外部广播 → `syncFromProvider` 把**全部**草稿重置为磁盘态（fetcher 回磁盘类型、workspace 回磁盘值）—— 在 D13「屏幕即真相」语义下，重置 = 回显，方向正确；③用户未保存的 workspace 编辑被广播丢弃，与 Cookie 输入同属时序约定 2 已登记的代价类（该条量级行只提了 Cookie，建议顺手补「workspace 草稿」三个字，非阻塞）。**S16 opencode 变体不含广播，仍成立**：切走再切回后 workspace 草稿保留（磁盘回显值）、`typeChanged` 回 false、cookieSet 计入 → 按钮亮、无需重填 ✅ |
| **A3**（继承链 × 恒传 × D3 采用 5） | **自洽**。saveAndTest 恒传显式值 → 继承链覆盖落盘；setEnabled 键缺省 → 继承既存；「切换来源只改这一个字段」描述的是**磁盘净效果**（其余键的落盘值不变：cookie 仅 typeChanged 才 `''`、apiKey 恒 undefined、fetcher/workspace 传同值）→ 三者无矛盾。legacy（models.json 旧寄生 quota）不含新字段 → 继承链第三跳恒 miss，无害 ✅ |
| **A4**（表 A 16 行终检） | **全表一致**：#4/#5（clearProviderState + 排序约束）、#8/#9（removeEntry + 三条语义）、#10（成功 fetch + configure 成功 + 删除三通道）、#11（clearProviderState）均与改动 4/5 正文逐格对齐；#1/#6/#12/#13/#14 未变且与正文一致；「加粗 5 项」与表内标记吻合；§7.1 缓存表删「清空 Cookie」行的归并论证成立（参数表规定 `cookie: ''` 仅在 typeChanged 出现，被类型变更行全覆盖）✅ |
| **A5**（§8 计数与阶段归属） | **一致**：S1-S16 共 16 个，标注反向的 S4/S5/S6/S8/S9/S10/S13/S15 共 8 个，与章首「16 个 / 8 个反向」吻合（S16 的 opencode 变体折叠进原行，未加计数，正确）；M2 = S1-S10 + S11① + S12/S13/S15/S16，M1 = S11② + S14 → 16 个场景全部有归属 ✅ |

## 新机制复核（被反例攻击后的结论）

| 机制 | 结论 |
|---|---|
| `QuotaConfigurePayload` 收敛 + 分期（M0 类型 → M1 service/handler → M2 core+mock+renderer） | **成立**。逐项实测/推理核对：M0 旧调用缺新键合法（全键可选）✓；M1 旧 wire 对象是合法 payload（含 `''` 语义保留，见 A1）✓；M2 先切一侧即编译错（少参调用多参目标不报错、多参调用少参目标报错 —— 旧 6 参调用对新 1 参签名是参数数错）✓；「4 个同构 `string \| undefined` 互相错位不报错」的动机论证属实 ✓ |
| 删除链排序（clearProviderState 后置 + cleanProviderExtras 返回 boolean） | **成立**。两个残余方向（一致残留 / 惰性孤儿）四要素齐备；孤儿惰性判据（无条目 ⇒ 兜底 `'provider'` ⇒ 改动 3 跳过；cookie 孤儿仅在不再保存时被 fetch 读到旧平台值 ⇒ 可诊断）与改动 3/改动 2 的机制对得上 ✅ |
| `QuotaCache.removeEntry` 三条语义 | **成立，且两条失效方向的论证与实装结构吻合**：`writeChain`（`quota-cache.ts:91`）串行化 ✓；`getEntry`（`:67-82`）内存 miss 会从磁盘重载 ⇒「只删磁盘」被内存镜像继续供旧值、「只删内存」被下一次 miss 重载还原 —— 两个方向的复现路径都真实存在，三条语义缺一不可 ✓ |
| 改动 6 继承链 | **成立**（见 A3）；M1 单测用例（键缺省不覆盖显式值）已进测试清单 ✅ |
| 并行变更适配（credentialResolver） | **属实**：当前 `quota-service.ts:585-600` 的 api-key 分支 = 专属 Key 优先 → `credentialResolver.resolveProviderCredential`（`getApiKeyForProvider` 已不在 `pi-provider-store.ts`），§3.2-D 现状片段与 §7.3 改动 3 片段均与实装一致，「专属 Key 仍无条件优先、失败模式 D 判定不变」成立 ✅ |

## 交叉引用一致性终检

| 联动点 | 结论 |
|---|---|
| 端到端链 8 段 ↔ §7.5 表格行 | 一一对应且守门列已按 payload 收敛改写（段 4 从「静默丢字段」改为「参数数编译错」；段 1 明确为「不报错，靠 S9 兜底」）✅ |
| §7.2 细节 2/3 ↔ D13 采用 ↔ D5 代价 ↔ S16 | 四处均含「Workspace 草稿不清」的交叉引用，无残留旧表述 ✅ |
| §7.1 缓存表 ↔ 改动 4 | 删行归并论证成立，`setEnabled(false)` 清 `lastFailure` 经「configure 成功」覆盖 ✅ |
| §9.1 各阶段 ↔ §7.5 归属单元 ↔ §8 场景 | M0/M1/M2/M3 与 U1-U6 的 payload 相关条目（protocol=U1、service+handler=U2、core domain+mock=U4/M2）一致；场景归属全覆盖（A5）✅ |
| 附录 B/C | 附录 B 登记原型第 3 处局限（workspace 草稿被原型清空、实施以文档为准）；附录 C v4 条目与实际修订一一对应 ✅ |
| 正文决策（采用/被否/证据/效果） | D12 新增「读时自愈」被否条目含减法理由；D13 采用/被否/代价与细节 2/3 一致 ✅ |

## 已核查通过的其余检查项

P0-1~P0-11、P0-13~P0-18、P0-21 与 P1 各项（五段骨架、结论先行、四方案对比、真实场景验收 16/8、S5 ⛔ 带降级路径、S13 宿主不变、物理数据流图路径正确、错误恢复指引、拆分 justification、决策 item 化）—— 本轮无新违反。

## INFO（不影响决策的机械性细节，不计数）

- 行号漂移（并行变更所致，语义均成立）：`quota-service.ts` 整体 +10 左右（`doFetch` 现于 `:478-489`、`getCredential` `:585-600`、`persistQuotaConfig` `:391-432`、`writeCookieSecret` `:319`）；`use-provider-edit.ts` 的 `API_KEY_CLEAR_SENTINEL` 现于 `:153`（文档引 `:166`）、清除写入点 `:564`（引 `:578`）、`resolveApiKeyForSave` `:162`（引 `:501`）；`demo-b.html` 清草稿在 `:195` 一带（附录 B 引 `:203`）；mock `configure` 在 `:1309-1313`（§7.5 引 `:1310-1312`）。
- §7.5 mock 行「门面三元要求两侧同构」的表述精度问题已并入本轮 Suggestion 的修复方向，不另计。
