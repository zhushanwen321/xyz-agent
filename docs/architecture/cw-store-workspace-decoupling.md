# cw-tool 侧 store/workspace 解耦协调需求（差异文档）

> **[HISTORICAL] cw 2.0 已废止本文描述的协调面**：cw 2.0（2026-08-20）完全重写 store 布局为 `~/.cw/<encoded-cwd>/`（per-cwd、无 `--workspace` 参数），cw-tool 侧的 `detectRepoWorkspace` / 版本门控 / `--workspace` 透传代码已随 Phase 2-B 适配删除（见 `docs/todo/pi-cw-cw2-adaptation.md`）。本文仅作 1.x 时代的决策追溯保留。

> **定位**：本文是 xyz-agent 侧（`@zhushanwen/pi-cw-tool`，cw-cli 的 pi extension 封装层）对「cw store 归属与 workspace 解耦」问题的**差异补充**。**引擎层完整设计 SSOT** 在 coding-workflow 仓库：`fix-cw-cwd-worktree/docs/cw-store-workspace-decoupling.md`（commit `aa4949b`，含自身对抗审查）。本文不重述引擎层决策，只记录 xyz-agent 侧独有的：cw-tool 协调改动、版本门控契约、本仓实测数据、ADR-0061 修订、反哺引擎层的两条。
>
> **一句话结论**：cw-tool 退回纯封装——删除 `detectRepoWorkspace`（`cw-runner.ts:96-160`）与 `--workspace` 透传逻辑（含只读守卫 `:225`）；加运行时版本门控（cw-tool 经 PATH 裸调 `cw`、`package.json` 零 dependencies，npm peerDep 管不到全局 cw 版本，错配组合会割裂回归）；配套将 ADR-0061 标记 Superseded。引擎层落地 store 归一化 + 迁移后，cw-tool 这两组改动即可。

---

## §1 为什么 xyz-agent 侧需要本文

cw-tool 把 cw-cli 包成 4 个 role-restricted 工具（`cw_planning` / `cw_wave` / `cw_dev` / `cw_review`）供递归编排 agent 调用。它在两点上与引擎层解耦方案耦合，这两点是 xyz-agent 侧独有、引擎层文档只列「协调需求」而具体实现落在本仓：

1. **`detectRepoWorkspace` + `--workspace` 透传**（ADR-0061 实现）：cw-tool 当前探测 `git-common-dir` 取 `dirname` 后传 `--workspace`。bare repo 下 `dirname(.bare)` = workspace 容器（非任何 worktree），是当前 bug 的所在。引擎层方案 A 要求归一化下沉 cw-cli，cw-tool 退回纯封装（不再探测、不传 `--workspace`）。
2. **PATH 裸调 cw + 零依赖声明**：`cw-spawn.ts:50` `spawn("cw", args)`，`package.json` 的 `dependencies: {}`、`peerDependencies` 仅声明 pi（`@earendil-works/pi-coding-agent` / `pi-ai` / `typebox`），**完全没声明对 `@zhushanwen/coding-workflow` 的依赖**。npm peerDep 机制管不到用户全局安装的 cw 版本，cw-tool 与 cw-cli 的版本协调只能靠运行时门控。

---

## §2 引擎层 SSOT（引用，不重述）

完整方案见 coding-workflow `fix-cw-cwd-worktree/docs/cw-store-workspace-decoupling.md`。cw-tool 侧需知的核心结论（详见引擎层对应章节）：

| 引擎层决策 | 结论 | cw-tool 影响 |
|---|---|---|
| 决策1 归一化下沉 cw-cli | `getCwJsonPath` 内部用 common-dir | cw-tool 不再需要探测/传 workspace |
| 决策2 store-key | `--path-format=absolute --git-common-dir` 绝对路径原值 | cw-tool 不再涉及 |
| 决策3 workspace | `show-toplevel` | cw-tool 不再涉及 |
| 决策4 testCwd | **相对仓库根，禁止绝对路径** | cw-tool 不涉及 |
| 决策7 迁移冲突 | **同 id 冲突即停、人工裁决**（不自动仲裁） | cw-tool 不涉及 |
| 决策8 `--workspace` 后向语义 | S1 后 = probe 基准 + 执行位置基准，非 store-key | cw-tool S2 后不传，cw-cli 自探测 |

> **方向性错误订正（本仓旧版 → 引擎层）**：本仓文档上一轮曾据一次对抗审查写入两处方向性错误——① testCwd 契约改「必须绝对路径」（与 repo 级共享 store 结构性矛盾：绝对路径烧入 worktree，跨 worktree 读到路径不存在）；② 迁移同 id 冲突「按 statusHistory 时间戳取最新」（cw-cli `status.ts` 状态机非单调——`aborted` 任意状态可达、`replan` 是 `from=to` 不改 status 但改 plan——时间戳压平丢语义，且「压平后再人工确认」自相矛盾）。二次审查（对照引擎层 SSOT + 引擎源码实测）推翻这两处，统一以引擎层决策 4/7 为准。详见附录「审查记录」。

---

## §3 cw-tool 侧改动清单（引擎层 S2）

对应引擎层 §4.1 S2。改 `extensions/cw-tool/`：

| 改动 | 文件:行 | 内容 |
|---|---|---|
| 删除 `detectRepoWorkspace` | `src/cw-runner.ts:96-160` | 删除整个函数（探测 common-dir + dirname + fallback 容器） |
| 删除 `--workspace` 透传 | `src/cw-runner.ts:225` 及调用处 | `executeCwAction` 移除 workspace 探测；`const workspace = isReadonlyAction(action) ? undefined : detectRepoWorkspace(cwd)` 整行删除（cw-tool 不再区分只读/读写，cw-cli 内部统一归一化） |
| 改测试 | `src/__tests__/detect-repo-workspace.test.ts` | detect-repo-workspace 相关测试删除或改为「cw-tool 不传 `--workspace`」契约 |

**验证**：cw-tool 不传 `--workspace`，cw-cli 内部归一化生效——由引擎层 V-bash-unified（bash 与 cw-tool 同一 store）+ V-bare-e2e（bare repo 两 worktree 实跑）覆盖，cw-tool 侧只需确认 spawn 的 args 不含 `--workspace`。

---

## §4 版本门控契约（xyz-agent 独有，审查 MF-E）

**问题**：cw-tool 与 cw-cli 是两个独立 npm 包，且比引擎层假设的「两包」更脱钩——cw-tool 经 PATH 裸调 `cw`（`cw-spawn.ts:50`）、`package.json` 零 dependencies、peerDep 不含 coding-workflow。npm peerDep 管不到用户全局安装的 cw 版本。两包独立升级产生错配：

| 错配组合 | 后果 |
|---|---|
| 旧 cw-tool（传 `dirname(容器)`）+ 新 cw-cli（S1 归一化） | cw-cli 在容器 probe common-dir 失败→fallback 容器 per-cwd→cw-tool 与现状一样坏 |
| 新 cw-tool（S2 不传 `--workspace`）+ 旧 cw-cli（无 S1） | cw-cli 用 `process.cwd()` per-cwd→**回退 bash/cw-tool 割裂（G2 倒退）** |

**门控机制（唯一可行路径）**：cw-tool 运行时探测 cw-cli 归一化能力，不满足则保留旧 `--workspace` 行为兜底 + stderr 引导升级 cw：
- 探测方式：`cw version` 输出 ≥ 含 S1 的版本号；或特性检测（cw 对探针 flag/命令的响应）
- 兜底语义：探测失败时 cw-tool 退回 ADR-0061 行为（传 `--workspace`），并 stderr 提示「检测到 cw-cli 版本不支持 store 自动归一化；请升级 cw-cli（`@zhushanwen/coding-workflow`）以启用 bare repo worktree 支持」

> 注：引擎层 §4.1 建议「peerDep 或运行时门控二选一」。本仓实测表明 peerDep 不可行（cw-tool 根本没声明对 cw-cli 的依赖、走 PATH 裸调），**只能运行时门控**——这是 xyz-agent 侧对引擎层建议的细化。

---

## §5 xyz-agent 实测数据（现状证据）

`~/.cw` 实测（本机）：

| 类别 | 数量 | 说明 |
|---|---|---|
| xyz-agent bare repo worktree 级 store | 5 | 各 worktree 一个（bash 在 worktree 内跑 cw 建的） |
| xyz-agent 容器级「store」 | 1（空目录） | `__...__xyz-agent-workspace/`——CwStore 构造 `mkdirSync` 副作用，`store.json` 从未写入，0 unit（ADR-0061 dirname bug 产物） |
| 对应 worktree **已删**的 store | ≈50% | `feat-optimize-subagent-workflow-load`(13 units)、`fix-workflow-input-agent-md`(7)、`fix-workflow-subagent-thinking-level`(3) 等无法 probe git |

**对引擎层的佐证价值**：
- 「容器级空目录」证明 ADR-0061 dirname bug 从未成功写入任务（`store.json` 不存在），不是「空 store」而是「无 store」
- 「50% worktree 已删」是引擎层决策 7② 归属硬问题（已删 worktree 无法 probe git）的现实佐证——归属不能靠 probe，须 remoteUrl fallback + 人工认领

---

## §6 ADR-0061 修订

ADR-0061（`docs/adr/0061-cw-store-repo-level-keying.md`）状态改为 **Superseded by 引擎层方案 A**：

- **继承成立的核心洞察**：store 应 repo 级共享（所有 worktree 一份）、用 `git-common-dir` 做 repo 标识
- **修正的实现错误**：① 多余的 `dirname`（common-dir 本身即标识，dirname 在 bare repo 到容器、在 separate-git-dir 到非 repo 根）；② 单一 `--workspace` 兼任 repo 标识 + 工作树两角色（bare repo 结构性不可能）；③ 归一化放 cw-tool 调用层而非 cw-cli 引擎层（导致 bash/cw-tool 割裂无法消除）

---

## §7 反哺引擎层的两条

xyz-agent 侧审查中发现、引擎层文档未覆盖、值得引擎层吸收：

1. **存量相对 testCwd 的迁移 rebase**：引擎层决策 4 收紧 testCwd 为「相对仓库根」后，历史按旧契约（相对 `workspacePath`=旧 cwd）存入的相对 testCwd，迁移期需按旧 cwd 基准 rebase 到相对仓库根。例：旧 cwd=`packages/auth`、testCwd=`./`→迁移后相对根=`packages/auth`。引擎层文档只定义新契约，未覆盖存量数据的 rebase 处理。
2. **statusHistory 前缀冲突判据**：引擎层决策 7「同 id 同状态自动去重」可细化为「statusHistory 一致、或一方为另一方前缀→去重/取长者；分叉→即停」，覆盖「同 status 但单边 replan（plan 不同）」的死角（cw-cli `status.ts:54-56` replan 是 `from=to` 不改 status 但改 plan）。

---

## §8 待验证（xyz-agent 侧）

| ID | 待验证 | 验证方式 | 阶段 |
|---|---|---|---|
| V-cwtool-no-workspace | cw-tool 改造后 spawn 的 args 不含 `--workspace` | 单测：mock spawner 捕获 args，断言无 `--workspace` flag | S2 |
| V-version-gate | 版本门控：旧 cw-cli 时 cw-tool 保留 `--workspace` 兜底 + stderr 引导 | mock `cw version` 返回旧版本，断言 cw-tool 传 `--workspace` + stderr 含升级提示 | S2 |
| V-bare-e2e | bare repo 两 worktree 端到端 | xyz-agent-workspace 两 worktree 实跑 `cw_planning create` + `cw_wave design`（引擎层 V-bare-e2e 覆盖，本仓确认 cw-tool 4 工具均通） | S2 后 |

---

## 附录：审查记录与文档演进

- **v1**（commit `764e02d94`）：首版设计，从 cw-tool 视角平行重述方案 A
- **v2**（commit `e207eb57e`）：据首轮对抗审查修订 MF-1（absolute 约束）+ MF-2（testCwd 改绝对路径）+ MF-3（按时间戳仲裁）——**其中 MF-2/MF-3 是方向性错误**（首轮审查缺引擎层参照，局部合理但全局矛盾）
- **v3**（本次，收敛为差异文档）：据二次审查（对照引擎层 SSOT + 引擎源码实测）推翻 MF-2/MF-3、收敛为差异文档、停止平行重述引擎层方案。二次审查 8 条 must-fix 处置：MF-A/B（方向性订正，并入 §2 订正说明）+ MF-C/D（归属/并发互斥，引擎层决策 7 已覆盖，引用）+ MF-E（版本门控，§4 详述）+ MF-F（「成熟迁移模式」事实错误，已随收敛删除该论据）+ MF-G（G4 目标失实，引擎层 G4 已修正表述）+ MF-H（`--workspace` 后向语义，引擎层决策 8 已定义）
