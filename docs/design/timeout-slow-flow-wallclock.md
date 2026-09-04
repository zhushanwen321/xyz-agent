# 慢速流超时墙钟治理设计（P2 组 + 65s 结构性守卫）

> **一句话结论**：把四条「慢速活跃流」链路（更新下载 / composer bash / 上下文压缩 / worktree setup）上的固定总墙钟替换为「停滞检测为主 + 校准链余量」，并把两处暗默认超时（shell-runner 120s、renderer 65s）改为编译期显式必传——总墙钟对挂死零增量保护、唯一作用是杀慢速活跃传输，这正是规则 19 反模式在慢速流场景的化身。

**层声明**：当前层 = 技术方案；下一层 = 实现任务单元（文件级）。本设计涉及运行时行为 / 数据流 / 错误处理，准则 5/6/7 严格档。

## 开篇（SCQA）

- **S（情境）**：xyz-agent 是 Electron + Node runtime + pi 子进程的桌面 agent 工作台。更新下载、composer `!` 前缀 bash、上下文压缩、worktree setup 四条链路都是「合法耗时可达分钟级到小时级」的慢速流，各自带有超时设置。
- **C（冲突）**：2026-09 全项目超时普查（SSOT：[timeout-audit-2026-09.md](timeout-audit-2026-09.md) §2 B 组）实锤：这四条链路存在六处「固定墙钟误杀慢速活跃流 / 双端零余量竞态 / 暗默认埋雷」问题——慢网络用户的 300MB 更新包下载 1h 被杀、`!sleep 320` 被报失败但命令其实还在跑、大 session 压缩被 renderer 与 runtime 同时判死、两处 API 暗默认让未来调用方静默继承错误量级。
- **Q（问题）**：如何在保住「控制面单请求秒级 / 回收层有界兜底」合法档的前提下，把慢速流的超时形态改成「无进展检测为主、墙钟只留校准过的兜底且带逃生门」，并建立防止再错位的结构守卫？
- **A（答案）**：删除更新下载的 1h 总墙钟（停滞检测前移补位）、bash RPC 拆小时级独立常量 + 超时后诚实告知、compact 双端抽 shared 常量对齐（runtime 30min、renderer + 60s 余量）、shell-runner 与 renderer request 的 timeout 改编译期必传。本文展开五个决策的方案对比与验收。

## 1. 背景：被设计的系统与四条慢速链路

**本章让没接触过超时治理的读者建立基本认知：四条链路各自在做什么、超时设在哪里。**

xyz-agent 的架构分三层：renderer（Vue 前端）↔ runtime（Node WebSocket 服务）↔ pi（AI agent 子进程）。本设计覆盖的五个超时点分布在全部三层：

| # | 链路 | 用户动作 | 现有超时 | 位置 |
|---|------|---------|---------|------|
| 1 | 更新下载 | 点「检查更新」→ 下载 DMG | **1h 总墙钟 ×3 挂载点** + 30s 停滞检测 | Electron main `update/` |
| 2 | composer bash | 输入框敲 `!npm test` | **300s（借 compact 常量）** | runtime `infra/pi/rpc-client.ts` |
| 3 | 上下文压缩 | 点「压缩」按钮 | **双端各 300s，零余量** | renderer `api/domains/chat.ts` + runtime rpc-client |
| 4 | worktree setup | 创建 worktree 跑初始化脚本 | **用户可配 60s~1h** + infra 暗默认 120s | runtime `infra/shell-runner.ts` |
| 5 | renderer RPC 兜底 | 一切前端→runtime 命令 | **65s 一刀切默认** | renderer `api/pending.ts` |

判读依据是 AGENTS.md 规则 19（超时默认原则）：任务执行正常路径禁止自带墙钟超时；量级必须按被保护对象粒度校准（任务级 = 小时级或无进展检测，控制面单请求 = 秒级）；回收层（防挂死兜底）允许默认有界但须可逃生。权威裁决见 [subagent-core-unbounded-wait-audit.md](subagent-core-unbounded-wait-audit.md)（「正常路径逐点根修 + 回收层统一有界兜底」）与 ADR-0047（静默 ≠ 卡死）。

正面先例（本设计的参照系）：handoff 三层手工校准链「UI 700s = RPC 660s = runtime 600s + 余量」（core `handoff.ts:25`、renderer `session.ts:19`、runtime `handoff-service.ts:53`）——下游层永远比上游多留余量，保证 renderer 永不先于 runtime 判死。core-shared 普查同时指出该链无守卫、纯靠注释维持对齐的脆弱性（本设计 D3 一并处理 compact 同款问题）。

## 2. 设计目标

**改造后使用者（含未来开发者）能做到以下五件事：**

1. **G1（慢网络更新）**：只要下载还在传字节，无论多慢都不被杀；拔网/卡死后 30s 内得到明确失败与续传指引。
2. **G2（长命令）**：`!` 前缀执行 >5min 的合法命令（构建/测试套件）结果不丢；超过兜底上限时错误消息诚实告知「命令仍在运行、如何取消、去哪找回结果」。
3. **G3（大 session 压缩）**：大 session 压缩不被 xyz 双端（renderer/runtime）误杀；renderer 恒不先于 runtime 判死（结构保证，不靠注释）。**边界声明（v1.1 收窄，审查 M2）**：压缩 LLM 调用本身在默认打包配置下受底层 provider SDK 默认 10min HTTP 墙钟约束（smart-context 默认接管且不设 timeoutMs、pi 原生 fallback 同样不设——smart-context D13-5 已知缺口，另立任务），本设计不承诺突破该层；>600s 压缩的完整治理见 §11 登记项 ③。
4. **G4（worktree setup）**：超时由用户配置值唯一决定；infra 层不再有隐藏 2min 墙钟埋伏未来调用方。
5. **G5（开发者）**：新增 RPC 命令忘记声明超时 → 编译期报错，而不是静默继承 65s 埋雷（compact 已发生过一次此类前科）。

**In-scope**：上述五点对应的所有代码改动 + 探针验证。**Out-of-scope**（显式声明，防 scope creep）：

- streaming UI 600s 墙钟、`XYZ_STREAMING_TIMEOUT_MS` 死口、dormant bash timer（→ Doc 2 `timeout-streaming-ui-idle.md`）
- zcode 300s / settled-watchdog（→ Doc 1）；插件工具 30s / 交互替答族（→ Doc 3）
- 附赠发现 #1-4：opencode workspace 硬编码、tarball 无 stall、trash 降级语义（→ Doc 5 `timeout-audit-hygiene-batch.md`）
- handoff 三层校准链的 shared 常量化迁移（现状值正确、无错位前科；登记为后续卫生项，见 §11）
- idle 超时 → curl 引擎降级的白名单扩围（维持现状保守不降级，见 D1 联动检查）
- smart-context 压缩继承 pi-ai SDK 10min 单请求墙钟：上游默认（`pi-ai/dist/types.d.ts:88-91`），本项目刻意不设 timeoutMs 以保 cache-key 一致性（`smart-context/src/llm.ts:120`，D13-5），已登记暂缓项

## 3. 现状：使用者眼里发生了什么

**本章用四个真实场景展示现状如何让使用者受阻；全部取自代码核实的失败链，非想象。**

### 3.1 更新下载：慢网络用户的更新永远装不上

**现状对活跃慢速传输一刀切判死。**用户在晚高峰 / 慢 ISP 下点更新，下载以 50KB/s 爬行——这是活跃传输（每秒都有字节），不是挂死。1h 总墙钟到点直接中止：

- undici 单段路径：`download-asset.ts:416` 在 fetch 发起前挂 `setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)`（:93 定义 = 3_600_000ms），**与是否有字节流动无关**；流结束才在 finally 清掉（:459-460）。abort 后经 `:668-673` 归为 `UPDATE_NETWORK_TIMEOUT`。
- 多段路径：`download-asset.ts:1010-1011` per-part 复用同一对常量（每段独立 1h 总钟 + 30s idle）；段失败经共享 signal 中断整批。
- curl 引擎路径：`curl-download.ts:46` `CURL_TOTAL_TIMEOUT_MS`=1h，:270-279 到点 `child.kill()`，:293-299 reject `UPDATE_NETWORK_TIMEOUT`。

量化（普查报告 elec-b 核实口径）：1h 边界 ≈ 300MB DMG 需持续 ≥83KB/s、170MB 需 ≥47KB/s；国内 GitHub CDN 典型 142-283KB/s 距边界仅 2-4 倍余量——慢速 ISP / 晚高峰 / 走代理时可击穿。被杀后：`classifyUndiciFailure` 把 AbortError 归 `non-fallback` 不降级 curl（`upgrade-fetch.ts:108-113`），终态失败，唯一恢复是用户手动重试 + resume-state 续传。

而挂死场景（拔网、服务器停发）**早已有更快的保护**：undici 侧 30s idle 检测（`download-asset.ts:551` 初始化、:567-569 每 chunk 重置——只要 30s 无新字节即 abort）；curl 侧 `--speed-limit 1 --speed-time 30`（`curl-download.ts:170-172`，30s 平均速率 <1B/s 即 exit 28）。**总墙钟对挂死的增量保护为零，唯一作用就是杀「1h 内没下完的活跃流」。**

### 3.2 composer bash：`!sleep 320` 被报失败，命令其实还在跑

**bash RPC 借用了 compact 的 300s 常量，且超时后迟到结果被双重吞掉。**用户在输入框敲 `!sleep 320 && echo done`（模拟 5min+ 的构建/测试）：

- runtime 侧 `rpc-client.ts:700` `bash()` 调 `sendCommand('bash', args, COMPACT_TIMEOUT_MS)`——:89 定义的 300_000ms 常量本是给 compact（LLM 压缩 RPC）用的，:695 注释自认「bash 可能长跑，复用 COMPACT_TIMEOUT_MS（300s）避免误超时」；`bash()` 签名 `(command, excludeFromContext?)` **无 timeout 参数**。
- t=65s：**renderer 先判死（v1.1 补层，审查 M1）**：`chat.ts` bash() 无显式超时 → pending 65s reject → `useChat.ts:623-631` catch → `toast.error(bashFailed)`——现状任何 >65s 的 `!` 命令就已先弹错误 toast（ack 并非毫秒级返回，见 §4.2）。
- t=300s：rpc-client 超时回调（:497-506）`pending.delete` + `timedOutIds.add(id)`（:97 TTL=5s）+ reject `RpcTimeoutError`。dispatcher 的 catch（`message-dispatcher.ts:405-429`）广播一条**合成错误终态**（`[bash error] timeout`）+ `message.error`，气泡收口显示失败；finally 复位 `isBashRunning`（:432-437）。
- **pi 侧 bash 并没有被 abort**（无自动 `abort_bash`），继续跑。
- t=320s 命令真实完成：pi 迟到的 `response` 到达 rpc-client `handleMessage`（:436-440）：id 已不在 pending；距超时已 >5s、id 已出 `timedOutIds` → 落入 listener 路径 → event-adapter `NULL_EVENTS` 集合含 `'response'`（`event-adapter.ts:1020-1024`）→ **吞掉，RPC 结果无人消费**。

用户看到的：失败气泡。实际发生的：命令成功执行完、结果在 pi 侧照常写入 session 文件（pi `recordBashResult` 落盘，见 `message-dispatcher.ts:287-295` 对 pi 双分支落盘的镜像描述）——**live 显示错误、重开 session 却能看到成功结果的分叉**（⛔ P1 探针在实施期验证落盘断言）。

### 3.3 大 session 压缩：renderer 与 runtime 同时判死

**双端同值、零余量，renderer 因传输延迟恒先触发。**用户在一个接近 1M token 的 session 点「压缩」：

- renderer：`chat.ts:15` `COMPACT_TIMEOUT_MS=300_000`，:80-82 随 `session.compact` 命令发出即起算。:77-79 注释记录了前科——**曾用 65s 默认在大 session 压缩时误 reject，才提到 300s**。
- runtime：`rpc-client.ts:89` 同值 300_000，:687 `compact()` 等待 pi 压缩 RPC 完成。
- 关键时序：runtime 对 `session.compact` 的 reply 在压缩**完成后**才回（`session-message-handler.ts:553-567`：`await dispatcher.compact()` 完整执行后才 reply）——所以 renderer 的 300s 计时覆盖的就是压缩全程，与 runtime 计的是同一段墙。
- 两计时器起点相差「renderer→runtime 的 WS 派发延迟 δ」：renderer **恒早 δ 触发**，先 reject 报错；runtime δ 毫秒后也 reject。双端零余量竞态的实义：**renderer 的超时永远不是「runtime reply 丢失」的兜底，而是与 runtime 并行的第二把刀。**

量级论证：实测锚点「显式 compact 300k tokens 耗时 40.1s」（探针 P-T2c，`subagent-core-unbounded-wait-audit.impl-plan.md:115`）。线性外推 1M token ≈ 133s（快 provider）；慢 provider（长 thinking、限速重试、首 token 慢）再放大 3-6 倍 → 400-800s，**可击穿 300s**。pi 侧压缩的 LLM 调用未设 provider timeoutMs 时跟随 `httpIdleTimeoutMs`（idle 语义，无墙钟，`shared/src/llm-retry.ts:9`），所以瓶颈不在 pi 内部，而在这把双端 300s 刀。

### 3.4 两处暗默认：shell-runner 120s 与 renderer 65s

**调用方漏传参数时静默获得一个未必符合语义的超时。**

- **shell-runner 120s**：`infra/shell-runner.ts:33` `DEFAULT_TIMEOUT_MS=120_000`（注释「setup-worktree.sh 通常含 npm install，给 2 分钟兜底」），:57 `opts.timeout ?? DEFAULT_TIMEOUT_MS`。port 契约 `ports/shell-runner.ts:37` 把 timeout 声明为可选（「默认 120000」）。唯一生产调用方 `worktree-service.ts:377-378` **已传**用户可配值（`configService.getTimeout()`，默认 60s、`config.setTimeout` 可调、上限 3600s——`worktree-config-helper.ts:51,53`）。所以生产路径今天是安全的，但任何未来调用方漏传即静默获得 2min 墙钟——而该脚本含 npm install，慢网络下 2min 可误杀（与 zcode 300s 事故同构、量级更小）。
- **renderer 65s 一刀切**：`api/pending.ts:27` `DEFAULT_TIMEOUT_MS=65_000`（注释「需 ≥ runtime rpc-client CMD_TIMEOUT_MS (60s) + 余量，防误超时」——backstop 语义本身合法）。约 50 个 WS 命令不显式传超时、继承此值。**结构性风险**：任何新增「长任务」命令忘传第三参即静默继承 65s——§3.3 的 compact 前科正是这么发生的（当时 65s 默认误杀大 session 压缩）。反面先例是 handoff：`session.ts:19` `HANDOFF_RPC_TIMEOUT_MS=660_000` 显式传「runtime 600s + 60s 余量」，从不依赖默认。

## 4. 根因与物理数据流

**症状各异的六处问题共享同一组根因：墙钟与停滞检测职责混淆、常量跨粒级共用、默认值暗埋。**

### 4.1 术语定义（后文反复使用，锚定上文例子）

> **停滞检测（idle / 无进展检测）** = 「连续 N 秒没有任何字节/产出才判死」——只要有进展就永不杀。§3.1 里 30s idle 检测就是它：50KB/s 爬行的下载是「有进展」，放行；拔网后 30s 无字节，判死。
>
> **总墙钟（total wall clock）** = 「不管有没有进展，到点就杀」。§3.1 的 1h 总钟就是它：50KB/s 爬行也会在 3600s 被杀。规则 19 的立场：任务正常路径禁总墙钟，要保护挂死用停滞检测。
>
> **双端竞态** = renderer 与 runtime 各挂一把同值计时器等同一个操作，起点相差传输延迟 δ，几乎同时到点——先到的一侧先报错，另一侧的结果无人消费。§3.3 的 compact 300s 就是它。
>
> **暗默认** = API 参数可选、实现里埋了默认值，调用方漏传时静默获得一个未必符合语义的值。§3.4 的两处都是它。
>
> **校准链余量** = 同一操作的多层超时按「下游 = 上游 + 余量」排布，保证下游永远不先于上游判死。handoff 700=660+40、660=600+60 是正面先例；compact 300=300+0 是反例。

### 4.2 bash RPC 物理数据流图（现状失败路径，准则 5）

```
用户在 composer 输入 `!sleep 320 && echo done`
│
▼ renderer packages/renderer/src/api/domains/chat.ts:96 bash()
│   └─ WS RPC `message.bash`（无显式超时 → 65s 墙钟罩整条命令执行；
│      ack = reply 在 `await sendBash()` 完整等待命令跑完后才回——是命令完成通知非提交确认，
│      session-message-handler.ts:517-531；与 message.send 的提交语义不同，v1.1 勘误）
▼ runtime dispatcher.sendBash（message-dispatcher.ts:306）
│   ├─ 广播 message.bashStart（气泡进入 executing 态）
│   └─ await client.bash() → rpc-client.ts:700 sendCommand('bash', COMPACT_TIMEOUT_MS=300s)
│        └─ 写 pi stdin JSONL ──► pi 子进程开始执行 sleep 320（无自动超时）
│
│  t=300s  rpc-client 超时回调（:497-506）：
│          pending.delete(id) + timedOutIds.add(id, TTL 5s) + reject RpcTimeoutError
│          └─► dispatcher catch（:405-429）：广播合成 bashResult "[bash error] timeout"
│              + message.error；finally 复位 isBashRunning（:432-437）
│              （pi 侧 bash 继续跑——无人调 abort_bash）
│
│  t=320s  pi 命令真实完成：
│          ├─ recordBashResult 把真实结果写入 session JSONL 文件（重开后可见 ⛔P1）
│          └─ 迟到 response 走 pi stdout → rpc-client handleMessage（:436-440）：
│               id ∉ pending；距超时 >5s 故 id ∉ timedOutIds
│               → listener 路径 → event-adapter NULL_EVENTS 含 'response'（:1020-1024）
│               → 吞掉，RPC 结果无人消费
│
▼ 用户眼前：bash 气泡显示失败（live）
    重开 session → 文件里有真实成功 entry（live ≠ reload 分叉）
```

其余四条链路的数据流（下载三处挂载点、compact 双端计时器、两处暗默认）已在 §3.1-3.4 逐 file:line 展开，不重复画。

### 4.3 根因归类

1. **墙钟与停滞检测职责混淆**（§3.1）：停滞检测已完整覆盖挂死，总墙钟只剩「杀活跃慢流」一个职能——它不是保护不足，而是保护错位。
2. **常量跨粒级共用**（§3.2）：compact（LLM 压缩，分钟级）与 bash（命令执行，小时级）量级差一个数量级，共用 `COMPACT_TIMEOUT_MS`——调大迁就 bash 会放大 compact 半死检测延迟，调小迁就 compact 加剧 bash 误杀。规则 19「禁止跨粒级挪用」的直接反面教材。
3. **双端零余量**（§3.3）：两把同值刀并排，renderer 恒先落刀；「对齐」没有跟「校准链余量」先例（handoff）对齐。
4. **暗默认 + 无结构守卫**（§3.4）：可选参数 + 内置默认 = 调用方无需决策；前科证明「注释提醒」不防错，只有编译期强制决策才防。

## 5. 终态：使用者眼里将是什么样

**改造后，四类使用者在同样的场景下得到与耗时相称的结果：慢流不被杀、超限有诚实出路、配置不被暗默认劫持。**

### 5.1 成功路径（使用者视角样例）

**样例 1（慢速下载，G1）**：晚高峰用户点更新，DMG 以 40KB/s 爬行，进度条缓慢但持续推进，100 分钟后下载完成、校验通过、进入安装。全程无任何「下载超时」报错。（现状：1h 被杀。）

**样例 2（长命令，G2）**：用户敲 `!sleep 320 && echo done`，气泡 executing 5 分 20 秒后显示 `done`、exitCode 0，结果进入对话流与 session 记录（live ≡ reload 一致）。（现状：300s 报「失败」。）

**样例 3（大 session 压缩，G3）**：1M-token session 点压缩，压缩跑 8 分钟完成，对话流出现压缩摘要。期间 renderer 计时器是 runtime 的 +60s 余量，永不出声。（现状：双端 300s 同时判死。）

**样例 4（worktree 慢 setup，G4）**：用户把 worktree 超时配到 1h，pnpm install 跑 40 分钟完成创建。若未来有新调用方接入 shell-runner 而漏传 timeout，TypeScript 编译直接报错，根本到不了运行时。

### 5.2 失败路径（带恢复指引，准则 6）

**样例 5（下载停滞，G1）**：下载中拔网 → 30s 无字节 → idle 检测 abort，错误提示改为：「下载停滞（连续 30 秒无数据）已中断。👉 点「重试」将从断点续传，无需重头下载。」（temp 与 resume-state 已保留，重试自动带 Range 头。）

**样例 6（bash 超兜底上限，G2）**：用户敲 `!sleep 3700`（>1h 兜底上限），1h 到点气泡收口为诚实错误：「命令执行超过 1 小时，已停止等待——命令可能仍在后台运行。👉 ① 点 bash 气泡的取消（abortBash）可终止它；② 等它自然结束后，重开本 session 可在历史记录中看到完整结果；③ 需要立即重跑请先取消再发送。」同时（⛔P6 验证）abortBash 后 pi bash slot 释放，紧接着再发 `!echo hi` 不被 busy 拒绝。

**样例 7（compact 真挂死，G3）**：pi 进程 wedged 导致压缩 30min 无响应 → runtime RPC reject → `session.compacted{error}` 广播 + renderer 在 +60s 兜底窗口内收到错误，压缩按钮复位可重试。重试若 pi 仍 wedged → ensureActive 走强杀自愈链（既有 D3a 机制，不在本设计范围）。

## 6. 关键决策与权衡

**五个决策共同把现状变成终态：两个「删」、一个「拆」、两个「显式化」。**

### D1：更新下载总墙钟——直接删除，停滞检测前移补位（选定）

- **采用**：删除全部 1h 总墙钟（2 处定义、3 个挂载点）：curl 侧删 `CURL_TOTAL_TIMEOUT_MS`（`curl-download.ts:46`）及其 totalTimer/timedOut 分支（:270-279、:293-299）；undici 侧删 `DOWNLOAD_TIMEOUT_MS`（`download-asset.ts:93`）单段 timer（:416）与 per-part timer（:1010）。**单段路径把 idleTimer 前移到 fetch 发起之前**（现 :551 在拿到 response 后才初始化）——删除总钟后，fetch 等响应头阶段将失去唯一显式保护（undici 环境默认 headersTimeout ≈300s 非本项目设置，普查 elec-b 危险项 5 已点名此缺口）；前移后「等头 + 流传输」统一由 30s idle 检测覆盖（响应头到达即视为首个进展，收到后继续每 chunk 重置）。**per-part 路径无需前移（v1.1 勘误）**：`downloadPart` 的 idleTimer 本就挂在 fetch 之前（:1011 在 `await fetch` 前），只删 :1010 总钟即可——且「idle 从 fetch 发起即覆盖 header 等待」已在生产运行（多段下载是现有功能），这是 ⛔P2 可行性的最强现成证据。curl 侧无需补位：`--speed-time 30` 覆盖整个传输阶段（含等头，0 B/s < 1 B/s 同样触发），另需适配 exit 28 文案（见文件地图）。
- **被否**：
  - **(b) 删除 + opt-in env 上界**（如 `XYZ_UPDATE_TOTAL_TIMEOUT_MS`）：多一个配置面与测试负担；且「停滞检测为主」的形态下 env 上界是语义弱化的墙钟复活口。无真实需求方；企业用户提出再加。
  - **(c) 抬到 4h**：仍是墙钟反模式，只是把边界外推——300MB @ <21KB/s 依旧被杀；`classifyUndiciFailure` 的双引擎互锁注释继续成立但语义仍错。
- **证据**：停滞检测已在双侧落地（undici `download-asset.ts:551,567-569`；curl `curl-download.ts:170-172`）——总墙钟对挂死零增量保护（§3.1）；规则 19「下载场景 = 传输速率检测/分段超时而非总墙钟」；普查 P2 组裁定「直接删除零损失」。header 阶段缺口与 idle 前移可行性 ⛔P2。
- **效果**：§5.1 样例 1、§5.2 样例 5 成立（G1）。
- **双引擎互锁联动检查**：`upgrade-fetch.ts:108-113` 把 AbortError 归 `non-fallback`（不降级 curl）的注释论据「总预算已耗尽，curl 同样会超时」随总钟删除而失效——**归类本身保留**（删除后 AbortError 来源变为 idle 30s 中止 / 用户取消 / per-part 共享中止，均非「连接建立类故障」，保守不降级仍成立：降级是白名单优化，未知形态维持直接失败），**注释改写**为「AbortError 来源（idle 中止/取消）非连接建立类故障，换引擎收益不确定，保守不降级」。「idle 超时是否值得单次降级 curl」登记 §11 观察项。

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| (a) 删除总钟 + idle 前移补 header 阶段 | ✅ 形态正确：停滞检测=规则 19 认可形态，by construction 不杀活跃流 | 删 3 挂载点 + idle 前移 + 注释修正，改动小 | header 阶段依赖 idle 前移（⛔P2）；涓流传输（≈1B/s）永不判死——进度条可见 + 用户可取消兜底 | ✅ |
| (b) 删除 + opt-in env 上界 | 多一配置面，墙钟复活口 | env 读取/透传链 + 文档 + 测试 | env 语义蔓延 | ❌ |
| (c) 抬到 4h | 仍是反模式，边界外推 | 最小（改常量） | 慢速用户被双重锁死的形态原样保留；注释语义继续错 | ❌ |

**被否若用**：(c) 之下 §5.1 样例 1 变成「40KB/s 爬行的下载在 4h 被杀，只是死得更晚」；(b) 之下默认行为与 (a) 相同但代码库多一条无人使用的 env 通路。

### D2：bash RPC——拆小时级独立常量 + 超时诚实告知，不自动 abort（选定）

- **采用**：`rpc-client.ts` 新增 `BASH_RPC_TIMEOUT_MS = 3_600_000`（1h），`:700` bash() 改用之；compact 回归自己的常量（见 D3）。env 逃生门 `XYZ_RUNTIME_BASH_RPC_TIMEOUT_MS`（设 0 = 不限时，读一次缓存）。超时行为三点改进：① dispatcher catch 识别 `RpcTimeoutError`（字段化 commandType/timeoutMs，rpc-client D3a 既有类型）时，合成终态的 output 换成 §5.2 样例 6 的诚实文案（仍在运行 / abortBash 可取消 / 重开可查结果）；② **不自动 `abort_bash`**——超时是「停止等待」，不是「处决命令」；③ 迟到响应维持丢弃（timedOutIds/NULL_EVENTS 机制不动）。
- **被否**：
  - **默认不挂（timeout=∞）**：dispatcher 的 `await` 永不 settle → `isBashRunning` 卡 true（finally 永不执行）→ 后续所有 bash 被 busy 预检拒绝 + pending 永挂。命令如 `tail -f` 确实永不结束，回收层必须有界兜底（规则 19 允许回收层默认有界 + opt-out，正是本形态）。
  - **显式参数必传**（bash() 加 timeout 必传参数）：把决策推给唯一调用方 dispatcher，dispatcher 仍需一个默认值——换汤不换药；composer 快捷命令也没有 per-command 超时的用户需求面。
  - **迟到响应广播补救**（超时后真实结果到达时替换/追加合成帧）：破坏 live≡reload 构造性等价（live 合成错误帧 + 迟到真实帧 = 两条 vs 文件一条；apply-entry-equivalence 守卫的根基）。pi 落盘已保证 reload 可见（⛔P1），补救是多余机制（准则 8）。
  - **超时后自动 abort_bash**：杀的是 1h 边界上仍在跑的合法命令——把「停止等待」升级成「处决」，重演 zcode「死后 app-server 继续烧」的反面（杀更糟：不可恢复）。层次原则对照：renderer 超时从不杀 runtime 任务（rend-api 普查核实），runtime 超时同样不杀 pi 任务。
- **证据**：对照先例——pi bash 工具（base-tool-enhance）前后台默认 `null` 不限时：agent 面任务级不设墙钟；本处是 RPC 控制面等待，需回收层有界兜底 → 小时级。1h 取值对齐 worktree `TIMEOUT_MAX=3600`（用户可配上限先例，`worktree-config-helper.ts:53`）；>1h 的命令语义上应走 agent bash 工具（不限时）而非 composer 快捷通道。**为何不能用 idle 检测**：`sleep 320` 全程零输出但是合法活跃任务（ADR-0047「静默 ≠ 卡死」）；`bash_execution_update` 流事件只在有输出增量时发（rpc-client.ts:424-428 注释），安静命令零事件会被 idle 误杀——墙钟是此处唯一不误杀的兜底形态。
- **效果**：§5.1 样例 2、§5.2 样例 6 成立（G2）。

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| 1h 独立常量 + env 逃生门 + 诚实消息 | ✅ 回收层有界 + opt-out，量级=任务级 | 拆常量 + catch 分支文案，小 | >1h 命令被「停止等待」（有诚实出路+reload 可恢复） | ✅ |
| 默认不挂 | ❌ pending 永挂 + isBashRunning 卡死 | 最小 | `tail -f` 类命令永久占用 bash slot | ❌ |
| 显式参数必传 | 决策上推，dispatcher 仍需默认 | 签名+调用链改动 | 换汤不换药 | ❌ |

**被否若用**：「默认不挂」之下 §5.2 样例 6 变成「`tail -f` 之后该 session 的 bash 功能永久 busy，只能重启」；「迟到响应补救」之下每次超时都制造 live/reload 双帧分叉，等价性守卫被迫引入替换机制。

### D3：compact 双端——runtime 30min + shared 常量对齐，renderer = runtime + 60s（选定）

- **采用**：`packages/shared` 新增 `COMPACT_RPC_TIMEOUT_MS = 1_800_000`（30min）与 `RENDERER_RPC_MARGIN_MS = 60_000`（建议放 protocol.ts 或新 timeouts.ts，实现层定）。runtime `rpc-client.ts:89/:687` compact 改引 shared 常量；renderer `chat.ts:15` 本地常量删除，改 `COMPACT_RPC_TIMEOUT_MS + RENDERER_RPC_MARGIN_MS`（=1860s）。校准链：runtime 30min（第一刀，reply 丢失时 renderer 还有 60s 窗口收到 error envelope）→ renderer 1860s（纯 backstop，恒不先于 runtime）。
- **取值论证（v1.1 修正层次，审查 M2）**：实测 300k token = 40.1s（P-T2c）；线性外推 1M token ≈ 133s；慢 provider ×3-6 → 400-800s。**实际有效上限分层**：runtime RPC 层 30min 只兜「pi 无响应/reply 丢失」；压缩 LLM 调用本身在默认配置下受 SDK 10min 墙（smart-context 同模型刻意不设 timeoutMs 保 cache-key、pi 原生 fallback 同样不设 → OpenAI SDK 默认 600s，`pi-ai/dist/types.d.ts:88-91`）——即 >600s 的压缩会被 SDK 切（smart-context 失败 → pi 原生 fallback 再至多 10min），30min **不承诺覆盖压缩本身**，取值依据修正为「≥ SDK 10min + smart-context 失败后原生 fallback 重试链 + 双端余量」，对齐 dialog-queue 30min 先例。不取 15min：两层重试链叠加贴线无余量；不取 60min：pi 真挂死时用户等 1h 才见错误。v1 的「pi 内部压缩跟随 httpIdleTimeoutMs 无墙钟」论据仅在用户显式配置了 provider timeoutMs/httpIdleTimeoutMs 时成立，默认配置下不成立（审查实锤），已修正。SDK 层缺口治理见 §11 登记项 ③（另立任务）。⛔P4 实施期实测校验。
- **被否**：
  - **双端各自改值 + 注释手动对齐**（现状模式）：chat.ts:15 注释已写着「对齐 runtime rpc-client」仍发生零余量竞态——注释不防错位；core-shared 普查对 handoff 同款结构点名「无守卫的脆弱性」。
  - **守卫测试断言双端常量关系**（两端各留常量，vitest 断言 renderer = runtime + 60）：绕过测试仍可错位（改常量忘跑测试），弱于编译期引用同一常量。
  - **顺手把 handoff 三层也抽 shared**：值正确、无前科，迁移牵三包；scope 控制，登记 §11 后续卫生项。
- **证据**：handoff「对齐+余量」先例（`session.ts:19` 660 = runtime 600 + 60；`handoff.ts:25` 700 = 660 + 40）；renderer 可 import shared（protocol.ts 已被双端引用，结构性成立 ✅P5）；65s→300s 前科（`chat.ts:77-79`）证明该链错位已实际发生过。
- **效果**：§5.1 样例 3、§5.2 样例 7 成立（G3）。

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| shared 常量双端引用 + 余量 | ✅ 编译期对齐，by construction 不漂移 | shared 加 2 常量 + 两端替换 import | 无（shared 已双端可达） | ✅ |
| 各自改值 + 注释对齐 | 脆弱，前科已发生 | 最小 | 再错位无告警 | ❌ |
| 守卫测试断言关系 | 中（测试可绕过） | 中（跨包测试） | 改值忘跑测试即失效 | ❌ |

**被否若用**：「注释对齐」之下未来某次只改 runtime 一侧，§5.1 样例 3 退回「双端零余量竞态、renderer 恒先报错」的现状。

### D4：shell-runner 暗默认——timeout 改 port 层必传，删内置 120s（选定）

- **采用**：`ports/shell-runner.ts:37` `timeout: number` 必传（注释同步改为「必传：调用方按脚本内容校准量级」）；`infra/shell-runner.ts` 删 `DEFAULT_TIMEOUT_MS`（:33），:57 直接用 `opts.timeout`。
- **被否**：
  - **默认改 0 = 不限**：漏传时 npm install 网络挂死 → `runSetupScript` 永久 pending，worktree 创建挂死无报错——比误杀更糟（反方向缺口，普查 rt-infra-b 危险项 1 同判）。
  - **保留 120s + 强化注释**：port 已有「默认 120000」注释仍挡不住漏传（D5 的 compact 前科证明注释不防错）。
- **证据**：唯一生产调用方已传用户值（`worktree-service.ts:377-378`），破坏面 = 0 个生产调用点 + 测试 mock 补参（shell-runner.test.ts）；「类型必传」与 D5 同构，一次建立「超时必须显式决策」的 port 契约范式。
- **效果**：§5.1 样例 4 成立（G4）。

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| timeout 必传 + 删默认 | ✅ by construction 消灭暗默认 | port 类型 + 测试补参，极小 | 无（生产调用方 0 破坏） | ✅ |
| 默认改 0=不限 | ❌ 漏传=挂死无报错（比误杀糟） | 最小 | npm install 网络挂死 → worktree 创建永久 pending | ❌ |
| 保留 120s + 注释强化 | 注释不防漏传（D5 前科证明） | 最小 | 未来调用方静默获得 2min 墙钟 | ❌ |

**被否若用**：「默认 0=不限」之下 §5.1 样例 4 变成「慢网络 install 挂死后 worktree 创建界面永久转圈、无任何报错」；「保留 120s」之下样例 4 的后半（新调用方漏传被拦截）变成「漏传者静默 2min 被杀」。

### D5：renderer 65s——request 超时改必传 + 具名 backstop 常量（选定）

- **采用**：`pending.ts` 的 `DEFAULT_TIMEOUT_MS`（:27）改名为导出的 `RPC_BACKSTOP_TIMEOUT_MS`（值不变 65_000，语义显性化：它是「≥ runtime CMD_TIMEOUT_MS 60s + 余量」的控制面兜底，不是任务超时）；`request.ts` `command(type, payload, timeout)` 第三参**必传**；`api/domains/**` 约 50 个调用点机械补参——有语义的用各自常量（compact→D3 shared、handoff→660s 既有、**message.bash→新 shared 常量 `BASH_RPC_TIMEOUT_MS + RENDERER_RPC_MARGIN_MS`（v1.1 补，审查 M1：实装 ack=命令完成通知非毫秒级，65s 兜底罩的是整条命令执行，D2 改 1h 后 renderer 65s 恒先判死——正是 D3 要消灭的双端竞态在 bash 链路的翻版，镜像 D3「runtime+余量」模式结构保证 renderer 恒不先判死**），其余统一 `RPC_BACKSTOP_TIMEOUT_MS`。现状佐证：>65s 的 `!` 命令今天就已先弹错误 toast（`useChat.ts:623-631` catch → `toast.error`）——本修复顺带消灭这个存量误报。
- **被否**：
  - **自定义 lint 规则**（缺参报错）：规则本身是新代码 + 新失败面（准则 8 反面）；存量 50 点仍无显式化。
  - **高异步命令白名单注释锚点**：不防新增命令——compact 前科恰恰发生在「新增/改造命令时没人想起默认值」，白名单只覆盖已知名单。
- **证据**：破坏面评估——全部调用点在 `packages/renderer/src/api/**` 内部（无外部消费者），tsc 会逐一列出漏点，机械修复；一次性 50 点的成本 < 自定义 lint 规则的开发维护成本 < 再犯一次前科的排查成本。
- **效果**：G5 成立——新增命令漏传超时从「静默埋雷」变为「编译失败」。

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| 必传 + 具名 backstop 常量 | ✅ 编译期强制决策，存量显式化 | ~50 点机械补参（tsc 列清单） | 机械 diff 的 review 负担（低） | ✅ |
| 自定义 lint 规则 | 规则=新代码新失败面；存量仍无显式化 | 规则开发+维护 | 规则误报/漏报需长期维护 | ❌ |
| 白名单注释锚点 | 不防新增命令 | 最低 | compact 前科正是「新增时发生」 | ❌ |

**被否若用**：「白名单锚点」之下 G5 场景（§9 场景 7）变成「下一个新增长任务命令上线当天静默继承 65s，在用户大操作时误杀——与前科完全同形」；「lint 规则」之下存量 50 点仍靠默认值语义理解，新人仍无法从调用点看出「这 65s 是兜底还是任务超时」。

### 决策总览

| 决策 | 动作 | 量级/形态 | 逃生门 |
|---|---|---|---|
| D1 updater | 删 1h 总钟 ×3 + idle 前移 | 停滞检测 30s | —（涓流靠进度条可见 + 用户取消） |
| D2 bash RPC | 拆独立常量 | 1h 墙钟（回收层兜底档） | env `XYZ_RUNTIME_BASH_RPC_TIMEOUT_MS=0` 不限时 |
| D3 compact | shared 常量对齐 | runtime 30min / renderer +60s | —（有界兜底，值保守） |
| D4 shell-runner | timeout 必传 | 调用方显式（现生产值 60s~1h 用户可配） | 用户经 `config.setTimeout` |
| D5 renderer 65s | timeout 必传 + 具名常量 | 调用方显式（backstop 65s 具名） | — |

## 7. 实现机制（把终态落到代码层）

**改动横跨 Electron main / runtime / renderer / shared 四处，全部是「删墙钟、拆常量、显式化」，无新机制。**

**文件改动地图**：

| 文件 | 改动 |
|---|---|
| `apps/electron/main/update/curl-download.ts` | 删 :46 常量、:270-279 totalTimer 块、:293-299 timedOut 分支；头注释更新（停滞检测为唯一保护）；**`mapCurlExitToError`（:193-207）exit 28 文案对齐错误规格表「下载停滞（30 秒无数据）已中断」语义（v1.1 补，删总钟后 exit 28 是 curl 侧唯一停滞出口，现有文案非停滞语义）** |
| `apps/electron/main/update/download-asset.ts` | 删 :93 常量；:416 单段 timer 删 + idleTimer 前移至 fetch 前；:1010-1011 per-part 同；:668-673 错误文案改「idle 30s 停滞」语义 + 恢复指引（§5.2 样例 5） |
| `apps/electron/main/update/upgrade-fetch.ts` | :108-113 AbortError→non-fallback 注释论据改写（D1 联动检查）；分类行为不变 |
| `packages/runtime/src/infra/pi/rpc-client.ts` | :89 旁新增 `BASH_RPC_TIMEOUT_MS=3_600_000`（env 读取）；:700 bash() 改用；:687 compact 改引 shared `COMPACT_RPC_TIMEOUT_MS` |
| `packages/runtime/src/services/session/message-dispatcher.ts` | sendBash catch 识别 `RpcTimeoutError` → §5.2 样例 6 诚实文案（三步恢复指引） |
| `packages/shared/src/…（protocol.ts 或新 timeouts.ts）` | 新增 `COMPACT_RPC_TIMEOUT_MS=1_800_000`、`RENDERER_RPC_MARGIN_MS=60_000` |
| `packages/renderer/src/api/domains/chat.ts` | :15 常量删，改 import shared + margin（=1860s） |
| `packages/renderer/src/api/pending.ts` | :27 改名导出 `RPC_BACKSTOP_TIMEOUT_MS`；request 超时参数必传 |
| `packages/renderer/src/api/request.ts` | `command()` 第三参必传 |
| `packages/renderer/src/api/domains/**`（~50 点） | 机械补参（具名常量） |
| `packages/runtime/src/services/ports/shell-runner.ts` | timeout: number 必传 + 注释改写 |
| `packages/runtime/src/infra/shell-runner.ts` | 删 :33 默认常量；:57 直接用 opts.timeout |
| 测试 | shell-runner.test.ts 补参；rpc-client 常量断言；download/curl 超时测试改 idle 语义；**apply-entry-equivalence 全量回归**（D2 不动迟到响应机制，必须证明无回归）；compact 常量关系断言（辅助，不计验收） |

**错误规格表（新失败路径）**：

| 触发 | 用户可见 | 恢复指引 |
|---|---|---|
| 下载 idle 30s（undici/curl 双侧） | 「下载停滞（30 秒无数据）已中断」 | 重试自动断点续传 |
| bash >1h（env 可调/0=不限） | 「命令超 1 小时，已停止等待——可能仍在运行」 | ①abortBash 终止 ②重开 session 查结果 ③先取消再重跑 |
| compact 30min 无响应 | `session.compacted{error}` + 压缩按钮复位 | 重试；连续失败走 ensureActive 自愈链 |
| shell-runner 漏传 timeout / request 漏传 timeout | 编译错误（不到运行时） | 按脚本/命令语义补显式值 |

## 8. 探针清单（准则 7；⛔ = 实施期门，必带降级路径）

| ID | 验证的行为 | 探针 | 状态 | 失败时的降级路径 |
|---|---|---|---|---|
| P1 | pi 对超时后的 bash RPC 照常 recordBashResult 落盘（reload 可见真实结果） | 实测 `sleep 320` 超时（临时调小常量）后重开 session，断言 JSONL 含成功 entry | ⛔ M2 | 若不落盘 →「维持丢弃」失去恢复出口，重评 D2：迟到响应改投递补救（真实帧替换合成帧，需保 live≡reload）或超时自动 abort 二选一 |
| P2 | 单段路径 idleTimer 前移到 fetch 前后，慢网络 header 阶段（TLS+RTT+CDN 调度）不误杀（per-part 路径已在生产以同形态运行——现成证据，v1.1 补） | 限速代理下抓 header 到达时延分布，确认 30s 边界余量 | ⛔ M1 | 前移致误杀 → header 阶段独立 60s timer，body 段维持 idle 语义 |
| P3 | 停滞检测双侧真实存在且 chunk 重置 | 代码核实（download-asset.ts:551,567-569；curl-download.ts:170-172）+ 既有测试 | ✅ 已核 | — |
| P4 | 大 session compact 实际时长 ∈ 30min 余量内 | 构造 300k-1M token session 实测压缩耗时 | ⛔ M3 | 实测击穿 → 取值升 45/60min 并重跑外推论证 |
| P5 | shared 常量双端可 import | protocol.ts 已被 runtime/renderer 双端引用（结构性） | ✅ 结构性 | — |
| P6 | bash 超时路径全行为：诚实文案 + abortBash 释放 slot + 后续 bash 不 busy | 临时调小常量实测超时路径三断言 + 一次全时长（1h）抽样 | ⛔ M3 | slot 不释放 → sendBash 超时分支补 abort_bash 兜底（重评 D2 被否项，此时「杀」的代价可接受因为命令已无人等待且 slot 需回收） |
| P-T2c（已有） | 300k token compact = 40.1s | `subagent-core-unbounded-wait-audit.impl-plan.md:115` | ✅ 已测 | D3 取值外推的输入 |

## 9. 验收（真实场景，非单测非 mock）

**本章结论：七个真实场景验证五个目标；单元测试仅作回归辅助，不计入验收。改动规模：中大型（行为变更 ×4 + 接口收紧 ×2），按大改动配多场景。**

| # | 场景 | 回溯目标 | 真实流程（谁/上下文/做什么/看到什么） | 通过标准 |
|---|---|---|---|---|
| 1 | 慢速下载存活 | G1 | dev app 指向本地 mock update feed（静态 server 服务 300MB 测试 DMG），经限速代理（如 nginx `limit_rate` / Network Link Conditioner）压到 <83KB/s，点「检查更新→下载」 | 持续活跃传输直至完成（总时长 >1h 不被杀），进度条单调推进，sha256 校验通过 |
| 2 | 拔网快速失败 | G1（负面：不该拖死） | 同场景 1，下载中途杀掉代理进程 | ≤30s+余量内报「下载停滞」错误；随后重试，从断点续传（流量监控确认未重传已完成字节） |
| 3 | 长 bash 结果不丢 | G2 | 真实 xyz dev app + 真实 pi，composer 敲 `!sleep 320 && echo done` | 气泡最终显示 `done`、exitCode 0；**全程无错误 toast（65s 存量误报随 D5 修复消灭）**；live 与重开后记录一致 |
| 4 | 超限 bash 诚实失败 | G2（负面：不杀命令） | composer 敲 `!sleep 3700`（或临时调小常量缩样 + 一次全时长抽样）；到点后点取消，再发 `!echo hi` | 1h 到点错误消息含三步恢复指引；**超时到点后、abortBash 前，命令进程仍在运行（不处决——缩样时可用 `ps`/输出文件增量断言）**；abortBash 后 `echo hi` 正常执行（不 busy） |
| 5 | 大 compact 不误杀 | G3 | 向真实 session 灌入 ~300k-500k token 文本（粘贴大文件）+ 慢模型构造耗时落在 300-600s 区间（testable 构造边界，v1.1），点「压缩」 | 压缩耗时 >300s 仍正常完成、对话流出现摘要；全程 renderer 无超时报错。**已知失败模式（不算本设计验收失败）**：实测耗时 >600s（撞 SDK 10min 墙）→ 按 §11 登记项 ③ 移交 smart-context D13-5 任务，场景改用更小构造复验 |
| 6 | worktree 用户值生效 | G4 | `config.setTimeout` 配 3600 后走 git-cwt 创建含 `pnpm install` 的 worktree；另在分支上写一个漏传 timeout 的 shell-runner 调用 | 慢 install 创建成功；漏传调用 `tsc` 编译失败 |
| 7 | 65s 显式化 | G5 | 全量 `pnpm typecheck`；临时删除任一 command 调用的第三参 | 编译报错指向该调用；~50 调用点全部显式具名常量 |

验收依赖说明：场景 1/2 的 mock feed 与限速代理是真实网络栈（真实 undici/curl、真实 TCP），仅 feed 指向本地——非 mock 依赖；场景 3/4/5 均真实 pi 子进程与真实 LLM/命令执行。

## 10. 下一层拆分（实现任务单元）

**拆成 5 个可独立验收的文件级单元 + 3 个里程碑；每个单元对应 §9 场景，可分阶段合并。**

| 单元 | 内容 | 对应验收 | justification（为什么这么拆） |
|---|---|---|---|
| U1 updater 墙钟删除 | D1 全部（curl/undici/per-part + idle 前移 + 注释联动） | 场景 1/2 | 三挂载点同根同模式，一个单元内闭环；前置 ⛔P2 探针门 |
| U2 bash RPC 独立化 | D2 全部（常量 + env + 诚实文案） | 场景 3/4 | 依赖 P1 落盘断言（迟到响应维持丢弃的前提）；apply-entry-equivalence 回归同批跑 |
| U3 compact 对齐 | D3 全部（shared 常量 + 双端替换） | 场景 5 | 独立于 U1/U2；⛔P4 取值门在 M3 前完成 |
| U4 shell-runner 必传 | D4（port + infra + 测试补参） | 场景 6 前半 | 最小独立单元，纯类型收紧 |
| U5 renderer 65s 必传 | D5（pending/request/50 点，含 message.bash 语义化取值） | U4：场景 6；U5：场景 3/7（v1.1 勘误对应关系） | 机械大 diff 单独成单元便于 review；与 U4 并行 |

**实施路径**：M1 = P2 探针 + U1 → M2 = P1 探针 + U2 → M3 = P4/P6 探针 + U3 → M4 = U4 + U5 + 全量回归（typecheck / extensions 三连不涉及 / apply-entry-equivalence / electron 打包三阶段验证——update 代码属 main 进程，走 preflight→build→postbuild）。

## 11. 待验证检查点与登记项

- **⛔P1/P2/P4/P6**（见 §8）：实施期门，均已配降级路径。
- **登记观察（out-of-scope，不在本设计实施）**：① handoff 三层校准链（700/660/600）迁移到 shared 常量——现状正确无前科，改动牵三包，建议随下一次触碰 handoff 时顺手做；② idle 超时（30s 停滞）是否值得单次降级 curl 引擎——D1 删除总钟后 AbortError 全部来自 idle/取消，降级白名单扩围是独立收益评估；③ **smart-context 压缩 SDK 10min 墙（v1.1 从「暂缓」升格为「已知缺口移交」）**：smart-context 默认打包接管用户 /compact 且 same-model 与 pi 原生 fallback 均不设 timeoutMs → 默认配置下压缩实际有效墙钟 = SDK 10min（`types.d.ts:88-91`），>600s 压缩被切——D3 的 30min 只兜 RPC 层不覆盖该层（G3 边界声明、D3 取值论证、场景 5 构造边界三处已对齐）；修复归 smart-context D13-5 cache-key 约束下的 timeoutMs 显式化任务（另立，非本设计 scope）。
- **设计阶段无法确定、诚实留给实施**：shared 常量落点（protocol.ts vs 新 timeouts.ts）——由「shared 包内聚性」在实施时裁决，两案均满足 D3 目标；~50 调用点的精确清单以 tsc 报错为准（设计阶段 grep 口径「约 50」来自 rend-api 普查）。

## 附录：变更历史

- v1（2026-09-04）：初版——依据超时普查总报告 P2 组 + 65s 结构性守卫任务落盘；五个决策（删下载总钟 / bash 拆 1h / compact 30min shared 对齐 / shell-runner 必传 / renderer 65s 必传）。
- v1.1（2026-09-04）：第一轮对抗式审查修复（2 MF/4 SG，逐条对应）：
  - M1（message.bash ack 语义事实错误）→ §4.2 数据流图勘误（ack=命令完成通知非毫秒级，session-message-handler await sendBash 实装）；§3.2 现状补 t=65s renderer 先弹错误 toast 层（useChat:623-631 存量误报）；D5 把 message.bash 归「有语义」组（BASH_RPC_TIMEOUT_MS+余量 shared 常量，镜像 D3 模式，消灭 bash 链路双端竞态翻版）；场景 3 补「无错误 toast」断言、场景 6/7 对应关系勘误（U4：场景 6；U5：场景 3/7）。反例重演：`!sleep 320` 端到端——renderer 3660s > runtime 3600s，无 toast、气泡 done。
  - M2（compact 30min 虚假覆盖）→ G3 边界收窄（30min 只兜 pi 无响应，不承诺突破 SDK 10min 层）；D3 取值论证改「≥ SDK 10min + fallback 重试链 + 余量」并修正「跟随 httpIdleTimeoutMs」的失实论据；场景 5 构造边界 300-600s 区间 + >600s 列已知失败模式；§11 登记项 ③ 从「暂缓」升格「已知缺口移交」（smart-context D13-5 另立任务）。反例重演：>600s 压缩被 SDK 600s 切——本设计不再承诺覆盖该形态，G3/论证/场景三处对齐。
  - S1→文件地图 curl 行补 exit 28 文案适配（mapCurlExitToError :193-207）；S2→per-part 表述勘误（只删钟不前移，idle 本就挂 fetch 前）+ P2 探针补 per-part 生产现成证据；S3→U4/U5 验收对应勘误；S4→场景 4 补「不处决」负面断言（ps/输出文件增量）。
  - 联动同步：正文决策（D1/D3/D5）、§3.2 现状、§4.2 数据流图、§5 终态（样例不受影响）、§7 文件地图/错误规格、§9 场景 3/4/5、§10 拆分（U5）、§11 登记项 ③、探针 P2；变更历史本条。
