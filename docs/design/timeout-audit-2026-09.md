# 全项目超时普查总报告（2026-09-04）——P0-P3 修复任务 SSOT

> **一句话结论**：15 份模块报告 / 177 文件普查登记约 200 条时限设置，抓出 4 条任务执行正常路径的固定墙钟违规（❌）、16 条可疑（⚠️）与 5 条非超时类附赠发现；全部修复任务按 P0-P3 分组，落为 5 份设计文档（见 §6 映射表）。

## 0. 执行概况与证据来源

- **触发案件**：zcode subagent「执行一半挂了」——深诊实锤为 `ZCODE_APPSERVER_TURN_DEFAULT_TIMEOUT_MS=300s` 固定墙钟误杀（34 个真实任务中 7 个 286-299s 撞线被杀、其中两个 app-server 侧 343s/541s 正常完成、死后继续烧 token，21% 误杀率）。
- **普查方法**：并行 subagent 分模块只读调研（≤15 文件/模块；5 个首轮因 provider 瞬时故障失败重派），对照 AGENTS.md 规则 19「超时默认原则」与权威裁决 `docs/design/subagent-core-unbounded-wait-audit.md`（正常路径逐点根修 + 回收层统一有界兜底）+ ADR-0047（静默 ≠ 卡死）。
- **普查日期**：2026-09-04；普查 session：`~/.xyz-agent/pi/sessions/2026-09-04T02-41-51-036Z_01a06a4b-*.jsonl`（15 份模块报告全文在 `~/.xyz-agent/pi/agent/subagents/--Users-zhushanwen-Code-xyz-agent-workspace-fix-zcode-subagent-failed--/sessions/` 对应 subagent session 内，诊断 session T001 含 zcode 根因报告）。
- **判定口径**：✅ 合法（控制面单请求秒级 / 回收层有界兜底 / opt-in 显式传参 / idle·无进展检测）· ⚠️ 可疑（量级或语义错配，未直接违规）· ❌ 违规（任务执行正常路径固定墙钟 + 默认生效 + 无逃生门 + 活动不刷新——规则 19 反模式四要素）。

### 模块报告索引（15 份）

| 模块 | 范围 | 结果概要 |
|---|---|---|
| rt-infra-a | runtime infra 前半（pi/rpc-client、npm-installer 等 9 文件） | ⚠️ 1（bash RPC 300s）+ tarball 无 stall 反向缺口 |
| rt-infra-b | runtime infra 后半（relay、shell-runner、trash 等 13 文件） | ⚠️ 1（shell-runner 120s 暗默认）+ trash 降级语义 |
| rt-svc-rest | runtime services 其余（quota/worktree/session 等 14 文件） | 0 ❌；附赠 opencode.ts:52 硬编码 URL |
| rt-svc-plugin | runtime plugin-service 13 文件 | ❌ 1（插件工具 30s）+ ⚠️ 3（交互替答族） |
| sc-exec-core | subagent-core 核心执行 7 文件 | ❌ 1（settled-watchdog 标定）+ ⚠️ 2（keep-alive 连坐 / 5min-per-turn 未校准） |
| sc-exec-rest | subagent-core execution 其余 12 文件 | 0 ❌ 0 ⚠️（mergeTimeoutSignal 纯 opt-in 范本） |
| sc-engine-orch | subagent-core 引擎+编排 14 文件 | ❌ 1（zcode 300s，+3 个二阶证据）+ ⚠️ 3（abort 连坐 / HARVEST_GRACE / DRAIN） |
| ext-1 | extensions 三大包（subagent-workflow/base-tool-enhance/permission） | ⚠️ 1（APPROVAL_TIMEOUT 5min fail-closed 可缓） |
| ext-2 | extensions 其余（cw-tool/rename/session-manager/smart-context 等 14 文件） | ⚠️ 3（create 假阴性 / A2 600s 前科 / unified-hooks 文案） |
| elec-a | Electron main 常驻层 | 0 ❌（正面样板；4 处裸 fetch 观察） |
| elec-b | Electron main 更新下载子系统 | ⚠️ 3（1h 总墙钟 ×3 处，同一模式） |
| rend-api | renderer API 层 7 文件 | ❌ 1（streaming 600s 交叉登记）+ ⚠️ 2（compact 300s / 65s 结构性） |
| rend-ui | renderer UI 层 | ⚠️ 1（worktree 60s 可配，降级） |
| core-shared | packages/core + packages/shared 10 文件 | ❌ 1（streaming 10min 值定义）+ ⚠️ 2（bash timer dormant / 配置死口） |
| scripts-tests | 项目脚本 + 测试基建 | 0 ❌（全控制面粒度；3 个工程质量观察） |

## 1. ❌ 违规 4 条（任务执行正常路径固定墙钟，按危害排序）

| # | 位置 | 值 | 危害摘要 |
|---|------|-----|---------|
| 1 | `subagent-core/src/execution/engine/engines/zcode/constants.ts:79` + `session-channel.ts:507-518` | turn 墙钟 **300s** | 起因案件：21% 任务误杀、死后烧 token、错误归类漏分流；二阶证据：①delta 不刷新；②超时后只本地 reject + closeSession（1.5s best-effort），app-server 侧 turn 不 stop；③错误归类 `engine_run_failed` 而非 `engine_timeout`。另：`status='error'` 终态被吞成假成功（`parsedAppServerAttempt` 不查 `terminal.status`） |
| 2 | `core/src/domain/chat/store.ts:69` + `timers.ts:55-60`（挂载点唯一 `effects/registry.ts:308`）+ renderer `stores/chat.ts:30` re-export（执行现场） | streaming UI **10min** | UI 判死活跃流（text_delta/tool_call 均不刷新计时），finalizeSession('timeout') 强推终态后 pi 侧继续烧 token；`XYZ_STREAMING_TIMEOUT_MS` 配置口是死口（store.ts:240-244 TODO 未接线）✅ **已修**（设计 docs/design/timeout-streaming-ui-idle.md）：固定墙钟改 idle 语义——timer 只由活动刷新（默认 1800s、clamp 60–3600s，`DEFAULT_STREAMING_IDLE_TIMEOUT_MS` 单一权威），编排期子代理逐字产出经 `subagent.stream_delta` 桥接刷新父 timer（6a4bb82b3）；timeout 收口打 prematureTimeout 标、迟到 message.complete 自愈恢复真实终态（8ffc560e8）；阈值经 settings 配置链持久化（2966eb2cf）、死口 env 随 idle 语义重构删除（6a4bb82b3——一致性审查 U4 指针修正：死口删除在 u-s1） |
| 3 | `runtime/src/services/plugin-service/bridge-interop.ts:18`（使用 :127） | 插件工具执行 **30s** | pi agent loop 主链路：`plugin.tool.execute` 被 30s 墙钟砍成 isError，无插件/用户指定通道；与 zcode 300s 同构、量级短 10 倍 |
| 4 | `subagent-core/src/execution/settled-watchdog.ts:43`（挂载：session-runner.ts:2454 首轮 + subagent-service.ts:1177 续聊轮） | chatMode 每轮 **10min** | **标定错误实锤**：探针 P-T2c 测的是 agent_end→settled（<2ms 收尾段），窗口却罩 prompt→settled 整轮执行——「4 个数量级余量」建立在错误被测对象上；默认挂载无 opt-out，唯一缓解=改源码常量；unbounded-wait-audit.md:295 自认「>10min 的 chatMode 单轮会被回收」 |

4 条共同形态：**固定墙钟 + 活动不刷新 + 默认生效 + 无逃生门**——AGENTS.md 规则 19 定义的反模式。

## 2. ⚠️ 可疑 16 条（四类归组）

**A.「等人工操作」被短墙钟替答**（→ Doc 3）：
- 插件 UI 弹窗 60s 自动 resolve（`ui-request-queue.ts:19`，confirm 默认 `false` :96；用户没看到即被替答拒绝，串行队列 :63 放行下一个）
- 插件权限审批 30s=拒绝→UNLOADED（`plugin-activator.ts:45`；`permissionTimeoutMs` 覆盖参数 :119 注释标注「测试用」，生产固定 30s）
- permission `APPROVAL_TIMEOUT` 5min deny（`pipeline.ts:232`，fail-closed 可缓——**暂缓，不在本轮**）
- activate 30s / 命令 handler 10s（`plugin-activator.ts:44` / `api/commands-executor.ts:15`，控制面边界——量级裁定入 Doc 3）

**B.「慢速活跃流」墙钟**（→ Doc 4）：
- 更新下载 1h×3（`curl-download.ts:46` + `download-asset.ts:93,416`；30s 停滞检测已存在，总墙钟零增量保护、双引擎互锁 `upgrade-fetch.ts:136-138` non-fallback）
- pi bash RPC 300s（`rpc-client.ts:89` 常量被 compact/bash 共用；`:700` bash() 签名无 timeout 参数；超时后 pi 侧 bash 继续、迟到响应被 timedOutIds+NULL_EVENTS 吞掉**结果永久丢失**）
- compact 300s 双端（renderer `api/domains/chat.ts:15` + runtime `rpc-client.ts:89`；1M-token 压缩可击穿；历史上已被 65s 默认误杀过一次才提到 300s）
- shell-runner 120s 暗默认（`shell-runner.ts:33,57`；生产路径已传用户值，暗默认是坑）

**C. 语义混载/连坐**（暂缓，未入 P0-P3 清单）：
- maxTurns keep-alive 分支到点连坐杀活跃后代不复核（`session-runner.ts:1954-1962`）
- zcode abort 链 3s+3s 连坐共享 app-server（`constants.ts:109,115` + `zcode-engine.ts:608-631`；ABORT_GRACE 部分入 Doc 1 联动）
- HARVEST_GRACE 1s 退订竞态回退到 300s（`zcode-engine.ts:759-771`——**入 Doc 1 联动**）
- session-manager create 60s 假阴性→重复创建（`session-manager/src/index.ts:44-52`）

**D. 无兜底/死口**：
- tarball 下载无 stall 超时（`npm-installer.ts:127` header 到达即清 timer，body/解压零超时——挂死不报错；**入 Doc 5**）
- 4 处裸 fetch（elec-a，liveness 探测漂移 ~300s，观察）
- streaming 配置死口（**入 Doc 2**）——✅ 已修：死口 env 配置口随 idle 语义重构删除，改接 settings 配置链（6a4bb82b3 删除 + 2966eb2cf 接线）
- BASH_TIMEOUT_MS dormant 契约（timers.ts:15 普查时点行号，**入 Doc 2**）——✅ 已修：契约整链删除（常量/bashTimers/arm+clear/finalizeBashOnly/effect-ctx 槽位），纯减法零行为变化，markBashError 收窄（d8427b695）
- pgrep 无 timeout（`kill-tree.ts:137`，观察）
- Worker 版 loadPlugin 超时不回收线程（`plugin-host.ts:108`——**入 Doc 3**）

## 3. ✅ 正面范本（修复时直接抄的参照系）

`mergeTimeoutSignal` 纯 opt-in 全链无默认（sc-exec-rest）· liveness 30s ping×3 连击+成功清零（elec-a）· keep-alive 无进展 30min+后代复核（session-runner）· `stream_warn` 120s 仅提示不杀流（protocol.ts:938）· idle timer busy 永不计时（lifecycle-manager）· bash 前后台默认 null 不限时（base-tool-enhance）· handoff「UI 700=RPC 660=runtime 600+余量」三层对齐（core）· dialog 队列 30min+显式覆盖（subagent-core dialog-queue.ts:45）· llm-shared 无默认透传（ext-2）· reaper「宁延迟勿误杀」（rt-svc-rest）· error-recovery race-F3 重试不重置预算（orchestration）。

## 4. 附赠发现（非超时类）

| # | 位置 | 问题 | 归属 |
|---|------|------|------|
| 1 | `runtime/.../quota-providers/opencode.ts:52` | 🔴 硬编码开发期测试 workspace URL（`wrk_01KM5Q3E...`）——所有用户查同一个 workspace 的额度 | Doc 5 |
| 2 | subagent 派发层 | engine+model registry 不配套：model 校验用 pi registry，执行走 zcode registry——pi id 过校验但 zcode 执行必炸，反之连校验都不过（普查当日实测两种形态各炸一次） | Doc 5 |
| 3 | `runtime/.../npm-installer.ts` | tarball 下载/解压无 stall 兜底（挂死不报错） | Doc 5 |
| 4 | `runtime/.../trash.ts:16-20` | trash 5s 超时降级为 `unlinkSync` **永久删除**（用户预期进废纸篓） | Doc 5 |
| 5 | `runtime/.../plugin-service/plugin-host.ts:108` vs `plugin-host-process.ts:26` | Worker/fork 宿主 loadPlugin 超时后行为不对称（fork terminate 子进程，Worker 只 reject 线程继续活——泄漏面） | **Doc 3**（同文件合并） |

## 5. 修复优先级（P0-P3）

- **P0**（用户可见误杀）：❌1 zcode → ❌2 streaming → ❌4 settled-watchdog → ❌3 插件工具
- **P1**（交互替答）：UI 弹窗/权限审批 → 分钟级以上或可配置（activate/handler 一并裁定）
- **P2**（慢速流）：下载 1h×3 直接删除零损失；bash RPC 拆独立量级；compact 双端同步升
- **P3**（卫生项）：附赠发现 1-5（#5 与 Doc 3 同文件合并）

## 6. 设计文档映射（本文档的下一层）

| 设计文档 | 覆盖任务 | 关键决策主题 |
|---|---|---|
| `docs/design/timeout-zcode-turn-and-settled-watchdog.md` | P0-1 + P0-4 + 二阶联动（超时清理 / status 分流 / HARVEST_GRACE / spawn 模式无 timer） | idle 语义 vs 回收层默认上界；settled 窗口重锚定；T2-③ 被否谱系回写 |
| `docs/design/timeout-streaming-ui-idle.md` | P0-2 + 配置死口 + dormant bash timer | 活动刷新语义；配置口 env vs settings；终态撕裂恢复 |
| `docs/design/timeout-plugin-service-granularity.md` | P0-3 + P1 全部 + 附赠 #5 | 工具执行超时通道设计；人工等待对齐 dialog 30min 先例；控制面秒级 vs 可指定的裁定线 |
| `docs/design/timeout-slow-flow-wallclock.md` | P2 全部 + 65s 结构性守卫 | 删除 vs opt-in 上限；bash RPC 迟到响应处理；compact 三层对齐（含 smart-context SDK 10min） |
| `docs/design/timeout-audit-hygiene-batch.md` | 附赠 #1-4（#5 见 Doc 3） | workspace 配置来源；engine-aware model 校验；stall 检测；trash 降级语义 |

**暂缓项登记**（有登记、无排期）：⚠️C 组的 keep-alive 连坐 / abort 3s+3s 连坐（Doc 1 只联动 HARVEST_GRACE）/ session-manager create 假阴性；⚠️D 组的裸 fetch×4 / pgrep / permission APPROVAL_TIMEOUT 5min / EXTENSION_UI_TIMEOUT_MS 5min（extension-timeout-manager.ts:51，同「等人工」族，量级 5min 可缓）；scripts-tests 三个工程质量观察（35s 硬耦合 / writer 孤儿 / SETTLE_MAX_POLLS 死参数）；WATCHDOG_MS_PER_TURN=5min 经验值重标定；cw-tool opt-out 不可达；smart-context 压缩继承 SDK 10min 墙钟（上游默认）。

## 7. 变更历史

- 2026-09-04：初版落盘（普查总报告 + P0-P3 分组 + 5 份设计文档映射）。
- 2026-09-05：P0-2（§1 ❌2 streaming UI 10min 固定墙钟）与 ⚠️D 组两条「入 Doc 2」条目（streaming 配置死口 / BASH_TIMEOUT_MS dormant 契约）修复完成，对应条目处已加 ✅ 标记 + commit 指针；修复链 = 设计 docs/design/timeout-streaming-ui-idle.md 四 commit——idle 语义 + stream_delta 桥接 6a4bb82b3 / prematureTimeout 打标 + complete 自愈 8ffc560e8 / dormant 契约整链删除 d8427b695 / 阈值配置链 2966eb2cf。已删符号的历史性提及按口径去代码 span（BASH_TIMEOUT_MS）。其余 ❌/⚠️/附赠条目状态不变（修复由各 Doc 1/3/4/5 链自行回写）。
