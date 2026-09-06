# Sidecar 绑定字段同步收敛设计（fix-add-session-to-project）

> **一句话结论**：session 加入 project 后「被轮换出来」由两类机制缺陷、四个同型实例（restore 与 fork 均不回填归属内存态、写/删 sidecar 不失效扫描缓存）加一个继承语义缺口（handoff 承接 session 不继承源归属）造成；根因是绑定字段的同步点组合爆炸（5 字段 × 入口 × 2 缓存层）且无机制守卫——本设计止血全部实例，用「字段注册表 + 类型键约束 + 统一回填 + 默认缓存失效 + 外部锚定守卫测试」把同步点收敛到单一权威源，护栏选型为「结构收敛 + 编译期/测试双层守卫」而非「仅注释」。

> **层声明**：当前层 = 技术设计；下一层 = 可实现的代码改动（函数/类型/测试），不跨层设计具体实现代码。

---

## 1. 背景目标

### SCQA

- **S（情境）**：xyz-agent runtime 用一族 sidecar 文件（`.project.json` / `.preset.json` / `.agent.json` / `.handoff.json` / `.meta.json`）持久化 session 级绑定数据。活跃 session 的绑定值走内存态（`ManagedSession` 实例上的扩展字段，`toSummary` 透传进广播）；磁盘 session 走扫描（`scanSessionMeta` 多读合一，带两层缓存）。两条路互斥：活跃 session 的文件被 `getActiveFilePaths` 排除出扫描。
- **C（冲突）**：D14 功能「session 归属 project」（2026-08-04 加入）漏了两个同步点。用户把 session 加入 project 后，侧栏里会有一个 session 从该项目视图消失、「掉回」默认项目——观感像被轮换出去。
- **Q（问题）**：这不是第一次。sidecar 家族 5 个成员中，同型「写 sidecar 后内存/缓存没跟上」的坑已独立出现 4 次（详见 §2.3）。为什么反复踩？
- **A（答案）**：同步点 = 字段数 × 重建入口 × 缓存层 ≈ 30 个，分散在 4 个文件里，无清单、无守卫，全靠 code review 记性。每新增一个绑定字段就要人肉记得 6+ 处同步——D14 漏掉多处是这个矩阵的必然产出。本设计：① 止血全部实例与语义缺口 ② 把同步点收敛到单一权威源 ③ 用编译期 + 测试双层守卫防第 7 次返工。

### 系统是什么（受众假设：会用 xyz-agent 但不熟 runtime 内部的开发者）

用户在桌面应用侧栏把 session「归入项目」（逻辑分组，可跨任意目录）。归属数据与 session 生命周期绑定：session 的 JSONL 对话文件旁边放一个 `.project.json` sidecar 记录归属 id。应用重启后扫描磁盘恢复显示。

### 设计目标（从使用者体验倒推）

- **G1**：用户把 session 加入 project 后，无论点击/切换/重开（restore）、fork、handoff 交接，还是重启应用，归属显示不再消失或回退；交接出去的工作（handoff 承接 session）留在同一 project。
- **G2**：开发者未来新增第 6 个绑定字段时，漏掉任一同步点（回填入口/缓存失效/字段登记）会被编译期或测试拦截，而不是靠 review 记性；新增 **create 派生调用方**（handoff 型）漏传/顺手多传绑定参数也会被入口清单测试拦截（见 §3.3 决策 1b）。**护栏不覆盖：入口语义定错（该继承却写 none）与其它未接入注册表体系的字段**，靠 review，见 §3.1 能力边界。
- **G3**：不牺牲现有性能特性（扫描 TTL 缓存、1s 列表刷新窗口的既有价值）。

### in / out scope

- **in**：runtime 层两类缺陷全部实例 + handoff 归属继承语义缺口的修复；绑定字段同步点的结构收敛；守卫测试；护栏选型。
- **out**：D14 关系模型本身（已验证正确，磁盘数据完好）；前端过滤逻辑（SessionList.visibleGroups 正确）；renderer 乐观更新机制不重构（靠写点失效保证广播数据新鲜使竞态无害，机制本身保留）；pi 层（不修改）。

---

## 2. 现状与问题分析

### 2.1 物理数据流（用户眼前 ← 广播 ← 双源）

```
                     写路径（用户操作「归入项目」）
用户点击 SessionItem「归入项目」菜单
  → RPC session.setProject(sessionId, projectId)
  → session-service.setProject（session-service.ts:1695）
      ├─ 活跃 session：写内存实例 projectId + persistProjectBinding
      └─ 磁盘 session：persistProjectBinding（写 .project.json sidecar）
  → broadcastSessionList（全量列表广播）

                     读路径（列表怎么变成用户眼前）
config.sessions 广播 ← listPersistedSessions ← listAll（session-scanner.ts:40）
  ├─ 活跃：getActiveSummaries() ← toSummary ← 内存实例字段   ← 唯一来源
  └─ 磁盘：scanSessions() ← scanSessionMeta（两层缓存：sessionMetaCache 文件级
           + scanDirCache 目录级 1s TTL）← 读 sidecar 文件
  （活跃 session 的 filePath 被 activeFilePaths 排除出扫描侧）
→ renderer applySnapshot 整表替换 groups
→ SessionList.visibleGroups 按 session.projectId === activeProjectId 过滤
→ 用户看到「项目 P 下的 session 列表」
```

关键结构事实：**活跃 session 的绑定值只认内存实例**（扫描侧被排除），所以任何「重建内存实例」的入口都必须回填全部绑定字段，否则广播数据就是错的。

### 2.2 两类缺陷、三个实例（真实失败模式，均已实锤）

**缺陷 A（持久性）：重建内存实例不回填绑定字段 —— restore 与 fork 两个实例**

**实例 A-1：restore 重开 session 后丢失归属内存态**

- 复现链（代码级实证，行号基于 HEAD f851db0）：
  1. 用户点击一个无活跃 pi 进程的 session（侧栏点击 → `session.switch` → `ensureActive` → `restoreSession`，session-lifecycle.ts:634）
  2. `restoreSession` 重建 `ManagedSession` 实例（`initializeManagedSession`，session-service.ts:1863——构造的字面量**不含 projectId**），只 patch 了 `launchPresetId`（lifecycle:735），**不回填 projectId**；而该实例进 Map 后其文件被扫描侧排除
  3. 之后任何 `config.sessions` 广播：该 session 的 `projectId = undefined`
  4. 前端过滤 → 该 session 从项目 P 视图消失，落入默认项目聚合
- 同型丢失不止 projectId：`spawnSource` / `parentAgentSessionId`（agent badge 丢）/ `handedOffTo`（已交接标记丢）同样不回填（restore 入口）。

**实例 A-2：fork 新 session 只写 sidecar、不 patch 内存 projectId**

- 复现链（对抗式审查逼出，初判曾误标「fork 现状已对」）：
  1. 用户 fork 一个归属项目 P 的 session → `forkSession` 正确解析继承值 `forkProjectId`（lifecycle:835-836，内存兑底 + 扫描 fallback）并写进 fork 产物的 sidecar（lifecycle:877-878）
  2. 但收尾只 patch 了 `launchPresetId` 内存态——**全函数无任何 projectId 内存赋值**；fork 新 session 立即入 Map、其文件被扫描侧排除
  3. → fork 产物**活跃期间**侧栏广播恒为 `projectId: undefined`，显示在默认项目而非 P；重启后才走扫描侧恢复正确显示
- 与 A-1 同型：继承语义写了磁盘一半、内存一半漏掉。

- 用户视角：「project 下有两个目录的 session，再加入第三个时，有一个被轮换出来了」——跨目录 project 下每组通常只有一个 session，任一 session 被 restore 过（哪怕只是之前点开过），整组就从视图消失。
- 持久层完好（已用真实数据验证：`~/.xyz-agent/pi/sessions/` 下 P 项目 4 个 session 的 sidecar 全部正确），所以**重启应用后现象消失**（重启后走扫描路径）。

**缺陷 B（瞬时性，1s TTL 窗口）：写/删 sidecar 后紧跟的广播带回 stale 归属**

- `persistAgentBinding` 写 sidecar 后特意传 `{ invalidateScanDir: true }`（注释明说：列表扫描有 1s 目录 TTL，不失效会让标记迟到窗口期）；`persistProjectBinding` 复用同一骨架（`persistBindingSidecar`，session-file-utils.ts）却**没传**。
- 探针实证（真实目录实测，已还原现场）：

```
1) 首次扫描                              → target projectId: null
2) persistProjectBinding(target, P)      → sidecar {"projectId":"proj-TEST-TTL"} 写入成功
3) 立即再扫（TTL 模式 = 广播实际走的路径） → 广播将携带 projectId: null   ← stale！
4) force 重扫（>1s 后）                  → proj-TEST-TTL                  ← 数据本来是对的
```

- 后果：`session.setProject` handler 写 sidecar 后紧跟 `broadcastSessionList` → TTL 命中 pre-binding 快照 → 广播携带 `undefined`。reply 帧先于 broadcast 帧到达，前端乐观更新（`updateProjectId`）必被后到的 stale 广播整表覆盖 → **刚加入的 session 又弹回默认项目**，1s 内有后续事件才自愈。
- **镜像实例（删除方向）**：`persistProjectBinding` 的空 projectId 分支（移出项目 = 归回默认的主路径）在骨架**之前**提前 return：unlinkSync + `sessionMetaCache.delete` 但**不失效 scanDirCache** → 移出项目后紧跟的广播命中 pre-delete 快照 → session 1s 内又弹回 P 视图。与写入方向对称的用户可见现象。

**缺陷 C（继承语义缺口）：handoff 承接 session 不继承源 project 归属（第二轮审查逼出）**

- 代码实证：`handoff-service.ts:281-286` 承接 session 走 `create(srcCwd, 'handoff from X', { persistLabel, modelOverride, thinkingOverride })`——**不传 projectId**；`session-lifecycle.ts:390-397` 仅 `options?.projectId` 存在时才写内存 + sidecar。
- 用户现象：把 session S 归入 P 后 handoff（换模型/思考等级把工作交接给新 session）→ 承接 session（工作的真正延续体）落在默认项目，源 session 留在 P 显示「已交接」——工作主体反而脱离了用户的逻辑分组。
- 语义不对称佐证：fork 继承归属（lifecycle:835-836，D14 明确「fork 继承父归属」）；handoff 连 cwd 都继承（srcCwd）却唯独不继承纯逻辑分组的 project。
- 修复决策（本设计拍板）：**继承**——handoff-create 透传源 projectId，与 fork、cwd 继承对称。
- **持久性依赖链（第三轮审查补明，属修复的一部分而非隐式巧合）**：承接 session create 时 JSONL 未落盘（pi 惰性写）→ sidecar 写入被 existsSync 守卫跳过 → 内存态 projectId 由 handoff 第 11 步注入 prompt 触发的首个 turn 的 turn_end 兑底落盘（`tryPersistProjectBinding`，session-service.ts:2143-2149，实例级 projectBindingPersisted 防重标记；restore 重建实例标记天然复位，复位后首 turn 同值幂等重写无害；setProject 改归属直接写盘不受标记影响）。**已知失败分支**：注入 prompt 失败（模型 error/pi 崩溃）→ 无 turn_end → sidecar 不落盘 → 重启后承接 session 归属丢失（退回默认项目，活跃期显示仍正确）。此分支本次不修（修复需 handoff 后主动 persist，属另一条链），在此显式声明。

### 2.3 同型历史：为什么说这是结构性弱点

| sidecar | 同型坑与补丁痕迹 |
|---|---|
| `.meta.json` | `persistSessionEnd` 注释 W2-2：曾不失效缓存致显示 idle 而非 stopped → 补 `sessionMetaCache.delete` |
| `.handoff.json` | 注释「写后失效 sessionMetaCache……不失效会命中缓存返回旧值」→ 又补一遍 |
| `.agent.json` | 加了 `invalidateScanDir: true`（注释完整记录了 TTL 窗口问题） |
| `.project.json` | **缺陷 B 写方向**：复用同一骨架没传 `invalidateScanDir` |
| `.project.json` | **缺陷 B 删方向**：空 projectId 分支提前 return，不失效目录缓存 |
| `.project.json` | **缺陷 A 两实例**：restore 不回填内存态；fork 只写 sidecar 不 patch 内存 |
| `.handoff.json` | 写点只失效文件级缓存、不失效目录缓存（同缺陷 B 型，决策 2 一并收敛） |
| （非 sidecar 写点） | **缺陷 C**：handoff-service 调 create 漏传 projectId——同一「人工记得」矩阵的受害者 |

七处遗漏，七次人工记忆。**注释能记录教训，但挡不住下一次**——教训散在 4 个文件的历史注释里，写新代码的人不会主动去读。

### 2.4 根因：同步点组合爆炸

绑定字段的完整生命周期要求（现状无一处集中声明）：

- **字段**（还在增长，scanSessionMeta 已从「三读合一」数到「第六读」）：`projectId` / `launchPresetId` / `spawnSource` / `parentAgentSessionId` / `handedOffTo`（+`outcome` 终态，消费路径不同，另行处理）
- **内存实例重建入口**（每入口语义不同，含派生入口）：`create`（新值来自 options；handoff 承接是它的派生调用，语义=继承源 projectId）/ `restore`（旧值来自扫描 meta，应全量恢复）/ `fork`（选择性继承：preset/projectId 继承，agent binding 刻意不继承）
- **写路径缓存层**：`sessionMetaCache`（文件级）+ `scanDirCache`（目录级 TTL）——写入方必须知道失效几层

5 字段 × 3 入口 × 2 缓存层 ≈ 30 个同步点，全部隐式。**新增第 6 个字段时，正确做法没有任何单一地方可查**。

---

## 3. 解决方案

### 3.1 终态（使用者视角先行）

**用户**：把 session S 归入项目 P 后——点击重开 S（restore）、fork S、handoff 交接 S、快速连续归类另一个 session、重启应用——S（及 fork 产物、handoff 承接 session）始终显示在 P 下；若 S 是 agent 创建的，重开后 badge 仍在。

**开发者**：新增第 6 个绑定字段时，改动集中在一个注册表常量（声明字段名 + 读写 helper + 各入口适用性）；注册表改完，守卫测试自动覆盖各入口与缓存一致性，漏一处测试红。`scanSessionMeta` 旁边只有一行指针注释指向注册表。

失败路径与恢复：若某入口回填语义拿不准（如未来字段的 fork 继承），注册表该入口列必须显式写 `'none'`（不继承）而非省略——省略 = 编译错误（决策 4 键完整性），逼决策显式化。**护栏的能力边界**（第三轮审查收窄）：① 拦「字段维度同步缺失」（登记了但漏回填/漏失效/删整行 → 测试红）与「漏登记」（编译错）；② 拦「入口维度新增派生调用方漏传/多传」（入口清单测试，决策 1b）；③ **不拦「语义定错」**（该继承却写 none、或派生入口该传不传的业务判断错误）——后者靠 review，属人类职责。

### 3.2 方案对比

维度一（止血全部实例）无方案分歧，均为最小修复（见 §5 拆分 unit 1/2）。有分歧的是维度二：**防再发机制选型**——用户核心问题「护栏 or 注释」。

| | 方案 A：注释 checklist | 方案 B：统一回填函数 + 默认失效 + 回归测试 | **方案 C（推荐）：绑定字段注册表（表驱动 SSOT）+ 统一回填 + 默认失效 + 矩阵守卫测试** | 方案 D：广播强制 force 重扫 |
|---|---|---|---|---|
| 形态 | 在 scanSessionMeta / persistBindingSidecar 写「新增字段 checklist」注释 | 手写 `applyBindingMeta(session, meta)`，三入口调用；`invalidateScanDir` 改默认开；测试锁已知字段（projectId 等）不回归 | `BINDING_FIELDS` 常量表：每字段声明 `{ read, persist, hydrate 入口适用性 }`；回填函数与守卫测试**从表生成**；`invalidateScanDir` 默认开 | listPersistedSessions 每次绕过 TTL 全量扫 |
| 长期架构合理性 | ✗ 差。§2.3 已证明注释挡不住第 4/5 次 | △ 中。同步点收敛到 1 函数，但「新字段忘了进函数」仍无守卫（测试只锁已知字段） | ✓ 好。单一 SSOT：字段加入表后全部同步点自动获得；测试从表生成用例，漏同步 = 红 | ✗ 差。TTL 缓存存在的意义（1s 窗口内零 IO）被整体放弃，列表刷新频率高时退化为每秒全量扫 |
| 短期实现成本 | 最低（半天） | 低（~50 行 + 测试） | 中（~150-200 行：表 + 回填 + 测试改造，一次到位） | 极低（一行），但性能回退 |
| 风险 | 无实现风险，高复发风险 | 低；守卫覆盖不全的风险仍在 | 中低：表驱动抽象需防过度设计——本设计把表限制为「声明数据 + 纯函数」，不搞运行时行为生成 | 高（G3 目标直接违背） |

**推荐 C**，B 是 C 的退化子集（无表、测试手写），D 否决。A 作为 C 的补充而非替代：注册表处保留一行 checklist 指针（引导新字段作者去表里登记），但防线是测试不是注释。

**若用被否方案**：A——D14 当时的作者面对的注释环境与今天完全相同（历史教训都在），照样漏了两处；B——下一个新增字段（比如未来的 `.star.json` 收藏标记）作者漏进 `applyBindingMeta`，测试只锁 projectId 不锁新字段，bug 静默上线，回到今天。D——§2.1 读路径每秒全量 statSync+读文件，session 多时列表广播开销线性放大，且 TTL 缓存的设计注释（wave:perf-w26）明确是为列表消费方服务的。

### 3.3 关键决策与权衡

**决策 1：内存回填统一走「绑定字段注册表」，入口适用性显式声明**

- 选择：`BINDING_FIELDS` 表（`session-file-utils.ts` 或独立模块）声明每个字段的 `{ hydrate 入口: 'create' | 'handoff' | 'restore' | 'fork' | 'none', 回填语义 }`（handoff 是独立通道而非 create 的注释性变体——见下方矩阵）；`hydrateBindingMeta(session, meta, entry)` 按表把 meta 中的字段 patch 到内存实例。
- **meta 参数数据源归一化**：函数只做「按表 patch」，不关心 meta 怎么来——调用方各自组装：restore 传自身扫描 meta（`findScannedSession` 结果六读合一全字段，直接可用）；fork 传源继承值集合（入口已解析，如 `{ launchPresetId: forkPresetId, projectId: forkProjectId }`）；create 从 options 组装（如 `{ projectId: options?.projectId }`，handoff 承接传 `{ projectId: 源 projectId }`）。三入口三数据源在调用方归一，hydrateBindingMeta 保持单一职责。
- 被否：各入口继续逐字段 patch（现状，漏源）；完全放弃内存态、广播永远读扫描（活跃实例的性能与实时性价值丢失，且扫描对未落盘 session 无能为力）。
- 证据：fork × agent binding 的「刻意不继承」证明入口语义确有差异——收敛不等于一刀切，必须让差异在表里显式。
- 矩阵现状基线（表的初值；**4 列与 FieldSpec 入口枚举一一对应**，每列都有结构承载；加粗 = 修复点，其余来自现状代码语义）：

| 字段 | create | handoff-create（承接） | restore | fork |
|---|---|---|---|---|
| `launchPresetId` | options.presetId | 无（源 preset 已消费，现状保持） | meta（fallback builtin:full，留在入口） | 源继承 + 内存 patch（现状已对） |
| `projectId` | options.projectId | **源继承（C 修复点：透传源 projectId，现状漏传）** | **meta（A-1 修复点）** | **源继承 + 内存 patch（A-2 修复点：现状只写 sidecar 漏内存）** |
| `spawnSource` / `parentAgentSessionId` | options | 无（现状保持，防漂移显式声明） | **meta（同型修复）** | none（刻意不继承，lifecycle:872） |
| `handedOffTo` | 无（新 session 未交接） | 无（承接者自身未交接，现状保持） | **meta（同型修复）** | none（fork 不写 handoff sidecar，现状保持） |

**决策 1b：入口维度守卫——create 派生调用方清单测试（第三轮审查补）**

- 背景：缺陷 C 本身是入口维度的失败（handoff 作为 create 的派生调用方漏传 projectId），三层字段护栏对「未来第 4 个派生调用方漏传/顺手多传绑定参数」原不设防——G2 承诺与机制覆盖不匹配。
- 选择：注册表旁维护 `sessionService.create` 派生调用方清单（当前两项：lifecycle 主流程、handoff-service），守卫测试静态扫描源码中 `create(` 调用点集合 vs 清单登记数，新增未登记调用点 = 测试红；已登记调用方逐项断言其传参与矩阵 handoff/create 列一致（handoff 只传 projectId，不传 spawnSource 等——把「防顺手继承漂移」从文档表格升级为测试承诺）。
- 被否：create options 类型收紧（projectId 上移为显式语义参数）——侵入 create 公共签名，影响面大；仅靠 review——缺陷 C 已证不可靠。
- 边界：静态扫描无法拦「调用方语义定错」（如未来模板克隆入口该不该继承 projectId 传错），仍属 review 职责（§3.1 边界③）。

**决策 2：`invalidateScanDir` 改为写点默认行为，覆盖骨架与 handoff/meta 自维护写点**

- 选择：① `persistBindingSidecar` 骨架默认失效目录 TTL（未来确有不失效理由时显式 `{ invalidateScanDir: false }` + 注释）；② `persistProjectBinding` 空 projectId 删除分支补 `invalidateScanDirCache()`（堵删除镜像）；③ `persistHandoffSidecar` / `persistSessionEnd` 补目录缓存失效（同型历史受害者一并收敛，消除「骨架内外两套失效纪律」——也是守卫测试规格自洽的前提）。
- 被否：维持 opt-in + 各写点自维护（现状，缺陷 B 三个实例的漏源）。
- 论证：binding 写点（preset/project/agent）唯一列表消费方是扫描，写后不失效无正当场景，成本 = 写后首扫多一次全量 statSync（1s 内本就会发生，增量 ≈ 0）。**`persistSessionEnd` 的频率修正**（第二轮审查）：它不是「session 终止」低频写点而是**每 turn 写点**（agent_end → `handleTurnEndSideEffects` 无条件调，`session-service.ts:1568-1581`；终态去重仅 onSessionExit 路径），补目录失效后活跃会话每 turn 触发一次全量重扫——但量级可控（sessionMetaCache 命中时仅 readdir + stat，50 session ≈ 1-2ms，A6 覆盖），且「骨架内外两套纪律」正是本设计要消除的漏源，一致性优先；曾评估 opt-out（outcome 迟到 1s 用户无感）并否决，若未来 turn 频率极端场景下 A6 退化再回头评估。G3 不受损。

**决策 3：守卫测试从注册表生成，断言锚定外部事实（非表自身）**

- 选择：测试遍历 `BINDING_FIELDS` × 入口（含决策 1b 的 handoff 通道）× 写/删双向，但**期望值不从表读**（防自指：改表同步改预期 = 静默绿）。① 入口回填断言：测试夹具预先在磁盘写好 sidecar / 预先构造源 session 归属（**外部事实**），模拟入口重建实例后断言 `listPersistedSessions()`（TTL 模式）中该字段值 === 夹具预置值——矩阵值只决定「该字段在该入口是否应有值」，期望值锚定夹具；② 缓存一致性断言：写/删 sidecar 后立即 TTL 模式扫描，值必须已更新（锚定「写后立即可见」这一外部行为，与表无关）。字段清单从表读（决定用例覆盖面），新增字段登记即自动获得用例。**夹具纪律**（防误红）：sidecar 预写必须先于该文件同进程内首次扫描，或统一经 persist* helper 写入（自动失效文件级 sessionMetaCache）——`force:true` 只绕过目录缓存，不绕过文件级缓存，裸 fs 写 sidecar 后直接 restore 会读到 stale meta。
- 被否：手写 projectId 专项回归（锁不住未来字段）；断言写「与矩阵预期一致」（自指，A5 变异会静默绿）。
- 探针（运行时断言）：
  - ✅ 已测：缺陷 B TTL stale（§2.2 探针输出，写 sidecar 后 TTL 模式扫描返回旧值）
  - ⛔ 实施期门：restore 后 `getSummary().projectId === 夹具预写 sidecar 值`；fork 后新 session 活跃期 `getSummary().projectId === 源归属预置值`；handoff 承接后 `getSummary().projectId === 源归属`（等 unit 2 落地后以 vitest 跑，不依赖 Electron 环境）

**决策 4：护栏分两层——类型键约束（编译期，全可选键提取）+ 否决全表驱动重构**

- 采纳（两轮审查迭代）：`BINDING_FIELDS` 的键从 `ScannedSessionMeta` 的**全部可选字段**派生（不限定 string）：

```ts
type OptionalKeys<T> = { [K in keyof T]-?: undefined extends T[K] ? K : never }[keyof T]
type BindingFieldKey = Exclude<OptionalKeys<ScannedSessionMeta>, 'parentSession' | 'forkEntryId'>
export const BINDING_FIELDS: Record<BindingFieldKey, FieldSpec> = { ... }
```

  排除集 { parentSession, forkEntryId }（header 派生字段，经核实即全集——`ScannedSessionMeta` 可选字段仅 7 个 = 2 排除 + 5 绑定；〔设计时快照〕composer-model-session-isolation D1 后终态 9 个 = 2 排除 + 7 绑定，新增 modelId/thinkingLevel 经 `ModelBindingFields` extends 收编，见 `session-binding-fields.ts` 注册表注释）。给 `ScannedSessionMeta` 新增第 6 个绑定字段而未登记表 = **编译错误**，对任意类型（boolean/timestamp/枚举）的字段都生效——第一轮草案的 `T[K] extends string | undefined` 写法会静默放过非 string 字段（而本设计 §3.2 自举的威胁模型例子 `.star.json` 收藏标记恰可能是 boolean），已否决。「新字段必经之路」正是 scanSessionMeta 填充 meta，此守卫卡在必经之路上。
- 残余边界（诚实声明）：**必填字段不受保护**（如未来某绑定字段被误声明为必填）——绑定字段天然可选（sidecar 缺失 = undefined），误声明必填会在 `scanSessionMeta` 构造处理想类型冲突，但非编译硬错；此边界写入 unit 4 的 checklist 注释。
- 被否的更强形态：`ManagedSession` 实例字段 / toSummary 输出也从表派生（全表驱动重构，编译期覆盖所有同步点）。
- 理由：当前 5 字段规模全表驱动重构收益/成本比不成立；类型键约束以 ~15 行拿到「漏登记」这一最大风险面的编译期拦截；字段增长到 ~8+ 或出现第二类消费方时再升级，届时注册表是平滑过渡的中间态（数据结构已就位，只扩大类型派生范围）。

---

## 4. 验收（真实场景，非单测）

| # | 场景（谁在什么上下文做什么看到什么） | 回溯目标 | 通过标准 |
|---|---|---|---|
| A1 | 用户在 dev app（独立数据目录）把 session S1 归入项目 P；重启 app（S1 变磁盘态）；点击 S1 重开（触发 restore）；等待 2s（列表广播） | G1 | S1 仍显示在 P 视图下，未落入默认项目聚合 |
| A2 | 用户把 S1、S2（两个不同目录）在 1s 内连续归入 P | G1 | 两者都稳定出现在 P 视图（无闪退回默认项目） |
| A3 | 承接 A2，重启 app | G1 | P 视图下 session 集合与重启前一致 |
| A4 | agent 创建的 session（spawnSource=agent）重开后；另重开一个已交接（handedOffTo 非空）的 session | G1 | badge（agent 标记）仍显示；「已交接」标记仍显示 |
| A7 | 项目 P 下的 session S，fork 后**不重启不切走**立即看侧栏 | G1 | fork 新 session 立即显示在 P 视图（活跃态即正确，非重启后恢复） |
| A8 | agent session（带 badge）fork 后看新 session | G1 | 新 session **不带** agent badge（锁定 fork×agent binding = none 语义，防「顺手继承」回归） |
| A9 | 用户把 session S 从项目 P **移出**（归回默认项目） | G1 | S 立即从 P 视图消失、出现在默认项目，无 1s 内弹回 P 的闪烁 |
| A10 | 项目 P 下的 session S，handoff 交接（换模型把工作交给新 session）后看侧栏；承接 session 跑完首个 turn 后**重启 app**再看 | G1 | 活跃期：承接 session 显示在 P 视图，源 session 留在 P 并显示「已交接」；重启后：承接 session **仍在 P 视图**（验证 turn_end 兑底链落盘，见 §2.2 缺陷 C 依赖链说明） |
| A11 | handoff 注入的 prompt 失败（模型 error）后重启 app 看承接 session | G1 | 归属退回默认项目（已知失败分支，本文档显式声明不修；验证声明与行为一致，防未来误报为回归） |
| A5 | 开发者做四类变异后跑守卫/编译，验证护栏本身有效：**变异 1**（同步缺失）：删掉 `hydrateBindingMeta` 中 projectId 的 restore 回填实现（表不动）；**变异 2**（漏登记）：给 `ScannedSessionMeta` 加新可选字段但不在注册表登记，跑 typecheck；**变异 3**（缓存失效缺失）：把决策 2 默认失效改回 false；**变异 4**（入口维度）：新增一个 `sessionService.create` 调用点但不登记进派生调用方清单 | G2 | 变异 1：回填断言红（期望值锚定夹具预写 sidecar，非表值）；变异 2：**typecheck 编译错**；变异 3：写后立即可见断言红；变异 4：入口清单静态扫描断言红。四类变异全部被拦（不含「语义定错」变异——该继承却写 none 属业务判断，护栏明示不拦，见 §3.1 能力边界） |
| A6 | 对照修复前基线：列表广播延迟（写 sidecar 后首扫耗时，session 数 ~50）；活跃会话连续多轮 turn（每 turn 触发 persistSessionEnd 重扫）下侧栏刷新 | G3 | 探针测首扫耗时差值 <10ms 量级（对比修复前基线）；人工操作无可感知卡顿 |

- A1-A4/A7-A11 在 `pnpm dev` + 独立 `XYZ_AGENT_DATA_DIR` 下人工操作验证（涉及真实 pi 进程 spawn 与 UI，不适合 mock）；A5/A6 是 CI 测试、typecheck 与探针，实施期落地。
- 每个场景回溯：A1-A4/A7-A10 → G1（不消失/不回退/继承语义正确/反向语义保持），A11 → G1 失败分支声明一致性，A5 → G2（护栏各自拦截对应变异），A6 → G3（性能不回退，含每 turn 重扫频率修正后的验证）。

---

## 5. 下一层拆分

| unit | 内容 | justification（为什么这么拆） | 文件 | 验收对应 |
|---|---|---|---|---|
| 1 | 缓存失效收敛三件套：`persistBindingSidecar` 默认开（opt-out 化）+ `persistProjectBinding` 空 projectId 删除分支补 `invalidateScanDirCache()` + `persistHandoffSidecar`/`persistSessionEnd` 补目录失效 | 缺陷 B 全部实例止血，独立成立、纯 session-file-utils 单文件改动先行落地，不依赖后续单元 | `session-file-utils.ts` | A2 / A9 / A5(变异 3) |
| 2 | `BINDING_FIELDS` 注册表（类型键从 ScannedSessionMeta 全可选键派生，入口枚举含独立 handoff 通道）+ `hydrateBindingMeta` 统一回填，接线 create/handoff 承接/restore/fork 四入口（含 fork 补 projectId 内存 patch、handoff 透传源 projectId）+ 决策 1b 派生调用方清单 | 缺陷 A 两实例 + 缺陷 C 的止血与结构收敛是同一份代码（先最小修再收敛 = 写两遍被覆盖的代码）；fork/agent/handoff 语义差异在表中显式保留且每列有结构承载 | `session-file-utils.ts`（表+类型）、`session-lifecycle.ts`（入口接线）、`handoff-service.ts`（承接 create 透传） | A1 / A4 / A7 / A8 / A10 |
| 3 | 守卫测试：表生成用例（入口 × 字段 × 写/删双向，断言锚定外部夹具事实）+ 决策 1b 入口清单静态扫描 | 测试夹具/扫描工具可先行搭建；表驱动用例依赖 unit 2 的 `BINDING_FIELDS` 导出（import 依赖，不可先于 unit 2 存在） | `packages/runtime/src/__tests__/`（新文件） | A5(变异 1/3) |
| 4 | 注册表 checklist 指针注释（`scanSessionMeta` 处，含决策 4 残余边界：必填字段不受编译保护）+ 本文档评审意见收口 | 文档性收尾，零风险 | `session-file-utils.ts` 注释 | — |

顺序建议：1 → 2 → 3 → 4（1 先行因最小且独立；3 的夹具可先行、表驱动用例在 2 完成后立即落地）。**待验证检查点**：unit 2 接线 fork 入口时，确认「fork 不继承 agent binding」的防御性清理（lifecycle:872 unlink）与回填 none 语义不冲突（一个删 sidecar、一个不回内存——语义一致但需测试锁定，A8 场景）；handoff 承接透传源 projectId 时，确认源 session 无归属（undefined）时行为与现状一致（不写 sidecar，归默认）；fork 补 projectId 内存 patch 后，确认 handoff 等后续流程对新 session `getSummary()` 的消费无 projectId 假设依赖。

---

## 附：与架构约束登记表的关系

实施时若本设计确立「绑定字段注册表 SSOT」，应在 `docs/constraints.json` 登记（scope=runtime，权威源=注册表文件，执行方式=矩阵守卫测试），并跑 `node scripts/render-constraints.mjs` 重新生成 md。
