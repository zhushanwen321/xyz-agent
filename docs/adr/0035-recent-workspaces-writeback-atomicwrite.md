# ADR-0004: recent-workspaces 持久化复用 write-back + atomicWrite 模式

- **Status**: accepted
- **Date**: 2026-07-03
- **From**: `2026-07-03-recent-workspaces §system-architecture §7, §code-architecture §4, §decisions D-005`

## 背景

recent-workspaces 需要持久化到本地文件（`recent-workspaces.json`）。项目现有持久化模式是「每域一 JSON + write-back（dirty + 定时 flush）+ atomicWrite（temp + rename）」，如 plugin sessionData、settings 等。

设计时考虑是否引入新的持久化抽象。

## 决策

**复用 write-back 意图（dirty + 定时 flush）+ atomicWrite**，不另起持久化模式。

具体实现（code-arch 阶段选定）：
- `RecentWorkspacesStore` 内置 WriteBackCache 语义：record 后标 dirty，debounce 500ms 或 `flushAll()`/`startFlushTimer` 定期触发 `atomicWrite`
- `flushAll()` 同步落盘（供 dispose / 关键时刻立即持久化）
- atomicWrite（`utils/fs-utils.ts`）：`writeFileSync(tmpPath)` → `renameSync(tmpPath, filePath)`，POSIX/NTFS 原子

## 备选方案（取舍）

| 方案 | 取舍 |
|------|------|
| **WriteBackCache 固定 partition（采纳）** | 与项目现有持久化模式一致（一致性 > 品味），atomicWrite 保证半写崩溃不损坏主文件 |
| JsonStore + service debounce | 抽象层级多一层，且 record 频率低（每次 create session 一次），debounce 收益有限 |
| 同步直写（每次 record 立即 fsync） | record 在 session.create 关键路径，fsync 阻塞 event loop，KB 级数据不值得 |

## 后果

- 持久化模式与 plugin sessionData / settings 一致，新人理解成本低
- atomicWrite 保证：半写崩溃时 rename 原子性确保「要么旧文件要么新文件」，无损坏中间态
- 文件已损坏（外部因素）时 `loadPartition` try/catch 降级空数组（INV-4）

## 验证

- atomicWrite 原子性 NFR 测试（T1.11）：写 tmp 阶段抛错 → 主文件不被污染 + 正常完成 tmp 清理
- 损坏降级测试（T1.6）：非法 JSON → list 返回 []
- debounce 测试（T1.7）：record N 次 + advance 500ms → atomicWrite 调用
- 跨进程持久化 E2E（T4.6）：record 落盘 → 新进程读同一文件 list 一致

## 关联

- 复用 `utils/fs-utils.ts` 的 `atomicWrite`（ADR-0004 跨主题复用既有 infra）
- INV-4（文件损坏降级 []）、INV-5（getConfigDir 动态化路径）均落此模式
