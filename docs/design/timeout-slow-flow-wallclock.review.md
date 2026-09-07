# 慢速流超时墙钟治理设计（P2 组 + 65s 结构性守卫）— 对抗式审查报告

> 审查对象：`docs/design/timeout-slow-flow-wallclock.md`（v1，2026-09-04）
> 审查依据：`~/.agents/skills/tech-design/review/rubric-design-doc.md` + AGENTS.md 规则 19/12/1 + 项目源码实装核实（工作目录 fix-zcode-subagent-failed）
> 审查方式：对抗式——所有影响决策的事实声明已逐一 `read` 源码核实（Electron main update 三文件 / runtime rpc-client + dispatcher + transport handler / renderer pending + request + chat + core useChat / pi 实装 dist JS / pi-ai types.d.ts / smart-context 源码）

## Summary

2 must-fix, 4 suggestions.

文档事实密度高且绝大多数 file:line 声明经实装核实**准确**（rpc-client/dispatcher/download-asset/curl-download/upgrade-fetch/shell-runner/pending/handoff 三处校准链/pi recordBashResult 双分支落盘全部对上）；五段骨架、方案对比、探针降级路径、错误恢复指引均达标。两处 MUST_FIX 都是「文档声明的前提/目标与实装行为存在断裂」：**M1**（§4.2「ack 毫秒级返回」为事实错误，导致 D5 对 `message.bash` 调用点超时归类错误——bash 链路将保留 D3 要消灭的双端竞态，G2 场景 65s 恒先弹错误 toast）；**M2**（G3「1M-token 压缩不被任一端误杀」与 D3 取值论证在默认打包配置下是虚假覆盖——显式 compact 被默认接管的 smart-context 及 pi 原生路径均不设 timeoutMs，实际有效墙钟 = 底层 provider SDK 默认 10min < 外推上界 800s，验收场景 5 大概率实测撞墙）。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §4.2 数据流图 + §6 D5 | P0-11 事实 / P0-12 遗漏 | **「ack = message.status{sent} 毫秒级返回」是事实错误**。实装：`transport/session-message-handler.ts` case `message.bash` 是 `await this.ctx.sessionService.sendBash(...)` 完整等待 bash 命令执行完（dispatcher.sendBash 内 `await client.bash()` 全程）后才 reply——ack 就是命令完成通知，不是毫秒级（与 `message.send` 的提交语义不同：pi 的 prompt RPC response 是提交确认，bash RPC response 是命令结果，两条 RPC 语义本就不同）。后果链（均实装核实）：`chat.ts` bash() 无显式超时 → renderer pending 65s 超时 reject → `packages/core/src/domain/chat/useChat.ts:623-631` catch → `toast.error(bashFailed)`——**现状任何 >65s 的 `!` 命令就已先弹错误 toast**（§3.2 现状分析漏了这层，只讲了 t=300s 合成终态）。D2 把 runtime 侧改 1h 后，D5 又把 message.bash 归入「其余统一 RPC_BACKSTOP_TIMEOUT_MS 65s」→ `!sleep 320` 在 t=65s 弹「bash 失败」toast、t=320s 气泡才显示 done——**renderer 65s 恒先于 runtime 3600s 判死，正是 D3 要在 compact 上消灭的双端竞态在 bash 链路的翻版**，D2 的诚实告知被 renderer 误报抢先 | ① D5 补参清单把 message.bash 列入「有语义」组：用 ≥ `BASH_RPC_TIMEOUT_MS + 余量` 的 shared 常量（镜像 D3 的 renderer = runtime + margin 模式，结构保证 renderer 恒不先判死）；② 验收场景 3 增加「全程无错误 toast」断言（否则 65s toast 误报验收抓不住）；③ §4.2 数据流图修正 ack 语义 |
| MUST_FIX | §2 G3 + §6 D3 取值论证 + §9 场景 5 | P0-10 因果 / P0-13 验收成立性 | **G3「1M-token 级压缩不被任一端误杀」与 D3「30min 覆盖 800s 外推上界」在默认打包配置下是虚假覆盖，实际有效墙钟 ≈ 10min**。实装证据链：① smart-context 在 `mandatory-extensions.json:16`（tier=feature，xyz 桌面默认打包），`compact-handler.ts` 头注释自认「三条压缩路径（agent 工具 / **用户 /compact** / 内建 auto）统一经过这里」——显式 compact 默认被接管；② same-model 调用刻意不设 timeoutMs（`smart-context/src/llm.ts:120-122`，D13-5 cache-key 一致性，文档已引用）；③ 接管失败 fallback 到 pi 原生 compact（`agent-session.js:1451` → `compaction.js`），原生 `createSummarizationOptions`（compaction.js:440-446）**同样不含 timeoutMs**；④ `pi-ai/dist/types.d.ts:88-91`：timeoutMs 未设时「OpenAI and Anthropic SDK clients default to 10 minutes」——xyz 常用 openai-compat provider（zai/kimi/xiaomi）走 OpenAI SDK → 默认 10min HTTP 超时。结论：慢 provider 1M-token 压缩（文档自身外推 400-800s）中 >600s 的部分被底层 SDK 切（smart-context 失败后原生兜底再试，又至多 10min），**runtime 30min 只兜「pi 进程 wedged 无响应」，永远兜不到压缩本身**。文档把 SDK 10min 放在 §2 Out-of-scope「暂缓登记」，但 G3 目标声明、D3 取值论证、场景 5 构造（1M token + 慢模型）三处都没有与该暂缓项对齐——目标承诺超出方案能兑现的范围；场景 5 实测很可能撞 10min 墙，验收不可稳定通过（testable 前提未声明） | 三选一（不强制改 30min 值）：① G3 与场景 5 收窄边界声明——30min 只兜 pi 无响应，>10min 压缩受底层 SDK 默认墙钟约束、属 smart-context D13-5 暂缓项的已知缺口（目标改为「不被 xyz 双端误杀」）；② D3 取值论证补「实际有效上限」层次，30min 的量级依据改为「≥ SDK 10min × 重试链 + 余量」而非「覆盖 800s 外推」；③ 场景 5 明确耗时构造边界（如 ≤600s 可稳定通过的区间）或把撞 10min 墙列为已知失败模式，验收才 testable |
| SUGGESTION | §7 文件改动地图（curl-download.ts 行） | P1-8 / P0-12 轻 | 错误规格表承诺「下载 idle 30s（undici/curl 双侧）→『下载停滞（30 秒无数据）已中断』」，但文件地图 curl 行只列「删 :46 常量、:270-279 totalTimer 块、:293-299 timedOut 分支；头注释更新」——**漏列 curl 侧 exit 28 的错误文案/映射适配**。实装：删总钟后 curl 停滞保护只剩 `--speed-time 30`（:170-172），触发后走 exit 28 → `mapCurlExitToError`（:193-207）现有文案非「停滞」语义，需同步核对改写（undici 侧 :668-673 已列出，curl 侧遗漏） | 文件地图 curl 行补「exit 28 文案对齐错误规格表」 |
| SUGGESTION | §6 D1 采用段 + §7 | P1-8 | 「idleTimer 前移到 fetch 发起之前（现 :551 在拿到 response 后才初始化）」**仅对单段路径成立**。实装：per-part 路径（`downloadPart`）的 idleTimer 本就挂在 fetch 之前（:1011 在 `await fetch` 之前），per-part 只需删 :1010 总钟、无需前移。且 per-part「idle 从 fetch 发起即覆盖 header 等待阶段」**已在生产运行**（多段下载是现有功能）——这恰是 ⛔P2 探针（header 阶段 30s 边界余量）可行性的最强现成证据，文档未引用 | 修正 per-part 表述（只删钟不前移）；P2 探针证据栏补「per-part 已在生产以同形态运行」 |
| SUGGESTION | §10 U5 行 | P1-8 | 「对应验收：场景 6 后半/7」错位——场景 6 后半（漏传 timeout 的 shell-runner 调用 `tsc` 编译失败）验证的是 **U4**（shell-runner port 必传）；U5（renderer 65s 必传）只对应场景 7 | 修正为「U4：场景 6；U5：场景 7」 |
| SUGGESTION | §9 场景 4 | P1-10 | D2 的关键负面行为「不自动 abort（超时是停止等待，不是处决）」没有显式验收断言——场景 4 验证了诚实文案与 abortBash 出路，但「到点后命令在 pi 侧仍存活（未被处决）」只能由「abortBash 能成功终止」间接推断，未写明 | 场景 4 通过标准补一句「超时时刻到点后、abortBash 前，命令进程仍在运行」（如临时调小常量缩样时用 `ps`/输出文件断言） |

## 已核实为准确的关键事实（对抗未击穿项，抽样列举）

以下声明逐一 `read` 实装源码核实**通过**，对抗式攻击未找到反例：

| 文档声明 | 核实结果 |
|---|---|
| §3.1 undici 单段 :93/:416/:551/:567-569、per-part :1010-1011、错误归类 :667-670；curl :46/:170-172/:270-279/:293-299；upgrade-fetch :108-113 AbortError→non-fallback 注释 | 全部对上（`:551` idleTimer 确在 fetch resolve 后的 `pipeResponseToTemp` 内初始化；`:567-569` chunk 重置；per-part 共享 signal 联动结构属实） |
| §3.2 rpc-client :89 COMPACT_TIMEOUT_MS=300_000、:695 注释自认复用、:700 bash() 无 timeout 参数、:497-506 timedOutIds TTL 5s + RpcTimeoutError、:436-440 迟到响应路径、event-adapter :1020-1026 NULL_EVENTS 含 'response' | 全部对上 |
| §3.2「pi recordBashResult 落盘」 | 实装核实成立：pi `agent-session.js` executeBash 完成即调 recordBashResult（:2372），非 streaming 时立即 `sessionManager.appendMessage`（:2383-2412 落盘，含 excludeFromContext 场景照常落盘）；streaming 时缓冲到 agent turn 结束 flush。xyz 注释引用的行号（2237-2247）与实装（2372+）有偏移，属 xyz 代码注释的偏移，非本文档错误——⛔P1 探针的行为前提有充分代码依据 |
| §3.3 compact reply 在压缩完成后才回、双端同段墙 | 属实（`handleSessionCompact` await sessionService.compact 完整执行后才 reply） |
| §3.4 shell-runner :33/:57、port :37、唯一生产调用方 worktree-service 已传 configService.getTimeout()（默认 60s、上限 TIMEOUT_MAX=3600） | 全部对上；`shellRunner.execute` 生产调用点 grep 仅 worktree-service.ts:379 一处，「破坏面 = 0」论证成立 |
| §3.4/§6 renderer 65s backstop、handoff 700/660/600 三层先例（core `domain/chat/handoff.ts:25`=700_000、renderer session.ts:19=660_000、runtime handoff-service.ts:53=600_000）、dialog-queue 30min（:46） | 全部对上 |
| D2 证据「base-tool-enhance 前后台默认 null 不限时」 | 属实（`base-tool-enhance/src/config.ts:43-44` 两字段默认 null） |
| D5「约 50 调用点全部在 api/** 内部、无外部消费者」 | grep 核实：生产代码中 request 的 command 仅被 `api/domains/**` 引用（外部仅测试文件）；调用点数量级与「约 50」一致且文档已声明「以 tsc 报错为准」 |
| §3.2「pi 侧 bash 并没有被 abort」 | 属实：pi executeBash 无任何 timer，仅响应 AbortController（外部 abort_bash） |

## 结构与验收维度判定摘要（rubric 四态）

| 检查项 | 判定 | 依据 |
|---|---|---|
| P0-1 五段骨架 | 通过 | 背景/目标/现状/方案/验收/拆分全齐，层声明明确 |
| P0-2 delta 链 | 通过 | 附录变更历史 v1 + 普查报告（timeout-audit-2026-09）引用 |
| P0-3 结论先行 | 通过 | 一句话结论 + SCQA 开篇 + 各章节首句结论 |
| P0-4/5/6 问题定义/视角/术语 | 通过 | §3 四真实场景、§4.1 五术语绑定例子、§5 使用者视角终态 |
| P0-7/8/9 方案对比 | 通过 | 每决策 ≥3 备选 + 两维表 + 裁决 + 「被否若用」反事实推演（超出 rubric 要求） |
| P0-10 方案解决根因 | **不通过（M2）** | G3 因果断裂：默认配置下实际有效上限 10min，30min 虚假覆盖 |
| P0-11 关键事实 | **不通过（M1）** | §4.2 ack 毫秒级为事实错误，直接影响 D5 对 message.bash 的取值决策；其余事实声明经核实准确 |
| P0-12 副作用/遗漏 | **不通过（M1 的 D5 部分）**；S1/S2 为轻量遗漏 | D1 的 upgrade-fetch 联动检查、per-part 共享 signal 联动均已自查覆盖（通过）；D5 遗漏 message.bash 语义化取值 |
| P0-13/14/15 验收 | **不通过（M2：场景 5 成立性）**；其余通过 | §9 七场景真实（真网络栈/真 pi/真 LLM）、逐场景回溯 G1-G5、通过标准具体、投入与中大型改动匹配 |
| P0-16 探针 | 通过 | ⛔P1/P2/P4/P6 全带降级路径，P3/P5/P-T2c 已核/结构性 |
| P0-17 数据流图 | 通过 | §4.2 bash 全链物理位置 file:line 齐全，其余链路在 §3 逐行展开（物理位置已标） |
| P0-18 错误恢复 | 通过 | §5.2 三失败样例 + §7 错误规格表（触发/可见/恢复三列） |

## 给实施方的一句话

两处 MUST_FIX 都是「声明与实装的断裂」而非方案方向错误：M1 修 D5 的一个调用点归类 + 一条验收断言，M2 修目标/论证/验收的边界对齐——修复成本低，但不修则 G2/G3 在真实使用中会被 65s toast 和 10min SDK 墙钟打脸。
