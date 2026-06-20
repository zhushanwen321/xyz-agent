# 0004: 配置文件写入采用 write-tmp + rename 原子操作

## 状态

已接受

## 上下文

Agent Runtime 有 3 个配置文件通过同步 I/O 持久化：
- `config-store.ts` — `~/.xyz-agent/config.json`（provider、defaults、toolPermissions）
- `skill-store.ts` — `<project>/.xyz-agent/skills.json`
- `agent-store.ts` — `<project>/.xyz-agent/agents.json`

原始实现直接 `writeFileSync(filePath, data)`。如果进程在写入中途被 kill（用户 Ctrl+C、OOM、断电），文件内容被截断为无效 JSON。下次启动时 `JSON.parse` 抛异常，用户配置/agent/skill 数据丢失。

config-store 的 `readFileSync` 模式不在本次改动范围内（见 spec D3），但写入侧可以低成本改进。

可选方案：
1. **保持 writeFileSync 直写** — 简单，但存在截断风险
2. **writeFileSync 到 .tmp + renameSync** — 操作系统保证 rename 是原子的（要么旧文件要么新文件，不会出现中间态）
3. **迁移到异步 I/O + flock** — 完美方案但影响面太广（所有调用路径需改为 async）

## 决策

方案 2：提取 `atomicWrite()` 共享函数到 `scanner-base.ts`，所有配置写入改用该函数。

```typescript
function atomicWrite(filePath: string, data: string): void {
  const tmpPath = filePath + '.tmp'
  writeFileSync(tmpPath, data, 'utf-8')
  renameSync(tmpPath, filePath)
}
```

## 理由

- renameSync 在 POSIX 和 NTFS 上都是原子操作
- 改动量极小（3 个调用点），无 API 变更
- 读侧不变（仍然是 readFileSync），不影响 spec D3 的同步 I/O 约束
- 最坏情况：写入中断留下 .tmp 文件，原始配置文件完好。下次写入覆盖 .tmp

## 后果

- 会在目标目录临时创建 `.tmp` 文件（通常 <1ms 就 rename 完成，用户不可见）
- 不解决并发读写问题（两个进程同时写入同一文件仍可能冲突），但 xyz-agent 是单进程，不存在此问题
- ~~`atomicWrite` 放在 scanner-base.ts 不太直觉（scanner-base 是扫描相关的），后续可移到独立的 fs-utils.ts~~ **已执行（R6）**：`atomicWrite` 迁至 `src/utils/fs-utils.ts`。该函数被 infra（pi-config-bridge/pi-provider-store）和 services（config-service）共用，无业务语义，归跨层共享叶子层 `utils/`。scanner 家族（skill/agent-scanner + expandHome/inferSourceType）同时迁至 `src/services/scanners/`（纯 fs 实现，只被 config-service 引用，非外部系统连接器，放 infra 违反 T4 铁律）。
