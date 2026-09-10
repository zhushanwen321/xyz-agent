# 设计文档审查报告 · coding-plan-quota-config-ux.md

审查依据：`~/.agents/skills/tech-design/review/rubric-design-doc.md`（主审归口：P0-1~P0-11、P0-13~P0-18、P0-21、全部 P1；P0-12/19/20 归影响面审）
审查方式：对抗式，逐条 `read` 源码核实文档的事实断言

## Summary

4 must-fix, 5 suggestions.

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §7.2 判定 2（doc:505-506）+ §7.1（doc:449） | P0-11 事实 + P0-10 对抗 | 「来源切换为 `'provider'` 时必须显式传 `apiKey: ''`」是**事件语义**，不是保存时不变量；且 `credentialSource` 是新增的**本地 Ref、无持久化**（§7.1 未列落盘字段，providers.json 无对应字段/迁移），默认值由「provider 侧凭据可用性」派生。于是磁盘上的专属 Key 与 UI 选中的来源可以长期不一致：①若只在显式切换时传 `''`，则默认选中的 `'provider'`（用户从未切换）→ 保存传 `undefined` → `quota-service.ts:579-580` 专属 Key 优先命中，用户的来源选择被静默截胡（D3 要消除的失效原样复现）；②若按「source==='provider' 一律传 `''`」修，则同一路径直接 `unlinkSync` 掉用户此前保存的专属 Key（`quota-service.ts:334-343`），用户未选「用专属 Key」也未同意删除，而 D5/§6.6 的「已知代价」只量化了类型误切、未登记凭证删除。 | 二选一写进 §7.2：①**持久化** `credentialSource`（providers.json `quota` 加字段 + 读侧默认回退），保存时按 source 显式传 `apiKey`；②不持久化则规定「打开编辑体默认 source = 磁盘专属 Key 是否存在（存在即 `'exclusive'`）」。无论哪种，§7.2 必须写成**保存时不变量**（`source==='provider'` → 恒传 `''`；`'exclusive'` → 恒传输入值或 `undefined`），并明确 readiness 两个分支分别读 `providerCredentialAvailable`（provider 侧，`authIdSet.has(id) \|\| override.apiKey`）与 `quotaApiKeyConfigured`（`quota.apiKeySet`），避免继续复用今天合并的 `apiKeySet`（`provider-config-helper.ts:335`）。补反向验收：切回 provider 后旧专属 Key 不再生效且文件被删/未被误删 |
| MUST_FIX | §7.2 切换类型作废（doc:508-509）+ §6.6（doc:359-371） | P0-11 事实 | D5 只说「类型下拉**变更**时」清凭证，未写同值守卫；而当前 Select 的同一交互路径在「再次点击当前已选项」时也会触发：`CodingPlanSection.vue:21-24` 用 `:model-value` + `@update:model-value="$emit('selectFetcher', String($event))"`；reka-ui `SelectItem.handleSelect` 无条件 `rootContext.onValueChange(props.value)`（`node_modules/reka-ui/dist/Select/SelectItem.js`），`SelectRoot` 用 `useVModel(...,{passive: props.modelValue === void 0})`（`SelectRoot.js:71-77`）→ 传入 `:model-value` 时 passive=false → `set(value){ triggerEmit(value) }` 恒 emit，无相等判断（`@vueuse/core/index.mjs:6899-6905`）。现状此路径无害（`useQuotaConfigure.ts:209` 只传 fetcher），D5 落地后变成**有损**：用户打开类型下拉、点一下当前已选的「小米 MiMo」→ `selectFetcher('mimo')` → `configure(pid, enabled, '', 'mimo', '')` → `<pid>-cookie.txt` 被删、按钮立刻置灰、查询转失败。用户「什么都没改」却丢凭证，且该动作还叠加 §6.11 已登记的「取消不回滚」（探索下拉即不可逆删除）。 | §7.2/§7.4 写明 `selectFetcher` 必须先做同值短路（`if (id === fetcherId.value) return`）再触发作废；或改为「类型切换只改草稿，与其余参数一起在 `saveAndTest` 一次性落盘」（同时消解同值误删与取消不回滚放大）。补一条反向验收：打开下拉点选当前类型后，`<pid>-cookie.txt` 与 `quota.cookieSet` 保持不变 |
| MUST_FIX | 附录 B（doc:674）+ §6.1（doc:310） | P0-11 事实 | 文档指定「`coding-plan-quota-ux.demo.js` 中 `readiness()` 是 §7.2 判定的可执行参考实现」——**该说法不成立**：`demo.js:56-69` 的 readiness 完全不看 `credentialSource`，取「专属 Key ∨ provider 凭证」并集、workspace 取「draft ∨ saved」并集、未选类型时 `missing:['查询类型']`；source 感知版本只存在于 `demo-b.html:78-92`（且其 workspace 仍是并集）。§6.1「四个方案都纳入了同一组齐备性规则」同样不成立：demo-a:95 / demo-c:66 / demo-d:113 都调 `Q.readiness`（并集版），只有 B 自带分支版。 | 把 §7.2 的参考实现指向 `demo-b.html:78-92`，或把 `demo.js` 的 `readiness()` 更新为 source 感知版使四处一致；同步修正 §6.1 的表述。§7.2 还应明确那条唯一权威规则（并集版即「留空=继承」隐式约定，正是 D3 被否的对象） |
| MUST_FIX | §9.1 M0（doc:621）/ §10 U1（doc:636）/ §7.5（doc:566） | P0-11 事实 | 「M0/U1 单独合入零行为变更、可独立验收」与类型穷尽性矛盾：`useQuotaQuery.ts:25` 的 `QUOTA_FAIL_REASON_KEYS: Record<QuotaFetchFailureReason, string>` 漏新键即 TS 报错，而 `.githooks/install-hooks.sh:144-163` 的 pre-commit 在 `packages/renderer` 跑 `vue-tsc --noEmit`（项目禁令不许 `--no-verify`）→ 只加枚举的 M0/U1 必然红。同类遗漏：§7.5 说 `injection-keys.ts`「预计无改动」，但 `injection-keys.ts:61-89` 的 `NOOP_FACTORY` 是 `QuotaConfigureState` 的完整字面量，契约增删成员后必改（缺属性/多余属性 TS 报错），且经 `ProviderEditBody.vue → ../injection-keys` 进入 renderer 的 vue-tsc program。 | 把 `useQuotaQuery.ts:25` 与 `injection-keys.ts` NOOP_FACTORY 明确归入 U1/M0（U1 定义为「枚举 + 全部穷尽点 + i18n」），§7.5 的「预计无改动」改为「NOOP_FACTORY 需同步」；或在 §9.1 承认 M0 不可单独合入、与 M2 合并 |
| SUGGESTION | §6.5（doc:355、357） | P1-5 章节 MECE / 结论自洽 | §6.2 明确 readiness 只门控「保存并测试」按钮，开关不受限；因此 §6.5「失败模式 A 降级为用户主动点按钮才会发生，且按钮是灰的」不准确：MiMo 未填 cookie 时可直接拨开开关 → `enabled=true` 落盘 → 浮层出现「暂无额度数据」（`ContextCapacityPopover.vue:118-121`），要等 hover 触发一次 fetch 才显示 `no-credential`（`useQuotaQuery.ts:101-137`）。 | 改述为「降级为**可诊断**」（hover 即得 no-credential），或给开关也接 readiness 提示（未齐备时开关旁提示「先补齐参数」）；若刻意不管，写进 D4 的边界澄清 |
| SUGGESTION | §8.2（doc:593-605） | P1-10 负面行为无验收 | 9 个场景覆盖了继承/cookie/opencode/开关/去掩码/作废/失败分辨/宿主表面，但缺两类本设计新增行为的场景：①D3 的 `credentialSource='exclusive'` 分支（填专属 Key → 保存并测试成功；再切回 `'provider'` → 确认专属 Key 不再截胡）——正是上面 must-fix 的验证点；②D8「未选类型时只渲染类型下拉 + 说明，不渲染开关/参数/按钮」。 | 追加 S10（exclusive 分支 + 切回 provider 后不截胡）、S11（未选类型态不渲染开关与按钮，且不产生 configure RPC） |
| SUGGESTION | §7.2 判定 1（doc:494、500-503） | P1-5 自洽 | 「workspace 判定只看 `draft.workspace`」与「保存时始终传值（空串 = 清除）」不可同时成立：只要输入框为空 readiness 就不 ready、按钮永远置灰，因此「空串=清除」这条语义在本设计下**不可达**——用户无法清空已保存的 workspace（现状可清：`useQuotaConfigure.ts:31-47` 空+已配置 → payload `''` → `quota-service.ts:361` → `null` 清除）。同一规则在参考原型里还是并集（`demo-b.html:90`），实现者会两难。 | 二选一并写死：①判定改「draft ∨ saved」并保留清除语义（需在禁用/提示上区分「未填」与「清空」）；②保持只看 draft，删掉「空串=清除」的表述并显式登记「本次移除清空 workspace 能力」 |
| SUGGESTION | §7.4（doc:551）+ §6.4（doc:347） | P1-3 受众背景 | readiness 的 provider 侧可用性读的是**已保存快照** `provider.apiKeySet`，而 provider 表单是草稿模型（`ProviderEditBody.vue:320-347` 的 `isDirty`/保存条）。用户在表单里刚填 API Key（未保存）时额度按钮仍灰，界面只给「上方凭据区还没有可用的 API Key」这类提示，与他屏幕上看到的内容矛盾（他刚填了）。 | 在 §6.4/§7.4 补一句跨区块时序说明，并把提示文案拆成两种情况：「未填写（请先在上方填写）」/「已填写未保存（请先保存 provider）」。注：以已保存快照判定本身与 runtime 只读落盘凭证一致，是对的，不必改判定 |
| SUGGESTION | §7.3 改动 1（doc:528） | P1-3 受众背景 | 影响面描述「影响 `getCached` 的后续返回（会带 reason）与对话页浮层」不完整：设置页重开时 `useQuotaConfigure.ts:167` 的 `if (result.data)` 会在 `data=null` 时丢弃 reason，因此 `no-credential` 在**设置页重开路径上不会显示**（仍呈 idle），只有「保存并测试」路径与对话页浮层能看到新文案。 | §7.3 写明这条边界（或让 `loadCached` 在 `data=null && reason` 时也置失败态，使「配置坏了就说出来」在两条路径一致） |

## must-fix 的可复现失败模式（证据链）

1. **来源选择静默失效 / 静默删除**
   - 前置：`secrets/<pid>-apikey.txt` 存在（用户此前保存过专属 Key），`providers.json` `quota.apiKeySet=true`。
   - 操作：某天 provider 侧也配好了 API Key → 打开 provider 编辑体 → 额度区块（source 默认 `'provider'`，§6.4）→ readiness 判 ready（`provider.apiKeySet=true`）→ 点「保存并测试」。
   - 结果 A（只按事件传 `''`）：`configure` 收到 `apiKey=undefined` → 专属 Key 文件保留 → `quota-service.ts:579-580` 先用它发请求。用户看到「用 Provider 凭据」被选中却用了旧专属 Key；若旧 Key 失效得 `unauthorized`，文案只说过期，凭据区写着「已配置」。
   - 结果 B（改为恒传 `''`）：同一路径 `writeApiKeySecret(pid,'')` → `unlinkSync`（`quota-service.ts:334-343`）→ 用户专属 Key 被静默删除。
   - 结论：无论怎么理解「来源切换」这句话，都存在一个未被登记的坏结果 → 必须写成保存时不变量并决定 source 是否持久化。

2. **同值点选类型 → 凭证被删**
   - 操作：MiMo 已配好 cookie（按钮亮）→ 打开类型下拉 → 点当前已选的「小米 MiMo Coding Plan」。
   - 结果：reka 无条件 emit 同值（证据见 Findings 表第 2 条）→ `selectFetcher('mimo')` → D5 的 `configure(pid, enabled, '', 'mimo', '')` → cookie 文件被删、`cookieSet=false`、按钮置灰、下次查询失败。用户主观上没做任何改动。

3. **实施者照抄参考实现 → D3 静默退化**
   - 操作：实施者按 §附录 B 指示打开 `coding-plan-quota-ux.demo.js`，取 `readiness()` 落地。
   - 结果：得到的是并集判定（不看 `credentialSource`），D3 的「显式二选一」与 §7.2 的两分支判定全部丢失，方案回到「留空 = 继承」——即 D3 被否的对象；单测会按同样错误理解写，测不出。

4. **U1 独立合入 → pre-commit 红**
   - 操作：按 §9.1/§10 只改 `packages/shared/src/quota-types.ts` 加 `'no-credential'` + i18n。
   - 结果：`packages/renderer/src/composables/features/model/useQuotaQuery.ts:25` 的 `Record<QuotaFetchFailureReason, string>` 缺键 → `vue-tsc --noEmit` 失败（`.githooks/install-hooks.sh:156`）→ 阶段切分需重做。

## 已核查判为通过的检查项

| 检查项 | 判定 | 依据 |
|---|---|---|
| P0-1 五段骨架 | 通过 | 背景/目标(§1-2) · 现状与根因(§3-4) · 方案与决策(§5-7) · 验收(§8) · 下一层拆分(§10) 齐备 |
| P0-2 delta 链 | 通过 | 正文无「参见上版/Rxx-finding」；附录 C 是单条版本记录 |
| P0-3 结论先行 | 通过 | SCQA 开篇 + 每章首句加粗结论（§1~§11 逐章有） |
| P0-4 问题定义 / 根因 | 通过 | §3.3 四条根因（缺齐备性 / 两来源无统一模型 / enabled 双职责 / 历史叠加）与 §3.2 五个失败模式一一对应，非复述现象 |
| P0-5 重实现轻体验 | 通过 | §3.1 先给控件排布、§3.2 给用户可见后果、§5 给终态用户视角 |
| P0-6 抽象术语有定义 | 通过 | §1 定义 [凭证来源]/[已保存 vs 本次输入]/[齐备性] 并绑例子 |
| P0-7/8/9 方案对比 | 通过 | §6.1 四方案 × 长期架构/短期成本双维度 + 裁决 + 推荐理由 + 被否方案若用会怎样 |
| P0-13 验收可测试/回溯目标 | 通过 | §8.2 九场景均带「回溯目标」列与具体通过标准，可在 `pnpm run dev` 真实环境执行 |
| P0-14 非单测非 mock | 通过 | 真实 provider 凭证 + 具体业务数值（32% / 2h18m / 三窗口）；未用覆盖率或抽象断言 |
| P0-15 投入与改动匹配 | 通过 | §8.1 自评「大」并给 9 场景（4 反向） |
| P0-16 探针 | 通过 | §8.2 S5 的「开关不发请求」标 ⛔ 且给降级路径（禁标志位补丁、回到 §7.1 契约删残留调用）；§11 四条待验证检查点诚实登记 |
| P0-17 物理数据流 | 通过 | §4.1 图标注 `providers.json` / `secrets/<pid>-*.txt` / `quota-cache.json` 物理位置与读写方 |
| P0-18 错误有恢复指引 | 通过 | §7.1 每个 reason 配恢复动作；§5.2 三条失败路径给具体动作（非「请检查」） |
| P0-21 宿主表面不变场景 | 通过 | S9（重启后 providers.json 结构完好、secrets 无空文件残留、浮层仍正常） |
| P1-1/2/3/4/6/7/9 | 通过 | 例子充分；§10 六单元均有 justification；§6 决策均四件套（采用/被否/证据/效果）item 化；每决策有 alternatives；以合并/减法为主；未跨 2 层；章节分组 MECE |
| 事实核对 | 通过 | 抽查的引用全部命中：`quota-presets.ts:42-102` · `quota-service.ts:476-480/511-515/576-596/611-622/309-318/325-349/381-421/643-650` · `useQuotaConfigure.ts:148/199-222/229-269/237/272-299/307-340/348-377` · `CodingPlanSection.vue:15/47/97/116/129/133/152-158/178/205/213/216/97` · `useQuotaDisplay.ts:78` · `ProviderEditBody.vue:205-238/222/320-347` · `provider-config-helper.ts:335` · `quota-message-handler.ts:79` · `useQuotaQuery.ts:25` · `quota-types.ts:44` · `panel.ts:149-153` · `settings.ts:422-487`（zh/en 同号）· 各 fetcher 的 no-subscription 行号（zhipu:115 / kimi:113 / minimax:93,96,100 / mimo:74 / opencode:63-67,97）· `design.md:322/339/340` · §7.5 测试清单 8 个文件均存在；§3.2 失败模式 A/B/C/D 链路与 §6.7 的 `provider.apiKeySet` 聚合语义均与源码一致；§4.2「同 id 重建继承旧凭证」经 `getCredential` 直读文件确认成立 |

## INFO（交接影响面审 / 机械性细节）

- **[影响面审交接]** 写入面除 `providers.json` extras 与 `secrets/<pid>-*.txt` 外还有 `quota-cache.json`（`QuotaCache.update`）与 runtime 内存 `lastFailure`；§4.2/§7.3 改动 3 已登记 secrets 无清理通道（删除 provider 后明文残留、同 id 重建继承），建议影响面审按 P0-19 穷举消费方与清理通道（含 `cleanProviderExtras` 只删 extras 不删 secrets 的对照）。
- **[机械性细节，不计数]** 文档个别源码行号偏移（`provider-config-helper.ts:741-742` 实为 `:981-982`，`cleanProviderExtras` 标注 `:909-921` 实为 `:1204-1216`），引文内容与语义均正确，不影响任何决策。
- **[机械性细节，不计数]** §6 章结论称「11 个决策」但实为 D1~D10 十条；编号计数错乱不影响阅读决策。
