# P0 验收门（gate 记录）— renderer-rebuild v2

> **上游依据**：[renderer-rebuild-architecture.md](../../renderer-rebuild-architecture.md) §11.1（P0 验收门三项定义）+ §11.0（P0 开工前 4 项架构决策）+ §11.2（逐域绞杀主线）
> **定位**：进入 P1 的 gate 记录——单一时间点的三项状态快照（2026-08-03）。三项原始证据文档各自独立（spike 测试文件 / core 测试文件 / spike planning 产物），本文档只做汇总与对照，不重复证据。
> **性质**：本 gate 记录的是「此刻」的状态。①② 实证在手判定通过；③ 实证待并行 spike 单元落地，如实标注在途（pending），不虚报全绿。

---

## §11.1 验收门原文引用

> 【P0 验收门：① PlatformPort spike 3 项全过 ② PoC 特征测试（3-5 个）在新 core 上跑通 ③ 新旧共存接缝机制（构建 flag / 双入口按域灰度）spike 验证通过 → **三项全绿才进入全量推进**】

§11.1 同时约束 P0 前置条件（§11.0 的 4 项架构决策）——其中「状态管理 DOM 耦合审计」「路由决策」「bootstrap 时序链」「ws-client 不变量定义」已由兄弟 wave 落地（`dom-coupling-audit.md` / `routing-decision.md` / `ws-client-invariants.md` + `packages/core/src/bootstrap.ts`）。

## §11.1 验收门对照表

| # | 验收门定义（原文摘录） | 状态 | 证据引用 |
|---|------------------------|------|----------|
| ① | PlatformPort spike 3 项全过 | **通过** | `packages/renderer/src/__spikes__/platform-port/`（实测 16 passed） |
| ② | PoC 特征测试（3-5 个）在新 core 上跑通 | **通过** | `packages/core/src/__tests__/bootstrap.test.ts`（5 passed）+ `packages/core/src/transport/__tests__/ws-client.invariants.test.ts`（15 it.todo 声明） |
| ③ | 新旧共存接缝机制（构建 flag / 双入口按域灰度）spike 验证通过 | **在途（pending）** | `.cw/recursive-root-p0-foundation-spike-coexistence-seam-spike/plan.json`（方案对比 + 推荐 A；实证待 execute） |

---

## ① PlatformPort spike（结论：通过）

**验收门定义**：PlatformPort spike 3 项全过（§11.1）——即 §9「平台适配层 PlatformPort」的 3 核心端口抽象在测试注入下成立。

**实证**：
- 引用路径：`packages/renderer/src/__spikes__/platform-port/port.ts`（接口定义 + `providePlatform` fail-fast + `createMockPlatform`）+ `port.test.ts`（16 用例）
- 3 端口覆盖：`KVStorage`（异步键值，get 不存在返回 null，set/remove 降级吞错）/ `WebSocketLike` + `WebSocketFactory`（DOM WebSocket 子集，4 状态常量）/ `ipc`（electronAPI 桥接，mock 默认 null）
- fail-fast：`getPlatform()` 未注入前调用抛错（`/not provided/i`）；`providePlatform(createMockPlatform())` 后返回 mock 实例；overrides 局部替换生效

**实测命令与结果**（2026-08-03）：

```bash
cd packages/renderer && npx vitest run src/__spikes__/platform-port/port.test.ts
# Test Files  1 passed (1)
#      Tests  16 passed (16)
```

**对照结论**：3 端口抽象 + 平台注入 fail-fast + mock 工厂全部有测试实证（16 passed），验收门 ① 达成。§11.0-4「ws-client 不变量定义」的配套修正（「特征测试覆盖的关键行为不变」）已落地为 ② 章节的 invariants 文件，不阻塞本项。

---

## ② 特征测试 PoC（结论：通过）

**验收门定义**：PoC 特征测试（3-5 个）在新 core 上跑通（§11.1）——即 §11.3 测试策略的特征测试在 `packages/core`（新 core 骨架）上真实执行。

**实证**：
- 引用路径 A：`packages/core/src/__tests__/bootstrap.test.ts` — 5 passed，覆盖 §11.0-3 bootstrap 时序链：
  - AC6：五步显式 await 编排，严格顺序 `[providePlatform, initConnection, restoreSessions, registerMountPoints, scanContributions]`
  - ES1：任一步 reject 中断后续步骤（4 个中断用例）
- 引用路径 B：`packages/core/src/transport/__tests__/ws-client.invariants.test.ts` — 15 it.todo，5 组不变量声明（连接状态机 / auth 握手 / close code 分流 / seq 回放 / 重连退避），断言点规格见 `docs/architecture/renderer-rebuild/ws-client-invariants.md`

**实测命令与结果**（2026-08-03）：

```bash
cd packages/core && npx vitest run
# Test Files  1 passed | 1 skipped (2)
#      Tests  5 passed | 15 todo (20)
```

**对照结论**：特征测试 PoC 在新 core 上跑通（5 passed 真实执行；15 todo 为 P1 ws-client 迁入后按 invariants 规格替换为真实断言的声明清单，todo 非失败），验收门 ② 达成。

---

## ③ 新旧共存接缝 spike（结论：方案已锁定，实证在途）

**验收门定义**：新旧共存接缝机制（构建 flag / 双入口按域灰度）spike 验证达成（§11.1 验收门 ③，原文见上文引用）——接缝机制支撑 §11.2 逐域绞杀主线（「切换期新壳已接入口、旧 renderer 仍持有未迁移域」）。

### 方案对比（引用 spike planning 产物）

来源：`.cw/recursive-root-p0-foundation-spike-coexistence-seam-spike/plan.json`（techChoices TC1/TC2/TC3）：

| 维度 | 方案 A：构建 flag（vite define） | 方案 B：双入口隔离 |
|------|----------------------------------|--------------------|
| 机制 | vite define 编译期常量替换 + `process.env.NEW_ARCH` 构建期开关，`globalThis.__NEW_ARCH__` 消费 | 独立 vite config + 独立 outDir + 独立 main 入口文件（`dist/main` vs `dist/main-new`） |
| 扰动面 | 最小（1 处 define + 1 处 loadFile 分支 + 源码 import 分支） | 两套完全隔离的构建链 |
| 域级灰度（§11.2 逐域绞杀） | 天然支持（每域模块 import 按 flag 分支，同一机制的域级延伸） | 需额外运行时路由层 |
| CI 影响 | 单次构建 | 构建次数翻倍 |
| 新增机制 | 零（复用现有 `__APP_VERSION__` define 模式） | 独立 config 文件 |

### 推荐结论（引用 spike planning TC1）

**推荐方案 A（vite define 构建 flag）**。理由（plan.json TC1 rationale 摘录）：define 是 vite 原生编译期常量替换，与现有 vite.config.ts 已有的 `__APP_VERSION__` / `globalThis.__E2E_SAMPLE_PROJECT_CWD__` 模式完全一致（零新机制）；扰动面最小且天然支持域级灰度；安全默认（未设 flag = 现状行为零变化，ES1）。

### 实证设计引用（IF1 协议 + 验证点）

- **IF1 共存 flag 协议**（`.cw/recursive-root-p0-foundation-spike-coexistence-seam-spike/plan.json` interfaces IF1）：构建期注入、运行期只读；flag=true 走新壳入口，flag=false/未注入 fallback 旧 renderer；三处消费点必须读同一 flag 源（`process.env.NEW_ARCH`），否则 main loadFile 的 renderer 与 renderer 自认架构不一致 → 白屏。
- **验证点**（flag-mechanism-spike wave plan testCases TC1-TC3）：
  - TC1：`resolveRendererEntry('1')==='renderer/dist-new/index.html'`，其余 ==='renderer/dist/index.html'
  - TC2：构建期 define 烘焙 flag 值（manifest-off.bakedFlagValue===false && manifest-on.bakedFlagValue===true）+ dist-new 占位存在（全流程集成）
  - TC3：ES1 安全默认——无业务模块消费 `__NEW_ARCH__`（consumerCount===0），未设 flag 时 build 行为零变化
- **涉及文件（7）**：`packages/renderer/vite.config.ts` / `apps/electron/main/window/resolve-renderer-entry.ts` / `apps/electron/main/window/window-factory.ts` / `apps/electron/renderer/dist-new/index.html` / `scripts/verify-coexistence-flag.mjs` / `apps/electron/main/test/resolve-renderer-entry.test.ts` / `package.json`

### 实证状态：pending（如实标注）

**spike execute 尚未落地**。`coexistence-seam-spike` 单元当前处于 clarifying（`.cw/recursive-root-p0-foundation-spike-coexistence-seam-spike/` 仅有 clarify/design-review/plan 产物，无 execute），其 comparison-report wave（产出对比报告）依赖 flag-mechanism-spike + dual-entry-spike 两个 execute wave 先行落地。

**缺失物证清单**（grep/find 复核 2026-08-03，全部不存在）：
- [ ] `scripts/verify-coexistence-flag.mjs`（TC3 实证脚本）
- [ ] `apps/electron/main/window/resolve-renderer-entry.ts`（TC1 入口分支纯函数）
- [ ] `packages/renderer/vite.config.ts` 中的 `__NEW_ARCH__` define 注入（TC2 烘焙）
- [ ] `apps/electron/renderer/dist-new/index.html` 占位（TC2 dist-new）
- [ ] `docs/architecture/coexistence-spike-manifests/`（DM1 四份 manifest 快照）
- [ ] `docs/architecture/coexistence-seam-spike-report.md`（comparison-report 交付物）

**报告路径占位**：对比报告 + 扰动面矩阵（DM2）落地于 `docs/architecture/coexistence-seam-spike-report.md`（待 spike comparison-report wave 产出，引用即生效）。

---

## Gate 判定

| 项 | 状态 | 依据 |
|----|------|------|
| ① PlatformPort spike | **通过** | 实测 16 passed（`packages/renderer/src/__spikes__/platform-port/port.test.ts`） |
| ② 特征测试 PoC | **通过** | 实测 5 passed | 15 todo（`packages/core` vitest） |
| ③ 共存接缝 spike | **在途（pending）** | 方案对比 + 推荐 A 已锁定（spike planning 产物）；实证待 coexistence-seam-spike 单元 execute 落地 |

**P1 进入条件**：③ 实证落地后**三项全绿**（§11.1 原文「三项全绿才进入全量推进」）→ 方可进入 P1 T&C 迁移（transport + coordination 全量，从 remote-use 代码迁）。

**gate 记录声明**：本文档作为进入 P1 的 gate 记录沉淀于 `docs/architecture/renderer-rebuild/`。①② 的实证引用随代码库演进保持可复核（测试文件 + 实测命令即证据）；③ 的状态在本文档快照时刻为在途，spike 完成后的最终判定以 `coexistence-seam-spike-report.md` + 本表 ③ 行更新为准。
