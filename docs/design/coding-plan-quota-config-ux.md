# Coding Plan 额度查询配置交互重构（方案 B）

> **一句话结论**：给设置页的「Coding Plan 额度查询」区块引入一个纯本地派生的**齐备性**判断作为唯一的按钮门控，把「保存」与「测试」合成一次点击，让「启用」开关退化为不带任何网络副作用的纯配置位，并补上缺失的 `no-credential` 失败原因；同时把「用哪份凭证」从隐式约定变成**持久化的显式选择**，让 UI 的承诺与 runtime 的实际行为无法背离。

> 交互选型由四个可点原型（`coding-plan-quota-ux.demo-{a,b,c,d}.html`）驱动，用户选定**方案 B**（平铺 + 单按钮「保存并测试」+ 凭证来源分段控件）。

---

## 开篇（SCQA）

- **S（情境）**：太极（xyz-agent）的设置页里，每个 provider 可以绑定一个「Coding Plan 额度查询」。配好之后，在对话框的容量浮层里就能看到该 provider 的 5h / 本周 / 本月套餐余量。目前支持 5 个平台：智谱 GLM、Kimi、MiniMax、小米 MiMo、opencode.go。
- **C（冲突）**：这个配置区块的交互是历史上按「每加一个平台加一个字段、每加一种认证加一个按钮」的方式叠出来的。今天它有 5 个各自即时写盘的控件，网络请求被打包进「开启」和三个「保存」里，而且**根本不存在「参数是否齐备」这个概念** —— 每个控件的可用性只能各自局部判断。更隐蔽的是，「这次查询用哪份凭证」这个决定从未被持久化，UI 显示的选择和 runtime 实际用的凭证可以长期不一致。
- **Q（问题）**：怎么让用户在配置这个能力时，始终能回答三个问题 —— *我还差什么？现在能不能测？测出来是什么？* —— 同时不再产生「配置已落盘但永远查不到」和「界面说用 A 凭证、实际用了 B 凭证」这两类坏状态？
- **A（答案）**：引入齐备性（readiness）派生量统一门控按钮；「保存」与「测试」合成一次点击；开关只写配置不发请求；凭证来源持久化并由 runtime 共同遵守；补 `no-credential` 让最常犯的错误第一次变得可诊断。

---

## 1. 背景：被设计的系统是什么

**本章结论：本次聚焦「设置页里一个 provider 的额度查询配置区块」，不涉及额度抓取逻辑本身与浮层的展示形态（仅补一个恢复入口）。**

**[Coding Plan 额度查询]** 是一个只读的附加能力：它按 provider 配置去对应平台的用量接口拉一次数据，把「5h / 本周 / 本月」三个窗口的已用百分比渲染到两个地方 —— 设置页的配置区块内（测试结果预览）和对话框的容量浮层（`ContextCapacityPopover`）。

它的数据链路是：

```
用户在设置页填参数 → providers.json / secrets 文件 → QuotaService 读凭证
   → 各平台 HTTP 接口 → quota-cache.json → WS RPC → 前端展示
```

配置侧有四个核心概念，后面会反复用到：

- **[凭证来源]** = 查询时用哪份凭据。api-key 类平台有两种可选来源：**Provider 凭据**（provider 自己的 API Key，或 OAuth 登录态）与**额度专属 Key**（只给额度查询用，存 secrets 目录）。cookie 类平台只有一份专属 Cookie，没有选择余地。
- **[已保存 vs 草稿]** = 磁盘上已有的配置 / 用户在输入框里刚敲但还没落盘的内容。两者的区别决定了「参数算不算填过」。
- **[齐备性]** = 当前选中的平台类型所需的全部参数，是否都能从「已保存」或「草稿」里解析到值。**这是纯本地计算，不涉及网络、不涉及落盘。**
- **[凭证归属]** = 一份凭证是为哪个平台类型而存的。凭证按 provider 存储、不含类型信息，所以「MiMo 的 cookie 在 opencode.go 上是否算数」必须由规则显式回答 —— 详见 D5。

平台类型本身差异是真实的、消不掉的（见下表），本次设计不试图抹平差异，而是让差异不再外溢成三套交互。

| 下拉项 | 认证方式 | 必须齐备的参数 | 需要 Workspace | 返回窗口 |
|---|---|---|---|---|
| 智谱 GLM Coding Plan | api-key | Provider 凭据 **或** 专属 Key | 否 | 仅 5h |
| Kimi Coding Plan | api-key / oauth | Provider API Key **或** OAuth 登录 **或** 专属 Key | 否 | 5h + 本周 |
| MiniMax Coding Plan | api-key | Provider 凭据 **或** 专属 Key | 否 | 5h + 本周 |
| 小米 MiMo Coding Plan | cookie | Cookie | 否 | 仅本月 |
| opencode.go | cookie | Cookie **且** Workspace 地址 | **是** | 5h + 本周 + 本月 |

（来源：`packages/shared/src/quota-presets.ts:42-102`；窗口能力来源：各 fetcher 的 `wins` 构造，见 `packages/runtime/src/services/quota-providers/*.ts`。）

## 2. 设计目标

**本章结论：改造后使用者在配置这个能力时，全程不需要猜测 —— 缺什么看得见、能不能测看得见、测的结果说得清、系统用的凭证就是界面上说的那份。**

从使用者体验倒推，本次要达成的五条：

1. **填参数时立刻知道还差什么**，不必先点一下按钮才知道错。
2. **一次点击完成「落盘 + 验证」**，不需要理解保存和测试的先后顺序。
3. **「启用」开关只表达「要不要在浮层里展示」**，不给它附加任何网络副作用。
4. **界面上说的凭证就是实际用的凭证**，任何时候都不出现「显示用 A、实际用 B」。
5. **不制造坏状态**：不产生「配置写进去了但永远查不到」，不把凭证写坏或静默删掉。

**In-scope**

- 设置页 `CodingPlanSection` 区块的交互与布局
- `useQuotaConfigure` composable 的状态模型与动作集
- `QuotaConfigureState` 契约（core ↔ ui/renderer 共享）
- runtime：`no-credential` 失败原因；cookie 的「空串 = 清除」语义；**按持久化的凭证来源选择解析凭证**；失败标记的清理；provider 删除时清理 quota secrets
- shared：`QuotaFetchFailureReason` 枚举扩展；`ProviderInfo.quota` 增加 `credentialSource` 字段；凭证来源解析函数
- `ContextCapacityPopover` 失败态补一个「配置」恢复入口（见 D11）
- i18n：新增/调整相关中英文文案；清理 10 处硬编码中文错误消息
- 上述所有改动对应的测试

**Out-of-scope**

- 新增平台类型 / 修改任何 fetcher 的解析逻辑与端点
- `ContextCapacityPopover` 的展示形态（成功态与无数据态不动）
- 额度缓存的 TTL / 10s throttle / pending 并发去重策略
- provider 表单其余字段的「草稿 + 底部保存条」提交模型（D10）
- `quota-cache.json` 的存储格式与磁盘清理

---

## 3. 现状：使用者眼里是什么样的

**本章结论：现状下最常走的那条路 —— 先打开开关再补参数 —— 会得到一个「已启用但永远查不到」的状态，而且用户看不到原因；另有两条路径会静默损坏或静默误用凭证。**

### 3.1 现状的真实样子

区块的控件排布（取自 `packages/ui/src/features/settings/coding-plan/CodingPlanSection.vue`）：

```
Coding Plan 额度查询
├─ 类型            [下拉：智谱 / Kimi / MiniMax / MiMo / opencode.go]   ← 改即落盘，无保存按钮
├─ 启用额度查询     [开关]                                             ← 打开后会自动发一次查询
├─ 认证方式         API Key 已配置 / API Key 未设置
├─ 专属 API Key    [输入框]  [保存]                                    ← 第 1 个保存按钮
├─ （Cookie 类）    Cookie  [已配置/未配置]
│                  [textarea]
│                  [保存 Cookie]                                        ← 第 2 个保存按钮，隐含「开启」
├─ （opencode）    Workspace 地址 [输入框] [保存]                        ← 第 3 个保存按钮
└─ 测试查询（仅启用后出现）
```

五个控件各自写盘，语义各不相同（取自 `useQuotaConfigure.ts`）：

| 控件 | 本地校验 | 写给 runtime 的 payload | 额外副作用 |
|---|---|---|---|
| 类型下拉（`:199-222`） | 无 | `configure(pid, enabled, undefined, 新类型)` | 改即落盘；`enabled` 被当前值重写 |
| 启用开关（`:229-269`） | cookie 类开启时要求 cookie 非空 | `configure(pid, !enabled, undefined, fetcherId)` | **开启成功后自动发一次查询**（`:247-253`） |
| 保存专属 Key（`:307-340`） | 无（空串 = 清除） | `configure(pid, enabled, undefined, fid, apiKey)` | 已启用时自动查询 |
| 保存 Cookie（`:272-299`） | 空输入拦截 | `configure(pid, **true**, cookie, fid)` | **强制开启** + 一定查询 |
| 保存 Workspace（`:348-377`） | URL 归一化 | `configure(pid, enabled, undefined, fid, undefined, ws)` | 已启用时自动查询 |

按钮的禁用条件也是散的（`CodingPlanSection.vue`）：保存 Key `:116` 只看 `configuring`；保存 Cookie `:205` 看 `configuring || !cookieInput.trim()`；保存 Workspace `:178` 只看 `configuring`；测试按钮 `:133/:216` 看 `testStatus === 'loading'`，且**必须先启用才出现**（`:129`、`:213` 的 `v-if="enabled"`）。

要注意的是，现状并非实现者写错 —— 最早的设计文档就是这么定的：

> `docs/page-design/archive/v3/coding-plan-quota/design.md:339`
> 「**开关**：默认关闭。打开后立即调 `quota.refresh` 测试一次，成功显示「✓ 已获取额度」，失败显示错误」

本次设计要推翻的正是这条早期约定。

### 3.2 怎么出错

**失败模式 A（最高频）：没填凭证就打开开关，得到一个永远查不到的「已启用」状态。**

触发条件：任何 provider，拨开启用开关。

链路：`toggleEnabled` 对 api-key 类**没有任何前置校验**（`useQuotaConfigure.ts:237` 只判 cookie 类）→ `configure` 成功 → `enabled=true` 落进 providers.json → 自动 `testQuery` → runtime `resolveCredential` 凭证链全 miss → `quota-service.ts:476-480` **静默 `return this.getCached(providerId)`（不带任何 reason）** → 前端拿到 `data=null, reason=undefined` → 只能落到通用文案「查询失败，请检查凭证」。

结果：配置已经持久化、开关停在「开」、浮层里出现一个空的额度区块（`useQuotaDisplay.ts:78` 只判 `quota.enabled`），而用户不知道到底缺什么。

**失败模式 B（会损坏数据）：cookie 输入框里的掩码会被当成有效输入写进 secrets，覆盖真 cookie。**

触发条件：任何 cookie 类 provider，保存过一次 cookie 之后，再次点「保存 Cookie」而没修改输入框。

链路：`useQuotaConfigure.ts:148` 把已配置的 cookie 回显成字面量 `'••••••••'` 填进输入框 → `CodingPlanSection.vue:205` 的禁用条件是 `!cookieInput.trim()`，掩码非空所以按钮可点 → `:286` 原样把输入交给 `configure` → `quota-service.ts:309-318` 直接写盘。

结果：`<dataDir>/secrets/<pid>-cookie.txt` 里的真 cookie 被 8 个圆点替换。之后所有查询返回 `unauthorized`，而用户看到的输入框里本来就显示圆点 —— **没有任何线索指向真正的原因**。

**失败模式 C：切换查询类型时，旧平台的凭证仍被当作「已配置」。**

触发条件：已配好 MiMo 的 cookie，把类型改成 opencode.go。

链路：凭证按 provider 存储（`<pid>-cookie.txt`），不含类型信息。切类型后它依旧存在、仍算「填过」，而两个平台的 cookie 完全不通用。

结果：用户点测试 → 拿 MiMo 的 cookie 请求 opencode.ai → 返回 `unauthorized` → 文案说「凭证可能过期」，把他引向「刷新凭证」而不是「你填的是另一个平台的 cookie」。

**失败模式 D（会静默误用凭证）：界面说「用 Provider 凭据」，runtime 却用了专属 Key。**

触发条件：某 provider 曾经存过额度专属 Key，后来用户改用 Provider 凭据。

链路：「用哪份凭证」这件事今天**完全没有被表达，更没有被持久化**。runtime 的 `getCredential('api-key')` 是一条固定链，**专属 Key 永远优先**（`quota-service.ts` `getCredential` 的 api-key 分支；provider 凭据段 auth.json → models.json 已收口到注入的 `credentialResolver`，但**收口不改变优先级**）：

```ts
if (kind === 'api-key') {
  const quotaKey = this.readSecret(this.getApiKeyPath(providerId))
  if (quotaKey) return quotaKey          // ← 只要文件在，就永远先用它
  try {
    const resolved = await this.credentialResolver.resolveProviderCredential(providerId)
    return resolved?.key ?? null         // ← auth.json api_key → models.json apiKey（异常降级 null）
  } catch {
    return null
  }
}
```

只要专属 Key 文件还在，无论用户怎么想，查询都会用它。若该 Key 恰好有效（比如属于另一个账号），用户会看到**另一个账号的额度数据** —— 静默错数据，比报错更难发现。

**失败模式 E：点「取消」放弃 provider 编辑，额度配置却留在磁盘上。**

触发条件：改动 provider 的 baseUrl，同时改了额度配置，然后点取消。

链路：provider 表单是草稿模式（`isDirty` → 底部保存条，`ProviderEditBody.vue:320-347`），但额度区块的所有操作即时走 `quota.configure` RPC，既不进 `isDirty` 也不受取消影响。

结果：baseUrl 回滚了，额度配置没回滚。用户以为撤销了全部改动。

**失败模式 F：三个「保存」按钮的语义各不相同。**

「保存 Cookie」隐含「启用」，「保存专属 Key」不隐含，「保存 Workspace」也不隐含。同一个词在同一个区块里指三件事。

### 3.3 根因

**根因 1（主因）：缺少「齐备性」这一派生概念。**

一旦没有它，每个控件的可用性就只能退化成局部判断 —— 结果就是 5 个控件 5 套禁用条件，且没有一个是关于「参数是否够用」的。唯一的必填校验（cookie 非空）被写在了开关那条路径上，而测试按钮压根看不见它。

**根因 2：「用哪份凭证」是一次未被表达、更未被持久化的决定。**

系统的行为事实是「专属 Key 永远优先」，但 UI 上没有任何东西表达这件事，providers.json 里也没有对应字段。于是界面可以显示「使用上方「凭据」区填写的 API Key」（`CodingPlanSection.vue:125` 的 `quotaApiKeyFallbackOrder` 文案）而 runtime 实际用的是专属 Key —— **UI 的承诺与 runtime 的事实之间没有任何约束**。失败模式 D 是它的直接后果。

**根因 3：「草稿」与「已保存」两种来源没有统一模型，判定只好退化成隐式约定。**

专属 API Key 的注释写着「留空 = 复用上方填写的 provider API Key」（`CodingPlanSection.vue:97`），但界面上一个空输入框既可能表示「继承」，也可能表示「我还没填」—— 用户和代码都没法区分。齐备性判定必须同时考虑两种来源，这正是根因 1 难落地的原因。同理，凭证「属于哪个平台」也从未被表达（失败模式 C）。

**根因 4：`enabled` 一个字段承担了两个职责。**

它既是「要不要在浮层展示」（纯展示开关），又是「触发一次验证查询」的动作入口（`useQuotaConfigure.ts:247-253`）。这两件事耦合在一起，使得「打开开关」的语义永远说不清。

**根因 5：历史叠加，每多一种形态就多一个按钮和一个触发点。**

api-key 类加专属 Key → 加一个保存按钮；cookie 类 → 再加一个；opencode 的资源维度 → 再加一个 workspace 保存，并给三个保存都挂上「已启用则自动查询」。网络请求的触发点从 1 个涨到 5 个。

---

## 4. 根因 + 物理数据流

**本章结论：五个根因共同指向同一件事 —— 交互缺一个「本地可判的完成度」层，且「用哪份凭证」这个决定没有落点；于是所有判断都被推到了「点一下试试」上。**

### 4.1 物理数据流

```
磁盘                                      runtime                          renderer
────────────────────────────────────────────────────────────────────────────────────────
<dataDir>/pi/agent/config/providers.json
  providers.<pid>.quota {
    fetcher, enabled, credentialSource,
    cookieSet, apiKeySet, workspace }
      │
      │ (读) XyzProviderStore.readAllSync
      └──────────────> listProviders 聚合 ──┐
                                            │
<dataDir>/secrets/<pid>-cookie.txt          │  ProviderInfo.quota
<dataDir>/secrets/<pid>-apikey.txt          │        │
      │                                     │        │
      │ (写/删) QuotaService.configure       │        │
      │ (读)    QuotaService.getCredential  │        │
      │         ↑ 按 credentialSource 选链  │        │
      │                                     │        │
      └──> 各平台额度 HTTP 接口              │        │
                │                           │        │
                │ cache.update              │        │
<dataDir>/quota-cache.json                  │        │
      │                                     │        │
      │ (读) getCached                      │        │
      └─────────────────────────────────────┴────────┴──WS RPC──> useQuotaConfigure
                                                                        │
                                                            ┌───────────┴───────────┐
                                                            │                       │
                                                  CodingPlanSection          ContextCapacityPopover
                                                    （设置页）                   （对话页）
```

（路径来源：`quota-service.ts:643-650` 的 `getCookiePath` / `getApiKeyPath`；`quota-cache.ts`；providers.json 路径 SSOT = `pi-paths.getProviderExtrasPath` —— `<dataDir>` 缺省 `~/.xyz-agent`、由 `getDataDir()` 推导，**不是**系统 pi 的 `~/.pi/agent`（ADR-0009 数据目录隔离；`shared/src/paths.ts:36-51` 注释明文「返回 `<dataDir>/pi/agent`，不是系统 pi 的 `~/.pi/agent`」）。）

### 4.2 写入面穷举（本次设计的完整接触面）

**表 A：持久状态与清理通道**

| # | 写入面 | 写入路径 | 清理通道 | 本次新增写入？ |
|---|---|---|---|---|
| 1 | `providers.json` 的 `quota` 字段 | `QuotaService.persistQuotaConfig`（`quota-service.ts:381-421`） | provider 删除时 `cleanProviderExtras` | **是**（新增 `credentialSource` 字段） |
| 2 | `providers.json.tmp`（atomicWrite 中间产物） | `atomicWrite` | rename 即消费 | 否 |
| 3 | 锁目录 + `ensureFileExists` 物化空文件 | `provider-extras-store.ts:67-84` | 锁释放 | 否 |
| 4 | `secrets/<pid>-cookie.txt` | `writeCookieSecret`（`:309-318`） | provider 删除时 `clearProviderState`（改动 5，仅当 `cleanProviderExtras` 成功后执行） | **是**（新增清除语义） |
| 5 | `secrets/<pid>-apikey.txt` | `writeApiKeySecret`（`:325-349`） | provider 删除时 `clearProviderState`（同上） | 否（已有清除分支） |
| 6 | `secrets/` 目录本身 | `ensureSecretsDir`（`:293-306`，**persist 成功后无条件执行**——改动 2 的顺序重排后，persist 失败的 configure（provider 不存在 / workspace 非法 / extras 写入异常）不再物化它） | 无 | 否（但拨开关也会物化它——开关同样走 persist 成功路径） |
| 7 | 进程级 `process.umask` 临时清零 | `writeSecretFile`（`:632-639`）、`ensureSecretsDir`（`:296`） | `finally` 恢复 | 否 |
| 8 | `quota-cache.json`（含同目录 `.tmp` 中间产物，rename 即消费） | `QuotaCache.update` / 新增 `removeEntry`（与 `update` 共用 `writeChain`，见改动 4） | **本次新增**：`configure` 检测到 fetcher 变更时删该条目（改动 4）；provider 删除时删（改动 5）。此前无任何删除通道 | 否 |
| 9 | `quota-cache` 内存镜像 | `QuotaCache` 内存 Map | **本次新增**：同上（`removeEntry` 同步删镜像条目） | 否 |
| 10 | runtime `lastFailure` Map | `fetchFailed`（`:511-515`） | 成功 fetch 时 `delete`；**本次新增**：`configure` 成功时（改动 4）+ provider 删除时（改动 5，`clearProviderState`） | **是**（`no-credential` 是新增写入源） |
| 11 | runtime `lastFetchTime` / `pending` Map | 拆开：`pending` → `runFetch`（`:173-199`，只读 `lastFetchTime` 做 throttle 判定并管理 pending）；`lastFetchTime` → `doFetch` 起点的 throttle 写 —— 改动 4 写点迁移后 = 守卫通过的**收尾 helper**（完成时刻） | `pending` 在 `finally` 删；`lastFetchTime` **本次新增**清理（改动 5，`clearProviderState`） | 否 |
| 12 | renderer `quotaStore`（内存） | `setCache` / `setError` / `clearCache` | `clearCache` | 否 |
| 13 | `<dataDir>/logs/` | `logger.warn('[quota] fetch failed')`（`:500`） | 日志轮转 | **是**（凭证缺失从零日志变为每次一条 warn） |
| 14 | WS 广播 `config.providers` + `model.list` | `broadcastProviderList`（`quota-message-handler.ts:79`） | — | 否（次数不增，详见 §11.2） |
| 15 | 第三方平台 HTTP 请求 | `fetcher.fetchQuota` | — | 否 |
| 16 | GUI 状态（浮层失败态） | — | — | **是**（D11 新增恢复入口） |

加粗的 **5 项**（#1 / #4 / #10 / #13 / #16）是本次新增的写入点；其中 #1（新增字段）、#4（新增清除语义）、#10（新增写入源）必须配套清理通道，由 D12 提供；#16 是 D11。

> **[影响面发现] secrets 明文无清理通道**：`cleanProviderExtras` 只删 providers.json 条目（`provider-config-helper.ts:1265-1278`）；`cleanAuthCredential` 只清 auth.json（`:1239-1263`）；两条删除链的清理调用（custom `:1395`；catalog `:1383`/`:1386`）**都没有清理 quota 的 secrets 文件**。删除一个配过额度的 provider 后，cookie / 专属 Key 的明文留在磁盘上，且「同 id 重建」会继承这些旧凭证 —— 而项目已有 M5-05「同 id 重建不静默继承旧配置」不变式（`:1256`），本条缺口正是该不变式的漏网面。D12 把它纳入本次实施。

---

## 5. 终态：使用者眼里将是什么样的

**本章结论：使用者全程只需要看「还缺什么」这一条信息，配置完点一次就行；开关可以随时拨，不带任何意外；界面上说的凭证就是实际用的那份。**

### 5.1 成功路径

智谱 provider 已经在上方「凭据」区填好了 API Key，现在来配额度查询：

```
【未选类型】
  Coding Plan 额度查询
  类型  [未选择 ▾]
        先选一个查询类型，下面的参数会按类型自动变化。
        ↑ 此状态下不渲染开关与任何参数

【选了智谱】
  类型  [智谱 GLM Coding Plan ▾]
  启用额度查询                                      [ ○]
        在对话框容量浮层里展示配额；可随时开关，不触发查询
  凭证来源   [ 用 Provider 凭据 ] [ 用专属 Key ]
        使用上方「凭据」区填写的 API Key
  [ 保存并测试 ]        ← 已可点（Provider 凭据齐备）

【点了保存并测试】
  [ 查询中… ]
  ✓ 查询成功 · 刚刚
    5h    ▓▓▓░░░░░░░░░░  32%   2h18m
    本周  ──────────────  ∞     --
    本月  ──────────────  ∞     --

【拨开开关】
  启用额度查询                                      [ ●]
  （不发任何网络请求）
```

之后在对话框里 hover 容量 chip，浮层的 coding-plan 区显示同样的三行数据。

**用专属 Key 的路径**：用户把「凭证来源」切到「用专属 Key」→ 出现专属 Key 输入框 → 粘贴 → 「保存并测试」。此后查询固定用这份 Key；切回「用 Provider 凭据」后，专属 Key 文件仍在磁盘上但**不会被使用**（runtime 按持久化的来源选择解析凭证），切回去不需要重新粘贴。

### 5.2 失败路径（带恢复指引）

**路径 1 · 参数没填完**

```
  类型  [小米 MiMo Coding Plan ▾]
  Cookie  · 必填
  [ textarea ]
  这里必须填 —— 该平台的额度接口只认 Cookie，没有继承路径
  登录 platform.xiaomimimo.com 后，从浏览器 DevTools → Application → Cookies 复制完整 cookie 字符串

  [ 保存并测试 ]  ← 置灰
  参数齐全后可点
```

👉 **恢复动作**：按字段下方的指引获取并粘贴 cookie。按钮自动变亮，不需要别的操作。

**路径 2 · 切换类型后凭证归属失效**

```
  类型  [opencode.go ▾]        ← 从「小米 MiMo」改过来
  Cookie  · 必填
  [ textarea ]
  这里必须填 —— 该平台的额度接口只认 Cookie，没有继承路径
  Workspace 地址 · 必填
  [ input ]
  这里必须填 —— 额度挂在具体 workspace 下，同一个 Cookie 可能对应多个
  [ 保存并测试 ]  ← 置灰（原 MiMo 的 Cookie 不再计入）
```

👉 **恢复动作**：粘贴 opencode.ai 的 Cookie + 填 Workspace 地址。

**路径 3 · 填了错凭证**

```
  [ 保存并测试 ]
  ✗ 额度查询失败：凭证可能过期。与该供应商发起一次对话触发凭证刷新后，点击「保存并测试」重试
```

> **文案的动作必须指向本屏真实存在的控件**（一致性审查订正）：设置页区块内只有「保存并测试」，没有「刷新」——「刷新」入口存在于对话页浮层（路径 5 / D11）。两处各按其所在界面写（对话页的对应 key 在 `panel.context.*`，设置页的 `quotaFetchFailUnauthorized` 只说「保存并测试」），否则用户会按图索骥找一个不存在的按钮。

👉 **恢复动作**：api-key 类文案已给出具体动作（发起一次对话刷新 OAuth）。cookie 类平台按失败原因分支（与 `no-credential` 的 cookie 变体同一手法，先例 `CodingPlanSection.vue:398-404`）：`unauthorized` 显示「凭证可能已失效。请从浏览器重新复制该平台的 Cookie 粘贴后重试」——「发起一次对话刷新」对 cookie 用户是不存在的动作；`no-subscription` 沿用既有两可提示「未检测到有效订阅或 Cookie 已失效，请检查订阅状态或更新 Cookie」。`unauthorized` 变体同时是 §7.3 改动 2 登记的反向残余的可诊断出口（孤儿 cookie 被 fetch 读到旧平台值 → 平台 401/302 → 正是这条文案）。

**路径 4 · 缺凭证（前端判定漏掉的边缘情况）**

```
  [ 保存并测试 ]
  ✗ 额度查询失败：未找到可用凭证。请在上方「凭据」区填写 API Key，或在此填写专属 API Key
```

👉 **恢复动作**：文案直接指向两个可执行的位置。这条文案就是本次新增的 `no-credential`，替代了今天那句什么都说不清的「查询失败，请检查凭证」。

**cookie 类平台需要一份变体**：cookie 类 provider 同样会出现 `no-credential`（`cookieSet=true` 但 secrets 文件缺失的幽灵态 —— §7.3 改动 2 登记的窗口）。此时 api-key 语境的两个位置对用户都不存在，文案会把他指向不存在的动作。按 `authKinds.includes('cookie')` 分支：

```
✗ 额度查询失败：未找到可用凭证。请在下方重新粘贴该平台的 Cookie 后重试
```

先例：`CodingPlanSection.vue:398-404` 已用同样的手法给 `no-subscription` 做过 cookie / 非 cookie 两套文案。

**路径 5 · 在对话页看到额度查询失败**

浮层的 coding-plan 区在失败态下显示错误文案，**同时**渲染两个按钮：「刷新」与「配置」（跳转设置页）。今天这个位置只有「刷新」，而刷新在凭证缺失时只会再失败一次，形成死路 —— 见 D11。

---

## 6. 关键决策与权衡

**本章结论：13 个决策。前 4 个建立齐备性模型，中间 5 个收敛写入与请求路径，后 4 个是正确性与恢复通道的硬约束。**

### 6.1 交互方案对比（四选一）

四个候选已做成可点原型（`docs/design/coding-plan-quota-ux.demo-{a,b,c,d}.html`）。四个方案都纳入了齐备性门控（按钮按参数完整性置灰、开关不触发网络请求、字段级/按钮级缺失提示），**方案 B 额外引入了「凭证来源」维度**（见 D3），因此它的齐备性判定比其余三个多一个分支。

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A · 平铺 + 双按钮** | 中：仍保留「保存」与「测试」两个概念，但与现有结构一一对应 | **低**：仅合并三个保存 + 加齐备门控 | 低 | ❌ |
| **B · 平铺 + 单按钮「保存并测试」+ 凭证来源分段** | 高：动作数与语义一一对应；凭证来源不再靠隐式约定 | 中：composable 重构 + 区块重写 | 中 | ✅ |
| **C · 分步引导** | 中：类型差异被步骤吸收，但引入了新的步骤状态机 | 中高：需维护「哪一步展开/完成」的额外状态 | 中高：老用户嫌绕，回改风险大 | ❌ |
| **D · 摘要 + 折叠编辑** | 高（另一个维度）：设置页信噪比最优 | 中：在 B 之上加一层折叠壳 | 中：首次配置多一次展开 | ❌（可与 B 叠加，不在本次） |

**推荐 B。** 理由：A 保留了「保存/测试」两个概念，没解决失败模式 F（「保存」一词在区块内有三种含义）；C 用更多状态换更少的字段，把复杂度从「字段」搬到了「步骤」，对已经熟悉这套配置的用户是净负担；D 解决的是另一个问题（设置页密度），它和 B 不冲突，可以后续叠加，但本次不引入。

**被否方案若用会怎样**：

- 用 **A**：§5.1 的成功路径会多一步 —— 用户填完 cookie 后必须意识到「先点保存、再点测试」是两次点击，而保存按钮此刻可能是灰的（无改动）或亮的（有改动），他得先判断属于哪种。§3.2 失败模式 F 原样保留。
- 用 **C**：§5.2 路径 1 的字段级提示会变成「步骤 2 未完成」，用户要多点一次「更改」才能看到自己缺什么。
- 用 **D**：已配置的 provider 默认收起，§5.1 的首次配置路径多一次「配置」展开点击。

### 6.2 D1：齐备性作为唯一的按钮门控（选定）

- **采用**：新增纯本地派生的 `readiness`，返回 `{ ready, missing[] }`。它是「保存并测试」按钮禁用状态的**唯一**依据。判定规则按类型分派（见 §7.2），核心是「草稿」与「已保存」两种来源取并集，并按「凭证归属」过滤。
- **被否**：
  - **按钮只看 `dirty`**（有改动就可点）—— 无法回答「参数够不够」，填了半个 cookie 也算 dirty。
  - **按钮只看 `enabled`**（现状）—— 必须先开开关才能测，而开开关本身又会测一次，形成循环。
- **证据**：现状 5 个控件 5 套禁用条件（`CodingPlanSection.vue:47/116/133/178/205/216`），没有一条与参数完整性相关；唯一的必填校验写在开关路径上（`useQuotaConfigure.ts:237`），测试按钮看不见它。
- **效果**：达成 §2 目标 1。§3.2 失败模式 A 的入口被前置拦掉。

### 6.3 D2：「保存」与「测试」合成一次点击（选定）

- **采用**：区块只保留一个主动作按钮「保存并测试」。点击时先把草稿落盘（`quota.configure`），成功后再 `quota.refresh`。
- **被否**：**双按钮分离**（方案 A）。让用户自己理解先后顺序，且当无改动时「保存」按钮还是灰的，用户会以为坏了。
- **证据**：runtime 的凭证读取完全依赖落盘（`quota-service.ts:576-596` 从 secrets 文件与 auth.json 读），所以「先落盘再查询」**是硬约束而非设计选择**。现状三个保存动作 + 一个测试动作已经把这条隐含约束散落在四处。
- **效果**：达成 §2 目标 2。§3.2 失败模式 F 消除。

### 6.4 D3：凭证来源显式选择 **并持久化**，UI 与 runtime 共同遵守（选定）

- **采用**：
  1. `providers.json` 的 `quota` 增加可选字段 `credentialSource: 'provider' | 'exclusive'`。
  2. 两端用**同一个解析函数**求有效值（构造性一致，杜绝各自推断）：

     ```ts
     // packages/shared/src/quota-types.ts
     export function resolveQuotaCredentialSource(
       quota: { credentialSource?: QuotaCredentialSource; apiKeySet?: boolean } | undefined,
     ): QuotaCredentialSource {
       return quota?.credentialSource ?? (quota?.apiKeySet ? 'exclusive' : 'provider')
     }
     ```

  3. runtime 的 `getCredential('api-key')` **按解析结果分支**：`'provider'` → 跳过专属 Key 文件，走 auth.json → models.json；`'exclusive'` → 只读专属 Key 文件，缺失即返回 null（由 `no-credential` 兜底）。
  4. UI 的分段控件初值 = 同一个函数的返回值。
  5. 保存时**不删除**专属 Key 文件 —— 切换来源只改 `credentialSource` 这一个字段。
- **被否**：
  - **保留「留空 = 继承」的隐式约定**（现状）—— 空输入框无法区分「继承」与「还没填」，齐备性判定无从下手。
  - **只改 UI 不持久化，靠"用户动过分段控件时才清专属 Key"**：这是**事件语义**而非状态语义。用户从未动过控件时（默认 `'provider'`）保存会传 `undefined`，磁盘上的专属 Key 继续被 runtime 优先命中 —— §3.2 失败模式 D 原样保留。
  - **只改 UI 不持久化，改成"保存时无条件清除专属 Key"**：能消除不一致，但把用户的凭证**不可逆地删掉**（切回要重新粘贴），且在「provider 删除后同 id 重建」场景下会删掉用户并未看到的残留文件 —— 用户没有授权这次删除。
- **证据**：`quota-service.ts` `getCredential` 的 api-key 分支固定链（专属 Key 永远优先于 provider 凭据；provider 凭据段已收口到注入的 `credentialResolver`，但收口不改变优先级）是 §3.2 失败模式 D 的机制成因；`ProviderEditBody.vue:222` 传入的 `apiKeySet` 是 `!!provider?.apiKeySet || !!provider?.quota?.apiKeySet` 的合并值，UI 今天连「专属 Key 是否存在」都无法单独得知。四份可点原型中方案 B 的分段控件是唯一表达了这个维度的界面。
- **效果**：达成 §2 目标 4。§3.2 失败模式 D 从机制上消除 —— UI 显示的选择与 runtime 使用的凭证由同一份持久化数据驱动，**无法背离**。

### 6.5 D4：「启用」开关退化为纯配置位（选定）

- **采用**：开关只写 `enabled` 一个字段（其余参数一律传 `undefined` = 不变），**不触发任何网络请求**。它唯一的语义是「要不要在对话框容量浮层里展示该 provider 的额度」。开关即时落盘（拨了就生效），不进入草稿。
- **被否**：**保留「开启即验证」**（现状与原始设计约定，`design.md:339`）。它正是 §3.2 失败模式 A 的直接成因 —— 把「展示意图」和「验证动作」绑在一起，导致用户在没有任何参数时也能触发一次注定失败的查询，并把失败状态持久化。
- **证据**：`useQuotaConfigure.ts:247-253`（开启成功后 `await testQuery()`）；`quota-service.ts:476-480`（凭证缺失时静默返回缓存，于是这次注定失败的查询连原因都不产生）。
- **效果**：达成 §2 目标 3。

**两个必须写清的边界**：

1. **开启之后仍有网络请求，但发生在展示期**。用户在对话页 hover 容量 chip 时，`useQuotaQuery.onHoverEnter` 会发起一次 `quota.fetch`（`useQuotaQuery.ts:101-141`，带 10s throttle）。这是**展示期的按需拉取**，与设置页的配置动作无关。用户已明确认可这一行为。
2. **未齐备时开关仍可拨，会得到一个空/失败的浮层**。用户明确要求「开关不置灰」。所以「选了类型但没填完参数就拨开开关」是允许的 —— 结果是浮层显示「暂无额度数据」，或在 hover 拉取后显示失败文案。这是**可诊断**的（不是静默的），且恢复通道由 D11 提供（浮层失败态补「配置」入口）。

### 6.6 D5：类型选择进入草稿；保存时按「凭证归属」作废旧平台凭证（选定）

- **采用**：
  1. **类型下拉只改草稿**，与凭证、Workspace 一起由「保存并测试」一次性提交。它不再即时落盘。
  2. **凭证归属规则**：一份已保存的凭证只在 `quota.fetcher`（磁盘上记录的类型）**等于**当前草稿类型时才算「已配置」；类型一变，旧凭证立即不计入齐备性。
  3. **保存时若类型发生变化**：cookie 传 `''`（清除）。专属 Key 不需要显式清除 —— 它由 `credentialSource` 决定是否生效（D3），且新类型下齐备性会要求用户重填或切换来源。
- **被否**：
  - **类型即时落盘 + 只加同值守卫**：即使用户没改类型，reka 的 `Select` 在点选当前已选项时也会无条件 emit 同值（`SelectRoot.js:71-77` 用 `useVModel(..., { passive: props.modelValue === void 0 })`，`passive=false` 时 `set()` 恒 emit）—— 用户「什么都没改」却触发一次落盘与凭证清除。加守卫能挡住，但草稿模型从根上消除这类事件语义。
  - **保留旧凭证并标记「来自其他类型」**：标记无法传导到 runtime（凭证按 provider 单份存储，cookie 没有来源选择机制），runtime 仍会把旧 cookie 交给新平台。
- **证据**：凭证按 provider 存储、不含类型（`quota-service.ts:643-650`）；平台间 cookie 的域完全不同（MiMo = `platform.xiaomimimo.com`，opencode = `opencode.ai`）；类型下拉与其余参数在同一张表里，分开落盘会产生两个提交模型。
- **效果**：§3.2 失败模式 C 消除；顺带消除「点一下已选项就丢凭证」这个由事件语义引入的新风险。

**已知代价（量化）**：

- **每次保存类型变更，需要重新粘贴该平台的 Cookie**。**量级**：等于用户主动切换类型的次数（不是误操作次数）—— 配好一个平台后正常使用不会触发；`matchQuotaPreset` 自动匹配正确时用户根本不需要动这个下拉。**恢复路径**：重新从浏览器 DevTools 复制 Cookie 粘贴（同一输入框，通道存在）。前提：用户手上能重新取到 Cookie 原文。**重审触发条件**：若出现用户反馈「换个类型看一眼再换回来，Cookie 就没了」，说明需要在 `quota` 里加 Cookie 归属字段（`cookieFetcher`）；届时按那时的证据重新评估。**判定**：可接受。（Workspace 不在此列 —— 类型切换不清它的草稿，见 §7.2 细节 2。）
- **provider 删除后残留的 secrets 文件**：不属于本决策，由 D12 处理。

### 6.7 D6：新增 `no-credential` 失败原因（选定）

- **采用**：`QuotaFetchFailureReason` 增加 `'no-credential'`；runtime 在凭证链解析不到任何凭证时返回它，而不是静默返回缓存。
- **被否**：**沿用通用文案「查询失败，请检查凭证」**。这句话在四种完全不同的故障下都会出现，用户无法据此行动。
- **证据**：`quota-service.ts:476-480` 的静默返回；与 opencode 缺 workspace 时的显式 `not_configured`（`opencode.ts:63-67`）形成鲜明对比 —— 同样是「参数没填齐」，一个告诉你缺什么，一个什么都不说。
- **效果**：达成 §2 目标 5。这是 D1 的必要补充 —— 齐备性是**前端近似判定**（`ProviderInfo.apiKeySet` 是 auth.json 凭证 id 集合与 models.json override 的聚合，见 `provider-config-helper.ts:335`，无法区分 api_key 与 oauth），runtime 才是权威。前端判不出来时，由这条 reason 兜底并说清。

### 6.8 D7：cookie 输入框不再回显掩码（选定）

- **采用**：cookie 输入框永远只放用户真实输入的值（保存成功后清空）；「已配置」改为字段标题旁的独立标记。
- **被否**：**保留 `'••••••••'` 回显**（现状）。它是一个**可作为值提交的掩码**，既是 §3.2 失败模式 B 的成因，也让用户无法区分「这里显示的是我填的内容」还是「这里是占位」。
- **证据**：`useQuotaConfigure.ts:148` 赋值掩码；`CodingPlanSection.vue:152-158` 把它作为 `model-value` 渲染进 `Textarea`；`:205` 的禁用条件 `!cookieInput.trim()` 对掩码求值为真。
- **效果**：达成 §2 目标 5。消除 §3.2 失败模式 B（数据损坏）。

### 6.9 D8：类型未选时不渲染参数与开关（选定）

- **采用**：`fetcher` 为空时，区块只渲染类型下拉 + 一句说明（「先选一个查询类型，下面的参数会按类型自动变化」）。开关、凭证区、按钮全部不渲染。
- **被否**：**始终渲染全部控件**（现状，`ProviderEditBody.vue:205` 无 v-if）。
- **证据**：`ProviderEditBody.vue:205-238` 的 `CodingPlanSection` 没有 `v-if`；原始设计文档 `design.md:322` 写的是「仅在 provider 命中 QUOTA_PRESETS 时显示」—— 实现与该约定早已脱节，后来演化为「始终显示以支持手动指定类型」（`CodingPlanSection.vue:15` 注释）。
- **效果**：达成 §2 目标 1。同时天然堵掉「没选类型就开开关」这条路径 —— 该状态下开关根本不存在。区块仍然对所有 provider 显示（用户决策），只是内部按 `fetcher` 是否已选分层渲染。

### 6.10 D9：错误文案统一走 i18n（选定）

- **采用**：清掉 `useQuotaConfigure.ts` 里 10 处硬编码中文（`:213/218/238/260/265/278/292/295/333/336`），全部改为 i18n key。
- **被否**：**保持现状**。该文件头部注释已经声称「失败文案走 i18n（en-US locale 不再透出硬编码中文）」（`:18-20`），实际只有 workspace 那两处是真走 i18n。en-US 用户会看到中文报错。
- **证据**：上述行号；对照 `:359/370/373` 的正确写法。
- **效果**：达成 §2 目标 4 的前置（说得清的前提是说得对）。现有测试只断言了 `testError` 的 i18n 路径，没覆盖 `configureError`。

### 6.11 D10：区块保持独立提交，不并入 provider 保存条（选定）

- **采用**：额度配置继续即时提交（走 `quota.configure`），不纳入 `ProviderEditBody` 的 `isDirty` / 底部保存条。区块内的即时动作收敛为两个：**开关**（单字段、语义唯一、即时生效）与**保存并测试**（其余全部参数，一次提交）。
- **被否**：**并入 provider 的草稿模型**。看起来更一致，但需要把 `quota.configure` 的 6 个参数并入 `setProvider` 的保存 payload，而 runtime 侧已经明确禁止经 `setProvider` 写 quota：

  > `provider-config-helper.ts:991-992`：「quota 写入分支已删除（历史死分支：无前端调用方传 quota；quota 配置唯一写路径是 QuotaService.configure → config/providers.json）。**禁止恢复经 setProvider 写 models.json quota。**」

  并入等于推翻这条架构约束。
- **证据**：上述注释；`use-provider-edit.ts` 全文无任何 quota 引用（grep 零命中）。
- **效果**：避免 scope 越界到 provider 表单的提交模型。

**已知代价（量化）**：

- **「保存并测试」这个动作不可回滚**。点下去就落盘，且其中包含两类销毁性操作：类型变更时清除 Cookie、`credentialSource` 切换。**量级**：等于用户点击该按钮的次数；正常配置流程里点击通常 ≤ 3 次（首次配置 1 次 + 调整重试 1-2 次）。**恢复路径**：① Cookie 被清 → 重新粘贴（从浏览器 DevTools 重取）；② `credentialSource` 改变 → 切回分段控件的另一侧即可，**前提是类型没变**（专属 Key 文件未删，无需重贴）；若同一次保存里类型也变了，专属 Key 同样因归属失效而不计入齐备性，需重填 —— 那部分代价已计入 §6.6。**重审触发条件**：若出现「点错按钮导致需要重贴凭证」的反馈超过偶发，评估给按钮加二次确认或把类型/来源选择改为即时提交。**判定**：可接受（销毁范围被 D3 收窄到只剩 Cookie 一项，且它有明确的重新获取通道）。
- **点「取消」放弃 provider 编辑时，额度配置的改动不会回滚**（§3.2 失败模式 E 保留）。**量级**：每次「改了额度配置又取消编辑」触发一次。**恢复路径**：重新进入编辑体改回。**重审触发条件**：若出现用户投诉「取消没生效」，届时评估是否把 quota 并入保存条。**判定**：可接受 —— 缓解手段是区块内不再有孤立的「保存」字样（只有「保存并测试」），降低误判「它受底部保存条管辖」的概率。

### 6.12 D11：浮层失败态补「配置」恢复入口（选定）

- **采用**：`ContextCapacityPopover` 的 coding-plan 区在**失败态**下，footer 同时渲染「刷新」与「配置」两个按钮（「配置」复用已有的 `openSettings` 注入，`:189`）。
- **被否**：**保持现状**。今天 footer 的按钮是二选一的（`:136-154`）：有 `matchedProviderId` 时只给「刷新」，否则才给「配置」。于是「已启用但凭证缺失」这个状态在对话页是**死路** —— 刷新只会再失败一次，没有任何入口能跳到设置页。
- **证据**：`:136-154` 的 `v-if="matchedProviderId"` / `v-else` 分支；`useQuotaDisplay.ts:71-80` 的 `matchedProviderId` 只判 `quota.enabled`，所以「启用了但坏掉」的 provider 一定有 `matchedProviderId`，必然走「只给刷新」的那一支。D4 明确保留了「未齐备时开关可拨」，因此这个状态**必然可达**。
- **效果**：达成 §2 目标 5（不制造坏状态 —— 至少要给出路）。D4 边界 2 的「可诊断」由此补全为「可诊断且可恢复」。

### 6.13 D12：补齐 quota 的清理通道（选定）

- **采用**：本次一并实现三处清理，全部对齐已有的 M5-05「同 id 重建不静默继承旧配置」不变式（`provider-config-helper.ts:1256`）：
  1. **provider 删除链清理 quota secrets**（两个文件）。需要一个注入回调（删除链当前不持有 `QuotaService`），或从 `getDataDir()` 推导 `secrets/` 路径 —— 倾斜前者，避免删除链知道 quota 的存储布局。
  2. **`configure` 成功后清 `lastFailure`**（配置变了，上一次的失败原因不再适用）。
  3. **provider 删除时清 `lastFailure` / `lastFetchTime`**（与 1 同一个钩子）。
- **被否**：
  - **只登记为已知缺口、本次不实现**。§3.2 失败模式 D 的修复（D3）把「专属 Key 残留」从一句隐式约定的副作用升级成了「UI 明确承诺却无法兑现的声明」：残留文件在 `credentialSource` 未持久化时（如删除后同 id 重建、extras 被清空）会被解析为 `'exclusive'` —— 而 UI 会显示「用 Provider 凭据」。**D3 让这个缺口的后果变严重了**，因此不能再只登记。
  - **组装 `ProviderInfo` 时按文件存在性校正标记（读时自愈）**：能给「幽灵标记」类不一致一个统一的读侧矫正，但代价是常驻读侧机制（每次组装 quota 信息两次 `existsSync`）+「存储标记 ≠ 有效标记」的双真相语义。它要救的三条路径各有更便宜的处置：configure 的 IO 窗口已登记且有恢复通道（§7.3 改动 2）、存量不一致走 §11 检查点 5 的差集探针、删除链部分失败由排序约束从源头堵住（§7.3 改动 5）。
- **证据**：`cleanProviderExtras`（`:1265-1278`）只删 extras 条目；`cleanAuthCredential`（`:1239-1263`）只清 auth.json；两条删除链的清理调用（custom `:1395`；catalog `:1383`/`:1386`）均无 secrets 清理 —— 全仓 grep `cookie.txt` / `apikey.txt` 只命中 `quota-service.ts` 自身。
- **效果**：达成 §2 目标 5。表 A 中 #4/#5/#10 三项新增写入获得清理通道。

**已知代价（量化）**：

- **删除 / 移除一个配过额度的 provider，会一并删掉它的 Cookie 与专属 Key，重新导入不恢复**。catalog provider 的「移除」按定义是可恢复的（定义在 pi 二进制内，重导入即回来），但 `secrets/<pid>-*.txt` 是用户自己粘贴的凭据 —— **重导入后必须重新粘贴**。**量级**：每次删除或移除一次（catalog 的移除/重导入循环同样计入）。**恢复路径**：重新从浏览器 DevTools 取 Cookie 粘贴（同一输入框，通道存在）；专属 Key 需回到对应平台控制台重取。**重审触发条件**：若出现「只是移除再导入，Cookie 就没了」的反馈，评估是否把 secrets 保留一段时间（但这会重新打开「同 id 重建继承旧凭证」的缺口，需一并权衡）。**判定**：可接受 —— 备注：D12 之前这些文件**永远不会被删**，本条代价是从「永久残留」换成「随删除清理」的必然结果，且删除是用户的显式动作。
- **删除链部分失败的两个方向**（「清理失败只 warn 不阻断」的既有语义之下）：① `cleanProviderExtras` 失败 → 按改动 5 的排序，secrets 删除被跳过 → 留下「标记与文件一致」的残留，同 id 重建正常继承旧 Cookie —— 即 D12 之前的既有行为在 IO 失败时的退化形态（warn 已提示，重试删除即清）；② extras 删成功 + secrets 删失败 → 惰性孤儿文件（永不被读取，惰性分析见 §7.3 改动 5）。**量级**：仅本地 IO 异常。**恢复路径**：①重试删除；②手工删或下次同 id 删除。**重审触发条件**：日志出现该路径 warn 且伴随用户反馈。**判定**：可接受 —— 两个方向都不产生「读得到假状态」的幽灵标记。

### 6.14 D13：Workspace 判定只看草稿，不再依赖「空串 = 清除」（选定）

- **采用**：Workspace 的齐备性判定**只看草稿**（`draft.workspace 非空`），保存时传草稿的归一化值。UI **不再产生空串**，即不依赖「空串 = 清除」这条信号。runtime 的 RPC 契约不变（`configure` 收到空串仍解释为清除，保留给直接调用者），但 UI 不会再走到那条分支。类型切换也**不清** Workspace 草稿（明文回显字段非凭证，凭证清空的理由对它不成立 —— §7.2 细节 2）。
- **被否**：
  - **判定取并集 + 保存传空串清除**（文档 v1 的写法）：会产生「同一屏幕状态对应两种保存结果」的特例 —— 输入框空既可能表示「保留既存」也可能表示「清除」，取决于用户动没动过。且 v1 里这条规则同时**不可达**（空即不 ready → 按钮灰 → 永远传不出空串），使 §7.2 与 §8 自相矛盾。
  - **判定取并集 + 保存只在非空时传**（v1 修订中一度采用）：用户清空输入框后按钮**仍然是亮的**（已保存值仍有效），点保存后又因为 `syncFromProvider` 回填而**把值还原回屏幕**（`useQuotaConfigure.ts:153`）—— 用户看到自己刚清空的内容又回来了，判断不了这个动作到底有没有生效。
- **证据**：Workspace 是**明文且始终回显**的（`useQuotaConfigure.ts:153` `workspaceInput.value = p.quota.workspace ?? ''`），所以「屏幕上显示什么，就保存什么」这个模型对它天然成立；cookie / 专属 Key 不回显，才必须走「草稿 ∨ 已保存」的并集。
- **效果**：达成 §2 目标 1（规则无特例），且消除 v1 的内部矛盾与「清空被还原」的视觉矛盾。

**已知代价（量化）**：

- **移除了「清空 Workspace 地址」的能力**（输入框清空后按钮置灰，保存不出去）。**量级**：该能力在额度查询场景无用 —— Workspace 是 opencode 查询的**必填项**，清空它等于把配置变成不可用状态（查询会返回 `not_configured`）；想换地址直接覆盖即可，想停用整个能力是关开关。**恢复路径**：直接填入新地址覆盖；停用则关开关。**重审触发条件**：若出现「想移除 Workspace 但做不到」的反馈，届时加一个显式的清除按钮（而不是复用「空串」这个有歧义的信号）。**判定**：可接受。

---

## 7. 实现机制

**本章结论：5 层改动。shared 加枚举值 + 字段 + 解析函数，runtime 修五处，core 换契约，renderer 重写 composable，ui 重写区块并补浮层入口。**

### 7.1 接口先行：契约变更

**新增 shared 类型与函数**（`packages/shared/src/quota-types.ts`）

```ts
/** 额度查询的凭证来源（D3）。provider = 复用 provider 自己的凭据；exclusive = 只用额度专属 Key。 */
export type QuotaCredentialSource = 'provider' | 'exclusive'

/**
 * 解析有效凭证来源 —— UI 与 runtime 必须调用同一个函数，否则两端推断可以背离（D3）。
 * 未显式设置时按既存标记推断：有专属 Key 视为 exclusive（兼容历史数据），否则 provider。
 */
export function resolveQuotaCredentialSource(
  quota: { credentialSource?: QuotaCredentialSource; apiKeySet?: boolean } | undefined,
): QuotaCredentialSource
```

`QuotaFetchFailureReason` 增加 `'no-credential'`（`:44`）。

**`ProviderInfo.quota` 增加字段**（`packages/shared/src/provider.ts:189-212`）

```ts
quota?: {
  fetcher?: string
  enabled: boolean
  cookieSet?: boolean
  apiKeySet?: boolean
  /** 凭证来源（D3）。未设置 = 按 resolveQuotaCredentialSource 推断（兼容历史数据）。 */
  credentialSource?: QuotaCredentialSource
  workspace?: string
}
```

**`quota.configure` 契约收敛为单一 payload 对象**（`packages/shared/src/quota-types.ts`）

```ts
/** quota.configure 的完整 payload —— protocol、core domain、mock、QuotaService 四处共用同一类型。 */
export interface QuotaConfigurePayload {
  providerId: string
  enabled: boolean
  fetcher?: string
  credentialSource?: QuotaCredentialSource
  cookie?: string
  apiKey?: string
  workspace?: string
}
```

现状 `configure` 是 6 个位置参数（`core/src/transport/api/domains/quota.ts:66-76`），本设计再加 `credentialSource` 会到 7 个，其中 4 个是同构的 `string | undefined`（`cookie` / `fetcher` / `apiKey` / `workspace`）——互相错位编译器不报错（`configure(pid, true, cookie, undefined, ws)` 把 workspace 塞进 apiKey 位是合法调用），v3 端到端链第 4 段的「静默丢字段」正属这一族。收敛后：handler 对 wire 消息**整对象透传**（`quota.configure(data)`，无逐参解构，后续加字段零改动）；实施者即使完全忘改 handler，旧 6 参调用对新 1 参签名也是**参数数编译错**，不可能静默丢失。

**分期兼容**（各阶段独立可编译）：M0 只落类型（旧调用缺 `credentialSource` 键仍合法，零行为变更）；M1 切 `QuotaService.configure` + handler（旧 renderer 发的 6 字段对象本就是合法 payload，wire 兼容）；M2 与 core `domains/quota.ts`、mock、renderer 调用点同批原子切换（先切调用方会编译错，恰好强制原子）。

**`QuotaConfigureState` 变更**（`packages/core/src/domain/settings/quota-configure-state.ts`）

移除：

| 成员 | 原因 |
|---|---|
| `cookieInput` 的掩码语义 | D7（字段仍在，语义改为「永远是用户真实输入」） |
| `selectFetcher(id)` | 现状是**异步持久化**（`useQuotaConfigure.ts:199-222` 走 `quota.configure`）。D5 后类型只写草稿 → 替换为同步的草稿写入（契约上表现为 `fetcherId` 的 setter，不单列异步方法） |
| `toggleEnabled()` | 拆为 `setEnabled(v)`（只写配置，不查询） |
| `saveCookie()` / `saveApiKey()` / `saveWorkspace()` / `testQuery()` | 合并为 `saveAndTest()`（D2） |
| `apiKeyConfigured` | 拆为 `providerCredentialAvailable` + `quotaApiKeyConfigured`（D3） |

新增：

| 成员 | 类型 | 语义 |
|---|---|---|
| `readiness` | `Ref<{ ready: boolean; missing: ReadinessMissing[] }>` | D1 的齐备性派生量 |
| `credentialSource` | `Ref<QuotaCredentialSource>` | D3 的来源选择（cookie 类不适用） |
| `providerCredentialAvailable` | `Ref<boolean>` | Provider 侧是否有可用凭据（决定「用 Provider 凭据」是否可点） |
| `quotaApiKeyConfigured` | `Ref<boolean>` | 专属 Key 是否已保存（**单独**表达，不再与 provider 侧合并） |
| `providerCredentialPendingSave` | `Ref<boolean>` | Provider 侧凭据「已填但未保存」（用于文案区分，见 §7.4） |
| `setEnabled` | `(v: boolean) => Promise<void>` | 只写 `enabled`，无网络副作用（D4） |
| `saveAndTest` | `() => Promise<void>` | 落盘 + 查询（D2） |

```ts
/**
 * 齐备性缺口项（UI 据此渲染字段级提示）。四态显式命名：
 * - 'type'      : 尚未选择查询类型 —— UI 走 D8 的「只渲染下拉 + 一句说明」，不渲染按钮，
 *                 故该值**不配 i18n 文案**，只用于让契约自解释（避免消费方把它误读为
 *                 「齐备但不可点」或渲染出「参数齐全后可点」这类空提示）。
 * - 'cookie' / 'apiKey' / 'workspace' : 已选类型下的具体缺口，各配一条 i18n 提示。
 */
export type ReadinessMissing = 'type' | 'cookie' | 'apiKey' | 'workspace'
```

**缓存失效的副作用声明**（补齐既有行为，不得静默丢失，也不得留下陈旧数据）：

| 触发 | 谁失效 | 依据 |
|---|---|---|
| `setEnabled(false)` | renderer quotaStore | 保留现状（`useQuotaConfigure.ts:253-255` 的 `clearCache`；语义见 `stores/quota.ts:96-98`）。同时清 runtime 侧 `lastFailure`（改动 4） |
| `saveAndTest` 中**类型发生变更**（参数表规定 `cookie: ''` 仅在 typeChanged 时出现，故「清空 Cookie 触发失效」的全部情形都被本行覆盖，不单列） | **runtime `QuotaCache` 该 provider 条目** + renderer quotaStore | 见下 |

**为什么类型变更的失效点必须在 runtime**：额度缓存按 provider 存储、不含类型（`quota-cache.json`）。只在 renderer 侧 `clearCache` **不解决问题** —— 紧随其后的 `syncFromProvider → loadCached`（`useQuotaConfigure.ts:156-158`）会走 `quota.getCached` 从 **runtime `QuotaCache` 把旧类型的行原样取回**（表 A #8：该缓存无删除通道）。更糟的是 `broadcastProviderList` 触发的 `syncFromProvider` 与紧随的 `quota.refresh` 是并发的，refresh 失败时旧行会经「查看上次成功数据」以**新类型标签**展示（`CodingPlanSection.vue:264-269`）。

所以：**runtime 在 `configure` 检测到 `fetcher` 变更时清该 provider 的 `QuotaCache` 条目**（列入改动 4，并配**在途写回守卫** —— 在途旧类型 fetch 落地时不回写，同见改动 4）。renderer 侧的 `clearCache` 保留（同一时刻镜像也该失效），但它是补充而非充分条件。

**两个时序约定（实施时必须遵守，否则会丢用户输入）**：

1. **`saveAndTest` 必须在发起 RPC 前捕获 payload 快照。** `quota.configure` 成功后会 `broadcastProviderList` → `props.provider` 更新 → `watch(providerRef, syncFromProvider)` 重跑 → 草稿被重置为磁盘状态（`useQuotaConfigure.ts:126-159`）。若在 await 之后才读草稿，读到的是已被重置的值。
2. **草稿会在 provider 广播时被重置为磁盘状态**，这是既有行为（`syncFromProvider` 的语义），本次不改变。**已知代价**：若用户在输入 Cookie / Workspace 的过程中，另一个 panel 或后台流程改动了同一 provider 并触发广播，未提交的输入会丢失。**量级**：需要「同一 provider 在两个 panel 同时被操作」或后台配置变更；正常单人操作单 provider 时为 0。**恢复路径**：重新输入。**重审触发条件**：若出现该反馈，改为「仅在 provider id 变化时重置草稿」。**判定**：可接受（既有行为，本次未加剧）。

### 7.2 齐备性判定规则（D1 + D5 的落地）

```
readiness(provider, draft) → { ready, missing[] }

savedFetcher = provider.quota?.fetcher
// 凭证归属的锚点（D5）。注意 `savedFetcher === undefined`（从未按某个类型保存过）**不算**
// 类型已变 —— 无既存归属可比。若把 undefined 也判为 changed，会给这类 provider 制造一次
// 用户从未请求的 `cookie: ''` 删除（api-key 类走该分支时 readiness 不检查 cookie，会被放行）。
typeChanged  = savedFetcher !== undefined && draft.fetcher !== savedFetcher

若 draft.fetcher 为空 → { ready: false, missing: ['type'] }
                       （UI 走 D8：只渲染类型下拉 + 说明，不渲染按钮，不消费该缺口项）

preset = QUOTA_PRESETS.find(p => p.fetcher === draft.fetcher)

若 preset.auth 含 'cookie'：
    cookie 有值 ⟺ draft.cookie 非空
                  ∨ (¬typeChanged ∧ provider.quota.cookieSet)
    否则 missing.push('cookie')

否则（api-key 类）：
    若 draft.credentialSource === 'provider'：
        可用 ⟺ providerCredentialAvailable
        否则 missing.push('apiKey')
    若 draft.credentialSource === 'exclusive'：
        可用 ⟺ draft.apiKey 非空
              ∨ (¬typeChanged ∧ provider.quota.apiKeySet)
        否则 missing.push('apiKey')

若 preset.requiresWorkspace：
    workspace 有值 ⟺ draft.workspace 非空       ← 只看草稿（D13：明文回显，屏幕即真相）
    否则 missing.push('workspace')
```

**四处必须写清、否则会被实施成 bug 的细节：**

1. **`typeChanged` 是「凭证归属」的唯一判据，且只在有既存归属时成立。** 判据是 `savedFetcher !== undefined && draft.fetcher !== savedFetcher` —— 「从未保存过某个类型」不等于「归属失效」。这条规则同时解决三件事：切换类型后按钮立刻置灰（用户必须重填）、「打开编辑体时旧类型凭证被误认为对新类型有效」、以及「无历史归属的 provider 被误判为类型已变而触发一次多余删除」。

2. **类型真正发生变化时才清空凭证草稿；已保存状态不动。**
   - **守卫必须落在值上，不能落在事件上**：`if (newId === fetcherId.value) return`。理由：`CodingPlanSection.vue:21-24` 用的是 `:model-value` + `@update:model-value`，而 reka 的 `SelectItem.handleSelect` 无条件调用 `onValueChange`，`SelectRoot` 走 `useVModel(..., { passive: props.modelValue === void 0 })`（`SelectRoot.js:71-77`）—— 传入 `:model-value` 时 `set()` **恒 emit、无同值判断**。若把「清空草稿」挂在事件上，用户「点一下当前已选的类型」就会丢掉尚未提交的输入（丢的是正在输入的内容，不是磁盘数据）。
   - **清空的是凭证草稿（Cookie / 专属 Key 的输入框内容），Workspace 草稿不清**。凭证必须清的理由：`draft.cookie 非空` 会让新类型被误判为齐备 —— 用户给 MiMo 敲了一半 Cookie、改选 opencode.go，按钮却是亮的，点下去就把 MiMo 的 Cookie 存成了 opencode 的，正是 D5 要消除的失败模式 C。这条理由对 Workspace **不成立**：它是明文回显字段（细节 3），不是凭证，没有「跨平台归属」问题 —— 残留值在新类型下要么不被消费（新类型不需要 workspace），要么就是用户屏幕上正看到的值。清它的唯一效果是负面的：磁盘上有、屏幕上看不到，而 D13 的判定只看草稿，不会替用户把它找回来 —— opencode 用户「切走再切回」后按钮会因缺 workspace 置灰，被迫重贴一个其实还在的 wrk_ 地址。
   - **已保存状态不清**：它的作废由第 1 条的归属规则表达，物理数据保留（D3 的可逆性由此成立）。所以「改类型 → 改回原类型」之后旧凭证仍然有效、按钮重新变亮，只是期间输入的**凭证**内容需要重新输入（Workspace 草稿未清，无需重填）。

3. **敏感字段与明文字段的判定来源不同（这条差异是全局的，不只影响 Workspace）。**
   - `cookie` / 专属 `apiKey` 是**密文、不回显**：判定取「草稿 ∨ 已保存」的并集，**保存时只在草稿非空才传**（`undefined` = 保留既存）。回退到已保存值是必要的 —— 否则用户每次打开编辑体都会看到按钮是灰的（明明已经配好了）。
   - `workspace` 是**明文、始终回显**：判定**只看草稿**，保存时传草稿值。「屏幕上显示什么就保存什么」对它天然成立，无需从已保存值借力。
   - 这条差异的后果：Workspace 失去「清空」通道（见 D13）；也正因此，类型切换**不清** Workspace 草稿（见细节 2）——对一个「屏幕即真相」的字段做本地清空，等于亲手制造屏幕与磁盘的背离。

4. **保存时的参数构造表**（构造 §7.1 的 `QuotaConfigurePayload` 单一对象，**仅适用于 `saveAndTest`**）：

   > **`setEnabled` 不走这张表**：它只构造 `{ providerId, enabled }`，`fetcher` / `credentialSource` / 凭证各键全部缺省（= 不变）。否则草稿里的类型或来源选择会经由一次拨开关被**偷偷落盘** —— 用户没点保存却改了配置。这一点与 D4「开关是纯配置位、语义唯一」是同一个约束的两面。

   | 参数 | 取值规则 |
   |---|---|
   | `enabled` | 恒传当前值（不变） |
   | `fetcher` | 草稿类型 |
   | `cookie` | 草稿非空 → 传草稿（trim）；草稿空 → `typeChanged ? '' : undefined`（类型一变，旧 Cookie 的归属就不成立了，**无条件清除**；类型没变则保留既存） |
   | `apiKey` | 仅当 `credentialSource === 'exclusive'` 且草稿非空 → 传草稿；其余情况传 `undefined`（**永不传 `''`**） |
   | `workspace` | `preset.requiresWorkspace` 时传归一化后的草稿值（非空 —— 空时按钮不可点）；否则 `undefined`。**永不传 `''`**（D13） |
   | `credentialSource` | **恒传当前选择**（幂等）。显式化磁盘字段，同时消除「未设置」这一中间态。落盘走 `inheritQuotaField` 继承链（键缺省 = 继承既存，见改动 6）；**禁止**用 `resolveQuotaCredentialSource` 在写侧补默认值（它是读侧推断，见改动 6 的反例） |

   **`apiKey` 永不传 `''` 的理由**（D3）：专属 Key 的「失效」由 `credentialSource` 表达，不靠删文件。删除是不可逆的，而来源切换是可逆的 —— 这正是 D3 相对「无条件清除」方案的核心优势。

### 7.3 runtime 改动

**改动 1 · 凭证缺失返回 `no-credential`**（`quota-service.ts:476-480`）

```ts
// 现状
const resolved = await this.resolveCredential(providerId, fetcher.auth)
if (!resolved) return this.getCached(providerId)
```
```ts
// 改为
const resolved = await this.resolveCredential(providerId, fetcher.auth)
if (!resolved) return this.fetchFailed(providerId, 'no-credential')
```

`fetchFailed`（`:511-515`）会写 `lastFailure` 并返回 `{ data: null, lastFetchAt: <上次成功时间>, reason }`。**行为变更点**：凭证缺失从「静默返回缓存」变为「显式失败」。

**影响面（必须完整声明）**：

| 消费方 | 变化 |
|---|---|
| `getCached`（`:214-221`） | 后续返回会带 `reason` → 前端重开编辑体会呈现失败态而不是 `idle` |
| 对话页浮层（`useQuotaQuery.ts:114-120` / `:126-128`） | 该 provider 从「暂无额度数据」变为「查询失败 + 未找到可用凭证」，并（经 D11）附带「配置」入口 |
| 设置页 `loadCached`（`useQuotaConfigure.ts:167`） | **当前有缺陷**：`if (result.data)` 在 `data=null` 时丢弃 reason，导致重开编辑体仍是 `idle` 态。本次一并修正为 `if (result.data || result.reason)` |
| `<dataDir>/logs/` | 凭证缺失从零日志变为每次一条 `logger.warn`（表 A #13） |
| runtime `lastFailure` Map | 新增一个写入源（表 A #10），清理通道见改动 4 |
| **「幽灵标记」态**（`quota.apiKeySet=true` 但 `secrets/<pid>-apikey.txt` 不存在） | 新分支在 `source === 'exclusive'` 时**只读该文件**，缺失即返回 null → `no-credential` 失败；而旧链会继续回退 auth.json → models.json，**可能成功**。即本改动对这个状态引入一次「从能查到查不到」的行为回退。**判定**：**有意为之** —— 配置声明了「用专属 Key」而 Key 不在，就应该报出来，而不是偷偷换成另一份凭证（后者正是 §3.2 失败模式 D 的成因）。且失败可诊断、可恢复（文案指向「填专属 Key 或改用 Provider 凭据」，且 UI 的齐备性会因 `apiKeySet=true` 判 ready，用户点一下就能看到明确原因）。**量级**：仅改动 2 登记的 persist→文件写入窗口，或用户手工删文件；D12 删除链的排序约束保证其部分失败**不产生**该状态（extras 删失败时 secrets 保留，见改动 5）。**重审触发条件**：若真实数据里该状态占比非 0 且用户因此受困，改为「`exclusive` 分支也在文件缺失时回退并 warn」 |

**改动 2 · cookie 的「空串 = 清除」**（`quota-service.ts:309-318`）

现状 `writeCookieSecret(pid, '')` 会写一个空文件并让调用方置 `cookieSet = true`；而读取端 `readSecret`（`:611-622`）把空内容当 `null`。结果是「标记说已配置，实际没有」。

**cookie 的失败语义在此写死（不引用其它待改代码）**：空串 → 目标文件存在则删除，**删除失败返回 `{ error }` 使 `configure` 整体失败**；文件不存在视为成功（幂等，不先 `existsSync` 预检 —— 预检本身是 TOCTOU）；成功后返回 `cookieSet = false`。

**`writeApiKeySecret` 的既有清除分支同样按上句修正**（它当前的 `unlinkSync` 失败被 catch 后只 `logger.debug`，仍返回 `apiKeySet: false`，persist 照写 `false` —— **标记说已清除、文件仍在**，而 runtime 在 `credentialSource='exclusive'` 下仍会读到它）。两处必须一致，否则 D5 的作废效果会绑在一个不实的标记上。

**删除与写入的顺序重排**：现状顺序是「写/删 secrets（`:250-262`）→ 归一化 workspace（`:266-271`，可 return error）→ persist（`:274-284`，可 return false）」。后两步任一失败，凭证已被物理删除而 providers.json 未更新，且 renderer 只回滚本地 `fetcherId`（`useQuotaConfigure.ts:210-221`），文件不可回滚。改为分两段：**先做全部校验与计算 → persist → 成功后执行 secrets 物理写入/删除**。

**provider 存在性检查移进 `extrasStore.modify` 回调内**（不是提前到 `configure` 开头）：

现状 `persistQuotaConfig` 在 `modify` **之前**检查 `providerExists`（`:390-397`）。把它上移到 `configure` 开头看似更早失败，实则**把 TOCTOU 窗口拉大了** —— `XyzProviderStore.modify` 的锁只锁文件（`provider-extras-store.ts:203-215`），不锁 provider 存在性，而删除链的 `cleanProviderExtras` 用同一把锁：谁后拿锁谁生效。

**失败序列**（并发删除 + 保存额度配置）：T2(configure) 开头检查通过 → T1(删除) 完整跑完（models.json / auth.json / extras / secrets 全清）→ T2 的 persist 后落盘 → providers.json **复活一条僵尸 quota 条目** → T2 的 secrets 写入重建刚被删的凭据文件 → 同 id 重建时 `readiness` 因「`¬typeChanged` ∧ `cookieSet`」判为齐备 → **复用被删 provider 的旧 Cookie**，正是 D12 声称关闭的 M5-05 缺口。

正确做法：把存在性检查放进 `extrasStore.modify(providerId, current => { ... })` 的回调内 —— 它与删除链的 `delete` 争同一把文件锁，读-判-写在同一临界区（`modify` 只在回调正常返回后才写盘，回调抛错则整个写入被跳过）：

```ts
await this.extrasStore.modify(providerId, current => {
  if (!this.providerExists(providerId)) throw new ProviderGoneError(providerId)
  return { ...current, quota: { ... } }
})
```

**残余窗口（显式登记，不可完全消除）**：persist（锁内）与紧随的 secrets 写入之间仍有间隙，删除链若在这个间隙里跑完，会留下「孤立 secrets 文件 + 无 extras 条目」。**量级**：需要用户在同一 provider 上并发执行「删除」与「保存额度配置」（两个 panel，或一个 panel + 脚本），属罕见组合；单人在一个编辑体里操作时为 0。**恢复路径**：下一次对该 provider 的删除会清掉孤立文件（D12 的清理是幂等的）；`readiness` 也不会把它算作齐备（无 extras 条目 → `savedFetcher === undefined` → 无既存归属）。**重审触发条件**：若日志中出现该序列。**判定**：可接受 —— 作为对照，「先写文件后 persist」的失败方向（幽灵文件 + 标记为 false）是**静默**的，更难发现；本方向只留下一个用户无感知但也不生效的孤立文件。
- **另一处不可完全消除的窗口**：persist 成功但文件写入失败时，providers.json 说 `cookieSet: true` 而文件不存在。**量级**：仅本地 IO 异常（磁盘满/权限），概率极低。**恢复路径**：用户重新点一次「保存并测试」即自愈（会重写文件）。**重审触发条件**：若日志中出现该路径的 warn。**判定**：可接受（同上，失败的可见方向更好）。
- **反向残余（删除失败留下孤儿文件）的惰性**：物理删除失败时 fail-fast 已让 `configure` 整体报错（用户知情），但 persist 已提交「已清除」—— 留下的孤儿文件消费面为空或可诊断：专属 Key 文件在「标记 false / 无条目」下**永不被读取**（`resolveQuotaCredentialSource` 兜底 `'provider'` ⇒ 改动 3 跳过该文件，readiness 也不计它齐备）；cookie 文件仅在 provider 仍启用且用户不再保存时被 fetch 读到旧平台值 → 平台不认 → 可诊断失败（`unauthorized` 的 cookie 变体文案，见 §5.2 路径 3），恢复 = 重贴（readiness 本就强制重贴才能再次保存，重贴即重写文件）。因此**不单列**「重物化/清理」通道 —— 孤儿是惰性残留，下一次 D12 删除尝试顺带清理。
- **删除与在途 fetch 并发时的缓存回写（一致性审查新登记）**：在途写回守卫比对的是 **fetcher id**，而后备解析含「按 providerId 直查 `QUOTA_FETCHERS`」这一级 —— 当 provider id 与 fetcher id **同名**（写侧不禁止，如 `kimi-coding`）且该 provider 在 fetch 在途时被删除，落地时 `getProviderInfo` 已返回 undefined 但同名 fetcher 命中，守卫通过 → `cache.update` 把已删 provider 的缓存行写回。**终态**：provider 已删、`quota-cache.json` 仍有其条目（同 id 重建后「查看上次成功数据」会看到上一实例的数据）。**量级**：需 provider id 与 fetcher id 同名 + 删除与查询并发，罕见。**恢复路径**：下一次对同 id 的删除或 fetcher 变更会经 `removeEntry` 顺带清理（幂等）。**重审触发条件**：若同 id 重建后出现「上次成功数据」串台反馈。**判定**：可接受 —— 存储残留但无消费方（provider 条目已不存在）；加 per-provider 代次/已删标记的代价面大于收益（与改动 4 被否方案同理）。
- **同窗口的半提交连带**：unlink 失败时 `configure` 返回 `{ok:false}`、handler 不广播，但 persist 已提交新状态（新 fetcher + `cookieSet:false`）—— renderer 快照停在旧值（旧 fetcher、`cookieSet=true`），重试期内 `readiness` / `typeChanged` 基于过期快照判定。**主路径方向安全**（用户保持新类型或重贴）：过期快照的 `savedFetcher` 是旧类型 → `typeChanged` 判真 → 旧 Cookie 不计齐备 → 按钮置灰强制重贴，判定偏保守、不会放行错误保存。**三级滞后的变体（点名登记）**：用户在重试期把草稿类型**改回旧类型**再保存 —— 此刻 `typeChanged=false`（快照 `savedFetcher`=旧类型）、cookie 缺省继承磁盘 `cookieSet:false` → 按钮亮、保存成功，而**文件仍在且是旧类型的有效 Cookie**（unlink 失败方向的含义）→ fetch 读到它会**成功**。终态是「标记 `false` + 有效文件」的**反向幽灵**：同屏「未配置」标记与「查询成功」矛盾，下次进编辑体 readiness 强制重贴一个其实仍有效的 Cookie。**量级**：IO 异常 × 重试期改回类型，双重罕见。**恢复**：重贴一次。**重审触发条件**：若出现「未配置标记 + 查询成功」的矛盾反馈，重审半提交时把 `cookieSet` 一次性回写为实际文件状态（unlink 失败时写回 —— 区别于 D12 已否决的常驻读侧存在性校正）。注意与 write 失败方向（文件缺、标记 `true`—— 那个才由 `no-credential` 兜底，已在改动 1 影响面表登记）相反，本方向**不产生错误数据、只产生矛盾展示**。**自愈**：重贴后保存成功即广播刷新快照。**不改为「失败也广播」**：广播触发 `syncFromProvider` 重置草稿，对**校验类失败**（persist 未提交）会无谓清掉用户正在输入的内容 —— 半提交只是极低概率 IO 异常下的短暂屏幕滞后，广播方案的代价面更大。

**改动 3 · 按 `credentialSource` 解析凭证**（`quota-service.ts:576-596`）

```ts
if (kind === 'api-key') {
  const source = resolveQuotaCredentialSource(this.getProviderInfo(providerId)?.quota)
  if (source === 'exclusive') {
    return this.readSecret(this.getApiKeyPath(providerId))   // 缺失 → null → no-credential
  }
  // source === 'provider'：跳过专属 Key 文件；provider 凭据段（auth.json → models.json）
  // 沿现状的收口通道调用，本设计不改动该段，只改「先读谁」的优先级。
  // 异常降级保留（resolveCredential 在 doFetch 的 try 之外，删掉降级会让 resolver
  // 异常逃出去变成 RPC 无响应——退化为 backstop 超时，比 no-credential 难诊断）
  try {
    const resolved = await this.credentialResolver.resolveProviderCredential(providerId)
    return resolved?.key ?? null
  } catch {
    return null   // → no-credential（可诊断）
  }
}
```

关键点：`'provider'` 分支**完全跳过**专属 Key 文件，这是 D3 消除 §3.2 失败模式 D 的机制所在。

**改动 4 · 缓存与失败标记的清理**

`configure` 成功后：

- `this.lastFailure.delete(providerId)` —— 配置变了，上次的失败原因不再适用。
- **若本次 `fetcher` 与既存值不同 → 清 `this.cache` 中该 provider 的条目**。理由见 §7.1 的「缓存失效的副作用声明」：额度缓存不含类型，不清的话旧类型的行会被 `getCached` 原样取回并可能以新类型的标签展示。`QuotaCache` 目前没有删除 API，需新增（`quota-cache.ts`）。**新 API `removeEntry(providerId)` 的三条语义（缺一即失效）**：① 磁盘侧走既有 `writeChain`（`quota-cache.ts:91-111`）做读-改-写 —— 否则与并发 `update`（hover fetch 写缓存）交错会互相覆盖；② 同步删除 `memoryCache` 镜像中该条目 —— 否则 `getEntry`（`:67-82`）内存 miss 时 `read()` 从磁盘重载，旧类型行被取回（只改内存 → 下一次被磁盘还原；只删磁盘 → 内存镜像继续供旧值，两个方向都复现本改动要消除的现象）；③ 幂等（条目不存在视为成功）。
- **在途写回守卫（「删除之后才落地的写」—— `writeChain` 只保证已发生的写互不交错，管不住这扇门）**：`doFetch` 发起时解析 fetcher 与凭据后进入两个 `await`（`resolveCredential` / `fetchQuota`，在途可达数秒），末尾写缓存前没有任何复核。失败序列：① hover 容量 chip → `quota.fetch` 在途（旧类型、旧凭据已在内存）→ ② 设置页「保存并测试」换类型 → persist 新 fetcher → `removeEntry` 删旧行 → 清 `lastFailure` → ③ 在途旧 fetch resolve（旧平台大概率成功）→ `cache.update` 把**旧类型的行写回** → ④ 若它晚于紧随的 refresh 落地，缓存停在旧类型行且无 reason（`lastFailure` 已被 ② 清空）→ 浮层把旧平台数据当新类型展示，10s throttle 内每次 hover 都读这行。**守卫**：`doFetch` 发起时捕获 `fetcher.id`，收尾区写三件套（`cache.update` / `lastFailure` / `lastFetchTime`）前与 `getFetcherForProvider(providerId)?.id` 比对（该读直读盘无缓存，persist 落盘后立即可见，与 broadcast 无关），失配则三件套全部不写、RPC 返回 `this.getCached(providerId)`（**读当前真相**，不是手工空对象 —— `useQuotaQuery.ts:125-130` 的消费分支是「有 `reason` → `setError`；无 `reason` → `store.setCache`」，手工 `{data:null}` 无 reason 会被当成功数据**写进 store**、并把诊断态 error 清成 null）。返回 `getCached` 的两种时序都有明确出处：**晚于**新 refresh 落地时读到新行 → `setCache(新行)`，正向；**早于** refresh 落地的窗口内返回空真相 → `setCache(pid,null,null)` 覆盖 store 里本就该失效的旧类型行，浮层一跳「暂无数据」，下一个 hover（时间戳已修、不被压制）立即重拉自愈。另：`saveAndTest` 的 refresh 结果走设置页本地态（`testStatus`/`quotaData`）不写 store，不存在「store 已有新数据被这次返回清掉」的时序。**`lastFetchTime` 的写点必须随守卫后移**：现行代码在 `doFetch` **开头**、两个 `await` 之前就 `lastFetchTime.set`（`quota-service.ts:480-482`，[W5] 注释即此语义）—— 末尾守卫撤不回已发生的写，照原样实施会出现「旧行不回写 ✅ 但时间戳已盖 → 新类型首次 hover 在 10s 内被 throttle 压制 → 返回已清空的 `getCached` →『暂无额度数据』持续 ≤10s」。改为把 `lastFetchTime.set` 挪进守卫后的收尾区：节流锚点从「发起时刻」变为「完成时刻」（语义上更正确 —— 在途期间由 pending 并发复用去重覆盖，不依赖时间戳；窗口实际拉长一个在途时长，无害）。**出口覆盖（否则失败查询失去节流）**：现行 `doFetch` 有五个出口（`!fetcher` 早退 / `no-credential` / 成功 `cache.update` / `fetchFailed(reason)` / throw → `fetchFailed('network')`），今天的开头一次性写覆盖**全部**出口 —— 失败也节流，这正是表 A #13「每次一条 warn」的速率前提。后移后 `set` 落在守卫通过后的**其余全部出口**（成功与各失败路径同等），**不写的只有两个出口：失配出口（守卫丢弃）与 `!fetcher` 早退（不发请求）**。若只放成功路径旁：持续失败的 provider（凭证缺失 / unauthorized）每次 hover 都发真实请求并落一条 warn，请求与日志速率失去上界。**`!fetcher` 早退的不写是一次显式行为变更**（现状的开头写在早退检查之前，该出口今天也被节流）：豁免后每次 hover 重跑本地判定 —— 量级为 2 次小文件读盘（`getExtrasSync` 直读 providers.json + models.json）+ `matchQuotaPreset`，无请求无日志，速率受 hover 事件与 renderer `markPending` 去重双重有界，判定无害。**结构收口（防出口漂移）**：五出口的守卫与三件套写收口为单一收尾 helper（守卫 + `cache.update` / `lastFailure` / `lastFetchTime` 只写一遍，各出口调用它）—— 新出口不经 helper 即不写时间戳，遗漏在代码结构里可见而非靠清单纪律（与 handler 整对象透传、字段级白名单同一「用结构消除清单」手法）。**被否**：失配分支补 `lastFetchTime.delete(pid)` 的补偿写 —— 「set 后再按条件 delete」依赖两处写点的顺序永不改变，比单一写点脆弱。**另一被否的加强**：per-provider 配置代次计数器 —— 凭证 / workspace 的在途变化只产生「同类型的略旧数据」（无害），**类型错标**才是要防的伤害；代次机制不为增加防护多带一份状态。

provider 删除时：清 `lastFailure` / `lastFetchTime`（与改动 5 同一钩子）。

**改动 5 · provider 删除链清理 quota secrets**（D12）

删除链的调用路径已核实：`settings-message-handler.ts:192` / `:216` → `ConfigService.deleteProvider` / `removeProviderByKind`（`config-service.ts:195-200`）→ `provider-config-helper.ts` 的 `deleteProviderImpl` / `removeProviderByKindImpl`。而 `ConfigService` 构造已经是**可选注入**模式（`config-service.ts:109-127` 的 `authStorage?` / `providerExtrasStore?`，注释明确写了「可选注入：未注入时清理 no-op，生产恒注入」）。

因此本改动照同一模式加一个可选依赖：

```ts
// config-service.ts 构造函数新增
/**
 * quota 副产物清理（D12）：secrets/<pid>-{cookie,apikey}.txt 明文 + 内存失败标记。
 * 可选注入：未注入时清理 no-op（测试场景），生产恒注入。
 */
private quotaStateCleaner?: (providerId: string) => Promise<void>,
```

**注入点必须用「后置回填」，不能用构造参数**（已核实的构造顺序）：

`index.ts:264` 构造 `configService`，`index.ts:696` 才构造 `quotaService` —— 后者依赖前者，构造期拿不到。照既有先例回填：

```ts
// index.ts，quotaService 构造完成之后
configService.setQuotaStateCleaner((providerId) => quotaService.clearProviderState(providerId))
```

先例：`index.ts:556-560` 的 `configService.setCredentialWriter(authService)`，其注释已写明该模式的安全性依据 ——「回填前无 RPC 处理，`server.start` 在全部装配后，无窗口期」。

> **实施注意（否则 D12 静默失效）**：可选注入的既有语义是「未注入 = no-op」（`config-service.ts:117/127`）。若漏掉上面这行回填，**不会编译报错**，而是生产环境删除 provider 时 `clearProviderState` 根本不执行 —— D12 效果归零，且只有验收场景 S14 能发现。

删除链的清理点遵循「清理失败只 warn 不阻断删除主流程」的既有语义（`cleanAuthCredential` / `cleanProviderExtras`，真实实现见 `provider-config-helper.ts:1239-1263` 与 `:1265-1278`，两处的 `catch → console.warn` 是同款）。**但新增的 `clearProviderState` 不与它们并列 —— 它只在 `cleanProviderExtras` 成功之后执行**（排序约束，防幽灵标记）：

- **extras 删失败 + secrets 保留** → 留下「extras 标记与 secrets 文件互相一致」的残留：同 id 重建会正常继承旧 Cookie。这是 D12 之前既有行为在 IO 失败时的退化形态（warn 已提示；重试删除即清）—— 宁可如此，也不制造「标记 `true` + 文件已删」的幽灵标记（它会让同 id 重建的归属判定读到假状态，见改动 1 影响面表的「幽灵标记」行）。
- **extras 删成功 + secrets 删失败** → 惰性孤儿文件（两个文件同理）：provider 已删 ⇒ 无人 fetch；同 id 重建 ⇒ readiness 强制重贴 / 重选 ⇒ `configure` 先重写文件；专属 Key 另有第二重惰性（无条目 ⇒ 兜底 `'provider'` ⇒ 改动 3 跳过）。下次同 id 删除再清。
- **实施注意**：`cleanProviderExtras` 目前 `catch → warn → 正常返回`，调用方无从得知失败。排序约束要求它把失败信号**返回**（如返回 `boolean`），warn 语义不变、仍不阻断删除主流程 —— 只阻断 `clearProviderState` 这一步。
- **钩子落点共三处**（RPC 层两条删除链，`cleanProviderExtras` 的调用点）：`deleteProviderImpl` 尾、`removeProviderByKindImpl` 的 catalog 与 custom 两分支尾（`provider-config-helper.ts:1315/:1386/:1395`，行号随并行变更漂移、以符号名为锚）。全仓核实 `extrasStore.delete` 仅被 `cleanProviderExtras` 内部调用 —— **无第三条删除路径**。排序约束与 boolean 失败信号要落在全部三点（`removeProviderByKindImpl` 两分支可抽共享尾函数，避免排序逻辑写两遍）。

`QuotaService` 提供对应实现（`clearProviderState(providerId)`）：删除两个 secrets 文件（幂等：**捕获 `ENOENT` 视为成功**，不做 `existsSync` 预检）+ 清 `lastFailure` / `lastFetchTime` + 清 `cache` 中该 provider 条目。

**为什么不直接从 `getDataDir()` 推导 `secrets/` 路径**：那会让删除链知道 quota 的存储布局，与 `authStorage` / `providerExtrasStore` 的注入惯例不一致；且路径推导若变化会有第二处需要同步。

**改动 6 · `persistQuotaConfig` 写入 `credentialSource`（继承链，非推断）**（`quota-service.ts:381-422`）

`quota` 嵌套字面量为 `credentialSource` 增加一行，与 `fetcher` / `cookieSet` / `apiKeySet` 同走既有的 `inheritQuotaField(next, current, legacy)`：payload 键缺省 = 继承既存值，显式值 = 覆盖。

**禁止把 `resolveQuotaCredentialSource` 用在写侧当默认值**。它只服务读侧（组装 `ProviderInfo.quota` 与 fetch 时解析），尽管签名 `{ credentialSource?, apiKeySet? }` 看起来正像一个写侧默认值模板。**危害不是「覆盖用户显式选择」（`??` 短路使那不可达——`resolve` 对带显式值的输入恒返回该显式值），而是「把未设置的字段物化成推断值」**：若 persist 写成 `credentialSource: incoming ?? resolve(current)`，则 `setEnabled`（其余键全缺省）会在磁盘上写入一个**用户从未选择过**的来源值——拨一下开关就把「未设置」这一中间态（读侧按 `apiKeySet` 动态推断）冻结成显式值，既违反 D4「开关只写 `enabled`」，也破坏了「键缺省 = 继承既存」的继承语义。可观察后果：该 provider 此后不再跟随推断——即使专属 Key 文件被清除（`apiKeySet` 变 false，读侧本应回落 `provider`），冻结的显式 `exclusive` 仍会让查询走向 `no-credential`。

### 7.4 UI 改动

`CodingPlanSection.vue` 按方案 B 重写。Props 变更：

| 变更 | 说明 |
|---|---|
| `apiKeySet` **删除** | 拆为 `providerCredentialAvailable` 与 `quotaApiKeyConfigured`（D3） |
| 新增 `credentialSource` / `readiness` | 渲染分段控件与字段级提示 |
| 新增 `providerCredentialPendingSave` | 消除「按钮灰但屏幕上明明填了 Key」的矛盾（见下） |
| `configureErrorMsg` 保留 | 保存类错误的统一出口（走 i18n，D9） |
| 四个按钮（`quota-save-apikey-btn` / `quota-save-cookie-btn` / `quota-save-workspace-btn` / `quota-test-btn`）**合四为一** | 合并为单个 `quota-save-test-btn` |
| **oauth 凭证态行移除** | 随 `apiKeySet` 一并删除（OAuth 信息并入 `quotaSourceProviderOauthHint`）；连带 4 个 i18n key（`quotaCredentialOauthReady` / `quotaCredentialOauthMissing` / `quotaCredentialOauthMissingHint` / `quotaApiKeyFallbackOrder`）失去全部消费方 → 同批删除（一致性审查登记，v8 遗漏） |

**「已配置 / 必填」徽标的取值规则（按 D5 的凭证归属过滤，与 readiness 同源）**：徽标表达的是「该字段此刻有效」，不是「磁盘上曾存过一份」——`已配置 ⟺ 磁盘有值 ∧ ¬typeChanged`（cookie：`!typeChanged && quota.cookieSet`；专属 Key：`!typeChanged && quota.apiKeySet`；workspace：明文回显字段，取 `workspaceInput` 非空）。用磁盘原始标记会导致类型切换后出现「徽标说已配置、字段提示说必填」的同屏矛盾 —— 对照 §5.2 路径 2 的终态原型（该状态明写 `Cookie · 必填`）与 S7 的通过标准（「改类型后旧 Cookie 不计入，Cookie 与 Workspace 都提示必填」）。

`ProviderEditBody.vue:222` 的 `:api-key-set="!!provider?.apiKeySet || !!provider?.quota?.apiKeySet"` 拆成两个独立 prop（D3 的证据来源）。

**字段级提示的渲染用显式白名单**：只对 `'cookie' | 'apiKey' | 'workspace'` 三个缺口键查 i18n 映射，不写 `missing.map(key => t(...))` 兜底循环 —— 让 §7.1 里「`'type'` 不配文案」的约定成为**结构保证**（`'type'` 走 D8 的「只渲染下拉 + 说明」分支，根本不进提示渲染），而不是靠消费方自觉。

**跨区块时序的文案处理**：齐备性读的是 **provider 的已保存快照**（`provider.apiKeySet`），而 provider 表单是草稿模型 —— 用户在表单里刚填 API Key 还没保存时，额度按钮仍是灰的。这**不是**判定错误（runtime 只能读到落盘的凭据），但需要文案说清：

- `provider.apiKeySet === false ∧ form.apiKey 为空` → 「上方「凭据」区还没有可用的 API Key，请先填写，或改用专属 Key」
- `provider.apiKeySet === false ∧ form.apiKey 非空` → 「上方「凭据」区已填写 API Key，**保存 provider 配置后**即可查询」

`ProviderEditBody` 把 `form.apiKey` 的状态作为 `providerCredentialPendingSave` 传入。**判定式必须排除清除哨兵**：

```ts
providerCredentialPendingSave = form.apiKey !== '' && form.apiKey !== API_KEY_CLEAR_SENTINEL
```

`API_KEY_CLEAR_SENTINEL = '__CLEAR__'` 是用户在 provider 表单点「清除」时写入的标记（`use-provider-edit.ts:166`，写入点 `:578`）。只用 `!== ''` 判断的话，用户刚点完「清除」会看到「已填写 API Key，保存 provider 配置后即可查询」—— 与实际正好相反。等价写法是复用 `resolveApiKeyForSave`（`use-provider-edit.ts:501` 用它派生 `wroteApiKey`）。

### 7.5 文件改动地图

| 层 | 文件 | 改动性质 | 归属单元 |
|---|---|---|---|
| shared | `packages/shared/src/quota-types.ts` | 加 `'no-credential'`（`:44`）、`QuotaCredentialSource`、`resolveQuotaCredentialSource` | U1 |
| shared | `packages/shared/src/provider.ts` | `quota` 加 `credentialSource`（`:189-212`） | U1 |
| shared | `packages/shared/src/index.ts` | 导出新符号（`:119-123`） | U1 |
| shared | `packages/shared/src/protocol.ts` | **`'quota.configure'` payload 改用 `QuotaConfigurePayload`（含 `credentialSource?`；`:585`）** —— 漏 `credentialSource` 键则 renderer 传该键触发 excess property **编译错**（`command()` 的 payload 受 `ClientMessageMap[K]` 约束，`core/src/transport/api/request.ts:42-45`） | U1 |
| core | `packages/core/src/transport/api/domains/quota.ts` | `configure()` 收敛为单一 payload 参数（`QuotaConfigurePayload`）并整对象透传（`:66-76`）—— **M2 落地**，与 renderer 调用点同批原子切换（先切一侧即编译错，见 §7.1「分期兼容」） | U4 |
| core | `packages/core/src/transport/mock/index.ts` | `configure` 签名同步切 payload（`:1310-1312`）—— 同构是**项目约定而非编译强制**（`packages/renderer/src/api/index.ts:54` 的门面三元的约束只在有人经门面调用 `configure` 时生效、当前无人经门面调它；`mock-domains.test.ts` 头注释「各域签名同构」正是该约定的测试形态）；mock 不参与 wire 链，漏改只影响 `VITE_MOCK=true` 分支 | U4 |
| renderer | `packages/renderer/src/composables/features/model/useQuotaQuery.ts` | `QUOTA_FAIL_REASON_KEYS` 加 key（`:25-31`）——**枚举扩展必须与穷举映射同批，否则 `vue-tsc` 报错** | U1 |
| renderer | `packages/renderer/src/i18n/locales/{zh-CN,en-US}/settings.ts` | 新增/调整/删除 key（块 `:422-487`） | U1 |
| renderer | `packages/renderer/src/i18n/locales/{zh-CN,en-US}/panel.ts` | `panel.context.*` 加 `quotaFailNoCredential`（`:149-153`） | U1 |
| runtime | `packages/runtime/src/services/quota-service.ts` | 改动 1/2/3/4/6（`:245-286`、`:309-349`、`:476-480`、`:511-515`、`:576-596`）；`configure` 签名切 `QuotaConfigurePayload`（M1，wire 兼容：旧 renderer 的 6 字段对象本就是合法 payload）；**另需扩 `ProviderInfoLike.quota`（`:37-45`，当前只声明 `{ fetcher?: string }`，拿不到 `credentialSource`/`apiKeySet`）并在 `persistQuotaConfig`（`:381-422`，嵌套字面量 `:400-414`）写入新字段（走 `inheritQuotaField` 继承链，见改动 6）** | U2 |
| runtime | `packages/runtime/src/transport/quota-message-handler.ts` | **`quota.configure` 分支改为整对象透传 `quota.configure(data)`（`:68`、`:75`）** —— 不再逐参解构；即使忘改，旧 6 参调用对新 1 参签名也是参数数**编译错**（v3 的「静默丢字段」段结构性消除，见下方「端到端链」）。透传前**保留** `!data.providerId \|\| typeof data.providerId !== 'string'` → `sendError` 的 [W3] 防御校验（`:69-71`，注释明言是修过的真实 bug 类）—— 它不随逐参解构一起删，M1 期 handler 先切、旧 renderer 并存时是畸形 payload 的唯一防线 | U2 |
| runtime | `packages/runtime/src/services/provider-extras-store.ts` | **`ProviderExtras.quota` 加 `credentialSource`（`:37-47`）** —— 否则 `persistQuotaConfig` 的嵌套对象字面量对 `ProviderExtras['quota']` 触发 excess property check **编译错** | U2 |
| runtime | `packages/runtime/src/services/quota-cache.ts` | 新增 `removeEntry`（改动 4 依赖；当前只有 `getEntry` / `update`；三条语义见改动 4：`writeChain` 串行化 + `memoryCache` 同步删 + 幂等） | U2 |
| runtime | `packages/runtime/src/services/provider-config-helper.ts` | 改动 5：删除链加 quota 清理钩子 + 排序约束（钩子落点**三处**：`deleteProviderImpl` 尾、`removeProviderByKindImpl` 两分支尾，以符号名为锚 —— 行号随并行变更漂移）；`cleanProviderExtras` 改返回 boolean 失败信号（warn-only 语义不变，细节见改动 5） | U2 |
| runtime | `packages/runtime/src/services/config-service.ts` | 构造函数加可选 `quotaStateCleaner`（`:109-127`）+ `setQuotaStateCleaner` 回填方法；`deleteProvider` / `removeProviderByKind`（`:195-200`）传入删除链 | U2 |
| runtime | `packages/runtime/src/index.ts` | 组合根**后置回填**：`quotaService` 构造（`:696`）之后调 `configService.setQuotaStateCleaner(...)`（先例 `setCredentialWriter`，`:556-560`） | U2 |
| core | `packages/core/src/domain/settings/quota-configure-state.ts` | 契约重构（§7.1） | U3 |
| core | `packages/ui/src/features/settings/injection-keys.ts` | **`NOOP_FACTORY` 是 `QuotaConfigureState` 的完整字面量（`:61-89`），契约增删成员后必须同步** | U3 |
| renderer | `packages/renderer/src/composables/features/model/useQuotaConfigure.ts` | 重构：readiness / saveAndTest / setEnabled / 类型进草稿 / 凭证归属 / 去掩码 / i18n / loadCached 修 reason | U4 |
| ui | `packages/ui/src/features/settings/coding-plan/CodingPlanSection.vue` | 重写 | U5 |
| ui | `packages/ui/src/features/settings/provider/ProviderEditBody.vue` | prop 接线（`:204-238`、`:222`），新增 `providerCredentialPendingSave` | U5 |
| renderer | `packages/renderer/src/components/panel/ContextCapacityPopover.vue` | D11：失败态 footer 补「配置」按钮（`:136-154`） | U5 |

**新参数 `credentialSource` 的端到端链（实施时逐段核对）**

D3 引入的新字段要穿过 8 段才真正生效。**payload 收敛（§7.1）之后守门分布变了**：第 3/6/7 段由类型系统报编译错；第 4 段（v3 里唯一「不报错、静默丢字段」的段）被整对象透传**结构性消除** —— 忘改 handler 时，旧 6 参调用对新 1 参签名直接参数数编译错。剩余不报错而失效的只有第 1 段（调用方没构造该键 —— 可选字段本不该报）。若真的发生，后果是 `providers.json` 永不写该字段、两端都退回 `apiKeySet` 推断、**§3.2 失败模式 D 原样复现**，且只有验收场景 S9 能发现：

| # | 段 | 位置 | 漏改的后果 / 守门 |
|---|---|---|---|
| 1 | renderer 调用 | `useQuotaConfigure.ts` 的 `saveAndTest` | 未构造该键 → 字段全程缺失（不报错，靠 S9 兜底） |
| 2 | core domain api | `core/src/transport/api/domains/quota.ts:66-76` | 整对象透传，透传层无从丢失（丢键 = 第 1 段的责任） |
| 3 | **protocol payload** | `shared/src/protocol.ts:585` | **编译错**（excess property check） |
| 4 | **runtime handler** | `runtime/src/transport/quota-message-handler.ts:68`、`:75` | 整对象透传；忘改则**参数数编译错**（v3 的静默丢字段在此结构性消除） |
| 5 | `QuotaService.configure` 签名与 `persistQuotaConfig` | `quota-service.ts:245-286`、`:381-422` | 签名 = shared 同一 payload 类型；不落盘只可能因 persist 漏写字段（改动 6 的继承链） |
| 6 | `ProviderExtras.quota` 类型 | `provider-extras-store.ts:37-47` | **编译错**（excess property check） |
| 7 | 读侧 `ProviderInfoLike.quota` | `quota-service.ts:44-54` | **条件性守门**：改写成逐字段投影（`quota: { fetcher: extras?.quota?.fetcher }`）**不会**报错——两者共享 `fetcher` 公共属性，既不触 weak type 也不触 excess property，静默丢掉 `credentialSource`/`apiKeySet`。须靠约定「传入整个 `extras?.quota` 对象，禁止逐字段投影」（现实现 `index.ts:722` 即如此）+ U2 测试断言 `credentialSource` 透传守门 |
| 8 | `resolveQuotaCredentialSource` | `quota-types.ts`（新增） | 两端推断各写各的（写侧禁用，见改动 6） |

**分段验收（可执行形式，按阶段能力对齐）**：

- **M1（段 5-7）**：M1 结束时 renderer 仍是旧实现、不传 `credentialSource`，「一次保存并测试后读 `providers.json`」在 M1 **跑不出来**（v3 写法按字面执行是假阴性）。改为：runtime 单测直接以带 `credentialSource` 的 `QuotaConfigurePayload` 调 `QuotaService.configure`，断言 `providers.json` 落盘该字段；同批断言「其余键缺省」的 `setEnabled` 式 payload **不覆盖**既存显式值（继承链，改动 6）。
- **段 3（M0）**：类型落地即由 `vue-tsc` 编译错守门（excess property）。
- **段 4（U2）**：接线时若保留旧 6 参解构 → 参数数编译错，守门前置；整对象透传的写法本身进 U2 审查面。
- **段 1-2 与整链（M2）**：S9 在真实 UI 上闭环（读 `providers.json` 比对 + 把专属 Key 改错验证 runtime 确实没用它）。

**测试改动清单**

| 文件 | 动作 |
|---|---|
| `packages/renderer/src/__tests__/composables/use-quota-configure.test.ts` | 重写（readiness 矩阵 / 凭证归属 / saveAndTest 参数构造 / setEnabled 无请求 / 无掩码） |
| `packages/ui/src/features/settings/__tests__/coding-plan-section.test.ts` | 重写（字段级提示 / 单按钮置灰矩阵 / 分段控件 / 未选类型态） |
| `packages/ui/src/features/settings/__tests__/provider-edit-body.test.ts` | 更新（prop 拆分） |
| `packages/renderer/src/__tests__/settings/provider-edit-body-phase-b.test.ts` | 更新（真实 composable 接线） |
| `packages/renderer/src/__tests__/panel/context-capacity-quota.test.ts` | 更新（失败态「配置」入口） |
| `packages/renderer/src/__tests__/i18n/quota-reason-i18n.test.ts` | 更新（新 reason key 双语存在性） |
| `packages/renderer/src/__tests__/api/quota-domain.test.ts` | 更新（configure payload 加 `credentialSource`） |
| `packages/core/src/transport/api/__tests__/domains.test.ts` | 更新（quota domain payload 形状） |
| `packages/runtime/test/services/quota-service.test.ts` | 新增（no-credential / cookie 空串清除 / **按 source 解析凭证** / lastFailure 清理 / 删除顺序 / **`credentialSource` 走继承链**——`setEnabled` 式「其余键缺省」payload 不覆盖既存显式值 / **在途 fetch 守卫**——fetch 在途 → configure 换类型 → fetch 落地，断言旧行不回写、`lastFetchTime` 未写**且新类型首个 fetch 不被 throttle 压制**、RPC 返回当前 `getCached` 真相；另断言**失败路径的节流不断**——`fetchFailed` 后 10s 内第二次 hover 不再发真实请求 —— 既有 throttle 测试只断言成功路径，失败失节流无门可拦） |
| `packages/runtime/test/services/quota-cache.test.ts` | 新增（`removeEntry` 三条语义：`writeChain` 串行化 / `memoryCache` 同步删 / 幂等） |
| `packages/runtime/src/services/__tests__/provider-config-helper.test.ts` | 新增删除链排序三用例：① `cleanProviderExtras` 失败 → 删除主流程仍成功 + secrets 保留；② extras 删成功 + cleaner 失败 → warn-only 惰性孤儿；③ 三落点各一条 —— 排序与 boolean 短路逻辑在 helper 层，`quota-service.test.ts` 的「删除顺序」覆盖不到这里，短路写错（如 `if (!ok) throw` 阻断删除主流程、条件写反）在此拦截 |
| `packages/core/src/transport/mock/__tests__/mock-domains.test.ts` | 更新（M2 批次：`:452` 的位置参数断言改 `quota.configure({ providerId: 'p', enabled: true })`）—— 该文件**在 `packages/core` 的 tsc 门内**（`core/tsconfig.json` 的 `include: ["src"]` 覆盖 `src/**/__tests__`，`core:typecheck` 会跑），位置参数对新签名是参数数**编译错**；但单跑 vitest 时旧断言仍会**假绿**（新 mock 收到 `'p'` 当 payload、忽略参数、照返 `{ok:true}`）——两个信号都要，故必须显式列清单同步更新断言 |
| `packages/runtime/src/services/quota-providers/__tests__/fetchers.test.ts` | 无改动（fetcher 层未动） |

---

## 8. 验收（真实场景，非单测非 mock）

**本章结论：16 个真实场景，其中 8 个是反向验证（验「不该发生的事没发生」）。**

### 8.1 改动规模

**大**：行为变更（开关不再触发查询、保存与测试合一、类型进入草稿）+ 接口调整（契约重构、新增持久化字段与失败原因）+ 新增删除通道。按 `doc-structure.md` 的层敏感调节表，本次属「技术方案设计类」，准则 5/6/7/11 全部适用。

### 8.2 验收场景

在真实运行的 `pnpm run dev` 环境里、用真实 provider 凭证执行。涉及「不该发生」的场景标注为**反向**。

| # | 场景 | 回溯目标 | 真实流程与观察点 | 通过标准 |
|---|---|---|---|---|
| S1 | **首次配置智谱**（provider 已填好 API Key） | 目标 1、2 | 打开 provider 编辑体 → 选「智谱 GLM Coding Plan」→ 观察按钮 → 点「保存并测试」→ hover 对话页容量 chip | 选完类型按钮**直接可点**（Provider 凭据继承生效，无需重复填 key）；点击后内联显示三窗口用量（5h 有值，本周/本月为 ∞）；对话页 hover 显示相同数据 |
| S2 | **首次配置小米 MiMo**（cookie 类，无继承路径） | 目标 1 | 选「小米 MiMo」→ 观察按钮与字段提示 → 粘贴从 DevTools 复制的 cookie → 点按钮 | 选完类型按钮**置灰**且 Cookie 字段下方出现「这里必须填」；粘贴后变亮；点击显示本月用量（5h/本周为 ∞） |
| S3 | **opencode.go 的两个必填项** | 目标 1 | 选「opencode.go」→ 只填 Cookie → 观察 → 再填 Workspace → 观察 | 只填 Cookie 时按钮**仍置灰**且 Workspace 字段提示存在；两项都填后变亮，测试通过 |
| S4 | **反向 · 参数没填完时按钮不可点** | 目标 1 | 上述任意未齐备状态下尝试点击按钮 | 按钮不可点（`disabled`），**不产生**任何 `quota.configure` RPC 与网络请求；runtime 日志无对应记录 |
| S5 | **反向 · 拨开关不发请求** | 目标 3 | S1 完成后把开关关掉再打开；观察 `<dataDir>/quota-cache.json` 的 `lastFetchAt` 与文件 mtime、runtime 日志 | `providers.json` 的 `enabled` 即时跟随；`quota-cache.json` 的 mtime 与 `lastFetchAt` **均不变**，runtime 日志无新的 fetch 记录 |
| S6 | **反向 · cookie 掩码不再损坏凭证** | 目标 5（失败模式 B） | S2 完成后重进设置页 → 观察 Cookie 输入框 → **不做任何修改**直接点「保存并测试」 | 输入框**为空**且字段旁标「已配置」；直接点按钮后查询**仍然成功**（真 cookie 未被覆盖） |
| S7 | **切换类型后凭证归属失效** | 目标 5（失败模式 C） | S2 配好 MiMo 后把类型改成「opencode.go」→ 观察齐备性 → 点「保存并测试」→ 检查 `<dataDir>/secrets/<pid>-cookie.txt` | 改成 opencode.go 后按钮**立刻置灰**（旧 Cookie 不计入），Cookie 与 Workspace 都提示必填；补齐并保存后，`<pid>-cookie.txt` 内容为新的 opencode cookie |
| S8 | **反向 · 点选当前已选类型不清空草稿** | 目标 5 | opencode.go：在 Cookie 输入框里粘贴一段**尚未提交**的内容 → 打开类型下拉，点选当前已经选中的「opencode.go」→ 观察输入框 | 输入框内容**仍在**；不产生 `quota.configure` RPC；`<pid>-cookie.txt` 与 `providers.json` 的 `quota` 字段完全不变。**场景前提**：必须先在草稿里留下未提交内容 —— 否则草稿本来就是空的，清不清都「通过」，测不出同值 emit 这个 bug（对照：若把清空挂在 Select 事件上，这一步会丢输入） |
| S9 | **反向 · 凭证来源与 runtime 实际行为一致** | 目标 4（失败模式 D） | ①给智谱配专属 Key（分段控件选「用专属 Key」）→ 保存并测试成功；②切到「用 Provider 凭据」→ 保存并测试；③检查 `providers.json` 的 `quota.credentialSource` 与 `secrets/<pid>-apikey.txt` | ② 之后 `credentialSource` 为 `provider`，且查询**确实没有使用**专属 Key（把专属 Key 改成一个明显错误的串，查询应仍成功）；`<pid>-apikey.txt` **仍然存在**（未被删除）；③ 切回「用专属 Key」无需重新粘贴即可生效 |
| S10 | **反向 · 未选类型时不渲染参数、不产生写入** | 目标 1（D8） | 打开一个从未配过额度的 provider 编辑体，不选类型，观察区块 | 只渲染类型下拉 + 一句说明；**不渲染**开关、凭证区、按钮；不产生任何 `quota.configure` RPC |
| S11 | **失败路径分辨得清** | 目标 5 | ①填一个错误的 API Key → 测试；②用只有 OAuth 凭证的 provider 配一个只支持 api-key 的类型 → 测试 | ①显示「凭证可能过期」并给出刷新动作；②显示「未找到可用凭证」并指向凭据区。**两条文案必须不同** |
| S12 | **对话页失败态有出路**（D11） | 目标 5 | 让某个已启用的 provider 处于失败态（如把它的专属 Key 改错），在对话页 hover 容量 chip | 浮层显示失败文案，且 footer **同时**有「刷新」与「配置」两个按钮；点「配置」能打开设置页 |
| S13 | **反向 · 宿主表面不被改变** | 目标 5 | S1-S3 各跑一轮，再执行 S7（触发一次 secrets 删除），然后重启应用，检查 `providers.json` 与 `<dataDir>/secrets/` | `providers.json` 结构完好（`version: 1`、无 `.corrupt-<ts>` 隔离文件、无 `.tmp` 堆积）；secrets 目录只含当前配置过的 provider 的文件、**无空文件残留**；重启后对话页浮层正常显示；连续 5 次切换类型 + 保存后，`.tmp` 与隔离文件数量不增长 |
| S14 | **provider 删除清残留**（D12） | 目标 5 | 给一个 custom provider 配好 cookie → 删除该 provider → 检查磁盘 → 用同一个 id 重建 | 删除后 `secrets/<pid>-cookie.txt` **不存在**（对照：现状会残留）；重建后编辑体显示「未配置」，不继承旧 cookie |
| S15 | **反向 · Workspace 不能被清空**（D13） | 目标 1 | opencode.go 配好 Workspace → 手动清空输入框 → 观察按钮与后续行为 | 按钮**置灰**并提示「还缺：Workspace 地址」；**不产生**任何 `quota.configure`；已保存的 Workspace 不被删除（对照：v1 设计下空串会被解释为清除） |
| S16 | **改类型再改回原类型** | 目标 4、5 | S2 的 MiMo 配好并测试通过 → 把类型改成 opencode.go（**凭证**草稿清空、按钮置灰）→ 不改任何参数，把类型改回「小米 MiMo」→ 观察按钮。**opencode 变体**：opencode.go 配好 Cookie + Workspace 并测试通过 → 切到 MiMo 再切回 → 观察 Workspace 输入框与按钮 | 按钮**恢复可点**（旧 Cookie 的归属重新成立，未被删除）；直接点「保存并测试」仍能成功 —— 证明 D5 的作废是**判定层**的、不是销毁层的。opencode 变体额外要求：Workspace 输入框**仍显示已保存的 URL**（类型切换不清 Workspace 草稿，§7.2 细节 2），无需重填 |

> **关于 S5 的探针**：该场景验证「开关不发请求」这一运行时断言。设计阶段未实跑（需要改造后的运行环境），标记为 **⛔ 实施期门**。**失败时的降级路径**：若探针显示拨开关确实产生了请求，说明 `setEnabled` 内仍有残留的查询调用 —— 直接回到 §7.1 的契约检查 `setEnabled` 实现；此时**不得**用「加一个标志位跳过首次查询」之类的补丁绕过，必须删掉该调用。
>
> **S5 未覆盖**：对话页 hover 的按需拉取（那是期望行为，见 D4 边界 1），只验证设置页的开关动作本身。

---

## 9. 实施

**本章结论：4 个阶段。M0/M1 可独立合入并独立验收（但 M0 的范围必须包含穷举映射点，否则编译不过），M2 是原子切换。**

### 9.1 迁移路径

| 阶段 | 内容 | 交付终态的什么 | 可独立验收 |
|---|---|---|---|
| **M0** | shared 枚举 `'no-credential'` + **`useQuotaQuery.ts` 的穷举映射** + 双语 i18n key（含 `panel.context.quotaFailNoCredential`）+ `QuotaCredentialSource` 类型与解析函数 + `ProviderInfo.quota.credentialSource` 字段 + `QuotaConfigurePayload` 类型（protocol 引用；旧调用缺新键仍合法，零行为变更） | 错误规格与数据模型可表达 | 类型检查通过 + i18n key 存在性测试 |
| **M1** | runtime 改动 1-6（`no-credential` / cookie 空串清除 + 删除顺序与失败语义 / 按 source 解析凭证 / 失败标记清理 / provider 删除清理钩子 / `credentialSource` 落盘继承链）+ `QuotaService.configure` 与 handler 收敛为 payload 透传（wire 兼容） | §7.3 | 场景 S11②、S14；runtime 单测（含端到端链段 5-7 的直调落盘断言，见 §7.5「分段验收」） |
| **M2** | core `domains/quota.ts` 与 mock 的 `configure` 签名切换 + renderer composable + ui 区块 + 浮层入口 **原子切换** | §7.1 / §7.2 / §7.4 | 场景 S1-S10、**S11①**、S12、S13、**S15**、**S16** 全量 |
| **M3** | 收尾：清 10 处硬编码中文、移除旧 prop、回写文档（附录 A） | §6.10 | lint + 全量测试 |

**为什么 M0 必须包含 `useQuotaQuery.ts`、`protocol.ts` 与 `ProviderInfo` 字段**：`useQuotaQuery.ts:25-31` 的 `QUOTA_FAIL_REASON_KEYS` 是 `Record<QuotaFetchFailureReason, string>` 的**穷举映射**，漏 key 不是运行期静默 undefined，而是 `vue-tsc --noEmit` **编译错误**（pre-commit 在 `packages/renderer` 会跑 vue-tsc）；`protocol.ts:588` 的 payload 类型是 renderer `command()` 的约束源（`packages/core/src/transport/api/request.ts:44-48`，payload 受 `ClientMessageMap[K]` 约束）：**漏必填字段 = 缺属性编译错**（TS2739/2345），**多键或键名写错 = excess property 编译错**（TS2353）。runtime handler 段在 v3 的 7 位置参数下漏改**不报错**（少传可选参数合法）；本次 payload 收敛后它变为**参数数编译错**（§7.1），守门从「清单纪律」升级为「编译器」—— U2 与端到端链清单仍保留，作实施导航。

**为什么 M2 必须原子**：`QuotaConfigureState` 是 core / ui / renderer 三方共享的类型，且 `injection-keys.ts:61-89` 的 `NOOP_FACTORY` 是该类型的**完整字面量** —— 契约增删成员后必须同批更新，否则编译不过。

**为什么 M1 可以先行**：runtime 的改动对现有调用方是行为增强而非破坏 —— `no-credential` 出现时前端会落到 `testFailReason` 的默认分支（通用文案），cookie 空串清除修正只影响一个今天不可达的路径（现状 `saveCookie` 在客户端就拦了空输入），`credentialSource` 解析在字段未设置时按既存标记推断（保持现状行为）。

## 10. 下一层拆分

**本章结论：拆成 6 个单元，前 2 个是前置（M0/M1，可独立合入），中间 2 个是主体（必须同批），最后 2 个是收尾。**

| 单元 | 说明 | justification（为什么这么拆） |
|---|---|---|
| **U1** · 数据模型与错误规格 | shared 枚举 + `QuotaCredentialSource` + `resolveQuotaCredentialSource` + `QuotaConfigurePayload` + `ProviderInfo.quota.credentialSource` + **`useQuotaQuery.ts` 穷举映射** + **`protocol.ts` 的 `quota.configure` payload** + 双语 i18n key | 类型、文案与**协议管道**是 U2-U5 的共同前置；「枚举 + 全部穷举消费点 + 协议字段 + 文案」必须作为一个原子单元，否则类型检查红或字段断链。此单元内 runtime handler 与 service 尚未切换（M1）、core 调用层也保持旧签名（M2），故零行为变更 |
| **U2** · runtime 凭证与清理 | `no-credential` 返回；cookie 空串清除；删除顺序重排与失败语义；按 `credentialSource` 解析（含扩 `ProviderInfoLike.quota`）；`lastFailure` / `QuotaCache` 清理；provider 删除清理钩子；**`QuotaService.configure` 签名切 payload + `quota-message-handler.ts` 整对象透传** | 与前端解耦，可独立单测与独立验收（S11②、S14）；先修好 runtime，前端才能依赖它。handler 与 service 签名必须在此单元**同批**切换 —— 漏改任一侧都是编译错，恰好强制原子 |
| **U3** · core 契约重构 | `QuotaConfigureState` 按 §7.1 重写；`injection-keys.ts` 的 `NOOP_FACTORY` 同步 | 契约是 U4/U5 的接口 SSOT；单独拆出便于审查「接口设计是否合理」而不被实现细节干扰。`NOOP_FACTORY` 与该契约强绑定，必须同单元 |
| **U4** · renderer composable 重构 | `useQuotaConfigure` 实现新契约（齐备性判定 + 凭证归属、saveAndTest 参数构造与 payload 快照、开关无副作用、类型进草稿且同值短路、去掩码、i18n、`loadCached` 修 reason）+ **core `domains/quota.ts` / mock 的 `configure` 签名切 payload（M2，与调用点同批原子切换 —— 先切一侧即编译错，见 §7.1「分期兼容」）** | 这是全部业务逻辑的落点，也是测试密度最高的一层（单测可覆盖齐备性矩阵 —— **含 D13 的判定/保存规则与 D5 的同值短路**，这两条是纯逻辑，最适合在此层用单测穷举）。core 调用层签名与调用点必须同批 —— 这正是 M2 原子性的编译器保障 |
| **U5** · ui 区块重写 + 浮层入口 | `CodingPlanSection` 重写、`ProviderEditBody` prop 拆分、`ContextCapacityPopover` 失败态补「配置」 | 与 U4 同批合入（契约是它们之间的接口）。拆开的意义在于审查面不同：U4 看状态机，U5 看渲染与置灰 |
| **U6** · 收尾与文档回写 | 清硬编码中文、移除旧 prop、回写 `design.md:322/339` 与 `docs/troubleshooting.md` | 按项目「设计文档同步纪律」（C-proc-10）：被本设计推翻的历史约定必须同批回写，否则下次会有人照着旧文档改回去 |

**U4 与 U5 的依赖关系**：强耦合，必须同一 PR。它们共享 `QuotaConfigureState`，且 U5 的置灰矩阵直接消费 U4 的 `readiness`。

## 11. 待验证检查点

诚实标注设计阶段无法确定、留给实施期验证的点：

1. **`provider.apiKeySet` 能否可靠表达「Provider 侧有可用凭据」**。它是 `authIdSet.has(id) || !!override?.apiKey` 的聚合（`provider-config-helper.ts:335`），**不区分 auth.json 里存的是 api_key 还是 oauth**。本设计假设「对只支持 api-key 的 fetcher（zhipu/minimax），若 provider 只有 oauth 凭证则齐备性会误判为 ready，随后由 `no-credential` 兜底」—— 需实跑确认（S11②）。若误判过于频繁，考虑给 `ProviderInfo` 增加凭证类型字段。
2. **广播体积的量化口径**。一次 `configure` 触发的是**两条**全量消息（`config.providers` + `model.list`，见 `message-broker.ts:215-217`、`:169-181`），每条都要跑一次 `listProviders()` 全量读盘。因此量级取决于 **provider 数 × 模型总数 × 客户端数 × 频率**，而不是单一的 provider 数。本方案**不增加**广播次数（旧流程一次切类型/保存 = 2~4 次 configure，新流程 = 1 次保存 + 开关各 1 次），风险是存量而非新增。**需验证**：在模型总数较大（>200）的配置下，一次「保存并测试」的广播耗时可接受。**降级路径**：若不可接受，把 `configure` 的广播从「全量 refetch」改为「增量 patch」（这是一条独立的优化，不在本次范围）。
3. **`not_configured` 在设置页是否还会出现**。按本设计它被 readiness 挡住（workspace 是必填项且始终回显），但 runtime 的该分支保留作为权威兜底。需确认实施后设置页确实不会再渲染这条文案，以及对话页浮层在 workspace 被外部改动时仍能正确显示它。
4. **`lastFailure` 残留的实际影响面**。D12 加了两条清理通道（`configure` 成功时、provider 删除时），覆盖了「用户改动配置」「provider 被删」两类。**真正剩下的窗口是「用户什么都不做」** —— 查询失败后既不重试也不改配置，`lastFailure` 常驻内存。这在语义上是**正确**的（自上次成功以来确实没有成功过，reason 不算过期），不需要额外处理。唯一存疑的是「凭证被外部修复（如手工编辑 auth.json）但用户未重新查询」时浮层仍显示失败 —— 需确认该场景下浮层是否有「刷新」入口给出路（D11 之后有）。
5. **存量「幽灵文件」的迁移面**。升级后 `resolveQuotaCredentialSource` 对「`quota.apiKeySet` 为 false/未设置、但 `<pid>-apikey.txt` 存在」的存量数据会解析为 `'provider'` —— 该 provider 的额度查询会从「实际用专属 Key」**静默切换**为「用 Provider 凭据」（账号与数值可能因此变化）。这正是 §7.3 改动 2 登记的「先写文件后 persist」失败方向在存量数据里的形态。**对照**：正常历史数据是 `apiKeySet: true` + 文件在 → 兜底解析为 `exclusive`，行为与今天一致，无切换。**需验证（可执行判据）**：对真实数据目录跑一次差集 —— 读 `providers.json` 的 `providers[*].quota`，取「`apiKeySet` 为 false/未设置」的 pid 集，与 `<dataDir>/secrets/` 实际存在的 `*-apikey.txt` 文件集求差；同时反向查「`apiKeySet: true` 但文件缺失」的幽灵标记（改动 1 影响面表登记的态）。一次性只读脚本或启动期 debug warn（⛔ 实施期门探针，不进正式代码）。差集为空 = 占比 0，可忽略；非空需评估是否在编辑体上提示「凭证来源已按当前配置重新确定」。

---

## 附录 A：与既有文档的关系

| 既有约定 | 本设计的处置 |
|---|---|
| `docs/page-design/archive/v3/coding-plan-quota/design.md:339`「开关打开后立即调 `quota.refresh` 测试一次」 | **推翻**（D4）。原因：它是失败模式 A 的直接成因。需在原文加 `[HISTORICAL]` 标注并指向本文档 |
| `docs/page-design/archive/v3/coding-plan-quota/design.md:322`「仅在 provider 命中 QUOTA_PRESETS 时显示」 | **已失效**：实现早已改为始终显示（`CodingPlanSection.vue:15` 注释），本次采纳用户决策「所有 provider 都显示，未选类型时只渲染类型下拉 + 一句说明」（D8）。需回写原文标注 |
| `docs/page-design/archive/v3/coding-plan-quota/design.md:340`「api-key 类凭证复用上方的 API Key 输入框」 | **部分推翻**（D3）：继承仍然成立，但从隐式约定改为显式的「凭证来源」选择，且该选择持久化 |
| `docs/page-design/archive/v3/coding-plan-quota/design.md:382` footer「配置」按钮跳转 Settings | **本次补齐**（D11）：原文只描述了未配置态的实现，失败态同样需要该入口 |
| `provider-config-helper.ts:991-992`「禁止恢复经 setProvider 写 models.json quota」 | **遵守**（D10） |
| `provider-config-helper.ts:1256` M5-05「同 id 重建不静默继承旧配置」 | **补齐漏网面**（D12）：quota 的 secrets 文件此前不在清理范围内 |

## 附录 B：交互原型

四个候选方案的可点原型（含固定状态画廊）：

- `docs/design/coding-plan-quota-ux.demo-a.html` — 平铺 + 双按钮
- `docs/design/coding-plan-quota-ux.demo-b.html` — 平铺 + 单按钮「保存并测试」（**本文档实现的就是它**）
- `docs/design/coding-plan-quota-ux.demo-c.html` — 分步引导
- `docs/design/coding-plan-quota-ux.demo-d.html` — 摘要 + 折叠编辑

共享 `coding-plan-quota-ux.demo.css`（对齐 `docs/page-design/design-tokens.md` 的玄·暗 tokens）与 `coding-plan-quota-ux.demo.js`。

> **原型与本文档的关系（v2 修订）**：`demo.js` 的 `Q.readiness()` 是**不含凭证来源维度的并集版**，服务于没有分段控件的方案 A/C/D；**方案 B 的 source 感知版实现在 `demo-b.html` 内联的 `readiness()`**，它包含「`credentialSource` 分支」。两者都已同步：类型只进草稿、`typeChanged` 归属过滤、workspace 判定只看草稿（D13）、凭证类字段取并集。**原型的三处已知局限**（前两处在 `demo-b.html` 的说明区已就地标注）：
> 1. 原型用的是**原生 `<select>`**（重复点选同一项不触发 `change`），而真实实现是 reka `Select`（同值也 emit）。所以 §7.2 细节 2 的同值短路守卫在原型里**测不出来** —— 实现时必须落在值上。
> 2. 原型尚未包含 `savedFetcher === undefined` 不算类型已变这条边界（§7.2 细节 1）。
> 3. 原型的类型切换会把 **Workspace 草稿一并清空**（`demo-b.html:203`），v4 已修订为「只清凭证草稿、Workspace 不清」（§7.2 细节 2）—— 原型未跟进此修订，实施以文档为准。
>
> 实施时以 §7.2 的文字规则为准；原型用于对照交互形态，不是判定的 SSOT —— 差异点已在此显式登记，避免实施者照抄原型导致 D3/D5 静默退化。

## 附录 C：变更历史

- v1（2026-09-10）：首版。四个交互方案对比（demo 驱动）后选定方案 B；11 个决策；9 个验收场景（4 个反向）；6 个拆分单元。
- v2（2026-09-10）：第一轮对抗式审查后修订（主审 4 must-fix + 5 suggestion，影响面审 6 must-fix + 4 suggestion，共 10 must-fix / 9 suggestion 全修）。关键变更：①D3 从「事件语义的清除」改为**凭证来源持久化 + runtime 共同遵守**（消除新发现的失败模式 D「界面说用 A、实际用 B」）；②D5 从「类型即时落盘 + 同值守卫」改为**类型进草稿 + 凭证归属规则**；③新增 D11（浮层失败态恢复入口）、D12（补齐 quota 清理通道，对齐 M5-05）、D13（Workspace 判定规则）；④补充写入面穷举（16 项）与 runtime 删除顺序/失败语义；⑤M0/U1 纳入穷举映射点；⑥验收场景 9 → 14。
- v3（2026-09-10）：第二轮聚焦复审后修订（主审 2 must-fix + 5 suggestion，影响面审 2 must-fix + 6 suggestion，共 4 must-fix / 11 suggestion 全修）。关键变更：
  - **补齐 `credentialSource` 的端到端传递链**（§7.5 新增 `protocol.ts` / core `domains/quota.ts` / runtime `quota-message-handler.ts` 三处；新增「新参数端到端链」清单）。其中 **runtime handler 漏改不报错、只静默丢字段** → `providers.json` 永不写该字段 → 两端退回推断 → 失败模式 D 原样复现，只有 S9 能发现。这是 v2 最大的漏洞。
  - **「切换类型清空草稿」补同值短路守卫**（守卫落在值上而非事件上）；S8 改为必须带未提交草稿的前置（原写法测不出该 bug），并新增 S16（改类型再改回）。
  - **撤回「`providerExists` 检查提前」**（v2 引入、反而拉大了 TOCTOU 窗口）：改为移进 `extrasStore.modify` 回调（同锁串行），并显式登记 persist→secrets 之间的残余竞态窗口。
  - **D13 改为「Workspace 判定只看草稿」**：v2 的并集写法会让用户清空后按钮仍亮、保存又被回填，产生视觉矛盾。
  - **`typeChanged` 补 `savedFetcher !== undefined` 边界**：避免「无历史归属」的 provider 被误判类型已变而触发一次用户从未请求的删除。
  - **D12 补「已知代价」量化 + 组合根后置回填说明**（漏回填不报错、D12 静默失效）。
  - 杂项：`no-credential` 的 cookie 文案变体、`__CLEAR__` 哨兵判定、`readiness` 第四态显式命名、写入面表补 `quota-cache.json.tmp` 与新增清理通道、6 处行号纠正、验收场景 14 → 16。
- v4（2026-09-10）：第三轮聚焦复审后修订（主审 1 must-fix + 4 suggestion，影响面审 1 must-fix + 5 suggestion，共 2 must-fix / 9 suggestion 全修 —— 两个 must-fix 同根因：类型切换清空草稿误伤 Workspace）。关键变更：
  - **类型切换只清凭证草稿，Workspace 不清**（§7.2 细节 2 / D13 / S16 补 opencode 变体）：Workspace 是明文回显字段，清它只制造「磁盘有、屏幕无」—— opencode 用户类型往返后按钮永久置灰、被迫重贴还在的 wrk_ 地址。
  - **`quota.configure` 收敛为单一 `QuotaConfigurePayload`**（§7.1）：7 位置参数中 4 个同构 `string | undefined` 互相错位编译器不报错（v3 端到端链断裂正属此族）；收敛后 handler 整对象透传、忘改 handler = 参数数编译错，v3 链上唯一「不报错、静默丢字段」的段结构性消除。分期兼容：M0 类型 → M1 service+handler（wire 兼容）→ M2 core+mock+renderer 原子切换。
  - **删除链排序约束**（改动 5 / D12 代价）：`clearProviderState` 只在 `cleanProviderExtras` 成功后执行，D12 部分失败不再产生幽灵标记；残余两方向（一致残留 / 惰性孤儿文件）按四要素登记，孤儿惰性判据写入改动 2/5。
  - **新增改动 6**：`credentialSource` 落盘走 `inheritQuotaField` 继承链，写侧禁用 `resolveQuotaCredentialSource` 推断（否则 `setEnabled` 会把用户显式选择覆盖成推断值）。
  - **`QuotaCache.removeEntry` 三条语义写死**（改动 4）：`writeChain` 串行 + `memoryCache` 同步删 + 幂等，缺任一条都会被磁盘重载或并发写还原。
  - **M1 分段验收改为可执行形式**（§7.5）：v3 的「M1 期一次保存并测试后读 `providers.json`」在 M1 跑不出真值（renderer 未切换），改为 runtime 单测直调 `QuotaService.configure` 断言落盘与继承链。
  - 其余：数据流图路径纠正（providers.json 在 `<dataDir>/pi/agent/config/`，非系统 pi 的 `~/.pi/agent`）；表 A 四格清理通道与正文对齐（#4/#5/#8/#10/#11）并删 §7.1 缓存表冗余行；§11 检查点 5 补可执行差集判据；mock 签名同构入文件地图；字段级提示渲染改显式白名单（让 `'type'` 不配文案成为结构保证）。
- v5（2026-09-10）：第四轮聚焦复审后修订（主审 0 must-fix + 1 suggestion，影响面审 1 must-fix + 4 suggestion，全修）。关键变更：
  - **在途写回守卫**（改动 4，影响面审 must-fix）：`doFetch` 发起时捕获 `fetcher.id`，写缓存三件套（`cache.update` / `lastFailure` / `lastFetchTime`）前与当前归属比对，不一致全部丢弃并返回空结果 —— 堵住「删除之后才落地的写」：hover 在途的旧类型 fetch 在 configure 换类型后落地，会把旧类型行写回缓存且无 reason、以新类型标签展示。per-provider 代次计数器记入被否（类型错标才是要防的伤害，代次多带一份状态却不增加防护）。
  - **删除链钩子落点三处写明**（改动 5）：`deleteProviderImpl` 尾 + `removeProviderByKindImpl` 的 catalog / custom 两分支尾；全仓核实无第三条删除路径（`extrasStore.delete` 仅 `cleanProviderExtras` 内部调用）。
  - **`unauthorized` 补 cookie 变体**（§5.2 路径 3）：「发起对话刷新 OAuth」对 cookie 用户是不存在的动作；变体同时是孤儿 cookie 残余（改动 2 反向残余）的可诊断出口。
  - **半提交连带登记**（改动 2）：unlink 失败 → `{ok:false}` 不广播但 persist 已提交 → 重试期屏幕快照滞后于磁盘；方向安全（`typeChanged` 判真偏保守）+ 重贴自愈；「失败也广播」记入被否（广播会重置草稿，对校验类失败无谓清掉用户输入）。
  - 杂项：handler 透传前保留 [W3] `providerId` 防御校验；mock 同构表述改「项目约定而非编译强制」；`mock-domains.test.ts` 入测试清单（不在编译门内，签名切换后旧断言是类型坏 + 假绿双隐形）；§7.1 时序约定 2 的输入丢失条款补 Workspace 草稿。
- v6（2026-09-10）：第五轮聚焦复审后修订（影响面审 1 must-fix + 3 suggestion，全修；主审 r4 已 0 must-fix 无新增）。关键变更：
  - **在途守卫两条条款落地化**（must-fix + suggestion 1）：① `lastFetchTime` 现行在 `doFetch` **开头**写入（[W5]），末尾守卫撤不回——把写点**后移进守卫后的收尾区**，节流锚点从「发起时刻」改「完成时刻」（在途期间由 pending 复用去重，窗口拉长一个在途时长，无害）；失配补 `delete` 的补偿写记入被否（两处写点顺序依赖，比单一写点脆弱）。② 失配返回 `this.getCached(providerId)` 而非手工空对象——无 reason 的 `{data:null}` 会被 `useQuotaQuery` 成功分支当数据写进 store、覆盖刚落地的新类型行并清掉诊断态。
  - **三级滞后终态改正**（suggestion 2）：unlink 失败方向文件仍在且有效，重试期改回旧类型再保存后 fetch 会**成功**——终态是「标记 false + 有效文件」的**反向幽灵**（矛盾展示，非错误数据）；v5 的「靠 no-credential 兜底」混淆了 unlink 失败与 write 失败两个方向，后者才归 no-credential。
  - **删除链排序的测试落点**（suggestion 3）：`provider-config-helper.test.ts` 补三用例（extras 删失败主流程仍成功 + secrets 保留 / extras 成功 + cleaner 失败 warn-only 孤儿 / 三落点各一条）——排序逻辑在 helper 层，quota-service 测试覆盖不到。
  - 杂项：§7.5 provider-config-helper 行与改动 5 的「三落点 + 符号锚」措辞同步。
- v7（2026-09-10）：第六轮聚焦复审后修订（影响面审 1 must-fix + 2 suggestion，全修；主审 r4 起 0 must-fix）。关键变更：
  - **`lastFetchTime` 后移的出口覆盖声明**（must-fix）：`doFetch` 有五个出口，今天的开头一次性写覆盖全部（**失败也节流**——表 A #13「每次一条 warn」的速率前提）。后移后 `set` 落在守卫通过后的其余全部出口，**不写的只有失配与 `!fetcher` 早退两个出口**；只放成功路径旁会让持续失败的 provider 失去节流、请求与日志速率无上界。测试补「`fetchFailed` 后 10s 内第二次 hover 不再发真实请求」。
  - **失配返回的两种时序登记**：晚于新 refresh → 读到新行正向；早于 refresh 的窗口 → 一跳「暂无数据」、下一 hover（不被压制）自愈；`saveAndTest` 的 refresh 走设置页本地态不写 store。
  - **三级滞后变体补重审触发条件**：出现「未配置标记 + 查询成功」矛盾反馈时，半提交改「unlink 失败时把 `cookieSet` 一次性回写实际文件状态」（区别于已否决的常驻读侧校正）。
- v8（2026-09-10）：第七轮聚焦复审后修订（影响面审 **0 must-fix** + 2 suggestion，全修——两份报告自此均 0 must-fix）。关键变更：
  - **出口覆盖三处精度修正**：①消同段自相矛盾（「唯一不写者」×「`!fetcher` 早退豁免」并存）→「不写的只有失配与 `!fetcher` 早退两个出口」；②豁免显式声明为行为变更（现状该出口也被节流；量级 = 2 次小文件读盘 + `matchQuotaPreset`，hover 事件 + `markPending` 双重有界）；③五出口收口为单一收尾 helper——新出口不经 helper 即不写，结构可见而非清单纪律（与整对象透传、字段白名单同一手法）。
  - **改动 3 片段补 try/catch 异常降级**：`resolveCredential` 在 `doFetch` 的 try 之外，照抄裸调用会让 resolver 异常逃逸成 RPC 无响应（backstop 超时，比 `no-credential` 难诊断）；§3.2 现状片段同步补齐。
  - 杂项：provider-config-helper 四处行号随并行工作流落地刷新（`:1239-1263` / `:1265-1278` / `:1383`·`:1386`·`:1395` / M5-05 `:1256`）。
