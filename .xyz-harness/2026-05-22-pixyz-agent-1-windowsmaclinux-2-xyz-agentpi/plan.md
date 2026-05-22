---
verdict: pass
---

# Bundle pi Binary into xyz-agent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bundle pi Bun binary + preinstalled extensions/skills into xyz-agent's packaged app, replacing the external pi dependency with a self-contained binary.

**Architecture:** pi's pre-built Bun standalone binary (from GitHub Release) is placed in Electron's `extraResources`. Runtime code detects packaged mode via `XYZ_AGENT_PACKAGED` env var and resolves the binary path from `process.cwd()/pi/`. `PI_CODING_AGENT_DIR` env var redirects pi's agent directory to the bundled extensions/skills. Git submodules provide extension/skill source at build time.

**Tech Stack:** Electron (electron-builder), Bash (CI scripts), TypeScript (runtime modifications)

---

## File Structure

| File | Type | Group | Description |
|------|------|-------|-------------|
| `src-electron/runtime/src/process-manager.ts` | modify | BG1 | Binary 发现逻辑（packaged vs dev 模式） |
| `src-electron/runtime/src/rpc-client.ts` | modify | BG1 | 注入 PI_CODING_AGENT_DIR 环境变量 |
| `src-electron/main/runtime-manager.ts` | modify | BG1 | 注入 XYZ_AGENT_PACKAGED 环境变量 |
| `src-electron/runtime/src/config-store.ts` | modify | BG1 | readPiDefaultModel 改为从 bundled agent 读取 |
| `src-electron/electron-builder.yml` | modify | BG2 | extraResources 配置 |
| `scripts/prepare-pi-resources.sh` | create | BG2 | 本地构建资源准备脚本 |
| `.gitmodules` | modify | BG2 | 添加 xyz-pi-extensions + xyz-harness submodule |
| `vendor/xyz-pi-extensions/` | create | BG2 | Git submodule (subagent/goal/todo) |
| `vendor/xyz-harness/` | create | BG2 | Git submodule (19 skills) |
| `.github/workflows/release.yml` | modify | BG2 | CI 下载 binary + 复制 extension/skill 步骤 |
| `src-electron/resources/pi/.gitkeep` | create | BG2 | 占位文件确保空目录被 git 跟踪 |

---

## Task List

| # | Task | Type | Depends on | Group |
|---|------|------|-----------|-------|
| 1 | 修改 runtime-manager 注入 XYZ_AGENT_PACKAGED | backend | — | BG1 |
| 2 | 修改 process-manager 支持 bundled binary 发现 | backend | 1 | BG1 |
| 3 | 修改 rpc-client 注入 PI_CODING_AGENT_DIR | backend | 1 | BG1 |
| 4 | 修改 config-store 跳过 ~/.pi 读取 | backend | 2 | BG1 |
| 5 | 添加 git submodule + electron-builder 配置 | backend | — | BG2 |
| 6 | 创建 prepare-pi-resources.sh 本地构建脚本 | backend | 5 | BG2 |
| 7 | 修改 release.yml CI 构建流程 | backend | 5 | BG2 |

---

## Execution Groups

### BG1: Runtime Binary Discovery and Env Injection

**Description:** 修改 runtime 层代码，让打包模式下 Sidecar 能发现并正确启动 bundled pi binary，注入正确的环境变量。

**Tasks:** Task 1, Task 2, Task 3, Task 4

**Files (预估):** 4 个文件（0 create + 4 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose → general-purpose |
| Model | 按 taskComplexity 自动选择（executor: high、tdd-coder: medium） |
| 注入上下文 | Task 1-4 描述、spec FR-4/FR-5、CLAUDE.md 架构约束 |
| 读取文件 | `src-electron/runtime/src/process-manager.ts`, `src-electron/runtime/src/rpc-client.ts`, `src-electron/main/runtime-manager.ts`, `src-electron/runtime/src/config-store.ts` |
| 修改/创建文件 | 上述 4 个文件 |

**Dependencies:** 无

**设计细节:**

#### Task 1: 修改 runtime-manager 注入 XYZ_AGENT_PACKAGED

**Files:**
- Modify: `src-electron/main/runtime-manager.ts:195` (spawn env 部分)

**背景:** runtime-manager.ts 的 `start()` 方法在打包模式下 spawn Sidecar 子进程时，需要通过环境变量告知 Sidecar 当前处于打包模式。Sidecar 不是 Electron 进程，无法调用 `app.isPackaged`，必须通过 env 传递。

- [ ] **Step 1: 修改 spawnOptions.env**

在 `runtime-manager.ts` 的 `start()` 方法中，修改 spawnOptions 的 env 行（约第 195 行）：

```typescript
env: {
  ...process.env,
  ELECTRON_RUN_AS_NODE: app.isPackaged ? '1' : undefined,
  XYZ_AGENT_PACKAGED: app.isPackaged ? '1' : undefined,
},
```

- [ ] **Step 2: 验证**

确认 TypeScript 编译通过：
```bash
cd src-electron && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src-electron/main/runtime-manager.ts
git commit -m "feat: inject XYZ_AGENT_PACKAGED env var into sidecar process"
```

#### Task 2: 修改 process-manager 支持 bundled binary 发现

**Files:**
- Modify: `src-electron/runtime/src/process-manager.ts`

**背景:** process-manager.ts 的 `findPiExecutable()` 当前搜索 PATH/nvm/通用路径。需要在打包模式（`process.env.XYZ_AGENT_PACKAGED === '1'`）下改为仅查找 bundled binary。

- [ ] **Step 1: 修改 findPiExecutable() 函数**

在 `findPiExecutable()` 函数最前面添加打包模式分支：

```typescript
function findPiExecutable(): string {
  // Packaged mode: use bundled pi binary from resources
  if (process.env.XYZ_AGENT_PACKAGED === '1') {
    const platform = process.platform  // 'darwin' | 'win32' | 'linux'
    const arch = process.arch          // 'arm64' | 'x64'

    // Map process.arch to pi binary arch naming
    // pi releases use: arm64, x64 (matches Node.js process.arch)
    const binaryName = platform === 'win32'
      ? `pi-windows-${arch}.exe`
      : `pi-${platform}-${arch}`

    // Sidecar's cwd = process.resourcesPath (set by runtime-manager.ts)
    const bundledPi = join(process.cwd(), 'pi', binaryName)

    if (!existsSync(bundledPi)) {
      throw new Error(
        `Bundled pi binary not found at ${bundledPi}. `
        + `Expected binary: ${binaryName}. `
        + `The application installation may be corrupted.`,
      )
    }

    console.log(`[process-manager] using bundled pi: ${bundledPi}`)
    return bundledPi
  }

  // Development mode: original discovery logic (unchanged below)
  const isWindows = process.platform === 'win32'
  // ... 保留原有逻辑不变
```

- [ ] **Step 2: 修改 ProcessManager constructor**

修改 constructor，让它在打包模式下不显示 "pi not found" 警告：

```typescript
constructor() {
  this.piPath = findPiExecutable()
  if (process.env.XYZ_AGENT_PACKAGED !== '1') {
    // Dev mode logging only
    if (this.piPath !== 'pi') {
      console.log(`[process-manager] using pi at: ${this.piPath}`)
    } else {
      console.warn('[process-manager] pi not found in common locations, relying on PATH')
    }
  }
}
```

- [ ] **Step 3: 修改 createSession() 错误消息**

修改 `createSession()` 的 catch 块，打包模式下给出不同的错误消息：

```typescript
if (msg.includes('spawn') || msg.includes('ENOENT')) {
  if (process.env.XYZ_AGENT_PACKAGED === '1') {
    throw new Error(
      `Failed to start bundled pi process. The application installation may be corrupted. `
      + `Attempted binary: ${this.piPath}. Original error: ${msg}`,
    )
  }
  throw new Error(
    `Failed to start pi process. Ensure pi is installed globally (npm i -g @mariozechner/pi-coding-agent). `
    + `Searched: PATH, ~/.nvm/versions/*/bin/pi, /usr/local/bin/pi. `
    + `Original error: ${msg}`,
  )
}
```

- [ ] **Step 4: 验证**

```bash
cd src-electron && npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add src-electron/runtime/src/process-manager.ts
git commit -m "feat: add bundled pi binary discovery for packaged mode"
```

#### Task 3: 修改 rpc-client 注入 PI_CODING_AGENT_DIR

**Files:**
- Modify: `src-electron/runtime/src/rpc-client.ts`

**背景:** rpc-client.ts 的 `start()` 方法 spawn pi 时需要注入 `PI_CODING_AGENT_DIR` 环境变量，让 pi 从 bundled agent 目录加载 extension/skill，而非默认的 `~/.pi/agent/`。

- [ ] **Step 1: 在 start() 方法中注入 PI_CODING_AGENT_DIR**

在 `start()` 方法中，`const env: Record<string, string>` 赋值之后、`buildProviderEnv` 调用之前，添加：

```typescript
// Packaged mode: redirect pi's agent directory to bundled resources
if (process.env.XYZ_AGENT_PACKAGED === '1') {
  const agentDir = join(process.cwd(), 'pi', 'agent')
  env.PI_CODING_AGENT_DIR = agentDir
}
```

注意：这行必须在 `Object.assign(env, buildProviderEnv(providerId))` 之前，因为 provider env 不应覆盖 PI_CODING_AGENT_DIR。

- [ ] **Step 2: 验证**

```bash
cd src-electron && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src-electron/runtime/src/rpc-client.ts
git commit -m "feat: inject PI_CODING_AGENT_DIR for bundled pi"
```

#### Task 4: 修改 config-store 跳过 ~/.pi 读取

**Files:**
- Modify: `src-electron/runtime/src/config-store.ts`

**背景:** config-store.ts 中有两个函数读取 `~/.pi/` 目录：`readPiDefaultModel()` 读取 `models.json`，`loadPiConfig()` 读取 `config.json`。打包模式下两者都必须跳过，实现 spec 约束「不读 ~/.pi/」。

- [ ] **Step 1: 修改 loadPiConfig() 添加打包模式守卫**

在 `loadPiConfig()` 函数体最前面添加：

```typescript
function loadPiConfig(): Record<string, ProviderConfig> | null {
  // Packaged mode: do not read ~/.pi/config.json (spec constraint)
  if (process.env.XYZ_AGENT_PACKAGED === '1') return null

  try {
    // ... 保留原有逻辑不变
```

- [ ] **Step 2: 修改 readPiDefaultModel() 添加打包模式守卫**

在 `readPiDefaultModel()` 函数体最前面添加：

```typescript
function readPiDefaultModel(): string | null {
  // Packaged mode: no models.json bundled, skip reading
  if (process.env.XYZ_AGENT_PACKAGED === '1') return null

  try {
    // ... 保留原有逻辑不变
```

- [ ] **Step 3: 验证**

```bash
cd src-electron && npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add src-electron/runtime/src/config-store.ts
git commit -m "feat: skip ~/.pi/ reads in packaged mode (config.json + models.json)"
```

---

### BG2: Build Configuration and CI Pipeline

**Description:** 配置 git submodule、electron-builder extraResources、CI 下载 binary 流程、本地构建脚本。

**Tasks:** Task 5, Task 6, Task 7

**Files (预估):** 6 个文件（3 create + 3 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose |
| Model | 按 taskComplexity 自动选择（executor: high、reviewer: medium） |
| 注入上下文 | Task 5-7 描述、spec FR-6/FR-7/FR-8/FR-9、electron-builder.yml 格式 |
| 读取文件 | `src-electron/electron-builder.yml`, `.github/workflows/release.yml`, `.gitmodules` (if exists) |
| 修改/创建文件 | 见上方 File Structure |

**Dependencies:** 无（与 BG1 独立，可并行）

**设计细节:**

#### Task 5: 添加 git submodule + electron-builder 配置

**Files:**
- Modify: `.gitmodules`
- Create: `vendor/xyz-pi-extensions/` (submodule)
- Create: `vendor/xyz-harness/` (submodule)
- Modify: `src-electron/electron-builder.yml`
- Create: `src-electron/resources/pi/.gitkeep`

- [ ] **Step 1: 添加 git submodule**

```bash
git submodule add https://github.com/zhushanwen321/xyz-pi-extensions.git vendor/xyz-pi-extensions
git submodule add https://github.com/zhushanwen321/xyz-harness.git vendor/xyz-harness
```

- [ ] **Step 2: 创建 resources/pi 占位目录**

```bash
mkdir -p src-electron/resources/pi
touch src-electron/resources/pi/.gitkeep
```

- [ ] **Step 3: 修改 electron-builder.yml 添加 extraResources**

在 `asarUnpack` 段落之后添加：

```yaml
# pi Bun binary + extensions + skills
extraResources:
  - from: src-electron/resources/pi
    to: pi
    filter:
      - "**/*"
      - "!**/*.tar.gz"
      - "!**/*.zip"
```

注意 `from` 路径是相对于项目根目录（electron-builder 从 package.json 所在目录运行，即 `src-electron/`），但 `src-electron/resources/pi` 相对于项目根目录。需要确认 electron-builder 的工作目录。electron-builder 在 `src-electron/` 目录下运行（`working-directory: src-electron`），所以 `from` 路径应为 `resources/pi`。

```yaml
extraResources:
  - from: resources/pi
    to: pi
    filter:
      - "**/*"
      - "!**/*.tar.gz"
      - "!**/*.zip"
```

- [ ] **Step 4: Commit**

```bash
git add .gitmodules vendor/ src-electron/resources/pi/.gitkeep src-electron/electron-builder.yml
git commit -m "feat: add pi vendor submodules and electron-builder extraResources config"
```

#### Task 6: 创建 prepare-pi-resources.sh 本地构建脚本

**Files:**
- Create: `scripts/prepare-pi-resources.sh`

- [ ] **Step 1: 创建脚本**

```bash
#!/usr/bin/env bash
# prepare-pi-resources.sh — Download pi binary and copy extensions/skills for local build testing.
# Usage: ./scripts/prepare-pi-resources.sh [PI_VERSION]
set -euo pipefail

PI_VERSION="${1:-0.75.4}"
PLATFORM="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
# Map uname -m to pi binary arch
case "$ARCH" in
  arm64|aarch64) PI_ARCH="arm64" ;;
  x86_64|amd64)  PI_ARCH="x64" ;;
  *) echo "Unsupported arch: $ARCH" >&2; exit 1 ;;
esac

RESOURCES_DIR="src-electron/resources/pi"
AGENT_DIR="${RESOURCES_DIR}/agent"
EXTENSIONS_DIR="${AGENT_DIR}/extensions"
SKILLS_DIR="${AGENT_DIR}/skills"

echo "=== prepare-pi-resources ==="
echo "Platform: ${PLATFORM}  Arch: ${PI_ARCH}  Version: ${PI_VERSION}"

# --- Download pi binary ---
if [ "$PLATFORM" = "darwin" ]; then
  ASSET="pi-darwin-${PI_ARCH}.tar.gz"
elif [ "$PLATFORM" = "linux" ]; then
  ASSET="pi-linux-${PI_ARCH}.tar.gz"
elif [ "$PLATFORM" = "mingw"* ] || [ "$PLATFORM" = "msys"* ] || [ "$PLATFORM" = "cygwin"* ]; then
  ASSET="pi-windows-${PI_ARCH}.zip"
else
  echo "Unknown platform: $PLATFORM" >&2; exit 1
fi

mkdir -p "$RESOURCES_DIR"

if [ -f "${RESOURCES_DIR}/${ASSET%.tar.gz}" ] || [ -f "${RESOURCES_DIR}/${ASSET%.zip}" ] || [ -f "${RESOURCES_DIR}/${ASSET%.zip}.exe" ]; then
  echo "Binary already exists, skipping download."
else
  echo "Downloading pi v${PI_VERSION} (${ASSET})..."
  gh release download "v${PI_VERSION}" \
    -R earendil-works/pi \
    -p "$ASSET" \
    -D "$RESOURCES_DIR" \
    --clobber

  echo "Extracting..."
  cd "$RESOURCES_DIR"
  if [[ "$ASSET" == *.tar.gz ]]; then
    tar xzf "$ASSET"
  else
    unzip -o "$ASSET"
  fi
  rm -f "$ASSET"
  chmod +x pi-* 2>/dev/null || true
  cd - > /dev/null
fi

# --- Copy extensions from vendor submodule ---
echo "Copying extensions from vendor/xyz-pi-extensions/..."
mkdir -p "$EXTENSIONS_DIR"
for ext in subagent goal todo; do
  if [ -d "vendor/xyz-pi-extensions/${ext}" ]; then
    cp -RL "vendor/xyz-pi-extensions/${ext}" "$EXTENSIONS_DIR/"
    echo "  ✓ ${ext}"
  else
    echo "  ✗ ${ext} (submodule not initialized? run: git submodule update --init)"
  fi
done

# --- Copy skills from vendor submodule ---
echo "Copying skills from vendor/xyz-harness/skills/..."
mkdir -p "$SKILLS_DIR"
if [ -d "vendor/xyz-harness/skills" ]; then
  cp -RL vendor/xyz-harness/skills/* "$SKILLS_DIR/"
  SKILL_COUNT=$(ls -1 "$SKILLS_DIR" | wc -l | tr -d ' ')
  echo "  ✓ ${SKILL_COUNT} skills copied"
else
  echo "  ✗ vendor/xyz-harness/skills/ not found (submodule not initialized?)"
fi

echo "=== Done ==="
echo "Resources ready at: ${RESOURCES_DIR}/"
ls -la "$RESOURCES_DIR/"
```

- [ ] **Step 2: 设置可执行权限**

```bash
chmod +x scripts/prepare-pi-resources.sh
```

- [ ] **Step 3: Commit**

```bash
git add scripts/prepare-pi-resources.sh
git commit -m "feat: add prepare-pi-resources.sh for local build testing"
```

#### Task 7: 修改 release.yml CI 构建流程

**Files:**
- Modify: `.github/workflows/release.yml`

**背景:** release.yml 的 build job 需要在 `npm run build` 之前下载 pi binary 并从 submodule 复制 extension/skill 到 `src-electron/resources/pi/`。

- [ ] **Step 1: 修改 checkout step 添加 submodules**

将 checkout step 改为：

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
    submodules: recursive
```

- [ ] **Step 2: 添加 "Download and prepare pi resources" step**

在 "Build" step 之前、 "Lint" step 之后添加：

```yaml
- name: Download and prepare pi resources
  shell: bash
  env:
    PI_VERSION: '0.75.4'
  run: |
    chmod +x scripts/prepare-pi-resources.sh
    ./scripts/prepare-pi-resources.sh "$PI_VERSION"
  # prepare-pi-resources.sh 会自动检测平台并下载对应 binary
```

注意：复用 `scripts/prepare-pi-resources.sh` 脚本，而非在 CI 中写独立逻辑。好处：本地和 CI 使用同一份脚本，减少维护成本。CI 中 `gh` CLI 已预装且有 `GITHUB_TOKEN` 权限。

- [ ] **Step 3: 验证 YAML 格式**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml'))"
```

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "feat: add pi binary download to CI release workflow"
```

---

## Dependency Graph & Wave Schedule

```
BG1 (Runtime 改动) ────────────→ 集成测试
BG2 (Build 配置 + CI) ─────────→ 集成测试
```

| Wave | Groups | 说明 |
|------|--------|------|
| Wave 1 | BG1, BG2 | 两个 Group 无依赖，可并行执行 |
| Wave 2 | 集成测试 | 两个 Group 都完成后验证 |

**并行约束:** BG1 和 BG2 修改不同文件，可安全并行。

---

## Risk Notes

1. **process.cwd() 假设**: BG1 依赖 Sidecar 在打包模式下 `process.cwd() === process.resourcesPath`。这由 `runtime-manager.ts` 第 188 行 `const cwd = app.isPackaged ? process.resourcesPath : projectRoot` 保证。如果 Sidecar 代码中有 `chdir()` 调用则会失效。已验证 runtime 代码无 chdir 调用。

2. **Windows .exe 后缀**: `findPiExecutable()` 在 win32 平台拼接 `.exe` 后缀。CI 脚本不重命名下载的 binary，依赖 pi release 中 Windows binary 本身包含 `.exe` 后缀。如果 pi 的 Windows release 不含 `.exe`，需要在 prepare-pi-resources.sh 中 rename。**需要在 plan 执行时首先验证。**

3. **pi binary 实际文件名**: pi release asset 是 `pi-windows-x64.zip`，解压后的文件名需要验证是否为 `pi-windows-x64.exe`。Task 5 的执行 subagent 应先运行 `gh release download` + `unzip -l` 确认。

4. **Submodule 初始化**: 新 clone 的开发者需要 `git submodule update --init --recursive`。在 CLAUDE.md 中补充说明。

5. **macOS codesigning**: 当前 CI 未配置 Apple Developer 证书（`CSC_IDENTITY_AUTO_DISCOVERY: false`）。pi binary 不需要单独签名（electron-builder 会处理 extraResources 中的 binary）。未来配置 codesigning 时需验证 pi binary 是否被覆盖签名。
