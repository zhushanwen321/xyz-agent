---
review:
  type: code_review
  round: 1
  timestamp: "2026-05-28T20:00:00"
  target: "bundle-pi-extensions — integration review"
  verdict: pass
  summary: "集成审查完成，第1轮，0条MUST FIX，调用链完整，数据隔离一致，BLR数据准确"

statistics:
  total_issues: 3
  must_fix: 0
  must_fix_resolved: 0
  low: 1
  info: 2

issues:
  - id: 1
    severity: LOW
    location: "src-electron/runtime/src/pi-config-bridge.ts:130-147"
    title: "migrateToPiSubdir 的 bundled sync 为一次性操作，应用更新后新增 bundled extension 不会自动同步"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: INFO
    location: "src-electron/runtime/src/services/session-service.ts:506"
    title: "Dev 模式运行时目录优先于源码目录，打包→dev 切换后本地修改可能被忽略"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: INFO
    location: "src-electron/runtime/src/pi-config-bridge.ts:139 vs src-electron/runtime/src/services/session-service.ts:515"
    title: "migrateToPiSubdir 同步了 shared/ 目录但 getExtensionPaths 跳过 shared/，结构性冗余"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 集成审查 v1

## 评审记录

- 评审时间：2026-05-28 20:00
- 评审类型：集成审查（编码评审模式）
- 评审对象：bundle-pi-extensions（logger.ts、session-service.ts getExtensionPaths()、pi-config-bridge.ts migrateToPiSubdir()）
- 审查依据：BLR 产出 `business_logic_review_v1.md` + 实际源码

---

## 1. BLR 模拟数据与实际代码一致性

### 1.1 Dev 模式路径

BLR §5.1 描述的 dev 模式启动路径：

| BLR 断言 | 实际代码 | 匹配 |
|---------|---------|------|
| `extensionPath: ~/.../xyz-agent-extension.js` | `session-service.ts` constructor 传入 `extensionPath` 参数 | ✅ |
| `projectRoot: ~/.../feat-xyz-pi-extension/src-electron/` | constructor 接收并保存 `projectRoot` | ✅ |
| `scanDirs[0]: ~/.xyz-agent/pi/agent/extensions/` | `getExtensionPaths()` line 501: `join(agentDir, 'extensions')` | ✅ |
| `scanDirs[1]: resources/pi/agent/extensions/` | line 504: `join(this.projectRoot, 'resources', 'pi', 'agent', 'extensions')` | ✅ |
| `scanDirs[1]` 仅在 dev 模式添加 | line 503: `if (process.env.XYZ_AGENT_PACKAGED !== '1')` | ✅ |
| 跳过 `shared/` | line 514: `if (entry === 'shared') continue` | ✅ |
| `seenExts` Set 按 name 去重 | line 507-508: `const seenExts = new Set<string>()` + `if (seenExts.has(entry)) continue` | ✅ |
| 运行时目录优先 | `for (const bundledExtDir of scanDirs)` — 运行时在数组首位 | ✅ |
| 查找 index.ts → index.js | line 516-520 | ✅ |

### 1.2 Packaged 模式路径

BLR §5.2 描述的 packaged 模式：

| BLR 断言 | 实际代码 | 匹配 |
|---------|---------|------|
| `scanDirs[1]` 跳过 | `if (process.env.XYZ_AGENT_PACKAGED !== '1')` 不成立 | ✅ |
| 仅 `~/.xyz-agent/pi/agent/extensions/` 作为扫描源 | scanDirs 只有一项 | ✅ |
| `migrateToPiSubdir()` 从 Resources 同步到此目录 | pi-config-bridge.ts:130-147 | ✅ |

### 1.3 Logger 路径

BLR §5.3 描述的日志路径：

| BLR 断言 | 实际代码 | 匹配 |
|---------|---------|------|
| `LOG_DIR = ~/.xyz-agent/pi/agent/logs/` (env 设置时) | logger.ts:33-34 | ✅ |
| fallback = `~/.pi/agent/logs/` (env 未设置) | logger.ts:35 | ✅ |
| `appendFileSync` 写入 | logger.ts:54 | ✅ |

### 1.4 数据隔离验证清单

BLR §5.4 的验证项与代码的实际常量定义一致：

| 验证项 | 预期值 | 实际值 | 匹配 |
|--------|--------|--------|------|
| `getPiAgentDir()` | `~/.xyz-agent/pi/agent/` | pi-config-bridge.ts:680-683: `return PI_AGENT_DIR` = `join(homedir(), '.xyz-agent', 'pi', 'agent')` | ✅ |
| `getSessionsDir()` | `~/.xyz-agent/pi/sessions/` | pi-config-bridge.ts:436: `return SESSIONS_DIR` = `join(PI_ROOT, 'sessions')` = `join(CONFIG_DIR, 'pi', 'sessions')` | ✅ |
| `PI_CODING_AGENT_DIR` | `~/.xyz-agent/pi/agent/` | rpc-client.ts:85: `env.PI_CODING_AGENT_DIR = getPiAgentDir()` | ✅ |
| Extension 扫描源 | runtime 或源码 | session-service.ts:500-505 | ✅ |

**结论：BLR 产出的模拟数据和执行路径与实际代码完全一致，无偏差。**

---

## 2. 调用链完整性验证

### 2.1 三模块间的数据流链

```
[模块加载时]
pi-config-bridge.ts:migrateToPiSubdir()
  → mkdirSync(PI_AGENT_DIR, ...)      ← 创建 ~/.xyz-agent/pi/agent/
  → mkdirSync(SESSIONS_DIR, ...)      ← 创建 ~/.xyz-agent/pi/sessions/
  → [packaged 模式] cpSync(src→dest)  ← 同步 bundled extensions/skills

[用户创建/恢复会话时]
session-service.ts:create() / resume()
  → getExtensionPaths()               ← 从 runtime 或源码目录收集 extension 路径
  → extensionService.getExtensionPaths()  ← 用户启用的 extension
  → [...bundleExtPaths, ...userExtPaths]
  → pm.createSession({ extensionPaths })

[ProcessManager → RpcClient]
rpc-client.ts:start()
  → env.PI_CODING_AGENT_DIR = getPiAgentDir()  ← 设置 ~/.xyz-agent/pi/agent/
  → spawn(pi, { --extension <path> ... })       ← 传递 extension 路径

[pi 子进程中]
extension/index.ts (jiti 编译)
  → import { createLogger } from "../../shared/logger.js"
  → 读取 process.env.PI_CODING_AGENT_DIR
  → LOG_DIR = ~/.xyz-agent/pi/agent/logs/
  → 写入 <prefix>-YYYY-MM-DD.log
```

### 2.2 链路线分析

| 环节 | 位置 | 输入 | 输出 | 状态 |
|------|------|------|------|------|
| 1. 路径定义 | pi-config-bridge.ts:30-35 | 常量定义 | `PI_AGENT_DIR` = `~/.xyz-agent/pi/agent/` | ✅ |
| 2. 路径创建 | pi-config-bridge.ts:73-75 | `mkdirSync(PI_AGENT_DIR, ...)` | 目录就绪 | ✅ |
| 3. 路径同步(packaged) | pi-config-bridge.ts:130-147 | `cpSync(src, dest)` | `extensions/`, `skills/` 在 runtime 目录 | ✅ |
| 4. 扩展收集 | session-service.ts:490-547 | 扫描 runtime/source dirs | extension 路径数组 | ✅ |
| 5. 扩展合并 | session-service.ts:96-98 | bundle + user paths | `allExtPaths` 数组 | ✅ |
| 6. 环境变量设置 | rpc-client.ts:85 | `getPiAgentDir()` | `env.PI_CODING_AGENT_DIR` | ✅ |
| 7. Pi 进程启动 | rpc-client.ts:91-100 | `--extension` args | pi 子进程 | ✅ |
| 8. 日志写入 | logger.ts:33-54 | `PI_CODING_AGENT_DIR` | 日志文件 | ✅ |

**关键发现：路径常量 `PI_AGENT_DIR` 在 `pi-config-bridge.ts` 定义一次，通过 `getPiAgentDir()` 导出，在 `session-service.ts` 和 `rpc-client.ts` 中统一消费。不存在多源路径定义，不存在硬编码路径。**

### 2.3 跨进程传递验证

`PI_CODING_AGENT_DIR` 的传递路径：

```
rpc-client.ts:85 设置 env.PI_CODING_AGENT_DIR
  → spawn(piCmd, args, { env })      ← 通过 `env` 参数传递给子进程
  → pi 子进程继承环境变量
  → extension 模块加载时读取 process.env.PI_CODING_AGENT_DIR  ← logger.ts:33
```

**链路完整，无断裂。**

### 2.4 潜在时序问题

`migrateToPiSubdir()` 在模块加载时执行（pi-config-bridge.ts 末尾被调用）。`SessionService` 的构造函数在 sidecar 初始化时执行，这发生在模块加载之后。因此 migrateToPiSubdir() 总是在任何 session 操作之前完成。

**时序正确：migrateToPiSubdir → SessionService.create/resume → rpc-client.start → logger.read。**

---

## 3. 数据隔离一致性验证

### 3.1 全局路径扫描

对三个源代码文件中所有涉及文件系统路径的代码进行全员扫描：

| 代码位置 | 涉及路径 | 是否 ~/.xyz-agent/ | 是否 ~/.pi/ |
|----------|---------|-------------------|------------|
| pi-config-bridge.ts:30 `CONFIG_DIR` | `~/.xyz-agent/` | ✅ | ❌ |
| pi-config-bridge.ts:31 `PI_ROOT` | `~/.xyz-agent/pi/` | ✅ | ❌ |
| pi-config-bridge.ts:32 `PI_AGENT_DIR` | `~/.xyz-agent/pi/agent/` | ✅ | ❌ |
| pi-config-bridge.ts:33 `MODELS_PATH` | `~/.xyz-agent/pi/agent/models.json` | ✅ | ❌ |
| pi-config-bridge.ts:34 `SETTINGS_PATH` | `~/.xyz-agent/pi/agent/settings.json` | ✅ | ❌ |
| pi-config-bridge.ts:35 `SESSIONS_DIR` | `~/.xyz-agent/pi/sessions/` | ✅ | ❌ |
| pi-config-bridge.ts:36 `AGENTS_DIR` | `~/.xyz-agent/pi/agent/agents/` | ✅ | ❌ |
| pi-config-bridge.ts:39-41 OLD paths | `~/.xyz-agent/models.json` 等 | ✅ | ❌ |
| pi-config-bridge.ts:73-75 `mkdirSync` | `PI_AGENT_DIR`, `SESSIONS_DIR`, `AGENTS_DIR` | ✅ | ❌ |
| pi-config-bridge.ts:131 `bundledAgentDir` | `{cwd}/pi/agent/` (packaged) | ✅ (Resources 内) | ❌ |
| pi-config-bridge.ts:135 dest | `join(PI_AGENT_DIR, subDir)` | ✅ | ❌ |
| session-service.ts:501 `agentDir` | `join(getPiAgentDir(), 'extensions')` | ✅ | ❌ |
| session-service.ts:504 source dir | `{projectRoot}/resources/pi/agent/extensions/` | ✅ (项目源码) | ❌ |
| session-service.ts:548 `getAgentDir()` | `getPiAgentDir()` = `~/.xyz-agent/pi/agent/` | ✅ | ❌ |
| rpc-client.ts:85 `PI_CODING_AGENT_DIR` | `getPiAgentDir()` = `~/.xyz-agent/pi/agent/` | ✅ | ❌ |
| rpc-client.ts:101 `sessionDir` | `getSessionsDir()` = `~/.xyz-agent/pi/sessions/` | ✅ | ❌ |
| logger.ts:33-34 LOG_DIR (env set) | `~/.xyz-agent/pi/agent/logs/` | ✅ | ❌ |
| logger.ts:35 LOG_DIR (fallback) | `~/.pi/agent/logs/` | ❌ | ⚠️ fallback |

### 3.2 结论

**所有 xyz-agent 流程可达的代码路径均使用 `~/.xyz-agent/` 命名空间。** logger.ts 的 fallback 路径写入 `~/.pi/agent/logs/` 仅在 `PI_CODING_AGENT_DIR` 环境变量未设置时生效。在 xyz-agent 流程中，该变量始终由 `rpc-client.ts:85` 在 spawn pi 之前设置，因此 fallback 分支在 xyz-agent 环境下不可达。

---

## 4. getExtensionPaths() 与 migrateToPiSubdir() 一致性

### 4.1 打包模式下的管道

```
migrateToPiSubdir():                          getExtensionPaths():
  src = {cwd}/pi/agent/extensions/              scanDirs[0] = ~/.xyz-agent/pi/agent/extensions/
  dest = ~/.xyz-agent/pi/agent/extensions/      scanDirs[1] = skipped (packaged)
  cpSync(src, dest) ✓                           readdirSync(scanDirs[0]) ✓
```

**packaged 模式：完整一致。前者通过 `cpSync` 将 bundled extensions 写入 runtime 目录，后者从 runtime 目录读取。**

### 4.2 开发模式下的管道

```
migrateToPiSubdir():                          getExtensionPaths():
  XYZ_AGENT_PACKAGED !== '1' → skip sync       scanDirs[0] = ~/.xyz-agent/pi/agent/extensions/
  但目录创建 (mkdirSync) 仍执行                 scanDirs[1] = {projectRoot}/resources/.../extensions/
```

**dev 模式：`migrateToPiSubdir()` 的 bundled sync 被 `XYZ_AGENT_PACKAGED != '1'` 守卫跳过。`getExtensionPaths()` 通过 scanDirs[1] 读取源码目录。路径一致。**

### 4.3 交叉验证

| 场景 | migrateToPiSubdir | getExtensionPaths | 结果 |
|------|------------------|------------------|------|
| 首次 dev | 创建目录结构，不 sync | 读取源码目录 | ✅ 一致 |
| 首次 packaged | 创建目录结构 + sync | 读取 runtime 目录 | ✅ 一致 |
| packaged → dev 切换 | 不 sync (dev guard) | runtime 目录 (packaged 残留) + 源码目录 | ⚠️ BLR Issue #2 |
| dev 后 packaged | sync (dest 不存在) | runtime 目录 | ✅ 一致 |

---

## 5. BLR 未覆盖的集成问题

### Issue #1 (LOW) — migrateToPiSubdir bundled sync 一次性操作

**位置：** `pi-config-bridge.ts:130-147`

```typescript
if (existsSync(src) && !existsSync(dest)) {  // ← 仅当 dest 不存在时执行
  cpSync(src, dest, { recursive: true })
}
```

**问题描述：** 打包模式下，`migrateToPiSubdir()` 仅在首次（或 runtime 目录被删除后）同步 bundled extensions 到 `~/.xyz-agent/pi/agent/extensions/`。如果应用通过自动更新发布了新的 bundled extension，或修改了现有 extension，这些变更不会自动同步到 runtime 目录。用户需要手动删除 `~/.xyz-agent/pi/agent/extensions/` 才能触发重新同步。

**风险分析：**
- 在 Phase 1（首次发布）中无影响：所有 bundled extensions 在首安装时同步到位
- 未来 Phase 更新 bundled extensions 时，必须考虑此机制：要么增加版本标记判断是否需要重同步，要么在 app 启动时始终做增量同步
- 当前设计不导致功能失效（已有 extension 正常工作），只是新增 extension 不会被加载

**建议：** 当前 phase 无需修复，但应在后续 phase 或 app 更新策略中处理此问题。

---

### Issue #2 (INFO) — Dev 模式运行时目录优先于源码目录

**位置：** `session-service.ts:506`

与 BLR Issue #2 一致。运行时目录 `scanDirs[0]` 在扫描源数组中优先于源码目录 `scanDirs[1]`，`seenExts` 去重机制导致源码目录的同名 extension 被跳过。开发者从打包模式切回 dev 模式后，本地更改被忽略。

---

### Issue #3 (INFO) — migrateToPiSubdir 同步 shared/ 到 runtime 目录

**位置：** `pi-config-bridge.ts:139 vs session-service.ts:515`

**问题描述：** `migrateToPiSubdir()` 通过 `cpSync(src, dest, { recursive: true })` 递归复制整个 `extensions/` 目录，包括 `shared/` 子目录。而 `getExtensionPaths()` 在扫描时明确跳过 `shared/` 目录。结果是 `~/.xyz-agent/pi/agent/extensions/shared/` 存在但从不被作为 extension 加载。

**影响：** 无害。`shared/` 目录下没有 `index.ts`/`index.js`，即使没有显式跳过也不会被加载。该冗余仅占用少量磁盘空间（一个 `logger.ts` 文件）。低优先级，无需修复。

---

## 6. 集成审查总结

### 6.1 正向验证结果

| 审查维度 | 结果 | 说明 |
|---------|------|------|
| BLR 数据与实际代码一致性 | ✅ 完全一致 | 模拟路径、执行顺序、变量值均匹配 |
| logger.ts → session-service.ts → pi-config-bridge.ts 调用链 | ✅ 完整 | 数据流链（而非函数调用链）6 个环节全部连接 |
| 数据隔离 (~/.xyz-agent/ vs ~/.pi/) | ✅ 一致 | 所有可达路径使用 ~/.xyz-agent/；logger fallback 不可达 |
| getExtensionPaths() ↔ migrateToPiSubdir() | ✅ 一致 | 两函数对路径的读写协议一致，packaged/dev 模式均正确 |
| 路径常量单一定义 | ✅ 良好 | PI_AGENT_DIR 定义一次，getPiAgentDir() 统一导出 |
| 跨进程 env 传递 | ✅ 完整 | rpc-client → spawn env → pi 子进程 → extension logger |

### 6.2 验证项矩阵

| # | 验证项 | 来源 (BLR §) | 状态 |
|---|--------|-------------|------|
| 1 | BLR dev 模式模拟路径与实际一致 | §5.1 | ✅ |
| 2 | BLR packaged 模式模拟路径与实际一致 | §5.2 | ✅ |
| 3 | BLR 日志路径与实际一致 | §5.3 | ✅ |
| 4 | BLR 数据隔离验证项全部可追溯 | §5.4 | ✅ |
| 5 | PI_CODING_AGENT_DIR 设置→传递→消费 完整 | — | ✅ |
| 6 | migrateToPiSubdir 时序在 session 创建之前 | — | ✅ |
| 7 | getExtensionPaths 跳过 shared/ 且不遗漏 extension | — | ✅ |
| 8 | 打包模式 bundled sync → scan 管道无断裂 | — | ✅ |
| 9 | 开发模式源码目录扫描正确 | — | ✅ |
| 10 | 所有文件系统操作不使用 ~/.pi/ | — | ✅ |

### 6.3 结论

**verdict: pass**

集成审查完成。三模块（logger.ts、session-service.ts、pi-config-bridge.ts）间的数据流完整、无断裂。所有路径常量在 `pi-config-bridge.ts` 中一次定义，通过 `getPiAgentDir()` 统一导出和消费。BLR 的模拟数据与实时代码完全一致。

0 条 MUST FIX，1 条 LOW（migrateToPiSubdir 一次性 sync 限制），2 条 INFO（dev 模式目录优先级 + shared/ 冗余）。

---

## 7. 附加：BLR 与本次集成审查的交叉引用

| BLR Issues | 本审查状态 | 一致性 |
|-----------|-----------|--------|
| Issue #1 (LOW) — logger fallback | 确认存在，确认在 xyz-agent 流程中不可达 | ✅ 一致 |
| Issue #2 (INFO) — dev 运行时目录优先级 | 确认存在，代码验证通过 | ✅ 一致 |
| Issue #3 (INFO) — 无全局去重 | 确认存在，代码验证通过 | ✅ 一致 |
| — (新增) Issue #1 (LOW) — bundled sync 一次性 | 本审查新发现 | — |

所有 3 个 BLR issue 均被本集成审查交叉验证确认，且 BLR 的全部模拟数据通过实际代码验证。本审查新发现 1 个 LOW 问题（bundled sync 一次性操作）。
