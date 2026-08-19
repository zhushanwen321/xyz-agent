# pi-assumption-remediation 状态账本

> 协调机制：cw-orchestrator 三方制衡（同 restore-fork-attach-fix 模式）。设计 SSOT = `docs/architecture/pi-assumption-remediation.md`（a3a15ef79）；证据 SSOT = `../2026-08-19-pi-assumption-audit/report-{a,b,c}*.md`（f2258401f）。
> 状态机：pending → building → built → verifying → verified → committed；失败 → rejected（打回修复后针对性复审）。
> 纪律：验收基线先行防篡改；subagent 禁 git 写；主 agent 唯一 commit 出口；pi 断言一律带实装版（node_modules 0.84.1 dist）锚点；extensions 改动本地 pi CLI 实测。

## 依赖图（执行顺序依据）

- 首波：W1a（model-switch）∥ W1b（provider-repair）——领地不相交（extensions/model-switch vs runtime infra/pi provider 域）
- 二波：W2（值域）∥ W3（wire 层）∥ W4（extensions isError）——领地：shared+值域行 vs event-adapter/pi-protocol vs extensions 5 包（除 model-switch）
- 三波：W5（core images + R1）→ W6（治本收尾）→ final gate（V1-V7 + dev app）

## wave 表

| wave | 名称 | 状态 | 验收基线 commit | 备注 |
|------|------|------|----------------|------|
| W1a | model-switch setModel 真切 | committed | 5481b2e9d | verifier PASS（报告 acceptance/w1a-report.md：锚点 4 组复核全真/plan≠provider 连带 bug 独立证实（setup.ts PROVIDER_TO_PLAN 8 条映射为证，-router 变体有仓内依据）/appendEntry 删除零破坏（customType=model_change 消费方全仓 0 + appendEntry 恒写 type:custom 双证）/独立 pi CLI 实测切换生效 + --continue 恢复 + 原生 entry 2 条 custom 0 条/红性删 setModel → 4/7 红字节还原）。2 observation 不阻塞（豁免清单滞后说明 / W1b 文件归属） |
| W1b | provider-repair 八字段对齐 | committed | 5481b2e9d | verifier PASS（报告 acceptance/w1b-report.md：同构 16 形态探针全一致（authHeader:false 等 pi 原文核实）/仅 2 zod 缝隙差异判定保守自愈合理/「刻意不纳入」两项评估 = pi 单 provider 粒度报错优于静默删除/红性退五字段 → V2 红字节还原/3204 一次全绿/store.ts 仅注释 diff 逐行核实）。2 suggestion 级不阻塞（headers:{} 与 zod 缝隙形态无显式用例） |
| W2 | 值域 SSOT 派生（thinking max/KnownApi/prompt/包名/注释） | committed (5acd3335b) | 899157062 前基线 d48793a39 | verifier PASS：双向编译断言攻击命中（删 max/加 ultra 均 TS2322）+ system prompt 真函数探针 32/32 行 + 红性 |
| W3 | wire 层（tool-call-index + 协议 select 类型） | committed (7808bbc95) | d48793a39 | 路径 a 实现：toolcall_end.toolCall.id 提取 + PiMessageUpdateEvent.message 死字段删除 + 真实 pi 锁定 4 用例。verifier PASS：独立 wire 抓包 57 事件双通道复核 + 行为级 translate 全链路 + 红性 3 红 |
| W4 | extensions isError throw 范式（9 处 5 包）+ goal stale + 6 注释 | committed (4bc988013) | d48793a39 | verifier PASS：9 处 diff 逐字审 + 独立双路径真实 pi 实测 isError=true + 红性 5 红；textResult 残留修正 23 处 → W4b |
| W5 | core images 双修 + R1 createWriteStream | pending | — | — |
| W6 | 治本（clone 更新/断言规则/探针/观察项） | pending | — | — |

## 事件

- 2026-08-20 计划启动：用户裁决「全部都要修复」。设计文档 a3a15ef79（fix 全集 = 13 错误 + 8 漂移 + 可低成本对齐风险项 + 治本；out of scope：bash 并发放开 D1 / 已删数据追溯 D2 / F8+compat 登记 D-观察）。首波 W1a + W1b 双 builder 并行派发。

| W4b | textResult 23 处 + stale 分诊复活 | committed (d5c4225dd) | 899157062 | verifier PASS：23 处文案机械证明（diff 文案行全上下文行）+ helper 签名收缩 TS2554 防回潮 + 独立实测 generate ESM isError=true + 红性双层；范围外发现（run 假启动）实锤 → W4c |
| W5 | core images 双修 + R1 createWriteStream | committed (527557908) | 899157062 | verifier PASS：core/runtime 版 21 断言 deepEqual + live≡replay 全链路探针恢复 + R1 四探针 + 红性双删均红；R1 别名 import 为家族既有边界（登记非回退） |
| W6 | 治本（clone 更新/断言规则/探针/观察项） | committed (70a889b1d) | 899157062 | clone 0.80.3→0.84.2（ff-only，worktree 指针修复）；AGENTS/ADR 断言权威源改实装版；A-10 探针判「无竞争」（retry 全程 isStreaming=true，旧 clone 前提推翻——verifier 三重复核含独立 400ms 抢发探针）；A-11 判「成立」；troubleshooting 三观察项 |
| W4c | workflow run 假启动修复（W4b verifier 发现） | committed (410fc000f) | — | 主 agent 直修（一行 + 回归测试）：actionRun 判 !script \|\| !script.available 对齐 suggestions 分支口径；探针实测复现过假启动 |

- 2026-08-20 **计划收官（W1a/W1b/W2/W3/W4/W4b/W5/W6/W4c 全 committed，9 wave + verifier 全 PASS）**。V7 终回归全绿：runtime 3222/3222（attach-lifecycle 真实 pi 用例在连续锤击下偶发资源竞争 flaky，单跑 4/4 + 全量复跑全绿，既有 W15/W1b 先例同型，非本计划引入）、core 1028、renderer 3066、extensions 三连（subagent-workflow 2246）、R1 exit 0。V1-V6 场景均有 wave 级真实 pi 行为证据（W1a 三阶段实测切换+恢复 / W1b 防误删 / W2 thinking max / W3 wire 锁定 / W4·W4b isError 实测 / W5 live≡replay 探针）；设计 §4 的 dev-app 端到端抽查（builtin 打包链形态）留作可选收尾未跑，需要时可派 gate executor。
- 2026-08-20 **Final gate 执行 + P1/P3 修复（计划闭环）**。gate executor 真实 dev app（5 轮生命周期，含并行 worktree 端口互杀 3 次如实入报告）产出 gate/final-gate-report.md + 18 证据文件：**V4 tool-call-index PASS**（contentIndex 真产出，toolCallId WS 帧 ≡ JSONL ≡ UI testid 三方一致，重开保留）；**V1 PARTIAL**（切换四点全 PASS 含失败路径真 400 反馈 + 4 条原生 model_change 零 custom 双写；但**重启恢复 FAIL**——P1 root cause：rpc-client.ts 无条件把全局默认 --model 拼进 spawn args，pi CLI model 恒优先压过 entry 恢复，W1a 报告 116 行预警的 gap 在 GUI 全链路实证）；**V3 PARTIAL**（max 档真实下发 WS 帧一手证据；mimo 族 supported levels 止于 high 被 pi 静默钳制，本环境结构性不可验 max 生效）。P1 主 agent 复核三环根因属实后直修（W4c 同模式）：RpcClientOptions.inheritSessionModel（restore 附着不拼 --model，preset model 是 launch-only）+ 单测 5/5 + 真实 pi 行为级用例三阶段（entry 恢复 ✓ / CLI 压过 bug 形态锁定 ✓）+ 红性（T1/T2 红字节还原）→ 3122127c0。P3 顺手修：setThinkingLevel reply/缓存回 pi 生效值（钳制场景请求值污染 pending 确认）+ 4 用例 → 93128c411。P2（thinking 钳制 UI 无提示）+ fork 同族 --model 压过 登记 troubleshooting 观察项 4/5。runtime 全量 3232/3232 绿。gate 产物 commit 见 `chore(harness): final gate report`。
