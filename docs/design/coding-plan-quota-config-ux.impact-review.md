# 影响面审查报告（r2）· Coding Plan 额度查询配置交互重构（方案 B · v2）

> 审查对象：`docs/design/coding-plan-quota-config-ux.md` v2（整体重写后重新 read 全文）
> 审查归口：**P0-12 / P0-19 / P0-20**（`~/.agents/skills/tech-design/review/rubric-design-doc.md`）；P0-1~P0-11、P0-13~P0-18、P0-21 归主审，不重复判定，线索标 INFO 交接。
> 方法：逐条 read 源码核实新机制（D3 持久化来源解析 / D5 草稿 + 凭证归属 / D11 浮层入口 / D12 清理链与注入点 / D13），不采信文档自述。

## Summary

2 must-fix（均为**新发现**）, 6 suggestions（5 新发现 + 1 承接 r1 残余）。

结论：r1 的 6 个 must-fix 中 **4 个已完全修复**（MF-1 / MF-3 / MF-4 / MF-5），MF-2 的核心已修但「把存在性检查提前」引入了**新的 TOCTOU 反例**，MF-6 基本修复但恢复路径 ② 缺限定条件。新机制本身**被核实成立**（D3 两端同源、D5 草稿消除了「切类型即销毁」、D11 不新增写入），但 **D12 的落地文件不在 §7.5 文件地图内**（漏注入会静默 no-op），**D12 与 configure 的并发窗口会复活僵尸 quota 条目**（D12 声称关闭的 M5-05 缺口在并发下不成立），且 **D12 是本版唯一没有「已知代价（量化）」块的破坏性决策**。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX（新发现） | §7.5 文件地图 / §7.3 改动 5 | P0-12 遗漏连带改动 · P0-19 ③ | D12 落地需要改的三个文件都不在 §7.5 里：① `packages/runtime/src/services/provider-extras-store.ts`（`ProviderExtras.quota` 必须加 `credentialSource`，否则 `persistQuotaConfig` 的嵌套对象字面量对 `ProviderExtras['quota']` 触发 excess property check 编译错）；② `packages/runtime/src/services/config-service.ts`（§7.3 改动 5 明说要加构造函数可选依赖）；③ `packages/runtime/src/index.ts`（组合根注入点：`configService` 在 `:264` 构造、`quotaService` 在 `:696` 构造，注入必须在 `quotaService` 存在之后，须用惰性闭包或 `setCredentialWriter`（`:147-151`）式回填）。**失败模式**：可选注入的既有语义是「未注入 = no-op」（`config-service.ts:117`、`:127` 注释），漏掉 ③ **不会编译报错**，而是生产环境删除 provider 时 `clearProviderState` 根本不执行 → D12 的效果归零（只有 S14 能抓到）；漏掉 ① 编译红但不在实施清单上。另 `ports/config.ts:27-40`、`pi-provider-store.ts:71-83` 是同形状的兼容声明，建议一并列出保持镜像同步 | §7.5 补 3 行（归 U2），§7.3 改动 5 写明注入点与 TDZ 安全的回填方式；四处 quota 形状声明的同步列入 U1/U2 |
| MUST_FIX（新发现） | §7.3 改动 2「providerExists 提前到 configure 开头」+ §6.13 D12 | P0-19 ③ 清理通道保证 | 存在性检查（`index.ts:704` 的 `configService.listProviders().some(...)`）与实际写盘之间是 TOCTOU 窗口，**把它提前到 configure 开头等于把窗口拉大**。`XyzProviderStore.modify` 的 mkdir 锁只锁 providers.json 文件（`provider-extras-store.ts:77-83`），不锁 provider 存在性；删除链的 `cleanProviderExtras` 用同一把锁（`:1204-1216`），于是**谁后拿锁谁生效**。**失败模式**（需并发删除 + 保存额度配置）：T2(configure) 开头检查通过 → T1(removeProviderByKind/deleteProvider) 完整跑完（models.json 条目删、auth.json 清、extras 清、secrets 清）→ T2 的 `persistQuotaConfig` 后落盘 → providers.json **复活一条 `quota{enabled:true, cookieSet/apiKeySet:true, fetcher}` 僵尸条目**（custom 已不在聚合列表故界面不可见，catalog 重导入后可见），随后 T2 的 secrets 写入把刚被 `clearProviderState` 删掉的文件重建；此后**同 id 重建**时 `readiness` 因 `¬typeChanged ∧ cookieSet` 判为齐备 → 直接复用被删 provider 的旧 cookie —— 正是 D12 声称关闭的 M5-05「同 id 重建不静默继承」缺口。§7.3 又写「三个清理点并列执行」，使 secret 清理与 configure 的 secret 写入顺序更不确定 | 把存在性检查移进 `extrasStore.modify` 回调内（与 `cleanProviderExtras` 同锁串行）——这样锁后到者看到的是真实删除态；或让删除链在 `clearProviderState` 之后再收口一次。若判定不修，必须按 P0-20 登记该窗口（量级/恢复路径/重审条件），不得静默带过 |
| MUST_FIX（新发现） | §6.13 D12 | P0-20 已接受代价未量化 | D12 是本版**唯一引入不可逆删除却没有任何「已知代价（量化）」块**的决策：D5（§6.6）、D10（§6.11）、D13（§6.14）都有四要素，D12 只有采用/被否/证据/效果。而它删除的是用户从浏览器取的凭据。**失败模式**：catalog provider 的「移除」按定义可以重新导入恢复（`removeProviderByKind` catalog 分支只清用户侧状态、定义在 pi 二进制内，`provider-config-helper.ts:1285-1325`），但 `<pid>-cookie.txt` 是用户粘贴的凭据，**重新导入无法恢复，只能重贴**；D5 的代价块只覆盖「类型切换」，未覆盖「切了类型 + 之后 provider 被删」的组合。用户视角的代价（"我只是移除再导入，Cookie 就没了"）在文档里无处可查 | §6.13 补四要素：量级（每次 provider 删除/移除一次，catalog 移除尤其）、恢复路径（重新从浏览器取 Cookie；catalog 重导入不恢复凭据）、重审触发条件（若出现「误删 provider 后凭证丢失」反馈，评估给移除加确认或非幂等删除）、显式判定 |
| SUGGESTION（新发现） | §7.1 契约变更表 | P0-12 接管点内部步骤 | D5 把类型改为草稿，但移除表列了 `toggleEnabled` / `saveCookie` / `saveApiKey` / `saveWorkspace` / `testQuery`，**唯独没列 `selectFetcher`** —— 而它的现有实现正是「异步 `quota.configure` 持久化 fetcher」（`useQuotaConfigure.ts:199-222`）。若实施者按表保留它，类型下拉仍然即时落盘 → D5 未落地，且会把 D5 被否理由里那条「reka 同值 emit 也触发落盘」的风险原样带回来 | 移除表补一行「`selectFetcher`（异步持久化）→ 同步草稿写值」，或在新增表写明 draft setter 的成员名 |
| SUGGESTION（新发现） | §7.1 缓存清理副作用表 行 3 | P0-12 机制不达目的 | 行 3 声称「类型变更时清 renderer 缓存」可避免「旧类型三窗口数据当新类型结果渲染」，但该理由不成立：清掉 renderer store 后 `syncFromProvider → loadCached`（`useQuotaConfigure.ts:156-158`）走的是 `quota.getCached`，读的是 **runtime `QuotaCache`**（表 A #8 自己承认「无删除通道（磁盘条目永久保留）」），旧行会立刻被重新取回并渲染。此外 `configure` 成功后 `broadcastProviderList` 触发 `syncFromProvider`，与紧随的 `quota.refresh` 有时序竞争：refresh 失败时旧行会经「查看上次成功数据」以**新类型的窗口标签**展示（`CodingPlanSection.vue:264-269`）。同一表也未声明 `saveAndTest` 在何时捕获草稿 payload，而任何 provider 列表广播都会经 `syncFromProvider` 重置草稿（类型选择、正在输入的 Cookie 都会被清） | 更正行 3 的理由，或把失效点下移到 `loadCached`（`typeChanged` 时忽略 `getCached` 的 `data` / 置 `testStatus='idle'`）；补一句 payload 捕获时点与草稿被广播重置的预期 |
| SUGGESTION（新发现） | §7.3 改动 2 | 交叉引用自相矛盾 | 改动 2 要求 cookie 空串「对齐 `writeApiKeySecret`（`:325-349`）的**既有**清除分支」，而紧跟的 (a) 又把该分支改成 fail-fast —— 同一节引用同一份代码的两个版本。cookie 路径的失败语义不是被写死的，而是引用的；实施者若照抄「既有」版本，会复现 r1 的 MF-2（unlink 失败被吞、仍报 `cookieSet=false`，而 D5 的作废效果与该标记绑定） | 改动 2 直接写死 cookie 的失败语义（对齐 **修正后**的 `writeApiKeySecret`：删除失败 fail-fast 返回 error），不靠对另一段待改代码的引用 |
| SUGGESTION（新发现） | §4.2 / §11 | P0-12 向后兼容/迁移 | 升级到 v2 时，存量「`apiKeySet` 为 false/未设置但 `<pid>-apikey.txt` 存在」的幽灵文件会被 `resolveQuotaCredentialSource` 兜底解析为 `'provider'` → 有效凭证从专属 Key **静默切换**为 Provider 凭据（查询账号与数值可能变化）。该状态恰是文档自述的「先写文件后 persist 的失败方向」（§7.3 改动 2 的登记项）在存量数据里的形态，但 v2 上线时对它没有任何处置登记（§4.2、§11、§8 都没有）。对照：正常历史数据（apiKeySet=true + 文件在）兜底为 `exclusive`，行为与今天一致 ✅ | §11 增一条迁移检查点（或明确「该切换就是目标行为」并说明用户在界面上如何察觉——分段控件会显示 `provider`） |
| SUGGESTION（新发现） | §7.2 + §11.4 | P0-19 ① 新反例 | `typeChanged = draft.fetcher !== savedFetcher`（§7.2 细节 1「唯一判据」），但草稿初值来自 `p.quota.fetcher ?? preset.value?.fetcher`（`useQuotaConfigure.ts:146`）—— 于是 `savedFetcher === undefined` 的 provider 恒被判为「类型已变」：① 若它在磁盘上还带着 `cookieSet=true`，界面会把有效凭证当成「归属失效」要求重贴；② 若草稿落在 api-key 类，参数表规则会让 `cookie=''` 执行一次**用户从未请求的删除**（该路径下 readiness 不检查 cookie，所以会被放行）。这与 D5 声明的「按凭证归属作废」语义不符（无既存归属 ≠ 归属失效） | 判据改为 `savedFetcher !== undefined ∧ draft.fetcher !== savedFetcher`，或为「无既存归属」单独定义语义（此时既存 `cookieSet/apiKeySet` 该如何处置也一并写明） |
| SUGGESTION（承接 r1 MF-6 残余） | §6.11 已知代价 恢复路径 | P0-20 恢复路径 | 恢复路径 ②「`credentialSource` 改变 → 切回分段控件另一侧即可（专属 Key 文件未删，**无需重贴**）」只在**类型未变**时成立：若同一次保存里类型也变了，`readiness` 的 exclusive 分支要求 `draft.apiKey 非空 ∨ (¬typeChanged ∧ apiKeySet)`，`typeChanged=true` 时旧 key 不再计入，切回「用专属 Key」仍需重贴 | 给 ② 加限定：「类型未变时无需重贴；类型同时变更时须重贴（属 §6.6 的已知代价）」 |

## 上轮 must-fix 修复核验

| r1 项 | 判定 | 核验证据 |
|-------|------|----------|
| MF-1 写入面穷举 + `lastFailure` 无清理通道 | ✅ 已修 | 表 A 扩到 16 项，与我 r1 的 15 项清单逐条对齐并把 quota-cache 内存镜像独立为 #9；#8 的清理通道描述已改正（原来错写成「随 provider 禁用清内存缓存」）；`lastFailure`（`:122`）由改动 4（`configure` 成功后 + provider 删除时）两条通道覆盖，D12 #2/#3 明确 |
| MF-2 删除通道失败语义 / 顺序 | ⚠️ 部分修 | (a) fail-fast、(b) persist 后再删 secrets、「persist 成功但文件写失败」的不可消除窗口给了四要素 ✅ 均已写清；但「`providerExists` 检查提前到 configure 开头」把 TOCTOU 窗口拉大 → 新 MUST_FIX-2；cookie 的失败语义靠引用待改代码表达 → SUGGESTION |
| MF-3 清除绑在事件上 / 残留文件静默截胡 | ✅ 已修（机制已核实） | D3 改成持久化字段 + 两端共用 `resolveQuotaCredentialSource`；已核实 `index.ts:697-702` 的 `getProviderInfo` 返回 `extras?.quota`（与 UI 的 `ProviderInfo.quota` 同源），两端不可能推断背离 ✅；改动 3 的 `'provider'` 分支跳过专属 Key 文件，残留文件不再截胡 ✅；兜底 `apiKeySet ? 'exclusive' : 'provider'` 让正常历史数据升级零行为变化 ✅ |
| MF-4 D5 例行制造「enabled + 凭证清空」 | ✅ 已修 | 类型进草稿后，保存前的切换不产生任何落盘（S8 覆盖 reka 同值 emit）；保存时 cookie 类在 `typeChanged` 下 readiness 强制草稿非空 → 保存成功后必带凭证，该状态不再被例行制造 ✅；未齐备拨开关这条剩余路径由 D11 + S12 给出出路 ✅ |
| MF-5 枚举扩展撞穷举 Record / M0 不可独立合入 | ✅ 已修 | M0 与 U1 均纳入 `useQuotaQuery.ts:25-31`，§7.5 加了归属列，§9.1 专门段落说明「漏 key 是 `vue-tsc` 编译错」；已核实该 `Record` 确为穷举映射（漏 key 编译报错，不会运行期静默 undefined）✅ |
| MF-6 §6.11 恢复路径不成立 | ⚠️ 基本修 | 原「改回即可」已废弃，拆成 ①Cookie 重贴 / ②来源切回两条 ✅；②缺「类型同时变更」限定 → 见 SUGGESTION；量级改为点击次数并补了前提 ✅ |

## 聚焦攻击点答复

**B1 · D12 `clearProviderState` 与 `configure` 的竞态 → 窗口真实存在，且「提前检查」把窗口拉大。** 结论见 MUST_FIX-2。补充核实：`XyzProviderStore.modify` 的锁是文件锁（`provider-extras-store.ts:77-83`），不锁 provider 存在性；`providerExists` 走 `configService.listProviders()`（`index.ts:704`，读 models.json + auth.json + extras），custom provider 在 `removeProviderCore` 之后即从聚合列表消失 → 检查通过后仍有完整删除链可以插入。危险产物是 **providers.json 的僵尸条目**（不是僵尸文件：文件在 D3 下是惰性的，条目才是让「同 id 重建」判为齐备的东西）。

**B2 · `clearProviderState` 的幂等与并发 → 文档声明已够，实现需按 ENOENT 处理。** §7.3 改动 5 写明「幂等，文件不存在视为成功」，语义上覆盖了「文件不存在」（`unlinkSync` 抛 ENOENT 必须被当作成功，不能先 `existsSync` 预检——预检本身是 TOCTOU，并发双删会漏一个）；失败按既有清理语义只 warn 不阻断（与 `cleanAuthCredential`/`cleanProviderExtras` 一致，`provider-config-helper.ts:1186`、`:1212`），因此即使抛错也被调用方 try/catch 吞掉，不会中断删除主流程 ✅。无需新增 finding，建议在改动 5 的实现注记里写「捕获 ENOENT 视为成功」。

**B3 · 三处删除是否引入新的不可逆代价 → 未发现「用户没意识到」的删除路径，但 D12 的代价未被登记。** 逐条：① cookie 空串清除只在 `typeChanged ∧ 草稿为空` 时发出 `''`，而 cookie 类 preset 在 `typeChanged` 下 readiness 要求草稿非空 → **UI 不可达**（只有 API-key 类切走时才会删掉被切走平台的 cookie = 用户意图，且 D5 已量化）；② 类型变更的 cookie 清除同上，且切回原类型不会误删（S8 的草稿模型）；③ provider 删除时清 secrets 与既有「移除 = 清用户状态」（auth.json 同样清）一致，但它是**新增的能力销毁且没有代价块** → MUST_FIX-3。唯一存疑的误删路径是 `savedFetcher === undefined` 的归属误判 → SUGGESTION。

**B4 · `credentialSource` 新字段的影响面 → 向前兼容安全，已核实。** `provider-extras-store.readInternal`（`:146-181`）只校验 `version === 1` + `providers` 是对象 + 条目非 null/非数组，**不校验条目内字段集合** → 新增字段不会触发 `quarantineCorruptFile`，旧版本 app 读到含新字段的文件不会被隔离 ✅。反向（旧版本写回新文件）会丢掉 `credentialSource`（`persistQuotaConfig` 逐字段构造 quota），但此时两端同时退回「专属 Key 永远优先」的旧语义、且兜底会把 `apiKeySet=true` 解析回 `exclusive`，行为自洽 ✅。**唯一需登记的是 SUGGESTION 里的幽灵文件迁移面**（标记 false + 文件在 → 有效凭证静默切换）。

**B5 · 表 A 是否还有遗漏 / #6 的频率 → 基本穷举，两点小差。** 与我 r1 的 15 项清单逐条对齐（#9 单独列出内存镜像、#12 补齐 renderer store、#13 日志、#16 GUI 均已在表）✅。仍缺：`quota-cache.json.tmp`（`quota-cache.ts:130-148` 的原子写中间产物，与 #2 的 `providers.json.tmp` 口径不一致）。#6 的频率方向是**下降**而非上升：D5 把类型下拉从「即时 configure」改为草稿，configure 的调用点由 5 个收敛为「保存并测试」+「拨开关」两个；D11 只复用 `openSettings`（`AppShell.vue:82` `provide('openSettings', () => settingsOpen.value = true)`），只打开设置模态框，**不触发任何 configure**，因此 `ensureSecretsDir` 的物化频率不升。

**B6 · §11 四个检查点是否有该量化未量化 → 有一个描述不自洽 + 缺两类检查点。** ① #1 有探针（S11②）✅；② #2 已按「provider × 模型 × 客户端 × 频率」量化并给了降级路径 ✅（我 r1 的 S-3 已修）；③ #3 是行为确认，量级可忽略 ✅；④ #4 的窗口描述与改动 4 自相矛盾：「`configure` 成功后清 `lastFailure`」+「`setEnabled` 也走 configure（quota 唯一写路径）」⇒「provider 被禁用」不再是残留窗口，真正的残留是「失败后用户不操作（provider 仍 enabled）」（= 期望行为）或「清理 warn-only 失败」→ SUGGESTION。另有**两类未设检查点**：MUST_FIX-2 的并发窗口、SUGGESTION 的幽灵文件迁移面。

## 交叉引用一致性终检（D11 / D12 / D13 × 各章）

| 项 | §2 In-scope | §6 决策 | §7 机制 | §7.5 文件地图 | §8 验收 | §9 阶段 | §10 单元 | 表 A |
|---|---|---|---|---|---|---|---|---|
| D11 | ✅（含「补一个恢复入口」） | ✅ §6.12 | ✅ §7.4 | ✅（ContextCapacityPopover → U5） | ✅ S12 | ✅ M2 | ✅ U5 | ✅ #16 |
| D12 | ✅ | ⚠️ 缺「已知代价」块（MUST_FIX-3） | ✅ §7.3 改动 4/5 | ⚠️ **缺 config-service.ts / index.ts / provider-extras-store.ts**（MUST_FIX-1） | ✅ S14 | ✅ M1 | ✅ U2 | ✅ #4/#5/#10 |
| D13 | ✅ | ✅ §6.14（含代价） | ✅ §7.2 细节 2 + 参数构造表 | 无新文件 ✅ | ⚠️ 无场景（见 INFO 交接主审） | ✅ M2 | ✅ U4/U5 | — |

表 A 的 16 项与正文引用：可被正文再引用的 #1/#4/#5/#8/#10/#12/#13/#14/#16 均已引用（§7.3 影响面表、§7.1 副作用表、§11.2、D12）；#2/#3/#6/#7/#9/#11 属登记性条目，只出现在表内（#2 另在 S13 被观察），可接受。§7.5 与 §9.1/§10 的单元归属逐行一致（U1 含 `useQuotaQuery.ts` 与 shared 三文件、U2 含 runtime 两个文件 + 清理钩子、U3 含 `injection-keys.ts`、U5 含浮层入口）✅。另核实：`injection-keys.ts:61-89` 的 `NOOP_FACTORY` 确为 `QuotaConfigureState` 的完整字面量，U3 把它与新契约绑定是同批必需项 ✅（文档这条写对了）。

## INFO（交接与机械性，不计入 must-fix/suggestion）

- **交接主审 P1-10**：D13 移除了「清空 Workspace 地址」这一既有能力，但 §8.2 没有对应场景（S3 只验必填），按 P1-10「负面行为无反向验收」由主审裁定；同时 D13 说「移除空串 = 清除的语义」，而 runtime 侧 `quota-service.ts:356-368` 的该语义是否同步移除，§7.3 未表态（保留无害，但建议一句话说明）。
- **机械性**（不影响决策，单句带过）：§8 结论写「13 个真实场景，其中 6 个反向」，实际表内 14 行、7 行标注反向（S4/S5/S6/S8/S9/S10/S13）；表 A 注写「新增加粗的 6 项」，表中「本次新增写入 = 是」实为 5 项（#1/#4/#10/#13/#16）；`provider-config-helper.ts:917-920`（清理失败只 warn）与 `:923-927`（M5-05 不变量）两处引用指向的是 model id 防线代码，实际注释在 `:1192-1216`；表 A 未列 `quota-cache.json.tmp`。
- **旁证（正向核实，供主审参考）**：§7.3 影响面表新增的「设置页 `loadCached` 在 `data=null` 时丢弃 reason」确为真实缺陷（`useQuotaConfigure.ts:167` 的 `if (result.data)` 把 reason 处理包在里面），修法正确；D6 让 `getCached` 带 reason 后该修复是必要的。

## 结构化输出

```json
{ "report_file": "docs/design/coding-plan-quota-config-ux.impact-review.md", "must_fix": 2, "suggestion": 6 }
```
