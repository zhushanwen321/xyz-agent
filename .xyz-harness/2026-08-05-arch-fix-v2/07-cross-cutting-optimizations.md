# 跨主题架构优化（4 个机会）

> 不是单个 bug 修复，而是从 8 份审查报告中提炼的跨问题共性，建立可持续架构约定。

---

## 优化 1：端口注入模式标准化

### 现状

core 已有 3 套端口注入，各自独立约定：

| 端口 | 注入函数 | 读取函数 | 测试隔离 | 位置 |
|---|---|---|---|---|
| PlatformPort | providePlatform | getPlatform（fail-fast） | __resetPlatformForTesting | core/platform/port.ts |
| DevMode | provideDevMode | isDevMode（恒 false 不抛） | __resetDevModeForTesting | core/platform/dev-mode.ts |
| ConnectionPorts | setConnectionPorts | useCoreConnection（内部读） | — | core/transport/use-connection.ts |

**差异**：
- getPlatform 未注入抛错（fail-fast），isDevMode 未注入恒 false（静默）—— 不一致
- 命名不统一（providePlatform / provideDevMode / setConnectionPorts）
- ConnectionPorts 无测试 reset 函数

### 优化

**统一端口注入约定**：
1. 命名约定：`provideXxx(port)` / `getXxx()` / `__resetXxxForTesting()`
2. 注入时序：壳 bootstrap 时注入，core 启动前完成
3. **读取策略：按「有无安全默认值」分流，不一号切 fail-fast**
   - **无安全默认值 → fail-fast**（getPlatform 模式：未注入抛错，防隐式 undefined）
   - **有安全默认值 → 静默**（isDevMode 模式：未注入恒 false，让 core 单测不注入也能跑）
   - 判据：统一 fail-fast 会强迫所有 core 测试注入端口；按默认值分流比统一策略可持续
4. 测试隔离：所有端口必须有 `__resetXxxForTesting()`

### 推广场景

core 新增环境耦合时优先端口化而非直连：
- composer input 的 DOM 访问（决策 1 A2 后归 dom-core，core 不需 DOM 端口）
- chat store.ts:86 的 `window.electronAPI?.getStreamingTimeout` TODO（@platform-port-wave）—— 用 PlatformPort.ipc 注入
- 未来 core 新增的 electron/Vite/env 耦合

### 落地

1. 建一个 `docs/architecture/port-injection-convention.md`（或 ADR），固化约定
2. isDevMode 改 fail-fast（或文档说明为何静默）
3. ConnectionPorts 补 __resetConnectionPortsForTesting
4. 命名不一致的统一（小改）

**时机**：决策 1 之后（dom-core 抽出后，core 边界清晰，端口约定固化）。

---

## 优化 2：re-export shim 模式推广

### 现状

slashIcons 已用此模式（renderer `composables/slashIcons.ts` 6 行 shim → ui SSOT）：

```ts
/** slash 命令 icon 组件映射 —— 薄 re-export（SSOT 在 @xyz-agent/ui）。*/
export { SLASH_ICON_COMPONENTS } from '@xyz-agent/ui'
```

### 优化

**建立「renderer 消费 ui/core/dom-core SSOT 经 re-export shim」约定**，推广到：
- file-basename（收尾 7.3）
- utils 的 cn()（收尾 7.3）
- 未来任何「renderer 原 re-export ui/core/dom-core」场景

### 约定内容

1. SSOT 在 ui（Vue 组件/原语）或 core/dom-core（headless/DOM 逻辑）
2. renderer 消费方经 re-export shim（`composables/xxx.ts` 或 `lib/xxx.ts`，6 行内）
3. shim 只做 re-export + JSDoc 指向 SSOT，零本地逻辑
4. renderer 消费方 import shim 路径（`@/composables/slashIcons`），不直接 import ui/core

### 收益

- SSOT 单一（改一处全局生效）
- renderer 消费方 import 路径稳定（ui/core 重构不影响 renderer import）
- 语义清晰（shim 文件名即文档）

### 落地

1. 把约定写入 `docs/standards.md` 或 ADR
2. 收尾 7.3（file-basename/utils）按此模式做
3. 未来 review 检查：renderer 是否有「与 ui/core/dom-core 重复的实现」→ 改 shim

**时机**：收尾 7.3 时顺势落地。

---

## 优化 3：窄口径自动化范式守护（可选）

### 现状

ADR-0049 Code Review Checklist（4 项）是文档门禁，依赖 reviewer 纪律执行：
1. 该 composable 是否持有 per-session 状态？
2. 若是，是否用了 useSessionScopedState 工厂？
3. WS handler 是否用 updateFor(sid, ...) 而非 update(...)？
4. session 销毁时分区是否 cleanup？

例外清单：4 处（useChat / subscription-state / useForkNoticeEffect / useSessionEvents）显式登记。

### 风险

文档门禁强度依赖 reviewer 执行纪律。新 PR 若 reviewer 漏看 checklist，仍可能引入模块级 Map。

### 优化

补一个**窄口径 ESLint 规则**，避开 AST 语义判定误报重灾区：

**检测条件（全部满足才报）**：
1. 模块顶层（非函数内）`const X = new Map<string,` 或 `new Set<string>`
2. 文件含 `sessionId` / `sid` 语义（变量名/参数名/import useSessionScopedState）
3. 文件未在 ADR-0049 例外清单（白名单文件路径）

**避开误报**：
- 不做 AST 语义判定（「这个 Map 是否 per-session 状态」太复杂）
- 只检测「模块顶层 Map/Set + sessionId 语义 + 未登记例外」的明显矛盾
- 白名单文件（4 个例外）显式豁免

### 投入产出比

- **投入**：写一个 ESLint custom rule（~50 行）+ 白名单维护
- **产出**：新增模块级 per-session Map 时自动报错，强制走工厂或登记例外
- **误报率**：低（三重条件收紧）

### 落地

1. 评估是否值得（若团队 reviewer 执行纪律高，文档门禁够用）
2. 若做，写 `.eslintrc.custom.js` 或 taste-lint 自定义规则
3. 白名单 = ADR-0049 例外清单文件路径

**时机**：可选。文档门禁够用时不必做。

---

## 优化 4：深模块化重构范式

### 现状

B4 Composer 已用此范式（873 行 useContenteditableInput → 三轴划分 input/dispatch/context + composer-shell.ts facade）。

待应用：
- 重构 4（B6 *Impl 消除，streaming-state-machine 深模块）
- 重构 2（ViewHost 挂载）
- 收尾 5（Settings 大文件拆分）

### 范式三段式

1. **逻辑归位**：按职责内聚到深模块（domain/store/state-machine），非「为绕 lint 行数限制拆 *Impl」
2. **壳装配**：容器组件/composable 退化为薄装配层，经 deps 注入或 facade 组装深模块
3. **facade 消费**：消费方只 import 1 个 facade（如 Composer.vue 只 import useComposerShell），不直接碰深模块内部

### 信号识别（何时该深模块化）

| 信号 | 含义 | 案例 |
|---|---|---|
| `*Impl` 后缀函数为绕 max-lines | 模块级函数拆分反模式 | B6 store.ts 6 个 *Impl |
| 容器组件 > 400 行 + import 多个 composable | 上帝组件 | B5 前 Sidebar.vue 508 行 |
| 同类逻辑散落多处 | 缺内聚 | ⌘[⌘]⌘, 散落 AppShell + useGlobalShortcuts |
| 深模块有独立测试价值 | 可抽 | streaming-state-machine（B6） |

### 落地

1. 把范式写入 `docs/standards.md` 的「重构」章节
2. 后续重构（B6 / ViewHost / Settings 拆分）统一遵循
3. review 检查：新代码是否有上述信号 → 建议深模块化

**时机**：重构 4 时顺势固化。

---

## 4 个优化的优先级

| 优化 | 优先级 | 时机 | 理由 |
|---|---|---|---|
| 1 端口注入标准化 | 中 | 决策 1 后 | 现有 3 套不一致，未来新增端口会延续混乱；但不阻塞功能 |
| 2 re-export shim 推广 | 中 | 收尾 7.3 时 | 顺势落地，约定化防止未来双份 |
| 3 窄口径自动化守护 | 低（可选） | 按需 | 文档门禁够用时不必做；团队纪律不足时再补 |
| 4 深模块化范式 | 中 | 重构 4 时 | B6/ViewHost/Settings 重构时遵循，避免重蹈 *Impl 反模式 |
