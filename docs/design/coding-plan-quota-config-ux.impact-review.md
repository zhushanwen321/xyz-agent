# 影响面审查报告 · Coding Plan 额度查询配置交互重构（方案 B）

> 审查对象：`docs/design/coding-plan-quota-config-ux.md`（v1）
> 审查归口：**P0-12 / P0-19 / P0-20**（`~/.agents/skills/tech-design/review/rubric-design-doc.md`）；P0-1~P0-11、P0-13~P0-18、P0-21 归主审，本报告不重复判定，线索标 INFO 交接。
> 方法：逐条 read 源码核实写入面、消费方、投影规则与清理通道（不采信文档自述）。

## Summary

6 must-fix, 4 suggestions.

结论：文档 §4.2 的状态表**不是写入面穷举**（缺 4 类落盘点与全部内存态），且**本次新增的是本方案唯一一条不可逆删除通道**，其失败路径、执行顺序、残留文件生命周期均未分析——三处叠加可让 `providers.json` 的标记与磁盘事实背离，而 §7.2 细节 2 与 D5 的正确性正建立在该文件确实不存在之上。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §4.2 状态表 | P0-19 ⓪ 写入面穷举 | 表只列了 4 个持久状态，实际每次操作的落盘/请求点至少 15 处（完整清单见下节）。最实质的缺口：`QuotaService.lastFailure`（`quota-service.ts:122`）**因本次改动产生新增写入**（改动 1 把凭证缺失从「静默 `return this.getCached`」改为 `fetchFailed` → `lastFailure.set(pid,'no-credential')`，`quota-service.ts:477-480`、`:511-515`），该 Map 无任何清理通道（provider 删除、禁用、`configure` 成功后均不清；只有一次成功 fetch 才 delete），文档未登记、未判可接受。次要缺口：`<dataDir>/logs/`（凭证缺失从「零日志」变为每次 `logger.warn('[quota] fetch failed')`，`:500`）、`<dataDir>/secrets/` 目录本身（`ensureSecretsDir` 在每次 `configure` 最前面无条件执行，`:245`/`:293-306`，只拨开关也会物化该目录）、`providers.json.tmp`+mkdir 锁目录/`ensureFileExists` 物化（`provider-extras-store.ts:184-188`、`:88-94`）、进程级 `process.umask` 临时清零（`:295`、`:632`）。另：quota-cache.json 单元格「随 provider 禁用清内存缓存」不准确——禁用清的是 **renderer** Pinia store（`useQuotaConfigure.ts:255`），runtime `QuotaCache.memoryCache` 无清除 API，删除 provider 时清的也是 renderer store（`ProviderPage.vue:509`）。**失败模式**：用户对某 provider 试一次错凭证 → runtime `lastFailure` 常驻该 pid → 此后每次 `quota.getCached` 都带 reason（`quota-service.ts:214-221`），对话页浮层首屏即写 error（`useQuotaQuery.ts:114-120`），进程生命周期内不自愈；provider 删除后该条目仍在 Map 中 | 补齐写入面表（主存储/日志/临时产物/内存态四类逐条列出并标清理通道）；`lastFailure` 无清理通道须显式登记为风险并给出重审触发条件（或补 provider 删除时的清理钩子） |
| MUST_FIX | §4.2 / §7.3 改动 2 / §8.2 S7 | P0-19 ③ 删除通道失败语义 | 新删除通道按 §7.3「对齐 `writeApiKeySecret` 的既有正确实现」实现，但该实现在客观上有两处缺陷，文档把它当作正解并复制：(a) `unlinkSync` 失败被 `catch` 后只 `logger.debug`，函数仍返回 `apiKeySet:false`（`quota-service.ts:334-343`），`persistQuotaConfig` 照写 `cookieSet/apiKeySet=false`——**标记说已清除、文件仍在**；(b) 删除发生在校验与持久化**之前**（`configure` 顺序：`:245` ensureSecretsDir → `:250-254` cookie 写/删 → `:257-262` apiKey 写/删 → `:266-271` workspace 校验（可 return error）→ `:274-284` persist（可 return false）），一旦后续阶段失败，凭证已物理删除而 providers.json 未更新（`cookieSet` 仍为 true）；renderer 的回滚只回滚本地 `fetcherId`（`useQuotaConfigure.ts:210-221`），**文件不可回滚**。**失败模式**：① Windows 或目录只读/文件被占用时 unlink 失败 → 用户选「用 Provider 凭据」并保存（§7.2 细节 2 传 `apiKey:''`），runtime `getCredential('api-key')` 仍**先读该文件**（`quota-service.ts:577-580`），旧专属 Key 静默截胡，且可能因 key 属于另一平台而返回 `unauthorized`——正是 D5 声称已消除的失败模式 C；② `persistQuotaConfig` 失败（providerExists 被并发删除、锁/写盘失败）→ cookie 已被删，`providers.json` 的 `cookieSet` 仍 true → 前端按 §7.2 判为「已配置」按钮可点，输入框空且标「已配置」，用户点「保存并测试」得 `no-credential`，无任何线索指向凭证已丢。S7 只验 happy path（「文件已被删除」），两条失败路径无验收 | 删除语义对齐写入语义：unlink 失败即 `return {error}`（与写失败同路径 fail-fast），或删除后 `existsSync` 复核 post-condition；删除动作后置到 `persistQuotaConfig` 成功之后（不可逆操作不得排在可失败校验之前）；文档补这两条失败路径的影响描述与验收场景 |
| MUST_FIX | §7.2 细节 2 / §4.2 / §11.3 | P0-19 ① 消费方与生命周期 | §7.2 细节 2 只声明「**来源切换为** `'provider'` 时**必须显式传** `apiKey:''`」，即清除动作被绑定在「用户操作了分段控件」这一事件上。而 `credentialSource` 的初值是 `'provider'`（D3「默认选前者」）——一个从未动过分段控件、但磁盘上存在历史 `<pid>-apikey.txt` 的用户，保存时传 `undefined`（= 不改既存，§7.2 细节 1），残留文件继续截胡。残留文件的产生通道恰恰是文档自己登记为「本次只登记、不实现」的那条（§4.2 注 + §7.3 改动 3：删除 provider 时 `cleanProviderExtras` 只删 extras 条目，`provider-config-helper.ts:1204-1216`；`cleanAuthCredential` 只清 auth.json `:1178-1190`；`deleteProvider` 调用链 `:1251-1254` 与 `removeProviderByKind` `:1319-1332` 均无 secrets 清理）。**失败模式**：用户删除 provider P（配过专属 Key）→ 同 id 重建 P 并选智谱 → 分段控件停在默认「用 Provider 凭据」→ 齐备性判 `provider.apiKeySet`（另一来源，§6.7 证据链 `provider-config-helper.ts:335`）为真 → 按钮可点、文案承诺「使用上方凭据区填写的 API Key」→ runtime 实际用被删 provider 留下的旧专属 Key 发请求。若该 key 恰好有效，**用户看到的是错误账号的额度数据**（静默错数据，比报错更糟）；若不有效，则得到与文案矛盾的 `unauthorized`。「同 id 重建继承旧凭证」在 D3 引入显式来源声明后**变得更糟**：旧代码里「留空=继承」是同一句话，新代码里它变成了一条被 UI 明确承诺、runtime 无法兑现的声明 | 把清除做成**无条件语义**而非切换事件：source==='provider' 时每次保存都传 `apiKey:''`（幂等），并同步清理 `<pid>-cookie.txt`（切到 api-key 类时）；或把 §11.3 的 secrets 清理缺口从「只登记」提升为本次实施（否则须显式判定该残留继承风险可接受并写重审条件） |
| MUST_FIX | §6.6 / §7.3 改动 1 / §8.2 S7 | P0-19 ① 投影面 | D5 的作废动作保持 `enabled` 不变（§7.2：`configure(pid, enabled, '', newFetcher, '')`），于是**本方案自身**例行制造出「`enabled=true` + 凭证已清空」状态。改动 1 又把凭证缺失从静默变为显式失败，该状态的消费方是对话页：`useQuotaDisplay.matchedProviderId` 只判 `quota.enabled`（`useQuotaDisplay.ts:71-80`）→ 浮层渲染 coding-plan 区 → 失败态下 error 优先于数据（`ContextCapacityPopover.vue:87-89`）且**该分支只有刷新按钮，无「去配置」入口**（`ContextCapacityPopover.vue:136-154` 的 `configureCodingPlan` 按钮只在 `matchedProviderId` 为 null 时渲染）→ 用户每 hover 一次容量 chip 就看到一次「查询失败：未找到可用凭证」，刷新只会再次失败。文档 §7.3 只写了改动 1 会让浮层「从『暂无数据』变为『未找到可用凭证』。这是期望的」，未登记该状态由 D5 例行产生、未给清除路径、§8.2 无对应场景（S7 只查 settings 页与文件，S8 只在 settings 页比较两条文案）。**失败模式**：用户切类型后中断配置（或点取消）→ 对话页对该 provider 长期呈红色失败；若该 provider 是当前默认模型，用户每次开对话框都看到「额度查询失败」而无处置入口 | 登记该状态及其清除条件，并二选一做出设计决定：切类型时同时把 `enabled` 置 false（D5 声明为「作废」就作废彻底），或在浮层失败态补一个指向 Settings 的恢复入口（复用现有 `openSettings` 注入）；§8.2 补一条「切类型后未完成配置 → 对话页浮层表现」的验收场景 |
| MUST_FIX | §9.1 M0 / §10 U1 / §7.5 | P0-12 遗漏连带改动 | `QuotaFetchFailureReason` 的扩展会触发一个**穷举类型消费方**：`useQuotaQuery.ts:25-31` 的 `QUOTA_FAIL_REASON_KEYS: Record<QuotaFetchFailureReason, string>`。漏 key 不是「静默返回 undefined」，而是 `vue-tsc --noEmit` 编译错（`packages/renderer` 的 `typecheck`/`build` 均含 `vue-tsc`）。文档 §9.1 却声明 M0「只加枚举值与文案」「单独合入零行为变更，可先验证 i18n 完整性测试」，§10 U1 同样声称「单独合入零行为变更」——按此拆分实施，U1/M0 单独合入时 renderer typecheck 直接红；且 §7.5 把这个改动列在 renderer 文件行，**未归属到任何 U 单元**（U1 只写「shared 类型 + i18n 骨架」，U4 只写 `useQuotaConfigure`）。**失败模式**：实施者按 §10 逐单元提交 U1 → pre-commit/CI 的 renderer 类型检查失败，按文档描述无法定位到「该键属于 U1」 | §7.5 把 `useQuotaQuery.ts` 行纳入 U1 清单并注明「枚举扩展必须与穷举映射同批」；§9.1 M0 的可独立验收标准改为「枚举 + 穷举映射 + 双语 key」三条同时满足 |
| MUST_FIX | §6.11 已接受代价 | P0-20 代价量化 | D10 登记的四要素中「恢复路径：重新进入编辑体改回即可」在本方案下**不成立**：即时提交的控件现在包含**不可逆销毁**动作——切类型会 `unlink` 凭证文件并把 `cookieSet/apiKeySet=false` 写进 providers.json（§7.2），「改回类型」只恢复 `fetcher` 字段，文件与标记都回不来；唯一回法是重新粘贴（与 §6.6 是同一份代价，但 §6.11 把它记成「改回即可」）。同段的**缓解论据**也不成立：「区块内不再有『保存』这个模糊词（只有『保存并测试』）」被用作「用户不会误以为它受底部保存条管辖」的依据，但新区块里类型下拉、启用开关、凭证来源分段控件三者仍是即时提交，而「保存并测试」这个**带「保存」字样的按钮**反而更容易让用户推断其余控件是草稿。**量级**口径同样漏项：「每次『改了额度配置又取消编辑』触发一次」未计入本次新增的破坏性控件（类型切换=凭证销毁） | §6.11 按新控件集重新列举代价：把「切换类型后取消/放弃编辑」单列为**不可逆**代价（恢复路径=重新粘贴凭证，且须说明该动作会持久化新 `fetcher`）；缓解论据改为「控件级显式提示哪些是即时生效」或重新评估是否给类型下拉加确认（D5 已否掉确认框，若维持否决须在此处说明由谁承担该代价）；量级给出可核对的口径（控件 × 频率） |
| SUGGESTION | §6.6 已知代价 | P0-20 量级 | 量级写成「取决于误操作频率，正常使用 ≤ 1 次/会话」——用「误操作」定义总体，漏掉了**有意切换**这一主要人群：类型下拉是为了让用户切换平台而存在的，用户从 MiMo 切到 opencode 再切回来，两次都要重新粘贴 cookie（合法操作，非误操作），成本线性于切换次数而非错误次数。恢复路径「重新粘贴，通道存在且是同一个输入框」隐含「用户手上仍持有 cookie 原文」（需回浏览器 DevTools 重取），文档未声明该前提 | 量级口径改为「每次类型变更（含有意切换）一次重新粘贴」，或说明为何认为有意切换的频次可忽略；恢复路径补「凭证原文须自行从浏览器重新获取」这一前提 |
| SUGGESTION | §7.1 setEnabled 语义 | P0-12 接管点内部步骤 | 被接管的 `toggleEnabled` 除发请求外还带着一处状态副作用：关闭分支清 renderer 额度缓存（`useQuotaConfigure.ts:253-255`，注释「避免 popover 显示过期数据」；`saveApiKey` 清空专属 Key 分支同样有 `:326-328`）。新契约 §7.1 把 `setEnabled` 定义为「只写 `enabled`」，全文未声明这两处 `clearCache` 是保留还是放弃；§4.2 只在「清理通道现状」格里提过一句「随 provider 禁用清内存缓存」，不在任何决策条目里 | 在 §7.1 明确 `setEnabled`/`saveAndTest` 是否保留既有 `clearCache` 副作用（保留则写明，放弃则写明放弃理由与用户可见差异） |
| SUGGESTION | §11.2 待验证检查点 | P0-20 量化 | 量化指标选错：一次 `quota.configure` 触发的不是「一次 provider 列表广播」，而是 `buildProviderListMsgs` 的两条全量消息（`config.providers` + `model.list`，`message-broker.ts:215-217`、`:169-181`），且每条都要先跑 `configService.listProviders()`（全量读盘）与 `getScopedModels()`；量级更依赖**模型总数**而非 provider 数，「>20 个 provider」不足以界定。另缺降级路径（若确有卡顿，是 debounce、只推变更 provider、还是分片）。已核实：本方案不增加广播次数（旧流程一次完整配置 2~4 次 configure，新流程 1 次「保存并测试」+1 次拨开关），故风险为存量而非新增 | 指标改为「单次 configure 的广播体积（provider 数 × 模型数）× 客户端数 × 频率」，并补一条失败时的降级路径（否则该检查点失败无人知道下一步做什么） |
| SUGGESTION | §6.6 / §7.4 | P0-12 遗漏连带改动 | D5 的「作废」只覆盖凭证，未覆盖**展示态**：切类型不重置 `testStatus`/`quotaData`（`useQuotaConfigure.ts:199-222` 只回滚 `fetcherId`），也不清 renderer 额度缓存。设置页因此在切类型后仍渲染「查询成功」+ 旧平台的三窗口数据，而窗口标签已换成新类型的标签（`CodingPlanSection.vue:228-237` 的展示条件只判 `testStatus`/`quotaRow`）；同一时刻对话页浮层按改动 1 显示失败态。两个界面自相矛盾，且与既有展示原则「旧缓存保留内存不直接展示，防陈旧数据当当前额度」（`CodingPlanSection.vue:254` 注释）冲突 | D5 的作废范围一并覆盖展示态：切类型时 `testStatus` 归 idle/清 `quotaData` 与 renderer store 条目（或在文档中显式声明不清并给出理由） |

## 写入面穷举清单（对照文档 §4.2）

按本方案的四类操作穷举：**O1 改类型下拉**（`configure(pid, enabled, '', newFid, '')`）、**O2 保存并测试**（`configure` + `quota.refresh`）、**O3 拨开关**（`configure`）、**O4 对话页 hover / 浮层刷新**（`quota.fetch` / `quota.refresh`，含 10s throttle）。

| # | 落盘/请求点 | 物理位置 | 触发操作 | 本次是否新增 | 清理通道 | 文档 §4.2 |
|---|--------------|----------|----------|--------------|----------|-----------|
| 1 | quota 配置字段 | `~/.pi/agent/config/providers.json` → `providers[pid].quota` | O1/O2/O3 | 是（O1 清 `cookieSet`/`apiKeySet`） | 删除 provider 时 `cleanProviderExtras` | ✅ 已列 |
| 2 | 原子写中转文件 | `providers.json.tmp` → rename | O1/O2/O3 | 否 | rename 即消，异常无清理 | ❌ 未列（瞬时产物） |
| 3 | mkdir 锁目录 + `ensureFileExists` 物化空 providers.json | `providers.json` 同目录 | 每次 configure | 否 | 锁释放即消 | ❌ 未列 |
| 4 | cookie 明文 | `<dataDir>/secrets/<pid>-cookie.txt`（0600） | O2 写 / O1 删 | **是（新增删除）** | **无**（provider 删除不清） | ✅ 已列（缺口已登记） |
| 5 | 专属 Key 明文 | `<dataDir>/secrets/<pid>-apikey.txt`（0600） | O2 写 / O1、来源切 provider 删 | **是（删除通道常态化）** | **无** | ✅ 已列（缺口已登记） |
| 6 | secrets 目录本身（0700） | `<dataDir>/secrets/` | 每次 configure（含只拨开关） | 否（但 O3 也会物化） | 无 | ❌ 未列 |
| 7 | 进程级 umask 被临时置 0 | `process.umask` | O1/O2/O3（写 secret 时） | 否（同步窗口内 finally 恢复） | 自动恢复 | ❌ 未列（风险低，作为完整性证据） |
| 8 | 额度缓存 + 其 `.tmp` | `<dataDir>/quota-cache.json(.tmp)` | O2/O4 成功时 | 否 | 无主动删除通道 | ⚠️ 已列但**描述不准**（见 Findings 第 1 条） |
| 9 | runtime 日志落盘 | `<dataDir>/logs/`（date+size 轮转） | O1/O2/O3/O4 失败时 | **是**（凭证缺失从零日志变为 `logger.warn('[quota] fetch failed')`） | 轮转 | ❌ 未列 |
| 10 | 内存：`lastFailure` Map | runtime 进程内存 | O2/O4 失败（**本次新增 no-credential 写入**） | **是** | **无**（仅成功 fetch 清） | ❌ 未列（核心缺口） |
| 11 | 内存：`lastFetchTime` / `pending` Map | runtime 进程内存 | O4（O3 不再触发请求） | 否 | pending 即时删；lastFetchTime 无 | ❌ 未列 |
| 12 | renderer 额度 store（`byProvider`） | 前端内存 | O2/O3/O4 | 否（但 O3 是否继续清需声明） | `clearCache`（禁用/删 provider/清专属 Key） | ⚠️ 仅在「清理通道」列被提及，决策条目未声明 |
| 13 | 平台额度 HTTP 请求 | 5 个第三方额度接口 | O2（1 次 refresh）/ O4（fetch，10s throttle） | 否（O3 不再发请求 = 本方案要消除的） | 不适用（只读接口） | ✅ 数据流图覆盖 |
| 14 | WS 出站消息 | `quota.configure:result` reply + `config.providers` + `model.list`（全量） | O1/O2/O3 成功后 | 否（次数不增） | 不适用（瞬时） | ⚠️ 仅 §11.2 提「卡顿」 |
| 15 | 宿主 GUI 可见状态 | 设置页区块 / 对话页浮层 | 全部 | 是（失败态从「暂无数据」变显式失败） | 见 Findings 第 4 条 | ⚠️ 部分（只提了浮层一句） |

## 检查项判定

| 检查项 | 判定 | 依据 |
|--------|------|------|
| **P0-12** 副作用/遗漏 | **不通过** | 穷举类型消费方未纳入 M0/U1 的独立合入清单（Findings 第 5 条，`useQuotaQuery.ts:25` 编译中断）；接管点 `toggleEnabled` 的内部步骤 `clearCache` 未被声明保留或放弃（SUGGESTION 第 2 条，`useQuotaConfigure.ts:253-255`）；D5 作废范围未覆盖展示态（SUGGESTION 第 4 条） |
| **P0-19** 共享/宿主状态写入投影面 | **不通过** | ⓪ 写入面非穷举（上表 15 项中 8 项完全未列，含本次新增写入的内存 `lastFailure`、日志、secrets 目录、瞬时产物）；① 消费方投影：`no-credential` 的两个消费方已逐一 read 核实（见下节），但 D5 例行制造的「enabled + 凭证已清空」状态在浮层的投影未登记、无恢复通道；③ 删除通道存在性与失败语义未分析（新增的删除是本方案唯一不可逆动作） |
| **P0-20** 已接受代价量化 | **不通过** | §6.11「恢复路径：重新进入编辑体改回即可」在新增的不可逆删除下不成立（Findings 第 6 条）；§6.6 量级以「误操作」为口径漏掉有意切换（SUGGESTION 第 1 条）；§11.2 量化指标选错（SUGGESTION 第 3 条）。四要素形式齐全但**内容失真**，不构成有效评估 |

## 消费方与投影面核实（`no-credential` 新 reason）

逐消费方 read 结果（回答「会不会因未知/新 reason 降级或崩溃」）：

| 消费方 | 读取方式 | 新 reason 的行为 | 结论 |
|--------|----------|------------------|------|
| `useQuotaQuery.ts:25-31` `QUOTA_FAIL_REASON_KEYS: Record<QuotaFetchFailureReason,string>` | 穷举映射 + `t()`（`:41-43`） | 漏 key = **编译错**，不会静默返回 `undefined`；文档 §7.5 已列此文件 | ✅ 安全（但见 Findings 第 5 条：归属与拆分顺序错） |
| `CodingPlanSection.vue:395-410` `failMessage` | if 链 + 末尾兜底 `testErrorMsg \|\| quotaTestFail` | 未加分支时退化为通用文案，不崩溃；§7.1 错误规格表已给出 `quotaFetchFailNoCredential` 与恢复动作 | ✅ 覆盖（§9.1 关于「落到默认分支」的断言对**该**消费方成立） |
| `ContextCapacityPopover.vue` | 只读 store 的 `error: string`（`:87-89` 优先于数据展示），reason→文案在 `useQuotaQuery` 完成 | 无 reason 分支需求，不崩溃；但**失败态无「去配置」入口**（`:136-154` 的门控是 `matchedProviderId`） | ⚠️ 见 Findings 第 4 条（无恢复通道） |
| `useQuotaConfigure.ts:123` / `injection-keys.ts:77` / `core/.../quota-configure-state.ts:55` | 透传 `Ref<QuotaFetchFailureReason\|null>` | 仅类型标注，无映射 | ✅ 安全 |
| `core/transport/api/domains/quota.ts:27` `toQuotaResult` | 纯字段投影，无白名单校验 | 直接透传 | ✅ 安全（已确认不存在运行期 reason 白名单，故无额外机械消费方） |
| renderer quota store `stores/quota.ts:40-55` | 存字符串 error | 无 reason 语义 | ✅ 安全 |

既有缺口复核（文档 §4.2 注的登记是否属实）：`cleanProviderExtras`（`provider-config-helper.ts:1204-1216`）只 `extrasStore.delete`；`cleanAuthCredential`（`:1178-1190`）只清 auth.json；`deleteProvider`（`:1251-1254`）与 `removeProviderByKind`（`:1319-1332`）两条删除链均无 secrets 清理；全仓 grep `cookie.txt`/`apikey.txt` 仅 `quota-service.ts:643-650` 读写——**文档登记属实**，且 renderer 只在删除时清自己的 store（`ProviderPage.vue:509`），runtime 侧确无清理通道。

## 交接与旁证（INFO，不计入 must-fix/suggestion）

- **[交接主审 P0-21]** `§8.2 S9` 覆盖了 providers.json 结构完好 + secrets 无空文件残留，但按上表穷举的写入面，至少还缺三条宿主面断言：① 连续 N 次切类型/拨开关后 `providers.json` 与同目录无 `.tmp`/`.corrupt-*` 残留堆积；② 连续失败的凭证查询产生的日志增长有界（轮转生效）；③ 对话页浮层在切类型后的表现（现 S9 只回设置页）。是否判不通过由主审裁定。
- **[旁证]** 文档 §9.1「M1 的 cookie 空串改动只影响一个今天不可达的路径」经核实**成立**：全仓四处 `quotaApi.configure` 调用里 cookie 参数分别为 `undefined`/非空（`useQuotaConfigure.ts:209/248/286/316/364`），无调用方传 `''`。
- **[旁证]** 文档 §11.1「`provider.apiKeySet` 不区分 api_key 与 oauth」经核实成立（`provider-config-helper.ts:335`）。
- **[旁证]** 本方案不增加网络请求次数与 provider 列表广播次数（旧流程一次完整配置 2~4 次 `configure`，新流程「保存并测试」1 次 + 拨开关 1 次，`quota.refresh` 不触发广播）。

## 结构化输出

```json
{ "report_file": "docs/design/coding-plan-quota-config-ux.impact-review.md", "must_fix": 6, "suggestion": 4 }
```
