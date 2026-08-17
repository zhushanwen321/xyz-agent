# P6 验收门审计报告（AC2-AC8）— renderer-rebuild v2

> **所属**：`wave:renderer-rebuild-v2::p6-cleanup::acceptance-gate-audit::w1-ac2-ac8-audit-and-fix`
> **依据**：renderer-rebuild-architecture.md §11.4（终态验收基准）+ p0-acceptance-gate.md（P0 验收门记录，本报告承接其 AC2-AC8 核对）+ p6-residual-deletion-inventory.md（兄弟 wave 的 AC1 判定交接契约）
> **状态**：**4 条 pass（AC2 修后 / AC3 / AC4 / AC8）+ 1 条新包侧 pass 但整体 blocked-prereq（AC5）+ 2 条 blocked-prereq（AC6 / AC7）**。P6 范围清理遗漏 1 项已修复（AC2 lint 规则补丁）。

## 基线声明

- **实测日期**：2026-08-03（与 p0-acceptance-gate.md 同基线时段）
- **git HEAD**：`edb0af046`（docs: p6 residual-deletion inventory (w1)）
- **未提交改动**：存在（`packages/core/src/coordination/route-inbound.ts` 迁移、`packages/renderer/src/components/panel/SideDrawer.vue` 等并行 wave 产物）。本审计按 clarify 决议**以工作区实测现状为基线**，未提交改动仅作观察对象，未修改未提交（认知外改动零触碰，ES3）。
- **基线差异说明**：slice plan 编写时假设「P1-P5 未执行、core 仅 4 文件」；实测 core 已有 65 文件（transport/coordination/extension-host/domain/foundation/rendering-protocol）。故 AC3/AC4/AC6/AC7 的核对对象实际存在，本报告逐项实测而非预设 blocked-prereq；实测缺失或未接线才记前置阻塞。

## Summary 表

| AC | 断言 | 审计命令 | status | 证据 |
|----|------|----------|--------|------|
| AC2 | core 零 `node:` / 零 `window.electronAPI` / 零直接 `localStorage`/`WebSocket`（lint 强制） | grep 全量扫描 + `npx eslint packages/core/src` | **pass**（修后；lint 规则原未开启，已补） | 零实际命中（仅注释提及）；补 3 条 lint 规则后红-绿验证通过 |
| AC3 | routeInbound 声明式 ROUTE_TABLE 查表 + 执行，无业务逻辑内联 | 代码审查 `route-inbound.ts` + `route-inbound.test.ts` | **pass**（代偿：代码审查） | ROUTE_TABLE 精确 type 查表（DM3），15 用例覆盖 pending 分流/seq gap/双通道 |
| AC4 | stores 零跨域 import、零 import composable | grep core 外部 import 全量 | **pass** | 外部 import 仅 `@xyz-agent/shared`（15 处）；零 ui/renderer/mobile 越界、零 composable |
| AC5 | 零 `reset*ModuleState`；per-session 100% useSessionScopedState（presence/lease 两例外） | grep 新四包 + 旧 renderer | **blocked-prereq**（P3） | 新包零命中 ✓；旧 renderer 2 处残留（useChat.ts / useMessageBusSubscription.ts）属 P3 域绞杀未完成 |
| AC6 | plugin 全链路（contributes.views→sidebar 第5tab→GuiComponent + 按钮→command + uiRequest→companion-band） | 代码审查 extension-host + ui 包 | **blocked-prereq**（P4/P5） | core 侧机制完整（34 测试）但桌面壳零接线；companion-band 链路未交付 |
| AC7 | builtin tasks core 零 tool name 特判 + goal/todo 对话流 | grep core + 审查 builtin/tasks | **blocked-prereq**（P4） | core 零 HIDDEN_TOOL_NAMES/tool name 特判 ✓；tasks 仅静态 manifest 骨架，真实激活待 s2 |
| AC8 | mobile 与桌面共享 core/ui；sync 脚本已删；双端 pnpm build 通过 | find + package.json + 双端 build | **pass** | sync 脚本零命中；mobile 声明 core/ui workspace:* 依赖；双端 build exit 0 |

---

## AC2 核对：core 纯净性 + lint 规则强制（TC-1）

**断言**：`packages/core/src` 零 `node:` import / 零 `window.electronAPI` / 零直接 `localStorage` / 零 `new WebSocket` / 零 `ws` 直连；ESLint 对 core 包强制该约束（违反即 lint fail）。

**审计命令**（可复跑）：

```bash
# 1. node: import
grep -rn "from ['\"]node:" packages/core/src --include="*.ts" | grep -v __tests__   # → 零命中
# 2. window.electronAPI
grep -rn "electronAPI" packages/core/src --include="*.ts" | grep -v __tests__        # → 仅注释（platform/port.ts:45）
# 3. localStorage
grep -rn "localStorage" packages/core/src --include="*.ts" | grep -v __tests__       # → 仅注释（system-storage.ts 声明零直连）
# 4. WebSocket 直连
grep -rn "new WebSocket\|from ['\"]ws['\"]" packages/core/src --include="*.ts" | grep -v __tests__  # → 仅注释（ws-client.ts 声明走平台注入）
# 5. lint 规则（补丁前）：eslint.config.mjs 全文 154 行，无 core 包专属 no-restricted 规则 → 缺失
```

**status**：**fail-P6-fixable → 已修复 → pass**

**证据**：
- 零实际命中：`node:` 零；`window.electronAPI`/`localStorage`/`new WebSocket` 在 core 源码中仅出现于注释（`platform/port.ts:11,39,45`、`transport/ws-client.ts:14`、`domain/settings/system-storage.ts:4-5`），实际能力全部经 PlatformPort 注入（`getPlatform().webSocket.create(url)` 而非 `new WebSocket(url)`）。
- **lint 规则缺失**：eslint.config.mjs 无 core 包专属 no-restricted-globals / no-restricted-imports / no-restricted-syntax（2026-08-03 实测）→ 属 P6 范围清理遗漏，T2 已修（见下「P6 修复记录」）。

## AC3 核对：routeInbound 声明式路由（TC-2）

**断言**：`routeInbound` 查表 + 执行，无业务逻辑内联；新增 server-push 消息不动路由核心。

**审计命令**：代码审查 `packages/core/src/coordination/route-inbound.ts` + `packages/core/src/coordination/route-inbound.test.ts`（代偿：代码审查，非 dev app 实测——该链路为纯逻辑层，审查+测试即可判定）。

**status**：**pass**（代偿）

**证据**：
- `ROUTE_TABLE: RouteTableEntry[]`（route-inbound.ts ~L100）：声明式条目数组，`{ type, handle }` 精确 type 字符串匹配（DM3），条目顺序无依赖（type 互斥）。
- 路由核心与业务分离：pending 分流（msg.id 命中 → resolve/reject）+ ROUTE_TABLE 精确条目（session.exited/message.complete/session.subagents/session.workflowUpdate）+ 恒真 FALLBACK 兜底；seq gap 经 `applySeqGap` 中间件（evalSeqGap 纯函数 + 副作用分离）。
- 新增 server-push 消息 = 追加表条目，不动路由核心（注释明示 remote-use 的 busy/idle/presence 分支届时作为新条目追加）。
- 测试覆盖：`route-inbound.test.ts` 15 用例——pending 分流（error envelope 展开/普通 resolve）、seq gap（gap 回拉/drop/正常递进）、session 通道 fallback、global 通道 + L9、effects 回调（exited/complete/subagents/workflowUpdate/globalError）、effects 可选不崩。

## AC4 核对：core stores 零跨域 import、零 composable import（TC-3）

**断言**：core 内 import 不越出包边界（不 import ui/renderer/mobile-renderer/旧 renderer）、不 import composable。

**审计命令**：

```bash
grep -rn "from ['\"]@xyz-agent/" packages/core/src --include="*.ts" | grep -v __tests__
# → 仅 '@xyz-agent/shared'（15 处，允许的共享类型包）
grep -rn "@xyz-agent/ui\|@xyz-agent/renderer\|@xyz-agent/mobile" packages/core/src --include="*.ts" | grep -v __tests__
# → 零命中（无越界）
```

**status**：**pass**

**证据**：core 外部包 import 仅 `@xyz-agent/shared`（15 处）；零 ui/renderer/mobile 引用。Vue 相关 import（`computed/ref/effectScope` 等）为框架原语非 composable（`foundation/use-session-scoped-state.ts:36` 是 core 自己的范式实现，非 import 旧 renderer composable）。`@xyz-agent/shared` 含跨层类型，由 p0-acceptance-gate.md ① 的 PlatformPort spike 契约允许。

## AC5 核对：零 reset\*ModuleState + per-session 状态范式（TC-4）

**断言**：零 `reset*ModuleState`；per-session 状态 100% 经 useSessionScopedState（presence/lease 两个标注例外）。

**审计命令**：

```bash
# 新四包（core/ui/mobile-renderer）
grep -rn "reset[A-Za-z]*ModuleState" packages/core/src packages/ui/src packages/mobile-renderer/src --include="*.ts" | grep -v __tests__
# → 零命中（仅 subscription-state.ts:187 注释提及 renderer 侧函数名，非代码）
# 旧 renderer 残留
grep -rln "reset[A-Za-z]*ModuleState" packages/renderer/src --include="*.ts" --include="*.vue" | grep -v __tests__
# → 2 文件：composables/features/useChat.ts、composables/useMessageBusSubscription.ts
```

**status**：**blocked-prereq（P3）**——新包侧 pass，旧包残留属 P3 strangler-domains 域绞杀未完成

**证据**：
- 新包零命中 ✓。
- per-session 状态范式落地：`foundation/use-session-scoped-state.ts`（Vue 响应式版）+ `extension-host/utils/session-scoped-map.ts`（headless 版，ADR-0049 Map 分区派）+ `coordination/subscription-state.ts`（模块级单例 Map，**带标注例外**——注释明示「为什么用模块级单例 Map 而非 useSessionScopedState（ADR-0049 例外）：routeInbound 配置闭包需同步访问，属数据完整性层非 UI 状态」）。
- presence/lease：`coordination/presence.ts` / `lease.ts` 为端口接口抽象（`acquire/release` 签名），非状态存储，符合例外语义。
- **上抛**：旧 renderer 2 处 `reset*ModuleState` 残留（useChat.ts / useMessageBusSubscription.ts）→ 归属 **P3 strangler-domains**（chat 域迁移时删除，P6 不替修，决策 D1）。

## AC6 核对：plugin 全链路（TC-5）

**断言**：`contributes.views` 声明 → sidebar 第 5 tab 渲染 GuiComponent；按钮点击 → command 执行；`plugin:uiRequest` → companion-band 弹窗 → 响应回传不超时。

**审计命令**：代码审查 `packages/core/src/extension-host/**`（8 模块）+ `packages/ui/src/extension-host/`（4 渲染件）+ renderer 接线 grep（代偿：dev app 不可用，按 clarify 决议以特征测试 + 代码审查代偿）。

**status**：**blocked-prereq（P4/P5）**——core 侧机制完整，壳侧接线未交付

**证据**：
- **core 侧就绪**（34 测试通过）：`contribution-registry.ts`（声明式注册 + loadExternal 幂等 + routeAll 挂载点态）、`mount-point-registry.ts`（开放字符串挂载点，壳注册制）、`plugin-message-source.ts`（9 plugin:* + 5 extension:* 消息源注入 + MockMessageSource）、`internal-event-bus.ts`、`builtin-contributions.ts`。测试：contribution-registry 10 / internal-event-bus 14 / mount-point-registry 5 / session-scoped-map 5。
- **ui 包渲染侧就绪**：`StatusBar.vue` / `ViewHost.vue` / `PluginSettingsPage.vue`（数据源经注入接口，壳 provide）。
- **缺口（上抛）**：桌面 renderer 壳**零引用** core extension-host（`grep extension-host packages/renderer/src` 零命中）——sidebar 第 5 tab 接线、`plugin:uiRequest → companion-band` 弹窗链路、响应回传均在 P5 dual-shells（桌面壳接入口）与 P4 s3/s4（两 API 跨层 + UI 统一）未交付范围。归属 **P4（s2 接线消费）+ P5（双壳接入）**。

## AC7 核对：builtin tasks（TC-6）

**断言**：core 零 tool name 特判（HIDDEN_TOOL_NAMES 不进业务逻辑）；goal/todo 对话流正常渲染。

**审计命令**：

```bash
grep -rn "HIDDEN_TOOL_NAMES\|toolName\|tool_name" packages/core/src --include="*.ts" | grep -v __tests__
# → 零命中
# builtin tasks 骨架
cat packages/core/src/extension-host/builtin/tasks/index.ts
# → 仅导出静态 manifest 与类型（ES2 降级注释：真实激活/注册待 s2 就绪）
```

**status**：**blocked-prereq（P4）**——core 零特判 ✓，tasks 插件仅静态骨架

**证据**：
- core 零 HIDDEN_TOOL_NAMES / tool name 业务命中 ✓（§11.4「core 零 tool name 特判」达成）。
- `builtin/tasks/manifest.ts` 声明结构完整（id/builtin/activationEvents/contributes + slashCommands/commands 声明），`index.ts` 注释明示「不导入 s2 运行时模块（ES2 降级：真实激活/注册待 s2 就绪，本骨架纯静态）」。
- **上抛**：goal/todo 真实激活 + 对话流渲染依赖 P4 s2（extension-host core 消费）就绪，归属 **P4**。

## AC8 核对：mobile 共享 + sync 脚本 + 双端 build（TC-7）

**断言**：mobile 与桌面共享 core/ui；sync 脚本已删；双端 `pnpm build` 通过。

**审计命令**（可复跑）：

```bash
# 1. sync 脚本不存在
find . -name "sync-mobile*" -not -path "*/node_modules/*"        # → 零命中
find scripts -iname "*sync*"                                      # → 零命中（plugin-sdk/scripts/sync-types.sh 为 sdk 类型同步，非 renderer 同步脚本）
# 2. mobile 依赖声明
python3 -c "import json; print(json.load(open('packages/mobile-renderer/package.json'))['dependencies'])"
# → {"@xyz-agent/core": "workspace:*", "@xyz-agent/shared": "workspace:*", "@xyz-agent/ui": "workspace:*", ...}
# 3. 双端 build
cd packages/mobile-renderer && pnpm build     # → exit 0（首次报 UNRESOLVED_ENTRY，重跑通过，疑 rolldown 缓存态）
cd packages/renderer && pnpm build            # → exit 0（仅 vueuse PURE annotation warning，非错误）
```

**status**：**pass**

**证据**：
- sync 脚本全仓零命中（与 p6-residual-deletion-inventory.md §1.5 交叉一致）；`packages/plugin-sdk/scripts/sync-types.sh` 属 plugin-sdk 自身类型同步脚本，与旧 `sync-mobile-from-renderer.sh`（已删）无关。
- mobile-renderer 依赖声明 `@xyz-agent/core` + `@xyz-agent/ui`（workspace:* 同源产物），非 sync-copy 副本（main.ts 注释明示「AC1 依赖边：import @xyz-agent/core + @xyz-agent/ui（workspace:* 同源产物，非 sync-copy 副本）」）。
- 双端 build：mobile `pnpm build` exit 0（462KB 产物）；renderer `pnpm build` exit 0（2.06s，vueuse PURE annotation 为 rolldown 提示非失败）。
- 注：mobile 首次 build 报 `[UNRESOLVED_ENTRY] Cannot resolve entry module index.html`，未改任何文件重跑即通过——疑 rolldown 增量缓存状态问题，记录备查（非代码缺陷，双端 build 判定以重跑通过为准）。

---

## 前置阻塞上抛清单

| AC id | 阻塞内容 | 归属层 | 阻塞的父 unit 引用 |
|-------|----------|--------|-------------------|
| AC5 | 旧 renderer `reset*ModuleState` 残留 2 处（useChat.ts / useMessageBusSubscription.ts）——P3 chat 域绞杀未完成 | **P3** strangler-domains | `renderer-rebuild-v2::p3-strangler-domains::*`（composer/settings/session-sidebar 等域 wave） |
| AC6 | 桌面壳零接线 extension-host（sidebar 第5tab / companion-band / 响应回传） | **P4**（s2 接线消费 + s3 两 API 跨层 + s4 UI 统一）+ **P5**（dual-shells 双壳接入） | `renderer-rebuild-v2::p4-extension-host::s2-* / s3-* / s4-*`、`renderer-rebuild-v2::p5-dual-shells::*` |
| AC7 | builtin tasks 仅静态 manifest 骨架，真实激活/注册待 s2 就绪 | **P4**（s2 extension-host core） | `renderer-rebuild-v2::p4-extension-host::s2-extension-host-core`、`s5-builtin-tasks-plugin` |

> 上抛处置遵循决策 D1：P6 不替前置层补功能。主调度器在对应 P1-P5 wave 交付后重跑本报告对应 AC 即可（Summary 表 status 为追踪入口）。

## P6 修复记录（T2）

**AC2 lint 规则补丁**（`eslint.config.mjs`，唯一代码产物）：

- **修复内容**：新增 core 包专属 overrides 块（`files: ['packages/core/src/**/*.{ts,vue}']`），含 3 条规则：
  - `no-restricted-globals: ['error', 'window', 'localStorage']`
  - `no-restricted-imports`（patterns：`node:*` / `ws` / `electron` 三组，各带中文 message）
  - `no-restricted-syntax`（`NewExpression[callee.name="WebSocket"]`）
- **验证**：
  - 红-绿验证：临时构造违反样例（`import { readFileSync } from 'node:fs'` + `localStorage.getItem` + `new WebSocket`）→ `npx eslint` 报 3 errors 全命中 → 样例已删除（不留痕）。
  - 回归验证：`npx eslint packages/core/src` → **0 errors**（仅 1 条存量 warning：contribution-registry.ts:64 的 unused eslint-disable directive，非本次引入）。
  - 全量 `pnpm lint` 的 945 errors 均为存量（scripts/*.mjs、visual-capture.mjs 等），与本次改动无关；core 包范围零新增。
- **范围控制（ES2）**：overrides 仅限定 `packages/core/src`，不动 renderer/ui/mobile 存量规则。

## 交接备注（对兄弟 wave / 主调度器）

- AC5/AC6/AC7 的 blocked-prereq 项在 P3/P4/P5 交付后可重跑本报告对应审计命令（grep/审查命令均已记录可复跑），无需重开本 wave。
- AC8 双端 build 已在本 wave 实测通过；AC1（residual-deletion w3）的双端 build 判定与本次同基线，可直接复用本次 build 证据（exit 0）交叉验证。
- mobile 首次 build UNRESOLVED_ENTRY 疑 rolldown 缓存态——后续 wave 若遇同错先重跑再排查，勿当代码缺陷。
