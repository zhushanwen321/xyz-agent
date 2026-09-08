# Composer Token 速度口径修复：采样分母改为 LLM 请求窗口（方案 A）

> **一句话结论**：速度样本的 durationMs 从「turn 全程墙钟（含工具执行时间）」改为「单次 LLM 请求窗口（assistant message_start → assistant message_end）」，采样点、存储、聚合、协议、renderer 全部不动。

## 1. 背景目标

**S（情境）**：composer 底栏常驻显示当前模型 token 速度（t/s），hover 出本次/今日/近 7 天/近 30 天四个聚合值，供用户判断「这个模型生成快不快」。
**C（冲突）**：2026-09-08 真实落盘数据分析发现，四个聚合值被工具执行时间系统性稀释——工具重的 turn（bash 跑测试数分钟）只贡献少量 output token 却贡献巨量 duration，加权均值被拉低到真实流式速度的 1/2 ~ 1/4（mimo-v2.5-pro 当日加权 9 t/s，剔除工具稀释样本后 35 t/s，差 4 倍）。UI 口径说明却写着「不含工具执行时间」——**文案与实现不符**。
**Q（问题）**：速度采样的分母为什么含工具时间？怎么只测 LLM 生成窗口？
**A（答案）**：pi 的 turn 边界跨越工具执行（turn_end 在 executeToolCalls 之后才发），而 runtime 现行锚点对恰好是「turn 开始 → turn_end 到达」。把闭合点前移到 assistant message_end（LLM 请求完成事件，先于工具执行到达）即可，起算点不动（它本来就是 assistant message_start）。

**目标（使用者视角倒推）**：

| # | 目标 | 来源 |
|---|---|---|
| G1 | 速度数字恢复「LLM 生成速度」语义：带长工具的 turn 不再把本次/聚合值拉到个位数 t/s | 用户原始诉求「llm 的 token 速度」 |
| G2 | UI 口径说明「不含工具执行时间」变为真实陈述 | 文案-实现一致性 |
| G3 | 现有可靠性语义不回退：无值 null 纪律、bogus guard、跨重启恢复、模型视角广播全部保持 | composer-gen-stats 设计 G2/G3/G4 |
| G4 | 存储与协议零迁移：旧样本自然老化出清，30 天内混合口径过渡可接受 | 改动最小化 |

**In scope**：runtime event-interpreter 计时锚点状态机；pi 语义静态探针；注释/文档同步；interpreter 级单测。**i18n 零改动**：zh/en 口径说明现文已是目标口径（「按单次 LLM 请求耗时计算，不含工具执行时间」，panel.ts:177 两侧一致），且 `gen-stats-triggers.test.ts:182-183` 已锁定该文案——G2 由「实现追上文案」达成，实施者无需寻找 i18n 改动点。
**Out of scope**：聚合算法（已是加权 Σ/Σ，无差异，本文档不复审）；存储布局与 GC；WS 帧 / RPC 协议；renderer 组件；bogus 阈值标定；streaming 中的实时滚动速度（二期，既定）。

## 2. 现状与问题分析

### 2.1 使用者视角的现状（真实例子）

用户让 agent 跑一个「改代码 + 跑测试」的任务。其中一轮 turn：LLM 流式输出 622 token 用了约 20 秒（真实流式速度约 30 t/s），随后 bash 跑测试 14 分钟。turn 完成后 composer 速度触发器显示 **0.7 t/s**（622 ÷ 854790ms，`~/.xyz-agent/gen-stats/speed/zai-coding-cn__glm-5.3-*.json` 真实样本）。用户看到的是「模型慢得离谱」，实际模型不慢——慢的是测试。

### 2.2 根因：物理数据流中闭合点晚于工具执行

现行采样链路（pi 0.84.4 实装，`npm ls` 核对；✅ 以下全部为本次设计前静态直读 dist 源码核实的探针事实）：

```
pi 子进程 (agent-loop.js)                        runtime
──────────────────────────────                  ─────────────────────────────────────
turn_start ────────────────✗不翻译（adapter NULL_EVENTS，event-adapter.ts:1198-1202）
message_start{assistant}（首个流事件到达）
  │→ adapter: kind 'turn-start' + 帧 message.message_start
  │                                   ────→  interpreter turn-start case:
  │                                           turnStartedAt = Date.now()   ←【起算点：正确】
  │-streaming (message_update*)…                     （'turn-start' kind 本就来自
  │                                                    assistant message_start，
  │                                                    event-adapter.ts:786-797）
message_end{assistant}（流完成，先于工具）
  │→ adapter: 帧 message.message_end(entry)
  │                                   ────→  interpreter: 仅转发 WS 帧，无计时动作
  │                                                                           ←【缺失的闭合点】
executeToolCalls（bash/编辑/子代理……分钟级）
  │
turn_end（含 usage，工具跑完才发）
  │→ adapter: kind 'turn-usage'       ────→  interpreter turn-usage case:
                                              durationMs = Date.now() - turnStartedAt
                                              ↑【闭合点：错误】= 生成 + 工具 + 抖动
                                            → GenStatsService.recordSample 落盘
```

- **起算点已经正确**：`turn-start` kind 并非来自 pi 的 turn_start 事件（该事件不翻译），而是来自 pi **assistant message_start**（event-adapter.ts:786-797 `!msg` 分支与 :853-858 兜底分支，两处都发 `turn-start` kind + `message.message_start` 帧）。即现行 duration 的起点 = LLM 流式窗口开端。
- **闭合点错误**：唯一的闭合动作发生在 turn-usage case（`Date.now() - turnStartedAt`，event-interpreter.ts:456-464），而 pi 的 turn_end 在 `executeToolCalls` **之后**才 emit（agent-loop.js:139-147，✅ 实装源码核实）。
- **设计史**：原设计文档（composer-gen-stats.md §2.2）将 turn 窗口误当「单次 LLM 请求窗口」（「每个 turn 恰好一次 LLM 请求」只断言了请求次数，未核实 turn_end 的时序）；GS-5 登记只承认了毫秒级 RPC 抖动，漏了分钟级工具时间。i18n 文案「不含工具执行时间」从第一天起就是错的。

### 2.3 影响量化（真实落盘数据，2026-09-08 当日）

| 模型 | 现行加权 | 剔除工具稀释样本后 | 差倍 | 稀释样本（<15 t/s 且 >20s）时长占比 |
|---|---|---|---|---|
| xiaomi-token-plan-cn/mimo-v2.5-pro | 9 t/s | 35 t/s | 4.0x | 18/94 条，占 77% |
| zai-coding-cn/glm-5.3 | 32 t/s | 64 t/s | 2.0x | 11/546 条，占 50% |
| deepseek/deepseek-v4.1-flash | 113 t/s | 262 t/s | 2.3x | 5/141 条，占 60% |
| zai-coding-cn/glm-5.3-flash | 29 t/s | 49 t/s | 1.7x | 29/960 条，占 41% |
| kimi-coding/k3-256k | 37 t/s | 37 t/s | 1.0x | 0（当日无工具重 turn） |

结论：稀释是系统性的（工具型工作流必然触发），不是长尾噪声。聚合窗口越长越接近「稳态被拉低」值，因为工具时间占比在工作流层面是稳定比例。

### 2.4 pi 事件时序契约（方案依据，全部 ✅ 静态核实）

| # | 断言 | 证据（实装 0.84.4 dist） |
|---|---|---|
| P1 | assistant message_end 先于 turn_end 到达（成功与 error 路径均是） | agent-loop.js:122-147（stream 返回后才 executeToolCalls → turn_end）；:236-251 error 分支 emit message_end 后 return，turn_end 于 :125 |
| P2 | message_start{assistant} 在流首个事件时 emit，晚于请求发出 | agent-loop.js:205-207（`case "start"` 才 emit）|
| P3 | 流异常闭合存在**双分支**，均发 message_end：① 优雅分支（用户 Esc 等，实测主路径）——pi-ai 流 push error 事件，agent-loop for-await 正常进 `case "error"`，emit **真实 partial message 的 message_end**（真实部分 usage），后 turn_end 于 :125；② 硬异常分支（进程内 throw）——`agent.js:347-365 handleRunFailure` 合成四事件 message_start+message_end+turn_end+agent_end，failureMessage `role:"assistant"`、`content:[{type:"text",text:""}]`（空文本）、`usage: EMPTY_USAGE`、`stopReason: aborted\|error`。真缺闭仅剩「pi 进程崩溃/断连（帧不到达 runtime）」一种。佐证：真实落盘 2088 条样本 output=0 为 0 条 → 用户 Esc 走①（②的 EMPTY usage 在 adapter 门槛被丢，见 §3.3 D2 防御栈） | agent-loop.js:196-251（①）+ agent.js:347-365（②），均 ✅ 静态核实 |
| P4 | 每 turn 恰一条 assistant message（1:1） | agent-loop.js:96-147 内层循环每轮恰一次 streamAssistantResponse；steering 注入发生在 turn_start 与 streaming 之间，不产生 assistant message |
| P5 | custom 消息（扩展注入）在 turn_end 之后 flush，不落入窗口 | agent-session.js:423-427（turn_end 处 flush pending custom） |

## 3. 解决方案

### 3.1 终态（使用者视角）

成功路径：用户发起带工具的任务。某轮 turn：LLM 流式输出 622 token 花约 20 秒，随后 bash 跑测试 14 分钟。turn 完成后 composer 显示 **≈31 t/s**（622 ÷ ~20000ms）——与用户 watching 文字流出的感知一致；14 分钟工具时间不再进入分母。hover 浮层四个聚合值随新样本逐步上修；口径说明「不含工具执行时间」成为真实陈述。

失败路径与恢复指引：

| 场景 | 用户看到 | 恢复 |
|---|---|---|
| turn 被用户 Esc 中断（流中途 abort，优雅分支①） | 有部分 usage（provider 已计 token）→ 产出「部分流窗口」样本（已流出 token ÷ 真实流时长，语义成立）；usage 空 → 不产样本 | 无需操作；命中率与速度同样仅在部分 usage 非空时采样（EMPTY 门槛），命中率的时间无关性不变 |
| pi 进程内硬异常（throw → handleRunFailure 合成事件，分支②） | 合成 message_end 被 role 守卫放行但窗口 ≈0ms——无样本落盘（EMPTY usage 在 adapter 门槛丢弃 turn-usage，且重锚清残留，见 D2/D3） | 无需操作；下个正常 turn 自愈 |
| pi 进程崩溃/断连，message_end 帧不到达（真缺闭） | 速度显「—」（durationMs=null，§3.5 null 契约不变） | 下个正常 turn 自愈 |
| 升级后首日聚合值「偏低混合期」 | 今日/7天/30天含 ≤30 天旧口径样本，缓慢上修 | 自然老化出清（D4），无需清数据 |
| runtime 中途启动（错过 message_start） | 速度显「—」（durationMs=null） | 下个完整 turn 自愈（现行契约不变） |

### 3.2 方案对比

| 候选 | 长期架构合理性 | 短期实现成本 | 风险 |
|---|---|---|---|
| **A（选定）闭合点前移**：interpreter 在 assistant message_end 帧到达时结算 duration 存入新状态，turn-usage 消费之 | 计时锚点语义与事件物理边界对齐（LLM 窗口）；采样点/存储/协议零改动；interpreter 单点状态机可测 | 极小：interpreter 两个 case 各 ±1-3 行 + 一条新状态字段；测试集中在 interpreter | 依赖 P1 时序（message_end 先于 turn_end）——pi 上游若改时序则退化为 null（安全失败），静态探针守卫漂移 |
| B 采样点整体迁移到 message_end：usage 在 message_end 就地取用，不再依赖 turn-usage | 少一层间接（不再经 turn-usage） | 大：cache 采样、onContextUpdate/onTurnUsage 编排全挂在 turn-usage；failureMessage 合成路径的 usage 形态需另行核实；动两处采样契约 | 扩散到无关行为（context.update 时序），回归面大；且 cache 采样随迁后失去 turn-usage 翻译处 EMPTY usage 门槛的天然守护（合成 turn 的空 usage 现由该门槛丢弃），需自建等价防退化采样——回退 G3 |
| C 扣除工具时间：保留 turn 窗口，用 tool_execution_start/end 事件差相减 | 理论上同样剔除工具时间 | 大：需处理并行工具批的时间区间合并（重叠区间去重）、事件丢失下的负值防御 | 区间代数易碎（pi 工具批并行语义漂移即错）；代码量与复杂度远超收益 |
| D 只改文案承认含工具时间 | 无架构改动 | 极小 | 指标失去「LLM 速度」意义（差 2-4x），用户决策价值崩塌——被问题定义直接否定 |

**推荐 A**。若用 B，cache 采样迁至 message_end 后失去 turn-usage 翻译处 EMPTY usage 门槛的天然守护，需自建等价防退化采样；若用 C，工具批并行重排一个事件序即产出负 duration；若用 D，§2.3 的 4 倍偏差永久合法。

### 3.3 关键决策与权衡

**D1 窗口定义 = assistant message_start 到达 → assistant message_end 到达（runtime 本地时钟差）**。
起算点沿用现行 `turn-start` kind（即 message_start{assistant}，P2 探针标明它晚于请求发出、在流首个事件时触发）——即窗口不含「请求发出→首事件」的准备段（context 转换 + HTTP 握手 + 首事件延迟），测得值略偏高（乐观偏差）。**量级声明**：偏差 = 首事件延迟（TTFT 段），设计期无落盘数据可锚定（gen-stats 只记 turn 总时长）→ 归 S1 验收实测锚定（对照同模型无工具 turn 的流出感知与显示值）；**重审触发条件**：臂 (b) 为主触发——用户反馈显示值系统性高于体感 → 重审口径（起算点回退到请求发出时刻或纳入首段）；臂 (a)（实测首事件延迟占窗口中位数比例 >50%）为诊断辅助量，需测量时以一次性 dev 模式诊断（临时记录 message_start→首个 message_update 间隔）获得。接受理由：与用户「看文字流出的速度」心智一致；若并入会重新引入对 provider 首包延迟的敏感度，与「生成速度」语义冲突。两端各有毫秒级 RPC 传输抖动，方向不定，不做时钟校正（GS-5 精神延续）。被否替代：以 pi turn_start 为起算（需新翻译该事件，且含 steering 注入与请求准备段）——无收益纯增量。

**D2 闭合信号带 role 守卫 + 合成事件防御栈**：interpreter 仅在 `message.message_end` 帧 payload 的 `entry.message.role === 'assistant'` 时结算窗口。user/toolResult 的 message_end 帧同样流经 interpreter（MESSAGE_END_ALLOWED_ROLES 全量下发，event-adapter.ts:901-935 ✅），custom 的 subagent-directive 亦然——无守卫会被它们错误闭合（截断 duration）。P5 已证 custom flush 在 turn 外，但守卫使「不靠时序靠结构」。

合成 message_end（P3 分支②，handleRunFailure）会被 role 守卫放行并结算出 ≈0ms 窗口，但不构成污染，防御栈三层（结构递进，均 ✅ 核实）：① adapter `handleTurnEndPi` 首行 `if (!usage?.totalTokens) return []`（event-adapter.ts:430）——EMPTY_USAGE 的合成 turn_end 不产 turn-usage 事件，该 turn 无从采样；② 结算残留的 ≈0ms `llmWindowDurationMs` 由下一 turn-start 重锚同步清除（新结构不变量，见 D3），不可泄漏至后续 turn 的 usage 消费；③ 即使前两层之一失效（①为 pi 上游漂移、②为实现回归），bogus guard（output>50 && duration<100ms）兜底拦截大 token 退化样本。**被否（减法裁定）**：结算处再加「本 turn 存在过 message_update 流动」标记守卫——第四层，需穿 message_update 高频帧路径置位，复杂度大于已被三层结构防线封闭的残余风险。

**D3 异常配对矩阵（全部安全失败，无僵尸态）**：

| 事件序（△ = 异常） | turnStartedAt | llmWindowDurationMs | turn-usage durationMs | 效果 |
|---|---|---|---|---|
| 正常：start → end(assistant) → usage | t₀ → null（end 结算清） | t₁-t₀ → null（usage 消费清） | t₁-t₀ | 正常采样 |
| △缺起（runtime 中途启动/丢事件）：end(assistant) 先到 | null | null | null | 速度样本跳过，cache 照常（现行契约） |
| △真缺闭（pi 崩溃/断连，P3 收窄后唯一缺 end 形态）：start 后无 end | t₀（残留） | null | null | 速度样本跳过，cache 照常；残留 t₀ 下轮 start 覆写 |
| △usage 缺席（turn_end 丢失）：start → end | null（end 已清） | d（残留） | 不触发 | **重锚清除不变量**：下轮 start 将 llmWindowDurationMs 置 null、turnStartedAt 重锚为新时刻（非置 null）——d 生命周期以「下轮 start 到达」为界严格限本 turn；start 亦丢失的复合见下方「△stale-d 缺起复合」行 |
| △合成对（P3 分支② handleRunFailure）：合成 start → 合成 end(assistant, EMPTY usage) | t₀′ → null | ≈0ms（残留） | 不触发（adapter EMPTY 门槛丢 turn-usage） | 本 turn 无样本；残留 ≈0ms 由下轮 start 重锚清除 → 永不入盘 |
| △stale-d 复合：上轮 d 残留 × 本轮 end 不到但 usage 到 | null | null（重锚已清上轮 d） | null | 无「旧窗口 × 新 token」垃圾样本——重锚清除不变量封闭该复合 |
| △stale-d 缺起复合（双事件丢失）：上轮 d 残留 × 本轮 start 丢失 × 本轮 usage 到 | null（上轮 settle 已清） | d（残留；缺 start 无重锚清除） | d（一次性消费 stale 值） | 唯一可泄漏复合（文档级枚举，八行单测覆盖面之外）：需「上轮 usage 丢失 + 本轮 start 丢失」双事件丢失才可达；至多产出一条旧窗口样本（消费后置 null 自愈，后续 turn 恢复 null 纪律）；极端值仍被 bogus guard 兼底——残余风险为有界单样本，接受（修复需引入跨 turn 配对标记，复杂度大于封闭面） |
| △双 start（pi 异常重入）：start → start | t₀ → t₀′（覆写重锚） | — | t₁-t₀′ | last-writer-wins，取最后窗口 |
| △他角色 end 混入（custom/user/toolResult） | 不动 | 不动 | — | role 守卫拦截（D2） |

结构性说明：**重锚清除不变量**——turn-start case 同步置 `turnStartedAt = Date.now()` 与 `llmWindowDurationMs = null`，使 duration 残留的生命周期严格限于本 turn，「残留跨 turn」路径被结构性封闭（不再依赖「下轮 end 必到」）。turn-start 每轮必到（message_start{assistant} 是 turn 的定义性事件）。turn-usage 处保留对 turnStartedAt 的既有清 null（防纵深，零成本）。

**D4 旧样本不迁移**：落盘文件 append-only，新旧口径样本 ≤30 天内共存（30 天 GC 出清，`pruneExpiredDays` 写时 GC ✅ 实装核实）。过渡期 day/d7/d30 聚合值偏低（偏向旧口径），current 立即正确（末条 = 新口径）。接受理由：数据量小（每模型日均 ~10² 条）、无消费方做历史对比、迁移脚本引入的写风险大于读偏差收益。**重审触发条件**：出现依赖聚合值做跨期对比/决策的消费方（如 speed report、模型选型看板），或用户反馈「聚合值与 current 长期倒挂」造成误读 → 启动一次性迁移（口径标记或双轨文件），届时走独立设计。

**D5 bogus guard / 聚合 / 存储 / 协议零改动**：`isBogusSpeedSample`（output>50 && duration<100ms）在新口径下语义更准（纯流式窗口内巨量 output 极短完成仍是回放型异常）；`aggregateSpeed` Σ/Σ 不变；文件格式不变；`GenStatsFrame`/`session.stats_update`/`session.getGenStats` 不变。

**D6 interpreter 内实现，不加新 translated kind**：闭合捕获在 interpreter 既有 `case 'message'` 分支内按帧 type + payload role 识别（先例：同 case 内 `handleSubagentBgNotify` 已做帧内容检查）。被否：adapter 新增 `genstats-window-close` kind——为一个消费方扩协议翻译面，跨界收益为零。

## 4. 验收（实施后在真实场景验证）

| # | 场景（真实上下文） | 步骤 | 通过标准 | 回溯 |
|---|---|---|---|---|
| S1 | 无工具纯对话：新开 session 对当前模型说「写一首短诗」 | 等完成，看 composer 速度触发器与 hover「本次」 | 本次 ≈ 该模型已知流式速度量级（对照：同模型无工具 turn 的 message_update 流出感知）；显式非 0.7 t/s 式畸形低值 | G1 |
| S2 | 长工具 turn（核心场景）：让 agent 修改代码并 `bash` 跑 ≥1 分钟的测试 | 完成后看「本次」 | 本次速度与该模型 S1 量级一致（工具分钟数不进分母）；落盘新末条样本 duration ≪ turn 墙钟（秒级 vs 分钟级） | G1/G2 |
| S3 | 聚合与口径：S2 后看 hover 口径说明与四值 | hover 速度触发器 | 说明文案「不含工具执行时间」成立；今日值较升级前同场景 visibly 上修（混合期允许部分上修） | G2 |
| S4 | 中断恢复：流式输出中按 Esc | abort 后看速度触发器与落盘末条 | 无崩溃、无「—」闪烁（帧链路未动）；该 turn 要么产出「部分流窗口」样本（有部分 usage 时，量级 = 已流出 token ÷ 真实流时长），要么不产样本（EMPTY usage）——**不出现 ≈0ms 畸形值或 0 t/s current**；下个正常 turn 恢复刷新 | G3 |
| S5 | 重启恢复：完全退出重开 app，切回该 session | 切入即看触发器 | 恢复腿 RPC 显示与重启前一致的聚合（新样本口径） | G3 |

单测层（防回归，非验收替代）：interpreter 配对矩阵八行全量（含合成对、stale-d 复合两新增防御行；stale-d 缺起复合为 D3 文档级枚举、不设单测——双事件丢失才可达且有界自愈，接受）+ role 守卫 + 双 start 重锚 + 重锚清除不变量；pi-semantics 静态探针守 P1/P3/P4 漂移（见 §5 U2）。

## 5. 下一层拆分（实施路径）

| # | 单元 | 内容 | 文件 | 为什么独立 |
|---|---|---|---|---|
| U1 | interpreter 状态机 | `turnStartedAt` 语义注释更名（LLM 窗口起算）+ 新增 `llmWindowDurationMs` 状态 + `case 'message'` 内 assistant message_end 结算 + **turn-start 重锚同步清 llmWindowDurationMs（重锚清除不变量）** + turn-usage 消费改源 | `packages/runtime/src/services/session/event-interpreter.ts` | 核心变更，单测可独立闭环 |
| U2 | pi 语义静态探针 | 守四断言：P1（message_end 先于 turn_end）、P3①（error 分支 emit message_end）、P3②（agent.js handleRunFailure 合成四事件 + failureMessage 形态：EMPTY_USAGE/空 text/assistant role）、P4（agent-loop 每 turn 迭代恰一次 streamAssistantResponse 调用——tokens↔duration 1:1 配对前提，破裂时新口径会产「末窗口 × 全 turn tokens」的静默偏高样本，必须守） | `packages/runtime/src/infra/pi/__tests__/pi-semantics-turn-usage-model.test.ts` | pi 升级防线，独立于行为单测 |
| U3 | D3 矩阵单测 | 配对矩阵八行全量（含合成对、stale-d 复合）+ role 守卫（user/toolResult/custom 非闭合）+ 双 start 重锚 + 重锚清除不变量（fake timers 控时钟） | `packages/runtime/src/__tests__/event-interpreter.test.ts` | 回归防线，依赖 U1 |
| U4 | 注释/类型语义同步 | `GenStatsSample.durationMs` 语义注释（types.ts）、gen-stats-service.ts recordSample 丢弃规则注释（:111-113）GS-5 口径注更新（D2 引用改指 message_end 闭合） | `packages/runtime/src/services/session/{types,gen-stats-service}.ts` | 纯文档性，随 U1 同 commit |
| U5 | 设计文档回写 | composer-gen-stats.md：§2.2 数据流图闭合点、GS-5 口径注、D2 注释（turn-start= message_start 已对，补闭合点）、§4 场景表速度值描述 | `docs/design/composer-gen-stats.md` | C-proc-10 回写纪律 |
| U6 | 全量验证 | runtime 相关 vitest（event-interpreter / gen-stats-* / pi-semantics）+ renderer 冒烟（不涉及） | — | 交付门槛 |

待验证（设计期无法定论，实施期核实）：D1 乐观偏差（首事件延迟占比）的量级锚定——归 S1 验收实测（记录显示值与流出感知对照），超阈值触发 D1 重审条件。

## 6. 自检结论与变更历史

五段齐备；方案 4 选 1 含被否谱系；运行时断言全部附 ✅ 探针标记；数据流图含闭合点标注；错误矩阵 8 行含恢复指引；验收 5 场景均回溯 G1-G3 且为真实操作（无 mock）；拆分 6 单元均可独立验收。受众假设检查：pi turn/message 事件模型在 §2.2 图内自解释。

**R1 修订（对抗式审查第 1 轮，双报告 3 must-fix + 4 suggestion 全修）**：

1. **P3 重写（主审 MUST-FIX，被否谱系）**：初版断言「abort 中断流时 message_end 不 emit（for-await 抛出结构推导）」——被实装事实击穿：`agent.js:347-365 handleRunFailure` 在 throw 路径合成 message_start+message_end+turn_end+agent_end 四事件。修订后 P3 为双分支（优雅 error → 真实 partial message_end；硬异常 → 合成事件），真缺闭收窄为进程崩溃/断连。击穿后果链（合成 end 结算 ≈0ms）以 D2 三层防御栈 + D3 重锚清除不变量封闭；初版「待验证 ⛔」标注一并纠正（设计期 read agent.js 即可定论，非实施期项）。
2. **D1/D4 补重审触发条件 + D1 量级降级为 S1 实测锚定（影响面审 MUST-FIX ×2，P0-20 四要素补齐）**。
3. **D3 重锚清除不变量（影响面审 SUGGESTION 采纳为结构不变量）**：turn-start 同步清 llmWindowDurationMs，封死 stale-d 复合；同步补合成对行与 stale-d 复合行。
4. **U2 探针扩面（双报告 SUGGESTION 合并）**：补 P3②（handleRunFailure 合成形态）与 P4（每 turn 恰一次 streamAssistantResponse）静态断言。
5. **§2.2 引用修正（主审 SUGGESTION）**：turn_start 不翻译的权威位置 = NULL_EVENTS（event-adapter.ts:1198-1202），原 :804 引用错位。
6. **i18n 零改动显式化（影响面审 INFO 采纳）**：In-scope 注明文案已被测试锁定，实现追上即可。
