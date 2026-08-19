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
| W1a | model-switch setModel 真切 | pending | — | critical：切换从未生效 |
| W1b | provider-repair 八字段对齐 | pending | — | major：sanitize 删合法配置（数据丢失） |
| W2 | 值域 SSOT 派生（thinking max/KnownApi/prompt/包名/注释） | pending | — | — |
| W3 | wire 层（tool-call-index + 协议 select 类型） | pending | — | 含降级分支（D3） |
| W4 | extensions isError throw 范式（9 处 5 包）+ goal stale + 6 注释 | pending | — | — |
| W5 | core images 双修 + R1 createWriteStream | pending | — | — |
| W6 | 治本（clone 更新/断言规则/探针/观察项） | pending | — | — |

## 事件

- 2026-08-20 计划启动：用户裁决「全部都要修复」。设计文档 a3a15ef79（fix 全集 = 13 错误 + 8 漂移 + 可低成本对齐风险项 + 治本；out of scope：bash 并发放开 D1 / 已删数据追溯 D2 / F8+compat 登记 D-观察）。首波 W1a + W1b 双 builder 并行派发。
