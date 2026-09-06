# 升级链路网络韧性设计：手动产物认领 + 双引擎下载降级

> **一句话结论**：升级链路新增两条互补的可达性保障——①用户手动下载的安装包放入固定目录即可被升级入口认领安装（零 app 网络依赖的最终逃生通道）；②所有升级网络访问统一收敛到「undici 优先、连接类失败自动降级系统 curl、代理不可用兜底直连」的封装与编排，调用方无感知。
>
> **层声明**：本文档是技术方案层（接口 / 数据模型 / 错误规格 / 物理数据流），下一层产物为代码实现。不涉及具体代码任务拆步（见 §5）。

---

## 1. 背景目标

### SCQA

- **S（情境）**：太极桌面 app 的自动升级链路为「检测（GitHub API）→ 下载（undici fetch，可配代理）→ sha256 校验 → detached 脚本替换重启」。下载与安装是两个独立阶段（`update:download` / `update:install` IPC），并有后台预下载机制（成功后写 `~/.xyz-agent/update/preloaded-update.json`，点击更新走快路径跳过下载）。
- **C（冲突）**：2026-08-30 实测事故——当前发布链路无开发者签名（ad-hoc），macOS 本地网络权限（Local Network Privacy）按**发起进程的二进制签名**判定且不沿进程树继承：app 主进程（undici）连私网代理一律 `EHOSTUNREACH`，但 app 拉起的子进程里系统二进制（`/usr/bin/nc`、`/usr/bin/curl`）与用户自装 node 全部畅通。结果：检测能过（检测路径有「代理失败→直连」降级，且授权拦截只影响私网、不拦公网直连），下载必挂（下载路径无任何降级），且用户没有任何手动逃生通道（浏览器下载的安装包 app 不认）。
- **Q（问题）**：如何让升级在网络授权失效、代理故障等场景下仍可完成？
- **A（答案）**：两个改进。①手动产物认领：固定目录约定 + name/size/sha256 三重校验 + 复用 preloaded 快路径；②网络访问双引擎封装：undici 连接类失败自动降级系统 curl（借系统二进制的健康签名路径），下载路径并增加「代理不可用→直连」兜底，对外单入口。

### 设计目标

| # | 目标 | 使用者体验倒推 |
|---|------|---------------|
| G1 | 手动下载逃生通道 | 用户用浏览器/其他机器下载安装包 zip，放入指定目录，升级入口（侧边栏升级按钮 **和** 设置页更新卡片，二者共用同一 IPC）识别后直接进入「可安装」态，全程零 app 网络依赖 |
| G2 | 网络访问双引擎降级 | 授权失效/连接层故障时用户点升级**无需任何额外操作**：undici 失败自动换 curl，代理整体不可用时兜底直连；调用方（download / check / testProxy）代码不感知引擎切换 |
| G3 | 兼容性 | 现有 IPC 契约、preloaded 机制、错误分类体系（UpdateErrorCode / 用户文案 / update-error.log）不变，仅扩展 |

### Scope

- **In**：main 侧网络访问收敛（检测 latest API / digest 缺失时的 manifest fallback / 多段 probe / 下载 / 代理测试五条路径的引擎降级）；下载路径「代理→直连」兜底；手动产物认领（固定目录扫描 + 校验 + 认领落 preloaded）；renderer 侧文案与状态衔接（i18n suggestion、settings 页展示手动目录）。
- **Out**：开发者签名 + 公证（根治授权失效的长期方案，需 Apple 开发者账号决策，另行推进）；文件选择器式认领 UI（固定目录已闭环，按 YAGNI 砍）；multipart per-part 的 curl 化（见 D7）；Windows / Linux 的授权问题（两平台无 macOS 本地网络权限机制，受益仅为「curl 引擎冗余」）。

---

## 2. 现状与问题分析

### 2.1 现状链路（物理数据流）

```
renderer (useAppUpdate 单例)
  │  update:check ──→ ReleaseChecker.checkForLatestRelease
  │                      ├ fetch GitHub /releases/latest（undici，代理优先，失败降级直连）
  │                      └ asset 缺 digest 时 fetch manifest.json（裸 undici，无降级）
  │                                    └─→ 写 pending-update.json（含完整 release + assets + sha256）
  │  update:download(version) ──→ resolveByVersion（网络权威解析，防装错版本）
  │                      ├─ readPreloadedUpdate(release)  ← 快路径：app 自己下载过的产物
  │                      └─ downloadUpdate → downloadAsset（undici 单段/多段/断点续传）
  │                              └─→ 校验 sha256 → 写 preloaded-update.json
  │  update:install ──→ readPreloadedUpdateRaw（本地读，install 不信任前端）
  │                      └─ installUpdate → detached 脚本解压 zip 替换 .app → 重启
```

关键事实（代码定位）：

- 检测路径**有**「代理失败→直连重试」降级：`release-checker.ts` `fetchGitHubLatestRelease`（网络错误且用了代理 → 无 dispatcher 直连重试一次）。
- 检测路径的 manifest.json digest fallback（`doFetchManifestSha256`，任一 asset 缺 digest 时触发）是**裸 undici、无任何降级**的网络路径。
- 下载路径**无任何降级**：`download-asset.ts` 单段 fetch 失败直接 `classifyNetError` 抛出。
- 快路径只认 app 自己写的 `preloaded-update.json`：登记入口仅 `writePreloadedUpdate`（`update:download` 成功与后台预下载两处调用），浏览器手动下载的文件没有任何入口被认。
- `update:download` 的第一步 `resolveByVersion` **需要网络**（缓存未命中时 force check GitHub），网络全断时连快路径判定都走不到——这是比「不认手动文件」更深的一层断网点。
- 两个升级 UI 入口（`UpdateButton.vue` 侧边栏角标、`UpdateCheckCard.vue` 设置页）共用 `useAppUpdate` 单例与同一组 IPC，main 侧单点接入即同时覆盖。

### 2.2 真实失败模式（2026-08-30 实测留档）

`~/.xyz-agent/update/update-error.log` 当日三条同型记录：

```
{"source":"download","errorCode":"UPDATE_PROXY_UNREACHABLE",
 "rawCause":"connect EHOSTUNREACH 192.168.1.202:7890 - Local (192.168.1.4:59473)"}
```

同环境实测对照（同一台机器、同一时刻）：

| 发起进程 | 可执行二进制 | 结果 |
|---|---|---|
| 太极主进程（undici fetch） | `TaiJi.app`（ad-hoc 签名，codesign 校验失败） | 连私网代理 `EHOSTUNREACH`（含授权弹窗允许 + 重启 app 后复测，稳定复现）；**公网直连正常**（检测路径降级直连成功即证） |
| 太极拉起的 bash → `nc` / `curl` | `/usr/bin/*`（Apple 签名） | TCP 通；经代理 curl GitHub Range 下载 206（1MB / 2.3s）——注意必须带 `-L`，GitHub release URL 实测 302 两跳至 CDN 签名 URL |
| 太极拉起的 bash → node（nvm 版） | Node 官方 Developer ID 签名 | TCP 通 |

结论（运行时断言，已实测）：本地网络权限按发起进程自身的二进制签名判定，不沿进程树继承，且只拦私网访问、不拦公网直连。**spawn 系统二进制（curl）是被验证可行的绕行路径，undici 直连公网亦可达**——两者共同构成本设计 G2 的机制依据。

历史佐证：2026-08-28 的错误日志为 `UPDATE_INTEGRITY_FAILED`（sha256 不匹配，多次）——代理链路下载大文件有内容损坏前科，任何降级路径都必须保留 sha256 终校验。

### 2.3 根因归纳

1. **下载路径单引擎、单通道、无降级**（undici+代理失败 = 升级失败），而检测路径已有直连降级，能力不对等。
2. **断网场景下下载入口整体不可用**：`resolveByVersion` 网络依赖前置，导致本地已就绪的产物（preloaded / 手动文件）无法被认。
3. **无零网络逃生通道**：用户唯一退路是去 release 页手动下载，但下载后的文件与 app 升级流程完全脱节（需手动解压替换）。

---

## 3. 解决方案

### 3.1 终态（使用者视角）

**场景 A（授权失效，自动恢复）**：用户点「更新」→ 进度条短暂停顿（undici 快速失败 <2s）→ 自动经 curl 继续下载 → 完成 →「重启安装」→ 升级成功。用户全程无感知引擎切换（诊断日志记录 `engine: curl` 的降级事件）。

**场景 B（curl 也不行 / 用户主动手动下载）**：下载失败时 toast 弹错误摘要（suggestion 不进 toast）；恢复指引中的手动下载一步（「或从 release 页手动下载 zip 放入 `<update>/manual/` 目录后重试」）追加在错误 suggestion 文案末尾，展示通道 = 侧边栏升级角标 hover 浮层，设置页更新卡片另常驻手动升级通道区（含路径与打开目录按钮）兜底可见性。用户用浏览器下载 `TaiJi-x.x.x-mac-arm64.zip` 放入该目录（设置页更新卡片常驻展示此路径 + 「打开目录」按钮）→ 重启 app 或再点「更新」→ 升级按钮直接进入「已下载，重启安装」态（与预下载完成态完全一致）→ 点安装 → 成功。**全程 app 可完全断网**。

**场景 C（手动文件损坏，安全拒绝）**：用户放入了不完整/被篡改的同名文件 → 认领静默失败（不安装、不弹错打断），落盘 `source: manual-claim` 诊断记录，升级按钮维持原路径（继续尝试在线下载）。

### 3.2 方案对比

#### 改进一：手动产物认领

| 方案 | 长期合理性 | 短期成本 | 风险 |
|------|-----------|---------|------|
| **A. 固定目录扫描（推荐）**：约定 `<update>/manual/`，download 入口与启动恢复链自动扫描认领 | 目录约定一次成型，UI 两入口共用；认领后复用 preloaded 快路径与既有安装链，零新状态机 | 低：一个新纯逻辑模块 + 两处调用点 | 用户需知道路径（UI 引导解决）；目录残留无关文件（不动即可，无副作用） |
| B. 文件选择器导入：设置页加「选择本地安装包」按钮 | 每次操作 3+ 步，用户需主动发现功能；不覆盖「下载失败后指引」场景的自动性 | 中：文件对话框 IPC + UI 状态 | 低 |
| C. 扫描 `~/Downloads` 按文件名匹配 | 用户零操作 | 中：目录扫描 + 名称模糊匹配 | 高：误匹配（同名旧版本）、Downloads 内容不可控、语义黑盒 |

选 A 的核心理由：认领落点在 main 侧 IPC 层，升级按钮与设置页**自动**同时生效（「检测到指定目录有新版即可升级」的自动语义是本设计的输入需求），B 是手动语义、C 不可控。B 可作为后续增强，不进本次 scope。

#### 改进二：下载网络访问降级

候选方案按「降级维度」分两类：引擎维度（undici→curl）与通道维度（代理→直连）。可达性矩阵（基于 §2.2 实测）：

| 故障场景 | undici+代理 | curl+代理 | undici/curl 直连 | 修复所需最小降级 |
|---|---|---|---|---|
| 本次事故（授权失效 + 私网代理，公网直连可达） | ✗ | ✓ | ✓ | 任一维度均可 |
| 代理进程挂（ECONNREFUSED），直连可达 | ✗ | ✗ | ✓ | **仅通道维度有效** |
| 直连被墙（国内典型）+ 代理正常 + 授权失效 | ✗ | ✓ | ✗ | **仅引擎维度有效** |
| 无故障 | ✓ | — | — | 无需降级 |

> 注：第 3 行的「授权失效」为 macOS 本地网络权限特有前提，Linux / Windows 无此行；Linux 无 curl 环境下第 2 行经 D10 第三步的引擎回退（undici 直连）覆盖。

| 方案 | 覆盖矩阵 | 长期合理性 | 短期成本 | 风险 |
|------|---------|-----------|---------|------|
| **A. 双引擎封装 + 下载直连兜底（推荐，A+D 叠加）**：`upgradeFetch`（undici→curl）收敛五条网络路径；downloadAsset 编排「undici+代理 → curl+代理 → 直连兜底（引擎按可用性选择）」 | 全部四行 | 单点收敛，签名修复后 flag 机制自动回归 undici；新增网络调用点天然获得降级 | 中：1 个 fetch 封装 + 1 个 curl 下载器 + 5 处接入 + 下载编排 | curl 输出解析与超时语义需对齐（错误映射表覆盖）；最坏尝试链 3 步（见 D10） |
| B. 仅在 download-asset 内部加 curl fallback（不抽封装） | 全部四行 | 五条路径各自重复实现降级，drift | 低 | 高：降级语义不一致（现状下载与检测能力不对等问题的再现） |
| C. 全部改用 curl 子进程（弃 undici） | 全部四行 | 丢失流式进度 / 多段并发 / 精细 idle 超时 / AbortController 语义；非 mac 平台无授权问题却被迫子进程化 | 中 | 高：重写全部下载语义，回归风险大 |
| D. 仅下载路径加「代理→直连」降级（复用检测路径既有模式，零新模块） | 前两行（第三行「直连被墙+授权失效」不覆盖） | 不引入子进程复杂度 | 最低 | 留下「直连被墙 + 授权失效」组合缺口——国内真实存在的场景 |

结论：D 案最简且足以修复本次事故，但不覆盖「直连被墙 + 授权失效」组合（该组合中 curl+代理 是唯一活路，恰是系统 curl 健康签名路径的价值所在）；产品要求同时具备「代码内引擎直访」与「spawn 系统 curl」两条通道能力（本设计的输入需求）。故选 **A（引擎 + 通道两维度叠加）**：`upgradeFetch` 只管引擎维度（「用给定网络参数把请求做成功，undici 不行换 curl」），通道维度（代理→直连）由调用方编排——检测路径沿用其既有直连降级，下载路径新增同款兜底。两维度正交，避免降级矩阵组合爆炸。

### 3.3 关键决策与权衡

**D1 认领落点：download 入口前置本地短路 + getPreloaded 兜底认领，而非新建认领 IPC**

- 选择：`update:download` handler 入口顺序改为 ①`readPreloadedUpdateRaw`（本地）**且 `preloaded.release.version === payload.version`** 时短路返回 downloaded（版本严格相等才短路，防静默装旧版；顺带修复「断网时快路径也走不到」的缺陷）→ ②`readPendingUpdate`（本地）且 `pending.version === payload.version` 时尝试认领（本地零网络）→ ③原链（resolveByVersion 网络 → downloadUpdate）。启动恢复链：`update:getPreloaded` 在 miss 后尝试认领（同样全本地，基准直接用 pending，无请求版本可比），命中则 app 启动即显示「已下载可安装」态。
- 被否：新建 `update:claimManual` IPC 由 renderer 编排——增加契约面，且 renderer 无法在 download 失败前的合适时机自动触发（自动性要求 main 侧前置）。
- 证据：`resolveByVersion` 的网络前置依赖（orchestrator.ts）是断网场景的结构性断点，认领必须前置于它；`readPendingUpdate` / `readPreloadedUpdateRaw` 均为纯本地读，前置无副作用。

**D2 认领校验：asset.name + size + sha256 三重匹配，sha256 缺失拒绝认领**

- 选择：目录内仅当存在与基准 release 的**当前平台** asset（`pickPlatformAsset(pending)`，跨平台包不参与匹配）**同名**文件，且 size 一致、sha256 一致时认领：`renameSync` 移入 `<update>/<asset.name>` + `writePreloadedUpdate` 落登记。落盘噪音控制：目录为空或无同名候选（常态）**不落盘**；存在同名候选但 size/sha256 不符才落盘 `source: manual-claim` + 具因。
- 被否：仅文件名匹配——同名不同内容是直接的恶意替换/损坏文件安装面；仅 size 匹配同理。
- 证据：sha256 匹配即内容与官方产物一致（抗碰撞），认领后文件与 app 自下载产物不可区分，installUpdate 的既有防线（m11 `validateRelease` + 脚本内 sha 校验）全量复用。sha256 缺失（异常 release / digest 未返回且 manifest fallback 失败）时拒绝认领并落盘，宁可不认不可装错；`size` 缺失按 size mismatch 同向拒绝（三重校验之一无法执行即无从证明一致）。
- 并发幂等：Electron 同 channel handler 可并发。认领内 `renameSync` 抛 `ENOENT`（源文件已被并发认领移走）视为「已被认领」按成功处理（幂等），不落 mismatch。短路①②位于 handler 入口（`await preDownloadPromise` 之前），与后台预下载存在真实并发窗口：认领与预下载先后各调一次 `writePreloadedUpdate`，最后写者胜。交错场景声明（接受，取舍如下）：认领写 0.9.11 → 预下载以 0.9.12 完成覆写 → install 从 preloaded 读时装 0.9.12 而 UI 显示 0.9.11——装上的仍是更新的官方校验产物（无安全危害，语义为「顺手升到最新」），违背「用户确认哪个版本就装哪个版本」的严格动机属低频低害（窗口 = 预下载完成恰好落在认领写入与用户点安装之间）；缓解：`update:install` 响应增加 `version`（实装版本）字段，renderer 进入 restarting 态前对齐 `state.latestRelease`，UI 与实装归一。被覆写登记抛下的孤儿 zip 文件**接受残留**（不在本次 scope 加清理器，交由用户/后续升级工作目录（getUpdateDir()）清理策略处理）。

**D3 认领的版本基准：`pending-update.json`（上次成功检测的持久化 release）**

- 选择：认领基准 release 取自 pending（含完整 assets + sha256）；download 入口认领要求 `pending.version === payload.version`（防降级安装旧版），启动链认领直接以 pending 为准。
- 被否：认领时 force check GitHub 拿权威 release——认领场景恰恰是网络不可用，引入网络依赖即失去逃生通道意义。
- 已知边界（固有，须在 UI 文案引导）：①从未成功检测过（pending 为空）则无法认领（无 sha256 基准）——全新安装且网络全断的边缘场景，落盘记录即可；②**pending 落后于实际 latest**（断网期间发布了更新版本）时，用户手动下载的更新版本 zip 与 pending 的 asset 名（含版本号）不同 → 拒认。这是「sha256 基准只能来自 app 已知 release」安全模型的固有代价，宁拒不猜。设置页手动通道文案须注明「仅支持 app 已提示的新版本」；恢复联网后 check 刷新 pending 即可认领新版本。

**D4 引擎降级触发矩阵（连接建立失败降级且记忆；瞬时类只降级不记忆；HTTP/磁盘/总超时不降级）**

| undici 失败形态 | 降级 curl？ | 置 enginePreference flag？ | 理由 |
|---|---|---|---|
| 连接建立失败：`EHOSTUNREACH` / `ECONNREFUSED` / `ENETUNREACH` / `UND_ERR_CONNECT_TIMEOUT` | **是** | **是** | 授权拦截与代理拒绝属进程生命周期级稳定状态（实测含重启后复现），记忆有效。授权拦截的丢包型呈现即 connect timeout（拒绝型为 `EHOSTUNREACH`），两者同源，必须同档 |
| 瞬时连接类：`ECONNRESET` / `ETIMEDOUT` / `ENOTFOUND` | 是 | 否 | CDN 抖动/DNS 瞬断是国内常态（多段下载单 part 中招概率不低），一次瞬时错误即永久放弃 undici 多段并发是过度泛化 |
| 流中断：`UND_ERR_SOCKET` / body timeout / 建立后断开 | **是**（下载路径，curl `-C -` 续传） | 否 | 不同实现栈或能恢复；sha256 终校验兜底内容正确性 |
| HTTP 状态错误（403 / 404 / 5xx，服务器已响应） | 否 | 否 | 与引擎无关（对齐检测路径「HTTP 错误不触发降级」既有语义）。**curl 引擎下经 `-f` 表现为 exit 22 的 CurlFetchError（携带 httpStatusCode）上抛而非返回 result——调用方须据此重建「服务器已响应」类既有语义，见 D8 交互规则** |
| 磁盘错误（`ENOSPC` / `EACCES`） | 否 | 否 | 换引擎不解决磁盘问题 |
| AbortError 总超时 | 否 | 否 | 总预算已耗尽，curl 同样会超时 |

**D5 进程级引擎记忆：仅连接建立失败置位，重启复位**

- 选择：`upgrade-fetch` 模块内 `enginePreference` 标志；置位后 downloadAsset 直接走 curl 下载、后续 fetch 跳过 undici 等待。**置位判定逻辑收敛在封装内部**：只有当本次 undici 失败经 D4 分类属「连接建立失败」档时才置位；瞬时类/流中断仅本次降级，不置位（下次调用重探 undici）。`upgradeFetch` 提供调用方声明「本次调用不参与置位」的选项（testProxy 使用：设置页试错探针不污染进程级记忆）；该选项为「不读不置」双语义——置位判定的 flag 分流也被绕过，探针每次完整重探双引擎，信息量完整。进程重启复位（签名/授权/网络状态可能变化，重启后重探）。
- 被否：每次调用都先试 undici——授权坏场景每次多付一次失败延迟（EHOSTUNREACH 快速失败虽 <2s，但 probe + part + 单段多次叠加可感知）；全部错误码都置位——见 D4 瞬时类反例（多段被单 part 抖动永久误杀）。
- 证据：授权失效是进程生命周期级的稳定状态（实测含重启后仍失败），连接建立失败类与之同构；瞬时类不是。

**D6 curl 调用规格：参数数组 spawn + 平台绝对路径 + 重定向与超时语义对齐**

- 路径：macOS `/usr/bin/curl`（系统自带，Apple 签名）、Windows `curl`（Win10+ System32）、Linux `curl`（PATH 解析；**缺失时引擎降级不可用，D10 下载链自动回退 undici 直连，不因 curl 缺失丢失直连兜底**）。
- `spawn(path, [args])` 数组传参不走 shell，URL/代理参数来自受控配置，无注入面。
- 关键 flags：**`-L`（必带——GitHub release URL 实测 302 两跳至 CDN 签名 URL，不带 `-L` 时 curl 引擎拿到重定向页、sha256 必挂；undici fetch 默认 `redirect:'follow'`，必须对齐）**、**`-f`（HTTP ≥400 时 exit 22 且不输出 body——缺失时错误页会写入 `.downloading` temp，被 sha256 失败掩盖真实原因；与 `-w` 不冲突，exit 22 时 `%{http_code}` 仍输出最终码；注意 `-f` 使 HTTP ≥400 以引擎层失败上抛而非返回 result，`CurlFetchError.httpStatusCode` 供调用方重建既有 HTTP 语义——限流退避 / testProxy「任何响应算成功」准绳在两引擎下等价，重建责任归调用方，见 D8）**、probe 用 `-I -L`（HEAD 跟随重定向后取最终响应头）、`-w '%{http_code}'`（语义为**跟随重定向后的最终状态码**，与 undici fetch `response.status` 对齐）、`-x <proxyUrl>`（代理，含凭证形态 `http://user:pass@host:port`）、`--connect-timeout 10`（对齐检测 10s）、`--speed-limit 1 --speed-time 30`（30s 无有效字节中止，对齐 undici `IDLE_TIMEOUT_MS=30s`）、下载路径 `-C - -o <temp>`（断点续传，以输出文件当前大小为起点，与 undici 侧 statSync 口径一致）+ 无外层总墙钟（timeout-slow-flow-wallclock D1：原总时长上限 1h 已删除——连接与传输停滞由 `--connect-timeout 10` + `--speed-limit 1 --speed-time 30` 覆盖，exit 28 为唯一超时出口，传输持续则不被杀）。
- 小请求（GET/HEAD）body 获取：`-D <headerTmpfile>`（headers 落文件）+ body 落第二个临时文件，避免 headers/body 混流解析；用后清理。
- exit code 映射（D8）：`7` 连接失败、`28` 超时（connect-timeout / speed-time 双成因——curl 未使用 --max-time，一致性审查 DE1 清理三成因残留）、`33` HTTP range error（`-C -` 续传被服务器以 200 拒绝）、`35`/`56` SSL/接收错误、`22` HTTP 状态错误（`--fail` 语义）。**`33` 的恢复动作：删除 temp 文件后从头下载一次**（等价 undici 路径「200 回退覆盖写」语义）。
- 进度：下载路径 watch `statSync(temp)` 文件大小（500ms 轮询）推原始字节数（引擎执行体职责），百分比折算与节流由 downloadAsset 编排层复用 `createThrottledProgress(onProgress, asset.size)`（总量 = `asset.size`）完成——两层分工，单段 undici 路径复用同一节流函数。
- 凭证出现在 argv 的安全评估：safeStorage 可用时凭证在磁盘为密文，argv 形态相对磁盘确有增量暴露（密文→明文）；但同 uid 威胁模型下攻击者已有更强手段（直接改 proxy-config.json、进程注入），该增量风险可接受。
- 子进程生命周期：curl 非 detached spawn，main 进程 `before-quit` 时 kill 未结束的 curl 子进程（防孤儿进程在 app 退出后继续占用带宽；内容正确性无风险——半下载文件本就由 `.downloading` 后缀 + sha256 兜底）。
- 下载完成后的 `resume-state.json` 清理归属：统一由 `downloadAsset` 校验链前执行（undici / curl 两引擎同点清理，不散落）。

**D7 多段下载与 curl 的关系：探测引擎为 curl 时直接放弃多段**

- 选择：multipart probe（HEAD）经 `upgradeFetch` 返回 `usedEngine`；probe 用了 curl → 本次放弃多段，直接整文件 curl 下载（多段是加速优化，跳过不影响正确性；瞬时类导致的单次 probe 降级也接受本次单流——下次下载因 flag 未置而重探 undici 多段）。**是否置 flag 由 `upgradeFetch` 内部按 D4 分类判定**（undici 失败属连接建立失败档才置；瞬时类不置），probe 调用方不做置位决策。多段 part 中途失败 → `downloadMultiPart` 现有语义整批放弃（`RangeNotRespectedError` 降级单段 / 其他错误上抛）→ 上抛的错误按 D4 分类，连接建立失败类置 flag 并降级 curl 从头下载（sha256 兜底）。
- 被否：为 multipart 的每个 part 实现 curl 版 Range 下载——授权坏场景在 probe 阶段就分流（probe 失败则根本进不了多段），part 级 curl 化收益极低、复杂度高。
- 降级重下时 renderer 进度条从当前百分比归零重来（190MB 场景可感）——**声明为预期行为**：降级是故障兜底而非常态，进度单调守卫属可选 UI 增强，不进本次 scope。

**D8 错误与落盘扩展（不动 UpdateErrorCode 枚举，扩展诊断字段 + 新增降级落盘点）**

- `appendUpdateError` 条目新增 `engine?: 'undici' | 'curl'` 字段（本地类型，不入 shared 枚举）。
- **单引擎失败被另一引擎兜住时**（降级成功，无用户可见错误）：由 `upgradeFetch` / `downloadViaCurl` 在降级发生点直接 `appendUpdateError` 落盘 `source: 'engine-fallback'` + `engine`（失败引擎）+ 原始错误分类——这是 A1/A5/A6 验收的可观测依据；不依赖 handler catch（降级成功时 handler 不进 catch）。
- 双引擎均失败时对用户报**undici 错误的分类**（undici 错误携带 errno，`classifyProxyUnreachable` 等精准分类只在 undici 侧成立），curl 侧结果仅作 `engine` 落盘字段——理由：curl exit 7 覆盖 `ECONNREFUSED`/`EHOSTUNREACH`/`ENETUNREACH` 全部连接失败，无 errno 级区分，若以 curl 结果分类会把「代理未启动（ECONNREFUSED）」误报为「本地网络权限（EHOSTUNREACH）」。
- 认领失败落盘：`source: 'manual-claim'` + `rawCause: 'size mismatch' | 'sha256 mismatch' | 'sha256 missing'` 等具因（落盘噪音控制见 D2）。
- testProxy 双引擎均失败才报错；单引擎失败即降级成功时返回成功（用户测代理的目的是「升级能不能走」，curl 能走 = 能升级）。`UPDATE_PROXY_UNREACHABLE` 等用户文案链路按上述「报 undici 分类」规则保持不变。
- **curl 引擎的 HTTP 状态交互规则**（`-f` 与既有语义的桥接，调用方重建责任）：① release-checker 对携带 `httpStatusCode` 403/429 的 `CurlFetchError` 重建 `ReleaseRateLimitedError`（RM2.3 限流退避在两引擎下等价成立）；404/5xx 按「服务器已响应」收口（null / 非 2xx 语义），不触发通道维度直连重试；② testProxy 收到携带 `httpStatusCode` 的 `CurlFetchError` 视为「代理可达、服务器返回了 HTTP 状态」→ `success:true`（「任何 HTTP 响应算代理可用」准绳两引擎等价）。
- 降级点落盘主体分层：小请求（检测 / probe / testProxy）由 `upgradeFetch` 在内部降级点落盘；下载路径的降级落盘由 downloadAsset 编排层完成（downloadViaCurl 单次执行无法感知「失败被后续步骤兜住」）。`engine-fallback` 双向均落：undici→curl 与「curl 不可用被 undici 直连兜住」（D10 第三步反向）都记 `engine` = 失败引擎；curl+代理 exit 7 被直连兜住另落 `source:'download' + engine:'curl'`（通道级降级记录）。双失败对外报 undici 分类的限定：有降级上下文（undiciError 存在）时才报 undici 分类，flag 分流路径无 undici 错误上下文时按 curl 映射错误对外。

**D9 手动目录的 UI 引导（settings 页常驻 + 错误指引双入口）**

- 设置页更新卡片新增折叠区：「手动升级通道——将安装包 zip 放入 `<update>/manual/`（仅支持 app 已提示的新版本）」+ 路径展示 + 「打开目录」按钮（首次点击先 `mkdirSync` 确保目录存在，再 `shell.openPath(manualDir)`）。下载/代理类错误 suggestion 文案追加「或手动下载后放入该目录重试」。
- 被否：错误弹窗里做「导入」按钮交互——错误场景 UI 越轻越好，路径指引 + 目录常驻展示已闭环。

**D10 下载路径降级编排与最坏延迟预算**

- 编排（downloadAsset 内，通道维度 × 引擎维度的收敛次序）：`undici+代理 →（连接建立失败置 flag）curl+代理 →（curl 亦连接失败，判定代理整体不可用）直连兜底`。第三步引擎按可用性选择：curl 可用 → curl 直连（flag 置位后统一 curl 的一致性）；**curl 不可用（spawn `ENOENT`，如 Linux 最小环境）→ undici 直连**——该场景 flag 仅因私网代理连接失败置位，undici 对公网直连仍可达（授权只拦私网），回退无矛盾，保证「无 curl 环境」下矩阵第 2 行（代理挂 + 直连可达）仍被覆盖。**curl 可用性判定对整条链生效**：任一 curl 形态（第二步或第三步）spawn `ENOENT` 即跳过全部 curl 形态，直连兜底按该可用性结果选引擎（curl 缺失的 spawn 失败是即时零开销，最坏延迟预算不变）。
- 最坏延迟：三步各 `--connect-timeout 10s`，理论最坏 30s 后才开始传输；正常路径（第一步成功）零额外开销。检测路径组合：checker 既有「代理→直连」两步 × 每步内引擎降级两试 = 最坏 4 试（flag 置位后收敛为 2 试）；瞬时类不置 flag（D4）避免了抖动场景的反复多试。
- 声明取舍：故障场景多付 10-30s 换可达性，正常场景零开销——可接受。

### 3.4 终态组件与数据流

```
update:download(version)
  ├─① readPreloadedUpdateRaw（本地）且 version 严格相等 → 返回 downloaded      ← 断网可用（新增短路）
  ├─② readPendingUpdate（本地）且 pending.version===version
  │     → tryClaimManualAsset(pending)（扫描 manual/，平台 asset name+size+sha256）
  │         ├─ 命中：move + writePreloadedUpdate → 返回 downloaded             ← 零网络（新增）
  │         └─ 未命中：静默跳过（同名候选校验失败才落盘 source=manual-claim）
  └─③ resolveByVersion（网络）→ readPreloadedUpdate(release) → downloadUpdate
        └─ downloadAsset
            ├─ enginePreference==='curl' → downloadViaCurl（-f -L -C -，代理）
            ├─ probe（upgradeFetch：undici→curl，返回 usedEngine，降级点落盘 engine-fallback；
            │    flag 置位与否由封装按 D4 内部判定——连接建立失败置，瞬时类不置）
            │    ├─ usedEngine==='curl' → 本次跳过多段 → downloadViaCurl（代理）
            │    └─ multipart（undici parts）─ 连接建立失败 → 置 flag → downloadViaCurl（代理）
            │                                    └ 瞬时类/流中断 → 降级单次，不置 flag
            └─ 单段（undici 流式）── 连接类/流中断 → 按类决定置 flag → downloadViaCurl（代理）
            ↘ downloadViaCurl 亦连接失败（exit 7）→ 判定代理不可用 → 直连兜底
                （curl 可用 → curl 直连；curl 缺失 ENOENT → undici 直连）
            ↘ 仍失败 → 报 undici 错误分类（engine 落盘）→ UpdateError
```

---

## 4. 验收

> 实施后在真实环境验证；每条回溯 §1 目标。A1/A2/A3/A4 使用 2026-08-30 事故机器（ad-hoc 签名 + 私网代理授权失效）作为黄金复现环境。

| # | 场景 | 步骤 | 通过标准 | 回溯 |
|---|------|------|---------|------|
| A1 | 授权失效自动恢复 | 事故机器上直接点「更新」（代理保持 manual 私网配置），同时开着代理服务端连接日志（或本机抓包） | 升级完成装上新版；update-error.log 出现 `source:'engine-fallback'`、`engine:'undici'` 的 `UPDATE_PROXY_UNREACHABLE` 记录且其后无失败记录；全程无用户额外操作 | G2 |
| A2 | 断网手动认领（启动链） | 联网时用浏览器下载与 app 已提示版本一致的 zip → 放入 `manual/` → 断开网络 → 启动 app | 启动期间代理服务端零连接（或抓包零请求到 GitHub 域）；升级按钮直接呈现「已下载，重启安装」态；点击后安装成功；命中的 zip 已从 `manual/` 移至 `<update>/` 且 `preloaded-update.json` 有该版本登记 | G1 |
| A3 | 断网手动认领（下载入口） | 断网 + 无 preloaded 启动（app 已提示新版本）→ 点「更新」 | 认领命中 → 直接进入 downloaded 态（不报网络错误）；安装成功 | G1 |
| A4 | 损坏文件安全拒绝 | **断网环境**：`manual/` 放同名字但截断的 zip → 点「更新」 | 认领被拒（update-error.log 出现 `source:'manual-claim'` + `rawCause:'size mismatch'` 或 `sha256 mismatch`）；不安装、不出现「已下载」态；后续行为与无手动文件时一致（断网 → 网络失败错误提示 + 手动下载指引） | G1（负面行为） |
| A5 | 正常网络回归 | 授权正常环境（直连可用）完整升级一次 | 全程 update-error.log 无任何新记录（含 `engine-fallback`），下载成功且引擎链路为纯 undici；进度 / 多段 / 断点续传行为与现状一致 | G3 |
| A6 | testProxy 降级 | 事故机器上设置页点「测试连接」 | 显示连接成功（落盘出现 undici 失败的 engine-fallback 记录，用户无感知） | G2 |
| A7 | Windows / Linux 定向检查 | Win10+：①`where curl` 确认 System32 curl.exe 存在；②制造代理不可达（代理地址填保留段）点「更新」。Linux：③最小 PATH（无 curl）环境下代理不可达点「更新」 | ①curl.exe 路径可 spawn（实施期手测留档）；②错误落盘含 engine 字段且错误分类来自 undici 侧 errno；③D10 第三步回退 undici 直连且下载成功（验证「无 curl 不丢直连兜底」）——exit code 7/28/33/35/56/22 映射正确性由单测覆盖 | G2 |

> 单元测试覆盖（实施层要求，非本层验收）：D4 降级触发矩阵逐行（含反例：HTTP 403 不触发 curl、瞬时类不置 flag、`UND_ERR_CONNECT_TIMEOUT` 置 flag、probe 瞬时降级不置 flag）、curl exit code 映射（含 22 的 `-f` 语义、33 的删 temp 重下）、curl spawn ENOENT 触发 D10 第三步 undici 直连回退、认领三重校验的正反例与并发幂等（renameSync ENOENT 视为成功）、download 本地短路的版本严格相等判定（0.9.11 payload vs 0.9.12 preloaded 不短路）、testProxy 调用不置 flag。

---

## 5. 下一层拆分

| 单元 | 内容 | 文件 | 备注 |
|------|------|------|------|
| U1 | `upgradeFetch` 封装：双引擎 + `enginePreference` flag（置位判定收敛在封装内，按 D4/D5 分类执行；提供「本次调用不参与置位」选项）+ curl exit code 映射 + 小请求（GET/HEAD）语义（`-f -L` / `-I -L` / headers 与 body 分文件）+ 降级点落盘 `engine-fallback` | `apps/electron/main/update/upgrade-fetch.ts`（新） | 依赖 net-errors / proxy-config / error-log；接口含 `usedEngine` 返回 |
| U2 | `downloadViaCurl`：spawn curl 整文件下载（`-f -L -C -` 续传 / speed-time 空闲中止 / statSync 进度 watch / 1h 总上限超时 kill / exit 33 删 temp 重下 / before-quit kill / spawn ENOENT 上抛供 D10 第三步引擎回退） | `apps/electron/main/update/curl-download.ts`（新） | 产出写 `.downloading` temp，交回现有 sha256 校验链；resume-state 清理由 downloadAsset 统一 |
| U3 | `download-asset.ts` 接入：flag 分流 + probe 换 `upgradeFetch` + 多段/单段失败降级编排 + D10 三步降级链（curl+代理 → 直连兜底，curl 缺失回退 undici 直连） | `download-asset.ts` | D5/D7/D10 的落点 |
| U4 | `release-checker.ts` 接入：`doFetchGitHubLatestRelease` **与 `doFetchManifestSha256`** 均换 `upgradeFetch` | `release-checker.ts` | 直连降级编排保留在 checker |
| U5 | `testProxyConnection` 接入：双引擎后才判失败 | `gateway/update-handlers.ts` | D8；调用 `upgradeFetch` 时声明不参与 flag 置位（试错探针不污染进程级记忆，见 D5/U1） |
| U6 | `manual-claim.ts`：目录扫描 + 三重校验 + move + 写 preloaded + mismatch 落盘（噪音控制见 D2） | `apps/electron/main/update/manual-claim.ts`（新） | 纯本地逻辑，无网络依赖 |
| U7 | handler 接入：download 入口本地短路前置（①②，版本严格相等）+ getPreloaded miss 后认领 + install 响应增加实装 `version` 字段 | `gateway/update-handlers.ts` | D1/D3 + D2 交错缓解 |
| U8 | renderer 衔接：下载失败 suggestion 追加手动路径指引、设置页手动通道区（路径展示 + mkdir + `openPath`）、install 返回后对齐实装版本、i18n 双语；install 返回形状类型（含 `version` 字段）提升到 `packages/shared/src/update.ts`（`UpdateInstallResult`），`apps/electron/preload/preload.ts` 与 `packages/renderer/src/lib/ipc.ts` 两处签名同步 | `useAppUpdate.ts` / `UpdateCheckCard.vue` / locales / `preload.ts` / `lib/ipc.ts` / shared `update.ts` | D9 + D2 交错缓解；无状态机改动（复用 downloaded 态） |
| U9 | `error-log.ts` 扩展 `engine` 字段 + `source: 'engine-fallback' / 'manual-claim'` | `update/error-log.ts` | D8 |

拆分依据：U1/U2/U6 是三个无 UI 依赖的纯逻辑新模块，可独立单测先行；U3-U5/U7 是各自单文件的接入改造，互不阻塞可并行；U8 收尾。验收顺序：A5 回归先行（保证不破坏现状）→ A1 → A2/A3/A4 → A6 → A7。

**待验证检查点（实施期门，探针失败则回改设计）**：

1. macOS 系统 curl 的 `--speed-limit 1 --speed-time 30` 实际中止行为与 undici idle 语义等价性（探针：限速代理下实测）。
2. 打包 app（launchd 环境）spawn `/usr/bin/curl` 绝对路径的可用性（探针：打包版实测一次 spawn + 下载 1MB）。
3. `statSync` 500ms 轮询进度的 UI 平滑度（450KB/s 实测网络下 190MB 全程观感）。
4. Windows `curl.exe` 对 `-w` / `--speed-limit` / `-L` 的支持（Win10 1809+ 自带版本应支持，实测确认）。
