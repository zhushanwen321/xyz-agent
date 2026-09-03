# P1 对等核对清单：command / fileSearch 双轨收口（u2.1 前置门）

基线: c67842c2e 系（u1.3 后） | 日期: 2026-09-02 | 依据: renderer-deepening.md §3.3 D7 + §2 例 4

核对对象：

- command：壳 `packages/renderer/src/stores/command.ts`（194 行，pinia setup store）vs core `packages/core/src/domain/new-task-search/command-store.ts`（277 行，factory）
- fileSearch：壳 `packages/renderer/src/stores/fileSearch.ts`（41 行）vs core `packages/core/src/domain/new-task-search/file-search-store.ts`（50 行）

定性口径（设计 D7）：每条差集定性为「等价」/「core 新增」（无需动作）或「壳独有」（必须先补齐 core 再切换）；行为级差异（语义不同而非新增）→ 补齐 core；根本性不对等 → 停该项走 fileSearch 降级。

## 1. command store（194 vs 277）

### 1.1 状态字段

| 函数/字段 | 壳（pinia） | core（factory） | 差异 | 定性 | 动作 |
|---|---|---|---|---|---|
| commandsBySession | `ref<Map<string, SessionCommand[]>>` | 同 | 无 | 等价 | — |
| appCommands | `ref<AppCommand[]>([])` | 同 | 无 | 等价 | — |
| pendingSlash | `ref<PendingSlash \| null>(null)` | 同 | 无 | 等价 | — |
| shortcutOverrides（状态） | ref + 构造期同步 `loadShortcutOverrides()`（localStorage 直读，解析失败降级 `{}`） | ref 初值 `{}` + `initShortcutOverrides()`（注入 KVStorage 异步读，解析失败/异常降级 `{}`） | 持久化读写经端口注入；恢复时序同步→异步 | core 端口化等价（core 文件头 IF1 既定差异；恢复语义一致：失败降级 `{}` 不抛出） | 无需补齐——构造期恢复由壳适配 `composables/features/command/useCommandStore.ts` 创建时 fire-and-forget `initShortcutOverrides()` 承接 |

### 1.2 操作方法

| 函数/字段 | 壳（pinia） | core（factory） | 差异 | 定性 | 动作 |
|---|---|---|---|---|---|
| requestSlashInjection | `{ ...payload, ts: Date.now() }` 幂等覆盖 | 同（逐字一致） | 无 | 等价 | — |
| clearPendingSlash | 置 null | 同 | 无 | 等价 | — |
| getCommands | `map.get(sid) ?? []`（不写入 Map） | 同 | 无 | 等价 | — |
| findCommandByName | getCommands().find(name) | 同 | 无 | 等价 | — |
| commandsOf | `computed(() => map.get(sid) ?? [])` | 同 | 无 | 等价 | — |
| slashCommandsOf | commandsOf 别名 | 同 | 无 | 等价 | — |
| registerApp | 幂等覆盖 appCommands，不写 commandsBySession | 同 | 无 | 等价 | — |
| applyCommands | raw → 归一化（id/kind/icon/description/sourceInfo）+ 不可变 Map 写 | 同（逐字一致） | 无 | 等价 | — |
| applyCommands 的 icon 推断 | `iconKeyForCommand` —— import 自 `@xyz-agent/core` | 同一函数（core 本地定义并导出，含 BUILTIN_COMMAND_ICON_KEYS / bareCommandName） | 无（壳本就消费 core 同一实现） | 等价 | — |
| clearCommands | has 守卫 + 不可变删 | 同 | 无 | 等价 | — |
| setShortcutOverride | 内存态立即更新 + 同步 `localStorage.setItem`，try/catch 降级内存态 | 内存态立即更新 + 异步 `storage.set`，try/catch 降级内存态 | 持久化同步→异步（内存态/失败降级语义一致） | core 端口化等价 | 无需补齐 |
| initShortcutOverrides | —（无：构造期同步恢复已覆盖） | 有（async，从 storage 回填） | core 多一方法 | core 新增（承接壳构造期恢复时序） | 无需动作 |
| loadShortcutOverrides（模块私有函数） | 有（localStorage 直读） | —（以 initShortcutOverrides + KVStorage 端口承接） | 壳独有实现细节 | 等价物已在 core（端口化改写，非语义差异） | 无需补齐 |

### 1.3 类型与模块级导出

| 导出 | 壳 | core | 差异 | 定性 | 动作 |
|---|---|---|---|---|---|
| SessionCommand / PendingSlash / RawCommand 接口 | 本地定义 | 同定义导出 | 无 | 等价 | 切换后 import 改指 core |
| BUILTIN_COMMAND_ICON_KEYS / bareCommandName / iconKeyForCommand | 壳 import 自 core | core 定义导出 | 无 | core 新增（壳本就消费） | — |
| pinia `defineStore('command')` 包装 | 有 | 无 | 消费方访问差异：pinia 自动解包（`store.pendingSlash`）vs 显式 `.value` | 形态差异非行为差异 | 消费方切换时补 `.value` |

### 1.4 单例语义（切换前置条件）

pinia store 同 id 天然单例；core factory 需模块级壳适配缓存。现状：command 已有壳适配 `composables/features/command/useCommandStore.ts`（模块级单例 + `__resetCommandStoreForTesting`），SearchModal（useSearchModalDeps）与 CommandPopover（CommandPopover.vue:91）均已消费它。fileSearch 的 core 单例现状内嵌在 `useSearchModalDeps.ts` 私有变量 `fileSearchStoreInstance`，CommandPopover 侧（useFileSearch/useSearch）尚在 pinia 轨 → 切换时抽公共壳适配，两轨同实例（否则缓存分桶，违背 D7 同一数据源目标）。

### 1.5 结论

command 双轨差集全部为「等价」/「core 新增（端口化改造既定差异）」，**无壳独有行为级差异，无需补齐 core**。P1 通过，可切换。

## 2. fileSearch store（41 vs 50）

| 函数/字段 | 壳（pinia） | core（factory） | 差异 | 定性 | 动作 |
|---|---|---|---|---|---|
| files | `ref<Map<string, FileNode[]>>` | 同 | 无 | 等价 | — |
| get | `files.get(sid)`（无则 undefined） | 同 | 无 | 等价 | — |
| set | `files.set(sid, nodes)` | 同 | 无 | 等价 | — |
| invalidate | `files.delete(sid)`（删缓存不重拉，G9） | 同 | 无 | 等价 | — |
| pinia `defineStore('fileSearch')` 包装 | 有 | 无 | 解包访问差异 | 形态差异非行为差异 | 消费方切换（方法调用形态不变） |

### 2.1 结论

fileSearch 双轨逐字同构（仅 factory 形态差异），**无壳独有差异**。P1 通过，可切换。

## 3. 核对范围内的行为级差异声明（仅 1 处，非阻断）

shortcutOverrides 恢复时序：壳版 pinia setup 同步读 localStorage（首次 `useCommandStore()` 即有值）；core 版经壳适配创建后异步回填（启动瞬间存在读取窗口）。该差异是 core 文件头 IF1 迁移约束的既定设计（壳适配注释已声明「启动瞬间的读取窗口可接受」），且 w5 壳接线已上线该形态（SystemShortcutSection 等已在 core 轨运行）——非本次切换引入，不构成补齐项。
