# restore-fork-attach-fix 状态账本

> 协调机制：cw-orchestrator 三方制衡（同 `../2026-08-19-data-source-governance-p1p4/ledger.md` 模式）。
> 设计 SSOT = `docs/architecture/restore-fork-attach-fix.md`（commit d6ab28d75，对抗式审查 4 must-fix 已修复）。
> 状态机：pending → building → built → verifying → verified → committed；失败 → rejected（打回原 builder 修复后针对性复审）。
> subagent 一律禁 git 写；每 wave 完成即 commit（主 agent 唯一 commit 出口，精确路径 add）。

## 依赖图

- W1（附着路径修复，含 R1 豁免——归一化 writeFileSync 会触发 R1，豁免必须随代码同 wave 否则无法 commit）→ W2（护栏收尾：attach 断言 + 生命周期等价测试 + ADR-0062 §2 修订 + ADR-0063 + 登记表 I5 + checklist）
- 串行：无并行 wave（W2 的 attach 断言在 tmp 附着形态下会立即失败，依赖 W1 先行）

## wave 表

| wave | 名称 | 状态 | 验收基线 commit | 备注 |
|------|------|------|----------------|------|
| W1 | 附着路径修复（F1+F2+F3 + R1 豁免） | committed | 8e1591cde | verifier PASS（报告 acceptance/w1-report.md：防篡改 sha256 一致/越界 35 条零越界（22 条认知外豁免）/3178 全绿/红性 5 红（C2-C6）字节还原四重证明/真实性 6 项）。**F1 major（对抗新发现）**：「崩溃残留 scanner 天然忽略」声明证伪（scanner 按内容识别，残留同 id 双条目 + findScannedSession 命中错位）→ 打回 builder 修复：`isScannableSessionFile` 过滤收口 `scanPiSessionsFromDisk` 两处枚举（session-scanner.ts 核实无需改）+ 双侧断言测试 + docstring/登记表声明修正 → 针对性复审 PASS 维持（红性独立复验/全域无第三枚举点/误伤面零/TTL 缓存不可绕过；R2 minor = 设计文档第三处同源声明，主 agent 已修正）。R1 豁免 B③ 与 B① 同构（F2 裁决不动） |
| W2 | 护栏收尾（F4：断言/等价测试/ADR/登记表/checklist） | committed | b5cc9f764 | verifier PASS（报告 acceptance/w2-report.md：0 major 3 minor/防篡改 sha256 一致/越界 10 条目全在清单+授权内/3182 全绿含真实 pi 等价 3 用例（restore 9.1s / fork 7.8s / C2 1.0s）/红性双注入（helper no-op → C2 红；读错文件 → restore 红）字节还原/pi 锚点超额抽查 9 条全吻合/ADR-0062 五项边界 ≡ 登记表 ⑨ ≡ 代码三方一致）。**跳过分支专项评估**：分支 3（pi 路径不存在跳过）判 minor——真实环境永不该触发（附着即写文件三重证据），最自然回归形态下接线先于 unlink 执行仍被 mismatch 拦截，收紧留后续。builder 修复循环 1 轮：5 mock 失败（getState 固定假路径恰构成 I1 分裂被正确 throw）→ 主 agent 裁决授权修 mock 语义（跟随 switchSession 实参）+ 追认 session-attach-assert.ts 独立模块（import 链污染 services 模块面）→ 3182 全绿。minor 处置：F1 留观察（跳过分支收紧/升级可观测）、F2 cpSync import 主 agent 删除、F3 ADR-0063 I3 覆盖边界如实声明（等价测试不走生产全管线，运行时守卫 = I1 断言 dev 期 throw） |

## 事件

- 2026-08-19 计划启动：设计文档定稿并 committed（d6ab28d75，含用户质疑触发的逐动机 pi 侧查证 + tech-design-review 对抗式审查 4 must-fix 修复记录，见设计文档附录）。裁决记录：F5 孤儿抢救不做（用户）；F3 方案 A rename-over 定案（用户「直接删掉」直觉 + 查证修正）。W1 验收基线入 git 后派 builder。
- 2026-08-19 **W1 一轮交付 + 修复循环收官**：builder 交付（tmp 管线删除 + 分流 + 归一化 + R1 豁免 B③）→ verifier PASS 含红性验证（回退 tmp 管线 5 红）→ F1 major（「scanner 天然忽略」声明证伪：按内容识别致同 id 双条目错位附着）打回 → builder 修复 isScannableSessionFile 收口两枚举点 → 针对性复审 PASS 维持 → committed 668273adb。R2 minor（设计文档第三处同源声明）主 agent 修正。
- 2026-08-19 **W2 交付 + 修复循环收官**：builder 交付护栏五件套（session-attach-assert.ts helper + 三接线 + attach-lifecycle.test.ts 真实 pi 等价 3 用例 + ADR-0062 §2 第三类 + ADR-0063 I1-I5 + 登记表 ⑩ + checklist 步骤 9/10）→ 首验 5 mock 失败裁决授权修（mock getState 跟随 switchSession 实参 = 真实 pi 行为；护栏对假分裂 throw 是正确行为）→ verifier PASS（0 major 3 minor，跳过分支专项评估不架空）。builder 固化协议事实两条入档：pi get_state.sessionFile 不展开 symlink（双侧 resolve 足够）；附着瞬间 pi 即写目标文件。观察项：helper 跳过分支 3 收紧（verifier W2 F1，真实环境不可达，低优先）。

## 里程碑 gate

| gate | 内容 | 状态 |
|------|------|------|
| final gate | 场景 G-V1/G-V2a/G-V2b/G-V3 + G-X（真实 dev app + 真实 pi，8 次精确启停，无 mock） | **PASS 4/4 + G-X**（报告 gate/final-gate-report.md：G-V1 前次丢失点反转——restore 后对话落登记文件 7→16 行 mtime 推进、二次重启暗号轮完整、用量单调无回退；G-V2a session_end 9→0 归一化 + AI 复述「香蕉37」（树索引防线生效）+ 幂等三项字节级全同；G-V2b cwd 死路径归一化 homedir 未阻塞 + AI 复述「芒果88」；G-V3 fork 暗号轮落 fork 文件 + 血缘指针完整 + 源文件字节不变；G-X 9 次附着零断言误伤 + $TMPDIR 零新孤儿。附注：fixture 保真度教训（assistant message 需带 usage 字段，pi getState 无守卫）；gate 尾段并行会话空降 session-lifecycle renameSession 重构（认知外未触碰，主流程在干净 HEAD ec38e546f 执行）） |

- 2026-08-19 **final gate PASS，计划收官（2/2 wave + gate 全绿）**。目标终态达成：restore 与 fork 后的每一轮对话都落进 sessions 目录内被登记的那个文件，重启零丢失；护栏（attach 断言 + 生命周期等价测试 + ADR-0062/0063 + 登记表 + checklist）全部就位。修复 commits：668273adb（W1）+ ec38e546f（W2）+ gate 报告本 commit。
- 2026-08-19 深夜 **实施后差距复审（reviewer 对抗审查，报告 review/design-impl-gap-review.md）**：结论 = 核心修复与护栏实现一致、验收证据链等强度、无越界实现；**1 must-fix + 6 suggestion**。must-fix（ADR-0063 I1 未如实记录跳过分支 ③）+ 5 条文档回写（设计 §3.4 I1/D3 跳过分支语义、§5 W2 行 R1 豁免/helper 落点偏差、§4 V4 覆盖边界、附录实施期裁决、attach-lifecycle 头注释、ADR-0063 与登记表 ⑩ helper 路径）随复审 commit（4a8936e26）落地；reviewer 独立实跑 R1 exit 0 + pi 锚点抽查 8 条吻合。
- 2026-08-19 深夜 **suggestion 6 实施（用户指示「must fix 和 suggestion 都实施」，观察项 ② 关闭）**：`.tmp-migrate-` 残留清理三机制——① `normalizeSessionFileInPlace` rename 失败回滚删除（原文件未触碰可重试）；② `cleanupMigrateResidues` 附着前清扫（`normalizeInactiveSessionFileIfNeeded` 顶部，restore F2/F3 + renameSession 非活跃分支共用，renameSession 同沾）；③ delete 链与 sidecar 四后缀同点清扫（两分支）。测试：`test/session-file-utils-migrate-cleanup.test.ts` 4 用例（rollback 真实触发 = rename 目标做成非空目录 + 清扫只删「basename 前缀精确 + .jsonl 后缀」不误删他人残留）+ attach 测试 S6 describe 3 用例（F2 前清扫 / F3 前清扫 / delete 链清扫）。设计 §3.3/附录、登记表 ⑨（双保险表述）同步。观察项 ①（跳过分支 ③ 收紧）维持 deferred——W2 verifier 既有裁决（mock 生态成本），非 reviewer 条目。
