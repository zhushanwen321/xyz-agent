# subagent-core-convergence.md 审查循环记录

> tech-design 对抗式审查（tech-design-review agent，同 agent 连续两轮）。被审文档：[subagent-core-convergence.md](subagent-core-convergence.md)。日期：2026-08-30。

## 循环轨迹

| 轮次 | must-fix | suggestion | doc_error | 判定 |
|---|---|---|---|---|
| R1 初审 | 4 | 4 | 1 | 全部成立 |
| R2 复审 | 0 | 3（新，R1 修订同步残留） | 1（新） | 4 MF 修复全部成立；3S+1DE 当轮修完 |
| 终态 | 0 | 0 | 0 | 设计就绪 |

## R1 findings 与修复

| # | 位置 | 问题 | 修复 |
|---|---|---|---|
| MF-1 | §3.2 D-3 | ModelEntry 并集漏 `provider` 字段——本仓 `model-list-injector.ts:44` provider 必填且 L88-92 排序 / L98 id 拼接两处硬消费，照抄上游口径（上游四轮审查亦未击穿）会破坏 A2 逐字节等价 | 并集补 `provider?`（pi 投影必填、zsw 缺席降级裸 id + id 码点序）；id/name 声明为条目最小必填；标注「本仓补充（上游 D-3 增强）」 |
| MF-2 | §5.1 W5 | 职责表漏两项：core 包 agents/ 进 pi 发现面接线（上游 W5⑥）、injector 深路径 import 改 barrel（§2.4 图已画终态但无人实现；§4.2 测试门却要求测） | W5 职责改显式七项编号（⑥接线+降级 ⑦统一 barrel）；领地补 README.md |
| MF-3 | §4.3 | 完成定义只含 committed + bundle + vitest 绿，把单测门事实上抬升为最终验收，A2/A9 可能从未执行 | 补第 3 条：§4.1 三场景全部通过且证据落盘，「单测绿不是最终验收」明示 |
| MF-4 | §4.1 A2 | `npm pack` 将 `workspace:*` 替换为现版本 0.2.0，`^0.2.0` 被已装 0.2.0 满足，验证不了 ≥0.4.0 依赖下限 | 临时副本 bump core 0.4.0 + pi-sw 依赖 `^0.4.0` 模拟发布面 manifest 再 pack |
| S-1 | §2/§5.3 | 基线后提交数 22 实测 26 | 改动态表述 + 复核命令写明 |
| S-2 | §5.1 | W1 挂钩 A2/A9 但其只能在 W5 后执行；W1-W5 间角色空窗未声明 | 挂钩标时机 + 新增「过渡态声明」段 |
| S-3 | §5.5 | 三处顺手修复文件不在对应单元领地；guide 文案落点在 W5 领地却归 W3 | 并入领地（W1 +core workflows/README.md；W5 +pi-sw README.md）；guide 改「W3 参数化 + W5 落文案」 |
| S-4 | §4.1 A2 | 快照基线何时取未写 | 补步骤①：W5 动工前落改造前基线快照 |
| DE-1 | §3.2 D-2① | 「agent-registry 不存在」措辞不精确（文件存在，不存在的是消费关系） | 改「agent-registry 只 import getCachedFile，不消费 sync 扫描」 |

## R2 findings 与修复（均为 R1 修订的同步残留）

| # | 位置 | 问题 | 修复 |
|---|---|---|---|
| S-1 | §3.3 红线 5 | 「全字段 optional」与 D-3 修订后「id/name 最小必填」打架 | 红线 5 改「除 id/name 外全字段 optional」+ provider 空串入守卫边界 |
| S-2 | §4.2 W3/W5 | W3 测试门未覆盖 provider? 两形态用例；W5 测试门无⑦验证项（vitest 绿无法区分深路径与 barrel） | W3 补 provider 存在/缺席两组用例；W5 补 grep 断言（无 `subagent-core/shared/` 深路径 import） |
| S-3 | §4.1 A2 | 临时副本取材基准未写（最小化副本产出残包）；同批安装的必要性未明示（单装 pi-sw tarball 必 404） | 补「全目录 copy 自已完成 §4.3-1 构建的包目录」+「同批安装是刻意设计非绕过」 |
| DE-1 | §4.1 A2 | 通过标准写「`^0.2.0` 不满足」——实测 8.7.0 依赖是精确 `0.2.0`（发布时 workspace 协议替换为精确版本，无 `^`） | 改「已装精确版本 `0.2.0` 不满足 `^0.4.0` 下限」 |

## R2 关键推演结论（留档）

- MF-1 降级语义闭合：zsw 投影 id 为全名形态（如 `builtin:bigmodel-coding-plan/GLM-5.3`）且 provider 缺席，裸 id 渲染即其现渲染形态，无 `provider/provider/id` 重复拼接；排序退化为 id 码点序对 zsw 是改造目标语义而非回归。
- MF-4 路径可执行性：registry 实测 core latest 仅 0.2.0，`^0.4.0` 下限只能由本地 tarball 满足，「先装 8.7.0 → 同批装两 tarball → 0.2.0 被强制替换为本地 0.4.0」可判定。

## 未修项

无（两轮全部 findings 均已当轮修复）。
