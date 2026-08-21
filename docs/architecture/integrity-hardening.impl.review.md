# integrity-hardening 实施一致性审查（R1）

> 审查日期：2026-08-20 / 审查范围 `git diff bb556d1d1..HEAD`（六 commit：026734166 / e3263ba83 / 0308eb1a1 / 29a555815 / 797655021 / 3d9f31186）/ 审查基调：对抗式（reviewer subagent 独立执行，主 agent 落盘）
> 声明：设计文档 `docs/architecture/integrity-hardening.md` 自 bb556d1d1（v3）后**零改动**，登记表 `data-source-registry.md` 最后一次改动停在 W1（e3263ba83）——所有实施期修正均未回写文档，方向二（代码→设计回写）的怀疑全部坐实。

## Summary

**8 must-fix, 6 suggestion, 5 info.** must-fix 集中在两类：① 设计文档/登记表/代码注释仍停留在「被探针推翻的原文」（收殓 env 判据、CSP 指令集、收敛编排机制、ext-config/worktrees 登记行）；② 真机验收发现的事实边界与执行状态无任何仓内登记（S5 边界、S1-S10 结果）。机制实现本身（方向一）质量高：22 条决策中 19 条如实落地且参数逐项吻合。

## Findings

### MUST_FIX

| # | 位置 | 类型 | 描述 | 修复方向 |
|---|---|---|---|---|
| 1 | `docs/architecture/integrity-hardening.md:37,132,226,234-235,323,364` vs `packages/runtime/src/services/reap-orphan-pi.ts:11-32` | 文档滞后+事实错误 | 收殓判据已从「env 含 `PI_CODING_AGENT_DIR`（macOS `ps eww`）」改为「argv `--mode rpc` + `--session-dir` 精确等值 + `ppid===1`」（macOS SIP 拿不到他进程 env，探针否决）。设计 6 处未更新：§1 术语「孤儿判据 = env…✅已核实」（「已核实」仅指 rpc-client.ts:134 传了 env，「env 可识别」在 macOS 为假）、§2.5 图示「孤儿判据 env 可识别却未利用」、§3.4 方案对比 A「env 天然隔离」、D4a/D4b 正文、S6 验收法「`ps eww \| grep PI_CODING_AGENT_DIR`」（该方法本身不可执行）、§6 门 4。D4b 三重防线形态也变了：代码防线②是 `ppid===1`（reparent 证据）而非「不在本进程子代表」，且 `reap-orphan-pi.ts:30-32` 明示单实例锁**不承担**排除另一合法实例职责（与设计 D4b 第三条相反） | 设计 §1/§2.5/§3.4/§4-S6/§6 按代码现状改写（代码头注释是现成素材），「✅已核实」标记改为探针否决记录 |
| 2 | `docs/architecture/integrity-hardening.md:207,215` vs `packages/runtime/src/services/session/message-dispatcher.ts:211-232` | 文档滞后+机制描述错误 | 设计 D3a 说强杀后「复用 onSessionExit 同构收敛」、方案对比 A 说「靠 exit 事件触发、收敛逻辑零新发明」。实际 kill 路径 exit 事件被双层守卫拦截（`rpc-client.ts:699` `_killing=true` 跳过 exitCallback；`process-manager.ts:305-308` 先删 Map 拦截 exit 回调），收敛由 message-dispatcher 内**手动编排**（detach → destroy → persistSessionOutcome('stopped') → publish session.exited → removeSessionEntry），是 onSessionExit 的**第二份副本**。读者按「exit 事件自动触发」理解，会给 onSessionExit 加收敛步骤而漏改此副本 → 两份收敛链漂移 | D3a 改写为手动编排 + 注明与 onSessionExit 的同步维护义务 |
| 3 | `docs/architecture/integrity-hardening.md:196` vs `packages/renderer/index.html:13` | 文档滞后 | D2c 起点指令集 `connect-src 'self' ws://127.0.0.1:* http://127.0.0.1:*`；W2 dev 实测定稿为 `connect-src 'self' ws://localhost:*`（renderer 实际连 `ws://localhost:<port>`，`packages/renderer/src/api/transport.ts:35`；删掉了 http://127.0.0.1）。设计未回写定稿集——读者按文档抄 CSP 会直接断掉 runtime WS 连接。且 ⛔门 5 只完成 dev 侧实测，打包态未验 | D2c 回写定稿指令集 + 标注「打包态实测随 S3 待验」 |
| 4 | `docs/architecture/data-source-registry.md:88` | 文档滞后+事实错误 | worktrees.json 行状态仍是「**计划中（W4）**；注释声称的对账兜底代码尚不存在」，锁协议栏仍是「计划：proper-lockfile withLock…⛔实施期门：bundle 验证」。W4（797655021）已全部落地：`worktree-registry.ts:162` withFileLock、`worktree-manager.ts:371` reconcileWithPhysical 对账已存在、bundle 探针已过。登记表是 pr-cr-fix review 的对照 SSOT，此行会直接误导 reviewer | 更新为已实施态 + 实际参数（async 版 10 次指数退避 100ms~10s/randomize + stale 30s + onCompromised；锁失败降级无锁 RMW + warn，见 `worktree-registry.ts:166-178`） |
| 5 | `docs/architecture/data-source-registry.md:86` | 文档滞后+事实错误 | rename-session-ext-config 行写「扩展侧 llm-shared saveConfig RMW **不持锁**…待 W4 扩展侧对齐；双侧 tmp 同名可碰撞…**部分实施（W1b），扩展侧 open**」。W4 已双端闭环：`llm-shared/src/config.ts:26,207` saveConfig 持 withFileLockSync 且**锁失败返回 success:false 不降级**（与 worktree 降级语义相反，代码内有论证），tmp 已唯一化（`config.ts:130-132`） | 更新为已实施（双端锁 + tmp 唯一化），登记两种失败语义及理由 |
| 6 | `packages/runtime/src/services/worktree-config-helper.ts:251-253` | 代码注释事实错误 | setRenameModel 注释仍说「extension 侧 saveConfig 当前不持锁…对齐留待主 agent 决策」。W4 已让 saveConfig 持同一把锁，注释与现实相反，会诱导重复实施或误判双写窗口仍开放 | 改写为「扩展侧 W4 已持同协议锁（@zhushanwen/pi-file-lock），双端闭环」 |
| 7 | `docs/architecture/integrity-hardening.md:45,201,215,322`（G3/D3a/终态/S5） | 事实未登记 | S5 真机两轮 PASS（3m35s/3m53s 收敛+restore），但发现边界：**全新 session 首个 turn 冻结时 pi 尚未 flush session 文件，重发得 SESSION_NOT_FOUND，「重发即可恢复」在该边界不成立**（pi session 文件延迟写入，AGENTS.md 规则 6 区）。此边界推翻 G3 的无条件表述，全仓无任何登记 | G3/D3a/S5 补边界例外与恢复指引（该场景需新建 session），登记为已知边界 |
| 8 | `docs/architecture/integrity-hardening.md` §4（:312-329） | 验收状态未登记 | S1-S10 实际执行结果（S1/S2/S5/S6 真机 PASS、S3/S4 打包态未验、S7 仅单测+集成测试、S8 仅 W0 单测、S9 未 push、S10 部分）在仓内**零登记**。最危险项：S3（打包态白名单/导航拦截/CSP）未验而 G2 声称「打包态安全不变量真实成立」，读者无从得知这是未验收断言 | §4 增结果列/实施验收记录，S3/S4 标记为待验 debt（若随后实测则更新为实测结果） |

### SUGGESTION

| # | 位置 | 类型 | 描述 | 修复方向 |
|---|---|---|---|---|
| 1 | `integrity-hardening.md:359-365`（§6） | 文档滞后 | 实施期门 5 项结论未按「已消解」格式回写：门 1（锁探针 3×300 轮零丢失，`pi-settings-store.ts:14`）、门 2（esbuild bundle 探针过）、门 3（SIGSTOP 全链已由 S5 真机覆盖）、门 4（env 探针否决判据）、门 5（dev 已做/打包未做） | 仿照「设计期已消解」把 5 门收敛并写结论 |
| 2 | `integrity-hardening.md:373-377`（附录 B） | 文档滞后 | 变更历史止于 v3，六波实施（commit hash + 各波偏离点）无记录 | 补 v4/实施记录条目 |
| 3 | `extensions/shared/quota-providers/src/cache.ts:221-234` | 遗漏 | D1c 明文「同模式顺手覆盖…quota-providers 日统计（minor 同族）」：`persistDailyRecord` parse 失败仍静默 reset 空记录并在下方写回（`readCacheSync:197-199` 同形态），无 quarantine——半截日统计文件会被合法化为空。无 deferred 登记 | 补 quarantine（或登记 deferred——静默跳过=未完成） |
| 4 | `packages/runtime/src/services/reap-orphan-pi.ts:20` vs `:24-26` | 代码注释自相矛盾 | 同一头注释内：「dev/prod 数据目录天然不同，互不误伤」vs「dev 与打包版**默认共用同一数据目录**」。后者为假：dev 自动隔离 `~/.xyz-agent-dev`（`apps/electron/main/main.ts:121-128`）。防线②结论（ppid=1）仍成立，但论据事实错 | 修正论据（真实场景：XYZ_AGENT_DATA_DIR 显式覆盖或同目录双开） |
| 5 | `AGENTS.md:27` | 导航滞后 | 「extensions/shared/ 共享库（quota-providers / llm-shared / extension-logger）」未收录 W4 新增的 `file-lock` | 列举补 file-lock |
| 6 | `packages/runtime/src/utils/file-lock.ts`（头注释）↔ `extensions/shared/file-lock/src/file-lock.ts:14-15` | 一致性保障缺失 | 双锁实现仅单向互指（extension 侧指 runtime 侧；runtime 侧不提 extension 孪生包），两份默认参数纯靠纪律同步，无测试/CI 断言 | runtime 侧头注释补互指 + 加断言两侧默认值相等的对照测试 |

### INFO

| # | 位置 | 类型 | 描述 | 修复方向 |
|---|---|---|---|---|
| 1 | `data-source-registry.md:90` | 表述错误 | auto-rename 行路径写「`<piAgentDir>/config/auto-rename` 等」，实际是 `<piAgentDir>/auto-rename-enabled`（`worktree-config-helper.ts:52`） | 路径改正 |
| 2 | `integrity-hardening.md:344` vs W0 commit | 排期差异 | chat-app 删除设计排在 W5「若授权」，实际 W0 已执行 | 附录 B 实施记录注明 |
| 3 | `.github/workflows/ci.yml` invariants job | 形态偏离（已论证） | D8b 说「直调既有检查」，bundle 脚本两段因无 preflight 模式改为等效 grep/node 实现，CI 内注明同步维护义务——可接受，但是长期双维护点 | D8b 补一句形态说明 |
| 4 | `pi-settings-store.ts:53-58` vs `:82-86` | 内部注释小失配 | PiSettings 接口把 `hideThinkingBlock` 归「model 域」注释，但 `SCOPE_FIELDS.model` 不含该字段（当前无 xyz 写入方） | 注释对齐（hideThinkingBlock 不在 xyz 写域，靠 scope-merge 保锁内最新值） |
| 5 | `integrity-hardening.md:162` vs `pi-settings-store.ts:20-21` | 表述精度 | 设计「无 stale 参数」略糙：proper-lockfile lockSync 默认 stale 10s 仍生效（pi 200ms 自旋等不到） | 文档精度对齐 |

## 设计决策逐条核对表

| 决策 | 代码状态 | 一致性判定（证据） |
|---|---|---|
| D1a | 已落地 | 一致。`file-lock.ts:41-43,64` 默认 stale 30s/25ms/预算 1s fail-fast；pi 侧形态四点论证逐字进 `pi-settings-store.ts:14-34`；探针结论已入注释 |
| D1b | 已落地 | 一致。4 scope + 11 调用点全迁移且 scope 与设计映射表逐一吻合（行号漂移 ±2） |
| D1c | 部分落地 | JsonStore + segments.json 已做；quota-providers 日统计未做（SUGGESTION #3） |
| D1d | 已落地 | 一致。双写已删、广播保留 |
| D1e | 已落地（双端）+ 登记滞后 | 代码闭环；登记表 :86 与 runtime 注释 :251 滞后（MUST_FIX #5/#6） |
| D2a | 已落地 | 一致。纯函数 + 三断言单测 |
| D2b | 已落地 | 一致。主窗口 + 嵌入 view 双挂 |
| D2c | 已落地（形态偏离定稿） | 指令集与设计起点不同且未回写（MUST_FIX #3）；打包态实测未做 |
| D2d | 已落地 | 一致。含 dev/prod userData 隔离说明 |
| D3a | 已落地（机制偏离） | RpcTimeoutError + SIGCONT 前置 + 强杀收敛齐备；收敛是手动编排非 exit 复用（MUST_FIX #2） |
| D3b | 已落地 | 一致。幂等 + 广播带 sessionId |
| D4a | 已落地（判据偏离） | argv+ppid=1 判据、5s 定时器调度点最前有注释；文档滞后（MUST_FIX #1） |
| D4b | 已落地（防线形态变化） | 三重防线 = argv 精确等值 + ppid=1 + 单实例锁（锁不承担跨实例保护）；文档滞后（并入 #1） |
| D5a | 已落地（形态偏离） | 新共享包双 API；锁失败降级无锁 RMW 为设计未提的实现决策（有论证）；登记表滞后（MUST_FIX #4） |
| D5b | 已落地 | 一致。双向 diff、死清活补、歧义保守跳过 |
| D5c | 已落地 | 一致。注释已指向实现 |
| D6a | 已落地 | 完全一致。单槽升列表 + 汇聚点清理 + 直调点移除 |
| D6b | 已落地 | 完全一致。双端清理 + 用户可见反馈 + sessionId 路由 |
| D7 | 已落地 | 一致。索引/supersede/路径注释/删除（提前到 W0，INFO #2） |
| D8a | 已落地（两行滞后） | 登记表 :86/:88 滞后（MUST_FIX #4/#5）；其余行锁参数与代码逐一吻合 |
| D8b | 已落地（形态偏离已论证） | invariants job 四检查 + __dirname 禁令；「直调」改等效实现（INFO #3） |
| D8c | 已落地 | 一致 |
| D8d | 已落地 | 一致。quota prune / skippedLines / shadow warn |

## 验收场景对照表

| # | 实际状态 | 文档登记 |
|---|---|---|
| S1 | 真机 PASS（25+25 轮交错零丢失；另有探针 3×300 轮） | 无仓内登记（MUST_FIX #8） |
| S2 | 真机 PASS（.corrupt byte-identical + 恢复日志） | 无仓内登记 |
| S3 | **未验**（打包产物已 build；G2 打包态断言未实证，CSP 也只有 dev 实测） | 未登记（风险最高项） |
| S4 | 未验（单实例锁只有单测） | 未登记 |
| S5 | 真机 PASS 两轮 + 边界发现未回写（首 turn 冻结→SESSION_NOT_FOUND） | MUST_FIX #7 |
| S6 | 真机 PASS（冻结孤儿 ppid=1 被 SIGKILL 收殓）；设计验收方法 `ps eww` 在 macOS 不可执行 | 未登记 |
| S7 | 仅单测 + 集成测试，无真机双 session 并发 | 未登记 |
| S8 | 仅 W0 单测，无真机 ask-user+kill-9 场景 | 未登记 |
| S9 | 未验（需 push 看 invariants job 实跑） | 未登记 |
| S10 | 基本达成（chat-app 已删、索引已改、supersede 已加、lint 无噪音源） | 未登记 |
