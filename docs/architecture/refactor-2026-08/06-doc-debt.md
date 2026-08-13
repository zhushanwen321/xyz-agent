# 文档债收口（§6）

> 本文件是 [README.md](README.md)（36 候选总纲）的文档债子文档，覆盖审查报告 §6 章节的 5 份文档。五段骨架：背景目标 → 现状与问题分析 → 解决方案 → 验收 → 下一层拆分。
>
> **事实修正说明**：数字均经二次核实（services 实际 132 文件/24,923 行；migration-progress:209「FULLY CLEAN」原文；COPY_MAP 在 git 跟踪源码零定义、14 处文档/.cw 提及——原「全仓零命中」措辞过宽）。

## §1 背景与目标

**SCQA**：架构审查发现「文档滞后于代码」是跨层共性问题——module-map 快照过期 3 倍、migration-progress 声称「FULLY CLEAN」已失守（D1 的 9 处漂移无守护）、v6 速查表 2/6 路径失效、五包图画成链但实为 DAG。AI 可导航性直接受损：**后续侦查反复踩 drift 坑，每次都要人工核实文档声明与代码事实**。

**本层目标**：5 份声明类文档统一改为「**历史快照 + 当前状态指向可执行检查输出**」两段式——声明与事实的核对从人工变脚本，文档债随波次收口。

**收口原则**（与 D1 合并推进）：声明类文档的价值是记录**决策**（为什么这样设计），不是记录**现状**（现状由代码和检查输出说话）。因此：历史部分保留并标注快照时点，现状部分删除手写断言，改为「运行 `<检查脚本>` 验证」的指令。

## §2 现状与问题分析（5 份文档）

| # | 文档 | 声明（现状） | 事实（实测） | 损害 |
|---|------|-------------|-------------|------|
| 1 | `runtime-module-map.md`（142 行） | services **48 文件/8165 行**；「**零 infra 直连**（R5/R7 达成）」；快照时点「R9 后」 | services 实际 **132 文件/24,923 行**（膨胀 3 倍）；D1 的 9 处漂移回潮（含 services→infra 6 处） | 导航价值已崩——按图找模块会踩空或找到过时规模；「零直连」声明给回潮打掩护 |
| 2 | `runtime-migration-progress.md`（248 行） | :209「services/ → infra 直接 import → **✓ FULLY CLEAN**（零依赖，无任何例外）」 | D1 的 9 处漂移存在且无守护——「CLEAN」是手写断言，不是检查结果 | 漂移无人察觉的根源：文档声称干净，代码早已回潮，且无机制在两者间产生矛盾信号 |
| 3 | `v6-architecture-refactor.md`（506 行） | B1-B9 欠债清单（现状审查时的待办） | 大多已落地（chat.ts 906→31 行、routeInbound 已迁 core 查表式、Sidebar 467→270、features 已按 14 域分组） | 文档停留在「欠债」状态，无落地标注——后续侦查反复把已落地项当未落地重新排查 |
| 4 | `renderer-target-architecture.md`（797 行）§2.2 速查表 | 6 文件归属表（GuiComponentRenderer→components、extensions/registry→…） | **2/6 路径失效**：GuiComponentRenderer 已迁 ui 包、extensions/registry 已升格 core/extension-host | 归位判定表不可信——新代码按表放位置会放错层 |
| 5 | `renderer-target-architecture.md` §2.0 五包图 + §2.3 sync 纪律 | 线性链（renderer 只经 ui 消费）；「sync 兼容纪律」描述 COPY_MAP 机制 | 实为 **DAG**（renderer 直连 core 96 文件、直连 shared 237 文件）；缺 extension-protocol 叶子（0.8k 行零依赖，被五方依赖）；**sync 脚本不存在**；COPY_MAP 在 git 跟踪源码**零定义**（仅 14 处文档/.cw 提及） | 分层图与事实不符——新成员按图理解依赖关系会误判「越层即违规」；纪律描述的机制不存在，读者无从执行 |

**共性根因**：5 份文档都是「一次性审查的产物被当作长期现状文档使用」。审查产出的是**时点快照**（审查那一刻的事实），但文档没有快照标注、没有指向可执行验证——时间一过，声明与事实必然漂移。

## §3 解决方案

### 统一修法（5 份文档一致）

1. **历史段**：文件头部加「**截至 <审查日期> 历史快照**」标注（含快照时点、当时的数据/图/清单），正文声明保留原样（它们是决策记录，不是现状声明）
2. **当前状态段**：新增「当前状态」章节，内容 = 可执行检查指令（脚本名 + 期望输出），删除手写现状断言（如「FULLY CLEAN」「零 infra 直连」「48 文件」的现状语气）
3. **与 D1 合并推进**：migration-progress/module-map 的当前状态指向 D1 新增的 `.githooks/check_layer_boundaries.py --report`（输出当前违规清单，空 = 边界干净）；renderer 侧文档指向既有可执行检查（`check_renderer_deps.py` / 包级 import 扫描脚本——若无现成脚本，在对应波次补最小检查，见下）
4. **数字改为生成式**：module-map 的「48 文件/8165 行」类规模数字改标注「以 `find services -name '*.ts' | wc -l` 实测为准」，不手写

### 每份文档的具体修法

| # | 文档 | 具体修法 | 当前状态指向 | 落地波次 |
|---|------|---------|-------------|---------|
| 1 | runtime-module-map.md | 头部标快照（R9 后审查时点）；架构图/规模数字标「历史快照」；「零 infra 直连」声明改为指向检查输出 | `bash .githooks/check_layer_boundaries.py --report`（空 = 干净） | W1（随 D1） |
| 2 | runtime-migration-progress.md | :209「FULLY CLEAN」改为「截至 <日期> 快照：迁移完结；当前状态以检查输出为准」 | 同上 + `rg "Pi[A-Z]" services/ transport/`（R5 验收） | W1（随 D1） |
| 3 | v6-architecture-refactor.md | 逐项标注落地状态（已落地 ✓ / 未落地 ×，依据当前代码核实）；文档头标「现状审查快照」 | 新增「落地核对」节：每项标注核实日期与证据（commit/行数） | W0 后（B/C 项多已落地）随行 |
| 4 | renderer-target-architecture.md §2.2 | 速查表按当前事实重写 6 条归属（GuiComponentRenderer→ui 包、extensions/registry→core/extension-host 等），表头加「截至 <日期>，变动以代码为准」 | 归属类条目标注核实方式（`rg` 定位定义文件） | W2 前（C2 等归位改动后最终核对） |
| 5 | renderer-target-architecture.md §2.0/§2.3 | 五包图改画 DAG + 补 extension-protocol 叶子（对齐审查报告实测依赖图）；删除不存在的 sync 纪律描述（同步机制未实现则注明「设计意图，未落地」）；COPY_MAP 提及标注「代码零定义，概念存疑」 | 图附「实测依赖数据来自 <审查报告链接>，重跑方法：包级 import 扫描」 | W1（文档优先，不依赖代码改动） |

**方案对比**：

| 方案 | 性质 | 取舍 |
|------|------|------|
| **历史快照 + 可执行检查输出（推荐）** | 长期方案 | 文档只承担「决策记录」职责，现状永远从脚本读——声明与事实的矛盾信号自动出现（检查失败即矛盾），不依赖人主动核对；与 D1 守护合并后检查脚本本身有 pre-commit 兜底 |
| 定期人工校对文档 | 短期方案 | 零机制成本，但审查已证明「人校对」挡不住回潮（migration-progress 就是人工维护失守的案例）；且校对周期内文档继续误导导航 |

## §4 验收

1. **快照标注**：5 处文档（module-map / migration-progress / v6-architecture-refactor / renderer-target §2.2 / §2.0+§2.3）头部或相应章节均有「截至 <日期> 历史快照」标注
2. **检查指向**：module-map 与 migration-progress 的「当前状态」节执行 `.githooks/check_layer_boundaries.py --report` exit 0（D1 修复后为空清单）——**真实场景：故意在 services/ 加一处违规 import，再跑 --report，输出非空且 exit 非 0，文档所示指令与实际行为一致**
3. **声明失守归零**：`rg "FULLY CLEAN"` 在 migration-progress 只剩历史引用（快照语境），无现状语气；`rg "48 files · 8165"` 标注为历史数字
4. **renderer 文档**：§2.2 速查表 6 条归属与 `rg` 实际定义位置一致（2 条失效路径已修正）；§2.0 图含 extension-protocol 叶子、形态为 DAG；§2.3 无「未实现机制」的现状语气描述
5. **v6-architecture-refactor**：B1-B9 每项有落地状态标注（✓/× + 证据），后续侦查按标注可跳过已落地项

## §5 下一层拆分

### 收口节奏（随波次起，不单独立项）

| 波次 | 文档动作 | 触发条件 |
|------|---------|---------|
| W0 | v6-architecture-refactor.md 落地状态标注（B/C 项多随 W0 落地，边做边标） | B1/B2/C1/C4 commit 后 |
| W1 | module-map + migration-progress 快照化 + 检查指向（与 D1 守护同批 commit）；renderer-target §2.0/§2.3 图与纪律修正 | D1 的 check_layer_boundaries.py 落地后 |
| W2 | renderer-target §2.2 速查表最终核对（C2 归位改动后） | C2/C3 完成后 |
| 每波次收尾 | 涉及文档的候选落地时，同步刷新对应文档「当前状态」节；波次完成跑 §4 验收 1-4 项 | 各波次完成时 |

### 任务清单

1. W1：module-map.md 快照化（头标注 + 数字生成式 + 检查指向）——1 commit，与 D1-⑦（migration-progress 改造）同批
2. W1：migration-progress.md :209 改写 + 检查指向——同批 commit
3. W0/W1：v6-architecture-refactor.md 逐项落地标注——随 W0 各 commit 顺手标注
4. W1：renderer-target-architecture.md §2.0 改 DAG 图 + EP 叶子 + §2.3 纪律修正——1 commit（文档独立）
5. W2：renderer-target-architecture.md §2.2 速查表重写——C2 归位后 1 commit
6. 全部完成后：本目录 README 的 §5 波次执行建议同步勾选

### 风险与注意

- 文档改动不触发 lint（无代码），但仍需 pre-commit 通过（目录规范检查等）
- 修法 3（renderer 侧可执行检查）若发现 §2.2 涉及的文件归属无现成检查脚本，不新增脚本——归属条目以 `rg` 核实为准（不为此建守护，避免过度工程）；真正需要守护的是 D1 的三层边界（已有）
- 文档「当前状态」指向的检查脚本如果未来改名/删除，需同步更新文档——把「指向脚本」本身写进文档时附脚本路径的核对提示
