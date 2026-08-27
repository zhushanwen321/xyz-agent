# 升级链路可观测性与代理体验修复 · 技术设计

> **一句话结论**：升级失败的根因（macOS 本地网络权限拦代理）已诊断清楚，但用户完全看不到原因——错误分类丢 cause、suggestion 在类型契约层被丢弃、renderer 无主动提示、磁盘零落盘。本设计打通「真实错误 → 用户可理解的中文提示 + 恢复指引」全链路，并补上代理连通性自检与检查更新的代理接入。

**层性质声明**：当前层 = 功能技术方案设计；下一层 = 可实施的代码任务（Wave 拆分）。涉及运行时行为、错误处理、数据流，准则 5/6/7 全部 P0 适用。

**修订记录**：v2——吸收对抗式审查（`update-observability.review.md`）6 must-fix + 9 suggestion：修正 toUserFriendly 机制描述（M1）、多段下载分类覆盖（M2）、预下载落盘（M3）、launchResult 改构造性拉取机制（M4）、状态联合补 rolled-back（M5）、Wave 类型清单修正（M6）及全部事实性修正。

---

## §1 背景目标

**SCQA**：

- **S（情境）**：太极（xyz-agent 桌面端）0.9.7 通过「侧边栏升级按钮」自升级到 GitHub Releases 上的 0.9.9。下载走 undici + 用户配置的代理（设置 → 更新 → 代理配置，`~/.xyz-agent/proxy-config.json`）。
- **C（冲突）**：用户代理 `192.168.1.202:7890` 是局域网地址，macOS 15+ 的「本地网络」隐私权限拦截了 app 到局域网的所有连接（实测 Electron 主进程 `EHOSTUNREACH`，0.1s 失败；系统 node 同代码 14.3MB/s 成功）。升级失败、测试代理失败，**但两处都只显示无信息量的通用文案**。
- **Q（问题）**：为什么配了代理、点了测试、点了升级，失败后既看不到原因也没有主动提示，排查只能靠猜？
- **A（答案）**：错误信息在链路上多处断——main 侧丢 `err.cause`（且多段下载路径完全无分类）、错误分类表缺权限场景、preload 与 renderer 两层类型契约丢 `suggestion`、无 toast 无落盘。本设计修复全链路 + 补两个体验缺口（hover 无版本号、检查更新不走代理）。

**系统是什么**（给未接触过升级模块的读者）：升级模块分三层——main 进程（`apps/electron/main/update/`：检查更新 release-checker → 下载 download-asset → 校验 → 平台替换脚本 updater.sh → 重启）、renderer（`useAppUpdate` 9 态状态机 + `UpdateButton` 角标 + 设置页 UpdatePage）、跨进程状态文件（`~/.xyz-agent/update/` 下 pending-update.json / preloaded-update.json / update-result.json，其中 update-result.json 是 self-healer 与替换脚本的 SSOT，状态值为 done/failed/rolled-back/no-op/replacing 五种）。

**设计目标**（从使用者体验倒推）：

| # | 目标 | 体验描述 |
|---|------|---------|
| G1 | 失败原因可见可懂 | 本地网络权限被拦时，用户在「测试连接」和「升级失败」两处都看到中文原因 + 具体恢复指引（系统设置路径），而不是通用「网络连接失败」或英文 `fetch failed` |
| G2 | 失败主动触达 | 升级失败不需要 hover 小图标才发现——toast 主动弹出错误摘要 |
| G3 | 版本上下文可见 | hover 升级按钮即知「当前 v0.9.7 → 新版 v0.9.9」，无需进设置页 |
| G4 | 成功有反馈 | 升级完成重启后，toast 告知「已升级到 v0.9.9」；升级中断被回滚后，重启也有告知 |
| G5 | 检查更新也走代理 | 代理模式下「检查更新」的 GitHub API 请求走代理（当前直连），代理不可用时自动降级直连不阻断 |
| G6 | 可事后取证 | 升级/测试/**后台预下载**失败落盘 `~/.xyz-agent/update/update-error.log`（JSONL），下次排查不用复现 |

**In-scope**：上表 G1-G6 对应的 main/renderer 改动。
**Out-of-scope**：① runtime/pi 子进程模型 API 通路的代理化（涉及 ENV_WHITELIST_PREFIXES SSOT 与 pi 生态行为，单独评估）；② 升级按钮交互重设计；③ macOS 权限问题的代码层规避（弹指引而非绕过，权限必须用户手动开）。

---

## §2 现状与问题分析

### 2.1 使用者视角的现状（真实例子）

**例 A：测试连接失败无原因**。设置 → 更新 → 代理配置已填 `http://192.168.1.202:7890`，点「测试连接」，1 秒后显示（UpdatePage.vue:136-140，i18n `testFailed: '代理连接失败: {msg}'`）：

```
代理连接失败: fetch failed
```

`fetch failed` 是 undici 外层 Error 的 message，真实原因在 `err.cause`（如 `Error: connect EHOSTUNREACH 192.168.1.202:7890`），`testProxyConnection` 的 catch 只取了外层（update-handlers.ts:105-108 `err instanceof Error ? err.message : String(err)`）。

**例 B：升级失败提示通用化**。点侧边栏升级按钮 → 0.1s 后失败 → 按钮角标变成小红点，**必须 hover 上去**才能看到错误浮层。单段下载路径下浮层内容是「网络连接失败」——`toUserFriendly()` 命中 UPDATE_NETWORK_FAILED 映射后返回的**映射表通用中文**（types.ts:161-186 `message: info.message`），无 EHOSTUNREACH 细节、无权限场景指引；多段下载路径（186MB 产物默认走多段，见断点 1b）下则是原始英文 `fetch failed`。两种路径都不可定位原因。

**例 C：hover 看不到版本**。hover 升级角标，浮层标题是「有新版本」（UpdateButton.vue:28 固定文案 `sidebar.update.newVersion`）+ release notes 正文，**没有版本号**——不知道要从哪个版本升到哪个版本。

**例 D：升级成功/回滚均无反馈**。升级替换完成后 updater.sh 写 `update-result.json status='done'` 并重启，新版本启动时 `cleanupCompletedUpdate()`（main.ts:280）直接消费终态并清理产物，用户不知道升级确实成功了；升级中断被 self-healer 回滚（写 `status='rolled-back'`）后重启回旧版，同样零反馈。

**例 E：检查更新不走代理**。release-checker.ts 的 `fetchGitHubLatestRelease()` 用全局 `fetch`（无 dispatcher），完全无视 proxy-config.json——用户以为配了代理全局生效，实际只有升级产物下载走代理。

**例 F：后台预下载静默失败**。预下载开关开启时，`update:check` 检测到新版会触发 `preloadUpdateSilently` 后台下载；其 catch 仅 `console.warn`（update-handlers.ts:152-165），无事件无落盘。在本诊断环境（权限被拦）里这是**每次检查更新都会发生的第一失败现场**，且完全不可见。

### 2.2 错误信息的物理数据流（现状）与断点

```
undici 连接失败
  │  err.message = 'fetch failed'          ← 外层无信息
  │  err.cause  = Error: connect EHOSTUNREACH 192.168.1.202:7890   ← 真实原因
  ▼
[断点1a] download-asset.ts:276 单段 fetch 分类：只 includes 匹配
        fetchErr.message（ECONNREFUSED/ENOTFOUND/ECONNRESET/ETIMEDOUT/ECONNABORTED）
        —— 匹配源是 message 而非 cause.code，EHOSTUNREACH 不在列表，
        兜底归 UPDATE_NETWORK_FAILED（raw message 丢失 cause）
[断点1b] download-asset.ts:647 downloadPart（多段下载的单段 fetch）：
        catch 只清理临时文件后原样 re-throw，无任何分类——raw undici 错误
        直达 handler else 分支（errorCode: undefined，message='fetch failed'）
  ▼
main catch → UpdateError.toUserFriendly()
  │  errorCode 命中映射表（8 个错误码，types.ts:63-104）→ 返回映射表的
  │  通用中文 message（「网络连接失败」）+ suggestion——message 无 cause 信息，
  │  且映射表没有「代理不可达/本地网络权限」场景；未命中（如 1b 路径
  │  errorCode undefined）→ 返回 this.message（英文技术串）
  ▼
win.webContents.send('update:error', {stage, message, errorCode, suggestion})
  │  （main 侧事件已携带 suggestion——丢失发生在下游类型契约层）
  ▼
[断点2] preload.ts:290 onUpdateError 类型声明 `{stage, message, errorCode}` —— suggestion 类型上被丢弃
  ▼
[断点2b] renderer lib/ipc.ts:289 onUpdateError 包装签名同样 `{stage, message, errorCode}` —— 同款丢弃在 renderer 适配层还有一份
  ▼
useAppUpdate onUpdateError：state.errorMessage = e.message
  │  [断点3] suggestion 未存入 state；UpdateState 无此字段
  ▼
[断点4] UpdateButton error 态：不 toast，错误浮层需 hover 才可见
  ▼
用户眼前：单段路径=「网络连接失败」（通用中文）；多段路径='fetch failed'（英文）
  ▼
[断点5-磁盘] 全链路无落盘：主进程 console.error 直接进虚空（GUI 进程 stderr 不持久化），
        预下载失败甚至只有 console.warn
```

### 2.3 根因分析

| 症状 | 根因 | 层 |
|------|------|----|
| 测试失败显示 `fetch failed` | testProxy catch 只读外层 message，cause 丢失 | main |
| 升级失败提示「网络连接失败」/`fetch failed` 均不可定位 | 分类只匹配 message 且无 EHOSTUNREACH；多段路径零分类；映射表无权限场景 | main |
| main 写好的 suggestion 用户看不到 | preload 与 lib/ipc 两层类型签名都缺 suggestion → renderer state 无字段 → UI 无渲染 | preload + renderer |
| 失败无主动提示 | useAppUpdate 只改 state，error 态视觉是小角标，无 toast；项目已有 useToast 基建未接入升级链路 | renderer |
| hover 无版本号 | UpdateButton HoverCard 标题只用固定文案，`state.latestRelease.version` 数据在但没渲染 | renderer |
| 成功/回滚无反馈 | update-result.json 终态在启动时被 cleanupCompletedUpdate 静默消费（返回 `Promise<void>`），无任何通知 renderer 的通路 | main + renderer |
| 检查更新不走代理 | release-checker 全局 fetch 无 dispatcher；代理配置当前唯一消费者是 download-asset | main |
| 无法事后取证 | 升级链路零落盘（~/.xyz-agent/logs/ 只有 runtime/pi 日志）；预下载失败仅 console.warn | main |

**已实测的环境事实**（探针，✅ 2026-08-26 本机）：

- P1 ✅ Electron 42 主进程 `net.connect('192.168.1.202', 7890)` → `EHOSTUNREACH`；同进程连公网 443 → 成功。系统 node 同代码连代理 → 成功。结论：macOS 本地网络权限拦截（bundle id `com.xyz-agent.app` 未授权）。
- P2 ✅ undici 7.28 + ProxyAgent + 该代理 GET 下载 186MB → 14.3MB/s。代码与代理本身无问题。
- P3 ✅ 直连 GitHub 下载 44KB/s（186MB 需 ~70 分钟，idle watchdog 30s 内即断流）。代理是刚需。
- P4 ✅ app.asar 内捆绑 undici 与本地一致（7.28.0），排除版本漂移。

### 2.4 术语定义

- **cause 链**：undici 的 fetch 抛错时，外层 Error 只带 `fetch failed`，真实网络错误（含 `.code` 如 `EHOSTUNREACH`）挂在 `err.cause`。下文「cause 提取」指逐层下钻 `err.cause?.code ?? err.cause?.message`。
- **本地网络权限**：macOS 15+ 隐私权限，app 访问局域网 IP 需用户授权；未授权时 connect 立即 `EHOSTUNREACH`（非超时，特征是 0.1s 内失败）。
- **单段/多段下载**：download-asset 的两条下载路径。产物 ≥10MB（MIN_MULTI_PART_SIZE）且远端支持 Range 时默认走**多段并行**（本设计的 186MB 产物常态路径）；probe 失败或断点续传时走单段。两条路径的 fetch 错误处理目前不一致（断点 1a/1b）。

---

## §3 解决方案

### 3.1 终态（使用者视角）

**场景 1：本地网络权限未开，点「测试连接」**（G1）

```
代理连接失败: 无法连接代理 (EHOSTUNREACH)
macOS 未授予「本地网络」权限（代理在局域网时常见）。恢复指引：系统设置 → 隐私与安全性 → 本地网络 → 允许「太极」，重启应用后重试
```

（UI 上为两行，样例即实况：第一行 `text-danger` 错误摘要，message 经存量 i18n 键 `testFailed` 模板包装为「代理连接失败: {msg}」（UpdatePage.vue:142）；第二行 `text-muted` 指引，是映射表 suggestion 单独一行渲染——「可能原因 + 恢复指引」两段已合并为一段（types.ts:95-99 UPDATE_PROXY_UNREACHABLE 条目）；不再是单行英文串。）

**场景 2：同环境点升级按钮**（G1+G2）

- toast 主动弹出（error 型，8s）：`升级失败：无法连接代理 (EHOSTUNREACH)`；
- 同时侧边栏角标进入 error 态，hover 浮层显示完整 message + suggestion 两段。

**场景 3：开权限后重试**（恢复路径）

`tccutil reset LocalNetwork com.xyz-agent.app`（或系统设置开开关）→ 重启 → 测试连接变绿 `代理连接成功` → 点升级 → 下载进度条 13MB/s ≈ 15s → 确认安装 → 重启。

**场景 4：升级成功重启后 / 升级中断回滚后**（G4）

- 新版本启动数秒内 toast（info 型，4s）：`已升级到 v0.9.9`。
- 升级中途被中断（断电/强杀）、下次启动 self-healer 回滚到旧版后：warning toast `上次升级未完成，已恢复到 v0.9.7`。

**场景 5：hover 升级角标**（G3）

```
发现新版本 v0.9.9
当前 v0.9.7 → v0.9.9
（release notes 正文，同现状）
```

**场景 6：代理开启时检查更新**（G5）

检查更新请求走代理（代理端可见 api.github.com 流量）；代理挂掉时 ≤2s 降级直连重试一次，检查更新功能不因代理故障而瞎。

### 3.2 方案对比

**总体架构方案**（错误链路怎么修）：

| 方案 | 长期架构 | 短期成本 | 风险 | 裁决 |
|------|---------|---------|------|------|
| **A. 全链路打通：main 收敛 cause 提取（含多段路径）+ 新增错误码 + suggestion 全链路透传 + toast + 落盘** | 错误分类 SSOT 收敛到 update 层一处，main/preload/renderer 三层契约用 shared 类型约束，后续新错误场景只加映射表条目 | 中（5 个文件层，见 §5） | 低；各点独立可验收 | ✅ |
| B. 只修 testProxy 单点（catch 里取 cause 拼进 message） | 治标：升级链路的同类断点依旧；下一个环境问题还是通用文案 | 低 | 高——症状消失根因链还在，§2.2 断点 1a/1b/2/2b/3/4 原样保留 | ❌ 若用它：场景 1 修复，场景 2 依旧是「网络连接失败」+ 无 toast，§2 例 B 复发 |

**D2 相关：EHOSTUNREACH 如何映射为「本地网络权限」提示**：

| 方案 | 长期架构 | 短期成本 | 风险 | 裁决 |
|------|---------|---------|------|------|
| **A. 条件判定：macOS + err.code=EHOSTUNREACH + 代理 URL host 是私网地址 → 给权限指引文案；公网代理或非该错误码 → 通用「无法连接代理」话术（附错误码后缀）** | 精确；公网代理 EHOSTUNREACH（路由问题）不会被误导去开权限 | 中（一个 isPrivateHost 工具函数 + 映射条件） | 低；误判率仅剩「私网代理但权限已开」场景，此时文案说「可能原因」，不武断。已声明局限：hostname 形式的代理（如 `nas.local`）不解析 DNS，落通用文案（见 D2） | ✅ |
| B. 无条件：所有 EHOSTUNREACH 都提示开权限 | 简单 | 低 | 公网代理路由不可达时误导用户去开无关权限，破坏指引可信度 | ❌ |

**D5 相关：成功/回滚反馈的数据通路**：

| 方案 | 长期架构 | 短期成本 | 风险 | 裁决 |
|------|---------|---------|------|------|
| **A. renderer 启动主动 invoke `update:getLaunchResult`，main 侧一次性缓存 + consumed 标志** | invoke 响应不可能丢失（请求-响应有构造性送达保证）；去重由 main 单点（consumed 标志）保证，与 renderer 多入口解耦 | 低（一个 handler + module 变量） | 低 | ✅ |
| B. main 冷启动推 `update:launchResult` 事件 | 与 update:progress 推送范式对称 | 低 | 高——cleanupCompletedUpdate 在 bootstrapMainWindow **之前**跑（main.ts:277-284），窗口尚不存在；即便缓存到 did-finish-load 后发送，renderer 订阅建立时机（首个 useAppUpdate 消费者 setup）与发送先后无构造性保证，事件可能发进虚空 | ❌ 若用它：场景 4 完全押在无法构造性证明的时序上 |

**D6 相关：release-checker 代理接入策略**：

| 方案 | 长期架构 | 短期成本 | 风险 | 裁决 |
|------|---------|---------|------|------|
| **A. 代理优先 + 失败降级直连（仅 mode=manual/system 且解析出代理 URL 时）** | 复用 resolveProxyUrl SSOT；代理故障不阻断检查更新（降级路径保底） | 低（一个 dispatcher 参数 + 一次重试） | 低；降级路径与现状行为等价 | ✅ |
| B. 纯代理不降级 | 语义「用户明确配代理就尊重」 | 最低 | 高——代理挂了检查更新全瞎，比现状（直连可用）还倒退 | ❌ |
| C. 直连优先失败再走代理 | 与用户意图相反（配代理通常因直连差） | 低 | 慢路径成为常态（先吃 10s 直连超时） | ❌ |

### 3.3 关键决策与权衡

**D1：cause 提取与网络错误分类收敛为共享函数，覆盖全部三条 fetch 路径（选定）**
- **采用**：新增 `apps/electron/main/update/net-errors.ts`：`extractNetErrorCode(err): string | undefined`（逐层下钻 `err.cause?.code ?? err.cause?.message` 前缀匹配）+ `classifyProxyUnreachable(err, proxyUrl): boolean`。接入点三处：① download-asset 单段 fetch 的内联分类（:258-300）改调它；② **downloadPart（:647）catch 增加「先经 extractNetErrorCode 分类为 UpdateError 再抛」**（downloadMultiPart 外层 catch 保持清理职责，分类在 downloadPart 内完成，避免多层包装漂移）；③ testProxyConnection。现有字符串匹配列表（ECONNREFUSED 等 5 项）保留，新增 EHOSTUNREACH 分支。
- **被否**：各 catch 点内联取 cause——多处重复实现必然 drift（本项目已有先例：B-1 代理凭证加解密双实现 drift 教训，见 proxy-config.ts 头注释）。
- **证据**：download-asset.ts:258-300 单段内联分类；:640-660 downloadPart 无分类只清理重抛；:700-710 downloadMultiPart 同样原样 re-throw；update-handlers.ts:105-108 testProxyConnection catch 无分类。
- **效果**：G1 的前提——同一个错误码在全部四个入口（测试/单段下载/多段下载/预下载）产生同一个用户文案。

**D2：新增错误码 `UPDATE_PROXY_UNREACHABLE`（选定）**
- **采用**：types.ts 的 UpdateErrorCode 联合类型 + UPDATE_ERROR_MESSAGES 映射表加条目，message 统一模板「无法连接代理 (EHOSTUNREACH)」（与 §3.1 场景 1、§4 A1 一致）。判定条件（承接上表 A 方案）：`process.platform === 'darwin' && code === 'EHOSTUNREACH' && isPrivateHost(proxyUrl)` → message「无法连接代理 (EHOSTUNREACH)」+ suggestion「系统设置 → 隐私与安全性 → 本地网络 → 允许『太极』后重启应用」。isPrivateHost 覆盖 IPv4 RFC1918（10/8、172.16/12、192.168/16）+ IPv6 ULA（fc00::/7）+ loopback；**已声明局限**：hostname 形式的代理（`nas.local`、DDNS 域名）不做 DNS 解析（引入解析即引入新失败面与延迟），落通用「无法连接代理」文案——文案仍可行动（提示检查代理与权限），只是少了精确指引。不满足条件（公网代理/其他平台）的 EHOSTUNREACH 错误分类归 UPDATE_NETWORK_FAILED，但用户可见话术分通路：**testProxy 场景统一准绳 = 始终代理语境话术 + message 附错误码后缀**——message 用「无法连接代理 (EHOSTUNREACH)」，suggestion 提示检查代理地址与网络（不加权限精确指引，与 A4 反向验证一致）；升级/下载路径维持 UPDATE_NETWORK_FAILED 映射表通用网络文案。此措辞是 D2 正文、§3.2 表 A 与 §4 A4 三处的共同准绳（testProxy 分支话术与当前实现的代码侧对齐由后续任务跟进，本文档为准绳 SSOT）。
- **被否**：复用 UPDATE_PROXY_ERROR（现语义是「代理认证失败 407」，混入可达性问题会让 407 的排查指引污染权限场景）。
- **证据**：types.ts:89-93 UPDATE_PROXY_ERROR 现有映射（现表 8 个错误码）；探针 P1（局域网 EHOSTUNREACH 特征）。
- **效果**：G1。testProxy 与三条下载路径共用此码。

**D3：suggestion 全链路透传（选定）**
- **采用**：shared 的 update.ts 新增 `UpdateErrorPayload` 类型 `{stage, message, errorCode?, suggestion?}`；preload.ts onUpdateError 类型签名改用它；**renderer 侧 `lib/ipc.ts:289` onUpdateError 包装签名同步**（断点 2 的同款类型丢弃在 renderer 适配层还有一份）；testProxy 返回类型同步扩为 `{success, code?, message?, suggestion?}`（preload.ts:155 与 lib/ipc.ts:328、api/domains/settings.ts:177 三处）；useAppUpdate 的 state 增 `errorSuggestion` 字段；UpdateButton error 浮层 + toast 都渲染两段。
- **被否**：把 suggestion 拼进 message 字符串（`\n` 分隔）——类型契约撒谎，后续消费方无法分离样式（指引行要 text-muted 弱化）。
- **证据**：§2.2 断点 2/2b；preload/index.d.ts 为 type-only re-export（改 preload.ts 自动跟随，无需单独改）。
- **效果**：G1/G2 的 UI 呈现基础。

**D4：失败 toast 触发点在 useAppUpdate 的 onUpdateError 回调（选定）**
- **采用**：useAppUpdate（module-level 单例）收到 update:error 即调 useToast().error(摘要)。摘要 = message（此时已是中文）；suggestion 太长不进 toast，留在 hover 浮层/设置页。
- **被否**：UpdateButton 组件层 toast——组件可能在 split-view / 设置页等多实例挂载，会重复弹；composable 单例才与「全应用共享 state」语义一致（订阅经 refCount 单化，toast 单次弹出有构造性保证）。
- **证据**：useAppUpdate.ts 文件头单例范式注释；useToast 已有 MAX_IN_FLIGHT=5 限流与 droppedCount 防风暴。
- **效果**：G2。

**D5：成功/回滚反馈经 renderer 主动 invoke + main 一次性缓存（选定）**
- **采用**：`cleanupCompletedUpdate` 返回值从 `Promise<void>` 扩展为 `Promise<{status, version} | null>`（读到非 no-op 终态时返回；no-op 不通知）；main.ts 启动序列将返回值存入 module 级缓存变量。新增 `update:getLaunchResult` handler：返回缓存值并**立即清空**（consumed 一次性标志，去重由 main 单点保证）。renderer useAppUpdate 初始化（首个消费者 setup，Sidebar 挂载即触发，早于 30s 自动检查）invoke 一次：status='done' → info toast「已升级到 v{version}」；'failed' → warning toast「上次升级未完成」；**'rolled-back' → warning toast「上次升级未完成，已恢复到 v{version}」**（self-healer 回滚写的是 rolled-back 而非 failed，见 update-self-healer.ts:96-99/145-152）。
- **被否**：方案对比 B（冷启动推送事件）——时序无构造性保证。
- **证据**：main.ts:277-284 启动序列（cleanup 在窗口创建之前，推送必丢）；update-self-healer.ts:207 现返回 void；updater-script.ts:200 done / :162/187/233/255 failed 写入点。
- **效果**：G4（含回滚告知，场景 4 两分支）。
- **接管副作用枚举**：本决策不动 cleanupCompletedUpdate 的清理职责，只在其返回路径上加只读信息；update-result.json 的消费顺序（maybeRollback → cleanup）不变；缓存变量生命周期 = 进程内一次性（app 不重启则不再重复 toast）。

**D6：release-checker 接代理 + 降级直连（选定）**
- **采用**：fetchGitHubLatestRelease 构造 options 时读 readProxyConfig() → resolveProxyUrl() → 有则构造 ProxyAgent dispatcher 传入 fetch；fetch 失败（非 HTTP 错误）且 dispatcher 存在时，用无 dispatcher 的直连重试一次。10s 超时各一次（总最坏 20s，与现状单次 10s 同量级；EHOSTUNREACH 类快速失败下降级延迟 <2s）。sha256 的 manifest.json fallback 同策略覆盖：fetchManifestSha256/doFetchManifestSha256 实现了同款代理优先 + 直连降级（仅网络错误才降级重试一次，HTTP 非 200 直接返回 null 不重试；代码注释自述「与 fetchGitHubLatestRelease 同策略」，见 release-checker.ts:322-349/:353）。
- **被否**：方案对比 B/C。
- **证据**：release-checker.ts:184-204 现全局 fetch 无 dispatcher；resolveDispatcher 已有同构实现（update-handlers.ts:46）可提取复用。
- **效果**：G5。
- **运行时断言（探针）**：实施后本地 `nc -l 7890` 监听可见 `CONNECT api.github.com:443` 请求行（ProxyAgent 对 https 目标发 CONNECT）；⛔ 实施期门。

**D7：update-error.log JSONL 落盘（选定）**
- **采用**：main 侧新增 appendUpdateError(entry)（update/constants.ts 加 `UPDATE_ERROR_LOG = join(UPDATE_DIR, 'update-error.log')`）。落盘点五处：testProxyConnection 失败、三个 update:* handler（download/install/perform）的 catch、**后台预下载 preloadUpdateSilently 的 catch（source: 'preload'——本诊断环境每次检查更新都会静默失败的第一现场）**、launchResult 'failed'/'rolled-back'。entry 结构 `{at, source, stage, errorCode, rawCause, proxyUrl?}`。rawCause 取得路径：UpdateError 扩展 `readonly rawCause?: string`（D1 的 net-errors 包装构造 UpdateError 时从 err.cause 提取注入）；proxyUrl 由 append 侧 `resolveProxyUrl(readProxyConfig())` 现取（文件读，成本可忽略）。轮转：超 512KB 重命名为 update-error.log.1（覆盖旧 .1），最多两份。
- **被否**：复用 electron-runtime-stderr.log（该文件是 runtime 子进程 stderr 汇聚，主进程 console 不入；语义混装）。也否「只 console.error 依赖用户开终端」——GUI app 无终端。
- **证据**：§2.2 断点 5；logs/ 目录现状（只有 runtime/pi 日志）；update-handlers.ts:143-166 preloadUpdateSilently catch 仅 console.warn。
- **效果**：G6。
- **错误恢复**：落盘失败（EACCES 等）静默跳过——日志失败不能阻断升级主流程，只 console.error 兜底。

**D8：hover 版本号（选定）**
- **采用**：UpdateButton HoverCard 标题行 `{{ t('sidebar.update.newVersionWithVersion', { version: state.latestRelease?.version }) }}`，副行 `{{ t('sidebar.update.versionTransition', { from, to }) }}`。当前版本来源：**现有 `__APP_VERSION__` 全局常量**（vite.config.ts:23 从 apps/electron/package.json 注入；useAppUpdate.ts:401 restorePreloadedUpdate 已在用），无需新 IPC。
- **被否**：只显示目标版本无「当前→目标」——用户仍需去设置页查当前版本（例 C 的原始抱怨）。也被否新增 getVersion IPC——现成通道已满足。
- **证据**：UpdateButton.vue:28 现标题；确认安装 Dialog 已用 `state.latestRelease?.version`（UpdateButton.vue:141-142）。
- **效果**：G3。

---

## §4 验收

> 三要素：场景 / 步骤 / 通过标准。A1-A4、A6-A8 为真实环境（打包 app + 真实代理 + 真实 GitHub），非单测非 mock；A5 为 UI 渲染层验收（走 dev mock，网络真实性已由 A1-A4 覆盖）。单测补充覆盖分类函数与类型契约，但不作为验收依据。

| # | 场景 | 步骤 | 通过标准 | 回溯 |
|---|------|------|---------|------|
| A1 | 本地网络权限未开（当前环境即满足：`tccutil reset LocalNetwork com.xyz-agent.app` 后重启 app） | 设置 → 更新 → 代理 `192.168.1.202:7890` → 点「测试连接」 | ≤3s 显示两行中文：摘要为「无法连接代理 (EHOSTUNREACH)」、指引含「本地网络」路径；不是 `fetch failed` | G1 |
| A2 | 同 A1 环境 | 点侧边栏升级按钮（单段路径：先制造断点续传态或用 dev 配置禁多段） | error toast 自动弹出（无需 hover）；hover 角标浮层见 message+suggestion 两段；`~/.xyz-agent/update/update-error.log` 新增一行含 `"errorCode":"UPDATE_PROXY_UNREACHABLE"` 与 `"rawCause":"EHOSTUNREACH"` | G1+G2+G6 |
| A3 | 恢复路径（A1 之后） | 系统设置 → 隐私与安全性 → 本地网络 → 允许太极 → 重启 app → 点「测试连接」→ 点升级 | 测试变绿「代理连接成功」；升级 15s 内完成下载进入确认安装；安装重启后见「已升级到 v0.9.9」toast | G4 + 恢复指引有效 |
| A4 | 公网代理不可达（代理填 `http://203.0.113.1:7890`（TEST-NET 保留段，必然不可达）） | 点「测试连接」 | 摘要为「无法连接代理 (EHOSTUNREACH)」（代理语境话术 + 错误码后缀，同 D2 testProxy 统一准绳），指引为检查代理地址与网络；**不出现**本地网络权限指引（反向验证 D2 条件判定） | G1 负面行为 |
| A5 | UI 渲染层（dev mock release，`DEV_MOCK_UPDATE_ENABLED`；不依赖真实新版本发布） | hover 侧边栏升级角标 | 浮层首行「发现新版本 vX.Y.Z」，副行「当前 A.B.C → X.Y.Z」 | G3 |
| A6 | 代理开启 + 直连 GitHub API 差的环境 | 终端 `nc -l 7890`（或代理端日志）→ 触发检查更新 | nc 输出含 `CONNECT api.github.com:443` 请求行；再故意停掉代理（不可达）→ 检查更新仍在 ≤20s 内返回结果（降级直连生效），功能不瞎 | G5 |
| A7 | 任意失败后（含预下载） | A1 环境下开启预下载开关 → 触发检查更新（触发后台预下载静默失败）→ 再手动点升级 → `cat ~/.xyz-agent/update/update-error.log` | JSONL 每行可 `jq` 解析，含 at/source/stage/errorCode；**既有 `"source":"preload"` 行也有 `"source":"download"` 行**；重跑失败多次后文件不超 1MB（轮转生效） | G6 |
| A8 | 多段下载路径失败（186MB 产物默认走多段） | A3 环境开始下载 → 下载中途停掉代理进程 | 失败 toast 与 hover 浮层显示「无法连接代理」分类文案（**不是**裸 `fetch failed`）；update-error.log 新增行含分类 errorCode | G1 负面路径（断点 1b 修复验证） |

**负面行为补充验证**：
- toast 不重复：同一错误在 Sidebar 与 UpdateButton 双消费者存在时，toast 只弹一次（D4 单例触发点验证）。
- 降级不误伤：mode=disabled 时不尝试任何代理连接（testProxy 返回 skipped、检查更新纯直连）。
- launchResult 一次性：同进程内多次触发 useAppUpdate 初始化，成功 toast 只弹一次（D5 consumed 标志验证）。

---

## §5 下一层拆分

**实施路径**：main 契约层先行（W1）→ 两个消费端并行（W2 main 侧接入 / W3 renderer 侧接入）→ 成功反馈与代理接入（W4/W5）。W1 是其余波的类型与函数依赖前置。

| Wave | 内容 | 主要文件 | justification（呼应验收） |
|------|------|---------|--------------------------|
| W1 | 契约与分类基建：net-errors.ts（extractNetErrorCode + isPrivateHost + classifyProxyUnreachable + UpdateError 包装）；UpdateErrorCode 加 UPDATE_PROXY_UNREACHABLE + 映射表条目；UpdateError 扩展 rawCause 字段；shared update.ts 加 UpdateErrorPayload；update-error.log append + 轮转工具 | `update/net-errors.ts`(新)、`update/types.ts`、`update/constants.ts`、`update/error-log.ts`(新)、`packages/shared/src/update.ts` | D1/D2/D3/D7 的依赖底座；独立单测（分类矩阵：私网 EHOSTUNREACH / 公网 EHOSTUNREACH / IPv6 ULA / 407 / 超时 / 多段路径包装） |
| W2 | main 侧接入：testProxyConnection 用分类函数 + 返回结构化 {success, code?, message?, suggestion?}；单段 fetch 分类与 downloadPart 分类改调 net-errors；三个 update:* handler catch 落盘；preloadUpdateSilently catch 落盘；preload.ts onUpdateError / testProxy 类型更新 | `gateway/update-handlers.ts`、`update/download-asset.ts`、`preload/preload.ts` | A1/A2/A4/A7/A8 的 main 侧前提（preload/index.d.ts 为 type-only re-export 自动跟随，不列入） |
| W3 | renderer 侧接入：lib/ipc.ts onUpdateError（:289）+ testProxy（:328）签名更新、api/domains/settings.ts（:177）testProxy 类型同步；UpdatePage 测试结果两行渲染；useAppUpdate state + errorSuggestion + onUpdateError toast；UpdateButton error 浮层两段渲染 + hover 版本号（__APP_VERSION__）+ i18n zh/en | `lib/ipc.ts`、`api/domains/settings.ts`、`useAppUpdate.ts`、`UpdateButton.vue`、`UpdatePage.vue`、`i18n/locales/zh-CN/sidebar.ts`、`i18n/locales/en-US/sidebar.ts` | A1/A2/A5 的 renderer 呈现；类型三处消费点（preload.ts / lib/ipc.ts / api/domains/settings.ts）全部同步。settings 语言包零改动——测试结果文案复用存量键 testFailed/testSuccess/testDisabled/testProxy 等（zh-CN/settings.ts:747-752） |
| W4 | 成功/回滚反馈：cleanupCompletedUpdate 返回终态上下文 {status, version}；main 启动缓存；update:getLaunchResult handler（consumed 一次性）；renderer useAppUpdate 初始化 invoke + done/failed/rolled-back toast | `update/update-self-healer.ts`、`main.ts`、`gateway/update-handlers.ts`、`interfaces.ts`（getLaunchResult 的 DI 契约字段，+5 行）、`preload.ts`、`lib/ipc.ts`、`useAppUpdate.ts` | A3 的成功 toast + 回滚告知（场景 4 两分支）；invoke 响应无丢失，无时序依赖 |
| W5 | release-checker 代理接入 + 降级直连 | `release-checker.ts` | A6；独立可回滚（出问题 revert 单文件） |

**文件改动地图**：改 16 文件（main 8 + preload 1 + renderer 7，其中 i18n 仅 sidebar zh/en 各 1 共 2 处；settings 语言包复用存量键零改动）+ 新增 2 文件（net-errors.ts / error-log.ts）。无删除。类型契约同步点四处：preload.ts（ElectronAPI 单一来源）→ lib/ipc.ts（onUpdateError + testProxy 包装）→ api/domains/settings.ts（testProxy 域封装）；shared/src/update.ts 的 UpdateErrorPayload 为共同依赖。preload/index.d.ts 自动跟随无需手改。

**原待验证检查点处理**（v2 已全部消解）：
1. currentVersion 通道——已解答：`__APP_VERSION__`（vite.config.ts:23 注入，useAppUpdate.ts:401 已在用），W3 直接使用。
2. launchResult 时序——已消解：D5 改为 invoke + consumed 构造性机制，无时序依赖（原推送方案的竞态被 M4 审查否决）。
3. 代理流量观察——已消解：A6 采用 `nc -l 7890` 监听 CONNECT 请求行，确定性验证手段。

---

## 修订记录

- **v3（2026-08-27）**——吸收对抗式复审的实现漂移核对 5 处（均为「实现更合理，文档未跟上」）：① D6 补记 manifest sha256 fallback 同走代理优先 + 直连降级（release-checker.ts fetchManifestSha256:322-349）；② §5 W4 文件清单补 `interfaces.ts`（getLaunchResult DI 契约字段，+5 行）；③ §3.1 场景 1 样例改为与 UI 实况一致的两行（首行存量 `testFailed` 模板包装 UpdatePage.vue:142，次行 suggestion 合并段 types.ts:95-99），消除正文「两行」与三行样例的自相矛盾；④ §5 W3 删除 settings 语言包条目并注明复用存量 i18n 键（zh-CN/settings.ts:747-752），连带文件改动地图 i18n 计数修正；⑤ 统一 D2/§3.2 表 A/A4 的 testProxy 公网 EHOSTUNREACH 话术准绳（始终代理语境 + `(EHOSTUNREACH)` 后缀），消除 D2「归类 UPDATE_NETWORK_FAILED 网络话术」与 A4「无法连接代理代理话术」的文档内矛盾，代码侧对齐由后续任务跟进。
