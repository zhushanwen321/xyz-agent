# 对抗式审查报告：timeout-audit-hygiene-batch.md

> 审查人：tech-design-review（对抗式）· 依据：rubric-design-doc.md · 源码基线：fix-zcode-subagent-failed worktree
> 所有「事实」判定均已 `read` 源码实地核对（核对清单见附录）。

## Summary

3 must-fix, 4 suggestions.

整体结构质量高：五段骨架完整、四项各有 ≥2 方案对比 + 两维度评估 + 明确裁决、失败模式有真实用户视角、验收全部真实场景非 mock、负面行为各有反向验证、探针全部带降级路径。三条 must-fix 均为「方案声明与源码实况的偏差」或「修复覆盖面遗漏」——D4 的恢复语义证据在 active session 分支与源码相反、D2 的修复落点漏掉 workflow 派发域、D3 的 stall 触发行为在流式路径会撞未处理 error 事件。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §2.4 / §3.4.3 D4-1 证据 / §4.4 V4-1 | P0-11 + P0-12 | **「trash 是 delete 流程第一步，session 留在列表」对 active 分支是事实错误**。实测 `session-lifecycle.ts` delete()（:547-560）：active 分支先 `detachSession → destroySession → removeSessionEntry`，**之后**才 `purgeActiveSessionFile → trash`（:499）。trash throw 时活跃 session 的进程已被销毁、条目已从列表移除——文件保留（G4 核心成立），但「session 留在列表，用户重试语义完整」不成立：用户看到删除报错，会话却已终止、列表已消失（文件下次扫描才以 scanned 形态回来）。V4-1 在 active session 上执行会直接不满足「session 留在列表」通过标准。D4-1 的证据陈述只对 scanned 分支（:543，trash 确在前）成立 | 设计显式处理 active 分支语义二选一：① 把 trash/文件保留判定提到 destroySession 之前（改 delete 编排序）；② 声明「active 分支失败 = 会话已终止 + 文件保留 + 报错，重删走 scanned 路径」为新语义，同步修正 D4-1 证据句与 V4-1 通过标准（按 active/scanned 两种形态分别断言） |
| MUST_FIX | §3.2（D2-1/D2-2 落点）/ §1.2 G2 / §4.2 | P0-10 + P0-12 | **修复只覆盖 chat 路径，workflow 派发域的 F2-B 形态未修**。实测：workflow 路径 `subprocess-agent-runner.ts` run() 先路由，非 pi 引擎**直接 `route.engine.run(taskSpec)`**（:227-229），不经 subagent-service.execute()，也无 validateModel 调用点——workflow 域 `agent({engine:'zcode', model:<pi id>})`（或 defaultEngine=zcode + pi id）仍在 prepare 期晚炸（已过 probe/journal/池），且拿不到 D2-3 场景 2 文案。而 §2.2 术语框明确「派发 = chat 工具路径 或 workflow 路径」，G2 承诺「任何组合要么成功要么派发同步期报错」——按文档自己的问题定义，目标未完整达成。§3.2.2 把「与 workflow 路径行为对齐」当优点引用，但对齐的只是路由时机，不是校验覆盖。V2-4② 只测 workflow **成功**回归，无 workflow 错误场景 | validateModel 调用点必须覆盖 SAR.run 的非 pi 分支（如 SAR 路由后与 chat 路径共用同一校验入口），并补验收场景「workflow 域 zcode+pi id 派发同步期报 D2-3 场景 2 错误」；或显式 descope workflow 域（改写 G2 措辞 + 说明为何 workflow 域可容忍 prepare 期晚炸） |
| MUST_FIX | §3.3.3 D3-4 | P0-11 + P0-12 | **「两路径 promise 均经既有 error 通道 reject」在流式路径不成立——stall 触发 `final.destroy(err)` 会产生未处理 'error' 事件**。实测流式分支（:355-357）只有 `final.pipe(gunzip)`，final **无任何 on('error') 监听**（httpGet 只在 header 前挂 req error，followRedirects 不挂，pipe 不转发源侧错误）。`final.destroy(new Error('stalled'))` → final 发 'error' 无监听 → ERR_UNHANDLED_ERROR（runtime 进程级风险）；gunzip 侧也收不到错误（pipe 半开）。P3-1 的降级路径（「extractTarStream 的 reject 前显式 gunzip.destroy()」）只解 gunzip 侧传播，**解不了 final 侧未处理 error**。附带发现：这是既有隐患——中途断流（ECONNRESET）在流式路径今天就是同一崩溃面 | D3-4 明确：流式分支显式挂 `final.on('error')`（吞掉/转入 reject，顺带修复既有断流崩溃面），stall 触发时同步 `gunzip.destroy(err)` 保证 promise reject；P3-1 探针措辞相应升级为「final 侧 error 有监听 + gunzip 侧有传播」双断言 |
| SUGGESTION | §3.3.3 D3-1 / D3-3 | P0-16（探针补强）+ P1-6 | **背压耦合击穿「解压段无外部等待面」论证**：流式路径 `final.pipe(gunzip)` 下，下游（gunzip/tar extract/落盘）跟不上时 pipe 会 pause `final`——data 事件停止是被解压速度门控的，与网络无关。「解压是本地 CPU 变换已收到的字节，无外部等待面」在 pipe 耦合下不严格：慢解压（大包 + 慢盘）+ 健康网络场景，stall timer 可能被饿死 >60s 而误杀（V3-2 的 50KB/s×5MB 形态测不到这个面——它测的是网络慢，不是解压慢）。概率低（typical 插件包小、解压快于下载），但论证应诚实 | 刷新点扩展到 gunzip/extract 链（任一链上有数据流动即刷新，语义仍是「无进展检测」）；或声明该假设 + P3/V3-2 补「大包 + 人为慢解压」探针形态 |
| SUGGESTION | §3.2.3 D2-1 | P1-3 / P1-5 | **target≠pi 分支的 model 三层语义未说明完整**：「model 原样透传（record.model 记 raw ref）」未界定是只透传 `opts.model`，还是含 agentConfig.model 层（agent .md frontmatter `model:`）。现状 resolveModel 三层（paramOverride > agentConfig > ctxModel）全经 pi registry；reorder 后非 pi 分支里 agentConfig.model 该透传（大概率在 zcode 炸）还是忽略（落 ZCODE_FALLBACK_DEFAULT_MODEL）语义不同，thinkingLevel 的兜底解析同理——实现者只能猜 | D2-1 补一张「target=pi vs target≠pi」的逐层语义小表（opts.model / agentConfig.model / ctxModel / thinkingLevel 各自归趋） |
| SUGGESTION | §2.4 / §4.4 | P1-3 | **调用方清单遗漏批量删除 deleteByCwd**：`session-lifecycle.ts` deleteByCwd（:577-598，folder 删除按钮）循环调 delete()，已有 per-item try/catch 聚合 `deleted/failed`——trash 改 throw 后批量语义自洽（失败项进 failed[]，前端可见），**无需改码**，但文档 §2.4 只登记 :499/:543 两调用点、V4 无批量部分失败场景，实施者与验收者都不知情 | §2.4 调用方清单补 deleteByCwd 一行（说明既有聚合语义天然兼容）；V4 可加一条批量场景（folder 删除含一个 Finder 卡死项 → failed[] 含该项、其余正常进废纸篓） |
| SUGGESTION | §2.2 / §5.3 | P1-8 | **四处路径前缀与实际不符（行号本身全部准确）**：model-resolver.ts 实际在 `packages/subagent-core/src/execution/`（doc 写 shared/）；host-task-spec.ts / zcode-engine.ts / routing.ts / port.ts 实际在 `packages/subagent-core/src/execution/engine/`（及 engines/zcode/）——doc 省略 engine 段。不影响决策，实施 grep 可达 | 修正路径前缀，保持行号不变 |
| INFO | §3.4.3 P4-1 | — | **探针可提前解出（正路已存在）**：实测 `server.ts:416-434` handleMessage 有统一外层 try/catch → `broker.sendError`（error 自带 code 透传，否则 handler_error）——trash throw 会以错误 reply 到达 renderer，session.delete case 无需自带 try/catch。实施时直接验证一次即可，无需预期走降级路径 | 实施期直接确认 server.ts 通道；如需 code 差异化可给 trash 错误挂 code |
| INFO | 全文 | P0-1~P9 通过项 | 结构与内容主线全部通过：五段骨架 ✅（§1-§5 + SCQA + 变更历史）；每节结论先行 ✅；术语定义带例子（workspace/SSR/registry/派发）✅；四项各 4 方案对比 + 长期/短期两维 + 明确裁决 + 被否反演 ✅；验收全部真实场景（真实 pi CLI / 真实 ZCode 登录态 / 本地 HTTP 故障注入已声明且非 mock / 真实 Finder 繁忙注入）且每场景回溯 G1-G4 ✅；负面行为反向验证（V1-3/V2-4③/V3-2/V4-3）✅；数据流物理位置标注 ✅；错误消息全部带恢复指引 ✅；规则 19 对齐（stall=无进展检测而非墙钟，与 zcode 300s 误杀反例对照）论证成立 ✅ | — |

## 判定四态汇总（P0 清单）

| 检查项 | 判定 | 依据 |
|---|---|---|
| P0-1 五段骨架 | 通过 | §1-§5 齐全，共用骨架声明合理（四独立小修） |
| P0-2 delta 链 | 通过 | 附录 B 变更历史 + 附录 A 与总报告映射（含行号勘误） |
| P0-3 结论先行 | 通过 | 一句话结论 + 每章/每节「本节结论」+ SCQA 开篇 |
| P0-4 问题定义/根因 | 通过 | 四项均有代码证据链 + 根因句（「值的来源通道缺失」/「双重错配」/「覆盖面止步 header」/「辅助失败≠原操作失败」） |
| P0-5 重实现轻体验 | 通过 | 每项有真实失败模式（用户视角）+ 终态场景 |
| P0-6 抽象术语 | 通过 | workspace/SSR/registry/派发 首次出现即定义绑例子 |
| P0-7/P0-8/P0-9 方案对比 | 通过 | 每项 4 方案 × 长期/短期/风险 + 裁决 + 被否反演 |
| P0-10 解决目标问题 | **不通过（D2）** | G2 按 §2.2 自定义的「派发」覆盖两路径，修复落点只覆盖 chat——见 MUST_FIX #2 |
| P0-11 关键事实 | **不通过（D4/D3）** | D4-1「trash 是 delete 第一步」与 active 分支源码相反；D3-4「两路径均有既有 error 通道」与流式路径源码不符——见 MUST_FIX #1/#3 |
| P0-12 副作用/遗漏 | **不通过（D2/D3/D4）** | workflow 域遗漏；final 未处理 error 新崩溃面；active 分支恢复语义；另 deleteByCwd 遗漏为 SUGGESTION |
| P0-13 验收可测试 | 基本通过 | 四表均 testable 且回溯目标；但 V4-1 通过标准在 active 分支会误判（随 MUST_FIX #1 修正）、V2 缺 workflow 错误场景（随 MUST_FIX #2 补） |
| P0-14 单测/mock/抽象断言 | 通过 | 全部真实场景；V3 本地 HTTP 故障注入是对真实 TCP 语义的注入且已声明缺口，非 mock |
| P0-15 验收投入匹配 | 通过 | 小改动 3 场景、中改动 4 场景，量级合适 |
| P0-16 运行时断言探针 | 基本通过 | 探针 6 项全带降级路径；但 P3-1 降级未覆盖 final 侧未处理 error（MUST_FIX #3），背压假设无探针（SUGGESTION #1） |
| P0-17 数据流图 | 通过 | 四条现状链路均标物理位置（URL/文件路径/模块） |
| P0-18 错误恢复指引 | 通过 | 所有新错误消息含 👉 具体动作（含按引擎区分的省略语义） |

## 事实核对清单（本次已 read 源码验证）

**命中（决策依赖的关键事实全部为真）**：opencode.ts:60 硬编码 URL + commit 56c6e00f3（2026-07-25，git log -S 实证）；quota-service.ts:231 configure / :258 cookie 落盘 / :379 doFetch / :321 persistQuotaConfig（providers.json 写侧）；quota-types.ts:42 reason 可区分注释 / :52-67 双参接口；protocol.ts:533 quota.configure payload（加 workspace 需动协议，unit-1 已列）；useQuotaConfigure.ts 存在（renderer 侧非死配置口，D1 调用链三层完整）；4 fetcher FETCH_TIMEOUT_MS 行号（kimi:12/mimo:14/minimax:15/zhipu:12 均 5000）；subagent-service.ts:850 resolveIdentity / :867 routeEngine / :876 executeViaEngine；model-ref.ts:200 not-a-registry-entry 文案 / :232 omit-to-inherit 文案 / :159+ Did-you-mean 先例；host-task-spec.ts:33 `model: opts.model` 透传；zcode-engine.ts:397 resolveZcodeModelRef 消费点；preparer.ts:178 resolveZcodeModelRef（`wanted ?? ZCODE_FALLBACK_DEFAULT_MODEL`——「zcode 不消费主 agent model」实证）；routing.ts:159-162 「路由层无 registry 访问面」注释原文；port.ts:181 listModels 可选面先例 + zcode :1144 实现已过滤无凭据 provider（D2-4 纠错候选不会指向无凭据模型）；constants.ts:37 ZCODE_FALLBACK_DEFAULT_MODEL；index.ts:662-663 defaultEngine 门控注入；npm-installer.ts:23/:122-141（httpGet 只保 header）/:180 bodyTimer+注释原文/:289/:308/:340-346/:355-357/:364-370（catch+rmSync+rename）;plugin-installer-adapter.ts:37；npm-git-installer 委托 installPackage；trash.ts 全部行号（:14/:16/:19/:23/:24/:27）；session-lifecycle.ts:499/:543。

**不命中（即三条 MUST_FIX 的事实基础）**：active 分支 delete 编排序（trash 非第一步）；流式路径 final 无 error 监听；workflow 域无 validateModel 调用点。

**旁证解出**：server.ts:416-434 外层 catch → sendError（P4-1 探针正路成立，见 INFO）。
