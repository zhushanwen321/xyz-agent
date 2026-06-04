---
verdict: pass
must_fix: 0
review_metrics:
  files_reviewed: 2
  must_fix_from_v1: 2
  must_fix_resolved: 2
  new_issues: 0
  duration_estimate: "20"
---

# Dev Business Logic Review v2 — v1 MUST_FIX 回归验证

## 审查记录
- 审查时间：2026-06-02
- 审查模式：Dev（L1 + L2 回归）
- 审查对象：`extension-resolver.ts` + `extension-resolver.test.ts`
- 目的：验证 v1 的 2 条 MUST_FIX 已修复

## v1 MUST_FIX 验证

### MUST_FIX #1：scanNpmExtensions 的 piExtension guard 移除

**v1 问题**：`scanNpmExtensions()` 检查 `pkg.piExtension` 字段，所有真实 `@zhushanwen/pi-*` 包均无此字段，导致 npm 源返回空 Map。

**v2 验证**：

`extension-resolver.ts` L62-95 `scanNpmExtensions()`：

1. 遍历 `@zhushanwen` scope 下 `pi-` 前缀的目录 → `entry.startsWith('pi-')` (L69)
2. 验证是目录 → `statSync(pkgDir).isDirectory()` (L72-74)
3. 读取 `package.json` 仅用于提取短名 → `replace(/^@[^/]+\//, '')` (L82-83)
4. **无任何字段过滤**（`piExtension`、`keywords` 等均未检查）

**判定：✅ 已修复。** 条件链从 "scope + prefix + piExtension field" 简化为 "scope + prefix + isDirectory"，充分且必要。

测试覆盖：
- `includes all pi-* packages regardless of package.json fields` — 显式验证无字段过滤
- `discovers pi-* packages and uses short name as key` — 验证 pi-code-review、pi-something 均被发现，not-pi-pkg 被排除
- `returns empty when node_modules/@zhushanwen does not exist` — 空路径边界

---

### MUST_FIX #2：去重 key 语义统一

**v1 问题**：npm 用全限定名 `@zhushanwen/pi-goal`，bundled/third-party 用目录名 `pi-goal`，导致去重失败。

**v2 验证**：

| 来源 | key 生成逻辑 | 示例 |
|------|-------------|------|
| npm | `(pkg.name ?? entry).replace(/^@[^/]+\//, '')` | `@zhushanwen/pi-goal` → `pi-goal` |
| npm（无 package.json） | `entry`（即 `pi-goal`） | `pi-goal` |
| bundled | `scanDirectory` → 目录 entry 名 | `pi-goal` |
| third-party | `scanDirectory` → 目录 entry 名 | `pi-goal` |
| user | 路径最后一段 | `pi-goal` |

四源 key 语义统一为**短名**（去掉 scope 前缀），`@zhushanwen/pi-goal` 和目录 `pi-goal` 映射到同一个 key `pi-goal`，deduplicate 的 first-write-wins 正确生效。

**判定：✅ 已修复。**

测试覆盖：
- `discovers pi-* packages and uses short name as key` — 验证 `result.get('pi-code-review')` 而非 `result.get('@zhushanwen/pi-code-review')`
- `npm overrides bundled for same name` — npm 的 `review` 覆盖 bundled 的 `review`，验证 key 碰撞时高优先级胜出
- `integrates all sources and deduplicates` — 端到端验证四源合并

---

## UC 业务路径回归

### UC-1：用户升级 Extension 版本

**执行路径**：
```
npm update @zhushanwen/pi-goal
  → scanNpmExtensions: pi-goal 目录 → isDirectory ✅ → 短名 "pi-goal" → Map.set("pi-goal", path) ✅
  → deduplicate: npm 优先级最高 → pi-goal 保留 npm 版本 ✅
  → pi 启动加载 npm 版本 ✅
```

**判定：✅ 主路径通畅。**

### UC-2：用户安装第三方 Extension（去重场景）

**执行路径**：
```
npm 有 @zhushanwen/pi-goal，third-party 有 pi-goal
  → npm key: "pi-goal"（短名提取后）
  → third-party key: "pi-goal"（目录名）
  → deduplicate: npm(优先级 0) 先写入 → third-party(优先级 2) key 已存在跳过
  → 只加载 npm 版本 ✅
```

**判定：✅ 去重正确。**

### UC-3：开发者修复 Extension Bug 并验证

**执行路径**：
```
npm install @zhushanwen/pi-goal@0.2.1-beta.0
  → 同 UC-1，scanNpmExtensions 发现 pi-goal → 加载 ✅
  → 开发者可通过 pi 交互验证 tool 注册 ✅
```

**判定：✅ 与 UC-1 同路径，通畅。**

### UC-5：打包产物验证

**执行路径**：
```
packaged=true:
  → scanBundledExtensions: return empty（正确，bundled 由 migrateToPiSubdir 同步到 third-party）
  → scanNpmExtensions(Resources/): extraResources 复制了 node_modules/@zhushanwen → 扫描 pi-* 包 ✅
  → scanThirdPartyExtensions: bundled extension 已同步到此目录 ✅
  → 所有 extension 可被发现 ✅
```

**判定：✅ 打包路径通畅。**

### 新增 UC：文件型 extension 不被过滤

**场景**：npm 包中 `@zhushanwen/pi-review` 的 `package.json` 不包含任何特殊字段（无 `piExtension`、无 `keywords`），仅靠 scope + prefix 识别。

**执行路径**：
```
scanNpmExtensions:
  → entry = "pi-review" → startsWith("pi-") ✅
  → isDirectory ✅
  → readFileSync(package.json) → { name: "@zhushanwen/pi-review" }（无特殊字段）
  → 无字段过滤逻辑 → 直接 Map.set("pi-review", path) ✅
```

**判定：✅ 无字段过滤，仅靠 scope + prefix + isDirectory 三个结构性条件。**

测试覆盖：`includes all pi-* packages regardless of package.json fields` 显式验证。

---

## AC 回归验证

| AC | 描述 | v1 状态 | v2 状态 | 说明 |
|----|------|---------|---------|------|
| AC-1 | Extension 加载无回归 | ❌ | ✅ | piExtension guard 已移除 |
| AC-2 | 去重无冲突 | ❌ | ✅ | key 统一为短名 |
| AC-3 | 第三方 extension 依赖解析 | ✅ | ✅ | 未改动 |
| AC-6 | 打包产物包含 npm extension | ⚠️ | ✅ | guard 移除后运行时扫描正常 |
| AC-7 | bundled 副本已删除 | ✅ | ✅ | 未改动 |
| AC-8 | 现有 subagent/usage-tracker/hooks 不受影响 | ✅ | ✅ | 未改动 |

## 结论

**verdict: pass。** v1 的 2 条 MUST_FIX 均已正确修复，无新增问题。代码逻辑简洁（scope + prefix + isDirectory 三条件），测试用例覆盖了关键业务路径和边界条件。
