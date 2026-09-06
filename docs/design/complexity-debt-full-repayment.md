# 继承复杂度债务全量清零（第二批）设计

> 状态：已通过 design-code-sync 三轮校准（2026-09-06，所有等级当轮修不留尾巴：A-A12-01/A-EVID-02/B2-F1/B2-F2 已清零；B1-01/B2-F3..F6/A-SCOPE-03/A-EVID-04 已修；A12 deferred 至主会话收口见 impl-plan §7）
> 日期：2026-09-06 | 上游：docs/todo/complexity-debt-inventory.md（SSOT；A12 deferred 待主会话删除）
> 前序：第一批 21 项已偿还（commit e6c2bb9b9，130→109），范式已对抗式复审实证（零 must-fix）

## 1 背景/目标

### 背景

全仓普查（fallow 口径：if/for/while/case/&&/||/??/三元/?./catch 各 +1、入口 +1）发现存量
**109 个函数 cyclomatic>15，分布 93 个文件**，按函数数分区（2026-09-06 fallow 实测）：

| 分区 | 函数数 | 分区 | 函数数 |
|------|--------|------|--------|
| extensions/universal | 39 | ui | 2 |
| runtime | 23 | renderer | 2 |
| subagent-core | 19 | shared | 2 |
| packages/core | 8 | electron main | 4 |
| scripts/ | 7 | dom-core | 1 |
| taste-lint | 1 | e2e | 1 |

第一批已偿还的 21 项验证了「并行 worker + 行为保持提取 + 主会话串行验证 + 对抗式复审」范式的有效性。

### 目标

1. 全仓 cyclomatic>15 函数清零（fallow health --max-cyclomatic 15 复测 = 0 findings）
2. 每个目标函数与提取的新 helper 全部降到 ≤12（保守余量；全局由 A1 抽验兜底）
3. 行为保持：错误文案、调用时序、事件发射顺序、返回值语义逐字节不变
4. 债务清单 SSOT（docs/todo/complexity-debt-inventory.md）终态删除（删除前顺手修正其日期标注笔误）

### Out-of-scope

- 不动 introduced 门禁阈值（.fallowrc.json health 节是 SSOT）
- 不借重构改行为/修 bug/加功能；发现行为 bug 登记 docs/todo 不顺手修
- 不改 fallow 工具本身；不改 metrics-gate 脚本
- 第一批已偿还的 21 项不回炉

## 2 终态/机制

### 重构形态（与第一批相同的两类）

1. **阶段化提取**：按校验/装配/分发/收口提模块内私有 helper，主函数只留编排（参数显式传递，禁止隐式可变共享状态；闭包变量逐个核对传入）
2. **表驱动分发**：switch 每个 case 体提为独立函数，主函数留查表+落空语义（落空行为与原 default/无 default 逐字节一致；同步 case 保持同步——微任务时序不变）

### 分波与并行机制

- **领地互斥**：unit 按文件路径聚类（impl-plan 精确到文件），任意两 unit 领地交集为空
- **worker 纪律**（第一批实证）：只写代码与测试；【禁止】跑 vitest/fallow（同包并发触发 oxc/vite transform 缓存竞争假红、fallow 缓存并发写失真）；【禁止】git 写操作；【允许】自检——ts/tsx 领地用包内 tsc --noEmit；.vue 领地用 vue-tsc --noEmit；.cjs/.mjs 领地用 `node --check` 语法检查（行为验证由主会话兜底）
- **主会话串行验证**：每波收齐后逐包跑 vitest（junit xml 提失败明细）+ tsc；vitest 全局串行
- **分歧裁决**：测试失败时 `git stash push -- <精确源文件路径>` 保测试文件跑 HEAD 实现对照——HEAD 也挂 = 用例/mock 错（修用例）；HEAD 过 = 重构漂移（修实现，must-fix）。**该对照的前提是「每波 commit 后 HEAD 上该文件 = 上一波终态」**，由下节 commit 粒度保证
- **派发通道**：原生 Agent tool（run_in_background）——zsw 引擎 300s 单轮墙钟对本规模任务系统性误杀（第一批会话实证），故本批不采用

### commit 粒度与回滚通道（两级）

- **每波一个 commit**（波 = 一批并行 unit 领地交集为空、同波验证完毕）：波内问题在提交前修到绿才 commit；跨波问题按波 revert
- 未提交态回滚：`git checkout -- <unit 文件集>`（领地互斥保证单文件单 unit 归属）
- 已提交态回滚：`git revert <波 commit>`（波间无文件交集，revert 不牵连其他波）
- 分歧裁决的 stash 对照依赖「HEAD 该文件 = 未重构（或上一波终态）实现」——领地互斥 + 波间 commit 共同保证

### 特殊风险点（逐文件核对过锚定手段；第一批未覆盖面）

| 风险点 | 锚定手段核实结论 | 处置 |
|--------|------------------|------|
| subagent-service.ts:1830 runAndFinalize(31)，1830 行巨型文件 | session-runner 覆盖 99.5%（第一批 commit 背书） | 该 unit 锚定测试先行：worker 先补特征用例再动生产码；报告逐分支给行为等价证据 |
| **electron 更新族** downloadAsset(35) / cleanupCompletedUpdate(35) / maybeRollbackInterruptedUpdate(25)——行为漂移后果是更新失败/错误回滚（事故级） | 已有专测：main/test/ 下 update 族专测 11 个（download-asset.test.ts、update-self-healer.test.ts 等） | 依赖既有测试锚定（不要求先行补测）；unit 报告须给出「既有测试覆盖了哪些分支、补了哪些」清单 |
| **taste-lint** no-unbounded-while-true.mjs walkStatements(39)——全仓最高复杂度；**该规则无 .test.mjs**（rules/ 21 个文件 = 17 条规则 + 4 个 .test.mjs，本条不在其中），经 eslint.config.mjs:316 全仓 warn 启用且根 lint `--max-warnings 0`（warn 即 fail）：漏报=门禁静默失效，误报=全仓 lint 红卡死 pre-commit | 无既有规则测试，锚定手段必须先建 | 该 unit **补规则判定测试先行**（对齐 no-chat-ops-in-components.test.mjs 既有形态，运行通道 = 仓库根 `pnpm exec vitest run taste-lint`，与 CI ci.yml 同命令），修前绿再动重构；该命令在 A2 执行，时机覆盖「修前（新测试落绿确认）」与「波收口」两次 |
| **Composer.vue onKeydown(20)——script setup 实测 299 行，vue_rules_checker.py MAX_SCRIPT_LINES=300 硬拦**，「同文件局部函数」机械余量仅 1 行，不可用 | 机械守卫实测 | **必拆 composable**（新建文件，目录归属按项目 composable 约定），遵守 ADR-0049（onKeydown 持有 per-session 状态时必须 useSessionScopedState 工厂）并由 reviewer 按 ADR-0049 checklist 核对；SettingsModal.vue(197 行) 不受限 |
| **bundle-extensions.mjs(20)**——无 argv/dry-run，跑一次=真实清空重建 staged 产物目录 apps/electron/resources/extensions/（该目录不被 git 跟踪，漂移无 git diff 防线；下游是 Electron 打包链） | 「干跑」锚定不可执行 | 验收专门条款：重构前后各跑一次 bundle-extensions，diff staged 产物目录逐字节为空（见 A9） |
| **.cjs 运行时** review-fix-loop-utils.cjs（被 review-fix-loop.js require 装载） | 直接单测在 packages/subagent-core/src/__tests__/review-fix-loop-utils.test.ts + review-fix-loop-script.test.ts（subagent-core vitest 通道覆盖）；cjs 头注释引用的旧测试路径已过时，该 unit 顺手修正 | 纯提取不改导出形态；验证 = subagent-core vitest + extensions 的 review-fix-loop-e2e.test.ts |
| .mjs 构建巡检脚本 scripts/ 7 文件（render-constraints 28、verify-staged-extensions 25 等为 pre-commit/CI 关键链路） | 部分有单测（taste-lint 机制）、部分零测试 | 冒烟最低标准 = **真实干跑一次并 diff 输出**（`--help` 不算——可能不经过重构函数路径）；确实无法干跑的（有副作用的）由主会话逐个裁决豁免理由，不允许 worker 自登记 |
| bench 文件（subagent-workflow 2 个 .bench.ts，4 函数） | package.json 无 bench script，无自动通道；显式登记不验证理由：纯提取不改算法，tsc + node --check 锚定 | 同上，报告声明 |
| e2e spec（e2e/workflow-thinkinglevel-real.spec.ts:487 arrow 19） | spec 自证「real case 慢且花 token」+ 需 real renderer bundle + playwright 单跑 | 重构后主会话终态跑一次 `npx playwright test e2e/workflow-thinkinglevel-real.spec.ts --grep TC1` 最小锚定（不跑全 spec） |
| rename-session/e2e 的 run-a1.mjs(19) / harness.mjs(17)——分类缝：非 src、非构建脚本、不在 playwright 通道；rename-session 包仅 vitest run | 无自动通道 | 主会话手工跑 `node run-a1.mjs` 一轮锚定（或登记豁免） |

### 错误处理

- worker 报告领地外必改 → 停止上报主会话，禁止顺手改
- 同一 unit dev→fix 超 2 轮未绿 → 冻结该 unit，升级用户
- 全波次完成后再进审查；审查 must-fix 未清零不进验收

## 3 验收场景表

| # | 真实流程 | 通过标准 |
|---|----------|----------|
| A1 | `fallow health --max-cyclomatic 15 --max-cognitive 999 --max-crap 999999 --sort cyclomatic --top 423 --format json`（workspace root，清缓存后） | findings 中 cyclomatic>15 = **0**；并抽验各 unit 报告中新 helper 估算 cyclo ≤12 |
| A2 | **改动涉及的包各自 vitest 全量**（从各子包目录）：packages/runtime、packages/subagent-core、packages/renderer、packages/dom-core、packages/ui、packages/core、packages/shared、apps/electron（test:main）；另有仓库根 `pnpm exec vitest run taste-lint`（与 CI 同命令，执行时机覆盖 taste-lint 规则测试的「修前落绿」与「波收口」两次）；serial 全局排队 | 全部 0 failed |
| A3 | `pnpm extensions:typecheck && pnpm extensions:lint && pnpm extensions:test` | exit 0（extensions 39 函数的运行时防线） |
| A4 | 各改动包 tsc --noEmit（renderer/vue 领地用 vue-tsc；.cjs/.mjs 用 node --check） | 0 错误 |
| A5 | `python3 .agents/skills/pr-cr-fix/scripts/metrics-gate.py --base main` | fail=0 |
| A6 | 对抗式复审（2 reviewer 按领地分工，逐 case token 对比 + 字面量多重集 diff） | must-fix = 0；suggestion 逐条裁决（修/登记） |
| A7 | 字面量零漂移抽查，抽样规则 = **cyclomatic top 5 + 每分区随机 1**（约 17 个，覆盖全部分区）：`git show HEAD:<file>` vs 工作区字符串字面量集合比对 | 错误文案零漂移（路由表 key 类预期新增除外） |
| A8 | `pnpm run lint` 全仓，重构前后 findings 集合 diff | 为空（taste-lint 规则重构防线） |
| A9 | bundle-extensions 前后产物比对：重构前后各跑一次 `node scripts/bundle-extensions.mjs`，diff apps/electron/resources/extensions/ | 逐字节为空 |
| A10 | e2e 最小锚定：`npx playwright test e2e/workflow-thinkinglevel-real.spec.ts --grep TC1`；`node extensions/universal/rename-session/e2e/run-a1.mjs` 一轮 | 两命令 exit 0 |
| A11 | design-code-sync 双向校准（本设计文档 + impl-plan vs 实际终态） | must-fix = 0 |
| A12 | 终态：A1-A11 全绿后删除 docs/todo/complexity-debt-inventory.md（删除前顺手修正日期标注笔误） | git log 含删除记录 |

## 4 下一层拆分（unit 切分原则，精确表在 impl-plan）

- 按「同包/同目录聚类 + 领地互斥」切 unit，每 unit ≤5 文件（全局 subagent 约束）；109 函数 93 文件预计 22-26 个 unit，extensions 39 函数（最大区）按包再细分为 6-8 个 unit
- 高风险文件（subagent-service.ts runAndFinalize、electron 更新族、taste-lint 规则、Composer.vue）所在 unit 只带 ≤2 个伴文件，并按 §2 风险表特殊处置
- 无跨 unit 共享契约（重构均为文件内提取）→ 无 u-foundation 根节点，DAG 接近平铺，按并发 ≤5 分波
- 全部 plain 隔离（领地互斥已保证无热点冲突；不开 worktree）
- 验收条款（unit 级）：目标函数与新 helper cyclo ≤12（fallow 复测）+ 领地内自检 0 错误 + 行为保持自查证据（文案/时序抽样比对）+ 补齐覆盖缺口测试

## 5 变更历史

- 2026-09-06 v1 创建
- 2026-09-06 v2 落实主审 3MF（A2 扩为改动包全清单、A3 扩 extensions 三连、分区按 fallow 实测重写）+ 影响面 4MF（taste-lint 补规则测试先行 + A8 lint findings diff、Composer.vue 必拆 composable + ADR-0049、bundle-extensions 产物比对 A9、每波一 commit + 两级回滚）+ 10 suggestion（electron 更新族/自检手段/归类缝/测试指路/抽样标准/冒烟标准/A1 抽验/e2e 量化等）+ 2 info（SSOT 日期笔误顺手修、cjs 头注释漂移顺手修）
- 2026-09-06 v2.1 落实聚焦复审 MF-R1（taste-lint 规则测试执行通道：A2 追加根级 `pnpm exec vitest run taste-lint`，覆盖修前与波收口两次）+ 2 处数字表述修正（rules/ 21 文件 = 17 规则 + 4 测试；update 族专测 11 个）。复审者预声明：满足即 can-approve → **阶段 0 通过**

- 2026-09-06 v2.2 design-code-sync 三轮校准（B1-01 旁注）：v2.1 写「rules/ 21 文件 = 17 规则 + 4 测试」是设计期时点（U01 修前），U01 commit c65ce3759 落地 no-unbounded-while-true.test.mjs 后终态为 **rules/ 22 文件 = 17 规则 + 5 测试**；§4 预测「22-26 个 unit」实际 27 unit（偏差原因：U22/U23 拆分为独立单元，extensions 39 函数按包细粒度超出 6-8 预测上沿，U01 配套新测试文件独立计 5 unit 也贡献一项），均已在 impl-plan §6 状态表 + §2 单元列表固化；其余 v2/v2.1 文本不动。
