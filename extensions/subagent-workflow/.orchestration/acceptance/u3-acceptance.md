# U3 验收标准 — 文档回写（README / CHANGELOG / 手册修订）

> **builder 与 verifier 禁止修改本文件。** 前置：U1（889a798f9）、U2（931e219a0）已 committed。U3 是纯文档单元：对齐代码终态、防漂移。
>
> status: pending

## 目标

面向用户的文档（README/CHANGELOG）与代码终态一致；实施规格手册按 U1/U2 verifier 实测反馈修订（S7 脚本 @pi-meta 头、断言口径）；源码注释残余 grep 清零复跑。

## 交付物

| 文件 | 改动 |
|---|---|
| `extensions/subagent-workflow/README.md` | pause/resume 能力描述删除；补一次性语义句（与 tool description 一致：`Runs are one-shot: there is no pause/resume — to stop a run early use abort; for a fresh result start a new run.`）；若提及快照版本/状态机处同步两态 |
| `extensions/subagent-workflow/CHANGELOG.md` | 新版本条目（版本号沿用包当前未发布版本策略，不新增 version 行则记入 Unreleased 或最新 dev 版本节——builder 按文件现状惯例判断），breaking 4 项：① workflow tool action enum 收窄 run/status/abort（pause/resume 调用得 `Validation failed for tool "workflow"`）；② /workflows verb 收窄（pause/resume → removed 提示文案）；③ session 切换/关闭时 running run 从「自动挂起可 resume」变更为「作废转 done,failed（token 投入作废）」；④ 快照格式 wf-run-v1→v2（旧 v1 文件静默跳过）。另附行为注记：worker 崩溃重试 + replay 保留 |
| `extensions/subagent-workflow/docs/design/workflow-one-shot-lifecycle-impl-spec.md` §3 手册 | ① S7 注入脚本补 `@pi-meta` 头（phases 必填——U1 verifier 实测：裸脚本 registry 标 available=false 以空脚本秒完成；给出带 meta 的最终脚本全文）；② S7 断言「扩展日志含 rebuild 1 次」改为行为证据口径（rebuild 路径无 deps.log 调用，以 workerErrorCount/子进程 session 文件数/scriptResult 判定——U1 verifier 注记 ②）；③ S4③ 补全断言补注记（pi rpc-mode 无补全探测入口，以源码 diff 为证——注记 ③） |

## 不改动（领地外）

- 全部 `src/` 文件（U1/U2 已验收；**工作区另有 8 个认知外改动文件，一律不碰**）
- `.orchestration/acceptance/u1/u2-acceptance.md`（历史验收记录；u2 的 fixture 描述勘误由主 agent 处理）
- `.review/` 报告

## 通过标准

1. README 无 pause/resume 现役能力描述（`grep -n -i "pause\|resume" README.md` 命中处均为历史/移除说明语境，逐处可解释）
2. CHANGELOG 含 4 项 breaking（人工核对内容与 U1/U2 commit 语义一致）
3. 子文档手册 3 处修订落地（S7 脚本含 `@pi-meta` 且 phases 声明；断言口径为行为证据）
4. `cd extensions/subagent-workflow && grep -rn -i "pause\|resume" src/` 复跑：命中均为 REMOVED_LIFECYCLE_VERBS 定制提示的必要字面量、lifecycle-removed 类型定义、注释中的历史说明——逐处列出并归类（本单元**不修** src/，只审计归类；发现现役能力描述残留 = 上报，不擅改）
5. `pnpm extensions:typecheck && pnpm extensions:lint` 复跑 exit 0（文档改动不应影响，回归性检查）
