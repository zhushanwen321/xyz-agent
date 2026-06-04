---
review:
  type: spec_review
  round: 3
  timestamp: "2026-06-03T10:30:00"
  target: ".xyz-harness/2026-06-02-extension-user-install-and-settings/spec.md"
  verdict: fail
  summary: "Spec 评审第3轮，3条 MUST FIX（disabledPackages 虚构、npm 目录 bootstrap 缺失、ExtensionResolver 双重调用风险），需修改后重审"

statistics:
  total_issues: 7
  must_fix: 3
  must_fix_resolved: 0
  low: 2
  info: 2

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md: D-1, FR-5"
    title: "disabledPackages[] 在 pi settings.json 中不存在，D-1 决策依据错误"
    status: open
    raised_in_round: 3
    resolved_in_round: null
  - id: 2
    severity: MUST_FIX
    location: "spec.md: FR-8"
    title: "npm/ 目录 bootstrap 未指定——npm install 需要前置 package.json 才能工作"
    status: open
    raised_in_round: 3
    resolved_in_round: null
  - id: 3
    severity: MUST_FIX
    location: "spec.md: FR-4, FR-5"
    title: "ExtensionResolver 双重调用风险——session-service 已独立调用 ExtensionResolver，新增 settings 源会导致同路径重复解析"
    status: open
    raised_in_round: 3
    resolved_in_round: null
  - id: 4
    severity: LOW
    location: "spec.md: FR-7"
    title: "ExtensionInfo.source 字段值与 ExtensionResolver 源名称不一致"
    status: open
    raised_in_round: 3
    resolved_in_round: null
  - id: 5
    severity: LOW
    location: "spec.md: FR-5"
    title: "IExtensionService 接口变更未同步到 interfaces.ts 和共享类型"
    status: open
    raised_in_round: 3
    resolved_in_round: null
  - id: 6
    severity: INFO
    location: "spec.md: FR-3, AC-5"
    title: "启用/禁用规则对 built-in 和 user-installed 的行为边界描述分散"
    status: open
    raised_in_round: 3
    resolved_in_round: null
  - id: 7
    severity: INFO
    location: "spec.md: FR-4"
    title: "settings 源在优先级数组中的位置与文字描述矛盾"
    status: open
    raised_in_round: 3
    resolved_in_round: null
---

# Spec 评审 v3

## 评审记录
- 评审时间：2026-06-03 10:30
- 评审类型：Spec 评审（计划评审第 1 项：spec 完整性）
- 评审对象：`.xyz-harness/2026-06-02-extension-user-install-and-settings/spec.md`
- 评审依据：`SKILL.md` 模式一第 1 项（spec 完整性）+ 项目 CLAUDE.md 架构约束

---

## 1. Spec 完整性逐项检查

### 1.1 目标是否明确

**通过。** 一段话可说清：让用户在 Settings 页面输入 npm 包名安装第三方 pi extension，支持卸载和启用/禁用，统一 ExtensionService 和 ExtensionResolver 的状态管理。

### 1.2 范围是否合理

**基本合理，但有扩展风险。** 涉及 ExtensionService 重写、ExtensionResolver 改造、WS 协议新增 2 个消息、共享类型变更、settings.json 读写。约 10 文件 / 600 行的估算偏乐观（ExtensionService 重写 + ExtensionResolver 改造 + npm 集成 + 前端 UI 变更，实际可能 800-1000 行）。不阻塞，但 plan 阶段需要重新评估工作量。

### 1.3 验收标准是否可量化

**部分通过。** AC-1 至 AC-6 均可写测试验证。AC-8（新会话生效）测试需要验证已有 session 不受影响 + 新 session 加载最新列表，可测试但需要多进程协调，plan 需注意测试策略。

### 1.4 [待决议] 项

无显式标记。但以下隐性待决议项未暴露（详见 MUST FIX #1、#2）。

---

## 2. 对照代码库的事实核查

以下问题通过与当前代码库（`extension-resolver.ts`、`extension-service.ts`、`session-service.ts`、`interfaces.ts`、`pi-config-bridge.ts`、pi 源码 `settings-manager.ts`）对照发现。

---

### 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST FIX | spec.md: D-1, FR-3, FR-5 | **`disabledPackages[]` 在 pi 的 settings.json schema 中不存在。** D-1 声称 "packages[] 和 disabledPackages[] 字段名与 pi 的 settings.json 一致，保持语义兼容"。但 pi 源码 `settings-manager.ts` 的 `Settings` 接口只有 `packages?: PackageSource[]`，无 `disabledPackages` 字段。pi 的 `PackageManager` 按配置中的包列表进行解析，没有"禁用"的概念——不在 `packages[]` 中的包自然不加载。 | 方案 A：放弃 `disabledPackages[]`，禁用 = 从 `packages[]` 移除但不卸载 npm 包（重新启用时重新加入 `packages[]`）。方案 B：在 xyz-agent 层面维护独立的禁用列表（不写在 pi 的 settings.json 里），加载 extension 时过滤。无论哪种，D-1 的"与 pi 一致"论断需删除或修正。 |
| 2 | MUST FIX | spec.md: FR-8 | **npm install 目标目录缺少 bootstrap 机制。** FR-8 说安装到 `~/.xyz-agent/pi/agent/npm/node_modules/`，但 `npm install` 需要目标目录有 `package.json` 才能工作。当前 `~/.xyz-agent/pi/agent/` 下只有 `settings.json`、`models.json`、`extensions/`、`skills/` 等目录，不存在 `npm/` 目录。如果直接 `npm install --prefix ~/.xyz-agent/pi/agent/npm/ <pkg>`，npm 会自动创建 `package.json`，但 spec 未说明：1) 首次安装时是否需要初始化；2) 是否使用 `--prefix` 参数；3) `package.json` 的 name/version 怎么填；4) 依赖冲突时如何处理（该目录下的 node_modules 可能被多个 pi extension 共享）。 | 明确 npm install 命令模板（如 `npm install --prefix <dir> <pkg>`），说明首次安装时的目录初始化逻辑（npm 会自动生成 `package.json`，但需确认行为），以及依赖冲突的处理策略。 |
| 3 | MUST_FIX | spec.md: FR-4, FR-5 | **ExtensionResolver 双重调用导致 extension 路径重复。** 当前 `session-service.ts:131-135` 的逻辑：`bundleExtPaths = this.getExtensionPaths()`（内部 new ExtensionResolver().resolve()）→ `userExtPaths = await this.extensionService.getExtensionPaths()` → `allExtPaths = [...bundleExtPaths, ...userExtPaths]`。FR-5 要求新的 ExtensionService 也路由到 ExtensionResolver.resolve()。如果 session-service 不改这段逻辑，settings 源的 extension 会被 resolve 两次（一次在 `getExtensionPaths()` 的 ExtensionResolver 内，一次在 ExtensionService 的 ExtensionResolver 内），导致 `--extension` 参数传重复路径给 pi。 | 方案 A：session-service 只调一次 ExtensionResolver，ExtensionService 不独立调用 resolve。方案 B：session-service 改为只调 ExtensionService（ExtensionService 内部统一调 ExtensionResolver）。方案 C：session-service 的 `getExtensionPaths()` 改为只调 ExtensionResolver（含 settings 源），ExtensionService 不再提供路径。无论哪种，spec 需明确 session-service 的调用变更。 |
| 4 | LOW | spec.md: FR-7 | **ExtensionInfo.source 的枚举值与 ExtensionResolver 源名称不对应。** FR-7 定义 `source: 'built-in' \| 'user-installed'`，但 ExtensionResolver 的源名称是 `'npm' \| 'user' \| 'settings' \| 'third-party' \| 'bundled'`。`built-in` 对应哪些源（npm + bundled？还是只有 npm？）不明确。`user-installed` 对应 `settings` 源还是 `user` 源？ | 明确 source 字段与 ExtensionResolver 源名称的映射关系。建议直接使用 ExtensionResolver 的源名称（加 `settings`），而非创造新分类。 |
| 5 | LOW | spec.md: FR-5 | **IExtensionService 接口变更未声明。** FR-5 定义了新接口 `IExtensionService` 含 `installExtension`、`uninstallExtension`、`scanExtensions`（签名变了），但当前 `interfaces.ts` 的 `IExtensionService` 只有 `scanExtensions`、`getEnabledExtensions`、`toggleExtension`、`getExtensionPaths`。spec 未声明：1) 需要更新 `interfaces.ts` 的 `IExtensionService`；2) 需要更新 `@xyz-agent/shared` 的 `ExtensionInfo` 类型（加 `source` 字段）；3) `server.ts` 的依赖注入签名是否需要变。 | 在 Constraints 或单独章节列出需要同步修改的类型定义文件：`interfaces.ts`、`shared/src/protocol.ts`。 |
| 6 | INFO | spec.md: FR-3, AC-5 | **启用/禁用规则分散在多个位置。** FR-3 说"已安装的 extension 可以切换启用/禁用"，AC-5 说"built-in 不可禁用"。这两条规则分散在 FR 和 AC 中，未在 Constraints 中集中声明。对实现者来说容易遗漏 built-in 的特殊处理。 | 建议在 Constraints 中新增一条："built-in extension 不可卸载、不可禁用。user-installed extension 可卸载、可禁用。" |
| 7 | INFO | spec.md: FR-4 | **settings 源优先级位置存在文字与代码不一致的风险。** FR-4 先给出 sources.push 顺序（bundled → third-party → settings → user → npm），又说"与现有 PRIORITY_ORDER 一致"后给出 `['npm', 'user', 'settings', 'third-party', 'bundled']`。虽然最终数组正确，但中间的 push 顺序是按代码执行顺序（低→高）排列，容易让读者混淆。 | 统一用 PRIORITY_ORDER 数组表达优先级，删除 sources.push 伪代码，避免歧义。 |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程
> - **LOW**：建议修复，但不阻塞
> - **INFO**：观察记录，无需操作

#### 等级判定校准

- #1 MUST_FIX：D-1 决策依据错误会导致实现者基于错误假设编码，`disabledPackages[]` 写入 settings.json 后 pi 不会读取，功能失效。
- #2 MUST_FIX：npm install 无 bootstrap 会直接导致安装命令失败，功能不可用。
- #3 MUST_FIX：双重调用导致 extension 路径重复传给 pi 子进程，可能引发 extension 重复加载或冲突。

---

## 3. 缺失内容清单

以下内容在 spec 中完全未提及，但对实现必要：

| 缺失项 | 影响 | 建议 |
|--------|------|------|
| pi `packages[]` 的 `PackageSource` 类型说明 | 实现者可能写成纯 string 数组，忽略 object 形式 | 在 FR-4 或 D-1 中说明 xyz-agent 仅使用 string 形式的 PackageSource |
| `isValidPiExtension` 验证的时机 | C-4 定义了验证条件，但未说是在 npm install 后立即验证还是 ExtensionResolver 扫描时验证 | AC-6 暗示是 install 后验证，但应明确 |
| npm install 的网络超时/重试策略 | 用户网络不稳定时 install 可能长时间阻塞 | 至少在 Constraints 中声明是否需要超时 |
| 并发安装保护 | AC-3 说一次一个，但未说明如果用户快速连点安装按钮的处理 | 在 Constraints 中加防重入说明 |

---

## 4. 结论

**需修改后重审。** 3 条 MUST FIX 均为功能性缺陷，不修复将导致实现失败或运行时功能不可用。

### Summary

Spec 评审完成，第 3 轮（首次评审），3 条 MUST FIX，需修改后重审。
