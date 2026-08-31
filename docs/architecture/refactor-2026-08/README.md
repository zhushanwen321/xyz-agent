# 架构审查重构总纲（2026-08）— 主文档

> 本目录是 2026-08-13 架构审查（`.xyz-harness/2026-08-13-architecture-review/architecture-review-20260813-123401.html`）产出的 36 个候选改进项的设计文档集。本文件是总纲，各层详细设计见子文档。

## §1 背景与目标

### 背景（SCQA）

2026-08-13 对 feat-optimize-ui 分支执行了包级/进程级整体分层审查 + 四层内部模块深度审查（5 个 subagent × 109 项声明逐条对抗核查，32 项失真已修正）。审查结论：**分层骨架合理、方向成立，但"声明"与"事实"存在三处偏差，每层内部都有回潮 / 残留 / 组织债**。

### 目标

按本设计文档集分波次落地 36 个候选改进项，做到：

1. **架构核心承诺恢复**：runtime 三层依赖方向（D1）、renderer 七层铁律（C2）、core 真 headless（B2）回到声明状态。其中 **D1 补上 runtime 三层的可执行 pre-commit 守护**（check_layer_boundaries.py），使 runtime 回潮被自动化拦住；**renderer/core/electron/extensions 四层的归位守护暂不自动化**（人工 + review 守住，评估成本后再决定是否补 githook，见各子文档"守护"说明）
2. **死代码与兼容壳清除**：B1/C1/C4 等绞杀残留死壳、shim 层、假声明全部删除（合计约 600 行零风险删除）
3. **seam 归位与重复收敛**：绕 seam 直连（C2）、跨端重复实现（C3/F1）、外部协议多份解析（F2/F7）收敛到唯一权威
4. **文档债收口**：过期 3 倍的 module-map、失守的 migration-progress、失效的速查表全部改为"历史快照 + 可执行检查输出"两段式

### Out of Scope

- 不引入新的 UI 视觉改动（本分支 feat-optimize-ui 的视觉工作不受影响）
- 不改变 pi 私有协议交互（触发词 triggerTurn/deliverAs 等语义维持现状）
- 不新增第三方依赖（除已有先例外，如 pre-commit 检查复用项目既有 check_path_whitelist.py 模式）

## §2 现状与问题分析

### 整体判定（来自审查报告 §0）

| 维度 | 判定 |
|------|------|
| 依赖方向 | 五包链零反向 import、零环、零绕过包入口（实测确认，无自动化守护） |
| 链 vs DAG | 文档画的是线性链，实测是 DAG（renderer 直连 core 96 文件、直连 shared 237 文件） |
| 漏画的叶子 | extension-protocol（0.8k 行零依赖）被五方依赖，是最底层叶子，不在五包图中 |
| 模块名漂移 | renderer 目录包名实为 @xyz-agent/frontend；速查表 2/6 路径已失效 |

### 跨层共性（3 条，主文档强制约束）

1. **绞杀迁移是主叙事**：chat 域已完整下沉 core（chat.ts 906→31 行），subagent/workflow/fileTree/project 四域停在断点——同层内新旧两种 implementation 并存。任何新增代码禁止制造第三种模式
2. **文档滞后于代码**：module-map 快照过期 3 倍、migration-progress 声称「FULLY CLEAN」已失守、v6 速查表 2/6 路径失效。本设计集落地时同步修文档
3. **「无守护 → 回潮」是通用病根**：runtime 三层泄漏、extensions 依赖声明矛盾，都是没有可执行检查守住的声明式约定。每层落地"归位"类改动时，必须同时问"守护在哪"

### 36 候选总览

| 编号 | 层 | 级别 | 一句话 | 波次 |
|------|-----|------|--------|------|
| B1 | 包级链 | Strong | 清除 renderer 的 core re-export shim 层 | W0 |
| B2 | 包级链 | Strong | core 的 pinia 死声明移出 dependencies | W0 |
| B3 | 包级链 | Worth | composables/logic/ 纯函数下沉 core（12 文件 1347 行，⚠️ mermaid 因 DOM 依赖不下沉，见 01 文档） | W3（DP-1 已决：下沉） |
| B4 | 包级链 | Worth | shared 扁平大杂烩按域收敛 | W4 |
| B5 | 包级链 | Worth | 包名统一 frontend vs renderer | W5 |
| B6 | 包级链 | Speculative | composer-shell 越层直连 dom-core 裁决 | W5 |
| B7 | 包级链 | Speculative | mobile sync 文档 gap 清理 | ⏸️ 暂缓（前提反转，remote 合并后协同） |
| C1 | renderer | Strong | useSidebar 绞杀残留死壳删除（565 行旧壳删除，useSidebarNew 重命名接管原名，2026-08-31 收尾） | W0 |
| C2 | renderer | Strong | Feature 层 vue 直连 lib/ipc 归位到域 composable | ⏸️ 暂缓（归位位置 vs COPY_MAP 待裁决） |
| C3 | renderer | Strong | 剪贴板 4 份 + resize 订阅 N 份收敛为 useClipboard/useWindowResize | W2 |
| C4 | renderer | Strong | summarizeTurn dead code + guiComponent 注释失真 | W0 |
| C5 | renderer | Worth | 四未下沉 store 直连 api 通道 → 下沉 core/domain | W3 |
| C6 | renderer | Worth | composables/panel/ 25 文件平铺 → 分子目录 | W4 |
| C7 | renderer | Worth | components/panel/ 巨模块群拆分（DetailPane 优先） | W4 |
| D1 | runtime | Strong | 三层骨架回潮修复 + pre-commit 守护（**Top 推荐**） | W1 |
| D2 | runtime | Strong | 16/16 port 单实现 → 7 个 hypothetical seam 折叠（需裁决；hypothetical seam = 单消费方 1:1:1 port，形式 seam 非真抽象点） | ⏸️ 暂缓（remote 合并后盘点 ports） |
| D3 | runtime | Strong | ITerminalService/IWorktreeService 方向反置归位 | W2 |
| D4 | runtime | Strong | settings-message-handler 业务编排下沉 config-service | W2 |
| D5 | runtime | Worth | session-message-handler 业务判断下沉 | W3 |
| D6 | runtime | Worth | JsonStore 深模块被新 store 绕过，复用 + 常量收敛 | W3 |
| D7 | runtime | Worth | message-bus stateTypeKey 发布侧断链修复 | W3 |
| D8 | runtime | Worth | session-service God facade + preset-service 五职责切分 | W4 |
| D9 | runtime | Speculative | workspace-service 薄委托：**建议关闭（不删）** | W5 |
| E1 | electron | Strong | update-handlers 业务编排下沉 orchestrator | W3 |
| E2 | electron | Strong | stderr sink 收尾收进 supervisor（组合根穿透 Facade） | W2 |
| E3 | electron | Strong | 窗口枚举双权威收敛到 WindowManager | W2 |
| E4 | electron | Worth | 组合根去内联化（三处同类） | W4 |
| E5 | electron | Worth | interfaces.ts 契约层 session 域泄漏 | W4 |
| E6 | electron | Worth | supervisor 内部重复实现 + shell-env 目录孤儿 | W4 |
| E7 | electron | Speculative | preload 形态适配归位 + update 域口径统一 | W5 |
| F1 | extensions | Strong | 跨包微型工具 12 处复制下沉 shared | ⛔ 冻结 |
| F2 | extensions | Strong | pi session JSONL 解析 adapter 唯一化 | ⛔ 冻结 |
| F3 | extensions | Strong | shared 层定位重整（quota-providers 死面，删除测试驱动 + DP-3） | ⛔ 冻结（quota 重构中，DP-3 暂缓） |
| F4 | extensions | Worth | Ajv schema 编译层收敛（审计先行，涉及 builtin） | ⛔ 冻结 |
| F5 | extensions | Worth | 裸 console 迁移决策（二选一） | ⛔ 冻结 |
| F6 | extensions | Speculative | formatDuration 同名异义（合法变体，记录即可） | ⛔ 冻结 |
| F7 | extensions | Medium | assistantMessageEvent 分流唯一化（与 F2 同构） | ⛔ 冻结 |
| §6 | 文档债 | - | 5 份文档改"历史快照 + 可执行检查输出" | W1 起随行 |

## §3 解决方案

### 波次计划（依赖约束优先，非纯优先级排序）

**W0 · 快赢（死代码/假声明清理，零风险，建议 1 天内完成）**
B1 + B2 + C1 + C4。四者均为删除/降级操作，无行为变化，同一天可完成（审查报告明确标注）。完成后即提交。

**W1 · 架构核心承诺恢复（Top 推荐，最高 leverage）**
D1：runtime 三层回潮修复 + pre-commit 守护。配套 §6 文档债中 migration-progress 改为指向检查输出。**本波次优先级最高**——它把 runtime 的"声明式三层边界"变成"可执行检查"，runtime 回潮被 check_layer_boundaries.py 自动拦住（扫描范围 `packages/runtime/src/{transport,services,infra}/`）。
- 依赖：无（独立可做）
- 守护范围说明：check_layer_boundaries.py **只扫 runtime 三层**，不覆盖 renderer 七层 / core headless / electron / extensions——这四层的归位（C2/B2/F1/F2 等）靠人工 + review 守住，各子文档守护项均标注「随 W1/D1 评估」。若后续某层回潮频发，再为该层补最小 githook（参照 D1 范式）

**W2 · seam 归位（中风险，行为收敛类）**
C3 + D3 + D4 + E2 + E3。五项都是"绕过已有 seam 的直连/错位归位到正确位置"，模式相同（收编 → 收敛 → 删除旧路径），可并行走 3 层。
- ⏸️ **C2 已暂缓**（归位位置与 remote COPY_MAP 覆盖冲突，待 mobile 开发协同裁决，见「实施状态与决策记录」节）——C3 不依赖 C2（features/browser/ 已有先例）

**W3 · 下沉/收敛（中高风险，行为迁移类）**
B3 + C5 + D5 + D6 + D7 + E1。六项都是"把逻辑从 A 层迁移到 B 层 / 修复深机制断链"，涉及 import 改写和测试迁移，是最大波次。F1/F2/F7 已冻结（extension 冻结，见「实施状态与决策记录」节）。
- B3 前置：✅ DP-1 已裁决（下沉，mobile 为真实消费方）——子集边界按 mobile 消费清单确定
- E1 前置：orchestrator 已 DI 注入，验证现有测试基建后再收编
- D7 前置：对照 ADR-0055 phase-1/phase-2 边界确认 dual-write 退出范围
- ⛔ DP-3 前置（F1/F3 联动）冻结：F3 删除测试随 quota-providers 重构消化，DP-3 裁决等 extension 解冻后重新评估

**W4 · 组织债 / 深模块（长期架构收益，大工程）**
B4 + C6 + C7 + D8 + E4 + E5 + E6。七项中 C6/C7/E4 是纯组织重构（低风险），B4/D8 是结构性（高风险）。F3/F4 已冻结（extension 冻结）。
- ⛔ F3 前置（删除测试 + DP-3 裁决）随 extension 冻结暂停，解冻后并入
- D8 渐进切分，禁止大爆炸（审查报告明确警告）

**W5 · 决策 / 收尾（低风险，需裁决项 + 文档对齐）**
B5 + B6 + D9 + E7。B7/D2 已暂缓（remote 合并后重新评估）、F5/F6 已冻结（extension 冻结），见「实施状态与决策记录」节；D9 建议直接关闭（审查报告核查后判定原候选自相矛盾）。
- ⏸️ D2 前置（DP-2 裁决）暂缓：remote 合并后盘点 ports 消费方再裁（折叠可逆，晚裁成本低）
- E5 在 W4（总览表口径），涉及 shared 类型 + renderer 消费方，盘点先行（renderer 对 WindowState 零消费、sessionIds 是恒空镜像已初步核实）再动

### 关键决策点（DP）清单

| DP | 问题 | 涉及 | 推荐倾向 | 裁决时机 |
|----|------|------|---------|---------|
| DP-1 | logic/ 纯函数下沉 core 与 renderer-target-architecture §2.2「留在原处」裁定冲突 | B3 | 包级 leverage 视角优先（移动端复用价值 > 包内七层纯净），下沉 | ✅ 已裁决（2026-08）：下沉（mobile/多端开发中，demand-driven 条件成立） |
| DP-2 | port 折叠进消费方 vs 按域集中拆分（R9 决策相悖） | D2 | 单消费方 port 折叠（7 个），多消费方 port 留 ports/；与 R9 的"集中"是两种组织哲学，需一次显式裁决 | ⏸️ 暂缓：remote 合并后盘点 ports 消费方再裁 |
| DP-3 | shared/ 层去留（quota-providers 死面砍后残存价值） | F3 | 删除测试驱动：砍死面后若只剩 readCache 深接口 → 保留瘦身；若渗透率推不动 → 撤销 shared 定位，quota 并回 model-switch。**裁决时机：W3 之前**（F3 删除测试独立先行，裁决结果决定 F1 utils 归位，避免决策与实施反序） | ⏸️ 暂缓：quota-providers 重构中 + extension 冻结，重构完成后重新评估残存价值 |
| DP-4 | 裸 console：全仓推广 extension-logger vs 承认私有依赖退出 shared | F5 | 真实数据支持推广（用了 logger 的包裸 console=0），推广优先 | ⛔ 冻结：extension 冻结期间不裁（依赖 DP-3） |
| DP-5 | composer-shell 越层直连 dom-core：文档注记 vs 强制链式 | B6 | 注记（选项 b）——强制链式会为形式约束加一层纯转发 seam | W5 实施前 |
| DP-6 | 包名 @xyz-agent/frontend vs 文档改口 frontend | B5 | 改包名 @xyz-agent/renderer（改口面更大，改包名一处） | W5 实施前 |

### 实施状态与决策记录（2026-08 更新）

**上下文变更**（本设计文档集成稿后）：mobile/多端与 remote 使用均已进入开发（`feat-remote-use` 分支 P0-P7 待合并 main）；extension 开发冻结（用户指令）；quota-providers 正在重构（用户指令）。以下为由此产生的裁决与暂停记录。

**决策记录**

| 决策 | 结果 | 依据 |
|------|------|------|
| DP-1（B3 下沉） | ✅ 已裁决：下沉 | mobile/多端开发中，mobile-renderer 为真实消费方——「零消费、基于预期」的 speculative 前提失效，demand-driven 条件成立。子集边界按 mobile 消费清单确定，mermaid 不下沉不变 |
| C2 归位位置（新增裁决） | ⏸️ 待裁决 | remote COPY_MAP 整目录 copy（composables/ 等 26 项）vs 七层 features/ 域归位——C2 产出放 composables/（sync 兼容）或 features/ + COPY_MAP 显式清单化，与 mobile 开发协同定 |
| B7 重新设计（前提反转） | ⏸️ 待 remote 合并 | feat-remote-use 分支真实存在 `scripts/sync-mobile-from-renderer.sh`（COPY_MAP 26 项 + MANUAL_FORK useConnection.ts）——sync 机制合并后真实存在，B7 从「删纪律描述」改为「按真实机制更新文档」 |
| DP-2（D2 折叠） | ⏸️ 暂缓 | remote 合并为 runtime 侵入式改动（connection-manager/message-broker 重写、lease-manager 新增），「7 个单消费方」事实需在 remote 基线重新盘点；折叠可逆，晚裁成本低 |
| DP-3 / DP-4 | ⏸️ 暂缓 / ⛔ 冻结 | quota-providers 重构消化 F3 删除测试前提；extension 冻结使 F1/F5 决策链下游暂停 |

**暂停清单（需要等的，先不做）**

| 项 | 状态 | 重新评估触发 |
|----|------|-------------|
| D2（W5） | ⏸️ 暂缓 | remote 合并后 |
| B7（W5） | ⏸️ 暂缓 | remote 合并后 |
| C2（W2） | ⏸️ 暂缓 | mobile 开发协同裁决归位位置 |
| F1-F7 + conventions 附带项 | ⛔ 冻结 | extension 解冻 |
| DP-3（F3 删除测试） | ⏸️ 暂缓 | quota 重构完成 + extension 解冻 |

**执行注记**

- **D1 与 remote 合并**：D1（W1）落地后，remote 分支 runtime 代码（transport 侵入式改动）合并进 main 必须过 `.githooks/check_layer_boundaries.py`——提前确认 remote 分支三层合规，否则合并被拦。D1 是 remote 合并的三层边界守门人，优先级不变
- **B1 与 COPY_MAP**：`lib/file-basename.ts` 在 remote COPY_MAP 单文件清单内——B1 删除 shim 后需同步清理 remote 分支 COPY_MAP 条目（脚本 SRC-MISSING 警告机制兜底）
- **C5/C7 与 COPY_MAP**：stores/、components/panel/message-stream/、components/panel/detail-renderers/ 均在 COPY_MAP 整目录清单内——C5 下沉后 mobile 改从 core import（与 mobile 开发协同）；C7 拆分产物落在 COPY_MAP 覆盖范围（detail-renderers 已入清单），与 sync 对齐，无冲突

### 子文档索引

| 文档 | 覆盖 | 重点 |
|------|------|------|
| [01-package-chain.md](01-package-chain.md) | B1-B7 | shim 清除、pinia 死声明、logic 下沉、shared 分域、包名、越层裁决、mobile 文档 |
| [02-renderer.md](02-renderer.md) | C1-C7 | 死壳删除、ipc 直连归位、clipboard/resize 收敛、dead code、store 下沉、组织债 |
| [03-runtime.md](03-runtime.md) | D1-D9 | 三层回潮守护、port 折叠、接口归位、transport 下沉、JsonStore、God facade |
| [04-electron-main.md](04-electron-main.md) | E1-E7 | update 编排归位、stderr sink、窗口单权威、组合根、契约层、supervisor 重复 |
| [05-extensions.md](05-extensions.md) | F1-F7 | 跨包工具下沉、JSONL adapter、shared 定位、Ajv 收敛、console 决策、事件流分流 |
| [06-doc-debt.md](06-doc-debt.md) | §6 | 5 份文档的历史快照化 + 指向可执行检查 |

## §4 验收

### 全局验收（每波次完成后跑）

1. **真实场景冒烟**：`pnpm run dev` 启动应用，完成一次完整对话（新建 session → 发消息 → 收回复 → 折叠/展开侧栏 → 切 session → 重开 session 验证历史），确认无回归。涉及 runtime 改动时用 Playwright 连 dev app（端口 9222）做 DOM 级验证
2. **全量检查**：`pnpm extensions:typecheck`、`pnpm extensions:lint`、renderer/runtime 各自 `npx vitest run` 全绿、`pnpm run lint` 通过
3. **打包链路**：W3 之后每波次至少跑一次 `bash scripts/validate-runtime-bundle.sh`（涉及 runtime 文件时）
4. **守护生效**：W1 后故意制造一次 D1 类违规，确认 pre-commit 拦截（红线 13：运行时行为断言必须先验证——守护的拦截行为必须实测，不能只写进文档）

### 每候选验收

每个候选的验收场景见各子文档对应条目，共同强制项：
- 删除类（B1/B2/C1/C4/D9/E6 部分）：`rg` 确认旧符号零引用，typecheck 通过
- 收敛类（C2/C3/D3/D4/E2/E3/F1/F2/F7）：行为等价验证——迁移前后跑同一真实场景，断言输出一致
- 下沉类（B3/C5/D5/D6/E1）：既有测试全绿 + 新增单测覆盖迁移后的纯逻辑 + 真实场景冒烟

## §5 下一层拆分

- 每层子文档末尾给出该层内部的任务拆分与依赖顺序（见 [01](01-package-chain.md) - [06](06-doc-debt.md)）
- 波次执行建议：W0 → W1 → W2 可每波次一个分支/commit；W3-W5 按子文档内部任务粒度拆分 commit（打包相关改动必须逐个 commit 逐个验证，见 AGENTS.md §12）
- 全部完成后：本目录文档标注实施状态，migration-progress 等文档债随 W1 收口

## 附：证据与修正记录

- 审查报告：`.xyz-harness/2026-08-13-architecture-review/architecture-review-20260813-123401.html`（只读实测 + 5 subagent × 109 项声明核查，32 项失真已修正）
- 本设计文档集中的所有文件路径/行号均经二次核实（2026-08-13 审查后代码有少量漂移，已按实际路径修正，见各子文档"事实修正"说明）
- 审查报告中的 ⚠️ 核查修正项（如 C1 消费方 9 非 20、F5 裸 console 真实计数、D9 原候选自相矛盾）在设计文档中均按修正后口径描述
