# 修复 cw-tool 在 bare repo + worktree 下的 workspace-key 分叉 bug

> **一句话结论**：cw-tool 的一个过时版本门控（placeholder `99.0.0`）让它在所有 cw-cli 版本上都画蛇添足地给写动作传 `--workspace`，而兜底函数在 bare repo worktree 下返回的路径会让 cw-cli 定位到一个**不存在的 store**——激活门控阈值即可根因修复，再加固兜底函数防止盲区复发。

## 层声明

- **当前层**：技术方案设计
- **下一层**：可实现的代码改动（cw-tool）+ 测试任务
- **不跨层**：本文不设计 cw-cli 内部（cw-cli 已正确），也不设计 pi-cw 编排流程（那是 bug 的下游受害者，修了 bug 自然恢复）

---

## 1. 背景目标

**SCQA**

- **S（情境）**：`@zhushanwen/pi-cw-tool`（下称 cw-tool）是 cw CLI 的工具封装，给 pi agent 提供 `cw_planning`/`cw_wave`/`cw_dev`/`cw_review` 四个工具，让 agent 能经工具层驱动 cw 编码流程（design/execute/review 等）。cw CLI（`@zhushanwen/coding-workflow`）自身负责状态机持久化（store）。
- **C（冲突）**：在 bare repo + worktree 项目（如 `xyz-agent-workspace`，`.bare` + 每分支一个 worktree）里，cw-* 工具的**写动作**（design/execute/replan/closeout/design-review/exec-review）全部报 `错误：unit not found: <id>`，而**读动作**（status/handoff/list/tree/frontier）正常——读写定位到不同的 store。
- **Q（问题）**：怎么让 cw-* 工具的写动作在 bare repo worktree 下也能定位到正确的 store？
- **A（答案）**：激活 cw-tool 过时的版本门控（cw-cli 早在 v1.6.2 就内置了 store-key 归一化），让 cw-tool 对现代 cw-cli 退回纯封装、不再传 `--workspace`；同时加固兜底函数，使老 cw-cli 路径在 bare repo 下也不再传错值。

**系统是什么**（给不熟 cw 的读者）

cw 是一套编码流程状态机：agent 用它把大任务拆成 epic→feature→slice→wave 树，逐层 design→审查→execute→合并。所有 unit（树节点）的状态持久化在一个 **store** 里。cw-tool 把 cw 的 CLI 动作包装成 pi 工具，agent 调 `cw_planning design-review` 等于 `cw design-review ...`。

两个易混的目录，必须分清（准则 4，术语锚定）：

| 术语 | 是什么 | 物理位置 |
|---|---|---|
| **`.cw/` 目录** | agent 写的**中间产物**（design.json / design-review.json 等 input 文件） | worktree 内（如 `feat-context-compact/.cw/`） |
| **store** | cw 的**状态机持久化**（所有 unit 的真实状态） | 全局：`~/.cw/<encoded-key>/store.json` |

**本次 bug 与 `.cw/` 目录无关，与 store 定位有关。** 单元找不到 = store 访问错了，不是中间产物文件丢了。

**两代 cw-cli 的 store 机制（理解方案的前提，准则 4）**

| 版本 | store-key 怎么算 | 是否归一化 |
|---|---|---|
| **老 cw-cli**（< v1.6.2，a90e8e8 之前） | `encodeCwd(workspacePath)`，`workspacePath = --workspace ?? process.cwd()` | ❌ 纯 per-cwd，**无归一化**——store-key 就是传入的路径本身 |
| **新 cw-cli**（≥ v1.6.2） | `encodeCwd(detectCommonDir(cwd))`，detectCommonDir 用 `git rev-parse --git-common-dir` | ✅ 归一化——同一 repo 的所有 worktree 探测出相同 common-dir，共享 store |

这个区别是方案 B 论证的关键（见 §3.1 失败路径、决策 2）。

**设计目标**（从使用者体验倒推）

1. **G1（核心）**：agent 在 bare repo worktree 调任意 cw-* 写动作（如 `cw_review design-review`），能正常推进状态机，不再 `unit not found`。
2. **G2（一致性）**：同一 worktree 的读写动作定位到**同一个 store**（状态可互相看见）。
3. **G3（不回归）**：普通 repo（`.git` 模式）和普通单仓库的 cw-* 调用行为不变。
4. **G4（防复发）**：有针对 bare repo + `.bare` 场景的测试，防止「门控被改回」或「兜底函数再写错」。

**Scope**

- **in-scope**：cw-tool 的 `cw-runner.ts`（门控阈值 + `detectRepoWorkspace` 兜底）+ 对应测试。
- **out-of-scope**：cw-cli 源码（已正确）；cw-tool 的 `cw-spawn.ts`（与 bug 无关）；pi-cw skill / planning-agent 模板（是 bug 的下游受害者，bug 修复后另行清理其「降级 general-purpose」措辞）。

---

## 2. 现状与问题分析

### 2.1 使用者视角的现状（真实错误）

agent 在 `feat-context-compact` worktree 里调 cw-* 工具，看到的真实行为（✅ 探针实测，2026-08-11）：

```
# 读动作（cw status 经 cw-tool，或 bash 直接 cw）→ 正常
$ cw status --unitId epic:infinite-context-m1m4
{ "id": "epic:infinite-context-m1m4", "scope": "epic", "slug": "...", ... }   # ✅ 有数据

# 写动作（cw-tool 给写动作附加 --workspace）→ unit not found
$ cw status --unitId epic:infinite-context-m1m4 --workspace /Users/.../xyz-agent-workspace
错误：unit not found: epic:infinite-context-m1m4                              # ❌ store 不存在
```

> 注：上面第二条用 `cw status` 复现——`status` 本是只读，但**手动加上 cw-tool 会给写动作附加的那个 `--workspace` 值**，就精确复现了写动作的错误。这证明 bug 与「写动作的逻辑」无关，纯粹是 `--workspace` 那个值错了。

**真实失败模式**：因为这个读写分叉，pi-cw 编排里的 planning-agent 发现「cw-* 工具写动作全废」，于是放弃整个 cw-tool 工具层 + agent 层，退化为「general-purpose + bash 裸调 cw」，进而导致递归 subagent 中途失活、需人工续派（详见 pi session a28270 的分析，本文不展开）。

### 2.2 机制现状：cw-tool 的 workspace 门控

`cw-tool/src/cw-runner.ts` 的 `executeCwAction` 对读写动作做了**差异化处理**：

```ts
// 只读 action：不传 --workspace（cw 用 process.cwd()）
if (isReadonlyAction(action)) {
  workspace = undefined;
} else {
  // 写 action：探测 cw-cli 版本，< 阈值 → 传 --workspace
  const capability = await probeCwCliNormalization(spawner, cwd, signal);
  workspace = capability.supported ? undefined : detectRepoWorkspace(cwd);
}
```

两个关键点：

**① 门控阈值是 placeholder**（`cw-runner.ts:124`）：

```ts
const MIN_CW_CLI_VERSION_FOR_NORMALIZATION = "99.0.0";
// TODO(S1): 当前 placeholder "99.0.0" 使门控永远判定为「不支持」→ 永远走兜底
```

`99.0.0` 让门控**永远判定 cw-cli 不支持归一化** → 所有写动作永远走兜底 → 永远传 `--workspace`。

**② 兜底函数 `detectRepoWorkspace` 在 bare repo 下返回错值**：

```ts
// detectRepoWorkspace = dirname(git rev-parse --git-common-dir)
// 普通 repo：dirname(<repo>/.git) = <repo>          ✅ repo 根
// bare repo：dirname(<ws>/.bare)   = <ws>            ❌ workspace 容器根（非 git 目录！）
```

### 2.3 机制现状：cw-cli 的 store 定位（新 cw-cli ≥1.6.2）

cw-cli（v1.6.2）的 store 路径由 `getCwJsonPath` 决定（`cw-cli/src/store/schema.ts`）：

```ts
function getCwJsonPath(cwd) {
  const storeKey = detectCommonDir(cwd);           // 归一化到 git-common-dir
  return join(getCwHome(), encodeCwd(storeKey), "store.json");  // ~/.cw/<encoded>/store.json
}
```

`detectCommonDir` 用 `git rev-parse --git-common-dir` 归一化：同一 repo 的所有 worktree（含 bare repo worktree）探测出相同 common-dir → 共享同一 store。**归一化是 commit `a90e8e8`（`feat(store): normalize store-key to git-common-dir, decouple workspace`）引入的，属于首个 tag `v1.6.2`**（✅ 探针：`git tag --contains a90e8e8` → v1.6.2；`git show a90e8e8~1:src/store/schema.ts` 的 getCwJsonPath 还是 `encodeCwd(cwd)` 纯 per-cwd 无归一化）。

**归一化不依赖 cwd 是 repo 根**——git 的 `--git-common-dir` 在 repo 任意子目录都会向上查找并返回同一 common-dir（✅ 探针：在 `feat-context-compact/extensions/infinite-context` 子目录跑，仍返回 `.bare`）。这意味着**新 cw-cli 自己能处理「cwd 是子目录」的情况，不需要外部用 `--workspace` 告诉它 repo 根在哪**。

> ⚠️ 此能力仅新 cw-cli（≥1.6.2）有。老 cw-cli（a90e8e8 之前）store-key = `encodeCwd(workspacePath)`，**完全依赖外部传入的 workspacePath，没有自我归一化**（见 §1 两代机制表）。

### 2.4 物理数据流：读写为什么分叉（准则 5）

```
                        ┌─── 读动作（cw-tool 不传 --workspace）──────────────┐
agent cwd =             │  cw 用 process.cwd() = worktree                    │
feat-context-compact    │  → detectCommonDir(worktree) → git-common-dir=.bare│
(worktree)              │  → storeKey = "...xyz-agent-workspace__.bare"       │
                        │  → ~/.cw/...__.bare/store.json  ✅ 有 epic(60 units)│
                        └────────────────────────────────────────────────────┘

                        ┌─── 写动作（cw-tool 传 --workspace=容器根）─────────┐
                        │  cw 用 --workspace = xyz-agent-workspace（容器根）  │
                        │  → detectCommonDir(容器根) → 非 git，exit 128       │
                        │  → fallback 到容器根本身作 storeKey                 │
                        │  → storeKey = "...xyz-agent-workspace"              │
                        │  → ~/.cw/...xyz-agent-workspace/（空目录，无        │
                        │    store.json——写动作 unit not found 非零退出，    │
                        │    cw 从未成功落盘，只留空目录壳）❌                │
                        └────────────────────────────────────────────────────┘
```

两个 storeKey 不同 → 落到不同位置。✅ 探针实测 `~/.cw/`：`...__.bare/store.json` 含 epic（60 units）；`...xyz-agent-workspace/` 是**空目录**（写动作 `unit not found` 非零退出，cw 从未创建 store.json，只留空目录壳）。写动作在这个不存在的 store 里找 unit → `unit not found`。

> 现场还有多个归一化前的遗留 per-cwd store（每个 worktree 一个，如 `...feat-context-compact/store.json` 含 8 units），是历史包袱，与本 bug 无关。cw-cli 1.6.2 有 `warnDeprecatedStore` 机制对它们打 deprecation 警告。epic:infinite-context-m1m4 位于归一化后的 `.bare` store（60 units），验收以此为准（见 §4 场景 1）。

### 2.5 根因三层

| 层 | 问题 | 证据 |
|---|---|---|
| **根因** | 门控阈值是 placeholder `99.0.0`，永远判定 cw-cli 不支持归一化 | `cw-runner.ts:124` + TODO(S1) 注释自述 |
| **致命放大** | 兜底 `detectRepoWorkspace` 在 bare repo 返回容器根（dirname(.bare)），cw 对非 git 目录 fallback 出错 storeKey | §2.4 数据流 + `~/.cw/` 空目录实测 |
| **漏网** | 测试盲区：`detect-repo-workspace.test.ts` 只测普通 repo + `git worktree add` 的 linked worktree，没测 bare repo `.bare` 模式；`workspace-gate.test.ts:118` 把 placeholder 当预期（用例名写「当前 placeholder 99.0.0」） | ✅ grep 测试文件确认 |

---

## 3. 解决方案

### 3.1 终态（agent 视角）

修复后，agent 在 bare repo worktree 调 cw-* 工具：

```
# 任意写动作，与读动作一样正常
$ <agent> cw_review design-review --unitId slice:...::m1-context-filter --input .cw/.../m1-context-filter-design-review.json
→ cw-tool 探测到 cw-cli >= 1.6.2（支持归一化）→ 不传 --workspace
→ cw 用 process.cwd()=worktree → detectCommonDir → .bare → 正确 store
→ { ok: true, action: "design-review", ... }   ✅ 状态机正常推进
```

读写动作定位同一 store，状态互相可见。

**失败路径**（老 cw-cli < 1.6.2 走兜底）：兜底函数检测到 bare repo 时返回 `undefined`（不传 `--workspace`）。

⚠️ **老 cw-cli 没有归一化能力**（见 §1 两代机制表、§2.3 警告）——不传 `--workspace` 时，老 cw-cli 用 `process.cwd()` 做 store-key（per-cwd store）。因此方案 B 在 bare repo 返回 `undefined` 的真实取舍是：**放弃 bare repo 的 repo 级共享，换取读写一致（读写都落在 worktree 自己的 per-cwd store）**。这比现状（写动作落空目录、unit not found）好——至少读写一致、状态不丢。bare repo worktree 模式下每个 worktree 本就有独立的 `.cw/` 中间产物，per-cwd store 与之同构，取舍合理。

> **切勿**把方案 B 理解成「老 cw-cli 会自己归一化」——那是错误的（老 cw-cli store-key = workspacePath，纯 per-cwd）。方案 B 的价值仅在 ≥1.6.2 普及前保护极少数老 cw-cli + bare repo 用户，且代价是退回 per-cwd（非 repo 级共享）。

若用户装了不支持归一化的老 cw-cli 又在 bare repo 下用，工具返回的 `ok:false` 错误会带上「cw 版本过低，建议升级到 ≥1.6.2」的恢复指引（准则 6，见决策 3）。

### 3.2 多方案对比（准则 9，强制）

| 方案 | 长期架构合理性 | 短期实现成本（量化） | 风险 | 裁决 |
|---|---|---|---|---|
| **A：激活门控阈值**（`99.0.0`→`1.6.2`） | ✅ 高。cw-tool 退回纯封装，完全符合 cw-cli「decouple workspace」的设计意图；门控从死代码变活逻辑 | 极低：改 1 常量 + 同步 `workspace-gate.test.ts` 2 处断言（~5 行） | 低。cw-cli≥1.6.2 立刻受益；<1.6.2 仍走兜底=现状不回归 | ✅ **必做** |
| **B：加固兜底 `detectRepoWorkspace`** | ✅ 中。让兜底路径在 bare repo 也读写一致；但**对 ≥1.6.2 用户完全无作用**（门控支持→根本不调用此函数），仅保护 <1.6.2 + bare repo 极少数用户 | 低：函数加 1 个 bare repo 检测分支 + `detect-repo-workspace.test.ts` 补 `.bare` 用例（~15 行） | 低。仅影响老 cw-cli 路径 | ✅ **应做**（防御性加固） |
| C：删整个门控，cw-tool 永不传 `--workspace` | ✅ 最高（by construction，最简） | 中：删门控 + `probeCwCliNormalization` + 整个 `workspace-gate.test.ts`，调整 `executeCwAction` 签名（~80 行） | 中。放弃对 cw-cli<1.6.2 的 repo 级共享兜底（cw-cli ADR-0014 意图）；老用户退回 per-cwd store（但那是老版本本来行为，且 bare repo 下兜底本就 bug） | ❌ 暂不选（留作 cw-cli≥1.6.2 普及后的减法清理，准则 8） |

**推荐：A + B 组合。** A 是根因修复（让主流 cw-cli≥1.6.2 用户立刻正常），B 是兜底加固（保护老 cw-cli 用户 + 防止未来门控逻辑被误改回 placeholder）。C 作为 B 的激进版，等 cw-cli≥1.6.2 普及后可再做减法。

> **ADR 引用勘误**：cw-tool 源码注释（`cw-runner.ts` 5 处）引用「ADR-0045」，但 cw-tool 项目无任何 ADR 文件，该编号是**坏引用**。实际对应 cw-cli 的 **ADR-0014**（`coding-workflow/docs/adr/0014-cw-store-workspace-decoupling.md`，已核实存在）。本设计文档统一引用 ADR-0014；代码注释的坏引用属预存错误，修复时一并订正（见 §5 P1 附带）。

**被否方案 C 的取舍可感知**（准则 4）：若选 C 删门控，§2.2 里 `probeCwCliNormalization` 函数和 `workspace-gate.test.ts` 整个测试文件都要删，`executeCwAction` API 表面变更更大；而 cw-cli<1.6.2 用户（若有）会从「ADR-0014 repo 级共享兜底」退回「per-cwd 独立 store」。A+B 保留兼容性，代价是门控逻辑继续存在（但活化后是正确逻辑，非死代码）。

### 3.3 关键决策与权衡

**决策 1：门控阈值定为 `1.6.2`，不是更低**
- 选择：`MIN_CW_CLI_VERSION_FOR_NORMALIZATION = "1.6.2"`
- 被否：`1.6.0` / `1.6.1`（这些版本 getCwJsonPath 还是纯 per-cwd，没有归一化）
- 证据：✅ `git show a90e8e8~1:src/store/schema.ts` 显示归一化前 `getCwJsonPath` 是 `encodeCwd(cwd)` 无归一化；`a90e8e8` 是唯一引入 `detectCommonDir` 归一化的 commit；`git tag --contains a90e8e8` 首个 = v1.6.2。

**决策 2：`detectRepoWorkspace` 怎么识别 bare repo 并返回正确值**
- 选择：检测到 common-dir 路径 **basename 不是 `.git`**（bare repo 是 `.bare`）时，返回 `undefined`（不传 `--workspace`）。
- 被否：
  - ❌ `git rev-parse --is-bare-repository` 返回 true 作为判据——**在 worktree 里永远 false**（worktree 不是 bare，bare 是 `.bare` 目录本身；agent 永远在 worktree 工作，此判据永不触发）。只可用 common-dir basename 判据。
  - ❌ 返回 `cwd` 本身（语义混乱：函数名 detect**Repo**Workspace 返回 cwd 等于没探测）。
  - ❌ 返回 `dirname(common-dir)` 的现状（bare repo 下 = 容器根，bug）。
- **老 cw-cli 机制（审查已查清，非待验证）**：老 cw-cli（a90e8e8 之前）store-key = `encodeCwd(workspacePath)`，纯 per-cwd，**依赖外部传 repo 根才能 repo 级共享**。因此 `detectRepoWorkspace` 在**普通 repo 下必须返回 repo 根**（现状 `dirname(.git)` 正确，不能动）；**bare repo 下返回 `undefined`** 退回 per-cwd（读写一致，放弃 repo 级共享）。这一条无需装 cw-cli 1.6.1 实测——`git show a90e8e8~1:src/cli.ts` + schema.ts 已确认老版本 store-key 直接取 workspacePath、无归一化。
- 证据：✅ §2.3 探针证明**新 cw-cli** 的 detectCommonDir 对任意 git cwd 能归一化；✅ `git show a90e8e8~1` 证明**老 cw-cli** 无归一化、依赖 workspacePath。

**决策 3：老 cw-cli（<1.6.2）用户在 bare repo 下的错误要带恢复指引（准则 6）**
- 选择：`probeCwCliNormalization` 返回 `supported:false` 且 `detectRepoWorkspace` 返回 `undefined` 时（即老 cw-cli + bare repo），`executeCwAction` 的错误消息追加：「👉 cw-cli 版本过低（<1.6.2 不支持 store-key 归一化），bare repo worktree 下写动作退回 per-cwd store（读写一致但无 repo 级共享）。建议升级：`npm i -g @zhushanwen/coding-workflow@latest`」
- 被否：静默返回 `ok:false`（现状，错误不可操作）。

**运行时行为断言探针清单（准则 7）**

| ID | 验证的行为 | 探针 | 状态 |
|---|---|---|---|
| P-version | 门控阈值 1.6.2 = 归一化首个版本 | `git tag --contains a90e8e8` → v1.6.2；`a90e8e8~1` getCwJsonPath 无归一化 | ✅ 已测 |
| P-bare-empty | 写动作定位到不存在的 store | `~/.cw/...__.bare/store.json` 有 epic(60units)；`...xyz-agent-workspace/` 是空目录无 store.json | ✅ 已测 |
| P-reproduce | 手动加 `--workspace=容器根` 复现 unit not found | `cw status --unitId X --workspace <容器根>` → unit not found | ✅ 已测 |
| P-subdir | 新 cw-cli detectCommonDir 不依赖 cwd=repo 根 | 子目录跑 `git rev-parse --git-common-dir` → 仍 .bare | ✅ 已测 |
| P-old-cwcli | 老 cw-cli（a90e8e8~1）store-key 机制 | `git show a90e8e8~1:src/cli.ts` + schema.ts：store-key=workspacePath，无归一化 | ✅ 已测（审查核实） |
| P-is-bare | `--is-bare-repository` 在 worktree 的值 | worktree 内跑 → false（不可作 bare 判据） | ✅ 已测（审查核实） |
| P-fix | 改阈值后 cw-cli≥1.6.2 写动作不再传 --workspace | 跑 workspace-gate TC1（probe 支持→不传） | ⛔ P1 实施期 |
| P-fix-bare | 改后在 feat-context-compact 实测 cw_review 写动作成功 | `cw_review design-review`（见 §4 场景1）不再 unit not found | ⛔ P4 验收期 |

---

## 4. 验收（真实场景，非单测）

**改动规模**：中等（1 个常量 + 1 个函数加固 + 错误消息 + 测试补全）。按准则 11，投入 3 个真实场景 + 1 个测试验收（G4 专属）。

> **验收素材已确认**：`.cw/infinite-context-m1m4/m1-context-filter-design-review.json`（18540 bytes）是当时 bug 卡住时 agent 已写好、却因 `unit not found` 无法经 `cw_review design-review` 提交的 judgment——修复后重提交它能成功，是最真实的写动作验收。epic:infinite-context-m1m4 及相关 unit 位于归一化后的 `.bare` store（60 units），验收以此为唯一真相（遗留 per-cwd store 是历史包袱，勿混）。

**场景 1（回溯 G1+G2，核心；写动作门控修复）**：在 `feat-context-compact`（bare repo worktree）实测修复后的**写动作**。
- 步骤：① 用修好的 cw-tool 调 `cw_review design-review --unitId slice:...::m1-context-filter --input .cw/infinite-context-m1m4/m1-context-filter-design-review.json`（真写动作，非只读 status——只读动作不触发门控，验不了）；② 再调 `cw_planning status`（读）对比，确认读写定位同一 store。
- 通过标准：写动作返回 `ok:true`，不再 `unit not found`；读动作能看到写动作推进的状态（读写一致）。
- 依赖：feat-context-compact worktree + 现有 cw 状态（真实，非 mock）。

**场景 2（回溯 G3，不回归）**：在普通 repo（`.git` 模式）实测写动作。
- 步骤：新建临时 git repo → bash 裸调 `cw create epic --slug tmp-verify`（建树根，工具层 cw_planning 白名单不含 create，须 bash）→ 用修好的 cw-tool 调 `cw_planning design --unitId epic:tmp-verify --input <设计>`（写动作，经工具层）→ 验证落盘 → `cw abort` 清理。
- 通过标准：写动作正常推进（与修复前行为一致），不因「门控活化后不传 --workspace」而退化。
- 说明：create 经 bash（工具层不含 create），写动作验证经 cw_planning 工具层——两层分开，勿混。

**场景 3（回溯 G4，防复发；G4 主证）**：跑补全后的测试套。
- 步骤：`pnpm extensions:test`（含新增 bare repo `.bare` 用例）。
- 通过标准：bare repo `.bare` 用例通过；现有 linked-worktree / 普通 repo 用例不回归。
- **此场景是 G4 的验收主证**（G4 目标本身就是测试）。

**验收口径区分**（准则 11）：G1/G2/G3 用真实 cw 调用为主证（场景 1/2）；**G4 的目标本身就是测试存在且通过，其主证就是场景 3**。单元测试对 G1-G3 仅作回归辅助（防止门控改回、兜底写错），对 G4 是主证。

---

## 5. 下一层拆分

**实施路径**（分阶段，每阶段可独立验收/回滚）：

| 阶段 | 内容 | 验收呼应 | 文件 |
|---|---|---|---|
| **P1** | 激活门控：`MIN_CW_CLI_VERSION_FOR_NORMALIZATION` `99.0.0`→`1.6.2`；同步 `workspace-gate.test.ts` 把「placeholder 当预期」的用例改成「1.6.2 边界」；附带订正 cw-runner.ts 注释的 ADR-0045 坏引用 → ADR-0014 | 场景 1（改完即刻受益）+ P-fix 探针 | `cw-runner.ts`（常量+注释）+ `__tests__/workspace-gate.test.ts` |
| **P2** | 加固兜底：`detectRepoWorkspace` 检测 common-dir basename 非 `.git` → 返回 `undefined`；普通 repo 保持返回 `dirname(common-dir)`=repo 根（现状正确，不动） | 场景 1（老 cw-cli 路径）+ 决策 2（机制已查清，无需实测老版本） | `cw-runner.ts`（detectRepoWorkspace）|
| **P3** | 补 bare repo 测试：`detect-repo-workspace.test.ts` 加 `.bare` 模式用例（复现 dirname(.bare)=容器根 的错误，断言修复后返回 undefined）；加「`--is-bare-repository` 在 worktree=false 不可作判据」的防误用用例 | 场景 3（G4 主证） | `__tests__/detect-repo-workspace.test.ts` |
| **P4** | 错误恢复指引（决策 3）+ 实测验收（场景 1/2 全跑） | 场景 1/2 | `cw-runner.ts`（executeCwAction 错误分支） |

**文件改动地图**

- `extensions/cw-tool/src/cw-runner.ts`：改 1 常量 + 订正注释 ADR 引用（P1）+ 改 `detectRepoWorkspace`（P2）+ 错误消息（P4）。核心文件，三处改动正交。
- `extensions/cw-tool/src/__tests__/workspace-gate.test.ts`：更新门控阈值相关断言（P1）。
- `extensions/cw-tool/src/__tests__/detect-repo-workspace.test.ts`：新增 bare repo `.bare` 用例 + is-bare 误用防护（P3）。
- **不动**：`cw-spawn.ts`、`index.ts`（工具注册）、cw-cli 源码。

**待验证检查点（诚实标注）**

- ⛔ P-fix / P-fix-bare：门控活化后的实际行为（探针表标 ⛔ 的两项），需实施后实测。
- ~~P-old-cwcli~~：原标「装 cw-cli 1.6.1 实测老版本行为」——**审查已用 `git show a90e8e8~1` 查清**（老 cw-cli store-key=workspacePath，纯 per-cwd无归一化），结论已并入决策 2，无需实测。
- ⛔ 是否同步更新 cw-tool 的 README（若有提及门控/placeholder）——实施时确认有无相关文档需同步。

**后续清理（out-of-scope，bug 修复后另做）**

pi-cw skill 与 planning-agent 模板里「cw-* 工具有 bug，降级 general-purpose」的措辞需清理——那是 bug 的下游受害者应对策略，bug 修复后应恢复标准 agent 模板派发。本文不覆盖。

---

## 附录：审查溯源

本设计经 `tech-design-review` 对抗式审查（2026-08-11），核实 14 项事实断言、发现 3 处与"✅已测"标注不符。已修正：① MF-1 老 cw-cli 归一化能力误述（重写 §1 两代机制表 + §3.1 失败路径 + 决策 2）② MF-2 验收场景 1 改用真写动作 `cw_review design-review` ③ MF-3 "空 store.json" 改"空目录无 store.json" ④ MF-4 ADR-0045 坏引用 → ADR-0014 ⑤ MF-5 G4 单设测试验收主证 + 采纳 5 条 suggestion。
