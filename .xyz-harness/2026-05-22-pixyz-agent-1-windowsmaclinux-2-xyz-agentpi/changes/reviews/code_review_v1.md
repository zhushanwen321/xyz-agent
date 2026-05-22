---
review:
  type: code_review
  round: 1
  timestamp: "2026-05-22T11:30:00"
  target: ".xyz-harness/2026-05-22-pixyz-agent-1-windowsmaclinux-2-xyz-agentpi"
  verdict: fail
  summary: "编码评审完成，第1轮，1条MUST FIX，需修改后重审"

statistics:
  total_issues: 3
  must_fix: 1
  must_fix_resolved: 0
  low: 1
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "src-electron/runtime/src/process-manager.ts:135"
    title: "打包模式下 createSession() 的 spawn 失败错误消息仍指向全局安装"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 2
    severity: LOW
    location: "src-electron/runtime/src/process-manager.ts:75"
    title: "ProcessManager 构造函数在打包模式下冗余日志"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 3
    severity: INFO
    location: "scripts/prepare-pi-resources.sh"
    title: "pi release asset 命名约定需外部验证"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 编码评审 v1

## 评审记录
- 评审时间：2026-05-22 11:30
- 评审类型：编码评审
- 评审对象：Bundle pi Binary into xyz-agent（spec + plan + git diff）

### 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST FIX | `src-electron/runtime/src/process-manager.ts:135` | 打包模式下，若 bundled pi binary 存在但 spawn 失败（权限/架构不匹配等），catch 块的错误消息仍指示用户全局安装 pi，而非告知用户安装可能损坏。spec FR-4 和 plan Task 2 Step 3 明确要求打包模式给出不同错误消息。 | 在 catch 块中添加 `if (process.env.XYZ_AGENT_PACKAGED === '1')` 分支，抛出 `Failed to start bundled pi process. The application installation may be corrupted.` |
| 2 | LOW | `src-electron/runtime/src/process-manager.ts:75` | ProcessManager 构造函数未根据打包模式抑制日志输出。打包模式下 `findPiExecutable()` 已通过 `console.log` 报告 bundled pi 路径，构造函数又会重复打印 `using pi at: ...`，产生冗余日志。 | 将 constructor 的日志用 `if (process.env.XYZ_AGENT_PACKAGED !== '1')` 包裹，打包模式只输出一条日志（由 findPiExecutable 负责） |
| 3 | INFO | `scripts/prepare-pi-resources.sh` | pi release asset 的命名约定（`pi-darwin-arm64.tar.gz`、`pi-windows-x64.zip` 等）基于 spec 假设，尚未与 `earendil-works/pi` 的实际 release 验证过。若 asset 名前缀或后缀与预期不符，prepare-pi-resources.sh 和 process-manager.ts 中的 binary 发现逻辑均会失效。 | 执行前先运行 `gh release view v0.75.4 -R earendil-works/pi --json assets` 确认 asset 命名格式；必要时在 CLAUDE.md 的 Risk Notes 中补充 |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程
> - **LOW**：建议修复，但不阻塞
> - **INFO**：观察记录，无需操作

#### 等级判定校准说明

| 问题 # | 判定依据 |
|--------|---------|
| 1 | 影响当前需求正确性（spec FR-4 要求打包模式错误消息正确）。非预存问题——这是本次变更未完成的实现项。符合 LOW 分级收紧规则「需求核心目标涉及的问题 → MUST_FIX」。 |
| 2 | 仅日志冗余，不影响功能。不满足 MUST_FIX 判断口诀中的任一条件（无数据丢失、无功能失效、无语义错误、无副作用、无时序错误）。 |
| 3 | 观察项，当前代码逻辑正确，仅在 release asset 命名变更时受影响。不满足 MUST_FIX 条件。 |

---

### 1. spec 合规检查

| FR | 状态 | 说明 |
|----|------|------|
| FR-1: 打包 pi Bun Binary | ✅ | electron-builder.yml 已配 extraResources；process-manager.ts 平台/架构映射正确 |
| FR-2: 打包预装 Extension | ✅ | prepare-pi-resources.sh 复制 subagent/goal/todo 三个 extension；submodule 已配置 |
| FR-3: 打包预装 Skill | ✅ | prepare-pi-resources.sh 复制 vendor/xyz-harness/skills/ |
| FR-4: 运行时 Binary 发现 | ⚠️ | `findPiExecutable()` 打包模式逻辑正确；但 spawn 失败的 catch 块未适配打包模式（见 #1） |
| FR-5: 环境变量注入 | ✅ | `PI_CODING_AGENT_DIR` 和 `XYZ_AGENT_PACKAGED` 均正确注入 |
| FR-6: electron-builder 配置 | ✅ | extraResources 配置正确，filter 排除了压缩包 |
| FR-7: Git Submodule 集成 | ✅ | .gitmodules 配置了两个 submodule |
| FR-8: CI 构建流程 | ✅ | release.yml checkout 含 submodules: recursive；有 prepare-pi-resources 步骤 |
| FR-9: 本地开发脚本 | ✅ | scripts/prepare-pi-resources.sh 已创建 |

### 2. 代码质量

**可读性：**
- `findPiExecutable()` 函数结构清晰：打包模式守卫在前，开发模式逻辑在后
- 注释解释了每个步骤的意图
- 变量名 `bundledPi`、`binaryName` 保持了语义清晰

**错误处理：**
- `findPiExecutable()` 打包模式找不到 binary 时抛出明确异常 ✅
- `createSession()` 的 catch 块在打包模式下未处理（见 MUST FIX #1）
- config-store.ts 的 guard 使用 `return null`，设计合理

**边界条件：**
- Windows `.exe` 后缀已处理
- 平台 `darwin/linux/win32` 映射完整
- `uname -m` → `process.arch` 的双重映射（脚本端和运行时端）保持一致

### 3. 架构合规

- **分层正确**：RuntimeManager（主进程）只负责注入 `XYZ_AGENT_PACKAGED` env；ProcessManager（Sidecar）负责解析 env 并发现 binary；RpcClient 负责注入 `PI_CODING_AGENT_DIR`。职责分离清晰 ✅
- **依赖方向正确**：Sidecar 不依赖 Electron API，仅通过 env 感知打包模式 ✅
- **未违反 CLAUDE.md 架构约束** ✅

### 4. 安全和性能

- **无安全漏洞**：env 变量注入不涉及用户输入；binary 路径拼接使用 `join()` 而非字符串拼接 ✅
- **无性能问题**：打包模式下的 `existsSync` 检查是单次 O(1) 操作 ✅
- **隔离性**：bundled pi 不读 `~/.pi/`，与系统 pi 严格隔离 ✅

### 5. 集成验证

**数据流：XYZ_AGENT_PACKAGED**
```
runtime-manager.ts (start) → spawnOptions.env → Sidecar process.env
  → process-manager.ts findPiExecutable() 读取 → 触发 bundled path
  → config-store.ts loadPiConfig()/readPiDefaultModel() 读取 → 跳过
```
路径完整 ✅

**数据流：PI_CODING_AGENT_DIR**
```
rpc-client.ts start() → env.PI_CODING_AGENT_DIR = join(cwd, 'pi', 'agent')
  → pi --mode rpc 进程读取 → 从 bundled agent 加载 extension/skill
```
路径完整 ✅

**集成风险点：process.cwd() 假设**
- runtime-manager.ts 设置 Sidecar cwd = `process.resourcesPath`（打包模式）
- process-manager.ts 和 rpc-client.ts 均假设 `process.cwd() === process.resourcesPath`
- 已验证 runtime 代码无 `chdir()` 调用，假设成立 ✅

### 6. CI 构建流程交叉检查

```
release.yml workflow:
  checkout (submodules: recursive)
  → setup-node
  → npm ci + src-electron npm install
  → Lint + TypeCheck + Test
  → Download and prepare pi resources (prepare-pi-resources.sh)
  → Build (electron-builder)
  → Upload artifacts
```

步骤顺序正确：资源准备在 Build 之前，Test 不影响资源准备 ✅

### 7. 跨平台检查

| 平台 | binary 命名 | 检测途径 |
|------|------------|---------|
| macOS arm64 | `pi-darwin-arm64` | `process.platform === 'darwin' && process.arch === 'arm64'` |
| Linux x64 | `pi-linux-x64` | `process.platform === 'linux' && process.arch === 'x64'` |
| Windows x64 | `pi-windows-x64.exe` | `process.platform === 'win32' && process.arch === 'x64'` |

- PATH delimiter 使用 `node:path` 的 `delimiter`，自动适配平台 ✅
- `existsSync` 在各平台行为一致 ✅

### 补充观察

- ESLint config 添加 `vendor/**` 忽略，避免 lint submodule 代码，合理 ✅
- electron-builder.yml 的 `from: resources/pi` 相对于 `src-electron/` 工作目录，与 prepare-pi-resources.sh 的 `src-electron/resources/pi` 目标路径一致 ✅
- prepare-pi-resources.sh 使用 `pushd/popd`（bash 特性），CI 使用 `shell: bash`，兼容 ✅
- `.gitkeep` 文件确保空目录被 git 跟踪 ✅

---

## 结论

需修改后重审。1 条 MUST FIX（createSession 打包模式错误消息）需修复后重新提交。

### Summary

编码评审完成，第1轮，1条MUST FIX，需修改后重审。
