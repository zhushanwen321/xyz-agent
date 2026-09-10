# 影响面审查报告（r7）· Coding Plan 额度查询配置交互重构（方案 B · v7）

> 审查对象：`docs/design/coding-plan-quota-config-ux.md` v7（重新 read：改动 4 出口覆盖段与失配时序 / 改动 2 三级滞后重审条件 / 测试清单 / 附录 C v7）；对照当前工作区 `quota-service.ts`（并行提交后形态）逐出口核实。
> 审查归口：**P0-12 / P0-19 / P0-20**；其余归主审。

## Summary

0 must-fix, 2 suggestions（均为新发现，精度级）。

r6 的 1 must-fix + 2 suggestion 修复**全部成立**：出口覆盖段与当前 `doFetch` 五出口逐一对得上（改动 1 目标态下 `!resolved → fetchFailed('no-credential')` 的枚举正确）、测试断言扩了「失败路径的节流不断」、两种失配时序与三级滞后重审条件均已登记、附录 C 有 v7 条目。本轮按 E3 专项扫「照字面实施不出来/实施出来行为不同」：**未再发现不可实施的条款**；余两处精度问题——出口覆盖段内一句自相矛盾（「唯一不写者」×「`!fetcher` 豁免」并存），以及改动 3 的目标片段漏掉了现状的 try/catch 异常降级（照抄会把 resolver 异常变成 RPC 超时）。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| SUGGESTION（新发现，E1+E2） | §7.3 改动 4「出口覆盖」段（附录 C v7 条目同步） | P0-12 条款内部自相矛盾 + 行为变更未声明 + 结构防漂移 | ① **同段自相矛盾**：「`!fetcher` 早退可豁免——它不发请求」与紧随的「**失配出口是唯一不写者**」并存——豁免成立后有两个不写者（附录 C v7 条目复述了同样表述）。抠字面「唯一」会把豁免撤销或让实施者困惑。② **`!fetcher` 豁免是行为变更且未声明**：现状 `set`（`:480-482`）在早退检查（`:485-486`）**之前**，即该出口今天**也被节流**；豁免后每次 hover 重跑本地判定——已核量为 2 次小文件读盘（`getExtrasSync` 直读 providers.json + `getProviderConfig` 读 models.json）+ `matchQuotaPreset`，无请求、无日志，速率受 hover 事件与 renderer 侧 `markPending` 去重双重有界，**「无害」判定成立**；但这是「后移」隐带的行为变化，按文档自己的风格（改动 1 有「行为变更点」段）应显式声明。③ **枚举防漂移**：「全部出口」原则 + 五出口快照的定位对**实施**足够（规则是原则、枚举是证据）；对**漂移**（并行工作流再改 `doFetch` 出口形态——本轮已核实他们最近一次提交仍动了 quota-service 所在链路）不免疫 | 一句话三改：把「失配出口是唯一不写者」改为「失配与 `!fetcher` 早退两个出口不写」（附录 C v7 同步）；补半句行为变更声明（含读盘量级与有界性）；建议补一句结构收口——五出口收口为单一收尾 helper（守卫 + 三件套写只写一遍），新出口不经过 helper 即不写、行为可见而非静默，把出口覆盖从清单纪律升级为结构保证（与文档在 handler 整对象透传、字段级白名单两处已用的手法一致） |
| SUGGESTION（新发现，E3 命中） | §7.3 改动 3 目标片段（`quota-service.ts:576-596`） | P0-11/P0-12 片段与代码形态不符（正是本轮复发模式） | 现状 provider 凭据段有 **try/catch 异常降级**（`c13351c26` 加入，注释明言「读取异常降级为『无凭据』…不阻断 `resolveCredential`」），而改动 3 的目标片段是**裸调用** `const resolved = await this.credentialResolver.resolveProviderCredential(...); return resolved?.key ?? null`。**失败模式**：`resolveCredential` 在 `doFetch` 的 try **之外**（`:486`，try 只包 `fetchQuota`）——照抄片段删掉 try/catch 后，resolver 异常（auth.json 读失败 / models.json 解析异常）会逃出 `doFetch` → RPC reject、无 reply → renderer 走 `RPC_BACKSTOP_TIMEOUT_MS` 超时，从「降级 null → `no-credential` 可诊断失败」退化为「无响应」。片段与同段自述「本设计不改动该段」也矛盾（不改动就该带上 try/catch） | 片段补上 try/catch（或加一行「片段省略现状的异常降级，实施时保留」）；这是 E3 专项在 v7 新审文本里找到的唯一一处「片段与形态不符」 |

## r6 must-fix / suggestion 修复核验

| r6 项 | 判定 | 核验证据 |
|-------|------|----------|
| MF · 出口覆盖声明 | ✅ 已修 | 出口覆盖段落入：五出口枚举与当前 `doFetch` 逐一对上（`!fetcher` 早退 `:485-486` / `!resolved`（改动 1 后为 `no-credential`）/ 成功 `cache.update` / `fetchFailed(reason)` / throw → `fetchFailed('network')`）；「今天的开头一次性写覆盖全部出口、失败也节流 = 表 A #13 速率前提」的论断与代码一致（set `:480-482` 先于一切出口）；「只放成功路径旁 → 速率无上界」失败模式写入；测试断言扩「失败路径的节流不断——`fetchFailed` 后 10s 内第二次 hover 不再发真实请求」。余三处精度 → SUGGESTION 1 |
| S1 · 失配返回时序登记 | ✅ 已修 | 两种时序都有出处（晚于 refresh → 读到新行正向；早于 → 一跳「暂无数据」、下一 hover 不被压制自愈）；「saveAndTest refresh 走设置页本地态不写 store」的核实结论也写入 |
| S2 · 三级滞后重审触发条件 | ✅ 已修 | 「出现矛盾反馈 → 半提交改 unlink 失败时一次性回写 `cookieSet` 实际文件状态（区别于已否决的常驻读侧校正）」入 bullet |

## 聚焦攻击点答复

**E1 · `!fetcher` 豁免 → 无害成立，但需声明。** 已核：豁免后该出口每次 hover 重跑 `getFetcherForProvider` = 2 次小文件读盘 + 本地匹配，无请求无日志；速率受用户 hover 事件与 renderer `markPending` 去重双重有界（`runFetch` 的 pending Map 也在微任务窗口内去重）。「无害」判定成立 ✅。但它是行为变更（今天该出口被节流），且条款里「失配出口是唯一不写者」与豁免自相矛盾——见 SUGGESTION 1①②。

**E2 · 枚举防漂移 → 原则+快照对实施足够，对漂移不免疫，补一句结构收口即可。** 「`set` 必须落在守卫通过后的全部出口」是规则、五出口是证据快照——实施者按规则走不会错；但若并行工作流给 `doFetch` 加第六个出口，按枚举实施的人可能漏掉它。结构收口（单一收尾 helper，守卫与三件套写只写一遍）让新出口天然暴露而非静默漏写——与文档已两次使用的「用结构消除清单」手法（handler 整对象透传、字段级白名单）一致。见 SUGGESTION 1③。

**E3 · 专项扫描 v7 新增文本 → 一处命中（改动 3 片段），无不可实施条款。** 逐条核过：出口覆盖段（现可实施 ✅）、失配返回时序（`getCached` 语义正确，且核实到 `getCached` 会带上新类型已失败的 `lastFailure` reason → `setError` 显示诊断，正向 ✅）、改动 6 继承链（helper 存在 ✅）、端到端链 8 段守门（编译错三条均验证过 ✅）、`QuotaConfigurePayload` 分期（wire 兼容已验 ✅）。唯一「照字面实施行为不同」的是改动 3 片段漏 try/catch → SUGGESTION 2。

## 交叉引用一致性终检

| 项 | 结论 |
|---|---|
| 守卫出口覆盖段 ↔ 测试清单 ↔ 附录 C v7 | 三处同步 ✅（测试断言含「失败路径节流不断」；附录 C v7 条目完整）；唯附录 C v7 复述了「唯一不写者 × 豁免」的矛盾表述，随 SUGGESTION 1 一并改 |
| 失配时序登记 ↔ §7.1:650 | ✅ 互引未破坏 |
| 三级滞后重审条件 ↔ 改动 2 bullet | ✅ 已入四要素 |
| 改动 3 片段 ↔ 现状代码 | ❌ 漏 try/catch（SUGGESTION 2） |
| 遗留机械项 | §4.2 注 / §6.13 证据 / 附录 A 的 provider-config-helper 行号（`:1214-1226` 等）仍为漂移值——历轮 INFO，本轮仍未同步（实际 `:1265/:1315/:1386/:1395` 一带） |

## INFO（不计入 must-fix/suggestion）

- 上述行号漂移未同步（建议全文统一为符号锚）。
- 旁证（正向核实）：出口覆盖段的五出口与当前工作区 `doFetch` 逐一吻合；`resolveCredential` 确在 try 之外（SUGGESTION 2 的失败链成立前提）；`getCached` 失配返回在「新类型已失败」时会带 reason 并被 `setError` 正确消费。

## 结构化输出

```json
{ "report_file": "docs/design/coding-plan-quota-config-ux.impact-review.md", "must_fix": 0, "suggestion": 2 }
```
