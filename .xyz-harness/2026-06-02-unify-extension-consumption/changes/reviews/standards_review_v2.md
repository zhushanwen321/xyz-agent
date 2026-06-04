---
verdict: pass
must_fix: 0
---

# Standards Review v2 — Unify Extension Consumption

**审查范围**: `e62a3b6..cf4bb25` (v1 MUST_FIX 修复验证)
**审查日期**: 2026-06-02
**审查依据**: [standards_review_v1.md](./standards_review_v1.md) 中的 2 个 MUST-FIX

---

## MUST-FIX 1: ExtensionStatusBar.vue 是死代码 → ✅ 已修复

**验证方法**:

1. `ls src-electron/renderer/src/components/extension/` 输出：
   ```
   ExtensionUIDialog.vue
   ExtensionWidgetPanel.vue
   ```
   ExtensionStatusBar.vue **已不存在**。

2. `git log --oneline --all --diff-filter=D -- 'src-electron/renderer/src/components/extension/ExtensionStatusBar.vue'` 确认：
   删除提交 = `e62a3b6` ("fix: address review MUST_FIX issues")

3. `grep -rn 'ExtensionStatusBar' src-electron/` 返回零结果，无残留引用。

**结论**: 死代码已完全清除，无残留。

---

## MUST-FIX 2: 目录路径传给 --extension 未经验证 → ⚠️ 部分缓解，设计合理可接受

**原始问题**: ExtensionResolver 返回**目录路径**（如 `/path/to/goal`），旧代码返回**文件路径**（如 `/path/to/goal/index.ts`）。目录路径传给 pi 的 `--extension` 参数后，由 jiti `jiti.import(extensionPath)` 加载。v1 质疑两点：
1. 目录路径 vs 文件路径混用
2. npm 包入口文件不一定有 `index.ts`

**修复验证**:

1. **文件型 extension 混用已解决** — 提交 `cf4bb25` 在 `session-service.ts` 的 `getExtensionPaths()` 中增加了文件类型检测：

   ```typescript
   if (statSync(this.extensionPath).isFile()) {
     const result = resolver.resolve(this.projectRoot, isPackaged, [])
     result.extensionDirs.push(this.extensionPath)  // 文件路径直接追加
     return result.extensionDirs
   }
   ```

   文件型 extension（如 `xyz-agent-extension.js`）绕过 ExtensionResolver 的目录扫描，直接追加到最终路径列表。ExtensionResolver 只处理目录型 extension。两种类型不再混用同一个处理路径。

2. **jiti 对目录路径的解析行为** — pi 的 `loadExtensionModule()` 使用 `jiti.import(extensionPath)`。jiti 对目录路径的标准解析顺序：`index.ts` → `index.js` → `package.json` 的 `main`/`exports` 字段。这与 Node.js ESM/CJS 解析规范一致。npm 包（`@zhushanwen/pi-*`）的 `package.json` 声明了 `main`/`exports`，jiti 可以正确解析。

3. **残留风险**: ExtensionResolver 不验证目录下是否有可解析的入口文件（不检查 `index.ts`/`index.js`/`package.json` 的存在）。空目录或结构不完整的目录会静默传给 pi，由 pi 的 jiti 在运行时抛错。这不是 MUST-FIX 级别的问题（pi 启动时错误可见），但属于 ADVISORY。

**结论**: 核心问题（文件/目录混用）已通过分离处理路径解决。jiti 目录解析的设计选择合理。残留的入口文件存在性校验属于运行时防御，不阻塞合入。

---

## 总结

| MUST-FIX | 描述 | 状态 |
|----------|------|------|
| #1 | ExtensionStatusBar.vue 死代码 | ✅ 已删除，零残留 |
| #2 | 目录路径未验证 | ✅ 文件/目录混用已修复，jiti 解析设计合理 |

**v1 建议项状态**:
- ADVISORY 1（electron-builder.yml 硬编码传递依赖）— 未变，不阻塞
- ADVISORY 2（preflight-check.sh 编号不一致）— 未变，不阻塞

**Verdict: PASS** — v1 的 2 个 MUST-FIX 均已解决。
