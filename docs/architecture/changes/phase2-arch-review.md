# Phase 2 + 2.5 架构审查报告

**审查对象**:commit `1fc919c1`(runtime 分层)+ `29b0622a`(main spawn 去重)
**审查依据**:design.md D4/D7/M1/M2/M3 + phase-2/2.5 plan + round-2/3 既知问题
**方法**:只读核对(import grep / tsc / 产物验证),不改代码

---

## 1. 审查范围

| 层 | 文件数 | 清单(抽查标 *) |
|----|-------|----------------|
| `transport/` | 7 | server.ts*, 6 个 *-message-handler.ts, bridge-handler.ts |
| `adapters/` | 8 | event-adapter.ts*, message-converter.ts*, pi-config-bridge.ts*, navigate-interceptor, pi-paths/provider-store, session-file-utils/tree-reader |
| `infra/` | 8 | rpc-client.ts*, process-manager.ts, npm-installer, extension-resolver, scanner-base/skill/agent, **trash.ts** |
| `services/` | 8 | session/config/model/tree + **extension-service/extension-timeout-manager(补迁)**, git-info, session-history |
| `services/plugin-service/` | 21 | 切片完整保留 |
| 根 | 3 | index.ts*, interfaces.ts*, types.ts |
| main | 3 | main.ts*, runtime-manager.ts*(+startAndNotify), test/main-start-and-notify.test.ts* |

计数与 spec/plan 完全一致;`utils/path-utils.ts`、`plugins/demo/` 按计划未动。

---

## 2. Checklist 结果

### ① D4 四层分类 — ✅(分类全对)
逐文件核对:transport 全是路由/传输;adapters 全是 pi 格式翻译;infra 全是外部系统连接器;services 是业务。**trash.ts 归 infra 合理**——只被 `session-service.ts:27 import { trash } from '../infra/trash.js'` 引用,是 OS 删除原语(`execSync('trash'/'osascript')`),services→infra 正向。无文件归错层。

### ② Import 正确性 — ⚠️→🔴(发现 1 处类型层断裂)
- 跨层方向:transport→services/adapters ✅;services→adapters/infra ✅;adapters→infra(type-only)✅;**services/transport 无逆向** ✅
- **type-only import 路径正确**:`interfaces.ts:19 import type { PiEventListener } from './infra/rpc-client.js'` ✅(plan 担心的隐蔽陷阱此处已规避)
- **🔴 `event-adapter.ts:54` inline import 路径漏改**(见问题 #1)
- `tsc --noEmit` **exit 2**,唯一错误即 #1
- bundle 产物存在(`index.cjs` 791KB + `plugin-bootstrap.cjs` 23KB),运行时验证(vitest 598/598)通过——**运行时绿掩盖了类型层红**,正是 checklist 点名的陷阱

### ③ D7 命名彻底性 — ⚠️(class 干净,注释残留)
- `SidecarServer`→`RuntimeServer` 类名+构造+注释**彻底重命名** ✅(`rg SidecarServer src-electron/` 零命中)
- 但 `rg -ni sidecar` 仍命中 **9 个文件**(全为注释/常量,非 class):`protocol.ts:1,166`、`main.ts:182`、`runtime-manager.ts:275`、`tsup.config.ts:35`、`plugin-types.ts:7`、`stores/plugin.ts:16`、`process-manager.ts:21`、2 个 test 文件(`SIDECAR_RESTART_TOOLS` 常量等)。违反 D7「挪目录须同时正注释」。

### ④ M1 spawn 去重 — ✅(无瑕疵)
- `runtime-manager.ts:269-277 startAndNotify(win)`:start→send port→catch→send runtime-error,封装正确 ✅
- `main.ts` whenReady(:154)与 activate(:178)**两处都改调** `startAndNotify(mainWindow)` ✅
- **XYZ_MOCK 分支两处保留**(whenReady `=== '1'` 跳过、activate `!== '1'` 才调,语义一致)✅
- **幂等**:`start()` 首行 `await this.stop()` 再 spawn(:221),activate 重启复用此语义 ✅
- 测试 3 case(成功/失败/幂等)用 `vi.mock('electron')`+`vi.spyOn(rm,'start')` 隔离,覆盖到位 ✅

### ⑤ tsup bundle 完整性 — ✅
- `entry: { index, 'plugin-bootstrap' }` 2 entry 正确;`bundle:true` 跟随 index.ts import 链 ✅
- **noExternal 与 dependencies 完全一致**:`deps=[ws,semver,fast-glob,tar]` ≡ `noExternal=[ws,semver,fast-glob,tar]` ✅(CLAUDE.md #12)
- plugin-bootstrap 路径 `src/services/plugin-service/plugin-bootstrap.ts` 正确(切片内未迁移)✅

### ⑥ index.ts 组合根 — ✅
3-Phase 线性构造保留:Phase1 无依赖实例 → Phase2 带闭包依赖 → Phase3 wire 跨服务(`setSessionService`/`setServices`)。hook 注入保持。import 路径全部更新到新位置。

---

## 3. 问题清单

### 🔴 必改(1)

**#1 event-adapter.ts:54 inline import 路径漏改**
`src/adapters/event-adapter.ts:54`:
```ts
Promise<import('./services/plugin-service/plugin-types.js').HookResult>
```
文件从 `src/` mv 到 `src/adapters/` 后,相对路径应为 `../services/...`(多一层 `..`)。其余 inline import(server.ts:38 用 `../services/`、interfaces.ts 在根用 `./services/`)均正确,**仅此一处漏改**。
- 证据:`tsc --noEmit` exit 2,`error TS2307: Cannot find module './services/plugin-service/plugin-types.js'`
- 为何测试没拦:esbuild/vitest 擦除类型表达式,运行时不解析;validate-runtime-bundle.sh 是运行时 smoke test,不做类型检查。**plan-round-2/3 反复警告的「build 过≠类型层正确」命中实例**
- 修复:`./services/` → `../services/`(1 字符改动)

### 🟡 应改(2)

**#2 infra→adapters 逆向依赖(违反 D4 依赖方向铁律)**
`infra/rpc-client.ts`、`infra/extension-resolver.ts` 均 `import { getPiAgentDir, getDefaultModel, getSessionsDir } from '../adapters/pi-config-bridge.js'`。spec D4 明定「infra 对上层一无所知;adapters 依赖 infra」。根因:`pi-config-bridge.ts` 混合两类职责——(a) 纯路径函数 `getConfigDir/getPiAgentDir/getSessionsDir`(语义属 infra「路径约定」)、(b) pi 配置翻译(真防腐层)。强行整体归 adapters 导致 infra 为 (a) 反向依赖。运行期无环(pi-config-bridge 不回 import infra),但方向违规。
- 性质:既有架构债被 mv 暴露,非 phase-2 引入
- 修复方向(长期):把纯路径函数拆到 `infra/pi-paths.ts`,pi-config-bridge 改 re-export 或只留翻译;或纳入 phase-3 scope

**#3 D7 命名残留(9 处注释/常量)**
见 checklist ③。class 已干净,但注释/文档/测试常量未清。spec D7 原则:「只换皮不治本」即指此。
- 修复:批量 sed `sidecar`→`runtime`(注释)、`SIDECAR_RESTART_TOOLS`→`RUNTIME_RESTART_TOOLS`;protocol.ts:1,166 注释归属 phase-2 task3 遗漏

### 🟢 建议(3,均既有债)

**#4** `session-service.ts`/`tree-service.ts` 仍 `import type { PiMessage } from '../infra/rpc-client.js'`——pi 类型泄漏到 service 层。round-3 P5 已知,adapters 防腐是目标态,phase-2 不解决,phase-3 拆 session-service 时一并处理。

**#5** `index.ts:13 import { PluginRegistry }` 直接 import 切片内模块,绕过 `IPluginService` Facade。与 D5「只有 IPluginService 越界」表述有张力,但组合根 DI 是正当需求(D5 表述偏严)。记录,不动。

**#6** `server.ts:38` transport 直接 `import { getPiAgentDir } from '../adapters/pi-config-bridge'`(file.read 白名单用)。transport→adapters 跨层跳过 services,既有代码,轻微。与 #2 同源,拆 pi-paths 后自然消解。

---

## 4. 结论

**整体评分:7/10**

- 加分:M1 spawn 去重近乎完美(封装/幂等/mock 测试/双分支保留全对);D4 文件分类零错位;bundle 配置与 dependencies 严格对齐;index.ts 组合根 3-Phase 构造保持;trash.ts 归位准确
- 扣分:**#1 是 plan 反复警告的隐蔽陷阱的真实命中**——tsc 失败却被运行时测试掩盖,暴露 phase-2 验证链缺 `tsc --noEmit` 环节;#2 是被 mv 显化的架构层逆向依赖

**是否可进入 Phase 3**:**修掉 #1(1 行改动)后可进入**。#2 建议纳入 phase-3 一并处理(拆 session-service 时顺手把 pi-paths 下沉到 infra)。#3 可独立小 commit 顺手清。Phase 3 前建议在 pre-commit 或 CI 补一道 `tsc --noEmit`,堵住「运行时绿、类型层红」的盲区——这是本轮最该吸取的工程教训。
