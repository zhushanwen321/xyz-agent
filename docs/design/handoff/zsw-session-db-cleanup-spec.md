# zsw 侧会话库清理交接规格（W5b 投递物）

| 项 | 值 |
|----|----|
| **owner** | zhushanwen |
| **投递日期** | 2026-09-09（本合入批次） |
| **投递形态** | 本仓内 handoff 文档。跨仓登记已降为「投递动作」：本文件即仓内登记（owner + 投递日期如上）；zsw 侧认领、re-vendor 排期与实施归 zsw 仓（z-code-plugin-workspace），本仓不做跨仓操作 |
| **路径契约权威源** | `packages/zcode-subagent-cli/src/db-path.ts`（引擎包化后随包迁移；源 impl-plan W1 交付，原 core 路径已于 2026-09-09 W11 删除） |
| **规格来源** | 设计文档 `docs/design/zcode-session-db-isolation.md` §2.4.3（第二宿主 zsw）+ §3.2 D7（清理通道）；实现级契约 `docs/design/zcode-session-db-isolation.impl-plan.md` §2.5（清理工具）+ §2.6（W5b 消费方式钉死） |
| **读者** | zsw（z-code-plugin-workspace）仓维护者。本文件自包含，无需读 xyz-agent 会话上下文 |

## 0 背景（自包含所需最小上下文）

1. **隔离设计**：xyz-agent 的 subagent-core 中，zcode 引擎走「app-server 常驻 + 共享宿主 HOME」形态。2026-09 会话库隔离改造（本仓分支 `fix-subagent-zcode-session`）在 spawn env 里覆盖式写入 `ZCODE_SESSION_DB_PATH`，把引擎会话库从宿主 `~/.zcode/cli/db/db.sqlite` 隔离到 `<engineDataDir>/engines/zcode/session-db/db.sqlite`，使 subagent 会话不再进入 ZCode GUI 侧边栏。HOME 保持共享（凭据 / 插件 / MCP / pnpm store 语义零变化）。
2. **zsw 是第二宿主**：zsw 消费的 subagent-core 是 **vendored 副本**（zsw 仓 `lib/vendor/subagent-core/`，由 zsw 仓 `scripts/vendor-subagent-core.js` 刷新 + `VENDOR-MANIFEST.json` 溯源；zsw `lib/core-ref.js` 头注明确「三形态都没有 node_modules 解析面」）。因此隔离**不是自动继承**：zsw 必须引入含本改造的版本并发版，其新会话才落隔离库。**（2026-09-09 W11 更新**：隔离实装已随 zcode 引擎外移至独立包 `@zhushanwen/zcode-subagent-cli`——subagent-core 内建 `engines/zcode/` 已删除，zsw 的版本门槛相应 = 引入含本改造的 zcode 引擎包，消费方式见 §4。**）**
3. **清理缺口**：隔离后，zsw 现有 `doctor clean` 硬编码宿主库（`lib/config.js` 的 `engineDbPath = <cliRoot>/db/db.sqlite`）→ 对新隔离库**恒 0 命中** → zsw 需自行扩展清理以覆盖自己的隔离库。本文件给出路径语义（§1）、清理面判定（§2）、清理工具 CLI 契约（§3）、消费方式边界（§4）与验收点（§5）。

---

## 1 SSOT：隔离库路径语义

### 1.1 路径公式与权威源

唯一权威是本仓 `db-path.ts` 的构造函数（**禁止任何消费方手拼路径字面量**，与 `resolvePoolDir` 同款纪律）：

```ts
// packages/zcode-subagent-cli/src/db-path.ts
export function zcodeSessionDbPath(engineDataDir: string): string {
  return path.join(engineDataDir, "engines", "zcode", "session-db", "db.sqlite");
}
```

即：**`zcodeSessionDbPath(engineDataDir) = <engineDataDir>/engines/zcode/session-db/db.sqlite`**。

- 入参 `engineDataDir` = 引擎数据目录（引擎内部由 `deps.engineDataDir()` 提供）。**路径一律由入参推导，禁硬编码**。
- 选址在池目录之外（不落 `engines/zcode/shared/`——那是 journal 池目录）。journal 路径不变（仍 `engines/zcode/shared/journal-<taskId>.jsonl`）；清理时 journal 不属清理对象（生命周期跟随 record）。
- `db.sqlite` 在磁盘上通常伴随 SQLite WAL 三件套 `db.sqlite` + `db.sqlite-wal` + `db.sqlite-shm`；涉及删除/备份时三件套视为一个整体。

### 1.2 zsw 侧路径（示例值，非权威）

zsw 侧 engineDataDir 按其自身引擎数据目录推导。设计期实测口径：zsw re-vendor 后新会话落
`~/.zcode/zsw/engines/zcode/session-db/db.sqlite`（即示例 `engineDataDir ≈ ~/.zcode/zsw/`）。
**该值仅为示例**——zsw 侧最终以 re-vendor 后 vendored core 实际运行时的 `engineDataDir` 为准，
判定方式见 §5 验收点 1（实际路径 == 公式推导值）。

### 1.3 相关契约面（zsw 清理判定会用到）

| 符号（均在 `db-path.ts`） | 签名 | 语义 |
|--------------------------|------|------|
| `zcodeSessionDbPath` | `(engineDataDir: string) => string` | 隔离库路径，唯一现役写入路径 |
| `hostZcodeDbPath` | `() => string` | 存量兼容锚点：`join(homedir(), ...ZCODE_HOST_DB_SUFFIX)` ≈ `~/.zcode/cli/db/db.sqlite`。隔离改造后定位降级——仅用于放行「共享 HOME 时代」（2026-09 至改造合入）落盘的宿主绝对路径 record；**新写入不走此路径** |
| `zcodeDbPathAllowlist` | `(dataDir: string) => readonly string[]` | ①级读取的封闭白名单集合 `[隔离库（现役）, 宿主库（仅存量兼容）]`。zsw 侧若自建清理工具需要「哪些 db 路径是合法会话库」判定，应复用同款封闭集合语义，不做开放匹配 |

env 契约（vendored core 的 zcode 引擎组装段自带，zsw re-vendor 后无需额外接线）：spawn env **覆盖式写入** `ZCODE_SESSION_DB_PATH`（忽略宿主继承值）并**显式清空同层别名键 `ZCODE_SESSION_DB`**（实装里两者都映射到 `storage.sessionDbPath`，按 env 键序后写胜出——必须显式化，不靠顺序巧合）。

---

## 2 zsw 需自行清理的面与判定（设计 §2.4.3 分析结论）

### 2.1 继承时序（写实）

xyz-agent 合入本改造 → core 版本 bump → zsw re-vendor（**版本门槛 = 含 `db-path.ts` 的 zcode 引擎包版本**——2026-09-09 W11 起 `db-path.ts` 随引擎包迁移至 `@zhushanwen/zcode-subagent-cli`，core 副本不再含该文件；以 zsw 仓 `VENDOR-MANIFEST.json` 溯源核对）→ zsw 发版 → zsw 新会话才落隔离库。在此之前 zsw 继续写宿主库（`lib/config.js` 硬编码）。

**观测前提**：re-vendor 之前，「zsw 侧隔离库 > 1GB」的观测对象**不存在**（隔离库路径上还没有 zsw 的行），相关阈值判断必须带此前置，否则条件永不触发造成误判。

### 2.2 三个面的归属与判定

| 面 | 内容 | 清理归属 | 判定 |
|----|------|---------|------|
| **面 A：zsw 自己的隔离库** | re-vendor 后 zsw 会话落 `zcodeSessionDbPath(zsw engineDataDir)`；该库归 zsw 独占（GUI 不认该路径，全部行都是 zsw 的） | **zsw 自行清理** | zsw `doctor clean` 硬编码宿主库 → 对该库恒 0 命中；zsw 须扩展清理链路覆盖新库（见 §5 验收点 2）。库可整删重建（删 `db.sqlite*` 三件套，引擎下次启动重建），但删库 = 库内会话历史丢失——按 §3.8 停机窗口纪律操作 |
| **面 B：zsw 历史行在宿主库** | re-vendor 前 zsw 写入宿主 `~/.zcode/cli/db/db.sqlite` 的行 | **zsw 现有通道** | zsw `clean-identify.js` 三类识别集（`task_type='subagent_child'` 按龄 / 自身 records 白名单 / 特征目录闭集）对 zsw 自己的行继续适用；本改造不改变该通道行为 |
| **面 C：xyz-agent 的宿主库存量行** | xyz-agent 改造前写进宿主库的会话行（设计快照 50 条 + 派生 4 条；数值为快照，复测值漂移属预期） | **xyz-agent 本仓 W5a 清理工具**（§3） | zsw **不触碰**。双向误删面为 0：zsw 识别集从未能识别 xyz-agent 的行（xyz-agent 行是 `interactive` + 普通 worktree 路径，不在 zsw 三类识别集内），反之亦然 |

### 2.3 误删面口径（不许反向主张）

实测证明：zsw `clean-identify.js` 的三类识别集**从未能识别 xyz-agent 的行**（改造前后命中概率同为 0）。因此本隔离设计**不主张**「隔离也隔离了误删面」——隔离只改变写入位置，不改变双方识别集的互不相交性。

### 2.4 观测与重审触发条件（带前置）

- **zsw 已完成 re-vendor** 且其隔离库 > 1GB，或 zsw 用户报告磁盘异常 → 启动清理；
- **每次 zsw re-vendor 时校验两项**（否则缺口静默存在）：① 其隔离库实际路径 == `zcodeSessionDbPath` 推导值；② 清理工具已覆盖新库。

---

## 3 清理工具 CLI 契约（对齐 impl-plan §2.5）

### 3.1 工具定位与 zsw 侧的关系

- 本仓工具 = `scripts/zcode-session-db-cleanup.mjs`（清理对象 = **xyz-agent 侧**三库：宿主库 + GUI 索引库 + xyz-agent 隔离库）。**W5a 已落地**（commit ee55740dc，随本规格同批入库；测试 `scripts/__tests__/zcode-session-db-cleanup.test.mjs` 17 用例）——以脚本自身 `--help` 与实现为实现级钉死点（本节契约以 impl-plan §2.5 为设计权威文本）。
- **zsw 侧对等物**：zsw 面对的是自己的隔离库（无跨库索引面——GUI 索引库只同步宿主库路径的会话，zsw 隔离库不进索引），复杂度低于本仓工具。zsw 可参考本节判据自建，或 vendor 本工具后裁剪。无论哪种，§3.8 停机窗口纪律与 §3.5 凭证机制必须等价满足。
- 术语 gloss（设计文档定义，此处沿用）：**①级 = 读引擎原生会话存储**（内容最全）；record = 引擎任务落盘的 append-only JSONL（**不可信面**）。

### 3.2 识别基准与解析路径

- 白名单 = 自身 record 存储的 `engineHandle.sessionRef.sessionId`（**我们知道自己的 id**）。
- 解析路径：只解析 `type='custom' && customType='subagent-record'` 的结构化 entry；**禁止对 JSONL 行做文本/正则提取**（record 是不可信面）。
- 结果做「id 形状校验 + 宿主库存在性」双过滤。

### 3.3 四条判据（违者中止或剔除，不是告警）

| 判据 | 内容 | 作用域 |
|------|------|--------|
| **I1 双计数** | 四数分列：白名单总数 / 白名单∩宿主库（=直接删除集）/ 派生删除集 / 删除集总数；断言「删除集 == 独立参照 SQL 结果」（跨双库单一文本，禁止工具自算即权威） | 全局 |
| **I2 时间戳交叉验证（硬中止）** | record `data.startedAt` 与宿主行 `time_created` 差值 ≤ **10s**（**全局唯一常量**，禁止多处写字面量）；取不到或超容差 → 中止并报告该 id | 直接删除集 |
| **I3 形态硬中止** | 任一行 `task_type != 'interactive'` 或 `title_source='custom'` → 中止 | 直接删除集 |
| **I3b 派生集不变量** | 每行必须满足 `parent_id ∈ 直接删除集 且 task_type='subagent_child'`，违反即中止 | 派生删除集 |

依据（为什么是跨源时间戳而非字段长相）：实测用户会话与我们的行在 `task_type`/`title_source` 上完全同分布，字段式判据拦不住；record 无目录字段，目录维度不可作硬判据。

### 3.4 CLI 参数

| 参数 | 语义 |
|------|------|
| `--confirm-count <N>` | 受控非交互旁路：`N` 必须**精确等于删除集总数**（主路径）；replay 模式下 `N` = 残留清单条数（防陈旧清单）。错值 → 拒绝 |
| `--replay-residue <file>` | 补删模式：读入残留清单文件逐 id 补删。清单文件由工具产生，命名 `w5-residue-<ts>.json` |

replay 前置断言（全部通过才执行）：逐 id 形状校验 + 索引库 `tasks` 存在性校验 + 复用索引预检四冲突源（命中 → 跳过并报告，**不删**）+ `--confirm-count <清单条数>` + 逐 id 断言宿主行确不存在（否则拒绝，提示先对齐两库备份状态——防制造「索引已删、宿主残留」反向中间态）。

### 3.5 执行形态与凭证机制

1. 交互式确认：stdin 输入「删除集总数」（精确数字，非 y/n）；
2. 非 TTY 且无 `--confirm-count` → **拒绝**（本仓现实：运维/AI agent 跑 bash 天然非 TTY；不存在笼统 `--yes`/`--force` 旁路）；
3. 报告置顶汇总异常信号（I2 中止项 / I3 命中 / 索引预检命中 / SET NULL 越行修改计数）；
4. **确认凭证落盘**：输入短语 + 操作者 + 时间戳 + 授权来源（破坏性操作的审计锚）。

### 3.6 退出码语义

成功 = 0；拒绝（参数/确认不匹配、非 TTY 无凭证）与中止（I2/I3/I3b 命中、停机窗口检查不过、replay 前置断言失败）= 非 0。**具体数字退出码 §2.5 未钉死**，由 W5a 实现钉死并在脚本 `--help` 声明；zsw 侧编排（若参考自建）以「可区分『成功 / 拒绝 / 中止』三态」为最低要求。

### 3.7 删除面与跨库顺序

- 宿主库：`session` 行 + 11 张带 FK 引用表（12 个 FK 列）按 FK 依赖序 + `PRAGMA foreign_keys=ON`（连接级开关，不写则级联静默失效）+ `input_history` 显式删（无 FK、无间接级联）+ 派生行纳入；宿主库**不**预计算冲突源表（FK 兜底）。
- 索引库（GUI `~/.zcode/v2/tasks-index.sqlite`）：**零 FK 到 `tasks`** → 四冲突源（`task_group_members` / `automations.target_task_id` / `off_peak_tasks.session_id` / `tasks.off_peak_task_id`）**只读预检必须保留**，命中 → 两侧同时剔除该 id；删除面只 `tasks` + 姊妹表。
- **跨库顺序固定：每 id 先宿主后索引** → 中间态只可能是「宿主已删、索引残留」（可恢复方向）；删除失败的残留 id 落盘 `w5-residue-<ts>.json`，经 `--replay-residue` 补删。
- 3 个 `ON DELETE SET NULL` 越行修改（`session_task_link.parent_session_id` 等）与「只删白名单命中行」不同口径，执行后须报告被改行数。

### 3.8 备份与停机窗口（zsw 直接相关）

- **备份 = 三库整库快照**（宿主库 + 索引库 + 隔离库），**回滚粒度 = 整库还原**（无单行回滚）。量级参考（快照值）：宿主+索引两库三件套实测 3.07GB；隔离库另计（量级 ≈0.3–0.4MB/会话）。执行前检查可用空间 ≥ 峰值 ≈9GB（备份 3GB + 可选 VACUUM ≈2×）。
- **删行不回收磁盘**（文件不缩小；VACUUM 可选、须窗口内独占访问、分钟级）。
- **窗口写者清单**（①③ 硬停 = 确定性可验证；②④ 尽力检查 = 只证明检查时点无匹配）：

| # | 写者 | 动作 |
|---|------|------|
| ① | 本仓 pi/runtime 宿主（xyz-agent） | 停——硬停 |
| ② | **zsw**（第二宿主） | **可执行判定**：zsw 2.0+ 为 CLI 一次性进程、无常驻 daemon，「停用进程」不可执行 → **窗口开始前**执行 `pgrep -flE "zsw|zcode.*app-server"`（覆盖 zsw CLI 与其在途 app-server 子进程）**断言空输出**；非空 → **中止窗口启动**并列出全部命中进程（等其终态或由操作者按进程级精确定位处理后重跑检查）。实施期以真实在途进程核验画像后钉死 |
| ③ | ZCode GUI | 关闭——硬停 |
| ④ | 用户手动终端 zcode CLI 进程 | 提示用户窗口内无在途 zcode 终端会话 |

**对 zsw 的义务（投递语境）**：xyz-agent 侧执行本工具时，zsw 是清单②的检查对象——窗口内 zsw 侧须无在途任务。zsw 侧若自建对等清理工具，须把同样清单映射到自己的宿主面（含对 xyz-agent 宿主与 GUI 的硬停要求），不得缩减。

---

## 4 消费方式钉死（impl-plan §2.6，边界声明；2026-09-09 W11 引擎包化后全量修订）

**权威源迁移**：`db-path.ts` 已随 zcode 引擎外移至独立包 `@zhushanwen/zcode-subagent-cli`（`packages/zcode-subagent-cli/src/db-path.ts`）；subagent-core 内建 `engines/zcode/` 目录已删除（W11），zsw 的 vendored core 副本自该版本起**不再包含** `db-path.ts`——按旧深路径（`lib/vendor/subagent-core/src/execution/engine/engines/zcode/db-path.ts`）接线会直接失败。

**zcode 侧两种受支持形态**：

1. **npm 包导入**：`@zhushanwen/zcode-subagent-cli` 根 barrel 直接导出三个构造函数——`src/index.ts:18`：`export { zcodeSessionDbPath, zcodeDbPathAllowlist, hostZcodeDbPath }`；package.json `exports "."` → `src/index.ts`（2026-09-09 于本仓实证）。有 node_modules 解析面的消费方（zsw 仓内 node 脚本 / 构建期工具等）优先此形态；
2. **vendored 整包源码导入**：按设计 §3.7（protocolization W9「zsw vendor 增引擎包目录」，owner = zsw 仓）把**引擎包**整包 vendored，深导入 `<zsw 仓>/lib/vendor/zcode-subagent-cli/src/db-path.ts`。

**pi 侧仍以 vendored 深导入为准**：zsw 的 pi 插件三形态（inline 直载 / marketplace 副本 / npm 包内容）都没有 node_modules 解析面（其仓 `lib/core-ref.js` 头注自证），运行期 vendored 副本内的源码深路径仍是唯一可接线方式；zsw 侧路径解析权威 = 其仓 `lib/core-ref.js` 单一解析点 + `VENDOR-MANIFEST.json` 溯源。

**原「npm 安装形态不可达」三条依据的现状改写**（原文逐条锚定 subagent-core，已随引擎包化全部失效；2026-09-09 逐条复核）：

1. 旧据 1（core `package.json` exports 无 db-path 子入口）：对 core 不再成立也不再相关——函数已不在 core；对 `@zhushanwen/zcode-subagent-cli` 不成立（`exports "."` 经根 barrel 导出三函数）；
2. 旧据 2（根 barrel 不导出 `zcodeSessionDbPath`）：失效——zcode 包根 barrel `src/index.ts:18` 直接导出三函数；
3. 旧据 3（`zcode-engine.ts:89` 模块级 re-export 不经 barrel 透出）：失效——三函数已经根 barrel 透出，npm 消费可达。

**仍成立的部分**：pi 域（`@zhushanwen/pi-subagent-cli`）与 zcode 路径契约无关——该包 `exports` 仅 `"."` 且包内无 `db-path`/`zcodeSessionDbPath` 符号（2026-09-09 grep 核实），zcode 路径契约的 npm 消费只能走 `@zhushanwen/zcode-subagent-cli`；「zsw 插件运行形态无 node_modules 解析面」的现状陈述对 pi 宿主面仍然成立。

**禁止**：绕过构造函数手拼路径字面量（§1.1 纪律）；只拷公式不拷函数实现（丢失权威源单一性）；向 vendored core（subagent-core 副本）寻找 `db-path.ts`（W11 起不存在）。

**版本门槛**：zsw 须引入含本改造的 zcode 引擎包版本（vendored 引擎包副本刷新到含 `db-path.ts` 的 `@zhushanwen/zcode-subagent-cli`；以 `VENDOR-MANIFEST.json` 溯源核对）。

---

## 5 期望 zsw 验收点（可勾选清单）

- [ ] **1. 隔离库路径一致性**：re-vendor + 发版后，zsw 实际产生的隔离库路径 == `zcodeSessionDbPath(其 engineDataDir)` 推导值（对照 §1.1 公式；同时确认 spawn env 含 `ZCODE_SESSION_DB_PATH` 且不含 `ZCODE_SESSION_DB`）。判定方式：跑一个 zsw 引擎任务，检查落库文件路径与公式一致，宿主库 `~/.zcode/cli/db/db.sqlite` 无新行。
- [ ] **2. 清理工具可执行**：zsw 清理链路覆盖自己的隔离库（`doctor clean` 或其替代物不再对新库恒 0 命中；面 B 宿主库历史行通道不受影响）。判定方式：构造可识别的测试残留 → 清理 → 隔离库命中归零；对照 §3 判据等价满足（至少：结构化解析、时间戳交叉验证、非 TTY 拒绝、凭证落盘）。
- [ ] **3. 停机窗口编排遵守**：任何一次真实清理执行（本仓工具或 zsw 对等工具）满足 §3.8——三库整库备份先行、窗口写者清单①–④齐全（zsw 在途任务判定 = `pgrep -flE "zsw|zcode.*app-server"` 空输出）、凭证落盘。判定方式：执行记录含备份快照路径 + pgrep 空输出证据 + 凭证文件。
- [ ] **4. 消费方式合规（补充项，对照 §4）**：zsw 侧对 `zcodeSessionDbPath` 的引用经 §4 两种受支持形态之一（npm 包导入或 vendored 引擎包源码导入；pi 侧运行形态以 vendored 深导入为准），无手拼路径字面量、无向 vendored core 寻找 `db-path.ts` 的残留。判定方式：zsw 仓内检索 `db.sqlite` 硬编码新路径为零（存量 `lib/config.js` 的宿主库硬编码除外——那是面 B 的存量兼容锚点）。

## 6 引用锚点（本仓）

| 内容 | 位置 |
|------|------|
| 路径构造函数实现（权威源） | `packages/zcode-subagent-cli/src/db-path.ts`（经包根 barrel 导出，见 §4） |
| 设计决策（隔离 / D7 清理通道 / §2.4.3 zsw 分析） | `docs/design/zcode-session-db-isolation.md` §3.2 D1/D2/D7、§2.4.3 |
| 清理工具实现级契约（I1–I3b / CLI 参数 / 窗口清单） | `docs/design/zcode-session-db-isolation.impl-plan.md` §2.5 |
| W5b 单元规格（消费方式钉死） | 同上 §2.6 |
| 约束登记 | `docs/constraints.json` C-ext-20 |
