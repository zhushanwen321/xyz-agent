# cw store 归属与 workspace 解耦设计

> **一句话结论**：cw 的「store 归属」（任务元数据属于哪个 repo）和「workspace」（在哪个工作树跑 git/测试）是两个正交维度。当前的问题有两层：**概念上** cw-cli 用单一 `--workspace` 把它们耦合；**职责上** store 归一化被放在 cw-tool（调用层）而非 cw-cli（引擎层），导致 bash 与 cw-tool 两条路径结构性割裂。根治 = 把 store 归一化下沉到 cw-cli 内部（`getCwJsonPath` 用 `git-common-dir`），workspace 用 `show-toplevel`，cw-tool 退回纯封装。

> **层性质声明**（tech-design 准则 10）：
> - **当前层**：架构方案设计——为什么解耦、归一层怎么选、怎么根治
> - **下一层**：cw-cli + cw-tool 的接口/参数拆分 + 实现计划
> - **不跨层**：本文不写函数级实现（不逐行写 `getCwJsonPath` 改动），深度止于接口设计与拆分计划

---

## §1 背景目标

### SCQA 开篇

- **S（情境）**：cw（coding-workflow）是编码流程状态机，存储任务树（epic/feature/slice/wave）、方案文档、审查判断、开发 commit 等元数据。它本身不持有代码——代码在 git 里，cw 只记录「这个方案设计成什么样、开发了哪个 commit、测试过没」。
- **C（冲突）**：cw 的 store 归属（任务元数据存哪个文件）和 workspace（git/测试/文件操作在哪个目录跑）是两个正交问题，cw-cli 当前用单一 `--workspace` 把它们耦合；更糟的是，store 的 repo 级归一化被放在 cw-tool（pi extension 封装层）而非 cw-cli（引擎层），导致 bash 直接调 cw（per-cwd）和 cw-tool 调 cw（repo 级）走不同的 store，bare repo + worktree 模式下这个割裂让 cw-tool 全线失效。
- **Q（问题）**：**cw 这样一个「存储方案/设计/commit 元数据的工具」凭什么和 cwd/worktree 强耦合？bash 能用、cw_* 工具失效的割裂从哪来？怎么根治？**
- **A（答案）**：两层修复——概念上把 store 归属与 workspace 解耦（store 用 `git-common-dir`，workspace 用 `show-toplevel`）；职责上把 store 归一化从 cw-tool 下沉到 cw-cli 内部（`getCwJsonPath` 自己探测 common-dir），让 bash 和 cw-tool 走同一条归一化路径。cw-tool 退回纯封装，不再推导 workspace。

### cw 是什么——先建立基本认知

cw 是一个命令行工具（npm 包 `@zhushanwen/coding-workflow`），把编码任务拆成层级单元（epic → feature → slice → wave），用状态机驱动每个单元走 design → review → execute → test → retrospect → closeout 流程。它管理四类元数据：

| 数据 | 例子 | 本质属性 |
|---|---|---|
| **任务树** | `slice:provider-dual-system-r2` 下挂 5 个 `wave:*`（parentUnitId 外键） | 任务的结构关系，与文件位置无关 |
| **方案文档** | design 阶段产出的 plan（文件清单、测试命令、验收标准） | 任务的方案描述，与文件位置无关 |
| **审查判断** | designReviewJudgment（pass/fail + 问题清单） | 对方案的判断，与文件位置无关 |
| **开发证据** | execute 记录的 commitHash、test 结果 | commitHash 是 git 全局对象引用（repo 级共享），非文件路径 |

**关键认知**：这四类数据都是「某个任务的元数据」，它们的归属维度是**任务**（或任务所在的 repo），不是「你站在哪个目录操作它」。同一个任务的 design 文档，不管你从哪个 worktree 打开 cw 看，都应该是同一份。commitHash 更是跨 worktree 的——git object store 在 repo 级共享（见 §2.4 探针），任何 worktree 都能 `git cat-file` 同一个 commit。

cw-tool（npm 包 `@zhushanwen/pi-cw-tool`）是 cw-cli 的 pi extension 封装，把 `cw` 包成 4 个 role-restricted 工具（cw_planning / cw_wave / cw_dev / cw_review），供 pi 的递归编排 agent 调用。

### 设计目标

从使用者体验倒推（使用者 = 在 bare repo + worktree 模式下用 cw 的开发者 / 递归编排 agent）：

1. **G1 — bare repo worktree 下 cw_* 工具全线可用**：cw_planning/cw_wave/cw_dev/cw_review 在 bare repo worktree 里能正常 design/execute/review，不出现 unit not found 或 git/测试崩。
2. **G2 — bash 与 cw-tool 路径统一**：bash 直接调 cw 和 cw-tool 调 cw 访问同一个 store，不再「bash 能用、cw_* 失效」。
3. **G3 — 递归编排跨 worktree 任务树共享**：planning 层（父 worktree）design 出的 wave，wave-agent（子 worktree，`worktree:true` 派发）能 execute 到。
4. **G4 — 不破坏普通 repo**：普通 repo（单 worktree 或 `git worktree add` 的 linked worktree）行为一致。
5. **G5 — 职责归位**：store 归一化是 cw-cli 的内部决策，cw-tool 退回纯封装，不越俎代庖推导 workspace。

### In / Out scope

- **In**：cw-cli 的 store 归一化层选型、`--workspace` 语义解耦、cw-tool 的职责收敛、store 路径迁移、向后兼容
- **Out**：cw 的状态机逻辑、审查 gate 规则、guidance 生成——这些不涉及 workspace 耦合，不动

---

## §2 现状与问题分析

### §2.1 cw 的本质职责——位置无关的元数据存储

**cw 是任务的元数据存储，不是代码的执行环境。** 它的输入是方案 JSON / 审查判断 / commitHash，输出是状态推进 + 持久化。cw 自己不编译、不运行代码——它只在 execute/test 阶段**委托** git（校验 commit 存在）和测试命令（跑 vitest）。这种「委托」需要知道「在哪个目录跑」，但这与「任务元数据存在哪」是两回事。

### §2.2 当前实现——4 个关注点耦合在单一 `--workspace`

**cw-cli 的 `constructCwDeps(workspacePath)` 把 4 个本应独立的关注点绑在同一个值上。** 取证（`coding-workflow/src/cli.ts:645-700`，constructCwDeps）：

| 关注点 | 代码 | 用 workspacePath 做什么 | 正确归属 |
|---|---|---|---|
| **store 键控** | `new CwStore(workspacePath)` → `getCwJsonPath(workspacePath)`（schema.ts:130） | 决定任务树存哪个 `store.json` | **任务/repo 标识**（"这是哪个任务的元数据"） |
| **gitValidator** | `git cat-file -e <hash>^{commit}` cwd=`workspacePath`（cli.ts:655） | 校验 commitHash 真实存在 | **任意能访问该 git 对象的仓库**（git object 是 repo 级共享，见 §2.4 探针） |
| **testRunner** | 缺省 cwd=`workspacePath`，per-wave `testCwd` 相对它 resolve（cli.ts:668-670） | 跑测试子进程 | **被测代码所在的工作目录**（wave 写码的 worktree） |
| **fileExists** | `resolve(workspacePath, ref)`（cli.ts:696） | 检查 artifact 文件存在 | **代码工作目录** |

`getCwJsonPath` 的实现（schema.ts:130-132）证实 store 键控就是路径编码：

```ts
export function getCwJsonPath(cwd: string): string {
  return join(getCwHome(), encodeCwd(cwd), "store.json");
  // encodeCwd 把路径分隔符替换为 __，如 /repo → __repo
}
```

**这 4 个关注点的「正确归属」是 3 个不同的东西**：store 要的是任务/repo 标识，gitValidator 要的是任意 git 仓库，test/file 要的是被测代码目录。当前用一个 `workspacePath` 全覆盖。

### §2.3 耦合的历史合理性——单 cwd 时代的简化

**在「一个 cwd = 一个 repo = 一个工作树 = 一个任务」的原始场景下，4 关注点同路径，耦合无害。** cw 最初（v1.x）的设计假设就是开发者在一个 git repo 根目录跑 cw：cwd 既是 repo 根、又是主工作树、又是任务的工作目录。此时 `--workspace = cwd` 让 4 关注点都指向同一条路径，是合理的简化——少传一个参数，少一个出错点。

cw-cli 至今（v1.6.1）仍是这个模型：`workspacePath = parsed.workspace ?? process.cwd()`（cli.ts:1060），`getCwJsonPath` 按 cwd 编码 store 路径（schema.ts:130），**零 repo 级归一化**（grep 全 src 确认无 worktree/.bare/show-toplevel/git-common-dir 解析）。

### §2.4 三种演进逐个击穿「单 cwd」假设

**耦合在三种场景演进下逐个崩溃，且每一种都让前面的「修复」变成下一种的病灶。**

#### 演进 1：子目录调用（cwd ≠ repo 根）

开发者在 repo 内 `cd` 到子目录跑 cw。cwd = `/repo/packages/renderer`，但任务属于 `/repo`。store 键控到子目录级 → 换个子目录就丢任务树。

cw-cli 的应对：**没应对**。per-cwd 是 cw-cli 的设计，它接受这个分叉，靠 `cw list --all`（cross-cwd.ts 聚合 CW_HOME 下所有 store）+ RepoMeta（schema.ts:38，记录 worktreePath/remoteUrl/branch）做只读聚合显示。

#### 演进 2：递归编排 wave `worktree:true`（父子 cwd 不同）

cw 递归编排（pi-cw-tool）里，planning 层在父 worktree design 出 wave，然后用 pi-subagent 的 `worktree:true + fork:true` 把 wave-agent 派到独立 worktree 并行写码（取证：`pi-cw-tool/agents/wave-agent.md:33`、`skills/pi-cw/design-v4.md:99`）。wave-agent 在子 worktree 调 `cw execute --commitHash`，需要读到父 worktree design 出的 wave unit。

per-cwd 下，父 worktree 和 wave worktree 是两个 store 文件 → wave `unit not found` → **wave 层第一个 cw 调用即失败**。这就是 ADR-0045 记录的 MF-1 故障。

**ADR-0045 的修复**：cw-tool（调用层）探测 `git rev-parse --git-common-dir`，取 `dirname(commonDir)` 作 `--workspace` 传给 cw-cli，让同一 repo 的所有 worktree 共享一个 store。**对普通 repo 这个修复成立**——`dirname(.git)` = repo 根，既是 repo 标识又是主工作树。但这个修复把 store 归一化放在了 cw-tool，埋下了演进 3 + bash 割裂的种子。

#### 演进 3：bare repo + worktree（repo 标识 ≠ 工作树）—— 当前 bug

bare repo + worktree workspace 模式（如 `xyz-agent-workspace/.bare` + `main/`、`fix-xxx/` 等独立 worktree 目录）下，ADR-0045 的 `dirname(common-dir)` 崩溃。实测（当前 worktree `fix-cw-tool-wroktree`）：

```
git rev-parse --git-common-dir   →  /Users/.../xyz-agent-workspace/.bare
dirname(.bare)                   →  /Users/.../xyz-agent-workspace     ← workspace 容器，不是任何 worktree！
```

cw-tool 把这个 workspace 容器当 `--workspace` 传给 cw-cli → `constructCwDeps` 的 4 个关注点全走这个非 git 目录：

| 关注点 | 后果 |
|---|---|
| store 键控 | store 路径 = `~/.cw/__...__xyz-agent-workspace/store.json`（**空，不存在**）→ unit not found |
| gitValidator | `git cat-file` 在非 git 目录跑 → 校验失败 |
| testRunner | 测试在非 git 目录跑 → 跑错地方 |
| fileExists | 文件 resolve 基准是 workspace 容器 → 找不到代码文件 |

**这解释了为什么是「所有 cw_* 工具失效」而不只是「unit not found」**——`--workspace` 绑了 4 个 cwd，bare repo 下这 4 个全坏。

#### 演进的隐藏病灶：bash 与 cw-tool 割裂

**ADR-0045 把 store 归一化放在 cw-tool，导致 bash 和 cw-tool 走不同的 store，这个割裂在普通 repo 也存在，bare repo 只是先暴露。** 数据流：

```
bash 调 cw（不经过 cw-tool）
  → workspace = process.cwd()（per-cwd）
  → store = encodeCwd(cwd)                         ← per-cwd store

cw-tool 调 cw（经 detectRepoWorkspace）
  → workspace = dirname(git-common-dir)（repo 级）
  → store = encodeCwd(dirname(common-dir))         ← repo 级 store（不同文件！）
```

普通 repo 里若开发者只用 cw-tool 不用 bash，store 一直在 repo 根，不暴露；bare repo 里开发者大量用 bash 推进（cw-cli 线性模式）+ 想用 cw-tool（递归编排），两条路径同时用 → store 割裂暴露 → 「bash 能用、cw_* 失效」。

**这个割裂是结构性的**——只要 store 归一化在 cw-tool，bash（不经过 cw-tool）就永远是 per-cwd，两者必然分叉。

#### 探针：git object store 在 bare repo 所有 worktree 间共享（方案成立的物理前提）

> **P-object-store**：bare repo 的所有 worktree 共享同一个 git object store（`.bare/objects`），任意 worktree 能 `git cat-file` 其他 worktree 的 commit。
>
> 探针（当前 worktree，已跑通 ✅）：
> ```bash
> $ MAIN_COMMIT=$(git rev-parse main)   # main worktree 的 HEAD
> $ git cat-file -e "${MAIN_COMMIT}^{commit}" && echo OK   # 当前(fix-cw-tool)worktree 查 main 的 commit
> OK
> $ git --git-dir=$(git rev-parse --git-common-dir) cat-file -e "${MAIN_COMMIT}^{commit}" && echo OK  # bare repo 本身直接查
> OK
> ```
> **结论 ✅**：gitValidator 不需要特定 worktree——任意 worktree 甚至 bare repo 本身都能校验任意 commit。commitHash 作为「开发证据」是 repo 级共享的全局引用，与 worktree 无关。

### §2.5 物理数据流图——当前（割裂）vs 理想（统一）

**当前（割裂）**：store 归一化在 cw-tool，bash 与 cw-tool 走不同 store。

```
  bash 调 cw                          cw-tool 调 cw
  (不经过 cw-tool)                    detectRepoWorkspace: dirname(common-dir)
        │                                          │
  workspace = cwd                          --workspace <dirname(common-dir)>
        │                                          │
        ▼                                          ▼
  store = encodeCwd(cwd)                  store = encodeCwd(dirname(common-dir))
  (per-cwd)                               (repo 级，但 bare repo 下 dirname=容器→4关注点全坏)
        │                                          │
        └────────────── 两个不同的 store.json ──────────────────┘
                        ★ bash 能用、cw_* 失效的根源 ★
```

**理想（统一）**：store 归一化下沉到 cw-cli 内部，bash 与 cw-tool 走同一条路径。

```
  bash 调 cw                          cw-tool 调 cw
        │                                          │
        └────────── workspace ──────────────────────┘
                          │
                    cw-cli 内部（getCwJsonPath）
            store-key = git rev-parse --git-common-dir  (.bare/.git，所有 worktree 相同)
            workspace = git rev-parse --show-toplevel   (当前 worktree 根，有效工作树)
                          │
          ┌───────────────┴───────────────┐
          ▼                               ▼
     store 键控                    gitValidator / testRunner / fileExists
  getCwJsonPath(common-dir)         cwd = show-toplevel (当前 worktree)
          │                               │
  普通 repo: .git → 所有 worktree 同一 store    workspace=worktree根 → git/test 有效
  bare repo: .bare → 所有 worktree 同一 store   workspace=worktree根 → git/test 有效
          │
  ★ bash 和 cw-tool 走同一条 cw-cli 归一化，无割裂；bare/普通 repo 统一无特殊分支 ★
```

### §2.6 根因——概念混淆 + 职责错层

**根因有两层，缺一不可。**

**根因 1（概念混淆）：cw-cli 把「归属」和「执行位置」混为一谈。**

| 维度 | 问题 | 答案应该是 | 当前实现 |
|---|---|---|---|
| 归属 | store 存哪个文件？ | repo 级标识（任务属于哪个 repo） | cwd（执行位置） |
| 执行位置 | git/测试在哪跑？ | 被测代码的工作树 | cwd（执行位置） |

这两个问题是正交的，cw-cli 用单一 `--workspace` 回答两者，是单 cwd 时代的简化（§2.3）。

**根因 2（职责错层）：store 归一化被放在 cw-tool，本该是 cw-cli 的内部职责。**

store 怎么键控，是 cw-cli 自己的内部决策——cw-cli 最懂自己的 store 该按什么标识。但 ADR-0045 因为「cw-cli 还没改」，把 `detectRepoWorkspace` 放在 cw-tool（调用层）：cw-tool 探测 common-dir、取 dirname、当 `--workspace` 传给 cw-cli。这有两个后果：

1. **cw-tool 越俎代庖容易做错**：`dirname` 算法对 bare repo 失效（本次 bug）。如果归一化在 cw-cli 内部、cw-cli 完全控制，就不会有「调用方传错值」的问题。
2. **bash 与 cw-tool 结构性割裂**：bash 直接调 cw 不经过 cw-tool，没有 `detectRepoWorkspace`，走 per-cwd；cw-tool 走 repo 级。两条路径 store 键控基准不同——这正是 §2.4 隐藏病灶「bash 能用、cw_* 失效」的根源。**只要归一化在 cw-tool，这个割裂就结构性存在，无法消除。**

ADR-0045 自己也承认这是过渡：它把方案分两层——「本分支（调用层先行）cw-tool 附加 `--workspace`」+「v5 引擎（根治，用户侧）`getCwJsonPath` 键控基准改为 repo 级」。**v5 引擎根治从未落地**（cw-cli v1.6.1 仍是 per-cwd），cw-tool 的 `--workspace` 一直作为过渡单方面存在。长期根治 = 把 store 归一化收回到 cw-cli 内部，cw-tool 退回纯封装。

> **ADR-0045 的方向半对、实现错位**：它识别到「store 应 repo 级共享」（归属维度正确）、用 `git-common-dir` 做 repo 标识（标识选型正确），这两点本方案完全继承。它的错误是：① 多余的 `dirname`（common-dir 本身就是标识，dirname 只为凑「可工作目录」，bare repo 下反而到容器）；② 单一 `--workspace` 兼任 repo 标识 + 工作树两角色（bare repo 结构性不可能）；③ 把归一化放 cw-tool 而非 cw-cli（bash 割裂）。本方案修正这三点。

---

## §3 解决方案

### §3.1 终态——使用者视角

**改造后，bash 与 cw-tool 走同一条 cw-cli 内部归一化，bare repo worktree 下行为完全一致，递归编排跨 worktree 任务树共享。**

使用者（开发者 / 递归编排 agent）看到的：

```
[场景：bare repo worktree 内推进 provider 任务，已拆 5 wave]

# bash 线性模式
$ cw status --unitId slice:provider-dual-system-r2
  status: executing, 5 waves (wave1 designing, wave2-5 blocked)

# cw_* 工具（修复后，之前 unit not found）—— 与 bash 访问同一个 store
> cw_wave design --unitId wave::provider-kind-type
  ✅ status: designing（store 命中，git/test 在当前 worktree 有效）

[场景：递归编排，planning 在父 worktree，wave 派到子 worktree]

# planning-agent（父 worktree）
> cw_planning execute --unitId slice:...   # cw 自动建 5 个 wave unit，写入 repo 级 store
> subagent start wave-agent (worktree:true)  # 派 wave 到独立 worktree

# wave-agent（子 worktree）
> cw_wave design --unitId wave::...        # cw-cli 内部 common-dir 归一化 → 同一 store
  ✅ 命中父层建的 wave unit（之前 unit not found = MF-1）
> cw_dev execute --commitHash <sha>        # commitHash 校验：当前 worktree cat-file 成功（object store 共享）
  ✅ execute 成功
```

**失败路径 + 恢复指引**（准则 6）：

| 失败场景 | 现象 | 恢复 |
|---|---|---|
| 非 git 目录调 cw | common-dir 探测失败 | cw 降级 per-cwd（保持现状），提示「cwd 非 git 目录，store 按 cwd 隔离」 |
| store 路径迁移期（per-cwd → common-dir） | 找不到历史 unit | `cw migrate-store`（§4.3）合并旧 store；或 `cw list --all` 确认 unit 在哪个 store |
| wave commit 未进 object store | gitValidator 校验失败 | 错误文案指向「commit <sha> 不在当前 repo object store，确认 wave worktree 已 commit」 |

### §3.2 方案对比（准则 9，强制 ≥2）

#### 方案 A（推荐，根治）：store 归一化下沉到 cw-cli 内部

cw-cli 的 `getCwJsonPath` 内部自己探测 `git-common-dir` 做 store 键控（`detectRepoWorkspace` 逻辑从 cw-tool 下沉到 cw-cli）；workspace 改用 `show-toplevel`。cw-tool 删除 `detectRepoWorkspace`，退回纯封装。

**store-key 选型 = `git rev-parse --git-common-dir` 原值**（不加 dirname）：
- 普通 repo worktree-A/B：common-dir = `/repo/.git`（相同）
- bare repo worktree-A/B：common-dir = `/workspace/.bare`（相同）
- 父 worktree 与 wave worktree：相同 common-dir → 同一 store ✅

**workspace 选型 = `git rev-parse --show-toplevel`**（当前 worktree 根，有效工作树）。

| 维度 | 评价 |
|---|---|
| **长期架构合理性** | ✅ 最干净。store 归一化回归 cw-cli（职责归位，根因 2 解决）；bash 和 cw-tool 自动统一（走同一 cw-cli 归一化，割裂消失）；cw-tool 退回纯封装不再越俎代庖；bare/普通 repo 统一无特殊分支；git-common-dir 是 git 原生 repo 标识，最稳定 |
| **短期实现成本** | 中。cw-cli 改 `getCwJsonPath`（内部加 common-dir 探测）+ `constructCwDeps`（workspace 用 show-toplevel）；cw-tool 删 `detectRepoWorkspace`；**全局 store 迁移**（per-cwd → per-common-dir，影响所有 cw-cli 用户含纯 bash 用户） |
| **风险** | 中。改 cw-cli 默认 store 路径，影响所有用户，需健壮的迁移（自动 + 幂等 + 可回滚）+ 版本号 major 或显著 warning |

#### 方案 B（渐进过渡）：cw-cli 加 `--store-key` 参数，cw-tool 显式传

cw-cli 新增 `--store-key <path>`，cw-tool 探测 common-dir 传入；`--workspace` 退化为只管 git/test/file。bash 不传 `--store-key` 则 fallback per-cwd。

| 维度 | 评价 |
|---|---|
| **长期架构合理性** | ⚠️ 半解耦。store 归一化仍在调用方（cw-tool），**bash 与 cw-tool 割裂仍在**（bash per-cwd vs cw-tool repo 级，G2 不达成）；只修了 dirname bug + 解耦 store/workspace 概念（根因 1 解决，根因 2 未解决） |
| **短期实现成本** | 低-中。cw-cli 加参数 + cw-tool 改探测；迁移面小（只 cw-tool 用户的 store 路径变） |
| **风险** | 低。bash 行为不变，只 cw-tool 用户受影响 |

**若用方案 B，§3.1 的终态会变成什么样**：cw_* 工具能用了（store-key 修复），但 bash 和 cw-tool 仍访问不同 store——开发者在 bash 建的任务，cw-tool 看不到；反之亦然。G2（bash/cw-tool 统一）不达成，本次 bug 的「bash 能用、cw_* 失效」本质未根治，只是从「cw_* 全坏」降级为「bash 和 cw-tool 各看各的」。

#### 方案 C：完全 task-id 化（store 按任务，彻底摆脱位置）

cw store 不再按 cwd/repo 键控，而是按显式 task-id（`cw create` 时指定或从 `cw.config.json` 读）。`--workspace` 只管 git/test/file。

| 维度 | 评价 |
|---|---|
| **长期架构合理性** | ✅ 概念最干净——任务就是任务，与位置完全无关；最彻底地回答用户「cw 凭什么和位置耦合」的质疑 |
| **短期实现成本** | 高：需新设计 task-id 生成/管理/发现机制；现有 per-cwd store 全量迁移到 per-task-id；`cw list` / 跨任务查询语义全变；cw-cli + cw-tool + 所有调用方改造 |
| **风险** | 高：task-id 是全新概念，设计不当会引入新的归属混乱（两个 repo 同名 task 怎么办）；迁移面最大 |

**若用方案 C，§3.1 的终态会变成什么样**：每次 `cw create` 要显式起 task-id（如 `cw create slice --task-id provider-r2`），所有后续 cw 调用要带 task-id 或靠 cwd 反查 `cw.config.json`。使用者心智负担增加（要记 task-id），但换来了「同一个 task 在任何目录都能操作」的极致解耦。

#### 方案 D：cw-tool 侧 env 半解耦（不改 cw-cli 参数语义）

cw-tool 通过环境变量（如 `CW_STORE_DIR`）直接指定 store 目录，绕过 cw-cli 的 `getCwJsonPath(cwd)`。

| 维度 | 评价 |
|---|---|
| **长期架构合理性** | ⚠️ 最弱。store 目录能指定，但 bash 不经过 cw-tool 仍 per-cwd（割裂仍在）；env 是隐式传参，调试难追踪；概念没真正分离 |
| **短期实现成本** | 最低：cw-cli `getCwJsonPath` 加一个 env 分支；cw-tool 设 env |
| **风险** | 中：env 隐式，`cw --help` 不暴露，可发现性差 |

#### 推荐与理由

**推荐方案 A**。理由：

1. **职责归位（by construction，准则 8）**：store 归一化是 cw-cli 的内部决策，放 cw-cli 最自然，结构性消除「调用方传错值」类 bug（dirname bug 不可能再发生）和「bash/cw-tool 割裂」（两者走同一 cw-cli 路径）。不是 clever mechanism，是结构正确。
2. **bash/cw-tool 统一（G2）**：方案 B 的 `--store-key` 仍是调用方传参，bash 不传就 per-cwd，割裂结构性存在。只有 cw-cli 内部归一化才能让两条路径统一。
3. **直接实现 ADR-0045 的「v5 引擎根治」愿景**：ADR-0045 本就规划了 cw-cli `getCwJsonPath` 改 repo 级作为根治，cw-tool `--workspace` 是过渡。方案 A 是把这个根治落地。
4. **成本可控**：方案 C 的 task-id 是全新概念且迁移面最大；方案 B/D 不彻底。方案 A 在「彻底根治」和「实现成本」间取得最佳平衡——主要成本是全局 store 迁移，这是一次性的，且有成熟迁移模式（cw-cli 曾做 v1→v2 迁移）。

### §3.3 关键决策与权衡

**决策 1：store 归一化放 cw-cli 内部（`getCwJsonPath`），不放 cw-tool。**
- 选择：cw-cli 启动时 `detectCommonDir(workspacePath)` → `getCwJsonPath(commonDir)`
- 被否：cw-tool 探测后传 `--store-key`（方案 B）——bash 不经过 cw-tool 仍 per-cwd，割裂不消除
- 证据：§2.4 隐藏病灶 + §2.6 根因 2

**决策 2：store-key 用 `git-common-dir` 原值，不加 dirname。**
- 选择：`store-key = git rev-parse --git-common-dir`（`.git` / `.bare` 原值）
- 被否：`dirname(common-dir)`（ADR-0045 现状）——bare repo 下 dirname 到 workspace 容器，非标识也非工作树
- 证据：探针 P-object-store ✅（common-dir 是 repo 级共享路径，本身即标识）

**决策 3：workspace 用 `show-toplevel`（当前 worktree 根），不用裸 cwd。**
- 选择：`workspace = git rev-parse --show-toplevel`
- 被否：`process.cwd()`——agent 常在 worktree 子目录调 cw（如 `extensions/cw-tool/`），cwd ≠ worktree 根，git/test 漂移到子目录
- 证据：探针 P-toplevel ✅（见下）

> **P-toplevel**：`git rev-parse --show-toplevel` 从 worktree 根和子目录都稳定返回 worktree 根。
> 探针（已跑通 ✅）：
> ```bash
> $ git rev-parse --show-toplevel                                    # worktree 根
> /Users/.../xyz-agent-workspace/fix-cw-tool-wroktree
> $ git -C extensions/cw-tool rev-parse --show-toplevel              # 子目录
> /Users/.../xyz-agent-workspace/fix-cw-tool-wroktree   # 相同，稳定
> ```

**决策 4：gitValidator 用 workspace（worktree），不用 store-key（common-dir）。**
- 选择：gitValidator cwd = workspace（show-toplevel）
- 被否：用 common-dir 直接 cat-file——虽探针 ✅ 证明可行，但 worktree 是「正经 git 工作树」，cat-file / 后续 git 操作（diff/log）更自然；common-dir 在普通 repo 是 `.git` 内部目录，不宜当工作 cwd
- 权衡：workspace（worktree）服务 gitValidator + testRunner + fileExists 三个，store-key 只服务 store 键控——职责清晰

**决策 5：探测失败降级，不引入 clever 机制（准则 8）。**
- common-dir 探测失败（非 git 目录）→ store-key fallback workspacePath（per-cwd，现状行为）
- 不加「猜测 repo」「缓存 common-dir」「自动迁移」等机制——每个 clever 机制都是新的运行时断言（准则 7）。by construction：探测到就归一化，探测不到就降级，结构上不可能错。

**决策 6：store 迁移一次性、自动、幂等、可回滚。**
- per-cwd store（`encodeCwd(cwd)`）→ per-common-dir store（`encodeCwd(common-dir)`）
- cw-cli 启动时检测旧路径 store，合并到新路径（unit 按 id 去重），旧 store 归档（`.legacy` 后缀）不立即删
- ⛔ 迁移正确性是实施期门槛（见 §4.3 V-migrate）

---

## §4 下一层拆分

### §4.1 实施路径（3 步，可独立验证）

| 步骤 | 改动项目 | 内容 | 验证 |
|---|---|---|---|
| **S1** | coding-workflow（cw-cli） | ① `getCwJsonPath` 内部 `detectCommonDir` 归一化（common-dir 优先，fallback workspace）；② `constructCwDeps` 解耦（store 用归一化值，git/test/file 用 workspace）；③ workspace 解析从 `process.cwd()` 改 `show-toplevel`（或保留 cwd 但 constructCwDeps 内 show-toplevel）；④ 探测失败降级 | 单测：common-dir 归一化、4 关注点分别用对的值、降级路径 |
| **S2** | cw-tool（pi extension） | 删除 `detectRepoWorkspace` + 相关 `--workspace` 透传逻辑；cw-tool 退回纯封装（只透传 action/unitId/input，workspace 由 cw-cli 自己探测） | 单测：cw-tool 不再传 --workspace，cw-cli 内部归一化生效 |
| **S3** | coding-workflow（cw-cli） | store 迁移：per-cwd → per-common-dir，自动 + 幂等 + 旧 store 归档 | 集成测：迁移前后 unit 可见性、幂等、回滚 |

### §4.2 文件改动地图

**coding-workflow（`~/Code/coding-workflow-workspace/main`）**：
- `src/store/schema.ts` — `getCwJsonPath` 内部增加 common-dir 归一化（或新增 `getCwJsonPathByRepo(workspacePath)` 先探测 common-dir 再编码）
- `src/cli.ts` — `constructCwDeps` 解耦（store 用归一化 common-dir，git/test/file 用 workspace）；workspace 解析加 `show-toplevel`；新增 `detectCommonDir` + `detectWorktreeRoot` 辅助函数
- `src/store/cw-store.ts` — `CwStore` 构造配合归一化后的 dbPath
- `tests/` — 新增 common-dir 归一化测试（bare repo `.bare` + 普通 repo `.git` + linked worktree + 非 git 目录）+ migrate 测试

**cw-tool（`extensions/cw-tool/`）**：
- `src/cw-runner.ts` — 删除 `detectRepoWorkspace` 函数；`executeCwAction` 移除 workspace 探测 + `--workspace` 透传；`buildCwArgs` 移除 workspace 参数
- `src/__tests__/detect-repo-workspace.test.ts` — 删除（逻辑已下沉 cw-cli，cw-tool 不再探测）；cw-tool 侧测试改为「不传 --workspace」契约
- `src/index.ts` — 工具 execute 不再传 workspace 相关

**ADR-0045**（`docs/architecture/adr/0045-cw-store-repo-level-keying.md`）：
- 状态 Accepted → Superseded by 本设计
- 决策章节：「cw-tool 附加 --workspace」→「cw-cli 内部 getCwJsonPath 归一化」

### §4.3 待验证检查点（实施期门槛 ⛔）

| ID | 待验证 | 验证方式 | 阶段 |
|---|---|---|---|
| V-normalize | cw-cli common-dir 归一化在 bare/普通 repo 都返回稳定 repo 标识 | 构造 bare repo + 普通 repo + linked worktree，对比 getCwJsonPath 输出 | S1 前 |
| V-workspace | workspace 用 show-toplevel 后，子目录调用 git/test 不漂移 | 在 worktree 子目录跑 cw execute，确认 gitValidator/testRunner cwd = worktree 根 | S1 |
| V-migrate | per-cwd → per-common-dir 迁移正确性（unit 不丢不重、幂等、可回滚） | 构造含 unit 的旧 store，跑迁移，断言新 store 含全部 unit + 旧 store 归档 + 重跑幂等 | S3 |
| V-bash-unified | bash 调 cw 与 cw-tool 调 cw 访问同一 store（G2 达成） | bash `cw create` + cw-tool `cw status`，确认命中同一 store 的 unit | S2 后 |
| V-bare-e2e | bare repo worktree 端到端：cw-tool 全 4 工具 + 递归编排 wave 跨 worktree | xyz-agent-workspace 两 worktree 实跑 cw_planning create + cw_wave design（子 worktree） | S2 后 |

---

## 探针清单（运行时断言验证，准则 7）

| ID | 验证的行为 | 探针 | 状态 |
|---|---|---|---|
| P-object-store | bare repo 所有 worktree 共享 git object store，任意 worktree 能 cat-file 其他 worktree commit | 当前 worktree `git cat-file -e main^{commit}` + bare repo 直接 cat-file | ✅ 已测（§2.4） |
| P-toplevel | `show-toplevel` 从 worktree 根和子目录都稳定返回 worktree 根 | worktree 根 vs `git -C extensions/cw-tool` 输出对比 | ✅ 已测（§3.3 决策3） |
| P-common-dir-shared | 同一 repo 所有 worktree 的 git-common-dir 相同（store-key 统一性） | 父 worktree + wave worktree 的 `git rev-parse --git-common-dir` 对比 | ✅ 已测（当前 worktree = `.bare`，与 main worktree 同） |
| P-no-dirname | git-common-dir 原值作 store-key 不需要 dirname | dirname 仅普通 repo 凑巧=repo根，bare repo dirname=容器（反证 dirname 有害） | ✅ 已推理（§2.6） |
| V-normalize | cw-cli 内部归一化 bare/普通 repo 稳定 | 见 §4.3 | ⛔ S1 前 |
| V-bash-unified | bash 与 cw-tool store 统一 | 见 §4.3 | ⛔ S2 后 |
| V-bare-e2e | bare repo 端到端 cw_* 工具 + 递归编排 | 见 §4.3 | ⛔ S2 后 |

---

## 附录：ADR-0045 修订建议

本方案实施后，ADR-0045（`docs/architecture/adr/0045-cw-store-repo-level-keying.md`）需修订：

1. **状态**：Accepted → Superseded by 本设计
2. **决策章节**：从「cw-tool（调用层）附加 `--workspace <dirname(commonDir)>`」改为「cw-cli（引擎层）`getCwJsonPath` 内部用 common-dir 归一化」——这正是 ADR-0045 自己规划的「v5 引擎根治」，本方案将其落地
3. **边界章节 bare repo 条目**：保留「bare repo 所有 worktree 共享 store」的意图，修正实现——common-dir 原值（非 dirname）做 store-key，workspace 用 show-toplevel
4. **被否决方案表**：新增「`--store-key` 参数（方案 B）」条目，否决理由「bash/cw-tool 割裂不消除」

ADR-0045 的核心洞察（store 应 repo 级共享、用 common-dir 做标识）完全成立并被本方案继承——本方案修正的是其实现错误（多余 dirname + 单一 --workspace 兼任两角色 + 归一化放错层），不是推翻其方向。
