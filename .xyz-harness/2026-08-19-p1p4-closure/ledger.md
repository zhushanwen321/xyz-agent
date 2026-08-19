# p1p4-closure 状态账本（data-source-governance 收尾）

> 协调机制：cw-orchestrator 三方制衡（同 `../2026-08-19-data-source-governance-p1p4/ledger.md` 模式）。
> 背景：p1p4 主体 20/20 wave + 对抗循环 3 轮已收官；restore-fork-attach-fix（用户完成，W1/W2 committed）已修复 P3 gate FAIL 根因。本计划清零剩余遗留。
> 状态机：pending → building → built → verifying → verified → committed；失败 → rejected（打回原 builder 修复后针对性复审）。
> subagent 一律禁 git 写；每 wave 完成即 commit（主 agent 唯一 commit 出口，精确路径 add）。

## wave 表

| wave | 名称 | 状态 | 验收基线 commit | 备注 |
|------|------|------|----------------|------|
| W1 | renameSession 非活跃分支健壮性（D3 else throw + findings #4 死 cwd 降级） | committed | f24760494 | verifier PASS（报告 acceptance/w1-report.md：0 major/防篡改 4 文件一致 + harness 零改动/等价重构逐行比对成立（共享方法 normalizeInactiveSessionFileIfNeeded，判定函数本体零改动）/两超授权项裁决成立（契约用例翻转 = CP1+CP5 唯一解；existsSync 守卫保 pi 报错分工）/红性 3 注入全红 + sha256 字节还原/独立全量 3185 passed + tsc 0/R1 exit 0/pi 锚点 3 条命中）。builder 裁量：裸 Error 不带 SESSION_NOT_FOUND code（该 code 触发 Panel.vue ghost 删除面板，rename 走 toast）——裁决合理。V-CP5 首跑 3 failed 判环境竞争（与并行 gate 流程 dev 启停时间重叠），复跑连续两次 3185 全绿 |
| W2 | P3 gate 复验改判（场景 3 restore/fork 重开一致性，根因修复后行为级验证） | committed | 26f1f7419 | **PASS 改判成立**（报告 gate/w2-gate-report.md：冒烟断言 A/B 全过——restore 零变换（16 行/md5/mtime 三项不动）→ 暗号轮落原文件 16→21 行/mtime 推进 → kill 后完好 → 第二次重启暗号轮完整在列/用量 50.8K 无回退/无进行中残留；$TMPDIR 零新孤儿；fork 引用 dcf0efe12 G-V3 豁免（W1 零触碰 forkSession）；执行形态变更依据与时间线重叠风险评估见报告 §3。观察 2 项非阻断：thinking 档「最高→高→最高」显示波动（状态感知族，不阻断）；变更集面板投影本仓 W1 diff 属正常）。p1p4 ledger P3 gate 行已改判 PASS + 事件收官条目随本 commit 入库 |
| W3 | attach 护栏报警器 + tmp-migrate 残留清理（审查遗留修复） | committed | 本文件同 commit | 用户裁决「剩余问题都修复，再跑一轮测试」（2026-08-19 23:45）；来源 = 主 agent 对 restore-fork-attach-fix 第三视角审查两项（①I1 护栏静默失效面②崩溃残留无清理）。verifier PASS（报告 acceptance/w3-report.md：0 major/差 7 归属闭合——3ded0d5fc gap review 新增 7 条，3192+6=3198，builder 引用 3185 属过期口径 minor/契约用例真实 pi 4/4 实跑 + 断言强度核对/红性 a/b 定向红 + 还原 cmp 字节一致/R1 exit 0/接线步骤 ⑧ listen 后 try-catch 不阻断启动）。**认知外并发改动上报**：验证期间外部在途修改 pi-provider-store/pi-provider-repair/sanitize 测试/model-switch + untracked chat-app/——首跑 8 红全落外部 sanitize 域且单独跑绿、外部收敛后复跑 3204/3204 全绿（= 3198 + 外部新增 6，闭合）；W3 commit 精确路径避开零触碰（规则 0） |

## 范围裁决（主 agent 2026-08-19 22:35）

- **纳入**：D3 + findings #4（同代码域合并一 wave）；P3 gate 复验改判。
- **不纳入（如实记录）**：①bash_execution_update live 流式消费（findings 相邻 #1「可选增强」——新功能开发非 bug 修复，round 1 已落 resolve 守卫 + no-op，事件不再误 resolve，仅流式渲染未做）；②findings 相邻 #4 断连瞬态清理（已核实随 round 1 B 线闭环：useMessageEffects reason='disconnect' → finalizeAllStreaming + clearAllPending，有测试锚定 useMessageEffects.test.ts:144-147）；③R2-4 runtime 口径重验（已实测 3182 全绿 2026-08-19 22:29，用户 W2 提交后回绿成立）。
- p1p4 ledger 的 P3 gate FAIL 收官改判由 W2 承载，本账本记录后同步回写 p1p4 ledger 事件节。

## 事件

- 2026-08-19 计划启动（用户指示「阅读设计文档，进入开发，subagent 分批分 wave」）：盘点 p1p4 全量遗留（gate 5+3 项发现 × 对抗循环 3 轮处置矩阵 + restore-fork-attach-fix 并行计划交叠）→ 确认仅两项待做。事实核实：runtime 3182 全绿（R2-4 解除）/断连瞬态清理已闭环/`if (target)` 无 else 与死 cwd 无降级坐实（session-lifecycle.ts:385-397 现读）/F2F3 分流形态可复用（:539-554）。W1 验收基线入 git 后派 builder。

## 事件

- 2026-08-19 **计划收官（2/2 wave committed）**：W1 `96f37a754`（verifier PASS 0 major）+ W2 gate 复验（冒烟断言 A/B 全过 + 引用豁免）。p1p4 P3 gate 改判 PASS 并回写 p1p4 ledger（gate 表 + 事件收官条目）。data-source-governance 全链路（P0 止血 → P1-P4 二十 wave → 对抗循环 3 轮 → restore 根因修复 → gate 复验）闭环。仍开放移交后续：bash_execution_update live 流式渲染（可选增强未立项）、thinking 档显示波动（W2 观察）。
- 2026-08-19 **W3 追加（审查遗留修复轮）**：主 agent 对 restore-fork-attach-fix 第三视角审查（用户裁决全修复）→ W3 一轮过（builder → verifier PASS 0 major）→ committed。修复两项：I1 护栏契约报警器（真实 pi 用例锁定 get_state().sessionFile 非空 string + resolve 归一绑定语义，pi 升级改字段形态时契约层先红）+ tmp-migrate 残留清理（startup-background-init 步骤 ⑧，1h 阈值两层枚举，新鲜残留不删防并发误删）。全量回归轮见下一事件。
- 2026-08-20 **W3 回归轮（用户指令「再跑一轮测试」）**：runtime 全量 3204/3204 全绿（含 W3 新增 6 + 认知外 3af2baa71 域新增测试）+ tsc exit 0 + R1 exit 0。工作区剩余改动均为认知外在途（pi-provider-store/repair、sanitize 测试、model-switch、chat-app/），零触碰。W3 commit 首次遇 pre-commit hook 瞬时 EOF（同 W12/W18 已知模式），重试全套通过。
