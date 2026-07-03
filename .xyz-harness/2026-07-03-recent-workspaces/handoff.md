# Handoff: recent-workspaces 独立持久化

> 给 **lite-plan** plan mode 会话用。所有事实型声明均已实测（标注文件:行），可直接采信；
> 判断型结论（方案/选型）plan mode 自行推导。本 handoff 不替代探索，只省去重复踩点。

---

## 0. 给 plan mode AI 的入口指引

1. 这是 **xyz-agent** 项目（Electron + Vue3 + Node.js runtime，三层架构 transport/services/infra）。
   - 必读规范：本 worktree 根目录 `AGENTS.md` + `CLAUDE.md`（workspace 根）。尤其规则 #1（emit 单 payload）、#5（pi 适配层）、#11（数据目录隔离）、打包约束 #12、目录规范 #13。
   - 工作目录：`/Users/zhushanwen/Code/xyz-agent-workspace/refactor-arch-render-runtime`
2. 用 `/plan` 进入 plan mode，选 template `feature-plan`，加载 `lite-plan` skill。
3. plan.md 输出路径由 plan extension 指定（planFilePath），建议 slug：`recent-workspaces`。
4. **范围守门自检**：本功能命中「跨 runtime + 前端 2 个子系统」「改动影响 3+ 既有文件核心逻辑」——**可能属于 design 而非 lite**。请先做范围守门（步骤 0/0b），如判定升级 design 则停止本 handoff，改走 design 工作流。若仍判 lite，继续。

---

## 1. 业务问题（一句话）

新建任务页选目录 popover（`DirSelectPopover`）的「最近工作区」列表是**从当前 session 列表实时派生**的，session 被删后该目录从列表消失，不符合「使用记录应独立持久化」的预期。

### 根因（实测）

- `src-electron/renderer/src/components/new-task/DirSelectPopover.vue:50` —— `recentWorkspaces(session.list)`，数据源是 `useSessionStore().list`。
- `src-electron/renderer/src/lib/utils.ts:61` `recentWorkspaces(sessions)` —— 遍历 sessions 按 cwd 去重取 lastActiveAt 最新 top10，**无独立存储**。
- `src-electron/renderer/src/lib/utils.ts:36` `resolveDefaultCwd(sessions)` —— 默认 cwd 也从 sessions 派生，同样隐患。
- 代码注释自称「本地缓存最多 10 条」(`utils.ts:59` 注释 + `MAX_RECENT_WORKSPACES=10`)，但实现里**没有**任何缓存文件，注释与实现不符。

### 业务目标（供 plan.md「业务目标」章节用，可改写）

让「最近工作区」成为**独立于 session 生命周期的持久化使用记录**：session 删除不影响目录记录；记录按独立时间戳排序。可衡量成功标准：删除某 session 后，该 session 的 cwd 仍出现在最近目录列表 top10 中（只要它在历史 top10 内）。

---

## 2. 现状盘点（实测，已查证）

### ~/.xyz-agent/ 现有持久化数据

| 文件 | 形态 | 大小 | 管理者 | 访问模式 |
|---|---|---|---|---|
| `config.json` / `config.toml` | 单 JSON | ~1KB | `services/config-service.ts` | 低频读写 |
| `model-db.json` | 单 JSON | **4MB** | 静态参考 | 启动读一次 |
| `session-labels.json` | 单 JSON | ~0.5KB | **疑似废弃**（runtime 代码 grep 无引用，仅 dev 目录残留） | — |
| `projects/*.jsonl` | JSONL | 小 | **pi 管理**，xyz-agent 经 `infra/pi/session-store.ts` 只读扫描 | session 会话历史 |
| `session-data/*.json` | 每 plugin/session 一文件 | 小 | `services/plugin-service/session-data-store.ts` | KV |
| session 列表本身 | 扫描 `projects/*.jsonl` **派生** | — | `services/session/session-scanner.ts` | 每次扫描，非独立存储 |

**关键结论**：session 列表不是独立表，是从 pi 的 jsonl 扫描派生的。所以「最近目录」从 session 派生 = 间接依赖 pi session 文件存在。

### 不需要 SQLite（已论证，plan.md「约束」可直接引用）

- 数据量极小（recent-workspaces top10，每条 ~100 字节 < 2KB）
- 访问模式是「整体读/整体写」非「按主键查行」
- SQLite 引入原生依赖（better-sqlite3 需对 Electron Node ABI 编译），与 CLAUDE.md 规则 #12 打包约束冲突，代价远超收益
- 项目现有模式就是「每个域一个 JSON 文件 + WriteBackCache」——应延续

---

## 3. 可复用的现成抽象（实测，复用检查已做）

### 3.1 WriteBackCache + atomicWrite（强烈建议复用）

- `src-electron/runtime/src/utils/json-store.ts:55` `JsonStore<T>` —— 通用 JSON 持久化，构造接 `JsonStoreOptions<T>`。
- `src-electron/runtime/src/utils/json-store.ts:184` `WriteBackCache<K,IK,IV>` —— write-back 缓存 + dirty 跟踪 + 定时 flush（`flushMs`），构造接 `WriteBackBacking`（`loadPartition`/`persistPartition`）。
- `src-electron/runtime/src/utils/fs-utils.ts` `atomicWrite(path, content)` —— 原子写（temp + rename）。
- **现成范例**：`services/plugin-service/session-data-store.ts` 就是 `WriteBackCache` + `atomicWrite` 的组合用法，可照抄模式（构造注入 configDir、flushMs、loadPartition/persistPartition 回调）。

### 3.2 configDir 注入路径

- runtime 服务通过组合根注入 `configDir`（`getConfigDir()`，`~/.xyz-agent/`，dev 模式 `~/.xyz-agent-dev/`——见 CLAUDE.md 数据隔离规则 #1/#2，**禁止硬编码路径**）。
- 新文件建议路径：`<configDir>/recent-workspaces.json`。

### 3.3 upsert 写入时机点（实测候选）

| 时机 | 位置 | 说明 |
|---|---|---|
| session 创建 | `services/session/session-lifecycle.ts:46` `create(cwd, label)` | 首次进入目录时记录 |
| session 活跃（发消息） | `services/session/message-dispatcher.ts:83` `activeSession.lastActiveAt = Date.now()` | 每次活跃刷新时间戳 |
| session 恢复/ensureActive | `session-service.ts` `ensureActive` | 切换到旧 session 时记录 |

plan 需决策：在 service 层哪个点调用 `recentWorkspacesStore.upsert(cwd)`（推荐 create + message-dispatcher 活跃点，覆盖「新建目录」+「重新活跃旧目录」两个语义）。

---

## 4. 技术改动点候选（文件级，供 plan.md「技术改动点」用，plan mode 需复核 + 决策接口）

> 标 [决策] 的需 plan mode 定接口，handoff 不预设。

### runtime 层
- **创建** `src-electron/runtime/src/services/workspace/recent-workspaces-store.ts` — 独立持久化服务，复用 `WriteBackCache`/`atomicWrite`。接口候选：`list(): RecentWorkspace[]`、`upsert(cwd: string): void`。top10 + LRU 淘汰。[决策] 是否做「目录已不存在则清理」(fs.exists)。
- **修改** `src-electron/runtime/src/services/session/session-lifecycle.ts` — `create()` 末尾调 `recentWorkspacesStore.upsert(cwd)`。
- **修改** `src-electron/runtime/src/services/session/message-dispatcher.ts:83` — 活跃点调 `upsert(cwd)`。[决策] 是否 debounce（发消息频繁）。
- **修改** `src-electron/runtime/src/index.ts`（组合根）— 实例化 `RecentWorkspacesStore(configDir)`，注入 session 服务。[决策] 注册到哪个 service 容器。
- **修改** `src-electron/runtime/src/services/ports/*.ts` 或新增 RPC handler — 暴露 `workspace.listRecent` RPC 给前端。

### 前端层
- **修改** `src-electron/renderer/src/components/new-task/DirSelectPopover.vue:50` — 数据源从 `recentWorkspaces(session.list)` 改为 RPC 拉取的独立记录（或 store）。
- **修改** `src-electron/renderer/src/lib/utils.ts:36,61` — `resolveDefaultCwd` / `recentWorkspaces` 改为消费独立记录（或废弃派生函数）。[决策] 是否保留派生函数作 fallback。
- **修改** `src-electron/renderer/src/stores/session.ts` 或新建 `stores/workspace.ts` — 持有 recent-workspaces 状态，订阅 RPC。[决策] store 归属。
- **修改** `src-electron/renderer/src/composables/useNewTaskFlow.ts` — `resolveDefaultCwd` 调用点适配新数据源。

### 注意（实测已知坑）
- `session-labels.json` 已废弃但文件残留 —— **本功能不要复用这个文件名/路径**，新建 `recent-workspaces.json`。
- CLAUDE.md 规则 #7（Session 隔离）：runtime→前端消息若涉及 session 必须带 sessionId。但本功能是「目录记录」非 session 级，broadcast 时注意路由语义（可能需要新的广播类型或前端主动拉取，参考规则「Runtime broadcast 时序竞争」——**renderer 切换/创建 session 后需立即消费的状态应主动拉取，不依赖 broadcast**）。

---

## 5. 测试设计输入（供 plan.md 测试章节，plan mode 需补全 + ensemble 反向自检）

### 项目测试栈（实测）
- runtime 测试：**vitest**（`src-electron/runtime/vitest.config.ts`，依赖 `vitest@^4.1.6`，命令 `npx vitest run`）。**禁止 node:test / tsx --test**（见 CLAUDE.md 测试规范）。
- 前端测试：Vue 组件测试，需 mount 顶层容器做渲染断言（见 CLAUDE.md 测试规范 #5-#8「渲染 gate」）。
- 项目有 `TEST-STRATEGY.md` + `docs/testing/` —— **plan mode 必读**对应章节复用 data-testid/fixture/已知坑。

### 必须覆盖的场景（同源盲区高发区，建议触发 4b ensemble）
1. 删除 session 后目录仍在列表（核心 AC）
2. 同 cwd 多次活跃 → 时间戳更新、不重复
3. top10 LRU 淘汰：第 11 个新 cwd 挤掉最旧的
4. cwd 脏数据（空串/undefined）跳过
5. 首次启动无记录文件 → 空列表（不抛错）
6. 持久化文件损坏/非法 JSON → 降级空列表不崩
7. 前端 DirSelectPopover 切换 session 后主动拉取（验证不依赖 broadcast）
8. `resolveDefaultCwd` 改数据源后行为一致

### 测试视角（CLAUDE.md #5-#8 强制）
每个集成/E2E 用例至少一个**用户可见 DOM 断言**（`wrapper.find(...).exists()`），不能只断内部 state。

---

## 6. 约束清单（直接进 plan.md Constraints）

- 必须用 vitest，禁 node:test
- 数据目录禁止硬编码 `~/.xyz-agent`，用 `getConfigDir()`（规则 #2）
- 持久化用 atomicWrite，不用裸 writeFileSync
- 不引入 SQLite（已论证）
- emit 单 payload 对象（规则 #1）
- runtime→前端消息遵循 session 隔离 + broadcast 时序规则（#7 + 「Runtime broadcast 时序竞争」）
- 打包相关：若新增 runtime dependencies，须同步 `tsup.config.ts` 的 `noExternal`（规则 #12）——本功能预期无新依赖（复用 WriteBackCache），但 plan 需确认
- 目录规范：不创建 `demos/`，设计稿在 `docs/page-design/`（#13）——本功能无前端设计稿需求

---

## 7. 不做（边界，供 plan.md「不做」）

- 不做 SQLite 迁移
- 不做跨机器同步
- 不做目录内容索引/搜索（仅记录 cwd 路径 + 时间戳）
- 不清理 pi 的 session 文件
- 不改 pi 侧任何东西（xyz-agent 侧独立维护记录）

---

## 附：关键文件速查表

| 文件 | 作用 |
|---|---|
| `src-electron/renderer/src/components/new-task/DirSelectPopover.vue` | 选目录 popover（前端入口） |
| `src-electron/renderer/src/lib/utils.ts` | recentWorkspaces / resolveDefaultCwd 派生函数 |
| `src-electron/renderer/src/composables/useNewTaskFlow.ts` | 新建任务流程，调 resolveDefaultCwd |
| `src-electron/runtime/src/services/session/session-lifecycle.ts` | session create（upsert 写入点） |
| `src-electron/runtime/src/services/session/message-dispatcher.ts` | session 活跃点（upsert 写入点） |
| `src-electron/runtime/src/services/session/session-service.ts` | session 服务总入口 |
| `src-electron/runtime/src/services/plugin-service/session-data-store.ts` | **WriteBackCache 用法范例，照抄** |
| `src-electron/runtime/src/utils/json-store.ts` | JsonStore / WriteBackCache 抽象 |
| `src-electron/runtime/src/utils/fs-utils.ts` | atomicWrite |
| `src-electron/runtime/src/index.ts` | runtime 组合根（服务注册） |
| `src-electron/runtime/src/services/ports/` | RPC port 定义（新增 workspace.listRecent） |
