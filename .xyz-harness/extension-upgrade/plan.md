---
scope_ensemble_overlap: not_triggered
reuse_ensemble_overlap: not_triggered
test_ensemble_overlap: not_triggered
reconstruct_blind_spot: high   # 禁读重建盲区（MISSING 19→补 14，high 保持启用）
---

# Extension 升级与自动升级 实现计划

## 业务目标

为 Settings · Extension 页面已安装的 user-installed 扩展提供「升级」按钮（点击立即从 npm 拉最新版重装）和 per-extension「自动升级」switch（开启后 runtime 启动时静默升级到最新版）。

成功标准：
- 已安装 user-installed 扩展列表每行显示「升级」按钮 + 「自动升级」switch；built-in 扩展不显示。
- 点击「升级」按钮：该扩展从 npm registry 重装到 latest 版本，成功后列表刷新显示新版本号。
- 「自动升级」switch 状态持久化到 settings.json（`autoUpgradePackages: string[]`，形如 `npm:pi-foo`），重开 app 后保持。
- 开启 autoUpgrade 的扩展，runtime 启动时（第一个 pi 进程 `ensurePublicSession` 之前）批量检查 npm latest 版本，`semver.lt(已装版本, latest)` 为真则静默升级；升级失败仅记日志不阻塞启动。
- **时序硬约束**：自动升级必须在 `ensurePublicSession()` 之前完成——publicSession 是第一个 pi 进程，之后所有 session 经 `getExtensionPaths()` 读磁盘扫描 extension 路径，升级后磁盘文件已是新版，所有 session（含 publicSession）加载的都是升级后的版本。

约束（技术约束只记录不展开）：
- 复用现有 `npm-installer.ts` 的 `fetchMetadata`/`resolveVersion`（已实现但 internal，需 export 一个 `getLatestVersion` 封装），复用 `installPackage`（本就 resolve 到 latest）。
- autoUpgrade 开关复用 `IExtensionSettings` port + `pi-settings-store` 统一读写层（D17 互斥 RMW），存 settings.json 的 `autoUpgradePackages` 字段。
- 升级错误契约复用现有 `ExtensionInstallError`（code: not_found/network/not_extension）。
- 前端复用现有 `Switch` / `Button` 原语、`extensionApi` 域模式、`config.extensions` 推回刷新机制。
- 禁止硬编码颜色/魔数间距/原生 HTML 元素（项目规范）。

不做：
- built-in 扩展不提供升级（随 app 更新）。
- 不做「有新版本才显示升级按钮」的预检查（避免打开页面时全量查 registry 的开销；按钮常显）。
- 不做全局 autoUpgrade switch（per-extension 粒度）。
- 不做升级进度条/分步升级（单扩展升级是原子 npm install，无中间态可展示）。
- 不处理升级后「需重启 session 才生效」的 UI 提示（升级在启动前完成，运行中的 session 仍用旧版属预期；用户新建 session 自动用新版）。

## 技术改动点

### runtime 层

- **修改 `packages/runtime/src/infra/installers/npm-installer.ts`** — export 新函数 `getLatestVersion(pkgName: string, timeout?: number): Promise<string>`。内部调用现有 internal `fetchMetadata(name)` + `resolveVersion(metadata)`（无 range → latest dist-tag），返回 latest 版本号字符串。已有 `fetchMetadata`/`resolveVersion`/`httpGet`/SSRF 校验全可复用，只需组合 + export。**边界处理（禁读重建发现）**：`resolveVersion` 无 range 时返回 `metadata['dist-tags'].latest`，若包无 dist-tags.latest 会返回 undefined → 后续 `semver.lt` 抛 TypeError。getLatestVersion 必须显式处理：无 dist-tags.latest 时 fallback 到 `semver.maxSatisfying(Object.keys(versions), '*')`（取最大版本号），仍无则抛 `NpmInstallError('not_found', 'No versions available')`。

- **修改 `packages/runtime/src/services/ports/installer.ts`** — `IInstaller` port 新增方法 `getLatestVersion(pkgName: string, opts?: { timeout?: number }): Promise<string>`。port 契约扩展（纯增量，不改现有方法）。

- **修改 `packages/runtime/src/infra/installers/npm-git-installer.ts`** — `NpmGitInstaller` 实现新 port 方法，委托给新 export 的 `getLatestVersion`。

- **修改 `packages/shared/src/protocol.ts`** — ClientMessageType 新增 `'extension.upgrade' | 'extension.setAutoUpgrade'`；ClientMessageMapBase 新增对应 payload 类型（`extension.upgrade: { name: string }`、`extension.setAutoUpgrade: { name: string; enabled: boolean }`）。reply 复用现有 `config.extensions`（升级/开关后重扫列表推回，与 install/uninstall/toggle 同模式）。

- **修改 `packages/runtime/src/services/ports/extension-settings.ts`** — `IExtensionSettings` port 新增：`getAutoUpgrade(): string[]`（读 autoUpgradePackages[]）、`setAutoUpgrade(source: string, enabled: boolean): Promise<void>`（add/remove）、`removeAutoUpgrade(source: string): Promise<void>`（卸载时清理）。

- **修改 `packages/runtime/src/infra/pi/pi-extension-settings.ts`** — `PiExtensionSettings` 实现新 port 方法。autoUpgradePackages 存 settings.json（经 `updateSettingsSync` RMW，与 packages[] 同域同文件同互斥），读写模式照搬现有 `addPackage`/`removePackage`/`getPackages`。

- **修改 `packages/runtime/src/infra/pi/pi-settings-store.ts`** — `PiSettings` interface 新增 `autoUpgradePackages?: string[]` 字段（纯类型扩展，透传未知字段语义已有 `[key: string]: unknown`，但显式声明便于类型安全）。

- **修改 `packages/runtime/src/services/extension-service.ts`** — 新增三个方法：
  - `upgradeExtension(name: string): Promise<void>` — **校验包存在且是 user-installed**：先 scanExtensions 查找 name 对应的 ExtensionInfo，找不到抛 `ExtensionInstallError(code='not_installed', 'Extension not installed: ...')`；source=built-in 抛 `ExtensionInstallError(code='not_user_installed', 'Built-in extensions cannot be upgraded')`（注：不复用 'not_extension' code——该 code 语义特指「npm 装成功但非有效 pi extension」，built-in 不该升级属「操作不被允许」，语义不同）。校验通过后调 `this.installer.installNpm(name, nodeModulesDir)` 重装 latest，复用 installExtension 的「验证有效 pi extension」（isValidPiExtension）+ 错误分类逻辑（not_found/network/extract→network/integrity→network）。
  - `setAutoUpgrade(pkgName, enabled)` — 调 extSettings.setAutoUpgrade，source 参数为 npm: 前缀拼包名。
  - `autoUpgradeOnStartup(): Promise<void>` — 启动时批量升级入口：读 `getAutoUpgrade()` + `scanExtensions()`，对每个 autoUpgradePackages 条目：从 scanExtensions 结果按 sourceKey（`npm:` + name）匹配已装扩展。**跳过条件**：scanExtensions 扫不到（磁盘无包，settings 残留）→ skip + warn；source=built-in → skip + warn。**版本判定**：已装 version 或 getLatestVersion 返回值任一为空/非法 semver（用 `semver.valid()` 校验，version='' 会 invalid）→ skip + warn（不调 semver.lt 避免 TypeError）。两者均合法且 `semver.lt(已装, latest)` 为真 → `installNpm` 重装。**容错**：getLatestVersion 失败和 installNpm 失败都 console.warn 不阻塞，整体 try-catch，方法永远 resolve 不抛（确保不阻塞启动）。
  - `uninstallExtension` 增加一行：卸载时同步 `removeAutoUpgrade(source)`（与现有 `removeDisabled` 对称，防 settings 残留无效条目）。

- **修改 `packages/runtime/src/transport/extension-message-handler.ts`** — `handles` 数组加 `'extension.upgrade' | 'extension.setAutoUpgrade'`；`handleExtensionMessage` switch 加两个 case。**payload 校验（禁读重建发现）**：参照 installDir/installGit 的 `invalid_payload` 守卫，upgrade/setAutoUpgrade 校验 name 非空字符串（setAutoUpgrade 额外校验 enabled 是 boolean），否则 `sendError('invalid_payload', ...)`。**错误路径显式定义**：upgrade 失败走现有 `sendInstallError`（复用 ExtensionInstallError 契约，install_failed envelope）；setAutoUpgrade 失败走 `sendError('setAutoUpgrade_failed', ...)`（参照 toggle 走 toggle_failed 模式，不走 sendInstallError——setAutoUpgrade 不涉及 npm 安装，语义不同）。成功后均 scanExtensions → reply config.extensions。

- **修改 `packages/runtime/src/index.ts`** — 在 `await sessionService.ensurePublicSession()` **之前**插入 `await extensionService.autoUpgradeOnStartup()`（包在 try-catch 里，失败 `console.error` 不阻塞，与 pluginService.initialize 容错模式一致）。这是时序硬约束的落地点。

### renderer 层

- **修改 `packages/renderer/src/api/domains/extension.ts`** — 新增 `upgrade(name: string): Promise<void>` 和 `setAutoUpgrade(name: string, enabled: boolean): Promise<void>`，模式照搬现有 `uninstall`/`toggle`（pending.create + transport.send）。

- **修改 `packages/renderer/src/components/settings/ExtensionPage.vue`** — 已安装列表每行：
  - version 标签后新增「自动升级」`Switch`（仅 user-installed 显示，`ext.source === 'user-installed'`），`model-value` 绑定本地 `autoUpgradeSet`（从 props.extensions 派生时需补 autoUpgrade 状态——见下），点击调 `extensionApi.setAutoUpgrade`，失败回滚 + actionError。
  - Switch 后新增「升级」`Button`（仅 user-installed 显示，`ArrowUpCircle` 或 `RefreshCw` 图标），loading 态用 `upgradingSet: Set<string>` 管理，点击调 `extensionApi.upgrade`，成功后列表经 onExtensions 自动刷新。
  - 新增 `upgrading` ref（Set<name>）+ `onUpgrade(ext)` 方法。
  - 新增 `onSetAutoUpgrade(ext, enabled)` 方法。
  - **autoUpgrade 状态来源问题**：现有 `ExtensionInfo` 不含 autoUpgrade 字段，`scanExtensions` 也不读 autoUpgradePackages。方案：`ExtensionInfo` 新增可选字段 `autoUpgrade?: boolean`，`scanExtensions()` 读 `getAutoUpgrade()` 填充（与 enabled/source 同模式读 settings 填充）。这样前端直接用 `ext.autoUpgrade` 绑定，无需额外请求。

### shared 层

- **修改 `packages/shared/src/extension.ts`** — `ExtensionInfo` 新增 `autoUpgrade?: boolean` 字段（可选，向后兼容；runtime scanExtensions 填充，前端消费）。

## Wave 拆分与依赖

| Wave | 改动文件 | 依赖 | 并行组 | 说明 |
|------|---------|------|--------|------|
| W1 | shared/extension.ts, shared/protocol.ts, runtime: npm-installer.ts, ports/installer.ts, npm-git-installer.ts, ports/extension-settings.ts, pi-extension-settings.ts, pi-settings-store.ts, extension-service.ts, extension-message-handler.ts | - | - | runtime + shared 全栈：类型 + port + 实现 + service + handler（runtime 内部强耦合，同 Wave 串行实现，不可再拆——升级链路 types→port→impl→service→handler 是一条调用链，拆开会产生中间不可编译态） |
| W2 | runtime/index.ts | W1 | - | 启动时挂载 autoUpgradeOnStartup（依赖 W1 的 service 方法） |
| W3 | renderer: api/domains/extension.ts, components/settings/ExtensionPage.vue | W1 | - | 前端 API + UI（依赖 W1 的 WS 消息类型 + ExtensionInfo.autoUpgrade 字段） |

> W2 和 W3 改动文件无交集、无调用依赖（W2 改 runtime 启动，W3 改前端），理论可并行，但 W2 是 1 行挂载（极小），W3 是前端主体，拆并行组编排开销 > 收益，串行执行。整体回归由 CW test 阶段承担。

## 单测用例清单（AC 级）

### npm-installer.getLatestVersion（W1）

| 用例ID | 覆盖改动点 | 输入 | 预期 | 类型 |
|--------|-----------|------|------|------|
| U1 | npm-installer.ts:getLatestVersion | pkgName='pi-foo'，mock fetchMetadata 返回 dist-tags.latest='1.2.3' + versions 含 '1.2.3' | resolve 返回 '1.2.3' | 正常 |
| U2 | npm-installer.ts:getLatestVersion | pkgName='not-exist'，mock fetchMetadata 抛 NpmInstallError('not_found') | 抛 NpmInstallError code='not_found' | 异常 |
| U3 | npm-installer.ts:getLatestVersion | pkgName='@scope/pkg'（scoped 包名编码），验证 encodePackageName 被调用 | URL 含 %2F 编码，正常返回 latest | 边界 |
| U3b | npm-installer.ts:getLatestVersion | mock fetchMetadata 返回 dist-tags={} 无 latest + versions 含 '0.1.0','0.2.0' | fallback 到 semver.maxSatisfying 返回 '0.2.0'（不返回 undefined） | 边界 |
| U3c | npm-installer.ts:getLatestVersion | mock fetchMetadata reject new Error('Request timeout')（httpGet 超时路径，非 NpmInstallError） | 抛 Error（原样冒泡，autoUpgradeOnStartup catch 兜住）—— 验证不返回 undefined | 异常 |

### ExtensionService.upgradeExtension（W1）

| 用例ID | 覆盖改动点 | 输入 | 预期 | 类型 |
|--------|-----------|------|------|------|
| U4 | extension-service.ts:upgradeExtension | user-installed 扩展 'pi-foo'，mock installer.installNpm 成功 + resolver.isValidPiExtension=true | 调用 installNpm('pi-foo', nodeModulesDir) + isValidPiExtension 被调，不抛错 | 正常 |
| U5 | extension-service.ts:upgradeExtension | built-in 扩展（source='built-in'） | 抛 ExtensionInstallError code='not_user_installed'，hint 提示 built-in 不支持升级 | 异常 |
| U5b | extension-service.ts:upgradeExtension | name='never-installed'，scanExtensions 扫不到该包（不在 packages[]） | 抛 ExtensionInstallError code='not_installed' | 边界 |
| U6 | extension-service.ts:upgradeExtension | installNpm 后 resolver.isValidPiExtension=false（包损坏） | 抛 ExtensionInstallError code='not_extension'，且调用 uninstallNpm 回滚 | 异常 |
| U7 | extension-service.ts:upgradeExtension | installNpm 抛 NpmInstallError code='network' | 抛 ExtensionInstallError code='network'，不调 uninstallNpm | 异常 |
| U7b | extension-service.ts:upgradeExtension | installNpm 抛 NpmInstallError code='not_found'（404） | 抛 ExtensionInstallError code='not_found'，hint='Check the package name...' | 异常 |

### ExtensionService.setAutoUpgrade（W1）

| 用例ID | 覆盖改动点 | 输入 | 预期 | 类型 |
|--------|-----------|------|------|------|
| U8 | extension-service.ts:setAutoUpgrade + extSettings | name='pi-foo', enabled=true | extSettings.setAutoUpgrade('npm:pi-foo', true) 被调用 | 正常 |
| U9 | extension-service.ts:setAutoUpgrade + extSettings | name='pi-foo', enabled=false | extSettings.setAutoUpgrade('npm:pi-foo', false) 被调用 | 正常 |
| U9b | extension-service.ts:setAutoUpgrade + extSettings | 连续两次 setAutoUpgrade('pi-foo', true) | autoUpgradePackages 不出现重复条目（去重幂等） | 边界 |

### ExtensionService.autoUpgradeOnStartup（W1/W2）

| 用例ID | 覆盖改动点 | 输入 | 预期 | 类型 |
|--------|-----------|------|------|------|
| U10 | extension-service.ts:autoUpgradeOnStartup | autoUpgradePackages=['npm:pi-foo']，scanExtensions 返回 pi-foo v0.1.0 source=user-installed，mock getLatestVersion 返回 '0.2.0' | installNpm('pi-foo') 被调用 1 次（semver.lt('0.1.0','0.2.0')=true） | 正常 |
| U11 | extension-service.ts:autoUpgradeOnStartup | autoUpgradePackages=['npm:pi-foo']，pi-foo 已是 v0.2.0，getLatestVersion 返回 '0.2.0' | installNpm **不**被调用（semver.lt('0.2.0','0.2.0')=false，跳过） | 边界 |
| U12 | extension-service.ts:autoUpgradeOnStartup | autoUpgradePackages=['npm:pi-foo','npm:pi-bar']，pi-foo 升级成功，pi-bar getLatestVersion 抛错 | pi-foo 升级成功 + pi-bar 失败仅 console.warn，方法整体不抛错（不阻塞启动） | 异常 |
| U12b | extension-service.ts:autoUpgradeOnStartup | autoUpgradePackages=['npm:pi-foo']，getLatestVersion 返回 '0.2.0'（需升级）但 installNpm reject NpmInstallError('network') | installNpm 失败仅 console.warn，方法整体不抛错 | 异常 |
| U13 | extension-service.ts:autoUpgradeOnStartup | autoUpgradePackages=['npm:pi-foo']，但 scanExtensions 中 pi-foo source='built-in'（settings 残留无效条目） | 跳过 built-in，installNpm 不被调用 | 边界 |
| U13b | extension-service.ts:autoUpgradeOnStartup | autoUpgradePackages=['npm:pi-foo']，但 scanExtensions 返回空（磁盘无包，settings 残留） | 跳过（找不到已装扩展），installNpm/getLatestVersion 不被调用，不抛错 | 边界 |
| U13c | extension-service.ts:autoUpgradeOnStartup | autoUpgradePackages=['npm:pi-foo']，scanExtensions 返回 pi-foo 但 version=''（readPackageJson fallback），getLatestVersion 返回 '0.2.0' | semver.valid('')=null → 跳过 + warn，不调 semver.lt（避免 TypeError），installNpm 不被调用 | 边界 |
| U14 | extension-service.ts:autoUpgradeOnStartup | autoUpgradePackages=[]（无开启自动升级的扩展） | 直接返回，installNpm/getLatestVersion 均不调用 | 边界 |

### ExtensionService.uninstallExtension 清理（W1）

| 用例ID | 覆盖改动点 | 输入 | 预期 | 类型 |
|--------|-----------|------|------|------|
| U15 | extension-service.ts:uninstallExtension | 卸载 'pi-foo'，该扩展在 autoUpgradePackages 中 | removeAutoUpgrade('npm:pi-foo') 被调用（与 removeDisabled 对称） | 正常 |
| U15b | extension-service.ts:uninstallExtension | 卸载 'pi-bar'，该扩展**不在** autoUpgradePackages 中 | removeAutoUpgrade 仍被调用但 no-op（不报错，不影响现有卸载流程） | 边界 |

### scanExtensions 填充 autoUpgrade（W1）

| 用例ID | 覆盖改动点 | 输入 | 预期 | 类型 |
|--------|-----------|------|------|------|
| U16 | extension-service.ts:scanExtensions | autoUpgradePackages=['npm:pi-foo']，扫描到 pi-foo + pi-bar | pi-foo 的 ExtensionInfo.autoUpgrade=true，pi-bar 的 autoUpgrade=false（明确 false 非 undefined） | 正常 |
| U16b | extension-service.ts:scanExtensions | autoUpgradePackages=['npm:@zhushanwen/pi-goal']（scoped 包），扫描到 @zhushanwen/pi-goal | sourceKey='npm:@zhushanwen/pi-goal' 正确匹配，autoUpgrade=true | 边界 |
| U17 | extension-service.ts:scanExtensions | autoUpgradePackages=[]（空） | 所有扩展 autoUpgrade=false（明确 false，向后兼容旧前端不因字段缺失崩溃） | 边界 |

### extension-message-handler（W1）

| 用例ID | 覆盖改动点 | 输入 | 预期 | 类型 |
|--------|-----------|------|------|------|
| U18 | extension-message-handler.ts:upgrade case | msg type='extension.upgrade', payload.name='pi-foo' | 调用 ext.upgradeExtension('pi-foo') → scanExtensions → reply config.extensions | 正常 |
| U19 | extension-message-handler.ts:setAutoUpgrade case | msg type='extension.setAutoUpgrade', payload.name='pi-foo' enabled=true | 调用 ext.setAutoUpgrade → scanExtensions → reply config.extensions | 正常 |
| U20 | extension-message-handler.ts:upgrade 失败 | upgradeExtension 抛 ExtensionInstallError | 走 sendInstallError（复用 install 错误契约），reply error envelope | 异常 |
| U20b | extension-message-handler.ts:setAutoUpgrade 失败 | ext.setAutoUpgrade 抛 Error | sendError('setAutoUpgrade_failed', ...)（不走 sendInstallError，参照 toggle_failed 模式） | 异常 |
| U20c | extension-message-handler.ts:payload 校验 | upgrade payload name 缺失或非字符串；setAutoUpgrade payload name 缺失或 enabled 非 boolean | sendError('invalid_payload', ...) | 边界 |

### pi-extension-settings 三方法（W1）

| 用例ID | 覆盖改动点 | 输入 | 预期 | 类型 |
|--------|-----------|------|------|------|
| U21 | pi-extension-settings.ts:getAutoUpgrade/setAutoUpgrade/removeAutoUpgrade | 真实 testSettingsDir（经 PiExtensionSettings 实例）：getAutoUpgrade 读无 autoUpgradePackages 字段的 settings → []；setAutoUpgrade('npm:pi-foo',true) 写入；getAutoUpgrade → ['npm:pi-foo']；setAutoUpgrade 再 false → [] | 经 updateSettingsSync RMW 读写，去重，ENOENT 容错 | 正常 |
| U21b | pi-extension-settings.ts:removeAutoUpgrade | removeAutoUpgrade('npm:never-existed')（不存在于 autoUpgradePackages） | no-op，不报错，autoUpgradePackages 不变 | 边界 |

### index.ts 启动时序（W2）

| 用例ID | 覆盖改动点 | 输入 | 预期 | 类型 |
|--------|-----------|------|------|------|
| U22 | index.ts:启动时序 | mock extensionService.autoUpgradeOnStartup reject，启动 runtime | autoUpgradeOnStartup 在 ensurePublicSession 之前被 await；抛错被 try-catch 吞掉（console.error）；ensurePublicSession 仍被调用；runtime 正常 ready | 异常 |

## E2E 用例清单

> 测试栈探测结果：项目有 Playwright（playwright.config.ts + e2e/ 目录 + package.json `test:e2e`）+ vitest（renderer/runtime 各有 vitest.config.ts）。runtime 层用 vitest 单测（U1-U20）；前端组件交互 + 真实 WS 集成用 Playwright E2E。docs/testing/ 无 extension 专属文档，从 fixture 对齐推导。

| 用例ID | 场景 | 测试层 | 前置 | 步骤 | 预期 | 执行方式 | dependsOn | parallelGroup |
|--------|------|--------|------|------|------|---------|-----------|---------------|
| E1 | 升级按钮交互（mock WS） | mock | ExtensionPage mount，extensions 含 1 个 user-installed 扩展 v0.1.0，mock extensionApi.upgrade resolve；升级后模拟 runtime 推 config.extensions（version 变 0.2.0） | 1.mount ExtensionPage 2.找到升级按钮 3.点击 4.等待 loading 消失 5.触发 config.extensions 推送（version→0.2.0） | 升级按钮存在且可点击；点击后 loading 出现后消失；upgrade 被调用 1 次；**列表中该扩展 version 标签从 v0.1.0 变为 v0.2.0**（使用者视角：验证可见效果，非仅 API 被调） | npx vitest run（renderer vitest，@vue/test-utils mount + mock api） | - | g-ext |
| E2 | 自动升级 switch 交互（mock WS） | mock | ExtensionPage mount，extensions 含 user-installed 扩展 'pi-foo' autoUpgrade=false，mock setAutoUpgrade resolve | 1.mount 2.找到 autoUpgrade Switch 3.点击切换 4.验证 api 调用 | Switch 状态切换；setAutoUpgrade('pi-foo',true) 被调用 | npx vitest run | - | g-ext |
| E3 | built-in 扩展不显示升级 UI（mock） | mock | ExtensionPage mount，extensions 含 1 built-in + 1 user-installed | 1.mount 2.查 built-in 行 3.查 user-installed 行 | built-in 行无升级按钮无 autoUpgrade switch；user-installed 行有 | npx vitest run | - | g-ext |
| E4 | 升级失败错误反馈（mock） | mock | mock extensionApi.upgrade reject('network error') | 1.mount 2.点升级 3.等待 | actionError 区域显示错误信息 | npx vitest run | - | g-ext |
| E5 | autoUpgrade switch 切换失败回滚（mock） | mock | ExtensionPage mount，extensions 含 user-installed 扩展 autoUpgrade=false，mock extensionApi.setAutoUpgrade reject | 1.mount 2.点 autoUpgrade Switch 3.等待 reject | Switch 视觉态回到 false（失败后 onExtensions 未变→开关自动恢复，与 onToggle 失败回滚机制对称）；actionError 显示错误 | npx vitest run | - | g-ext |
| E1-r | 启动时自动升级集成（service→installer→settings 真实组装） | real | 真实 ExtensionService（临时 settingsDir）+ vi.mock NpmGitInstaller 的 installNpm 和 getLatestVersion；autoUpgradePackages=['npm:pi-ask-user']，磁盘上 pi-ask-user v0.1.0；mock getLatestVersion 返回 '0.2.0' | 1.准备临时 settingsDir（旧版扩展 + autoUpgradePackages 配置） 2.构造真实 ExtensionService 3.调 autoUpgradeOnStartup() 4.检查 installer 调用 | **installNpm 对 pi-ask-user 被调用 1 次**（semver.lt('0.1.0','0.2.0')=true 触发）；getLatestVersion 被调；方法不抛错。注：mock installer 不写盘，不断言磁盘 version 变更（那需真实 npm，标 [需集成环境]），只验证逻辑判定 + 真实组装链路 | npx vitest run（runtime 集成测试） | - | g-ext-real |

> E1-r 说明：真实 npm registry 测试慢且不稳定，实际执行用 mock installer（vi.mock NpmGitInstaller.installNpm + getLatestVersion），验证「autoUpgradeOnStartup 在真实 service→settings 组装下调用了 installNpm」这一集成行为（semver.lt 判定 + 容错）。mock installer 不写盘，故不断言磁盘 version 变更（那需真实 npm registry，标 `[需集成环境]`）。归 real 层因它验证真实 ExtensionService + 真实 PiExtensionSettings 的组装（非纯单测 mock 所有依赖）。

## 覆盖率 gate

- gate 命令：
  - runtime：`cd packages/runtime && npx vitest run --coverage`
  - renderer：`cd packages/renderer && npx vitest run --coverage`
- 增量算法：vitest `--coverage` 报全量，用 `git diff --name-only main` 出改动文件，看报告中这些文件（extension-service.ts / npm-installer.ts / extension-message-handler.ts / ExtensionPage.vue / extension.ts api）的行覆盖。
- 阈值：增量改动文件覆盖率 ≥ 60%（项目无更高既有阈值配置，60% 为下限）。

## 实现步骤

1. **[W1] runtime + shared 全栈升级链路**（TDD）：
   - 写 U1-U3c 失败测试（getLatestVersion，含 dist-tags 缺失 fallback + 超时路径）→ 在 npm-installer.ts export `getLatestVersion`（组合现有 fetchMetadata + resolveVersion，无 dist-tags.latest 时 fallback 到 semver.maxSatisfying）→ 测试通过
   - 写 U16/U16b/U17 失败测试（scanExtensions 填充 autoUpgrade，含 scoped 包名）→ 在 IExtensionSettings port + PiExtensionSettings 加 getAutoUpgrade/setAutoUpgrade/removeAutoUpgrade；pi-settings-store.ts 加 autoUpgradePackages 类型；extension-service.ts scanExtensions 读 getAutoUpgrade 填充 → 测试通过
   - 写 U21/U21b 失败测试（PiExtensionSettings 三方法真实文件读写）→ 验证经 updateSettingsSync RMW 读写 + 去重 + no-op → 测试通过
   - 写 U4-U7b 失败测试（upgradeExtension，含 not_installed/not_found/not_user_installed 语义）→ extension-service.ts 加 upgradeExtension 方法（校验包存在 + source + installNpm + isValidPiExtension 验证 + 错误分类）→ 测试通过
   - 写 U8/U9/U9b 失败测试（setAutoUpgrade，含幂等）→ extension-service.ts 加 setAutoUpgrade 方法 → 测试通过
   - 写 U10-U14/U12b/U13b/U13c 失败测试（autoUpgradeOnStartup，含 installNpm 失败 / 磁盘无包残留 / version 空字符串 semver.valid 校验）→ extension-service.ts 加 autoUpgradeOnStartup 方法（批量 semver.valid + semver.lt 判定 + 多失败点容错）→ 测试通过
   - 写 U15/U15b 失败测试（uninstall 清理，含 no-op）→ uninstallExtension 加 removeAutoUpgrade → 测试通过
   - 写 U18-U20c 失败测试（handler，含 payload 校验 + setAutoUpgrade_failed 错误路径）→ IInstaller port + NpmGitInstaller 加 getLatestVersion；shared/protocol.ts 加 extension.upgrade/setAutoUpgrade 消息类型；shared/extension.ts 加 ExtensionInfo.autoUpgrade 字段；extension-message-handler.ts 加 case + invalid_payload 守卫 → 测试通过
   - 全部 W1 测试绿 → 提交

2. **[W2] 启动时挂载自动升级**：
   - 写 U22 失败测试（时序 + 容错）→ 在 index.ts 的 `await sessionService.ensurePublicSession()` 之前插入 `try { await extensionService.autoUpgradeOnStartup() } catch (e) { console.error(...) }`（时序硬约束：必须在 ensurePublicSession 前，确保 publicSession 及后续 session 加载升级后版本；失败不阻塞启动）→ 测试通过
   - 提交

3. **[W3] 前端 API + UI**：
   - 写 E1-E5 失败测试（ExtensionPage 组件测试，@vue/test-utils mount + mock extensionApi，含 version 刷新断言 E1 + switch 失败回滚 E5）→ 在 api/domains/extension.ts 加 upgrade/setAutoUpgrade 方法；ExtensionPage.vue 已安装列表每行加「自动升级」Switch（仅 user-installed）+「升级」Button（仅 user-installed）+ onUpgrade/onSetAutoUpgrade 方法 + upgrading/upgradingSet 状态 → 测试通过
   - 提交

4. **[验收]** 运行全量单测（U1-U22）+ 覆盖率 gate + E2E（E1-E5 mock + E1-r real 集成）→ 全绿
