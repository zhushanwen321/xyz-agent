---
verdict: pass
must_fix: 0
review_metrics:
  files_reviewed: 3
  boundaries_checked: 4
  issues_found: 1
  must_fix_count: 0
  low_count: 1
  info_count: 0
  upstream_v1_must_fix: 1
  upstream_v1_fixed: 1
---

# Integration Review v2

## 审查记录
- 审查时间：2026-06-02
- 上游：integration_review_v1.md（verdict: fail, must_fix: 1）
- 审查范围：验证 v1 MUST_FIX #1 的修复正确性

## v1 MUST_FIX #1 修复验证

**原始问题：** `ExtensionResolver.scanUserExtensions()` 的 `isDirectory()` 检查导致文件型 extension（`xyz-agent-extension.js`）被静默丢弃。

**修复方案：** 在 `session-service.getExtensionPaths()` 中提前检测文件类型，绕过 resolver 直接追加到结果列表。

### 修复代码路径分析

**文件：** `session-service.ts` L568-L586

```
getExtensionPaths():
  resolver = new ExtensionResolver()
  isPackaged = process.env.XYZ_AGENT_PACKAGED === '1'
  userExtPaths = []

  if (this.extensionPath && existsSync(this.extensionPath)):
    try:
      if (statSync(this.extensionPath).isFile()):        ← 文件型检测
        result = resolver.resolve(projectRoot, isPackaged, [])  ← resolver 不含文件路径
        result.extensionDirs.push(this.extensionPath)     ← 直接追加
        return result.extensionDirs                       ← 提前返回 ✅
    catch:
      // statSync 失败，继续走 resolver
    userExtPaths.push(this.extensionPath)                 ← 非文件（目录/symlink）走 resolver
  result = resolver.resolve(projectRoot, isPackaged, userExtPaths)
  return result.extensionDirs
```

### 模拟数据推演

#### 场景 A：文件型 extension（xyz-agent-extension.js）

```
this.extensionPath = "/app/xyz-agent-extension.js" (文件存在)
existsSync → true
statSync(...).isFile() → true
  resolver.resolve(projectRoot, isPackaged, [])
    → 四源扫描（bundled/third-party/npm）, userExtPaths=[]
    → extensionDirs = ["/app/node_modules/@zhushanwen/pi-goal", ...]
  result.extensionDirs.push("/app/xyz-agent-extension.js")
  return ["/app/node_modules/@zhushanwen/pi-goal", ..., "/app/xyz-agent-extension.js"]
  → rpc-client: --extension ... --extension /app/xyz-agent-extension.js ✅
```

**结论：** 文件型 extension 正确追加到结果末尾，不会被 `isDirectory()` 过滤。

#### 场景 B：目录型 extension（不存在此场景，但验证防御性）

```
this.extensionPath = "/some/dir-extension/" (目录)
existsSync → true
statSync(...).isFile() → false
  userExtPaths.push("/some/dir-extension/")
resolver.resolve(projectRoot, isPackaged, ["/some/dir-extension/"])
  scanUserExtensions(["/some/dir-extension/"])
    statSync("/some/dir-extension/").isDirectory() → true
    result.set("dir-extension", "/some/dir-extension/") ✅
```

**结论：** 目录型 extension 仍走 resolver 路径，去重逻辑正常工作。

#### 场景 C：打包模式 + 文件不存在

```
this.extensionPath = "/app/Resources/xyz-agent-extension.js"
existsSync → false
  跳过整个 if 块
resolver.resolve(projectRoot, true, [])
  → 仅 npm 源扫描（bundled 打包模式返回空, third-party 正常）
return extensionDirs  ← 不含 xyz-agent-extension.js
```

**结论：** 文件不存在时安全跳过，不会注入无效路径。但打包模式下 `xyz-agent-extension.js` 需要确保存在于 Resources 目录中（由 extraResources 或 prebuild 脚本保证）。

#### 场景 D：statSync 异常（权限/损坏）

```
this.extensionPath = "/app/xyz-agent-extension.js"
existsSync → true
statSync → throw EACCES/EINVAL
  catch → 继续
userExtPaths.push("/app/xyz-agent-extension.js")
resolver.resolve(projectRoot, isPackaged, ["/app/xyz-agent-extension.js"])
  scanUserExtensions(["/app/xyz-agent-extension.js"])
    existsSync → true
    statSync → throw → catch → continue (SKIP!)
```

**结论：** 如果 `statSync` 在文件检测分支和 resolver 的 `scanUserExtensions` 中都失败，extension 会被静默丢弃。这是一个极端边界场景（权限问题），实际发生概率极低，且行为一致（两处都失败）。NOT MUST_FIX。

## 四维度审查

### D1 数据格式转换

| 优先级 | 文件 | 行号 | 描述 | 修复方向 |
|--------|------|------|------|---------|
| LOW | extension-resolver.ts | L152-158 | `scanUserExtensions()` 仍只接受 `isDirectory()`，文件路径在此处被 continue 跳过。当前依赖调用方（session-service）提前拦截绕过，但若未来其他调用方直接使用 resolver 传入文件路径，会再次遇到 v1 问题 | 考虑在 `scanUserExtensions` 中增加 `isFile()` 分支，使 resolver 本身对文件/目录都兼容 |

### D2 错误传播

无问题。`statSync` 异常被 catch 后优雅降级到 resolver 路径，不会导致 session 创建失败。

### D3 接口契约一致性

无问题。`getExtensionPaths()` 返回类型仍为 `string[]`，与 `IProcessManager.createSession` 的 `extensionPaths?: string[]` 契约一致。rpc-client 将每个路径作为 `--extension` 参数传递给 pi。

### D4 前后端上下游

无变更。本次修复仅影响 runtime 内部 extension 路径组装逻辑，不涉及前端协议变更。

## 回归风险矩阵

| 场景 | 旧代码 | 修复后代码 | 回归风险 |
|------|--------|-----------|---------|
| 文件型 extension 存在 | 直接 push，✅ 通过 | statSync.isFile → push，✅ 通过 | 无 |
| 目录型 extension（user enabled） | readdirSync 扫描子目录 | scanUserExtensions isDirectory 检查 | 无（行为一致） |
| npm extension 去重 | 按 entry 名去重 | 按 shortName 去重 | 无（v1 已验证） |
| 打包模式 + 文件不存在 | warn log + 跳过 | 静默跳过（无 warn） | 极低（不影响功能） |
| 空 extensions | 返回空数组 | 返回空数组 | 无 |

## 结论

**verdict: pass**

v1 MUST_FIX #1（文件型 extension 被 `isDirectory()` 过滤）已正确修复。修复方案在 `session-service.getExtensionPaths()` 中对文件型 extension 提前检测并直接追加，绕过 resolver 的 `scanUserExtensions` 过滤逻辑。

数据流验证通过：
- 文件型 extension（`xyz-agent-extension.js`）→ `statSync.isFile()` 检测 → 直接 push → `--extension` 传递给 pi ✅
- 目录型 extension → 走 resolver → `isDirectory()` 通过 → 去重 → `--extension` 传递 ✅
- 返回类型 `string[]` 与下游 `RpcClientOptions.extensionPaths` 契约一致 ✅

1 条 LOW 级建议：`scanUserExtensions` 本身应兼容文件路径，避免未来调用方重复踩坑。
