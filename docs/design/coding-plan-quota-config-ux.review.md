# 设计文档审查报告（r2）· coding-plan-quota-config-ux.md

审查依据：`~/.agents/skills/tech-design/review/rubric-design-doc.md`（主审归口：P0-1~P0-11、P0-13~P0-18、P0-21、全部 P1）
审查范围：本轮聚焦 ① 上轮 must-fix 的修复是否成立、新机制能否被新反例击穿；② 交叉引用一致性终检。已确认项不重查。

## Summary

2 must-fix, 5 suggestions.

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §7.5（doc:820-854）+ §7.1 契约（doc:562-576）+ §7.2 参数构造表（doc:669） | P0-11 事实（新发现） | 新增参数 `credentialSource` 的**端到端传递链在文件地图里断在三段**，且没有任何一处写明这条链：① `packages/shared/src/protocol.ts:585` 的 `'quota.configure'` payload 类型是 `{ providerId; enabled; cookie?; fetcher?; apiKey?; workspace? }` —— 不含新字段，而 core 的 `command()` 用 `ClientMessageMap[K]` 约束 payload（`packages/core/src/transport/api/request.ts:42-45`），renderer 传对象字面量带该键 = **excess property 编译错**；② `packages/core/src/transport/api/domains/quota.ts:66-76` 的 `configure` 只有 6 参（§7.5 只列了它的测试 `domains.test.ts`，源文件不在表里）；③ `packages/runtime/src/transport/quota-message-handler.ts:68/75` destructure 6 字段、传 6 参 —— 不改**不会编译报错**（少传参数合法），而是把 wire 上的 `credentialSource` **静默丢弃**：providers.json 永不写该字段 → `resolveQuotaCredentialSource` 恒按 `apiKeySet` 推断 → 有专属 Key 文件的 provider 恒判 `'exclusive'` → 用户切到「用 Provider 凭据」后 runtime 仍用专属 Key = **§3.2 失败模式 D 原样复现**，且只有 S9 能发现。另：`quota-service.ts` 只列了 `:245-286`/`:309-349`/`:476-480`/`:511-515`/`:576-596`，而新字段的**写入点** `persistQuotaConfig`（`:381-422`，嵌套字面量在 `:400-414`）与读取侧 `ProviderInfoLike`（`:37-45`，只声明 `quota?: { fetcher?: string }`）都不在列。 | §7.5 增列 protocol.ts（U1）、core `domains/quota.ts`（U1 或 U3）、runtime `quota-message-handler.ts`（U2），并把 `quota-service.ts` 行号补 `:37-45`/`:381-422`；同时新增一条「新参数端到端链」清单（renderer 调用 → core domain api → protocol payload → runtime handler → `QuotaService.configure` → `persistQuotaConfig` → `ProviderExtras.quota` → 读侧 `resolveQuotaCredentialSource`），并在 U1 的验收里加「`quota.configure` payload 含 `credentialSource` 且落盘可见」（S9 已覆盖终态，但当前无阶段承接这三处改动） |
| MUST_FIX | §7.2 细节 2（doc:662）+ §6.6 被否（doc:451）+ §8.2 S8（doc:879） | P0-11 事实 + P1-10 验收盲点（新发现） | 新加的「**切换类型时清空草稿**」与文档自己承认的 reka 机制相撞，且没有守卫：`CodingPlanSection.vue:21-24` 用 `:model-value` + `@update:model-value`，reka `SelectItem.handleSelect` 无条件 `rootContext.onValueChange(props.value)`，`SelectRoot` 用 `useVModel(..., { passive: props.modelValue === void 0 })`（`SelectRoot.js:71-77`）→ 传入 `:model-value` 时 `set()` **恒 emit，无同值判断**。若把「清草稿」挂在 Select 的事件/`fetcherId` setter 上（最自然的位置，且 §7.1 已把 `selectFetcher` 改成同步草稿写入，原 r1 的 `if (id === fetcherId.value) return` 守卫随之消失），**用户点选当前已选的类型 = 清空未提交的 Cookie/专属 Key 输入**（丢输入，非丢磁盘）。更严重的是 **S8 看不见**：S8 的前置是「S2 完成后」（cookie 已保存、输入框已清空），此时草稿本来就是空的，而 S8 的通过标准只查「不产生 RPC + 磁盘不变」—— 草稿被清时两条依然满足，S8 仍判通过。 | §7.2 细节 2 写明同值短路（`if (newId === fetcherId.value) return`，且该守卫必须在 setter 内而非依赖事件）并把 S8 场景改成「**先粘贴一个未提交的 Cookie → 再点选当前已选类型 → 输入框内容必须仍在**」；顺带补一条「改类型再改回原类型」的正向验收（按细节 2 草稿会被清两次，但旧 Cookie 应仍有效、按钮应亮 —— 现状无任何场景覆盖这个来回序列） |
| SUGGESTION | §7.4（doc:811-816） | P0-11 事实（新发现） | `providerCredentialPendingSave` 定义为「`form.apiKey` 的非空状态」，但 `form.apiKey` 有第三个取值：`use-provider-edit.ts:166` 的 `API_KEY_CLEAR_SENTINEL = '__CLEAR__'`（用户在 provider 表单点「清除」，`:578` 写入）。用 `!== ''` 判非空后，点「清除」会让文案显示「上方「凭据」区**已填写** API Key，保存 provider 配置后即可查询」——与实际（用户刚清空）相反。 | 判定式写清：`form.apiKey !== '' && form.apiKey !== API_KEY_CLEAR_SENTINEL`（或直接复用 `use-provider-edit` 的 `resolveApiKeyForSave` 派生「本次将写入非空 key」） |
| SUGGESTION | §5.2 路径 4（doc:353-360）+ §7.1 错误规格 | P0-18 恢复指引（新发现） | 新增的 `no-credential` 只有一份 api-key 语境的文案（「请在上方「凭据」区填写 API Key，或在此填写专属 API Key」）。cookie 类 provider 同样会出现该 reason（`cookieSet=true` 而文件缺失的幽灵态 —— §7.3 改动 2 自己登记了该窗口）。此时文案指向的两个位置对 cookie 用户都不存在（没有 API Key 区、也没有专属 Key 输入框），用户被指向不存在的动作。 | 按 `authKinds.includes('cookie')` 给 cookie 变体（既有先例：`CodingPlanSection.vue:398-404` 已按 cookie/非 cookie 给 `no-subscription` 两套文案），文案指向「重新粘贴 Cookie」 |
| SUGGESTION | §9.1（doc:911）「为什么 M1 可以先行」 | P0-11 事实（新发现） | 「`credentialSource` 解析在字段未设置时按既存标记推断（保持现状行为）」有一个未声明的例外：字段未设置 + `apiKeySet=true` 但 `secrets/<pid>-apikey.txt` 不存在（幽灵标记，§7.3 改动 2 自己登记的窗口）时，新分支只读该文件 → null → **`no-credential` 失败**；而旧链会继续回退 auth.json → models.json（可能**成功**）。即 M1 会对该状态引入一个从「能查到」到「查不到」的行为回退，影响面清单未列。 | §7.3 改动 1 的影响面表补一行（幽灵标记下由「回退成功」变为「显式失败」），或说明该状态在 D12 + 改动 2 落地后不可达（需给出依据，否则按已登记窗口处理） |
| SUGGESTION | §7.2（doc:635）+ §7.1 契约（doc:602-605） | P1-1 契约表达（A6） | `readiness` 在未选类型时返回 `{ ready: false, missing: [] }`，这是一个契约里没有名字的第四态（`ReadinessMissing` 只有 3 个值，只有内联注释解释）。后续消费方（或本次实现者手滑）容易把它当成「齐备但不可点」或渲染出「参数齐全后可点」这类空提示。 | 在契约注释里把该态显式定义（「未选类型：UI 不渲染按钮与缺口项，`ready=false` 是占位」），或让 `missing` 表达为 `['type']`（若选后者需同步 i18n key 清单） |
| SUGGESTION | §9.1（doc:902-905）+ §8.2（doc:886）+ §10（doc:917-926） | 交叉引用终检（新发现） | 新增场景 S15（D13）与 S11① 没有归属阶段：M1 只列「S11②、S14」，M2 列「S1-S10、S12、S13」——**S15 与 S11① 不在任何阶段的可独立验收清单里**；`§10` 的 U 单元 justification 也未提 D13 的验证落点（U4/U5 无 D13 字样）。 | 把 S15 加进 M2（D13 的规则落在 U4/U5），S11① 加进 M2，并在 U4 的 justification 里点出「D13 的判定/保存规则」 |

## 攻击点逐条回答（A1-A6）

| # | 结论 | 依据 |
|---|---|---|
| **A1**（有没有路径让 `credentialSource` 停止更新，使磁盘值与 UI 选择再次背离？） | **有一条，且是最危险的一条**：不是 renderer 的分支，而是 **runtime handler 把 wire 字段丢掉**（`quota-message-handler.ts:68/75` 不 destructure 就不传参，`configure` 第 7 参缺失时 TS 不报错）→ providers.json 永不写该字段 → 两端都退回 `resolve()` 的 `apiKeySet` 推断 → 又回到失败模式 D。此外 renderer 侧 `setEnabled`（D4：其余参数传 `undefined`）依赖 `persistQuotaConfig` 的 `inheritQuotaField` 链带上新字段（该链在 `:404-414`，文档未点名，属同一缺口的次要面）。**正确性判断**：文档的「保存时恒传（幂等）」在 saveAndTest 路径上成立，`resolve()` 的 `??` 短路也确实让「显式值一旦写下就不会被推断覆盖」；但这条保证只在字段真的落盘时成立。 | protocol.ts:585 · request.ts:42-45 · domains/quota.ts:66-76 · quota-message-handler.ts:68/75 · quota-service.ts:37-45/381-422/404-414 |
| **A2**（`cookie` 的 `typeChanged ? '' : undefined` 会不会删掉用户刚输入但未提交的内容？） | **不会**。`''` 分支的前置是「草稿空」，用户刚输入的内容在草稿里；草稿非空时走「传草稿」分支覆盖写入。但有一个**反向**残留（正是 A3 的形态）：草稿是「跨类型存活」还是「随类型清空」在草稿模型下必须由文档指定 —— 现版本已指定为「随类型清空」（doc:662），所以旧形态封住了。 | doc:675/677 · doc:662 |
| **A3**（改类型 → 填新凭证 → 改回原类型 → 保存，会不会打架？） | **不会打架**：改回原类型时 `typeChanged=false`，但草稿已在两次类型变更中被清空（detail 2）→ `cookie` 走 `undefined`（保留既存）、`apiKey` 走 `undefined` → 保存后旧凭证仍生效、按钮亮，语义自洽。代价是用户刚粘贴的新内容被丢弃 —— 属 detail 2 的已声明后果（原型 demo-b.html:193-199 同款）。**但**「什么事件算类型变更」未定义，见 Findings 第 2 条（同值点选会误触发清草稿）。 | doc:633（typeChanged 定义）· doc:662 · doc:675-676 |
| **A4**（`cleanProviderState` 与 `configure` 并发） | **已封得相当好，但仍有一处未登记**：现版本把存在性检查移进 `modify` 回调（与删除链 `delete` 争同一把文件锁，读-判-写同临界区）并登记了「persist 与 secrets 写之间」的残余窗口 —— 这两点与我上轮设想的攻击一致且处理正确（`XyzProviderStore.modify` 确实无条件建条目、锁只锁文件：`provider-extras-store.ts:213-228`/`231-244`，`readFileSync` 不 whitelist 字段所以新字段能直通）。**未登记的一处**：D12 的 `clearProviderState` 与并发的 `configure` 之间仍是「先删后写」的自然顺序 —— 若 configure 在 `clearProviderState` 之后完成 secrets 物理写，孤立文件会被**重新创建**，而「下一次删除会清掉它」只在用户再次删除时成立；文档只说「孤立文件 + 无 extras 条目」，未说明文件会被**重新物化**且 `readiness` 不会因此误判（`savedFetcher===undefined` 使它不生效 ✓ 判断正确）。建议在该段补一句「重物化」的表述即可，不阻塞。 | doc:719-735 · provider-extras-store.ts:213-228/231-244 · quota-service.ts:381-422 |
| **A5**（S5 的 ⛔ 探针降级路径是否可执行？） | **可执行，无需更多信息**。观测面（`quota-cache.json` mtime + `lastFetchAt` + runtime 日志）能区分「拨开关发了请求」；失败时的动作是「回到 §7.1 契约检查 `setEnabled` 是否仍调 `refreshQuota`，删掉该调用」，对象明确、禁令明确（不许加标志位补丁）。 | doc:888-890 |
| **A6**（`readiness` 未选类型返回 `missing: []` 是否够清晰？） | **不够清晰**，见 Findings 第 5 条（建议把「未选类型」这一态在契约里显式命名，而不是靠内联注释）。 | doc:635 · doc:602-605 |

## 交叉引用一致性终检

| 联动点 | 结论 |
|---|---|
| 正文决策（采用/被否/证据/效果） | D1-D13 均四件套齐备；D3/D5/D11/D12/D13 的「被否」都含机制级证据（`getCredential` 链、reka emit、footer 二选一、`cleanProviderExtras` 只删 extras、明文回显），**通过** |
| 终态数据流图（§4.1） | 已含 `credentialSource`（doc:215）与「按 credentialSource 选链」（doc:226），与 D3 实现机制一致，**通过** |
| 错误规格表 | v2 **删除了 v1 §7.1 的「reason → 文案 key → 恢复动作」表**。判定：不构成 P0-18 违反（§5.2 路径 1-5 逐条给恢复动作；既有 5 个 reason 的 key 映射在代码里已存在，本次只新增 `no-credential`，其 key 在 §7.5 与 §9.1 都点名了）。但 `no-credential` 的 cookie 语境变体缺失（见 Findings），建议至少补一条规格行 |
| §5 拆分单元表 + 文件改动地图 | §10 六单元与 §7.5 的「归属单元」列自洽；`provider-extras-store.ts` / `quota-cache.ts` / `config-service.ts` / `index.ts` 已补入（上轮缺口已修）。**新缺口**：protocol.ts / core `domains/quota.ts` / runtime `quota-message-handler.ts` 三处未列（见 Findings 第 1 条） |
| §8 验收（新边界是否补场景） | D11→S12 ✓、D12→S14 ✓、D13→S15 ✓、D3→S9 ✓、D5→S7/S8 ✓、D8→S10 ✓；反向场景 8/15 与章首计数一致（上轮计数错已修）。**缺口**：S15/S11① 未归入任何阶段（见 Findings 第 6 条）；S8 场景无法发现草稿被清（见 Findings 第 2 条） |

## 已核查判为通过的检查项（含上轮 must-fix 复核）

| 上轮 finding | 复核结论 |
|---|---|
| MF-1 `credentialSource` 未持久化 / 事件语义 | **成立且已修**：D3 改为字段持久化 + 两端共用 `resolveQuotaCredentialSource` + runtime 按 source 分支跳过专属 Key 文件 + 「`apiKey` 永不传 `''`」（可逆），并给出 `quota.ts:577-587` 链的真实语义；`getCredential('provider')` 跳过文件的写法与 fetcher 链一致（`auth.json → models.json`），无残留截胡路径。**残留**：wire 链路缺失（本轮 MF-1） |
| MF-2 reka 同值 emit | **成立且已修**（类型进草稿 + 归属规则，§6.6 还引用了 `SelectRoot.js:71-77` 的原证据）；**残留**：清草稿未加同值守卫 + S8 盲点（本轮 MF-2） |
| MF-3 demo 不是 §7.2 的参考实现 | **成立且已修**：附录 B 显式登记 demo.js（并集版，服务 A/C/D）与 demo-b（source 感知版、未含 typeChanged）的差异，并声明 SSOT 是 §7.2 文字规则；§6.1 改为「B 额外引入凭证来源维度」，**通过** |
| MF-4 M0/U1 独立合入会编译红 | **成立且已修**：U1 已含 `useQuotaQuery.ts` 穷举映射 + `provider.ts` 字段 + index.ts 导出，§9.1 写明 `Record` 漏键是 vue-tsc 编译错；`injection-keys.ts` NOOP_FACTORY 归 U3 且标为必改，**通过**。同类新缺口见本轮 MF-1 |
| 全部 suggestion（S-1 开关可诊断表述、S-2 验收场景、S-3 workspace 语义、S-4 跨区块文案、S-5 loadCached 丢 reason） | **五条全部落实**：D4 边界 2 改「可诊断」+ 新增 D11 恢复入口（含 footer 二选一证据 `:136-154` + `openSettings:189`）；S8/S9/S10/S15 补齐；D13 改为「只看草稿 + 永不传空串」并列明代价；§7.4 两条文案分支；§7.3 影响面表列出 `loadCached` 缺陷并纳入本次修正，**全部通过** |
| P0-13/14/15/21（验收） | 真实环境（`pnpm run dev` + 真实凭证，非 mock）、逐场景带「回溯目标」列、具体业务数值（32%/2h18m/三窗口）、S13 宿主表面不变（`version:1`/无 `.corrupt-<ts>`/无 `.tmp` 堆积/无空文件残留）、S5 ⛔ 带降级路径，**通过** |
| P0-1/2/3/4/5/6/17/18、P1-1/2/3/4/6/7/9/10 | 五段骨架、无 delta 链、每章结论先行、失败模式 A-F 与五根因对应、四方案双维度对比 + 推荐、物理数据流含 `credentialSource`、每失败路径给恢复动作、六单元均有 justification、决策 item 化，**通过** |

## INFO（不影响决策的机械性细节，不计数）

- 两处源码行号偏移：`provider-config-helper.ts:991-992`（引文实为正文注释所在段，实际「禁止恢复经 setProvider 写 quota」在 `:981-982` 一带，doc:947 引用为 `:991-992`）与 `:1204-1213`（M5-05 不变式的注释段）—— 引文语义正确，不影响任何决策。
- §4.2 表 A 的「加粗 5 项」与表中实际加粗项（#1/#4/#10/#13/#16）一致，**通过**（此处上轮为 6 项口径混乱，已修）。
