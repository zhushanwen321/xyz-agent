# npm 发布面一致性守卫 实施计划

基线: cb73002b1（设计文档 v4 commit）| 来源设计: docs/design/npm-publish-surface-guard.md | 日期: 2026-09-07

## 0 章节映射

| 内容 | 本文实际位置 |
|------|--------------|
| 背景/目标 | §1 背景目标（SCQA §1.1 / 受众背景 §1.2 / 设计目标 G1–G4 §1.3 / in-out scope §1.4） |
| 终态/机制 | §3 解决方案（终态+失败路径 §3.1 / 方案对比 §3.2 / 关键决策 D1–D8 §3.3 / 终态数据流 §3.4） |
| 验收场景表 | §4 验收（S1 / S1b / S2 / S3 / S4 / S5 / S6 / S6b / S7） |
| 下一层拆分 | §5 下一层拆分（u1–u5 单元表 + 文件改动地图 + 实施顺序） |
| 待验证检查点 | §5 末「待验证检查点」2 项（豁免新形态判定 / S5 CI run 安排） |

审查证据：3 轮对抗式审查收敛（主审 2+1+0 / 影响面 4+0 must-fix），第 3 轮报告 /tmp/review-publish-surface/main-r3.md 判定 0 must-fix；全部 suggestion 已在 v4 修复（变更历史 §6）。v4 = commit cb73002b1。

## 1 目标快照（逐字摘录自设计 §1.3 / §1.4）

- **G1 发布面一致性机器门（双向）**：发布现场，每个 dist 发布包 `files` 白名单的每个条目必须真实存在于磁盘且非空（幽灵条目拦截，幽灵声明方向）；包内顶层 `dist*` 产物目录必须被 `files` 白名单覆盖（产物目录反向覆盖，漏声明方向）；自包含档（`dist.bundle/`）必须真正自包含（外部依赖探针）。
- **G2 构建入口显式化**：发布 workflow 显式声明每个 dist 包的全部构建档；消除「smoke 脚本副作用 = 唯一构建入口」的隐式依赖——构建产出由显式步骤保证，验证门只负责验证。
- **G3 同型缺口清偿**：dev 预发布线补 session-delivery build 步骤；`resources/plugins/statusline` 加 `"private": true`；deprecated 的 `pi-unified-hooks` 显式加入 changeset ignore。
- **G4 防复发登记**：constraints.json 新增 C-proc-11（发布面一致性约束，含「新增产物档须同批挂守卫」条款）。

**out-of-scope**：产物契约 manifest（仅登记触发条件）；subagent-core 0.5.2 发布编排（S7 只定义验收口径）；extensions 方向守卫改造（现状健康不动）；zsw 侧 vendor 通道回归（外部仓事务）。

## 2 单元列表

| Unit | 职责 | 领地（精确文件路径） | 依赖 | 隔离 | 验收条款 |
|------|------|----------------------|------|------|----------|
| u5 约束登记 | constraints.json 新增 C-proc-11（发布面一致性：files 白名单 ↔ 构建产出双向对齐，发布门强制；新增产物档须同批挂构建步骤、files 条目与守卫覆盖；自包含档命名约定 `dist.bundle`、非发布构建目录不得用 `dist` 前缀；非 workspace 包不经 changeset 发布线、防手滑 publish 用 private:true）→ 跑 render-constraints 重生成 md | `docs/constraints.json`、`docs/constraints.md`（生成产物，随同提交） | — | plain | ① constraints.json 含 C-proc-11 且 id/scope/权威源/执行方式字段与既有条目同构；② `node scripts/render-constraints.mjs` exit 0，md 再生成含 C-proc-11；③ `node scripts/check-doc-symbol-drift.mjs` exit 0 |
| u1 守卫脚本 | check-publish-surface.mjs：动态发现 dist 发布包（packages/ 下非 private 且 files 含 `dist*` 目录条目）→ 检查项 1 幽灵条目（磁盘 stat 判定形态：目录须非空 / 文件须存在 / glob 须命中 ≥1）+ 检查项 2 自包含探针（三步判定顺序：isBuiltin 先行 → 相对路径 → 裸名红 / 子路径须命中豁免；豁免 `ajv/dist/runtime/*` 含预期计数 4 + `.default` 形态锚点，超出红、少于预期 notice）+ 检查项 3 产物目录反向覆盖（顶层 `dist*` 目录须被 files 覆盖）+ 体积估算 warning（files 条目求和 > 5MB 提示 D7 重审，不红）；配套单测（vitest + tmpdir fixture，按 check-core-dist-gate.test.mjs 惯例） | `scripts/check-publish-surface.mjs`（新）、`scripts/__tests__/check-publish-surface.test.mjs`（新） | u5 | plain | ① 单测绿（用例覆盖设计 u1 行清单：幽灵三形态 / 无尾斜杠目录条目非空断言 / 探针三步顺序含 `fs/promises` `node:fs/promises` 内建子路径 PASS / 裸名红 / 豁免命中绿 / 子路径未命中红 / 豁免命中数超预期红 / 命中少于预期 notice 不红 / 反向覆盖命中 / 漏声明红 / glob 零命中边界）；② 三包四档本地构建后 `node scripts/check-publish-surface.mjs` 基线绿（S3 前置断言）；③ S1 实测：临时加 files 条目不构建 → 红含恢复指引；④ S1b 实测：mkdir dist.worker + 占位 .cjs 不加 files → 红；补条目 → 绿 |
| u4 尾部风险清偿 | statusline 加 `"private": true`；pi-unified-hooks 加入 changeset ignore | `resources/plugins/statusline/package.json`、`.changeset/config.json` | u5 | plain | S6b：① `node -p "require('./resources/plugins/statusline/package.json').private"` 输出 true；② `.changeset/config.json` ignore 数组含 `@zhushanwen/pi-unified-hooks`；③ 两文件 JSON 可解析 |
| u2 发布 workflow 接线 | release-npm.yml：subagent-core 两档显式构建 step + 守卫 step（publish 前）+ Summary step gates 文字补 publish surface guard；release-npm-dev.yml：session-delivery build + core 两档 + 守卫 step **全部挂 `should_publish == 'true'` 条件**，既有 `Build extension-protocol` 保持无条件不动 | `.github/workflows/release-npm.yml`、`.github/workflows/release-npm-dev.yml` | u1 | plain | ① diff 审查逐项符合 D2/D4（正式线新 step 无条件；dev 线新 step 同条件挂载 + 既有 step 零改动）；② 两 YAML 解析有效（node yaml parse exit 0）；③ 本地等价命令实证：四条 build 命令产出非空 + 守卫绿；④ 守卫 step 的调用命令与 ci.yml（u3）同源直调 |
| u3 CI PR 接线 | ci.yml invariants 段：3 包构建 + 守卫 step（同源直调，注释标注 D7 通则，参照 G4/D9-① 既有模式）；**同批**将新测试文件追加进「Test - scripts guards」step 显式文件清单（逐名列举非 glob，漏追加 = 永不运行） | `.github/workflows/ci.yml` | u1 | plain | ① invariants 段新增 step 位置正确（pnpm install 之后）且命令可直接本地复跑；② Test - scripts guards 清单含 `scripts/__tests__/check-publish-surface.test.mjs`；③ YAML 解析有效；④ 本地复跑 invariants 新增命令序列 exit 0 |

## 3 DAG 图

```mermaid
graph TD
  subgraph W1[Wave1]
    U5["u5 约束登记 C-proc-11<br/>领地: docs/constraints.json + constraints.md"]
  end
  subgraph W2[Wave2]
    U1["u1 守卫脚本 + 单测<br/>领地: scripts/check-publish-surface.mjs + scripts/__tests__/check-publish-surface.test.mjs"]
    U4["u4 尾部风险清偿<br/>领地: resources/plugins/statusline/package.json + .changeset/config.json"]
  end
  subgraph W3[Wave3]
    U2["u2 发布 workflow 接线<br/>领地: .github/workflows/release-npm.yml + release-npm-dev.yml"]
    U3["u3 CI PR 接线<br/>领地: .github/workflows/ci.yml"]
  end
  U5 -->|"仓库纪律：新增约束先登记再写代码（C-proc-11 条款先行）"| U1
  U5 -->|"u4 实施 C-proc-11 的 private:true 条款，登记先行"| U4
  U1 -->|"u2 守卫 step 引用 u1 脚本（文件须已存在）"| U2
  U1 -->|"u3 invariants 守卫命令 + 测试清单引用 u1 产出"| U3
```

说明：u2 与 u3 领地互斥（不同 workflow 文件）且都只依赖 u1，W3 并行；设计 §5 实施顺序 u5→u1→u3紧随→u2→u4 中 u4 排最后仅为叙述顺序，无技术依赖，DAG 化后提前进 W2 与 u1 并行（u4 是两个单行改动）。

## 4 测试策略

**增量（单元开发期，subagent 自跑）**：

- u1：`cd /Users/zhushanwen/Code/xyz-agent-workspace/dev-0.9.15 && pnpm exec vitest run scripts/__tests__/check-publish-surface.test.mjs`；守卫本体 `node scripts/check-publish-surface.mjs`（前置：四档构建 `pnpm --filter @xyz-agent/extension-protocol run build && pnpm --filter @xyz-agent/session-delivery run build && pnpm --filter @zhushanwen/subagent-core run build && pnpm --filter @zhushanwen/subagent-core run build:bundle`）
- u5：`node scripts/render-constraints.mjs` + `node scripts/check-doc-symbol-drift.mjs`
- u2/u3：YAML 解析验证（node + js-yaml 或 python3 -c yaml.safe_load）+ 本地复跑 workflow 内命令序列
- u4：S6b 两条断言命令 + JSON 解析

**全量（收尾阶段 5，主 agent 跑）**：

- scripts guards 测试全套（ci.yml「Test - scripts guards」清单口径，含新测试）：`pnpm exec vitest run scripts/__tests__/check-unsafe-stream-writes.test.mjs scripts/__tests__/check-core-dist-gate.test.mjs scripts/__tests__/gitcode-release-sync.test.mjs scripts/__tests__/check-publish-surface.test.mjs`
- `node scripts/check-doc-symbol-drift.mjs`
- 新脚本过项目 lint（`pnpm run lint` 若覆盖 scripts/，否则 `pnpm exec eslint scripts/check-publish-surface.mjs scripts/__tests__/check-publish-surface.test.mjs` 按仓库现状）
- render-constraints 幂等（重跑无 diff）

## 5 合理偏差登记表

初始为空。执行中发现的合理不一致在此登记（必要时同步设计文档措辞并记变更历史）。

| 日期 | 单元 | 偏差内容 | 处置 |
|------|------|----------|------|
| — | — | — | — |

## 6 状态表

| Unit | 状态(pending/in-progress/committed/blocked) | 轮次 | 证据指针 |
|------|--------------------------------------------|------|----------|
| u5 | pending | 0 | — |
| u1 | pending | 0 | — |
| u4 | pending | 0 | — |
| u2 | pending | 0 | — |
| u3 | pending | 0 | — |

## 7 残留风险与变更历史

**残留风险**：

1. S5（真实 CI run）需推送测试分支——push 属用户授权事项，执行到 u3 验收时向用户确认推送安排；未获授权则以「本地复跑 invariants 命令序列 + diff 审查」为替代证据并如实登记。
2. S6 的 workflow 生效面（真实 dev 预发布 run）延后到下次 dev 预发布，设计 §4 已如实登记此形态。
3. S7（发布后终验）不在本次实施范围，随 0.5.2 发布编排执行。
4. 工作区存在认知外改动（`docs/design/update-multi-source.md` 未 staged、`packages/renderer/src/__tests__/panel/command-popover-symbols-format-age.test.ts` 已 staged）——主 agent 全程不碰；commit 一律精确路径 + pathspec（`git commit -- <paths>`），防裹挟 staged 区。

**变更历史**：

| 日期 | 变更 |
|------|------|
| 2026-09-07 | 初版：按设计 §5 拆分 u1–u5 固化为 DAG（u4 从叙述末位提前进 W2 并行，理由见 §3 说明） |
