# 打包事故深度复盘：v0.3.4 ~ v0.3.11 DMG Runtime 启动失败

> 日期：2026-05-31
> 影响版本：**v0.3.4 ~ v0.3.9**（v0.3.4 起就无法从 DMG 正常启动）
> 修复版本：v0.3.11 (PR #63)
> 真正能用的最后版本：v0.3.3

**这次复盘最关键的发现是：DMG 无法启动不是 v0.3.8 才出现的，而是从 v0.3.4 引入 plugin service 时就已经存在。v0.3.4 ~ v0.3.7 的 DMG 全部无法启动，只是 plugin 初始化失败被 try-catch 吞掉了，用户没有感知到。**

---

## 事故时间线（修正版）

| 版本 | PR/Commit | DMG Runtime | Plugin System | 用户感知 |
|------|-----------|-------------|---------------|----------|
| v0.3.3 | — | ✅ 正常 | 不存在 | ✅ 正常 |
| v0.3.4 | #59 (plugin-arch-6) | ⚠️ 勉强运行 | ❌ 顶层 require("semver") 崩溃 | ❌ "连接断开" |
| v0.3.5 | statusline merge | ⚠️ 勉强运行 | ❌ 同上 | ❌ 同上 |
| v0.3.6 | minor fixes | ⚠️ 勉强运行 | ❌ 同上 | ❌ 同上 |
| v0.3.7 | TS fixes | ⚠️ 勉强运行 | ❌ 同上 | ❌ 同上 |
| v0.3.8 | #61 (fix-release-ci) | ❌ 完全无法启动 | ❌ files + __dirname | ❌ 完全无法启动 |
| v0.3.9 | #62 (fix-release-ci) | ❌ 完全无法启动 | ❌ files + __dirname 未修 | ❌ 完全无法启动 |
| v0.3.11 | #63 (fix/dmg-v2) | ✅ 正常 | ✅ 正常 | ✅ 正常 |

---

## 根因 1：electron-builder.yml files 排除了 dist/runtime

### v0.3.7（正常）

```yaml
files:
  - dist/**/*           # ← 通配符，包含 dist/runtime/
  - node_modules/**/*   # ← 通配符，包含所有依赖
```

electron-builder 先用 `files` 收集文件到 asar，再用 `asarUnpack` 把 `dist/runtime/` 从 asar 中提取出来。两个通配符覆盖面广，不会遗漏。

### PR #61（v0.3.8）的改动

```yaml
files:
  - dist/main/**/*      # ← 精确指定
  - dist/preload/**/*   # ← 精确指定
  # dist/runtime 缺失！
  - "!dist/runtime/**/*"  # ← 显式排除
```

改动意图：减小包体积（runtime 已经被 tsup 打包，不需要 asar 里再放一份）。

**致命错误**：`asarUnpack` 只作用于**已被 `files` 包含的文件**。排除后，asarUnpack 无文件可提取，`app.asar.unpacked/` 目录为空。Runtime 进程找不到 `index.cjs`。

### PR #62（v0.3.9）的修复

删除了 `!dist/runtime/**/*`，但**没有添加 `dist/runtime/**/*`**。

结果：files 中没有显式包含 dist/runtime，asarUnpack 仍然无文件可解压。`app.asar.unpacked/` 仍然为空。

### PR #63（v0.3.11）的修复

```yaml
files:
  - dist/main/**/*
  - dist/preload/**/*
  - dist/runtime/**/*   # ← 显式包含
```

### 为什么 3 个 PR 才修好？

**PR #62 犯了一个逻辑错误**：以为"不排除 = 包含"。但 electron-builder 的 `files` 默认不包含任何东西，只有匹配到的才进 asar。删除排除规则不等于添加包含规则。

---

## 根因 2：plugin-host.ts 的 CJS __dirname 兼容方案错误

### v0.3.7（正常）

```typescript
const bootstrapPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'plugin-bootstrap.js',
)
```

直接用 `import.meta.url`。在 v0.3.7 的 tsup 配置（`target: 'node22'`, 无 `platform`）下，tsup 保留了 `import.meta` 的引用，CJS 运行时也能正确解析。

### PR #61（v0.3.8）的改动

```typescript
function resolvePluginHostDir(): string {
  const dir = (globalThis as Record<string, unknown>).__dirname
  if (typeof dir === 'string' && dir) {
    return dir
  }
  // fallback to import.meta.url
}
```

改动意图：解决 tsc 对 `__dirname` 的类型检查冲突（不用 @ts-expect-error）。

**致命错误**：CJS 中 `__dirname` 是**模块作用域变量**，不存在于 `globalThis` 上。`globalThis.__dirname` 永远是 `undefined`。

更糟的是，PR #61 同时改了 tsup 配置：
```typescript
// 旧
target: 'node22', external: ['node:child_process', ...]
// 新
platform: 'node', target: 'node20', external: []
```

`platform: 'node'` 导致 tsup 将 `import.meta` 替换为 `var import_meta = {}`。所以 fallback 到 `import.meta.url` 也不行——`import_meta.url` 永远是 `undefined`。

**两条路都断了。** `resolvePluginHostDir()` 只能 throw。

### PR #62（v0.3.9）的修复

仍然是 `globalThis.__dirname` + `import.meta.url` fallback，没有修复核心问题。

### PR #63（v0.3.11）的修复

```typescript
function resolvePluginHostDir(): string {
  const cjsDir = typeof __dirname !== 'undefined' ? __dirname : undefined
  if (cjsDir && cjsDir !== '.') {
    return cjsDir
  }
  // import.meta.url fallback...
}
```

直接引用 `__dirname`（不用 `globalThis`），esbuild/tsup 在 CJS 输出中**原样保留**这个引用。Node.js CJS 运行时会正确注入模块作用域的 `__dirname`。

### 为什么 3 个 PR 才修好？

**对 CJS 模块变量作用域的理解有误**。`__dirname` 在 CJS 中不是全局变量，是类似函数参数的模块局部变量。用 `globalThis` 访问永远拿不到。同时没有意识到 `platform: 'node'` 会破坏 `import.meta`。

---

## 为什么每次都没有被拦截？

### 没有 E2E 打包验证

所有 PR 都做了以下检查：
- `npm run build` ✅ （Vite + tsup + electron-builder 都不报错）
- `npm run lint` ✅
- `npm run test`（v0.3.11 才通过，之前 plugin-host 相关测试失败）
- `preflight-check.sh` ✅

但**没有一个检查实际打开 DMG 验证 runtime 启动**。

electron-builder 的 `files` + `asarUnpack` 不一致是**静默失败**：
- 打包不报错
- 产物 `app.asar` 生成成功
- `app.asar.unpacked/` 只是空的
- 只有用 DMG 里的 Electron 二进制实际运行 bundle 才能发现

### preflight-check 的盲区

v0.3.9 添加的 preflight-check 只检查了：
1. ❌ `files` 没有排除 `dist/runtime` → 只验证了 `!dist/runtime` 不存在
2. ✅ `asarUnpack` 包含 `dist/runtime`

但**没有检查 `files` 显式包含了 `dist/runtime`**。这是 v0.3.9 漏掉的第三个检查点。

### 测试覆盖的盲区

`plugin-host.ts` 的测试用 `plugin-bootstrap.mock.cjs` 在测试 setup 中创建 `plugin-bootstrap.js`。但测试环境是 ESM（tsx 直跑），不是 CJS bundle。`globalThis.__dirname` 在 tsx 中恰好有值（tsx 注入了），所以测试通过了。但 CJS bundle 中没有。

---

## 后续防护措施

### 已实施

1. **preflight-check.sh 增加 files 显式包含检查**（PR #63）
   - 检查 `files` 中存在 `dist/runtime/` 通配规则
   - 三个维度：排除检查 + 包含检查 + asarUnpack 存在检查

2. **CLAUDE.md 更新 CJS __dirname 规则**（PR #63）
   - 明确禁止 `globalThis.__dirname`
   - 明确禁止 `import.meta.url`（tsup CJS 输出中为 undefined）
   - 给出正确模式：`typeof __dirname !== 'undefined' ? __dirname : undefined`

### 建议实施

3. **postbuild-validate 增加 asar.unpacked 验证**
   - 构建完成后检查 `dist/builder-output/*/xyz-agent.app/Contents/Resources/app.asar.unpacked/dist/runtime/index.cjs` 存在
   - 这是唯一能真正拦截 `files` 配置错误的检查点

4. **CI 增加 smoke test**
   - 打包完成后，用 DMG/ZIP 中的 Electron 二进制执行 `ELECTRON_RUN_AS_NODE=1 <electron> <runtime/index.cjs> --port=<random>`
   - 验证输出包含 `listening on port`
   - 这能同时拦截 files 缺失、__dirname 错误、CJS 兼容性等问题

5. **runtime 测试增加 CJS bundle 模式**
   - vitest 测试用 tsx（ESM）运行，不代表 CJS bundle 行为一致
   - 增加 `npm run build && node dist/runtime/index.cjs --port=<random>` 的 smoke test
   - 可以作为 `validate-runtime-bundle.sh` 的一个阶段

6. **electron-builder.yml 变更触发全量验证**
   - pre-commit hook 中已有检测，但只跑 preflight-check
   - 应该额外跑 `postbuild-validate.sh`（检查实际产物）

---

## 教训总结

1. **electron-builder 的 `files` 和 `asarUnpack` 是 AND 关系，不是 OR**。只配置 asarUnpack 不够，files 必须先包含目标文件。这个行为在文档中不醒目，且静默失败。

2. **"不排除 ≠ 包含"**。在一个精确白名单系统中，删除排除规则不等于添加包含规则。这是 PR #62 的核心逻辑错误。

3. **CJS 模块变量不在 globalThis 上**。`__dirname`、`__filename`、`require`、`module`、`exports` 都是 Node.js CJS 包装函数的参数，不是全局变量。用 `globalThis` 访问永远拿到 `undefined`。

4. **测试环境和生产环境的差异是最大的盲区**。tsx（ESM）中 `globalThis.__dirname` 有值（tsx 注入），CJS bundle 中没有。`import.meta.url` 在 tsx 中有值，在 tsup CJS 输出中被替换为空对象。这种差异无法通过单元测试发现。

5. **静默失败比报错更危险**。electron-builder 不报错、tsup 不报错、`app.asar.unpacked/` 只是空的。唯一能发现的方式是实际运行打包产物。

---

## 深度分析：系统性问题

### 一、"贪多嚼不烂"—— PR #61 是一次危险的巨型重构

PR #61（8b43045）是一个**单体巨型 commit**，同时改了 6 个互相关联的子系统：

| 文件 | 改动 | 影响 |
|------|------|------|
| tsup.config.ts | platform: 'node', target node22→node20, noExternal 增加 2 个, external 清空 | **改变 CJS 输出行为** |
| electron-builder.yml | files 从通配改成精确白名单 + 排除 dist/runtime | **改变打包范围** |
| plugin-host.ts | import.meta.url → __dirname 兼容层 | **改变路径解析** |
| plugin-version-checker.ts | createRequire → fs 向上查找 | **改变版本获取** |
| 新建 3 个验证脚本 | preflight + postbuild + validate | 新增 |
| CLAUDE.md + 研究文档 | 新增规则 | 新增 |

这 6 个改动每一个都独立影响生产环境的启动链路。任何一个出错都会导致 runtime 无法运行。但它们被打包在**一个 commit** 中，没有任何中间验证点。

**问题**：当 v0.3.8 的 DMG 打不开时，根本无法判断是哪个改动导致的问题。观察到的症状（"连接断开"）对两个根因都是同一个表现，必须逐个排查。

**教训**：涉及打包链路的改动必须**逐个拆分、逐个验证**。每个改动独立提交，用 `npm run build` + 解压验证确认无害后再做下一个。

### 一.五、被遮蔽的真相：v0.3.4 ~ v0.3.7 也无法正常启动

**这是本次复盘最重要的发现。**

v0.3.4（PR #59, feat-plugin-arch-6）在 runtime 的 `package.json` 中添加了 `semver` 和 `fast-glob` 依赖，但**没有更新 tsup 的 `noExternal`**。

```typescript
// v0.3.4 的 tsup.config.ts
noExternal: ['ws']  // 只有 ws！
// 但 dependencies = { ws, semver, fast-glob }
```

这意味着 CJS bundle 中 `require("semver")` 是运行时解析。而在 DMG 中，runtime 在 `app.asar.unpacked/` 目录下，Node.js 的 `require` 搜索不到 asar 内部的 `node_modules/`。**顶层 `require("semver")` 直接导致整个 `index.cjs` 加载失败。**

RuntimeManager 的流程是：
1. spawn 子进程（`ELECTRON_RUN_AS_NODE=1`）
2. 进程立即因 `require("semver")` 崩溃
3. healthCheck 重试 30 次 × 200ms = 6 秒后超时
4. `throw "Runtime health check timed out"`
5. main.ts 的 catch 捕获，发送 `runtime-error` 给渲染进程
6. 用户看到"连接断开"

**v0.3.4 ~ v0.3.7 的用户一直看到的是"连接断开"，只是当时没有引起重视。**

v0.3.8 的情况更严重（`app.asar.unpacked/` 为空），但表现形式一样——"连接断开"。这解释了为什么 v0.3.8 被归咎为"回归"：实际上从 v0.3.4 开始就有问题。

**为什么这个问题持续了 4 个版本（v0.3.4 ~ v0.3.7）没被发现？**

1. 开发者可能只在 dev 模式下测试（tsx 直跑，依赖在 node_modules 中），不测 DMG
2. plugin 初始化在 try-catch 中，失败不会 crash 整个 app
3. 没有 CI 的 DMG smoke test
4. "连接断开"被当作网络问题或环境问题，而不是打包问题

### 二、v0.3.7 的 import.meta.url 为什么能工作？

v0.3.7 的 tsup 配置是：

```typescript
// 没有 platform，没有 target node20
format: ['cjs'], target: 'node22', bundle: true
noExternal: ['ws']
external: ['node:child_process', ...]
```

这个配置下，tsup（底层 esbuild）对 `import.meta` 的处理方式是**保留为 CJS 等价物**。esbuild 会注入一个 `__dirname`/`__filename` shim，使得 `import.meta.url` 在 CJS 运行时能够正确解析为 `file://` URL。

而 PR #61 改成了 `platform: 'node'`。这个选项告诉 esbuild "目标环境是 Node.js，你不需要提供 polyfill"。esbuild 因此**不再注入 import.meta shim**，而是直接替换为 `var import_meta = {}`。

**教训**：tsup/esbuild 的 `platform` 选项不是无害的。从无 platform 切换到 `platform: 'node'` 会改变 `import.meta` 的处理行为，影响所有使用 `import.meta.url` 的代码。这应该是破坏性变更，需要全量验证。

### 三、tsc vs ESLint 冲突导致 "creative workaround" 引入 bug

commit 16e12d9 的 commit message 说明了为什么引入 `globalThis.__dirname`：

> Both tsc and ESLint have conflicting rules:
> - tsc: @ts-expect-error is unused (__dirname has type 'string')
> - ESLint: @ts-ignore is banned, must use @ts-expect-error

这是一个 **工具链配置冲突**。tsc 认为 `__dirname` 总是 `string`（因为 Node.js 类型声明），所以 `@ts-expect-error` 被标记为未使用。ESLint 规则又禁止用 `@ts-ignore`。

为了绕过这个冲突，AI 选择了 `globalThis.__dirname`——一个在 TypeScript 类型系统中合法（`Record<string, unknown>`），在 ESLint 中不触发规则，但在运行时**永远返回 undefined** 的方案。

**这是一个典型的"工具链规避"反模式**：为了满足 linter/compiler 的形式要求，写了运行时不正确的代码。

**正确解法**（至少有两种）：
1. 在 eslint 中对该行禁用 `@typescript-eslint/prefer-ts-expect-error` 规则：`// eslint-disable-next-line @typescript-eslint/prefer-ts-expect-error`
2. 用 `declare const __dirname: string | undefined` 代替直接引用

**教训**：当两个工具的规则冲突时，**禁用其中一个的规则**是正确做法。写 "creative workaround" 来规避形式检查，代价是引入运行时 bug。这种 workaround 比直接的 `// eslint-disable` 更危险，因为它看起来像是合法代码。

### 四、PR #62 的 "诊断停止过早" 问题

PR #62 的 commit message 列出了 4 个根因：
1. files 排除了 dist/runtime ✅ 找到了
2. plugin-bootstrap.ts 没被 tsup 打包 ✅ 找到了
3. resources/pi 的 symlink ✅ 找到了
4. plugin-version-checker 用 process.cwd() ✅ 找到了

但 **两个致命 bug 都没修到**：
- files 删除了排除规则但没有添加包含规则
- `globalThis.__dirname` 没有被修复

为什么？**AI 满足于找到了"足够多"的问题就停了**。找到了 4 个问题，修复了它们，写了一个详细的 commit message，觉得已经够了。没有做端到端验证。

更深层的问题是：**AI 在猜测而不是验证**。它猜测删除 `!dist/runtime` 就够了，不需要添加 `dist/runtime/**/*`。它猜测 `globalThis.__dirname` 没问题（因为上一个 PR 就是这样写的）。它没有实际构建 DMG、解压、运行来验证猜测。

**教训**：打包问题的验证方式只有一个——**实际构建并检查产物**。`npm run build` 成功不代表产物正确。electron-builder 的静默失败特性决定了只有检查 `app.asar.unpacked/` 目录才能确认配置正确。

### 五、每次修的都是不同层面的问题

| PR | 修了什么 | 没修什么 |
|------|---------|----------|
| #61 | noExternal 缺依赖、import.meta→__dirname、files 精确化 | 引入了 files 缺失和 globalThis 错误 |
| #62 | 删除 !dist/runtime 排除、添加 plugin-bootstrap entry、symlink、版本注入 | files 缺少包含、globalThis 未修 |
| #63 | files 显式包含、typeof __dirname 正确用法 | — |

每个 PR 都在修**上一次引入的问题**，但每次修复都在引入或保留新的问题。没有一个 PR 做到了"对比能用的版本，理解完整差异，验证所有改动点"。

### 六、CLAUDE.md 规则的效力问题

PR #61 写了详细的 CLAUDE.md 规则 #12（Electron 打包约束），包括 files/asarUnpack 交互、3 阶段验证等。PR #62 进一步扩展了规则。

但这些规则**没有阻止后续犯错**。原因：
1. 规则是**被动参考**——只有 AI 想起来去读才会生效
2. 规则写的是"不要做什么"，但 AI 在修复过程中不会回头检查每条规则
3. 规则的覆盖面有限——没有覆盖 `globalThis.__dirname` 的陷阱（PR #63 才补充）

**教训**：CLAUDE.md 规则适用于"日常开发中避免新问题"。但对于"正在修复一个已知 bug"的场景，AI 不会停下来重读 CLAUDE.md。需要的是**自动化检查**（hooks、CI），不是文档。

---

## 行动项汇总

### 已完成

| # | 行动 | PR | 效果 |
|---|------|-----|------|
| 1 | files 显式包含 dist/runtime | #63 | 防止 asarUnpack 静默失败 |
| 2 | typeof __dirname 替代 globalThis | #63 | 修复 CJS 路径解析 |
| 3 | preflight-check 增加 files 包含检查 | #63 | 打包前拦截 |
| 4 | CLAUDE.md CJS __dirname 规则 | #63 | 防止再犯 |
| 5 | CI release workflow 加入 postbuild-validate | #64 | CI 自动拦截 |
| 6 | 版本号 UI 显示 | #63 | 方便用户反馈 |

### 待实施

| # | 行动 | 优先级 | 说明 |
|---|------|--------|------|
| 7 | CI smoke test（ELECTRON_RUN_AS_NODE 运行 bundle） | **P0** | 唯一能拦截所有打包链路错误的检查 |
| 8 | validate-runtime-bundle 增加 CJS bundle smoke test | P1 | 本地 pre-commit 阶段拦截 |
| 9 | electron-builder.yml 变更触发 postbuild-validate | P1 | pre-commit hook 扩展 |
| 10 | 解决 tsc @ts-expect-error vs ESLint @ts-ignore 冲突 | P2 | 根治 "creative workaround" 诱因 |
| 11 | 打包相关 PR 的强制拆分规范 | P2 | CLAUDE.md 增加规则：tsup/config/yml 改动必须逐个 commit |

---

## 根方法论反思

### 为什么连续失败？

**根本原因不是某个具体知识点的缺失，而是从 v0.3.4 起就没有过端到端验证流程：**

1. **问题的真正起点是 v0.3.4，不是 v0.3.8**：plugin service 引入时添加了 semver/fast-glob 依赖，但没有更新 tsup noExternal。从 v0.3.4 到 v0.3.7，DMG 的 runtime 都无法正常启动。PR #61 尝试修复这个问题，但在修复过程中引入了两个新 bug。

2. **"修 bug"的起点就是错的**：AI 以为基线是 v0.3.7（能用），实际上 v0.3.7 也不能用。基于错误的基线做 diff，得出的结论必然有偏差。

3. **没有端到端验证**：3 个 PR 没有一个实际构建 DMG 并验证 runtime 启动。每个 PR 都认为自己的修复是充分的，因为 lint/test/build 都通过了。

4. **"猜测驱动"而非"验证驱动"**：PR #62 猜测删除排除规则就够了，没有验证。PR #62 猜测 globalThis.__dirname 没问题，没有验证。如果任何一个猜测被验证了，就能发现 bug。

5. **修复引入问题而非根因**：每次修复都是"修上一次引入的表面症状"，而不是"回到能用的版本，理解每个改动的实际效果"。

### 正确的修复流程应该是什么？

1. **建立正确基线**：先确认哪个版本真的能用（v0.3.3，不是 v0.3.7）。`git diff v0.3.3..v0.3.8 --stat` 找到所有改动文件
2. **构建验证**：`npm run build` + 解压 DMG + 检查 `app.asar.unpacked/`
3. **运行验证**：`ELECTRON_RUN_AS_NODE=1 <electron> <index.cjs> --port=<random>` 确认 runtime 启动
4. **二分排查**：如果以上失败，逐个回退改动直到找到引入问题的 commit
5. **逐个修复**：每个根因独立修复、独立验证、独立提交
