# D7+D9：扫描类 IO 缓存治理（文件扫描 + session 目录扫描）

> **一句话结论**：两类「每请求全量扫描」的 IO 成本需要治理——①文件扫描：`searchFiles` 串行递归 + 每文件逐个 stat、`.gitignore` 每请求重读重编译、`matchPath` O(规则×前缀)；②session 扫描：`scanPiSessions` 每次全量 `readdirSync`+`statSync` 无目录级缓存，且被 8+ 处调用点重复触发。定案：自建四件套（matcher mtime 缓存 + 目录剪枝 + 有界并发 + searchFiles 免 stat）+ session 目录列举 1s TTL 缓存。不引入第三方扫描库（探明：fast-glob 虽在依赖中，但产品语义——硬短路目录不可取反、结果上限、逐目录容错——fast-glob 无法直接表达）。

**当前层 → 下一层**：技术方案设计（下一层产物 = 可实现的接口/缓存策略/剪枝语义）。涉及数据流，准则 5 适用。

---

## §1 背景目标

### SCQA

- **情境**：用户打开 composer 输入 `#` 触发文件候选（`file.search`），或展开文件树目录（`file.tree.expand`）——这些交互要求 runtime 快速返回文件列表。runtime 的文件扫描（`file-service.ts`）自建递归遍历 + 自研 ignore 匹配。同时侧栏的 session 列表依赖 `listPersistedSessions` 扫描磁盘 session 目录。
- **冲突**：文件扫描每次请求都重读重编译 `.gitignore`、对每个文件逐个 `stat`、串行递归目录；ignore 匹配是 O(规则数 × 路径前缀数)。session 扫描每次全量 `readdirSync` + 每文件 `statSync`，一次「加载更多历史」操作内会被多个方法各自触发多次。
- **问题**：**「每请求全量重算 + 无缓存」的 IO 模式**。大仓库（10 万文件）下 composer 候选秒级~十秒级；session 多时列表刷新每次几百次同步 stat。
- **答案**：自建优化（探明事实显示第三方库不能表达产品语义），两处扫描各加一层缓存 + 剪枝 + 并发。

### 系统是什么（最小背景）

| 概念 | 说明 |
|---|---|
| IgnoreMatcher | 编译后的 .gitignore 匹配器（`infra/fs/ignore-parser.ts`）：规则列表 + `matchPath(path)` 判定是否忽略，对齐 git「最后匹配规则生效」语义（支持 `!` 取反）。 |
| BUILTIN_IGNORE_DIRS | `file-service.ts:65-67` 的硬屏蔽目录集（node_modules/.git/dist/build/coverage 等）——**独立短路，不可被 `!` 取反覆盖**。 |
| searchFiles / listTree / expandDir | 三个扫描入口：composer 候选全量递归（上限 5000 结果、深度 8）；文件树首加载（顶层 + 一级）；展开单层。 |
| scanPiSessions | `session-file-utils.ts:637-692`：readdirSync sessions 目录 + 递归子目录 + 每文件 statSync + per-file meta 缓存（(mtimeMs,size) 键，已有）。 |
| sessionMetaCache | per-file 的 meta 缓存（已有，命中则零读只 statSync）；**目录列举层无缓存**。 |

### 设计目标

1. **候选/展开即时**：大仓库 composer `#` 候选 < 1s；目录展开免重读重编译 .gitignore。
2. **session 列表秒级**：`listPersistedSessions` 高频调用时目录列举走缓存，新建 session 仍秒级可见。
3. **语义零变化**：ignore 匹配结果与现状完全一致（剪枝仅在可证明安全的条件下生效）；文件树 untracked 的 size 降级显示保持。

### In / Out scope

- **In**：matcher 缓存、matchPath 剪枝与短路径、listDir 参数化（免 stat）、searchFiles 有界并发、session 目录列举缓存与失效。
- **Out**：嵌套 .gitignore 支持（探明：现状本就不支持，非本次目标）；前端缓存策略（已有两层缓存，不动）；引入第三方扫描库（见 3.2）。

---

## §2 现状与问题分析

### 2.1 使用者视角的现状

大仓库用户打开 composer 输 `#`：候选列表数秒才出现（串行递归 + 每文件 stat + 每路径 O(规则×前缀) 匹配）；每次展开一个目录，runtime 重新读 `.gitignore` 并重编译全部正则。session 很多的用户每次进入侧栏/刷新列表，runtime 同步扫整个 sessions 目录。

### 2.2 探明事实（决定方案形态的关键证据）

| 事实 | 数据 |
|---|---|
| 全仓 .gitignore 取反规则 | 仅根 `.gitignore` 2 条 `!`（`.env.example`、`.pi/workflows/`），其余 6 个文件 0 条 |
| 嵌套 .gitignore | 不支持：searchFiles/listTree 只读 cwd 根（expandDir 额外读展开目录），递归下钻不重载子目录 matcher |
| size 字段消费 | renderer 唯一消费点 = `FileTreeRow.vue` 的 untracked 降级显示 `~size`；composer 候选与 markdown 路径链接不显示 size → **searchFiles 可免 stat**（但 listDir 当前无条件 stat，需参数化） |
| fast-glob | 已是 runtime 依赖（`fast-glob@^3.3.3`）但 file-service/ignore-parser 未使用；**消费点已探明：`plugin-rpc-setup.ts:279-280` 的插件 `findFiles`**（不可移除，见 §5 检查点） |
| ADR 约束 | ADR-0026 否决「全量加载」「全量+虚拟滚动」，基调自建懒加载；ADR-0027 要求 FileService 三层 port + ignore 纯函数；ADR-0030 复用匹配算法。ADR 未禁止第三方库 |
| session 扫描调用点 | `session-service.ts:322/527/534/560/839`、`session-history.ts:46/61`、`session-lifecycle.ts:331/465`（465 为 `findScannedSession` 服务方法；464 是注释行）各自独立 `scanSessions().find()`；`sendInitialState` 每次 renderer 重连触发一次全量扫描 |
| per-file meta 缓存 | 已有（(mtimeMs,size) 键），目录列举层无 |
| `invalidateSessionMetaCache` | 仅 delete 路径调用（session-lifecycle.ts:295/306）；rename/persist 不失效（靠 mtime 键自然失效） |
| pi 写 session 文件时机 | 延迟写入：首个 assistant 消息前不落盘（规则 #6）——新建 session 的发现靠目录重扫 |

### 2.3 根因

1. **matcher 无缓存**：`loadMatcher` 每次 `readFile(.gitignore)` + `compileIgnoreRules`（每个规则一次 `new RegExp`）。
2. **matchPath 算法无剪枝无复用**：每路径 `allPrefixes` 重新 split/slice/join 分配数组，规则 × 前缀两层循环。
3. **IO 形状差**：searchFiles 串行 `await walk` + 每文件 `stat`（目录内并发为零）。
4. **session 目录列举无缓存**：每次调用全量 readdirSync + statSync；同 handler 内多次 find 重复整表扫描。

### 2.4 物理数据流（现状，searchFiles 单次请求）

```
file.search RPC
  → loadMatcher(cwd)：readFile(.gitignore) + compileIgnoreRules（每请求重复）
  → walk 递归：readdir(目录) →【串行】下一个目录
      每文件：stat（取 size）→ entryToNode → matchPath（每路径 O(规则×前缀)）
  → 结果截断 5000 条返回
```

---

## §3 解决方案

### 3.1 终态（使用者视角先行）

**composer 候选**：大仓库输 `#`，候选 < 1s 出现（有界并发递归 + 免 stat + 剪枝跳过已忽略目录）。同 session 重复打开浮层直接命中前端缓存（现状已有），打开瞬间不卡。

**目录展开**：`.gitignore` 编译结果按 (目录, mtime, size) 缓存，展开几十个目录零重读零重编译。

**session 列表**：进入侧栏/切换目录时，目录列举命中 1s TTL 缓存（几百个 session 也零磁盘 IO）；新建 session 后 1s 内出现在列表（缓存过期自然发现；删除/重命名走显式失效立即生效）。

**失败路径 + 恢复指引**：目录不可读/stat 失败 → 与现状一致逐条容错跳过；matcher 缓存失效只需 `.gitignore` mtime 变化（自然失效，无需手动维护）。

### 3.2 多方案对比

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| **A：自建四件套 + session 目录缓存（选）** | ✅ 符合 ADR-0026/0027/0030 的自建基调；产品语义（硬短路不可取反、结果上限、逐目录容错）全部保留 | 中：4 个局部改造 + 1 个缓存层 | 低：剪枝有安全条件（见 D7-2） | ✅ |
| B：fast-glob 替换扫描 | ⚠️ 依赖已在，但产品语义需适配层重造：BUILTIN_IGNORE_DIRS 不可取反的硬短路、MAX_SEARCH_RESULTS 截断时机、per-dir 容错、cwd 相对路径——fast-glob 的 ignore 是 glob 级匹配，与「目录命中即剪枝」的增量语义不契合 | 中 | 中：语义差异是隐蔽回归源 | ❌ 若用它：`!` 取反与硬短路的交互行为会变（fast-glob 无「不可取反目录」概念），结果上限的截断时机变化影响候选排序稳定性 |
| C：引入 `ignore` 库只做匹配 + 自建扫描 | ⚠️ 混合：匹配语义交给库、扫描自建，收益边际（匹配已是纯函数）且引入两套语义概念 | 低 | 低 | ❌ 若用它：matchPath 的「最后匹配生效」语义与库行为需逐一对照验证，收益只是省掉自研 parser 的维护 |

**推荐 A**。理由：探明事实（取反规则≈0、无嵌套、size 仅一处消费）使自建优化成本极低；产品语义定制是真实存在的行为（BUILTIN 硬短路等），第三方替换反而引入适配层；ADR 基调自建。

### 3.3 关键决策与权衡

**D7-1：IgnoreMatcher 缓存（key = 单个 .gitignore 文件路径 + mtimeMs + size，文件级缓存）**。
- 选择（审查修正：初稿按「目录元组」组合键，V2「只读一次」不可达成——`expandDir` 传 (cwd, dir) 两个目录 → 目录元组键 20 个不同目录 = 20 个不同 key → 根 .gitignore 被重读重编译 ~20 次）：`loadMatcher` 结果按**单个 `.gitignore` 文件** `(path, mtimeMs, size)` 作 key 缓存——cwd 根与各展开目录共享同一根 .gitignore 时命中同一编译结果（缓存 miss 路径先 `stat` 该文件取 (mtime,size) 再决定重读/重编译；一次 stat 代价远低于重编译，且与 sessionMetaCache 同款键策略）。命中免读免编译。
- 证据：`.gitignore` 会话内几乎不变；mtime 键天然失效（文件被写工具改动即 miss，无需手动 invalidate）。
- 边界：嵌套 .gitignore 现状不支持（Out of scope 已声明），缓存层不引入新语义；expandDir 读的两个目录各自解析到「同一根 .gitignore 文件路径」时共享命中。

**D7-2：matchPath 剪枝 + 短路径直通（审查修正：明确「新增 vs 已有」边界与负向影响）**。
- **已有行为边界**：目录剪枝（ignored 目录 `continue` 整目录跳过下钻）是 searchFiles **现状已有**行为（`file-service.ts:209`）——D7-2 的增量是：① 短路径直通（无 `/` 的路径跳过 `allPrefixes`）；② 对「无取反 matcher」的剪枝**安全条件背书**（现状无论有无取反规则都剪枝——对含取反规则的仓库，现状行为是「被忽略但可取反的目录已被误剪」；本文档按保守语义区分处理）。
- 剪枝语义（安全条件）：**仅当某目录被「非取反规则」命中且该规则之后无任何取反规则可能覆盖时，才整目录跳过下钻**。实现为：预计算「是否存在取反规则」——无取反规则的 matcher（覆盖探明事实中 99%+ 场景）直接启用剪枝；**有取反规则的 matcher 走保守路径（不剪枝或仅对 BUILTIN_IGNORE_DIRS 硬短路，后者本就不受取反影响）——这是相对现状的行为变化：取反仓库会变慢（正确性优先于速度），如实标注为已知负向影响**。
- 短路径直通：无 `/` 的路径跳过 `allPrefixes`（`[path]` 直接测试）。
- 被否：无条件剪枝——违反「最后匹配规则生效」（`!` 取反可重新包含被忽略目录）。
- 证据：探明事实「取反规则仅根 .gitignore 2 条」+「BUILTIN_IGNORE_DIRS 独立短路不可取反」。
- **[实施定案 R-13，2026-08-17 回写] 本段的「安全条件剪枝」方案（含取反规则的 matcher 禁用剪枝的保守路径）不做**。裁决源：plan.md R-13（05-G1）。理由：该保守实现会改变改造前行为（取反仓库的剪枝结果集差异），属于语义变更而非性能优化，与 V6「取反规则行为与现状一致」自相矛盾且有回归风险。实施口径：**matchPath 级剪枝保持改造前行为不动**（`file-service.ts:281-283` 实况：`matchPath(matcher, node.path)` 命中即跳过下钻，无论 matcher 是否含取反规则——接受 `build/` + `!build/keep.js` 场景下被忽略目录内子孙文件不可被取反找回的既有语义）；W24 实际只做 matcher mtime 缓存（D7-1）+ 短路径直通。上文本段第 2-3 条（安全条件背书与保守路径描述）仅保留为设计过程记录，**以本条实施定案为准**。V6 验收措辞已同步修正（见 §4）。

**D7-3：listDir 参数化（searchFiles 免 stat）**。
- 选择：`IFileExecutor.listDir(path, opts?: { withSize?: boolean })`，默认 true（文件树保持 size）；searchFiles 传 false。
- 证据：size 唯一消费点是 FileTreeRow 的 untracked 降级（文件树路径），searchFiles 结果不显示 size（探明事实）。

**D7-4：searchFiles 有界并发**。
- 选择：目录遍历改为 8~16 路有界并发（信号量），保持 MAX_SEARCH_RESULTS=5000 截断与 per-dir 容错语义；**输出顺序仍由 `sortNodes` 终排序确定（确定性）**——有界并发改变的是**发现顺序**而非输出顺序。
- **同名 tie 决出规则（审查修正，输出序与现状对齐口径修订）**：`sortNodes` 新增同名 tie 按 **path 降序**决出（跨目录扁平列表才会出现，如 `a/x.ts` vs `b/x.ts`）。理由：并发收集顺序非确定，仅靠稳定排序（保持插入序）不足以产生全序——path 全序断 tie 显式消除对 readdir 目录序的依赖，输出序完全确定。树场景（listTree/listLevel）同目录 name 唯一，tie 分支不可达，行为不变。**跨目录同名节点的输出序相对改造前（readdir 序 + 稳定排序）可能变化**，此为已声明修订（V1 验收按新全序对齐，不再与改造前逐条等价）。
- **截断成员不确定性（审查修正，显式声明）**：`MAX_SEARCH_RESULTS=5000` 截断发生在收集期——超限仓库（>5000 命中）下「命中前 5000 的成员」随并发调度而异（深度优先严格顺序与有界并发不可兼得）；`sortNodes` 只保证输出顺序、**不恢复截断成员**。定案：① **未超限仓库结果集与现状完全一致**（并发不影响集合成员）；② 超限仓库**截断成员可能不同**，显式声明为可接受范围（候选是「前 N 个按序结果」的近似，语义不变）；③ 头部常驻性：字典序最前的已发现成员必在结果中（收集完成前不会被更晚发现的成员挤出……以实施期实现为准）。**[实施定案（口径统一，2026-08-16）]** 「V1 截断健壮性场景验收『同批重跑结果集稳定』」**不作为验收项**——实现为收集达 `MAX_SEARCH_RESULTS` 即停（`file-service.ts` 收集循环内 `result.length >= MAX_SEARCH_RESULTS` 即 return/break），截断成员取决于并发调度，同批重跑结果集**不保证稳定**；与 ②「截断成员不确定性为可接受」的声明口径统一，仅头部常驻性可验收。
- 证据：现状串行 `await walk` 是深目录树的延迟主因。

**D9-1：session 目录列举 1s TTL 缓存 + 显式失效（审查修正：缓存只作用列表构建消费方，不污染路径解析消费方）**。
- 选择：`scanPiSessions` 的**目录列举层**（readdirSync 递归 + statSync 部分）加 **1s TTL 缓存**；per-file `scanSessionMeta` 缓存保持现状。create/fork/delete/rename 路径调用 `invalidateSessionMetaCache` 之外新增目录缓存失效。
- **消费方分层（审查修正，初稿笼统缓存在共享 scanPiSessions 上，会节流正确性敏感的单 session 路径解析）**：`scanSessions()`（session-store.ts:31-33）被两类消费方共用——**列表构建消费方**（`SessionScanner.listAll` / `listPersistedSessions`，侧栏列表）与**单 session 路径解析消费方**（`session-history.ts:46/61` 的 `getHistoryFromFile`/`getFullHistory`、`getSubagents`/`getWorkflows` 等按文件路径查找）。TTL 只作用前者；后者**绕过缓存强制刷新**（或提供 `force` 参数）。理由：外部 pi 写文件（规则 #6：新 session 文件首个 assistant 后才落盘）不在显式失效覆盖内——若路径解析也走 1s 缓存，刚落盘的持久化 session 的历史/子代理/workflow 查找会在窗口内静默返回 []/not_found（较现状「始终最新」新增退化窗口，正确性敏感路径不可接受）。列表构建消费方 1s 陈旧可接受（新建 session 落盘后秒级可见）。
- TTL 取值依据：新建 session 的 pi 文件「首个 assistant 前不落盘」（规则 #6）——列表本来就无法在文件落盘前发现它；1s TTL 保证落盘后秒级可见，且不会因外部进程写文件而需要事件驱动（探明结论：「新建 session 秒级可见」的关键是目录重扫，1s 重扫满足）。
- 被否：fs.watch 事件驱动——pi 是外部进程写文件，watch 全目录的语义维护复杂，收益不抵；TTL 更长（分钟级）——新建 session 可见性延迟不可接受。
- 顺手项：同 handler 内多次 `scanSessions().find()` 合并为一次扫描复用（session-service.ts 多处）。

---

## §4 验收（真实场景）

| # | 场景 | 步骤 | 通过标准 | 回溯目标 |
|---|---|---|---|---|
| V1 | 大仓库打开 composer 输 `#` | 计时候选列表出现；**精确等价 diff 在 <5000 命中仓库验证**（按新 `sortNodes` 全序逐条一致——同名节点按 path 降序，D7-4 tie 规则）；超上限仓库（≥5 万文件命中 >5000，可用构造仓库或本仓 >5000 子集近似）单列「截断健壮性」：**同批重跑结果集不保证稳定（勘误：达 cap 即停、成员随并发调度而异，D7-4 实施定案）**、头部（字典序最前已发现成员）常驻 | 候选 < 1s（改造前基线对比）；<5000 仓库 diff 按 sortNodes 全序逐条一致（含同名 tie path 降序）；超限仓库**结果集不保证稳定属已声明可接受范围** + 头部常驻（D7-4） | 目标 1 |
| V2 | 文件树连续展开 20 个目录 | 观察响应与 runtime 日志 | 每次展开 < 100ms；**每个唯一 `.gitignore` 文件只读取/编译一次**（缓存按文件级 (path,mtime,size) 键，20 个目录共享同一根 .gitignore 时命中同一编译结果；日志打点或 strace 验证） | 目标 1 |
| V3 | 文件树显示一个 untracked 文件 | 观察行数降级显示 | untracked 文件仍显示 `~size` 降级（listDir 默认 withSize 保持文件树行为） | 目标 3 |
| V4 | 修改 `.gitignore`（agent 用 edit 工具改动）后再次展开目录 | 观察 ignore 行为 | 新规则立即生效（mtime 键失效，缓存 miss 后重读重编译） | 目标 3 |
| V5 | 新建一个 session（发送首条消息等 pi 落盘） | 观察侧栏列表 | 文件落盘后 1s 内新 session 出现在列表；删除 session 后立即从列表消失（显式失效） | 目标 2 |
| V6 | 含取反规则的仓库（构造一个带 `!` 的 .gitignore 测试仓库） | 扫描验证 | 取反规则行为与**改造前**一致（以改造前实测为基线，而非理想语义——剪枝保持 matchPath 级现状、安全条件剪枝不做，见 §3.3 D7-2 实施定案 R-13 勘误） | 目标 3 |

---

## §5 下一层拆分

实施路径：两个独立子域（文件扫描、session 扫描）可并行，各自单阶段：

| # | 拆分单元 | justification | 文件改动地图 |
|---|---|---|---|
| U1 | matcher mtime 缓存 | 独立小改动、收益直接 | `file-service.ts`（loadMatcher 加缓存） |
| U2 | matchPath 剪枝 + 短路径 | 纯函数改造，测试先行 | `ignore-parser.ts`（剪枝条件 + 短路径）；新增测试覆盖取反边界 |
| U3 | listDir 参数化 + searchFiles 免 stat | 接口小改动 | `fs-executor.ts`、`services/ports/file-executor.ts`、`file-service.ts` |
| U4 | searchFiles 有界并发 | IO 形状改造 | `file-service.ts`（walk 信号量化） |
| U5 | session 目录列举缓存 + 失效 + find 合并 | 独立子域 | `session-file-utils.ts`（目录缓存）、`session-lifecycle.ts`/`session-service.ts`（失效点 + find 合并） |

**待验证检查点**：
- **fast-glob 依赖不可移除（审查修正：消费点已探明）**——`plugin-rpc-setup.ts:279-280` 在插件 `findFiles` 中 `import('fast-glob')`，移除会破坏插件 findFiles；§5 检查点定案「保留依赖」，除非另行替换插件 findFiles 的实现。
- 剪枝安全条件的实现细节：「规则之后无取反规则可能覆盖」的精确判定——保守实现为「matcher 含任何取反规则则整体禁用剪枝」，覆盖探明事实的 99%+ 场景；精确实现留待后续。**[实施定案 R-13，2026-08-17 回写]** 此检查点已失效：安全条件剪枝整体不做（含保守实现），matchPath 级剪枝保持改造前行为——见 §3.3 D7-2 勘误段（裁决源 plan.md R-13）。
- 有界并发下「结果上限 5000」的截断时机变化对候选列表内容的影响：未超限仓库结果集成员不变、输出序按新 sortNodes 全序（V1 diff 验证）；超限仓库截断成员不确定性按 D7-4 声明为可接受（V1 截断健壮性场景验收）。
