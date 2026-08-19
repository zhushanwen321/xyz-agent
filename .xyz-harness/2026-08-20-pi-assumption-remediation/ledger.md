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
| W2 | 值域 SSOT 派生（thinking max/KnownApi/prompt/包名/注释） | pending | — | — |
| W3 | wire 层（tool-call-index + 协议 select 类型） | pending | — | 含降级分支（D3） |
| W4 | extensions isError throw 范式（9 处 5 包）+ goal stale + 6 注释 | pending | — | — |
| W5 | core images 双修 + R1 createWriteStream | pending | — | — |
| W6 | 治本（clone 更新/断言规则/探针/观察项） | pending | — | — |

## 事件

- 2026-08-20 计划启动：用户裁决「全部都要修复」。设计文档 a3a15ef79（fix 全集 = 13 错误 + 8 漂移 + 可低成本对齐风险项 + 治本；out of scope：bash 并发放开 D1 / 已删数据追溯 D2 / F8+compat 登记 D-观察）。首波 W1a + W1b 双 builder 并行派发。
