# Electron 打包最佳实践调研报告

> 调研日期：2026-05-31
> 项目上下文：xyz-agent（Electron 33 + electron-builder 25 + tsup + Node.js sidecar）

---

## 目录

1. [electron-builder 打包约束与验证方案](#1-electron-builder-打包约束与验证方案)
2. [tsup 打包 Node.js 代码为单文件 CJS](#2-tsup-打包-nodejs-代码为单文件-cjs)
3. [Electron 子进程与 asar/unpacked 路径问题](#3-electron-子进程与-asarunpacked-路径问题)
4. [开源 Electron 项目 CI/CD 经验](#4-开源-electron-项目-cicd-经验)
5. [针对 xyz-agent 的具体建议](#5-针对-xyz-agent-的具体建议)

---

## 1. electron-builder 打包约束与验证方案

### 1.1 预发布检查清单（Preflight Checks）

#### 必检项

| 检查项 | 命令/方法 | 失败影响 |
|--------|----------|---------|
| **package.json 完整性** | `npm pkg get name version main` 必须存在 | 打包失败 |
| **main 入口文件存在** | `ls dist/main/main.cjs` | 白屏/无法启动 |
| **appId 格式** | 必须是反向域名格式（`com.xyz-agent.app`） | macOS 签名失败 |
| **版本号格式** | 必须 semver 兼容 | publish 失败 |
| **依赖完整性** | `npm ls --all --production` 无 missing | 运行时 crash |
| **签名证书** | macOS: `security find-identity -v -p codesigning` | 签名失败 |
| **asar 产物验证** | `asar list app.asar \| head -20` | 缺文件 |
| **unpacked 目录验证** | `ls app.asar.unpacked/dist/runtime/` | sidecar 无法启动 |

#### 验证脚本模板

```bash
#!/bin/bash
# scripts/preflight-check.sh — 打包前验证

set -euo pipefail

echo "=== Electron Builder Preflight Checks ==="

# 1. 基础文件检查
echo "[1/7] Checking package.json fields..."
node -e "
  const pkg = require('./package.json');
  const required = ['name', 'version', 'main', 'description'];
  for (const f of required) {
    if (!pkg[f]) { console.error('Missing:', f); process.exit(1); }
  }
  if (!/^\d+\.\d+\.\d+/.test(pkg.version)) {
    console.error('Invalid semver:', pkg.version); process.exit(1);
  }
  console.log('  ✓', pkg.name, pkg.version);
"

# 2. main 入口存在性
echo "[2/7] Checking main entry..."
MAIN_ENTRY=$(node -e "console.log(require('./package.json').main)")
if [ ! -f "$MAIN_ENTRY" ]; then
  echo "  ✗ Main entry not found: $MAIN_ENTRY"
  echo "    Run: npm run build:main"
  exit 1
fi
echo "  ✓ $MAIN_ENTRY exists"

# 3. runtime 产物
echo "[3/7] Checking runtime bundle..."
if [ ! -f "dist/runtime/index.cjs" ]; then
  echo "  ✗ Runtime bundle not found: dist/runtime/index.cjs"
  echo "    Run: npm run build:runtime"
  exit 1
fi
echo "  ✓ dist/runtime/index.cjs exists"

# 4. renderer 产物
echo "[4/7] Checking renderer bundle..."
if [ ! -f "renderer/dist/index.html" ]; then
  echo "  ✗ Renderer not built"
  echo "    Run: npm run build:vite"
  exit 1
fi
echo "  ✓ renderer/dist/index.html exists"

# 5. 生产依赖检查
echo "[5/7] Checking production dependencies..."
npm ls --all --omit=dev 2>/dev/null || {
  echo "  ⚠ Some dependencies may be missing"
}

# 6. electron-builder 配置验证
echo "[6/7] Validating electron-builder config..."
npx electron-builder --config ./electron-builder.yml --validate 2>/dev/null || {
  echo "  ⚠ electron-builder --validate not supported in this version"
  echo "  Checking YAML syntax instead..."
  node -e "const fs = require('fs'); require('js-yaml').load(fs.readFileSync('electron-builder.yml', 'utf8')); console.log('  ✓ YAML valid')" 2>/dev/null || echo "  ⚠ Install js-yaml for config validation"
}

# 7. 磁盘空间检查
echo "[7/7] Checking disk space..."
AVAILABLE_GB=$(df -g . | tail -1 | awk '{print $4}')
if [ "$AVAILABLE_GB" -lt 5 ]; then
  echo "  ⚠ Low disk space: ${AVAILABLE_GB}GB available (recommend ≥5GB)"
else
  echo "  ✓ ${AVAILABLE_GB}GB available"
fi

echo ""
echo "=== All preflight checks passed ==="
```

### 1.2 打包后产物验证（Post-Build Validation）

```bash
#!/bin/bash
# scripts/postbuild-validate.sh — 打包后验证

set -euo pipefail
OUTPUT_DIR="dist/builder-output"

echo "=== Post-Build Validation ==="

# 1. 产物存在性
echo "[1/5] Checking build artifacts..."
ARTIFACT_COUNT=$(find "$OUTPUT_DIR" -maxdepth 1 \( -name "*.dmg" -o -name "*.zip" -o -name "*.exe" -o -name "*.AppImage" -o -name "*.deb" \) | wc -l)
if [ "$ARTIFACT_COUNT" -eq 0 ]; then
  echo "  ✗ No build artifacts found in $OUTPUT_DIR"
  exit 1
fi
echo "  ✓ Found $ARTIFACT_COUNT artifact(s)"

# 2. macOS: 验证 app 结构
if [ -d "$OUTPUT_DIR/mac-arm64" ]; then
  APP_PATH=$(find "$OUTPUT_DIR/mac-arm64" -name "*.app" -maxdepth 1 | head -1)
  if [ -n "$APP_PATH" ]; then
    echo "[2/5] Validating macOS app structure..."
    
    # Info.plist 存在
    if [ -f "$APP_PATH/Contents/Info.plist" ]; then
      echo "  ✓ Info.plist exists"
    else
      echo "  ✗ Missing Info.plist"
      exit 1
    fi
    
    # main 入口
    MAIN_EXE=$(find "$APP_PATH/Contents/MacOS" -type f -maxdepth 1 | head -1)
    if [ -n "$MAIN_EXE" ]; then
      echo "  ✓ Main executable: $(basename "$MAIN_EXE")"
    else
      echo "  ✗ No main executable"
      exit 1
    fi
    
    # asar 文件
    if [ -f "$APP_PATH/Contents/Resources/app.asar" ]; then
      echo "  ✓ app.asar exists"
      
      # 验证关键文件在 asar 内
      ASAR_FILES=$(npx asar list "$APP_PATH/Contents/Resources/app.asar" 2>/dev/null || true)
      echo "  ℹ asar contains $(echo "$ASAR_FILES" | wc -l) files"
      
      # 检查 main 入口
      if echo "$ASAR_FILES" | grep -q "dist/main/main.cjs"; then
        echo "  ✓ dist/main/main.cjs in asar"
      else
        echo "  ✗ dist/main/main.cjs NOT in asar"
        exit 1
      fi
    fi
    
    # unpacked runtime
    if [ -d "$APP_PATH/Contents/Resources/app.asar.unpacked/dist/runtime" ]; then
      echo "  ✓ Runtime unpacked correctly"
      RUNTIME_SIZE=$(du -sm "$APP_PATH/Contents/Resources/app.asar.unpacked/dist/runtime" | cut -f1)
      echo "  ℹ Runtime size: ${RUNTIME_SIZE}MB"
    else
      echo "  ✗ Runtime not in app.asar.unpacked"
      exit 1
    fi
    
    # extraResources (pi binary)
    if [ -d "$APP_PATH/Contents/Resources/pi" ]; then
      echo "  ✓ pi binary in Resources"
      PI_SIZE=$(du -sm "$APP_PATH/Contents/Resources/pi" | cut -f1)
      echo "  ℹ pi size: ${PI_SIZE}MB"
    else
      echo "  ⚠ pi binary not found in Resources"
    fi
  fi
else
  echo "[2/5] Skipping macOS validation (no mac-arm64 directory)"
fi

# 3. 文件大小检查
echo "[3/5] Checking artifact sizes..."
for f in "$OUTPUT_DIR"/*.dmg "$OUTPUT_DIR"/*.zip "$OUTPUT_DIR"/*.exe; do
  if [ -f "$f" ]; then
    SIZE_MB=$(du -m "$f" | cut -f1)
    echo "  ℹ $(basename "$f"): ${SIZE_MB}MB"
    # DMG 通常 200-500MB（含 Electron + pi）
    if [[ "$f" == *.dmg ]] && [ "$SIZE_MB" -gt 800 ]; then
      echo "  ⚠ DMG exceeds 800MB, check for unnecessary files"
    fi
  fi
done

# 4. 代码签名验证 (macOS)
echo "[4/5] Code signature check..."
if [ -n "${APP_PATH:-}" ] && command -v codesign &>/dev/null; then
  if codesign --verify --verbose=1 "$APP_PATH" 2>&1; then
    echo "  ✓ Code signature valid"
  else
    echo "  ⚠ Code signature invalid or missing (OK for dev builds)"
  fi
fi

# 5. latest-mac.yml 完整性
echo "[5/5] Checking update metadata..."
if [ -f "$OUTPUT_DIR/latest-mac.yml" ]; then
  echo "  ✓ latest-mac.yml exists"
  # 验证 SHA512 存在
  if grep -q "sha512" "$OUTPUT_DIR/latest-mac.yml"; then
    echo "  ✓ SHA512 hashes present"
  fi
fi

echo ""
echo "=== Post-build validation complete ==="
```

### 1.3 CI/CD 中的打包阶段

```yaml
# GitHub Actions 典型流程
jobs:
  build:
    strategy:
      matrix:
        include:
          - os: macos-latest  # arm64
          - os: macos-13      # x64 (Intel)
          - os: windows-latest
          - os: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      
      # 关键：依赖安装要覆盖 src-electron/
      - run: npm ci
      - run: cd src-electron && ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
      
      # 预检查
      - run: bash scripts/preflight-check.sh
      
      # 构建
      - run: npm run build
      
      # 产物验证
      - run: bash scripts/postbuild-validate.sh
      
      # 启动测试（smoke test）
      - run: node scripts/smoke-test.mjs
      
      # 上传产物
      - uses: actions/upload-artifact@v4
        with:
          name: ${{ matrix.os }}-build
          path: src-electron/dist/builder-output/*
```

### 1.4 关键约束规则

1. **asar 限制**：asar 是只读归档，不能 `fs.writeFile` 到 asar 内路径。运行时写文件必须用 `app.getPath('userData')`。

2. **files 过滤要精确**：避免 `node_modules/**/*` 打进不需要的东西。用 `!` 排除测试、文档、`.map` 文件。

3. **asarUnpack 粒度**：只 unpack 必须被 Node.js 子进程直接 require/spawn 的文件。xyz-agent 的 `dist/runtime/**/*` 必须 unpack。

4. **extraResources vs extraFiles**：
   - `extraResources` → `Contents/Resources/`（macOS）或安装目录
   - `extraFiles` → `Contents/`（macOS）或安装根目录
   - pi binary 放 `extraResources` 是正确的

5. **node_modules 处理**：electron-builder 默认会 smart prune devDependencies。但如果用 tsup 预打包了 runtime，那 runtime 的 npm 依赖不需要在 node_modules 里（已在 bundle 中）。

---

## 2. tsup 打包 Node.js 代码为单文件 CJS

### 2.1 最佳配置

```ts
// tsup.config.ts — Electron sidecar/runtime 打包配置
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: '../dist/runtime',
  format: ['cjs'],           // Electron main process 用 CJS
  target: 'node22',          // 匹配 Electron 内置 Node 版本
  platform: 'node',          // 明确 Node.js 平台
  platform: 'node',          // 关键：自动将 Node 内置模块标为 external
  bundle: true,              // 打包为单文件
  clean: true,               // 清理输出目录
  splitting: false,          // CJS 不需要 code splitting
  sourcemap: false,          // 生产环境关闭（减小体积）
  minify: false,             // Node.js 代码不需要 minify

  // === 关键：依赖处理 ===

  // 打包进 bundle 的 npm 包
  // 规则：纯 JS 包、无 native addon、体积合理
  noExternal: [
    'ws',          // WebSocket 客户端
    'semver',      // 版本解析
    'fast-glob',   // 文件匹配
    // 新增依赖时必须加入此列表
  ],

  // 排除在外的模块
  external: [
    // Node.js 内置模块（node: 前缀）
    'node:child_process',
    'node:fs',
    'node:fs/promises',
    'node:http',
    'node:os',
    'node:path',
    'node:readline',
    'node:net',
    'node:url',
    'node:stream',
    'node:crypto',
    'node:events',
    'node:util',
    'node:buffer',
  ],
})
```

### 2.2 noExternal 配置决策矩阵

| 包类型 | 策略 | 原因 |
|--------|------|------|
| **ESM-only 包**（got@12, chalk@5） | `noExternal`（必须打包） | CJS 环境无法 require ESM |
| **Node native addon**（.node 文件） | `external` | tsup 无法处理二进制，需要单独复制 |
| **Electron 内置**（electron） | `external` | 只在 renderer 可用，sidecar 不能用 |
| **体积极大的包**（>5MB） | 评估 | 打包增加启动时间，权衡利弊 |
| **有副作用/动态 require 的包** | `external` 或 测试验证 | 动态 require 在 bundle 中会失败 |
| **monorepo 内部包**（@my-app/shared） | `noExternal` | 确保业务代码在同一 bundle |
| **node:* 内置模块** | `external` | 必须，否则打包会报错 |

### 2.3 常见问题与解决方案

#### 问题 1：动态 require 失败
```js
// 某些库内部用动态 require
const mod = require(someDynamicPath)
// tsup 打包后 this 会失败

// 解决：将该包加入 external
external: ['problematic-package']
```

#### 问题 2：native addon (.node)
```ts
// tsup 无法打包 .node 文件
// 解决：用 copy 插件或 electron-builder extraResources 处理

// tsup.config.ts
import { defineConfig } from 'tsup'
import { copyFileSync, mkdirSync } from 'fs'

export default defineConfig({
  // ... 其他配置
  external: ['native-module'],
  onSuccess: async () => {
    // 复制 .node 文件到输出目录
    mkdirSync('../dist/runtime/native', { recursive: true })
    copyFileSync(
      'node_modules/native-module/build/Release/module.node',
      '../dist/runtime/native/module.node'
    )
  }
})
```

#### 问题 3：CJS/ESM 互操作
```ts
// Electron main process 用 CJS，但某些依赖只有 ESM 导出
// tsup 的 noExternal 会自动处理转换，但需要确认

// 验证产物是否纯 CJS：
// node -e "const m = require('./dist/runtime/index.cjs'); console.log(typeof m)"
```

### 2.4 与 electron-builder 配合

```yaml
# electron-builder.yml 中确保 runtime 被正确包含
asarUnpack:
  - "dist/runtime/**/*"   # 必须 unpack，子进程直接 require

# 如果 runtime 有 native addon
extraResources:
  - from: src-electron/dist/runtime/native
    to: runtime-native
```

### 2.5 验证清单

```bash
# 1. 打包产物是纯 CJS
node -e "require('./dist/runtime/index.cjs')" && echo "✓ CJS valid"

# 2. 无 dangling require
node -e "
  const { execSync } = require('child_process');
  const output = execSync('grep -r \"require(\" dist/runtime/index.cjs | grep -v \"node:\" | head -20');
  console.log(output.toString());
"

# 3. 文件大小合理
du -m dist/runtime/index.cjs

# 4. 无 native addon 遗留问题
file dist/runtime/index.cjs  # 应该是 "ASCII text" 或类似
find dist/runtime -name "*.node"  # 不应该有（除非特意复制）

# 5. Electron 环境下能正常加载
node -e "process.env.ELECTRON_RUN_AS_NODE='1'; require('./dist/runtime/index.cjs')"
```

---

## 3. Electron 子进程与 asar/unpacked 路径问题

### 3.1 核心问题

Electron 打包后，`app.getAppPath()` 返回 `app.asar` 路径。asar 是一个**虚拟文件系统**：
- Electron 的 `fs` 模块被 patch 过，可以读取 asar 内的文件
- **但大部分 Node.js 子进程 API 不能读取 asar 内的文件**

**各 API 的 asar 支持情况（来自 Electron 官方文档）：**

| API | 是否支持 asar 内执行 | 说明 |
|-----|---------------------|------|
| `child_process.execFile` | ✅ 支持 | Electron 会自动提取到临时文件再执行 |
| `child_process.execFileSync` | ✅ 支持 | 同上 |
| `child_process.exec` | ❌ 不支持 | 接受 `command` 走 shell，无法判断 asar 路径 |
| `child_process.spawn` | ❌ 不支持 | 同 exec，接受 `command` 参数 |
| `child_process.fork` | ⚠️ 需特殊处理 | `cwd` 不能设为 asar 内目录 |

**`spawn` 不工作的根本原因**：接受的是 `command`（命令字符串），在 shell 中执行。Electron 无法可靠判断命令中是否引用了 asar 内文件，也无法安全替换路径。

### 3.2 路径解析规则

```ts
import { app } from 'electron'
import path from 'node:path'

// === asar 环境下的路径 ===

// 1. app.getAppPath() — asar 路径
app.getAppPath()
// → /path/to/app.asar（打包后）
// → /path/to/project（开发时）

// 2. __dirname / __filename — asar 内路径
// 在 main process 的 bundle 中：
// __dirname → /path/to/app.asar/dist/main
// 不能用于子进程 spawn！

// 3. process.resourcesPath — 资源根目录
process.resourcesPath
// → /path/to/MyApp.app/Contents/Resources（macOS）
// → /path/to/resources（Windows）

// 4. process.execPath — Electron 二进制路径
process.execPath
// → /path/to/MyApp.app/Contents/MacOS/MyApp
// 可用作 Node.js 解释器（配合 ELECTRON_RUN_AS_NODE）

// 5. app.getPath('exe') — 与 process.execPath 相同
app.getPath('exe')
```

### 3.3 正确的子进程启动方式

```ts
import { spawn } from 'node:child_process'
import { app } from 'electron'
import path from 'node:path'

function startSidecar(port: number) {
  // ✅ 正确：使用 unpacked 路径
  const runtimeDist = path.join(
    process.resourcesPath,
    'app.asar.unpacked',    // ← 关键：unpacked 目录
    'dist',
    'runtime',
    'index.cjs',
  )

  // ❌ 错误：使用 asar 路径
  // const runtimeDist = path.join(app.getAppPath(), 'dist', 'runtime', 'index.cjs')
  // → 路径指向 app.asar/dist/runtime/index.cjs，子进程读不到

  const cmd = process.execPath  // Electron 二进制
  const args = [runtimeDist, `--port=${port}`]

  const child = spawn(cmd, args, {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',  // ← 关键：让 Electron 以 Node.js 运行
    },
  })

  return child
}
```

### 3.4 electron-builder 中 asarUnpack 配置

```yaml
# electron-builder.yml
asar: true

# 必须被 unpack 的文件
asarUnpack:
  # 1. Runtime sidecar（子进程直接 require）
  - "dist/runtime/**/*"
  
  # 2. Native addons（.node 文件）
  - "node_modules/native-module/**/*"
  
  # 3. 需要被外部进程读取的资源
  # - "resources/scripts/**/*"

# 需要放在 Resources 根目录的资源（不在 asar 内）
extraResources:
  - from: resources/pi
    to: pi
    filter:
      - "**/*"
      - "!**/*.tar.gz"
```

**asarUnpack 的效果**：
- 配置 `"dist/runtime/**/*"` 后，electron-builder 会把 `dist/runtime/` 复制到 `app.asar.unpacked/dist/runtime/`
- 产物结构：
  ```
  Contents/Resources/
  ├── app.asar              ← 主应用代码（虚拟 FS）
  ├── app.asar.unpacked/    ← unpacked 文件（真实文件）
  │   └── dist/
  │       └── runtime/
  │           └── index.cjs
  └── pi/                   ← extraResources
  ```

### 3.5 常见陷阱

#### 陷阱 1：__dirname 在打包后指向 asar 内部
```ts
// ❌ 开发时 OK，打包后失败
const sidecarPath = path.join(__dirname, '../runtime/index.cjs')
// 打包后 __dirname = /path/to/app.asar/dist/main
// → 解析为 /path/to/app.asar/dist/runtime/index.cjs
// → 子进程读不到

// ✅ 正确做法
const sidecarPath = app.isPackaged
  ? path.join(process.resourcesPath, 'app.asar.unpacked', 'dist', 'runtime', 'index.cjs')
  : path.join(__dirname, '../runtime/src/index.ts')  // 开发用 tsx
```

#### 陷阱 2：process.execPath 的语义
```ts
// process.execPath 指向 Electron 二进制，不是 Node.js
// 默认启动 Electron 主进程，不是 Node.js
// 必须设置 ELECTRON_RUN_AS_NODE=1 才能作为 Node.js 使用

// ✅ 正确
spawn(process.execPath, ['script.js'], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
})

// ⚠️ 注意：ELECTRON_RUN_AS_NODE 下不能用任何 Electron API
// （BrowserWindow、ipcMain、app 等都不可用）
// xyz-agent 的 sidecar 是纯 Node.js 服务，不调 Electron API，所以没问题
```

#### 陷阱 3：路径替换的简单方法
```ts
// 通用工具函数：获取 unpacked 路径
function getUnpackedPath(relativePath: string): string {
  const appPath = app.getAppPath()
  // 开发环境直接返回
  if (!appPath.includes('.asar')) return path.join(appPath, relativePath)
  // 生产环境替换 app.asar → app.asar.unpacked
  return path.join(
    appPath.replace('app.asar', 'app.asar.unpacked'),
    relativePath,
  )
}

// 使用
const runtimePath = getUnpackedPath('dist/runtime/index.cjs')
```

#### 陷阱 4：extraResources 路径解析
```ts
// extraResources 放在 process.resourcesPath 下
const piBinary = path.join(process.resourcesPath, 'pi', 'pi')
// → /path/to/Contents/Resources/pi/pi（macOS）

// ❌ 不要用 app.getAppPath() 解析 extraResources
// ❌ 不要用 __dirname 解析 extraResources
```

#### 陷阱 4：Windows 路径差异
```ts
// Windows 上路径分隔符
path.join(process.resourcesPath, 'app.asar.unpacked', 'dist', 'runtime', 'index.cjs')
// → C:\Users\xxx\AppData\Local\Programs\xyz-agent\resources\app.asar.unpacked\dist\runtime\index.cjs

// 确保使用 path.join 而非字符串拼接
```

### 3.6 xyz-agent 当前实现的正确性验证

对照 `runtime-manager.ts` 的实现：

```ts
// ✅ 正确使用 app.isPackaged 区分环境
if (app.isPackaged) {
  // ✅ 正确使用 process.resourcesPath + app.asar.unpacked
  const runtimeDist = path.join(
    process.resourcesPath,
    'app.asar.unpacked',
    'dist',
    'runtime',
    RUNTIME_ENTRY_FILE,
  )
  // ✅ existsSync 检查
  if (!existsSync(runtimeDist)) { throw new Error(...) }
  // ✅ 使用 process.execPath + ELECTRON_RUN_AS_NODE
  cmd = process.execPath
  args = [runtimeDist, `--port=${port}`]
} else {
  // ✅ 开发环境用 tsx 运行 TS 源码
  const tsxPath = path.join(projectRoot, 'node_modules', '.bin', 'tsx')
  cmd = 'node'
  args = [tsxPath, runtimeEntry, `--port=${port}`]
}

// ✅ env 中设置 ELECTRON_RUN_AS_NODE
env: buildSafeEnv({
  ELECTRON_RUN_AS_NODE: app.isPackaged ? '1' : undefined,
})
```

### 3.7 xyz-agent 实现正确性验证

对照 `runtime-manager.ts` 的实现：

```ts
// ✅ 使用 spawn（不是 fork），配合 unpacked 路径 — 正确
// spawn 不支持 asar 内文件，但 xyz-agent 的 runtime 在 unpacked 目录
const runtimeDist = path.join(
  process.resourcesPath,
  'app.asar.unpacked',  // ← 关键：unpacked 目录
  'dist', 'runtime', RUNTIME_ENTRY_FILE,
)
// ✅ existsSync 检查防止打包错误
if (!existsSync(runtimeDist)) { throw new Error(...) }
// ✅ 使用 process.execPath（Electron 二进制）+ ELECTRON_RUN_AS_NODE
cmd = process.execPath
args = [runtimeDist, `--port=${port}`]
```

**结论：xyz-agent 使用 `spawn` + `app.asar.unpacked` 路径，完全绕过了 asar 限制，实现正确。**

### 3.8 fork 的特殊坑（electron/electron#2708）

如果未来需要用 `fork` 而非 `spawn`，注意 `cwd` 的限制：

```ts
// ❌ 不工作 — cwd 指向 asar 虚拟目录
const child = fork('./js/_launch.js', [], {
  cwd: __dirname  // → /path/to/app.asar/js — 虚拟目录
})

// ✅ 可行 — cwd 设为真实目录（resources/）
const child = fork('app.asar/js/_launch.js', [], {
  cwd: path.join(__dirname, '..')  // → resources/，真实目录
})
```

### 3.9 发现的改进点：tsup 缺少 `platform: 'node'`

当前 `src-electron/runtime/tsup.config.ts` 没有设置 `platform: 'node'`。

```diff
  // tsup.config.ts
  export default defineConfig({
    entry: ['src/index.ts'],
    outDir: '../dist/runtime',
    format: ['cjs'],
+   platform: 'node',    // 自动将 Node 内置模块标为 external
    target: 'node22',
    bundle: true,
```

**效果**：设置 `platform: 'node'` 后，tsup 会自动将所有 Node.js 内置模块（`fs`、`path`、`child_process` 等）标记为 external，**不再需要在 `external` 列表中手动列举每个 `node:*` 前缀模块**。

注意：这不会改变打包行为（当前手动列举已生效），但能减少配置维护负担——升级 Node.js 版本后新增的内置模块会被自动处理。

---

## 4. 开源 Electron 项目 CI/CD 经验

### 4.1 VS Code (Visual Studio Code)

| 维度 | 方案 |
|------|------|
| **构建系统** | 自研 Gulp → 自研构建管线（`strip-binaries.py` + `ninja`） |
| **CI/CD 平台** | Azure DevOps Pipelines（微软内部） |
| **Electron 定制** | 从 Chromium 源码级编译 → Electron → VS Code，支持对 Chromium 打 patch |
| **打包方式** | 非社区工具，自研脚本产出 ZIP/DMG/MSI/DEB |

**结论**：构建链路极度定制化（Chromium patch → Electron build → packaging），**不可复用**。

**唯一可借鉴**：多阶段 pipeline 结构——
```
compile (跨平台) → [macOS runner] → package + sign → notarize
                 → [Windows runner] → package + sign
                 → [Linux runner] → package → AppImage + deb + rpm
```

### 4.2 Notion Desktop

| 维度 | 方案 |
|------|------|
| **打包工具** | 封闭源码，具体不明；官方产出 DMG/EXE/DEB，通过自有 CDN 分发 |
| **社区方案** | `notion-enhancer/notion-repackaged` 通过 repackaging 实现定制 |
| **Flatpak** | 社区通过 `apply_extra` 在安装时从 Notion 服务器下载原始应用 |

**结论**：官方方案不公开。社区 repackaging 思路有参考价值（运行时下载 + 本地壳）。

### 4.3 Slack Desktop

| 维度 | 方案 |
|------|------|
| **架构模式** | **混合架构（Hybrid）**——本地只打包部分资源，大部分代码从远程 CDN 加载 |
| **历史** | 从 MacGap v1 → Electron，解决 HTTP/2、WKWebView 兼容问题 |
| **适用场景** | Web 应用已有成熟前端、桌面端只是壳 |

**可复用模式**：Hybrid 架构——桌面端只做本地壳 + 原生能力（通知、快捷键、tray），业务逻辑在远端。

### 4.4 Spotify Desktop

| 维度 | 方案 |
|------|------|
| **底层** | **不用 Electron**，用 C++ + CEF（Chromium Embedded Framework） |
| **架构** | C++ 后端处理音频缓冲和网络，前端 Web UI 通过 CEF 渲染 |

**结论**：非 Electron 项目，不适用。但统一 UI 层（一套 Web 代码）+ 多容器适配的思路可参考。

### 4.5 Discord Desktop

| 维度 | 方案 |
|------|------|
| **打包** | 自研打包系统，Squirrel.Windows / autoUpdater |
| **CI** | 内部 CI，多阶段测试：unit → integration → E2E（Spectron/Playwright） |
| **发布** | 灰度发布：canary → stable 逐步放量 |

**可复用模式**：灰度发布策略。

### 4.6 通用 CI/CD 最佳实践（综合多个项目）

#### 4.4.1 代码签名与公证

```yaml
# macOS Notarization（必需，否则 Gatekeeper 会阻止启动）
- name: Notarize
  if: runner.os == 'macOS'
  env:
    APPLE_ID: ${{ secrets.APPLE_ID }}
    APPLE_PASSWORD: ${{ secrets.APPLE_PASSWORD }}
    APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
  run: |
    # 提交公证
    xcrun notarytool submit "$ARTIFACT_PATH" \
      --apple-id "$APPLE_ID" \
      --password "$APPLE_PASSWORD" \
      --team-id "$APPLE_TEAM_ID" \
      --wait
    
    # Staple 公证票据
    xcrun stapler staple "$APP_PATH"
```

```yaml
# Windows Code Signing
- name: Sign Windows
  if: runner.os == 'Windows'
  run: |
    # 使用 signtool 或 DigiCert CertCache
    signtool sign /tr http://timestamp.digicert.com /td sha256 /fd sha256 /a "$ARTIFACT_PATH"
```

#### 4.4.2 多平台策略

| 策略 | 方案 | 适用场景 |
|------|------|---------|
| **Native runner** | 每个平台用对应 OS 的 runner | 最可靠，推荐 |
| **Docker** | Linux 打包在 Docker 中 | 跨平台 Linux 发行版 |
| **Cross-compile** | electron-builder 支持 `mac -> win` | 不推荐，签名有问题 |

```yaml
strategy:
  matrix:
    include:
      - os: macos-latest    # arm64
        build: npm run build:mac
      - os: macos-13        # x64 (Intel runner)
        build: npm run build:mac
      - os: windows-latest
        build: npm run build:win
      - os: ubuntu-latest
        build: npm run build:linux
```

#### 4.4.3 自动更新

```ts
// electron-updater 配置（推荐方案）
import { autoUpdater } from 'electron-updater'

autoUpdater.autoDownload = false  // 手动控制下载
autoUpdater.autoInstallOnAppQuit = true

autoUpdater.on('update-available', (info) => {
  // 通知用户有更新
})

autoUpdater.on('download-progress', (progress) => {
  // 显示下载进度
})
```

```yaml
# electron-builder.yml — publish 配置
publish:
  provider: github
  owner: zhushanwen321
  repo: xyz-agent
  releaseType: release
```

#### 4.4.4 版本管理

```bash
# 使用 standard-version 或 changeset 管理版本
npx changeset        # 记录变更
npx changeset version  # bump 版本
npm version patch    # 或手动 bump

# electron-builder 自动读取 package.json 的 version
# CI 中从 git tag 获取版本：
# VERSION=${GITHUB_REF#refs/tags/v}
```

#### 4.4.5 Smoke Test（启动测试）

```js
// scripts/smoke-test.mjs — 验证打包后应用能启动
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

// macOS
const app = spawn('open', ['-a', '/path/to/xyz-agent.app', '--wait-apps'], {
  timeout: 30000,
})

await sleep(5000)

// 验证端口
const resp = await fetch('http://localhost:1420')
if (!resp.ok) {
  console.error('App failed to start')
  process.exit(1)
}

console.log('✓ Smoke test passed')

// 关闭
spawn('osascript', ['-e', 'tell application "xyz-agent" to quit'])
```

---

## 5. 针对 xyz-agent 的具体建议

### 5.1 当前配置审查

| 配置项 | 当前状态 | 评估 |
|--------|---------|------|
| `asar: true` | ✅ | 正确 |
| `asarUnpack: dist/runtime/**/*` | ✅ | 正确，runtime 必须 unpack |
| `extraResources: pi` | ✅ | 正确，pi binary 在 Resources 根目录 |
| `files` 过滤 | ⚠️ | `node_modules/**/*` 太宽泛，建议更精确 |
| `publish` fallback | ✅ | localhost fallback 避免本地构建崩溃 |
| `mac.target` | ✅ | dmg + zip，arm64 only |
| `noExternal: [ws, semver, fast-glob]` | ✅ | 合理 |
| `runtime-manager.ts` 路径处理 | ✅ | 完全正确 |

### 5.2 优化建议

#### 建议 1：收紧 files 过滤

```yaml
# 当前
files:
  - dist/**/*
  - renderer/dist/**/*
  - package.json
  - node_modules/**/*

# 建议：更精确
files:
  - dist/main/**/*
  - dist/preload/**/*
  - renderer/dist/**/*
  - package.json
  # 只包含运行时需要的 node_modules
  - node_modules/electron-store/**/*
  - node_modules/markdown-it-footnote/**/*
  # 排除运行时不需要的
  - "!node_modules/**/test/**"
  - "!node_modules/**/tests/**"
  - "!node_modules/**/*.md"
  - "!node_modules/**/*.map"
  - "!node_modules/**/*.ts"
  - "!dist/runtime/**/*"       # runtime 在 asarUnpack 中
  - "!dist/builder-output/**/*"
```

#### 建议 2：添加 preflight 脚本到 build 命令

```json
{
  "scripts": {
    "build": "npm run preflight && npm run build:runtime && npm run build:vite && npm run build:main && npm run build:preload && npm run postbuild-validate && electron-builder --publish never",
    "preflight": "bash scripts/preflight-check.sh",
    "postbuild-validate": "bash scripts/postbuild-validate.sh"
  }
}
```

#### 建议 3：CI 中添加 smoke test

在 CI 的 build job 末尾添加启动测试，验证打包后的应用能正常启动和加载渲染进程。

#### 建议 4：考虑添加 electron-builder 的 buildVersion

```yaml
# electron-builder.yml
# buildVersion 用于区分同一 version 的不同构建
# 可以用 git short hash
# mac:
#   minimumSystemVersion: "12.0.0"
```

#### 建议 5：tsup 添加 `platform: 'node'`

```diff
  // tsup.config.ts
  export default defineConfig({
    entry: ['src/index.ts'],
    outDir: '../dist/runtime',
    format: ['cjs'],
+   platform: 'node',
    target: 'node22',
    bundle: true,
    clean: true,
-   noExternal: ['ws', 'semver', 'fast-glob'],
+   noExternal: ['ws', 'semver', 'fast-glob'],
-   external: [
-     'node:child_process', 'node:fs', 'node:fs/promises',
-     'node:http', 'node:os', 'node:path', 'node:readline',
-     'node:net', 'node:url',
-   ],
+   // platform: 'node' 自动处理所有 Node 内置模块，无需手动列举
+   external: [],
    splitting: false,
    sourcemap: false,
    minify: false,
  })
```

#### 建议 6：tsup 添加 onSuccess 验证

```ts
// tsup.config.ts
export default defineConfig({
  // ... 其他配置
  onSuccess: async () => {
    // 验证产物可以被 require
    const { execSync } = await import('node:child_process')
    try {
      execSync('node -e "require(\'../dist/runtime/index.cjs\')"', {
        stdio: 'pipe',
        timeout: 5000,
      })
      console.log('✓ Runtime bundle validated')
    } catch (err) {
      console.error('✗ Runtime bundle validation failed')
      throw err
    }
  }
})
```

### 5.3 已知风险

1. **runtime 新增 npm 依赖时**：必须同步更新 `noExternal` 列表，否则打包后运行时找不到。建议在 CI 中添加检测。

2. **Electron 版本升级**：`target: 'node22'` 需要随 Electron 的 Node.js 版本同步更新。Electron 33 内置 Node **20.18.x**，`target: 'node22'` 实际上高于运行环境——应改为 `'node20'`。

3. **macOS notarization**：目前未配置。当分发给其他用户时，macOS Gatekeeper 会阻止未公证的应用。需要在 CI 中集成 `notarytool`。

4. **Windows code signing**：未配置。Windows SmartScreen 会警告未签名的应用。

---

## 附录 A：关键命令速查

```bash
# 查看打包产物结构
npx asar list dist/builder-output/mac-arm64/xyz-agent.app/Contents/Resources/app.asar | head -50

# 提取 asar 内容（调试用）
npx asar extract app.asar /tmp/asar-extract

# 查看 unpacked 文件
find app.asar.unpacked -type f

# 验证 macOS 签名
codesign --verify --verbose=1 xyz-agent.app

# 查看应用 Info.plist
/usr/libexec/PlistBuddy -c "Print" xyz-agent.app/Contents/Info.plist

# 检查 Electron 版本和 Chrome 版本
node -e "console.log(process.versions)"
```

## 附录 B：参考资源

- [electron-builder 官方文档](https://www.electron.build/)
- [Electron asar 文档](https://www.electronjs.org/docs/latest/tutorial/asar-overview)
- [Electron 代码签名指南](https://www.electronjs.org/docs/latest/tutorial/code-signing)
- [Electron macOS Notarization](https://www.electronjs.org/docs/latest/tutorial/macos-notarization)
- [electron-builder CI 集成](https://www.electron.build/multi-platform-build)
- [VS Code 构建系统](https://github.com/microsoft/vscode/wiki/Source-Code-Organization)
