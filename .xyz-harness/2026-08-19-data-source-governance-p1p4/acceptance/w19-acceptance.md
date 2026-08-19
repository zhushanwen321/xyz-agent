# W19 验收标准：session_end sidecar 登记收口

> **防篡改声明**：本文档与 `docs/architecture/data-source-governance-plan.md` §5 W19 节（L595-616）是 W19 的验收权威。builder 与 verifier 禁止修改两者。冲突时以 plan 为准并上报主 agent。
> **前置依赖**：W2、W11（直写清零后语境成立）。
> **性质：小 wave（核查 + 登记为主，代码零到微量；`git diff --stat` ≤30 行，超出即越界）**。禁止实施 appendEntry 改造（D3 裁决选项 a；选项 b 仅真实需求出现时启动）。

## 目标（一句话）

session_end 维持 sidecar 单写方——读写收口确认 + 登记表按 sidecar 家族（四后缀全集）登记为 xyz 自有合法形态。

## 交付物

1. 全量核查 sidecar 家族读写点：`grep -rn "persistSessionEnd\|persistPresetBinding\|persistProjectBinding\|persistHandedOff\|\.meta\.json\|\.preset\.json\|\.project\.json\|\.handoff\.json" packages/runtime/src --include="*.ts" | grep -v __tests__`——确认读方都经 session-file-utils 函数（check_sidecar_session.py pre-commit 已有守卫）
2. `packages/runtime/src/infra/pi/session-file-utils.ts`（仅当核查发现未收口读写点时收口 + @data-owner 注解；预期零改动或纯注释）
3. 登记表更新草稿（主 agent 落表）：sidecar 家族条目（.meta.json owner=persistSessionEnd / .preset.json=persistPresetBinding / .project.json=persistProjectBinding / .handoff.json=persistHandedOff（W11 迁入后））；R1 四后缀豁免与登记条目一一对应核对

## 通过命令（builder 自验 + verifier 实跑）

1. `python3 .githooks/check_sidecar_session.py` exit 0；`python3 .githooks/check_pi_direct_write.py` exit 0（R1 空 allowlist 态）
2. grep 核查结果全部「已收口」并在汇报列出全量清单
3. 回归：session 终态相关测试全绿（RUNTIME_TEST）；`git diff --stat` ≤30 行

## 禁改清单

- 验收权威文档；一切非核查必需的代码；extensions；六实例；chat 域
- 禁 git 写操作

## 备注

- 完成后 W23 解锁（三依赖齐）。
