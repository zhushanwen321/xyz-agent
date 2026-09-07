# 超时普查卫生批次设计：附赠发现 #1-4（opencode workspace / engine+model 错配 / tarball stall / trash 降级）

> **一句话结论**：超时普查附赠的 4 条独立正确性缺陷，各用最小独立方案修复——opencode workspace 从硬编码改为用户配置（未配置明确报错，绝不查他人数据）、subagent 派发把 model 校验时机改到引擎路由之后并按目标引擎校验（错误消息明确「引擎与模型不配套」）、tarball 下载补 60s 无进展 stall 兜底（触发即 network 错误可重试）、trash 超时不再降级永久删除（失败保留文件 + 报错，active/scanned 两形态恢复语义显式设计）。

**层声明**：当前层 = 技术方案；下一层 = 实现任务单元。本批 4 项相互独立的小修，结构采用：共用 §1 背景目标 + §2 各项现状 + §3 每项独立方案对比 + §4 每项独立验收 + §5 统一拆分表。每项仍完整走「现状（代码证据）→ 方案对比 ≥2 → 验收真实场景」。

## 开篇（SCQA）

- **S（情境）**：2026-09-04 全项目超时普查（SSOT：[timeout-audit-2026-09.md](timeout-audit-2026-09.md)）在超时主题外附赠 5 条非超时类发现，其中 4 条归本文档（#5 plugin-host Worker/fork 不对称已归 Doc 3 `timeout-plugin-service-granularity.md`，本文只做指针不重复设计）。
- **C（冲突）**：这 4 条都不违反超时规则 19，但全是正确性级缺陷——**查别人的数据**（opencode 硬编码 workspace）、**误导性失败**（engine+model registry 错配，普查当日两种形态各炸一次）、**无声挂死**（tarball 下载无 stall 兜底）、**数据丢失**（trash 超时降级永久删除）。
- **Q（问题）**：四个分属不同子系统的独立缺陷，各用什么最小方案修复？验收各自怎么证明？
- **A（答案）**：逐项「现状 → ≥2 方案对比 → 决策」；每项独立验收，统一拆分为 4 个可独立交付的实现单元。

---

## 1. 背景：被设计的系统与四个缺陷

**本章结论**：四个缺陷分属 xyz-agent 的四个独立子系统（额度查询 / subagent 派发 / npm 安装器 / 文件删除），共同点是「普查顺手抓出的正确性欠账」，相互无依赖，可并行修复独立验收。

### 1.1 系统是什么

xyz-agent 是 Electron + Vue 3 的 AI Agent 桌面工作台：Electron 主进程管理窗口与 runtime 子进程，runtime（Node.js WebSocket 服务）承载会话/配置/安装等业务，pi CLI 作为 agent 引擎。本设计涉及四个子系统：

- **额度查询（quota）**：用户在 Settings 为 Coding Plan provider（如智谱/kimi/opencode）配置凭证（API key 或 cookie），悬停 provider 时 runtime 拉取该平台的套餐额度并展示进度。每个平台一个「fetcher」（可插拔查询器，注册表 `QUOTA_FETCHERS`）。
- **subagent 派发**：主 agent 通过 `subagent` 工具把子任务委派给子 agent。子任务可指定执行引擎（`engine` 参数：`pi` 缺省 / `zcode` 桌面端引擎）与模型（`model` 参数）。每个引擎有自己的模型注册表（registry）——pi 的 registry 来自 pi 三源合并，zcode 的来自 `~/.zcode/v2/config.json`（ZCode 桌面登录态）。
- **npm 安装器（npm-installer）**：runtime 纯 Node 实现的 npm 包下载安装（registry 元数据 → HTTP 下载 tarball → gunzip 解压），服务于插件安装与用户 extension 安装，不 spawn npm CLI。
- **文件删除（trash）**：删除 session 文件时优先移入系统废纸篓（macOS 经 `trash` CLI 或 Finder AppleScript），失败时降级。

### 1.2 设计目标（从使用者体验倒推）

1. **G1（opencode）**：用户配置自己的 opencode 凭证后，看到的额度**只可能是自己账号的数据**；未配置 workspace 时得到明确的「未配置」指引，而不是别人的数字或莫名报错。
2. **G2（engine+model）**：agent 派发 subagent 时，`engine` 与 `model` 的任何组合要么成功执行、要么在派发同步期报出**指明引擎与模型不配套**的错误（含目标引擎可用清单与修正动作），绝不出现「校验通过但执行必炸」或「合法派发被误导性拒绝」。「派发」按 §2.2 定义覆盖 **chat 工具与 workflow 两条路径**，两路径同等满足。
3. **G3（tarball）**：tarball 服务器中途停发数据时，安装操作在有限时间内**报出可重试的 network 错误**，而不是永久挂死。
4. **G4（trash）**：用户删除 session 时，文件**要么进废纸篓要么留在原地报错**——任何系统状态下都不会被静默永久删除。

### 1.3 Scope

**In-scope**：上述 4 项各自的修复方案、错误消息设计、验收与拆分。
**Out-of-scope**（显式声明，防蔓延）：
- 附赠发现 #5（plugin-host Worker/fork 超时后行为不对称）——归 Doc 3。
- opencode 自动发现 workspace 的 API 探测**只登记为实施期探针**，不承诺实现（见 D1-1）。
- trash 的非 macOS 分支（Linux 无废纸篓尝试、直接 unlink）保持现状——xyz-agent 主平台是 macOS，Linux 分支改动无验收环境。
- trash 的路径注入硬化（`"${filePath}"` 未转义）——独立问题，本文不处理。
- subagent 的 `<available_zcode_models>` 注入策略调整（defaultEngine 门控）——已有用户拍板决策（2026-08-25），本设计只在错误消息侧闭环（见 D2-4 被否栏）。

---

## 2. 现状与问题分析（四项）

### 2.1 opencode：所有用户在查同一个 workspace 的额度

**本节结论**：opencode fetcher 把开发期测试用的 workspace id 烤死在 URL 常量里，任何用户配置自己的 cookie 后查到的都是那个 workspace 的数据——错误数据 + 开发依赖两大问题。

先定义两个术语（后文反复使用）：

> **workspace** = opencode 平台上套餐额度的归属单位（id 形如 `wrk_01KM5Q3E...`）。opencode 的额度页面按 workspace 维度组织——**同一 cookie（账号）可以有多个 workspace**，额度数据挂在具体 workspace 下。这就是 §2.1 例子里 URL 中间那段。
>
> **SSR HTML 解析** = opencode 的额度页不是 JSON API，而是服务端渲染的 HTML 页面，数据以 `rollingUsage:$R[n]={...}` 形式嵌在页面源码里，fetcher 用正则抠出来。

**现状链路**（代码证据，行号已实地核对）：

```
用户在 Settings 配置 cookie（quota-service.ts:231 configure）
  → cookie 落盘 <dataDir>/secrets/<providerId>-cookie.txt（:258）
  → hover 触发 quota.fetch RPC → QuotaService.doFetch（:379）
  → opencodeFetcher.fetchQuota(cookie, 'cookie')（opencode.ts:53）
  → fetch('https://opencode.ai/workspace/wrk_01KM5Q3EEQEHZJ3V5PXF5JCR62/go')（opencode.ts:60 ← 🔴 硬编码）
  → 302 = cookie 过期 → unauthorized（:66）；HTML 三窗口解析失败 → no-subscription（:76）
```

- 硬编码 URL 在 `packages/runtime/src/services/quota-providers/opencode.ts:60`，自 fetcher 诞生（commit `56c6e00f3`，2026-07-25）就在——是开发期测试 workspace 残留，从未参数化。
- 对照同目录其余 4 个 fetcher：kimi/mimo/minimax/zhipu 的接口都是**账号维度**（cookie/api-key 本身决定账号，URL 与用户无关，`FETCH_TIMEOUT_MS=5000` 各自定义于 kimi.ts:12 / mimo.ts:14 / minimax.ts:15 / zhipu.ts:12）。opencode 是唯一**资源维度**（需要 workspace id）的 fetcher，而 fetcher 接口没有给它传递这个信息的通道——`ProviderQuotaFetcher.fetchQuota(credential, kind)` 只有凭证参数（`packages/shared/src/quota-types.ts:52-67`）。

**真实失败模式**：

- **F1-A（错误数据，最高危 🔴）**：用户 A 配置自己的 cookie，hover opencode provider → 查到的是开发者测试 workspace 的三窗口额度——**数字是别人的**。若该 workspace 套餐规格与用户不同，用户据此误判自己的用量。
- **F1-B（开发依赖）**：该测试 workspace 被删除/失效的那天，全体 opencode 用户同时开始报 `unauthorized`（302）或 `no-subscription`（页面无数据），无人能通过重新配置凭证自愈——因为病根不在凭证。

**根因**：workspace id 是 **per-account 资产**（每个用户自己的 opencode 账号下才有意义），却被写成了**全局常量**；且 fetcher 接口设计时只预留了凭证通道，没有配置通道——不是「值写错了」而是「值的来源通道缺失」。

### 2.2 subagent 派发：model 校验源与执行引擎错配

**本节结论**：派发链路对 `model` 参数的校验固定用 pi registry，且时机在引擎路由**之前**——导致 zcode 合法模型被误导性拒绝（形态①）、pi 模型过校验后到 zcode 执行期才炸（形态②）。普查当日两种形态各实测炸过一次（总报告 §4 #2）。

> **registry（模型注册表）** = 「这个引擎认识哪些模型 id」的清单。pi registry 三源合并（含 `zai-coding-cn/glm-5.3-flash` 这类 id）；zcode registry 来自 `~/.zcode/v2/config.json`（含 `builtin:bigmodel-coding-plan/GLM-5.3-Flash` 这类 id）。**两套 id 空间互不认识**。
>
> **派发** = agent 调 `subagent` 工具发起子任务（chat 工具路径），或 workflow 脚本调 `agent()`（workflow 路径）。

**现状链路**（chat 工具路径，证据 `packages/subagent-core/src/execution/subagent-service.ts`）：

```
subagent tool execute(opts)                    opts = {task, engine?, model?, ...}
  ① :850  resolveIdentity(opts)                ← 🔴 先做 model 解析
        → execution/model-resolver.ts:114 三层解析（override > agent.md > 主 agent model）
        → override 路径经 assertCanonicalModelRef 对【pi registry】全等裁决
          （shared/model-ref.ts:200）
        → 未命中抛: "Model X is not a registry entry ... Or omit the `model` param
          to inherit the main agent model"（:200,:232）
  ② :867  routeEngine(routing)                 ← 引擎路由在【后】
        三层: 调用参数 engine > agent .md frontmatter > config.json defaultEngine
        + probe 探活 + fallback 三守卫
  ③ :876  executeViaEngine → engine/host-task-spec.ts:33  model: opts.model（原样字符串透传给引擎）
  ④ zcode 引擎 engine/engines/zcode/zcode-engine.ts:397 resolveZcodeModelRef(task.model)
        → 对【zcode registry】（v2 config 带凭据 provider）校验
        → 失败抛 ZcodePrepareError[model_not_available]（preparer.ts:178 起）
```

workflow 路径（`execution/subprocess-agent-runner.ts`，下称 SAR）：run() 自带路由编排（:143 起），路由通过后非 pi 引擎在 :226-229 **直接 `route.engine.run(taskSpec)`**——既不经 subagent-service.execute()，也无任何 model 校验调用点；model 错误只能落在 engine.run 内部的 zcode prepare 期（已过 probe、journal 写入、并发池 acquire），以 errorResult（SAR「不 reject」契约）返回。即两条路径只是**路由时机**对齐、**校验覆盖**不对齐——workflow 域的 F2-B 形态（`agent({engine:'zcode', model:<pi id>})` 或 defaultEngine=zcode + pi id）现状无人修。

配套的可发现性注入：`<available_provider_models>`（pi 段，教育 agent 用这些 id 派发）恒注入；`<available_zcode_models>`（zcode 段）**只在 defaultEngine≠pi 时注入**（`model-prompt.ts`，调用点 `extensions/universal/subagent-workflow/src/index.ts:662-663`）。

**真实失败模式**（普查当日均实测复现）：

- **F2-A（形态①：合法派发被误导性拒绝）**：defaultEngine=zcode 的用户（或显式传 `engine:'zcode'`）按系统提示里 `<available_zcode_models>` 的 id 派发（如 `builtin:bigmodel-coding-plan/GLM-5.3-Flash`）→ ①处 pi registry 裁决未命中 → 报 `Model "builtin:..." is not a registry entry`，且建议「omit the model param to inherit the main agent model」——**对 zcode 引擎这是错误指引**（zcode 不消费主 agent model，省略后落 zcode 自己的缺省模型，preparer.ts 注释与 `warnIgnoredCtxModel` 自证）。合法派发被拒 + 恢复指引指向歧途。
- **F2-B（形态②：校验通过但执行必炸）**：defaultEngine=pi 的用户按调用参数 `engine:'zcode'` 派发，但上下文里只有 pi id 清单（zcode 段未注入）→ agent 传 pi id（`zai-coding-cn/glm-5.3-flash`）→ ①处 pi registry 校验**通过** → ②③④ 流转到 zcode prepare 期才发现 provider 不存在 → `ZcodePrepareError: 未知 provider "zai-coding-cn"`。失败来得晚（已过 probe、并发池 acquire），且文案不解释「你把 pi registry 的 id 用在了 zcode 引擎上」——用户以为模型配置坏了去查 models.json，方向全错。

**根因**：双重错配——**校验源错配**（model 校验固定用 pi registry，而执行引擎各有自己的 registry）+ **校验时机错配**（identity 解析在引擎路由之前，路由层注释自认「路由层无各引擎 provider 注册表的访问面，精确可解析性判定归引擎 prepare 期」，engine/routing.ts:159-162）。接口上 model 参数是引擎中立直译（host-task-spec.ts），校验却是 pi 单源——中立通道接了单源校验。

### 2.3 npm-installer：tarball 下载 header 之后零兜底，stall 即永久挂死

**本节结论**：下载管线只给「等 header」设了 60s 超时，header 到达后 body 读取与流式解压全无兜底——服务器停发 body 时 `downloadAndExtract` 永久 pending，安装挂死不报错。这是「该有兜底处缺兜底」，与普查主方向的误杀相反。

**现状管线**（证据 `packages/runtime/src/infra/installers/npm-installer.ts`）：

```
httpGet(url)                     :122  timer(:127) 在【header 到达】即清(:132)
  ↓ res
followRedirects                  :146  最多 5 跳，每跳重走 httpGet（同样只保 header）
  ↓ final（http.IncomingMessage）
fetchJson（registry 元数据）      :166  ✅ 有 bodyTimer(:180) 先例——注释明言
                                       "服务器发了 header 后 stall 不发 body 会永久 pending"
downloadAndExtract（tarball）     :308  🔴 无任何 timer：
  ├─ integrity 路径 :340-346     buffer promise 只有 data/end/error 监听
  └─ 流式路径     :355-357     final.pipe(gunzip) → extractTarStream(:289) 无超时
        ⚠ 流式路径两附加事实（实测，D3 修订基础）：① final 无任何 on('error')
          且 pipe 不转发源侧错误——中途断流（ECONNRESET）现状即未处理 'error'
          事件（ERR_UNHANDLED_ERROR，进程级风险）；② pipe 背压会 pause final
          ——final 的 data 事件被解压速度门控（见 D3-1 刷新点修订）
```

调用方（用户可见后果）：
- 插件安装：`plugin-installer-adapter.ts:37` → `downloadPackageTarball` → 挂死 = 插件安装永久 pending。
- extension 安装：`npm-git-installer.ts` 委托 `installPackage` → 同管线 → extension 安装挂死。

**真实失败模式**：registry CDN 或代理在发出响应头后断流（半开连接/中间设备故障——不是纯理论：fetchJson 当初加 bodyTimer 正是为这个场景，tarball 路径漏掉了）→ `downloadAndExtract` 的 buffer/pipe promise 永不 resolve → 安装 UI 一直转圈，无错误、无超时、无法重试。用户唯一出路是重启应用。

**根因**：`DEFAULT_TIMEOUT=60s`（:23，注释「对齐 npm `fetch-timeout` 默认 60s」）的覆盖面止步于 header 阶段；tarball 路径与 fetchJson 的 body 阶段同构却没有复刻 bodyTimer，且流式路径的兜底从未设计。

### 2.4 trash：5s 超时把「进废纸篓」静默降级为「永久删除」

**本节结论**：macOS 删除链路在 trash 命令 5s 超时/失败后 catch 降级 `unlinkSync`——把用户预期的可撤销操作静默变成不可逆删除，属数据丢失级降级语义错误。

**现状链路**（证据 `packages/runtime/src/infra/system/trash.ts` + `packages/runtime/src/services/session/session-lifecycle.ts`）：

```
用户在侧栏删除 session（单个）或 folder 删除（deleteByCwd :577-598 循环调 delete）
  → session-lifecycle.ts delete()（:547-560）两分支，trash 在两分支中的位置【不同】：
      active 分支: detachSession → destroySession(进程销毁) → removeSessionEntry(列表移除)
                   → purgeActiveSessionFile(:499 trash + sidecar 清理)
      scanned 分支: trash(:543) 是【第一步】→ purgeSessionSidecars
  → trash.ts:14  execSync(`trash "path" || osascript -e 'tell Finder to delete ...'`,
                    { timeout: 5000(:16), env: buildOutboundChildEnv(:19，C-proc-09) })
      ├─ 成功 → 进废纸篓 ✅
      └─ 超时/失败 → catch(:23) console.error(:24) → unlinkSync(:27) 🔴 永久删除
```

**调用方清单**（trash 改 throw 的影响面，三处）：① `:499` active 分支（purgeActiveSessionFile 内）；② `:543` scanned 分支；③ `deleteByCwd`（:577-598，folder 删除按钮）——已有 per-item try/catch 聚合 `deleted/failed[]`，trash throw 后批量语义天然自洽（失败项进 failed[]，前端可见），**无需改码**。

**真实失败模式**：Finder 繁忙（用户开着 Finder 对话框、系统高负载、AppleScript 响应慢）时 `osascript` 超过 5s → execSync 抛超时 → catch → **session 文件被 unlinkSync 不可恢复删除**。用户视角：「删到废纸篓」是可撤销操作（误删还能捞回来），静默永久删除违背预期且不可逆。session 文件含完整对话历史——这是数据丢失级后果。

**根因**：降级分支把「辅助手段失败」当成「原操作失败」处理——正确语义应是**操作失败并保留原状**，而不是换一个语义更强的手段（永久删除）硬完成。超时 5s 本身合法（控制面单命令秒级），错在触发后的行为设计。

---

## 3. 解决方案（四项独立）

### 3.1 opencode workspace 来源：用户配置 + 未配置明确失败

**本节结论**：workspace 来源采用**用户配置**（quota 配置通道扩展，与 cookie/apiKey 同构）；未配置时返回可区分的 `not_configured` 失败（不 fallback 通用页、不静默返回缓存）；硬编码 URL 删除不留任何 fallback。

#### 3.1.1 终态（使用者视角）

**成功路径**：

```
[用户] Settings → 模型与额度 → provider "my-opencode"
       凭证: cookie=<自己的 cookie>
       Workspace 地址: https://opencode.ai/workspace/wrk_自己账号的id/go   ← 新增输入项
[用户] 保存 → hover 该 provider
[系统] 用自己的 cookie + 自己的 workspace URL 抓取 → 展示自己账号的三窗口进度
       （数值与用户浏览器打开同一 URL 看到的一致）
```

**失败路径（未配置）**：

```
[用户] 只配了 cookie 没配 workspace → hover
[系统] 额度区显示失败态：未配置 workspace（不发任何请求）
       👉 打开 opencode.ai 控制台，从浏览器地址栏复制 workspace 页 URL，
          填入 Settings → 该 provider → Workspace 地址后重试。
```

#### 3.1.2 方案对比

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A. 用户配置**（quota 配置通道扩展：providers.json 增 workspace 字段，Settings 增输入框，fetchQuota 增可选配置参数） | ✅ workspace 是账号资产，用户可见可管理；与既有 cookie/apiKey/fetcher 配置同构；接口扩展方向与「Phase 2 plugin 化」预留一致 | 中：跨 3 层（shared 协议+类型 / runtime service+fetcher / renderer UI） | 低：用户需一次性复制 URL（恢复指引覆盖） | ✅ **选** |
| B. 自动发现（fetch 前先探测 workspace 列表 API，取第一个） | UX 最好（零配置）；但依赖未文档化内部 API，SSR 站点接口随时变 | 高：探测+解析+失败回退全套逻辑 | 高：接口一变全体挂（重演 F1-B 的集中故障）；未证实存在即不可依赖 | ❌（登记为实施期探针，证实后可作 A 之上的增强） |
| C. cookie/登录态推导（从 cookie 串解析 workspace id） | cookie 通常只含会话 token 不含业务资源 id | 低 | 高：即便某版本 cookie 含 id，语义也无契约保证，平台改 cookie 格式即全体挂 | ❌ |
| D. 未配置时 fallback 通用页（如 opencode.ai 首页） | 通用页无 workspace 维度 SSR 数据，必 parse 失败——等于把「未配置」伪装成「解析失败」，不可诊断 | 低 | 高：错误归因被污染 | ❌ |

**被否反演**：若用 B——探针证伪（API 不存在/不稳定）后代码进退两难；若用 C——cookie 推导失效时 §3.1.1 成功路径变成随平台 cookie 格式漂移的时好时坏；若用 D——§3.1.1 失败路径显示 `parse` 失败，用户去检查 cookie（方向错，病根是没配 workspace）。

#### 3.1.3 关键决策

**D1-1：workspace 来源 = 用户配置（方案 A），自动发现只登记探针（选定）**
- **采用**：Settings 为 opencode-go fetcher 增加「Workspace 地址」输入（接受完整 URL 或 `wrk_...` id，两者都归一化存储）；持久化进 providers.json 的 quota 配置块。
- **被否**：B/C/D（见上表）。
- **证据**：接口无配置通道（quota-types.ts:52-67）；cookie 类配置先例（quota-service.ts:231 configure / :258 cookie 写入）；其余 4 fetcher 均账号维度无需配置（§2.1）。
- **效果**：G1 成立——数据只来自用户自己的 workspace。
- **探针**：⛔ P1-2（实施期）：用真实 cookie 探测 opencode 是否存在稳定的 workspace 列表端点（如 `GET /api/workspaces` 或首页 SSR 中的 workspace 数据）。**降级路径**：探针失败 → 维持方案 A（纯配置），零损失——A 不依赖 B 成立。

**D1-2：fetcher 配置注入 = `fetchQuota` 增加第三个可选参数（选定）**
- **采用**：`ProviderQuotaFetcher.fetchQuota(credential, kind, config?)`，`config` 为 per-provider 只读配置（首期仅 `workspaceUrl?: string`）；QuotaService.doFetch 从 providers.json 读出后注入。其余 4 个 fetcher 忽略该参数（签名可选，零改动面）。
- **被否**：①「fetcher 自行读文件」——fetcher 当前无 IO 依赖（只有 fetch+logger），自行读盘破坏可插拔边界与可测性；②「工厂模式按配置构造 fetcher」——重构面大于问题本身（准则 8 减法）。
- **证据**：接口注释已预留 plugin 化（quota-types.ts:51「可插拔」）。
- **效果**：§3.1.1 成功路径的数据来源通道成立。

**D1-3：未配置默认行为 = 可区分失败 `not_configured`，不请求不发数（选定）**
- **采用**：`QuotaFetchFailureReason` 增加 `'not_configured'`（shared 类型 + renderer 失败态映射文案 + 恢复指引）；opencode fetcher 在 workspace 缺失时直接返回 `{ok:false, reason:'not_configured'}`，不发 HTTP。
- **被否**：①「静默返回缓存」——用户拿旧数据/空数据且无感知（resolveCredential 凭据缺失就是这个语义，对 cookie 尚可接受、对必填配置是掩盖）；②「fallback 通用页」（方案 D）；③「沿用 `parse`」——归因错误，恢复指引无法指向「去配置」。
- **证据**：reason 可区分是既有设计原则（quota-types.ts:42「可区分——恢复指引」）。
- **效果**：§3.1.1 失败路径成立；G1 的「未配置得到明确指引」成立。

**D1-4：硬编码 URL 删除，无任何残留 fallback（选定）**
- **采用**：`opencode.ts:60` 的 URL 常量整体删除，URL 由配置拼接；仓库内 `grep wrk_01KM` 归零。
- **被否**：「保留硬编码作为未配置时的缺省」——修复后仍有用户查开发者 workspace（F1-A 不除根）。
- **证据**：F1-B（开发依赖集中故障）。
- **效果**：G1「只可能是自己账号的数据」由构造保证（by construction）。

---

### 3.2 subagent 派发：路由先行 + 按目标引擎校验 model

**本节结论**：把 chat 路径的 model 校验时机移到引擎路由**之后**、校验源改为**目标引擎的 registry**（EnginePort 新增可选 `validateModel` 面，zcode 复用 preparer 既有校验），pi registry 未命中时跨引擎给出纠错候选——两个失败形态同步消灭，错误消息指明「引擎与模型不配套」。

#### 3.2.1 终态（使用者视角，三场景）

**场景 1（原 F2-A，修复后成功）**：

```
[agent] subagent start {task:"...", engine:"zcode", model:"builtin:bigmodel-coding-plan/GLM-5.3-Flash"}
[系统] 路由 → zcode → 按【zcode registry】校验 model ✅ → spawn 执行
```

**场景 2（原 F2-B，修复后派发同步期明确报错）**：

```
[agent] subagent start {task:"...", engine:"zcode", model:"zai-coding-cn/glm-5.3-flash"}
[工具返回·错误]
  model 'zai-coding-cn/glm-5.3-flash' is not available on engine 'zcode'.
  Engine registries are independent — ids in <available_provider_models> (pi registry)
  do NOT apply to 'zcode' dispatches.
  zcode models with configured credentials:
    builtin:bigmodel-coding-plan/GLM-5.3, builtin:bigmodel-coding-plan/GLM-5.3-Flash, ...
  👉 Retry with one of the above (exact string), or omit `model` to use the zcode
     engine default (builtin:bigmodel-coding-plan/GLM-5.3).
```

**场景 3（漏传 engine 的 form ① 变体，跨引擎纠错）**：

```
[agent] subagent start {task:"...", model:"builtin:bigmodel-coding-plan/GLM-5.3-Flash"}   // 未传 engine，走默认 pi
[工具返回·错误]
  Model "builtin:bigmodel-coding-plan/GLM-5.3-Flash" is not a pi registry entry.
  This id matches the registry of engine 'zcode'.
  👉 Retry with engine: 'zcode', or use a pi model from <available_provider_models>,
     or omit `model` to inherit the main agent model.
```

#### 3.2.2 方案对比

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A. 路由先行 + 按目标引擎校验**（execute 内 model 解析移到路由后；target=pi 走现有 pi 链；target≠pi 时跳过 pi registry、经 `EnginePort.validateModel?()` 校验；未实现 validateModel 的引擎透传给其 prepare 期兜底；pi 未命中时跨引擎纠错候选） | ✅ 校验源=执行源，by construction 消灭两形态；引擎中立（新引擎实现 validateModel 即获得派发期校验）；与 workflow 路径（SAR :143 已路由先行）行为对齐 | 中：execute 编排顺序调整 + EnginePort 可选面 + zcode 实现（复用 `resolveZcodeModelRef`，已有）+ 错误消息 | 中：record.model 字段语义调整（非 pi 引擎时记 raw ref 而非 resolved 对象拼接）——影响面小（record.model 本就是 string） | ✅ **选** |
| B. model 参数按引擎命名空间拆开（`model` 只归 pi，zcode 用独立参数） | ❌ 违背 AgentTaskSpec 引擎中立直译设计（host-task-spec.ts）；每加引擎加参数，API 面扩散 | 高：schema+文档+所有调用方教育 | 高：参数组合爆炸，agent 更容易选错 | ❌ |
| C. 双 registry 交集探测 + 启动时警告 | 不解决任何形态：F2-A 仍会在 :850 炸、F2-B 仍 late failure；只降概率 | 低 | 低 | ❌（可作 A 的附属日志，不单独立项） |
| D. 只改错误消息（保持现有校验时序） | F2-A 的合法派发仍被拒——文案再好也是拒绝合法操作 | 低 | 高：修复不完整 | ❌ |

**被否反演**：若用 B——§3.2.1 场景 1 变成 `zcodeModel:"..."`，agent 需记住每引擎参数名，且 workflow 的 `agent({model})` 中立参数被架空；若用 C——场景 2 的错误仍出现在 zcode prepare 期（绕过 probe/池之后），场景 1 依旧被 pi registry 拒绝；若用 D——场景 1 依旧失败（「抱歉这个模型不属于 pi」对一个本该成功的派发毫无帮助）。

#### 3.2.3 关键决策

**D2-1：校验时机 = 路由先于 model 解析（chat 路径对齐 workflow 路径）（选定）**
- **采用**：`subagent-service.ts` execute() 内：① agentConfig 解析（agent .md 加载）保持在最前；② `routeEngine` 提前；③ model 解析按路由结果分支——target=pi 走现有 `resolveModel`（pi registry 三层解析，行为零变化）；target≠pi 跳过 pi registry，model 原样透传（record.model 记 raw ref）。**非 pi 分支逐层语义（v1.1 补，审查 S2）**：opts.model 显式参数→原样透传 + validateModel 校验；agentConfig.model（agent .md frontmatter）→同样原样透传（不忽略——agent 作者声明优先，配错在 validateModel 同步报错，不落 fallback 默认模型静默续跑）；ctxModel 主 agent model 兜底→**不透传**（主 agent 的 pi id 对 zcode 大概率无效，引擎缺省语义归引擎：zcode 落 `ZCODE_FALLBACK_DEFAULT_MODEL`）；thinkingLevel→直接透传（引擎中立参数，不涉 registry）。
- **被否**：「维持现状只在校验内判 engine」——engine 三层（调用参数 > frontmatter > config 默认）解析逻辑在路由层，校验点再判一遍 = 两处三层逻辑漂移源。
- **证据**：subagent-service.ts:850 vs :867 时序；workflow 路径 subprocess-agent-runner.ts:143 先路由已验证此顺序可行；routing.ts:159-162 自认路由层无 registry 访问面（校验归引擎侧）。
- **效果**：F2-A（场景 1/3）成立的前提。
- **探针**：⛔ P2-1（实施期回归门）：defaultEngine=zcode 下 chat 派发带 zcode id，修复前后行为对比（前=必炸 F2-A，后=成功）。降级路径：若 reorder 引发未预期时序依赖（record/注册顺序），回退为「identity 拆分——agentConfig 解析保持在前、仅 model 解析延后」的窄改法，同样消灭 F2-A。

**D2-2：派发期校验面 = `EnginePort.validateModel?(ref)` 可选方法，zcode 先实现（选定）**
- **采用**：EnginePort 增可选 `validateModel(modelRef: string): { canonicalRef: string }`（throw 结构化错误）；zcode 实现直接委托 `resolveZcodeModelRef`（preparer.ts:178，含凭据与清单校验，同步读 v2 config——已存在机制）；pi 不实现（pi 走 D2-1 的现有链）。未实现 validateModel 的未来引擎：model 透传，其 prepare 期校验兜底（现状语义）。**调用点双路径覆盖（v1.1 补，审查 MF2）**：① chat 路径 executeViaEngine（:876）路由后调用；② workflow 路径 SAR run()（subprocess-agent-runner.ts:226-229，r3 复审行号精化）在 `route.engine.run(taskSpec)` 前对非 pi 引擎调用同一校验——SAR 已路由先行（:143），两路径共享同一校验入口与错误文案，workflow 域 `agent({engine:'zcode', model:<pi id>})` 同步期报 D2-3 场景 2 错误，不再 prepare 期晚炸（§2.2 现状登记的「校验覆盖不对齐」就此清账）。
- **被否**：①「用 `listModels` 近似校验」——只有清单没有凭据判定（listZcodeModels 过滤了无凭据 provider，语义接近但 canonicalRef 归一化、短名缺省 provider 决策都在 resolveZcodeModelRef 里，重复实现 = 漂移源）；②「把 pi registry 校验也搬进 pi 引擎的 validateModel」——pi 链现有三层解析（override/agentConfig/ctxModel + thinkingLevel）语义远超「校验」，搬迁是大重构，准则 8 减法不做。
- **证据**：zcode-engine.ts:397 prepare 期已在用 `resolveZcodeModelRef`（同一函数两处消费，无重复实现）；port.ts:181 `listModels?()` 已开创「可选能力面」先例。
- **效果**：F2-B（场景 2）的失败从 prepare 期提前到派发同步期，错误消息拿到 zcode 清单数据。

**D2-3：错误消息 = 「引擎与模型不配套」+ 目标引擎清单 + 按引擎区分的省略语义（选定）**
- **采用**：场景 2/3 两种文案（见 §3.2.1）——共同结构：① 点破 registry 独立；② 列目标引擎可用清单（数据源 validateModel 抛错携带 / `listModels`）；③ 👉 给出修正动作。关键修正：**「省略 model」的语义按引擎说明**——pi 是「继承主 agent model」（model-ref.ts:232 现文案），zcode 是「用引擎缺省模型」（`ZCODE_FALLBACK_DEFAULT_MODEL`，constants.ts:37）——现文案对 zcode 派发是错误指引。
- **被否**：「沿用 `not a registry entry` 文案」——不区分引擎，恢复指引（omit to inherit）对非 pi 引擎是错的（§2.2 F2-A）。
- **证据**：model-ref.ts:200/:232 现文案；preparer.ts 各 ZcodePrepareError 已带恢复指引先例。
- **效果**：G2 的「错误指明引擎与模型不配套」成立；错误→权威源（清单）→重试闭环（准则 6）。

**D2-4：跨引擎纠错候选 = pi registry 未命中时反查其他引擎清单（选定）**
- **采用**：pi 校验未命中时，遍历已注册引擎的 `listModels?()`，命中唯一引擎则附「该 id 属于引擎 X，👉 加 engine:'X' 重试」（场景 3）。
- **被否**：「同时把 `<available_zcode_models>` 改为无条件全引擎注入」——已有用户拍板（2026-08-25 defaultEngine 门控决策，见 out-of-scope），全量注入加大每 turn prompt 体积；错误点按需给出清单信息密度更高。
- **证据**：port.ts:181 listModels 面（D2-2 之后 zcode 已实现）；model-ref.ts:159+ 已有「Did you mean」候选先例（case variant / 相似度）——本决策是同一模式跨引擎扩展。
- **效果**：form ① 的「漏传 engine」变体（默认 pi + zcode id）也能一步自愈。
- **探针**：⛔ P2-2（实施期）：listModels 对 v2 config 的同步读在派发错误路径上的耗时（文件通常 <100KB，预期毫秒级；若实测显著卡顿则改为仅列 provider 前缀提示，降级不列全清单）。

---

### 3.3 npm-installer tarball：60s 无进展 stall 兜底

**本节结论**：给 `downloadAndExtract` 的 body 消费段（integrity buffer 与流式 pipe 两路径）加**由 data 事件刷新的 inactivity timer**（stall 检测，非总墙钟），窗口 60s 复用既有 `timeout` 旋钮；触发后 `destroy` → 结构化 `network` 错误（可重试）→ tmp 目录清理。解压阶段不加 timer（本地 CPU 无外部等待）。

#### 3.3.1 终态（使用者视角）

**失败路径（原 F3 挂死场景）**：

```
[用户] Settings → 插件 → 安装 <plugin>@1.2.3
[系统] registry 元数据拉取正常 → tarball 请求发出 → 服务器发了 header 后停发 body
       → 60s 无任何数据字节 → 安装报错：
       "Download failed: no data received for 60s (stalled connection)"
       👉 网络恢复后点击重试安装（已下载部分自动清理，重装幂等）。
[用户] 重试 → 正常服务器 → 安装成功
```

#### 3.3.2 方案对比

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A. inactivity timer，data 事件刷新，覆盖 body 阶段（integrity + 流式两路径单点实现）** | ✅ 语义=「无进展检测」（规则 19 与 ADR-0047 的合法规矩：控制面单请求兜底 + 活动刷新不误杀）；与同文件 fetchJson bodyTimer 先例同构，量级一致 | 低：downloadAndExtract 内一个 timer + 两处 data 监听（final ∪ gunzip 输出侧——v1.1 修订：pipe 背压会 pause final，单挂 final 侧慢解压+健康网可饿死 timer，见 §2.3 现状注记）+ destroy | 低：慢速但持续的网络（限速下载）永不触发——正确行为 | ✅ **选** |
| B. 总墙钟（如 10min 总 deadline） | ❌ 对合法慢速大包误杀——量级按「被保护对象粒度」校准的反面（一个 50MB tarball 在 200KB/s 链路上合法需要 ~4min） | 低 | 高：慢网用户全部安装失败且无法自愈（重试也一样慢） | ❌ |
| C. 只补 integrity buffer 路径（复刻 fetchJson bodyTimer） | 覆盖不完整：无 integrity/shasum 的包走流式 pipe 路径（:355），仍挂死 | 低 | 高：修复后仍存在挂死路径 | ❌ |
| D. 调用方（插件/extension 安装 handler）外层各自加超时 | 每个调用方重复实现 + 新调用方必漏；stall 语义（哪一层停了）在下载层最清楚，外层只知道「总时长」 | 中（×N 个调用方） | 高：各处量级不一致 | ❌ |

**被否反演**：若用 B——§3.3.1 的重试场景在慢速链路上每次都在 10min 处失败，用户永远装不上（比挂死更糟：挂死至少不误报）；若用 C——无 integrity 的老包（verifyIntegrity 注释自认存在）安装继续挂死；若用 D——下一个新增的安装入口（如未来 GUI 直装）忘了加超时就回归。

#### 3.3.3 关键决策

**D3-1：stall 语义 = 无进展检测（data 刷新），非总墙钟（选定）**
- **采用**：timer 在「header 到达后」启动，每收到一个 body chunk 刷新；60s 无字节 → 触发。**刷新点双挂（r2 复审 MF 修正，同步 §3.3.2 方案表 A 与 §2.3 注记②——v1.1 变更历史已声明双挂但本决策正文漏同步，按正文实施会使 S1 攻击面回归）：流式路径挂 `final` ∪ `gunzip` 输出侧双 data 监听（pipe 背压会 pause final——慢解压 + 健康网时 final 侧静默，单挂 final 可饿死 timer 误杀）；integrity 路径无 pipe 耦合（buffer 全收），保持 `final` 单侧**。
- **被否**：总墙钟（方案 B）。
- **证据**：正面范本先例——普查 §3 登记的 liveness「ping×3 连击+成功清零」、心跳「每条消息重置计时器」（connection-manager.ts:30）：活动刷新是本项目对「慢速活跃流」的既定语义；方案 A 与 zcode 300s 误杀事故（活动不刷新的固定墙钟）形成正反对照。
- **效果**：慢速合法下载（G3 不误杀）与挂死检测并存。

**D3-2：量级 = 60s，复用 `options.timeout` 单旋钮（选定）**
- **采用**：stall 窗口 = `timeout ?? DEFAULT_TIMEOUT`（60s）——与同文件 header 阶段（httpGet）、metadata body 阶段（fetchJson bodyTimer）同值同旋钮。
- **被否**：①「独立 STALL_TIMEOUT 常量」——两个旋钮两个来源，调用方不知道该调哪个（量级耦合教训：普查 rt-infra-a 危险项 3 的 compact/bash 共用常量是反面，但那是「不同粒度对象共用」，此处 header/body 是同一请求的两个阶段，同量级合理共用）；②「120s 更宽」——无证据支撑的宽容度：健康网络 inter-chunk 间隔是毫秒级，60s 零字节已可判死，更宽只拖长挂死感知时间（但注意：本 timer 不是墙钟，宽容度只影响「完全断流」的检测延迟，不影响慢速流）。
- **证据**：npm-installer.ts:23 注释「对齐 npm `fetch-timeout` 默认 60s」——本文件既有两个阶段已按此口径。
- **效果**：单一量级口径，配置行为可预期。

**D3-3：覆盖阶段 = body 读取（两路径）；header 已有；解压不加（选定）**
- **采用**：单点实现在 `downloadAndExtract`——integrity buffer promise（:340-346）与流式 pipe（:355-357）共用同一个 stall timer。**刷新点挂载（r2 复审 MF 修正）：integrity 路径挂 `final` 的 data/end/error；流式路径挂 `final` ∪ `gunzip` 输出侧双 data + 各自 error（D3-1 双挂定案的落点声明——v1.1 的「挂在 final 的 data/end/error 上」是 integrity 形态漏写到流式路径）**。
- **被否/声明放弃**：①给 `extractTarStream`（gunzip/tar）单独加 timer——解压是本地 CPU 变换已收到的字节，无外部等待面；gunzip 挂起属代码 bug 而非网络故障，加 timer 是为新断言买保险（准则 8 减法），**声明放弃**并在此留痕；②只补 integrity 路径（方案 C）。
- **证据**：§2.3 管线图——外部等待面只有 body 到达；fetchJson bodyTimer 同判（只保 body 不保 JSON.parse）。
- **效果**：F3 全路径覆盖（integrity 包 + 无 integrity 包）。

**D3-4：触发行为 = destroy → `NpmInstallError('network')` → tmp 清理 → 可重试（选定）**
- **采用**：`final.destroy(new Error('stalled'))` + **同步 `gunzip.destroy(err)`，且流式分支显式挂 `final.on('error', reject)`（v1.1 补，审查 MF3：现 :355-357 final 无任何 error 监听——destroy(err) 会产生未处理 'error' 事件 ERR_UNHANDLED_ERROR 进程级风险，且这是既有隐患：中途 ECONNRESET 断流今天就是同一崩溃面，本修复顺带消除；v1「两路径均经既有 error 通道」声明修正为「buffer 路径既有、pipe 路径随本修复补齐」）** → 落入 downloadAndExtract 既有 catch（tmpDir rmSync + rethrow）→ 包一层 `NpmInstallError('network', '...no data received for Xms (stalled connection)')`。调用方（插件/extension 安装）已有失败呈现与重试入口，零改动。
- **被否**：「自动重试 N 次」——重试策略归调用方（安装 handler 有用户可见进度与重试按钮）；下载层静默重试掩盖网络问题（准则 8）。
- **证据**：downloadAndExtract :370-385 既有 catch/清理/原子 rename 结构；NpmInstallError code 体系（'network' 已含「基础设施层失败，检查网络/稍后重试」语义）。
- **效果**：§3.3.1 失败路径成立；G3「有限时间内报可重试错误」成立。
- **探针**：⛔ P3-1（实施期）：本地 stall 服务器（发 header 后不发 body 的 node 脚本）实测 60s 触发 + destroy 后无泄漏句柄/无未处理 rejection；**双断言（v1.1 升级）：① final 侧 error 有监听（不产生 unhandled）、② gunzip 侧错误传播到 promise reject**；降级路径：若 gunzip 侧传播仍不完整，改在 extractTarStream 的 reject 前显式 `gunzip.destroy()`。

---

### 3.4 trash：失败保留文件 + 报错，永不静默永久删除

**本节结论**：macOS 路径 trash 命令超时/失败后**不再降级 `unlinkSync`**——保留原文件并抛结构化错误（含恢复指引），调用方把「删除失败」呈现给用户；顺带把降级分支的 `console.error` 换成 logger 落盘。

#### 3.4.1 终态（使用者视角）

**失败路径（原 F4 数据丢失场景）**：

```
[用户] 侧栏右键 → 删除 session（Finder 恰好繁忙，AppleScript >5s）
[系统] 删除操作报错（scanned 形态：session 留在侧栏列表；active 形态：会话已终止 + 条目已移除，报错文案同）:
       "移入废纸篓失败（Finder 未在 5s 内响应）。文件已保留在原位置，未做任何删除。
        👉 稍后重试删除；或手动在访达中将该文件拖入废纸篓：<文件路径>"
[用户] Finder 恢复后重试 → 成功进废纸篓（访达废纸篓可见该文件）
```

**成功路径**：与现状一致（5s 内 trash/osascript 成功 → 进废纸篓）。

#### 3.4.2 方案对比

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A. 超时/失败保留原文件 + 抛结构化错误** | ✅ 语义正确：辅助手段失败 ≠ 原操作可换强手段硬完成；「可撤销操作永不静默变不可逆」成为构造性保证 | 低：删一个降级分支 + 抛错文案；调用方（session-lifecycle 两处）错误通道需核对 | 低：删除可能失败——但失败可重试，数据丢失不可逆，权衡明确 | ✅ **选** |
| B. 重试 N 次（如 3×5s）后才（仍）降级 | 重试治「暂态繁忙」，但 execSync 是同步阻塞——每次重试阻塞 runtime 事件循环 5s，N 次放大阻塞；且「重试后才降级 unlinkSync」数据丢失后果分毫未减 | 中（重试循环 + 阻塞时长） | 高：阻塞放大 + 后果不变 | ❌（若未来需要重试，前提是先改异步 exec——独立改动，登记不展开） |
| C. 降级前移动到自建 fallback 目录（如 `<dataDir>/trash-fallback/`） | 引入自建回收站：清理策略（TTL/reaper）、容量、用户找不找得到（访达废纸篓里没有，预期违背仍在）——新机制新断言源 | 高（新目录+生命周期管理） | 高：目录膨胀/用户不知情 | ❌ |
| D. 提高 timeout（5s→30s） | 只缩概率不除后果；Finder 弹窗等待态可无限长 | 极低 | 高：数据丢失仍可能发生 | ❌ |

**被否反演**：若用 B——Finder 被模态对话框占住时重试 3 次共阻塞 15s 后照样永久删除（F4 原样发生，还多等了 15s）；若用 C——§3.4.1 用户在访达废纸篓找不到文件（进了私有目录），且该目录无人清理持续膨胀；若用 D——只是把 5s 改 30s，Finder 卡死场景照样超时照样 unlinkSync。

#### 3.4.3 关键决策

**D4-1：mac 路径失败 = 保留文件 + 抛结构化错误（选定）**
- **采用**：删除 trash.ts:23-26 的 catch-降级块；超时/非零退出统一 `throw new Error('移入废纸篓失败（ Finder <5s 未响应或命令失败）。文件已保留：' + filePath + '。👉 稍后重试，或手动在访达中拖入废纸篓。')`（错误消息含路径与两类恢复动作）。快失败（如 `trash` CLI 缺失直接走 osascript 也失败）与超时同语义。
- **被否**：B/C/D（见上表）。
- **证据**：trash.ts:14-27 现降级链；session-lifecycle.ts:499/:543 两个调用点。**两形态恢复语义（v1.1 勘误，审查 MF1——v1「trash 是 delete 流程第一步」仅对 scanned 分支成立）**：① scanned 分支（:543）trash 是第一步 → throw 时 session 留在列表，重试语义完整；② active 分支（:499，delete 流程为 detachSession → destroySession → removeSessionEntry **之后**才 trash）→ throw 时**会话已终止、条目已从列表移除、文件保留**——显式声明新语义：「active 分支删除失败 = 会话已终止 + 文件保留 + 报错指引」，用户重删走 scanned 路径（文件下次扫描以 scanned 形态回来）或恢复会话后重试；不做「trash 提前到 destroy 之前」的编序重排（若 trash 成功而 destroy 失败，会话活着但文件已进废纸篓——比现序更危险，记入被否谱系）。
- **效果**：G4 构造性成立——mac 路径再无任何代码路径执行 unlinkSync。
- **探针**：⛔ P4-1（实施期，v1.1 简化）：`server.ts:416-434` 外层 handleMessage 统一 try/catch → `sendError`（error.code 透传）已源码核实存在——trash throw 必达 renderer，预期无需 case 内 try/catch；实施期直接验证一次错误到达即可（如需 code 差异化可给 trash 错误挂 code）。

**D4-2：日志 = console.error 换 logger（选定）**
- **采用**：catch（现 :24）删除的同时，把失败信息经 `infra/logger.ts` 落盘（架构约定 #4：禁止静默 catch，错误必须落盘）。
- **被否**：保留 console.error——runtime 日志约定是 logger 落盘轮转，console 在打包环境不可观测。
- **证据**：trash.ts 同文件 import 区可直达 `../logger.js`；quota fetcher 等同层模块均用 logger。
- **效果**：失败可诊断（日志含路径与原因）。

**D4-3：非 mac 分支与 5s 值保持现状（选定）**
- **采用**：Linux 分支（无废纸篓尝试直接 unlinkSync）不动；timeout 5s 不动（AppleScript 正常 <1s，5s 已宽；超时说明 Finder 不可用，D4-1 语义下再宽也无益）。
- **被否**：Linux 也改「保留+报错」——无验收环境（out-of-scope 已声明）；提高 timeout——见方案 D。
- **证据**：本 workspace 主平台 macOS（AGENTS.md 环境）。
- **效果**：改动面收敛在 mac 降级语义这一处。

---

## 4. 验收（真实场景，非单测非 mock）

**本章结论**：四项各用真实场景验证（真实平台/真实系统状态/真实网络行为），每场景回溯 §1 目标；关键负面行为（不查他人数据 / 不误拒合法派发 / 不误杀慢速下载 / 永不永久删除）各有反向验证。单元测试仅作回归辅助，不计入验收。

### 4.1 V1 opencode（改动规模：中——跨 3 层接口扩展）

| 场景 | 回溯目标 | 真实流程/步骤 | 通过标准 |
|---|---|---|---|
| V1-1 配自己的 workspace 后查到自己额度 | G1 | 用户 A 在 Settings 为 opencode provider 配置自己的 cookie + 自己的 workspace URL（从自己浏览器地址栏复制）→ hover/点击测试查询 | 展示三窗口进度，数值与用户 A 浏览器打开同一 URL 看到的**一致** |
| V1-2 未配置 workspace 的明确指引 | G1 | 只配 cookie 不配 workspace → hover | 失败态显示「未配置 workspace」+ 指向 Settings 的恢复指引；**不发任何 HTTP 请求**（网络面板/日志验证） |
| V1-3 硬编码清零（负面） | G1 | `grep -rn "wrk_01KM" packages/ extensions/` | 零命中；任意配置状态下查询的数据只能来自配置的 URL |
| V1-4 凭证/URL 失效可区分 | G1 | 配一个失效 workspace URL（已删除的 workspace）→ 查询 | 报 unauthorized 或 no-subscription（可区分），恢复指引指向「检查 cookie 或 workspace 地址」 |

### 4.2 V2 engine+model（改动规模：中——派发主链路编排调整）

前置：本机 ZCode 桌面端已登录（v2 config 有带凭据 provider）。subagent 引擎配置（`~/.pi/agent/npm/node_modules/@zhushanwen/pi-subagent-workflow/config.json` 环境路径，见 subagent-ext-config skill）defaultEngine 分别设为 zcode / pi 两组场景。

| 场景 | 回溯目标 | 真实流程/步骤 | 通过标准 |
|---|---|---|---|
| V2-1 zcode id 派发 zcode 引擎成功（原 F2-A） | G2 | 本地 pi CLI（`pi --mode rpc --extension <subagent-workflow>`）派发 `subagent start {task:"列出当前目录文件", engine:"zcode", model:"builtin:bigmodel-coding-plan/GLM-5.3-Flash"}`；再以 defaultEngine=zcode 不传 engine 重试 | 两种形态都成功执行并返回结果（修复前：报 `is not a registry entry`） |
| V2-2 pi id 派发 zcode 引擎的同步期明确报错（原 F2-B） | G2 | 派发 `engine:"zcode", model:"zai-coding-cn/glm-5.3-flash"` | 派发**同步期**（不进入执行/probe 后）返回错误：点破 registry 独立 + 列 zcode 可用模型清单 + 👉 修正动作；按清单 id 重发即成功 |
| V2-3 漏传 engine 的跨引擎纠错 | G2 | defaultEngine=pi，派发 `model:"builtin:bigmodel-coding-plan/GLM-5.3-Flash"`（不带 engine） | 错误提示该 id 属于引擎 'zcode'，👉 加 `engine:'zcode'` 重试；照做后成功 |
| V2-4 既有路径回归（负面+正面） | G2 | ① pi id 派发 pi 引擎（现状主路径）行为不变；② workflow 路径 `agent({engine:'zcode', model:<zcode id>})` 不回归；③ 大小写错误 id 派发 pi 仍报全等裁决错误（零容忍原则不破）；④ **workflow 错误场景（v1.1 补，审查 MF2）**：`agent({engine:'zcode', model:<pi id>})` | 四者：①②③行为与修复前一致；④ 派发**同步期**报 D2-3 场景 2 错误（不进入执行/probe 后，与 chat 路径 V2-2 同文案） |

### 4.3 V3 tarball stall（改动规模：小——单函数兜底）

| 场景 | 回溯目标 | 真实流程/步骤 | 通过标准 |
|---|---|---|---|
| V3-1 stall 服务器触发报错可重试（原 F3） | G3 | 本地起真实 HTTP 服务器（node 脚本：响应 header（Content-Length 正常）后不发 body）；`NPM_CONFIG_REGISTRY=http://…` 指向本地（或插件安装入口指向构造的 tarball URL）执行一次安装 | ~60s（±5s）内安装报 network 错误（含 stalled 字样）；随后换回正常 registry 重试安装**成功**；无残留 `.tmp` 目录 |
| V3-2 慢速合法下载不误杀（负面） | G3 | 本地服务器限速（如 50KB/s）发一个 ~5MB 真实 tarball（总耗时 >2min）→ 安装 | 安装**成功**（data 持续到达，stall timer 持续刷新，永不触发） |
| V3-3 真实 registry 回归 | G3 | 正常网络从 registry.npmjs.org 安装一个真实 `@zhushanwen/pi-*` 包 | 安装成功，耗时与修复前无感知差异 |

> 依赖说明：V3-1/V3-2 用本地 HTTP 服务器注入网络行为——这是对真实 TCP 语义的故障注入（非 mock 掉下载逻辑），验证缺口仅剩「公网 CDN 特定断流形态」，可接受。

### 4.4 V4 trash（改动规模：小——单分支语义修改）

| 场景 | 回溯目标 | 真实流程/步骤 | 通过标准 |
|---|---|---|---|
| V4-1 Finder 繁忙时删除永不永久删除（原 F4） | G4 | 真实注入系统繁忙：`osascript -e 'tell app "Finder" to display dialog "x"'` 挂住 Finder（或 `kill -STOP <Finder pid>`）→ 在应用侧栏删除一个 session | 5s 后删除报错（含文件路径 + 👉 指引）；**文件仍在原位置**（磁盘验证）；恢复 Finder（关闭对话框 / `kill -CONT`）后重试删除成功。按形态分别断言（v1.1）：scanned 形态——session 留在列表，重试成功；active 形态——会话已终止 + 条目已移除（新语义），文件保留，重新 scan 后以 scanned 形态出现、再删成功 |
| V4-2 正常删除仍进废纸篓（负面/正面） | G4 | 正常状态下删除另一个 session | 访达废纸篓出现该 session 文件（可撤销语义保持） |
| V4-3 永久删除路径清零（负面） | G4 | `grep -n "unlinkSync" packages/runtime/src/infra/system/trash.ts` | 仅剩非 mac 分支一处（mac 路径无任何永久删除代码） |
| V4-4 批量删除部分失败（v1.1 补，审查 S3） | G4 | folder 删除（deleteByCwd）含一个 Finder 卡死项 + 两个正常项 | failed[] 含卡死项（前端可见）、其余正常进废纸篓——既有 per-item try/catch 聚合语义天然兼容，零改码 |

---

## 5. 下一层拆分（实现任务单元）

**本章结论**：拆成 4 个相互独立的实现单元（一个 PR 粒度 each），无相互依赖、可并行、各自独立验收回滚；建议按「数据正确性 → 数据丢失 → 挂死 → 派发链路」顺序合入。

### 5.1 实施路径

| 阶段 | 内容 | 交付终态的什么 | 对应验收 |
|---|---|---|---|
| M1 | Unit-1 opencode workspace 配置化 | G1 全部 | V1-1~V1-4 |
| M2 | Unit-4 trash 降级语义 | G4 全部 | V4-1~V4-3 |
| M3 | Unit-3 tarball stall 兜底 | G3 全部 | V3-1~V3-3 |
| M4 | Unit-2 engine-aware model 校验 | G2 全部 | V2-1~V2-4 |

顺序理由：M1/M2 是最小且最高危害（错误数据/数据丢失）先行；M4 动派发主链路编排，放最后以便其余三项先稳定（其回归面最大，V2-4 三条回归场景守卫）。

### 5.2 拆分清单

| 单元 | 说明 | justification（为什么这么拆） |
|---|---|---|
| unit-1 opencode-workspace | shared 协议+类型（`quota.configure` 增 workspace 参数 / `QuotaFetchFailureReason` 增 `not_configured` / `fetchQuota` 第三参数）→ runtime（QuotaService 读写注入 + fetcher URL 拼接）→ renderer（Settings 输入框 + 失败态文案） | 接口扩展跨 3 层必须同批交付才可验收（V1-1 端到端）；与其余三项零交集 |
| unit-2 engine-model-validation | subagent-core：execute() 编排调整（路由先行+按引擎分支）+ EnginePort.validateModel 可选面 + zcode 委托 resolveZcodeModelRef + 错误文案（场景 2/3）+ pi 未命中跨引擎候选 | 全部改动服务于同一失败形态族（F2-A/B），拆开交付会出现「文案指向尚不存在的行为」的中间态；subagent-workflow 扩展包零改动（校验全在 core 层） |
| unit-3 tarball-stall-guard | npm-installer.ts downloadAndExtract 单点：stall timer + data 刷新 + destroy + NpmInstallError 包装 | 单文件单函数闭环，独立可验收（V3）；不动调用方 |
| unit-4 trash-no-permanent-delete | trash.ts 降级分支删除 + 结构化错误 + logger；session-message-handler delete case 错误通道核对（P4-1） | 单文件主改动 + 一处调用方错误通道核实；独立可验收（V4） |

### 5.3 文件改动地图

| 单元 | 文件 | 改动 |
|---|---|---|
| unit-1 | `packages/shared/src/quota-types.ts`、`packages/shared/src/protocol.ts`（:533 configure payload）、`packages/shared/src/provider.ts`（quota 配置类型） | fetchQuota 签名、reason 枚举、配置字段 |
| | `packages/runtime/src/services/quota-service.ts`（configure/doFetch/persistQuotaConfig）、`quota-providers/opencode.ts` | 配置读写注入 + URL 拼接 + not_configured |
| | `packages/renderer/src/composables/features/model/useQuotaConfigure.ts`、对应 Settings 组件、失败态文案 | 输入框 + 恢复指引 |
| unit-2 | `packages/subagent-core/src/execution/subagent-service.ts`（execute 编排 :849-876）、`execution/subprocess-agent-runner.ts`（SAR 非 pi 分支校验调用点，v1.1 补）、`execution/engine/port.ts`、`execution/engine/engines/zcode/zcode-engine.ts`（validateModel 委托，r2 复审 SG 补 execution/ 段）、`shared/model-ref.ts` 或新错误构造（跨引擎候选） | 见 §3.2.3 四决策；含 V2-4② workflow 错误场景 |
| unit-3 | `packages/runtime/src/infra/installers/npm-installer.ts`（downloadAndExtract） | stall timer |
| unit-4 | `packages/runtime/src/infra/system/trash.ts`、`packages/runtime/src/transport/session-message-handler.ts`（P4-1 视核实结果） | 降级分支删除 + 错误通道 |

### 5.4 待验证检查点（设计阶段无法确定，诚实标注）

- **P1-2**（⛔ unit-1 实施期）：opencode workspace 列表端点是否存在且稳定（真实 cookie 探测）——失败则维持纯配置方案（降级路径已内置，零损失）。
- **P2-1**（⛔ unit-2 实施期）：execute() 编排 reorder 的时序回归（record 注册/emit 顺序依赖）——失败则收窄为「仅 model 解析延后」的窄改法。
- **P2-2**（⛔ unit-2 实施期）：错误路径上 listModels 同步读 v2 config 的耗时——超预期则降级为仅列 provider 前缀。
- **P3-1**（⛔ unit-3 实施期）：pipe 路径 destroy 后 gunzip 错误传播完整性——失败则在 extractTarStream reject 前显式 `gunzip.destroy()`。
- **P4-1**（⛔ unit-4 实施期）：session.delete 在 trash throw 时的 WS 错误 reply 通道——正路（server.ts:416-434 外层统一收口）已源码核实存在，预期无需 case 内 try/catch；「若无统一收口则补 case 内 try/catch → sendError」为防御性登记（r2 复审 INFO-2 注明，非条件分支）。
- **P1-1**（⛔ unit-1 实施期）：配置的 workspace URL 归一化（完整 URL vs 裸 `wrk_` id 两种输入的解析与校验，含非法输入报错文案）。

### 5.5 探针清单（汇总，可审计）

| ID | 验证的行为 | 探针 | 状态 | 失败时的降级路径 |
|---|---|---|---|---|
| P1-1 | workspace URL 输入归一化两形态均可解析 | 实现后单元测试 + 手工两种输入实测 | ⛔ unit-1 | 仅接受完整 URL（输入框 placeholder 指引），文档标注 |
| P1-2 | opencode 自动发现端点存在且稳定 | 真实 cookie 探测 /api/workspaces 与首页 SSR | ✅ 已执行（2026-09-05 Gate B）：端点及全部变体 5+ 次采样稳定 404（无凭证与 Bearer key 交叉验证，首页 SSR 无 workspace 数据）——**探针证伪，降级路径生效：维持纯配置方案，零损失** | 维持纯配置方案（方案 A 不依赖它） |
| P2-1 | 路由先行 reorder 无时序回归 | V2-1/V2-4 全场景跑 + 既有 subagent 测试套件 | ⛔ unit-2 | 收窄为「仅 model 解析延后」窄改法 |
| P2-2 | 错误路径 listModels 同步读耗时可接受 | v2 config 实测计时 | ✅ 已执行（2026-09-05 Gate B）：组合全链路（validate 失败 + listModels 反查）p50=0.070ms/p95=0.076ms，冷启动 0.06-0.32ms，低于 100ms 阈值约 3 个数量级——**通过，维持实现** | 降级为 provider 前缀提示（不列全清单） |
| P3-1 | destroy 后 pipe 链错误传播完整、无句柄泄漏 | stall 服务器实测 + process 活动句柄检查 | ⛔ unit-3 | extractTarStream reject 前显式 gunzip.destroy() |
| P4-1 | trash throw 能到达 renderer（错误 reply） | Finder 繁忙注入实测删除报错可见 | ⛔ unit-4 | handler case 内补 try/catch → sendError |
| —（代码追踪已证） | F2-A/B 两形态的时序根因（:850 先于 :867） | 本文 §2.2 代码证据链 + 普查当日实测（总报告 §4 #2） | ✅（代码级） | — |

---

## 附录 A：与总报告的映射

- 来源：[timeout-audit-2026-09.md](timeout-audit-2026-09.md) §4 附赠发现 #1（opencode workspace）、#2（engine+model 错配）、#3（tarball stall）、#4（trash 降级）；#5（plugin-host Worker/fork 不对称）归 Doc 3 `timeout-plugin-service-granularity.md`，本文不涉及。
- 行号勘误（普查报告 → 本文实核）：opencode 硬编码 URL 实际在 `opencode.ts:60`（报告记 :52，:52 是 fetcher id 行）；trash 降级 catch 实际在 `trash.ts:23-27`（报告记 :16-20，:16 是 timeout 值行）。以本文为准。
- 模块报告全文：rt-svc-rest（opencode 发现）、rt-infra-a（tarball 缺口）、rt-infra-b（trash 降级语义）。

## 附录 B：变更历史

- v1（2026-09-04）：初版落盘——四项现状证据实核、方案对比、决策、验收与拆分。
- v1.1（2026-09-04）：第一轮对抗式审查修复（3 MF/4 SG/1 INFO，逐条对应）：
  - MF1（active 分支 trash 非第一步）→ D4-1 证据按 active/scanned 两形态勘误 + 显式声明新语义（active 失败 = 会话已终止 + 文件保留 + 报错指引，重删走 scanned 路径）；「trash 提前到 destroy 前」记入被否谱系（trash 成功而 destroy 失败 → 会话活文件已删，更危险）；失败路径样例与 V4-1 按形态拆分断言。反例重演：active session + Finder 卡死 → 报错、会话终止、文件保留、重新 scan 后重删成功——v1 的「session 留在列表」不再出现在 active 断言中。
  - MF2（workflow 派发域遗漏）→ D2-2 补调用点双路径覆盖（SAR run() 非 pi 分支 engine.run 前同一校验）；V2-4 补④ workflow 错误场景；unit-2 补 SAR 文件。§2.2「派发=chat+workflow」定义下 G2 完整达成。
  - MF3（流式路径 final 无 error 监听）→ D3-4 补 final.on('error') + gunzip.destroy 同步；v1 失实声明修正；ECONNRESET 既有崩溃面顺带消除；P3-1 升级双断言。
  - S1（背压饿死）→ D3-1 刷新点扩为 final ∪ gunzip 双挂；S2（非 pi 分支逐层语义）→ D2-1 补 opts.model/agentConfig.model/ctxModel/thinkingLevel 归趋表；S3（deleteByCwd）→ 调用方清单补 deleteByCwd 第三处（v1 漏登记，r2 复审 INFO-1 记述修正——v1 §2.4 只登记两调用点），补 V4-4 批量场景；S4（路径前缀）→ 四处已按实核修正（execution/、engine/ 前缀）。INFO（P4-1）→ server.ts 外层通道已核实，探针简化为直接验证。
  - 联动同步：§2.3/§2.4 现状注记、§3.2.3 D2-1/D2-2、§3.3.3 D3-1/D3-4/P3-1、§3.4.3 D4-1 + 失败路径样例、§4.2 V2-4/V4-1/V4-4、§5 unit-2/unit-4；变更历史本条。
- v1.2（2026-09-05）：**第 2 轮聚焦复审修复**（1 MF/1 SG/3 INFO 全修，报告 .review/timeout-hygiene-r2.md；r1 三条 MF 修复全部经源码逐点核实验证成立——active/scanned 两分支编排、SAR catch 收口零新增错误通道、integrity/流式 error 监听双通道）。①MF（D3-1/D3-3 刷新点落空，P0-12 联动遗漏 + P0-2 delta 链失实）：v1.1 变更历史声称「刷新点扩为 final ∪ gunzip 双挂」但决策正文仍是 final 单挂——D3-1 补双挂定案（流式路径 final ∪ gunzip 输出侧双 data，pipe 背压 pause final 时单挂可饿死 timer——S1 攻击面回归；integrity 路径无 pipe 耦合保持 final 单侧）、D3-3 补挂载点分路径声明；②SG：§5.3 unit-2 两处路径补 execution/ 段（engine/port.ts、engine/engines/zcode/zcode-engine.ts）；③INFO-1：v1.1 变更历史 S3「调用方清单已有（v1 即含）」记述修正为「v1 漏登记、修复时补第三处」；④INFO-2：P4-1 条件式降级句补注「正路已核实存在，降级为防御性登记」。
- v1.3（2026-09-05）：**第 3 轮聚焦复审 0 must-fix / 1 SG / 1 INFO，当轮全修收口**（报告 .review/timeout-hygiene-r3.md；三轮收敛 3→1→0 MF，r2 全部修复经重演验证成立——双挂反例消灭/慢速下载不受影响/四方位联动一致/五路径实核存在）。①SG：SAR 行号 :227-229→:226-229 两处精化（v1.2 变更历史「3 INFO 全修」实修 2 条的 delta 失实随之消除）；②INFO 登记：双挂后 stall 语义客观扩为「下载-解压管线零进展」——本地 I/O 停滞 >60s 会报 network 错误（归因略偏、行为无害、不在 G3 承诺范围），实施期知晓。**设计就绪。**
