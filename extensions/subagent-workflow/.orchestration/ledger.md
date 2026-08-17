# Workflow 一次性生命周期实施 — Ledger

> 开发期协调脚手架（cw-orchestrator 机制：验收基线入 git → builder 开发 → verifier 对抗验收 → 主 agent 核对流转 commit）。权威规格：`docs/design/workflow-one-shot-lifecycle-impl-spec.md`。

## Unit 状态表

| unit | 模块 | 状态 | 验收基线 commit | 备注 |
|---|---|---|---|---|
| U1 行为删除 | orchestration + index + interface | committed | 2cff4d3f8（R6 后基线） | verifier PASS（.orchestration/acceptance/u1-report.md） |
| U2 类型与持久化收窄 | models + jsonl-run-store + gui 视图 | committed | ce9302111 | verifier PASS（.orchestration/acceptance/u2-report.md）；builder 两项裁决（abortRun 死分支删除不可达论证 / v1 fixture 用 running）均复核成立 |
| U3 文档回写 | README + CHANGELOG | committed | 963fddae8 | verifier PASS（.orchestration/acceptance/u3-report.md）；R8 扩权（SKILL.md 宣传修正 + 8 处注释）+ ports.ts:132 保留裁决复核成立 |
| obs-fixes 观察项根除 | execution/orchestration | committed | d2853b11b | verifier PASS（.orchestration/acceptance/obs-fixes-report.md）；S7 残留瞬时污染守卫（executeAgentCall 尾参 isOrphaned 实例比对前移至 trace.update 前）+ rebuildRuntime L1-L4 debug 日志；U6 红性验证闭环 |
| slice5 conformance 复核 | 全包（只读验收） | closed（复核 PASS） | —（实施 093e28fe3/459202f25/dcee2c9b6/f4f4f9f9f，2026-08-16 05:16-06:23 用户侧交付） | verifier PASS（.orchestration/acceptance/slice5-conformance-report.md）：14/14 接口项符合（3 PASS-with-note）、勿动清单 9/9 零触碰、对抗抽查 3/3（worker 快照独立重算 byte-identical / IF13 fuzz 200 例 / IF2 并行保序 30 轮） |

## Milestone Gate

| gate | 状态 | 报告 |
|---|---|---|
| one-shot 全场景（S1-S8 真实 pi 环境） | **PASS（复判）** | .orchestration/acceptance/gate-report.md（首轮 14/15 + S7 修复复审附录） |

## 观察项（不阻塞，流转时如实记录）

- ~~存量测试失败 4 用例（skill-discovery ×2 / spawn-worktree-guidance ×2）~~ **已关闭**：用户侧 commit b843a5f49（2026-08-17 00:32）修复（mock 补 stdin 字段 / getAgentDir 直 mock），包全量 2187 绿复核成立（本 automation run exit 0 复证）
- U1 verifier 环境注记 3 条（U3 已处置）：①手册 S7 注入脚本 @pi-meta 头已补（U3）；②~~rebuild 路径无 deps.log 调用~~ **已关闭**（obs-fixes 补 L1-L4 日志）；③pi rpc-mode 无补全探测入口，补全断言以源码 diff 为证（U3 已注记）
- ~~S7 修复已知残留：executeAgentCall 内部 finalizeCall 的 trace.update 对重跑新节点瞬时污染~~ **已关闭**（obs-fixes：isOrphaned 谓词守卫，U6 红性验证锚定）
- 用户侧 pi-scheduler 扩展崩溃排查：**已修复（2026-08-17 crash-fix 交付，extensions/scheduler/.orchestration/ledger.md）**。根因：dispatchTask 的 `await sendMessage` 窗口与 new_session 替换交错 → 旧 session 的 30s tick timer 存活到下一 tick → `refreshWidget` 访问 stale ctx（`ctx.ui` getter 抛）→ `void tickScheduler()` fire-and-forget 无 catch → unhandledRejection → pi exit 1。修复 F1+F2 双层（session_start 停旧 runtime + tick catch 分诊自停）；E2E 终裁：同场景交错后 75s+ 存活零 stale。**全局安装版 0.3.0 待 npm 发版更新（归用户决策）**

## 事件流水（时间倒序追加，永不覆盖）

- 2026-08-17 用户追加指令三件：pi-scheduler 全面排查（读引用 session 日志 + 本仓源码）→ 复现成功 exit 1（dispatch await 窗口 × new_session 交错，29.5s 对齐旧 timer 边界；idle 对照不崩），根因双层（timer 泄漏 + tick 无防护），方案已给待决策；feature 层 retrospect + closeout 写入 .cw/swf-perf-impl/（gitignore 惯例不提交）；PR 不开。
- 2026-08-17 02:17 automation run（定时任务 automation-a9c769d0）执行 handoff 两任务：
  - **交接文档纠错**：handoff 称「slice5 wave1 零起点、wave2 未开始」——实际 wave1（093e28fe3 + 459202f25）与 wave2（dcee2c9b6 + f4f4f9f9f）已于 2026-08-16 05:16-06:23 完整交付（含 exec-review followups），主 agent git 考古 + 全符号现状核查证实。任务 B 转为独立符合性复核：verifier PASS（14/14 接口项 + 勿动清单 9/9 零触碰 + 对抗抽查 3/3，报告 slice5-conformance-report.md）。slice5 就此闭环；feature 层 retrospect/closeout 归用户决策未自发执行。
  - **obs-fixes unit 交付**：任务 A 项 2/3（S7 残留根除 + rebuild 可观察性）。基线 d2853b11b → builder 4 文件（+9 测试，2196 全绿）→ verifier PASS（U6 红性：谓词改 () => false → 'failed' ≠ 'running' 精确红；差异点 a-d 全裁决接受）→ 主 agent 核对（diff 基线为空 + sha256 一致 + 无越界）→ 流转。
  - 认知外改动处置：handoff §1 的 2 文件（model-resolver.ts / tool-render.ts）经查已由用户侧 commit 1fb48731b（00:25:02）正式提交，工作区 clean，无待确认事项。
  - 任务 A 项 4（pi-scheduler 排查）跳过：需用户确认是否仍复现，automation 场景无法求证（见观察项节）。
- 2026-08-16 gate FAIL→复判 PASS：首轮 15 项 14 过，S7-second 暴露概率性竞态（rebuild 后旧 dispatch 的迟到 completion 经 postAgentResult 投给新 worker 同 callId pending，劫持重跑 → 假 completed b=""）——F2 定稿时「orphan 无外部副作用」断言与实测相反，被 gate 抓出。修复：isOrphanedCall 实例比对守卫（.then/.catch 双路，跳过投递/持久化/预算检查）+ 4 回归用例 + 错误注释修正。针对性复审 PASS：红性验证（守卫恒 false → 3 用例红）、真实复跑铁证（debug 日志 orphan drop 落在重跑 finalize 前 18ms = 竞态窗口重演且被拦截，非幸运通过）；builder 4 次复跑 + 复审 1 次全过 b=beta + PHASE_A 恰 1 份。commit 8353f6b60。
- 2026-08-16 环境事件（非被测物责任）：用户全局 pi-scheduler 扩展在 session 替换后 stale ctx 崩掉 pi 主进程两次（中断 gate C3 首轮，重启重跑成功）——已向用户披露，建议反馈该扩展。

- 2026-08-16 U3 verified→committed：builder 首轮 3 文件（README/CHANGELOG/手册修订）+ R8 扩权 8 文件（SKILL.md:244 pause/resume 能力宣传改写为一次性语义——G3 违例修正 + 注释 8 处）；verifier PASS（288 处 grep 命中独立归类无现役能力残留；「previously auto-paused」经 pre-U1 代码抽验非杜撰）。minor：README reason 列举补 time_limited（verifier 观察①，主 agent 流转时修）；ports.ts:132 历史转述保留裁决复核成立。commit cdaea8a54。
- 2026-08-16 外部事件：认知外改动确认为用户并行开发 displayAgentName 功能并自行 commit（7c4061e0a，9 文件）——U2 流转已用精确 add 排除，无污染；protocol §5.4 git 纪律由此固化进 cw-orchestrator skill（useful-dev-tools 683c1bc）。
- 2026-08-16 U2 verified→committed：verifier PASS（基线 ce9302111 防篡改、U1 领地 5 文件零触碰、契约 7 条全过、两项 builder 裁决复核成立、真实 pi E2E S3/S5/S6/S8b 全过——S5 父子预算 24371.16==24371.16 铁证）。R7 勘误：v1 跳过 fixture status=running（S8b 双零 grep 断言优先，语义等价）。commit 931e219a0（精确 add 排除当时在场的 8 个认知外文件）。
- 2026-08-16 U1 R6 裁决：builder 上报 3 冲突（command-actions.test.ts / robustness-low-batch1.test.ts 规格遗漏、S8a grep 全域不可达）→ 测试清单扩 2 文件、S8a 改领地内断言、全域零命中挪 S8b；基线 2cff4d3f8。存量失败 4 用例待 verifier 核验归因。
- 2026-08-16 U1 builder 首轮交付：14 文件（7 源 + 7 测试），typecheck 0 / lint 0 error / 目标测试 76 绿；3 冲突停手上报（正确行为）。打回修复 C1/C2 后 16 文件全绿（2171/2175，4 豁免存量）。
- 2026-08-16 设计定稿：R3-R5 对抗审查收敛（R5: 0 must-fix），子文档 impl-spec 交付（commit 9ccfd44e1）。U1 acceptance 基线 commit 313005e1c。
