# 对抗式审查报告：timeout-plugin-service-granularity.md（Doc 3）

> 审查人：主 agent（代 tech-design-review——原定审查 subagent 两轮均被环境杀死，写作/审查分离临时让渡；本文档作者为独立 subagent，非审查人）
> 依据：rubric-design-doc.md + AGENTS.md 规则 16/17/19 + 源码实读核实。审查日期 2026-09-04（v1）。

## Summary

**2 must-fix, 2 suggestions, 2 info。**

文档质量显著高于均值：v2 自修订已吸收双层竞速（Worker 侧单一计时权威 + cancel 通知 + 防泄漏兜底，含串行排队反例重演与被否谱系）；对抗攻击 10+ 处事实声明（ui-api 五方法不传参 / client 30s 发起即挂 / activator resolve(false) 链 / Worker loadPlugin 仅 reject / handleWorkerCrash 存在 / bridge-interop 30s isError / invoke 必传 / dialog-queue 30min 先例 / syncFrom 存完整 schema）逐一实读核实**全部命中**；「D1 声明值传播链」与「30min 上界归属论证」两个最强攻击面均被文档自身的证据链挡住（syncFrom 存完整 ToolEntry，getSyncPayload 塑形只影响 pi 侧负载——无矛盾）。两处 MUST_FIX 集中在：**新引入机制的碰撞面未设计（requestId 生成权移交）**与**验收环境可行性（pi CLI 无 runtime 时 bridge 工具无被调方）**。

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §6.2 D2 第 2 条（requestId 生成权移到 Worker 侧） | P0-12 副作用/遗漏 | **Worker 侧生成 requestId 的跨 Worker/跨插件碰撞面未设计**。现状 queue（宿主单点）生成 id 天然全局唯一；移交 Worker 侧后：① 共享 Worker（≤10 插件同一线程同一 rpcClient）内两插件并发出 UI 请求，各自 ui-api 生成的 id 可能碰撞（PendingTracker 按 id 键控）→ cancel 通知误删他方 pending → 错撤他人弹窗；② 多 Worker 场景同理。取消语义（本决策核心）的 correctness 依赖 id 全局唯一，文档未指定生成规则 | 指定唯一性规则：`workerId` 前缀或 UUID（对齐既有 id 生成惯例），写入 D2-2 采用段；验收 V4 补「双插件并发弹窗 + 其一超时取消，另一不受影响」断言 |
| MUST_FIX | §9 V1/V2 + §8 P-8（验收环境） | P0-14 可执行性 | **「本地 pi CLI --extension <bridge>」验收环境大概率不可行**：实装核实 `bridge:sync`/`bridge:tool_execute` 是 runtime WS 命令（`transport/bridge-handler.ts:28-37`，转发 pluginService）——pi 侧 bridge 消费方经 relay WS 到 runtime；纯本地 pi CLI 无 xyz runtime 时，bridge 工具清单为空、tool_execute 无被调方，V1/V2/P-8 按字面无法执行。AGENTS.md「extension 优先 pi CLI 实测」纪律针对 pi extension 本体；plugin-service 是 runtime 子系统，该纪律不直接适用 | V1/V2/P-8 环境重述为：`pnpm dev`（runtime + pi spawn 全链）或「standalone 启动 runtime + 以 relay env 手动拉起 pi CLI」二选一，写明 relay env 接线点；保留「真实 pi + 真实插件 + 真实前端」的实质要求不变 |
| SUGGESTION | §7 错误规格表 + §6.4 D4 | P1-3 UX 完整性 | command 抬 30min 后的**重复触发行为未登记**：现状并发守卫拒绝重复执行（普查已录）——30min 窗口把「点了没反应再点被拒」的 UX 面放大 180 倍；用户视角需要「正在执行中」的可见反馈与取消出路 | 错误规格表补一行：重复触发 → busy 提示（含已等待时长）；登记「命令可取消/进度反馈」为 renderer 联动排期项（对齐 U8 模式） |
| SUGGESTION | §6.2 D2 第 3 条 + §7 ui-request-queue 行 | P1-8 一致性 | D2 采用段第 3 条写「rpcClient.notify('plugin.ui.uiRequestExpired')」而 §7 改动地图同位置写「expired 广播回调注入」——通知方法命名（`plugin.ui.uiRequestExpired`）与广播事件名（`plugin:uiRequestExpired`）两套命名并存，实施者易混（Worker→host notify 与 host→renderer broadcast 是两条不同通路，文档区分了通路但未给命名对齐规则） | 统一命名约定：Worker→host notify 用 `plugin.ui.*`（RPC 域），host→renderer broadcast 用 `plugin:*Expired`（ServerMessageMap 域），并在 D2 加一句命名规则说明 |
| INFO | §6.1 D1 证据（声明值传播链） | 攻击未击穿记录 | 审查以「getSyncPayload 只塑形三字段 → 裁决点读不到 timeoutMs」为攻击点，实读 `bridge-interop.ts:71-79` 证伪：`syncFrom` 存的是完整 `ToolEntry`（含全量 schema），`entriesByName` 路由的正是完整 entry——`getSyncPayload` 的塑形只影响发往 pi 的负载，runtime 裁决点本地可读。文档证据链成立。建议：把「syncFrom 存完整 entry（:71-75）」在证据句中明示为传播链承重环节（现文「缓存层整体同步 schema」已对但可更直白） | （可选）证据句补半句 |
| INFO | 全文 | P0 通过项 | 五段骨架/SCQA/结论先行 ✓；每决策 ≥3 方案+被否反演+反例重演（D2 v1 被击穿方案入谱系是范本）✓；验收 6 场景全真实+回溯目标 ✓；探针 ✅7+⛔5 全带降级 ✓；被否谱系/回写义务/量级依据（dialog 30min + SPAWN_WATCHDOG_FLOOR 双先例）✓；行号抽查全命中 | — |

## 判定四态（P0 摘要）

| 检查项 | 判定 |
|---|---|
| P0-1~9（骨架/delta/结论先行/问题定义/视角/术语/方案对比三维/因果） | 通过 |
| P0-10 解决目标问题 | 通过（D1-D6 与 §4.4 裁定框架逐点对齐；workflow/worker 碰撞面属 P0-12） |
| P0-11 关键事实 | 通过（10+ 处实读全命中；无「声明 vs 源码」断裂） |
| P0-12 副作用/遗漏 | **不通过（requestId 碰撞面）** |
| P0-13/15 验收存在/投入 | 通过（6 场景/大改动） |
| P0-14 验收真实可执行 | **不通过（V1/V2/P-8 环境可行性）** |
| P0-16 探针 | 通过（⛔ 带降级） |
| P0-17/18 数据流图/恢复指引 | 通过 |
