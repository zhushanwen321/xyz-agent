# V1-V8 全局验收场景 dev 实测记录

> **验收日期**：2026-08-16（14:51-17:16，两段会话接力完成：前段 14:51-16:40 完成部分场景并留截图，runtime 意外中断；后段 16:43-17:16 完成全部场景实测与本文档）
> **环境**：dev 模式（`pnpm dev`），Electron renderer `localhost:9222` / vite `localhost:1420` / runtime `localhost:3310`（tsx 源码直跑）/ 数据目录 `~/.xyz-agent-dev/`
> **模型**：`xiaomi-token-plan-cn/mimo-v2.5-pro`（真实流式）
> **探针**：Playwright over CDP（`browser-automation` skill 的 `pw.js`）evaluate 注入 `performance.now()` + `requestAnimationFrame` 双帧检测；截图存 `dev-acceptance-assets/`
> **结论总表**：

| 场景 | 结论 | 关键实测数据 |
|---|---|---|
| V1 长对话流式 | **通过** | 流式输出期 ~37s 连续采样 60fps（p99 17.7ms / max 17.8ms / 零 >100ms 长任务）；流式期间滚动响应 19-39ms |
| V2 大仓库交互 | **通过** | 目录展开首帧 33.4-67.6ms（三层目录）；过滤 'store' 333ms（含 200ms 设计 debounce）；composer `#` 候选 626ms |
| V3 终端高频输出 | **通过** | 2000 行输出全程 29.2s 采样 60fps / 零 >100ms；切走切回历史完整 |
| V4 启动与首屏 | **通过**（产物引用既有硬证据 + 本轮 runtime 日志） | runtime listen 即就绪 total=20.2ms（后台异步 561ms 不阻塞）；build 产物 entry gzip **75.2KB**（基线 684KB，降 89%） |
| V5 AI 写文件链路 | **通过** | AI 创建 2 文件 → file_changes ready 后 **302ms** 树角标刷新（P-D9-2/P-D9-3 探针实测）；写文件时窗无 git 异常日志 |
| V6 插件 hook | **未测（dev 环境技术不可行，根因已定位）** | sandbox Worker fork 报 `ERR_MODULE_NOT_FOUND: plugin-bootstrap.js`（dev tsx 模式无编译产物）→ 插件无法激活；hook 语义由 8 个测试文件背书 |
| V7 长 session 切回 | **部分通过（口径如实）** | 切回 81ms/115ms（零请求路径）；冷加载 2253ms；「驱逐重进」路径两轮构造未触发（如实记录）；日志有 `cache fresh (empty delta)` since 机制运行证据 |
| V8 断线重连 | **通过（两轮实证）** | SIGTERM → 90s supervisor 重启 → **ready 后 0.4s** renderer 重连 → state 快照恢复（消息数一致、无重复、无断线横幅） |

---

## V1 长对话流式 — 通过

**步骤**：
1. 新建 session，向 MiMo-V2.5-Pro 发送「生成约 400 行 TypeScript 工具库（单 markdown 代码块）」
2. 发送前启动 `requestAnimationFrame` 采样器（evaluate 注入，双 rAF 帧检测）
3. 流式输出期间每 2.4-3s 对 `.message-stream` 容器执行一次 400px 向上滚动，测滚动应用耗时
4. 第二轮发送「再输出约 250 行测试文件」，发送瞬间重启采样器再采 15s

**实测数据**：
- 第一轮：15s 主采样 + 10s 容器探测 + 12s 补采样 ≈ 37s 连续覆盖流式输出期（消息流最终 9099px / 上下文 48.4K token / 代码块完整）
- 两轮合计：60fps，avg 16.7ms / p95 17.6ms / **p99 17.7ms / max 17.8ms / >100ms 长任务 0 次**（730 帧 + 910 帧两个采样窗口）
- 流式期间滚动交互：5 轮滚动应用耗时 19.1-39.1ms（即时生效，无可感知卡顿）
- 验收标准 ≥55fps → 实测 60fps **通过**

**未覆盖项**（如实声明）：「runtime CPU 较基线显著下降」无优化前版本对照，未测；单序列化（双序列化消除）由 W09/W21 确定性测试背书。

**证据**：截图 `v1-streaming-final.png`（48.4K 上下文 + 代码块渲染态）；evaluate 输出见本文数据段。

## V2 大仓库交互 — 通过

**步骤**：
1. `location.reload()` 刷新 renderer 后打开会话 → 侧栏「文件」tab → 文件树加载
2. evaluate 注入计时器：对目录行 `click()` → 轮询（4ms）子目录 testid 出现 → 双 rAF 后取「首帧」耗时；对 `packages/`、`packages/renderer`、`packages/renderer/src` 三层各测一次（先收起再展开，状态感知 + 4s 超时兜底）
3. 过滤框（`file-filter-input`）逐字输入 `s`→`store`，轮询树行数稳定计时
4. composer contenteditable 写入 `#` + 手动放置 caret 到文本节点（`detectHashTriggerFromEl` 要求 collapsed selection on TEXT_NODE）→ dispatch input → 轮询 reka popper 容器出现计时

**实测数据**（刷新后干净 store）：

| 目录 | DOM 出现 | 首帧（双 rAF） | 子项数 |
|---|---|---|---|
| `packages/` | 44.6ms | **67.6ms** | 11 |
| `packages/renderer` | 16.0ms | **33.4ms** | 6 |
| `packages/renderer/src` | 28.8ms | **48.9ms** | 12 |

- 展开首帧全部 <100ms **通过**
- 过滤：`s`→`store` 五次输入，每次 ~333ms 树更新（含 200ms 设计 debounce，W15 定案区间上限；实际投影重算几十 ms），102 行 → 53 行，清空恢复 102 行——「过滤即时」**通过**
- `#` 候选浮层 626ms 出现（含文件列表 WS 拉取），候选含 .editorconfig/.gitignore 等——<1s **通过**

**关联发现（遗留问题，记录不修）**：runtime 被 kill 后 renderer 未刷新时，此前发起过 expand 在途请求的目录（本轮为 `packages/renderer`）点击完全无响应——`useFileTree.expandNode` 的 `loading`/inFlight 去重拦截（`useFileTree.ts:130`）在 WS 断线期间请求悬挂后残留；`location.reload()` 后恢复正常。属 dev 长会话边界（生产环境 runtime 重启伴随 renderer 重建的概率低），建议后续在 WS 重连事件清理 inFlight/nodeState。

**证据**：截图 `v2-hash-candidates.png` / `v2-composer-state.png`（前段会话）；本轮 evaluate 输出见数据段。

## V3 终端高频输出 — 通过

**步骤**：
1. PanelHeader `drawer-toggle` 打开 SideDrawer → 切「终端」tab（TerminalView/xterm 挂载，PTY spawn）
2. `.xterm-helper-textarea` focus 后 type 命令：`for i in $(seq 1 2000); do echo "v3 line $i"; done` + Enter
3. 启动全局 rAF 采样器，覆盖命令执行与输出全程（29.2s）
4. 输出完成后：切走终端 tab（切到文件/git tab，TerminalView 因 `v-else-if` 卸载）→ 切回 → 对比历史内容

**实测数据**：
- 采样 29.2s / 1755 帧：**60fps**，avg 16.7ms / p95 17.7ms / **p99 17.7ms / max 17.8ms / >100ms 长任务 0 次**——输出流畅可交互 **通过**
- 终端输出至 `v3 line 2000` 完成，回到 prompt（`✔ │ 16:59:40`）
- 切走（`terminal-view` 卸载）→ 切回（重新挂载 + PTY 重连）：视口内容 `v3 line 1960-1969` 与切走前一致，`v3 line` 文本完整保留——**历史完整通过**

**证据**：截图 `v3-terminal-2000-lines.png`（本轮）；`v3-terminal-high-freq-result.png` / `v3-tab-roundtrip.png`（前段会话）；runtime 日志 `[terminal] spawn` 记录（07:23:08.288Z）。

## V4 启动与首屏 — 通过（产物数据引用既有硬证据）

**步骤与数据**：
1. runtime 启动 breakdown（17:02 supervisor 拉起新 runtime 的日志，本轮 V8 测试副产物）：
   ```
   [09:02:07.850Z] listening on port 3310 → ready
   startup breakdown: syncMigrations=2.3ms construction=16.6ms listen=1.0ms total=20.2ms
   background init breakdown: migrationA=0.2ms migrateBuiltin=2.5ms autoUpgrade=0.1ms
                          piVersion=528.4ms skillInit=16.9ms plugins=13.2ms total=561.1ms
   ```
   **「runtime 监听端口即就绪（不再等迁移/版本探测）」通过**：监听 20.2ms 即 ready，piVersion 探测（528ms）等全部后台异步化不阻塞监听。
2. build 产物体积（`apps/electron/renderer/dist/`，现存构建产物实测 gzip）：
   - entry `main-Bj8w9yPm.js`：raw 258KB / **gzip 75.2KB** —— 远低于 <400KB 目标（基线 684KB，**降 89%**）
   - vendor chunk gzip 197.6KB、shiki 438.9KB、katex 180.6KB（shiki/katex 静态绑定首屏初始请求集合，符合 10 文档 §2.2 声明；xterm 不在 index.html 初始引用中）
3. 冷启动 TTI（点击图标→可交互）：**未测**——当前环境无优化前基线版本可对照，重启 dev Electron 计时无法提供对比价值，如实标注。

**证据**：runtime 日志 09:02:07 段；`dist/index.html` 入口引用链 + `gzip -c` 实测输出。

## V5 AI 写文件链路 — 通过

**步骤**（本轮重跑，前段会话 15:22 已跑过同链路一次）：
1. evaluate 注入 `console.debug` 收集器（过滤 `[fileTree]`/`D-9` 探针输出到 `window.__v5Probes`）
2. 向当前 session 发送「创建 v5b-perf-test-a.md（内容 V5B acceptance A）和 v5b-perf-test-b.md（V5B acceptance B）」
3. 等待 AI 执行（写文件工具），随后读探针数组 + 检查文件落盘 + 查 runtime 日志 git 异常

**实测数据**（时间线）：
```
17:10:38       发送指令（runtime 日志 09:10:38.809 send: type=prompt）
17:10:5x       AI 写文件完成：v5b-perf-test-a.md / v5b-perf-test-b.md 落盘（ls 确认 17:10）
17:10:50.521   P-D9-3: [fileTree] ready-driven invalidation (D-9) {sid:01a009d3…, paths:26}
17:10:50.823   P-D9-2: [fileTree] overlay refreshed (D-9) {sid:01a009d3…, count:40}
```
- **file_changes ready → 树 overlay 刷新 302ms**（「数秒内刷新」标准超额满足）**通过**
- runtime 日志写文件时窗（09:10 段）无 git 异常 / `[git-state]` warn / 超时记录——「无 >100ms git 阻塞」的 profiler 直测未做（无 instrumentation），以间接证据支撑：302ms 完成失效+刷新链路本身、V1/V3 全程帧率零长任务（若 git 阻塞 runtime 主线程则不可能达成）

**证据**：探针输出（evaluate 返回值，上文时间线）；文件 `v5b-perf-test-a.md` / `v5b-perf-test-b.md`（仓库根，验收残留保留作证据）；截图 `v5-filetree-badges.png`（树中 v5 系列文件行）；前段会话同链路产物 `v5-perf-test-a/b.md`（15:22）。

## V6 插件 hook — 未测（dev 环境技术不可行，根因已定位）

**步骤与尝试**：
1. dev 数据目录已有前段会话构造的验收插件 `~/.xyz-agent-dev/plugins/v6-hook-test/`（onBeforeSendMessage 拦截器：把 `v6magic` 改写为 `[V6-HOOK-APPLIED]`）
2. WS 直连 runtime（3310）发 `plugin.list`：插件**已被发现**（`{pluginId:'v6-hook-test', status:'discovered', trustLevel:'sandbox', enabled:false}`）
3. 发 `plugin.toggle {enabled:true}` 激活 → **失败**，enabled 回滚 false
4. runtime 日志根因（09:16:04.245）：
   ```
   [ERROR] [plugin-process:sandbox-v6-hook-test] Error [ERR_MODULE_NOT_FOUND]:
   Cannot find module '.../plugin-service/plugin-bootstrap.js' imported from
   '.../plugin-service/plugin-bootstrap-process.ts'
   [ERROR] [plugin-host-process] process sandbox-v6-hook-test exited with code 1
   ```
   sandbox Worker fork 引用 `plugin-bootstrap.js`（打包产物路径），dev 模式 runtime 用 tsx 直跑 `.ts` 源码、无编译产物 → Worker 启动即崩 → 激活失败。**非本次 perf 改动引入**（dev/prod 路径差异），按纪律记录不修。
5. 行为旁证：激活失败状态下发含 `v6magic` 消息 → 消息正常送达（模型回复「收到」），hook 未改写（符合插件未激活预期），功能无损、runtime 有 ERROR 出声。

**替代证据**：onBeforeSendMessage 的拦截/改写/超时语义由既有测试套件背书（`packages/runtime/test/plugin-hooks-e2e.test.ts`、`plugin-hook-bridge.test.ts`、`plugin-api-hooks.test.ts`、`plugin-hooks-integration.test.ts` 等 8 个文件）。

**结论**：dev 环境不可验收；需在打包产物（`pnpm build` 后）环境重跑本场景——插件文件已就位，复测成本低。

## V7 长 session 切回 — 部分通过（口径如实）

**前置盘点**：dev 环境 session 文件最大 1401 行 JSONL / 5 user 轮（另有 1747 行 / 1 轮工具密集型）——**「几百轮」长 session 不存在**，完整口径无法满足，以下为现有条件下实测。

**步骤**：
1. 选中 entry 最多的 session「测试指令与目录查看」（Stock 项目，1401 行）计时冷加载
2. 构造 LRU 驱逐：连续切换 4 个既有 session + 新建 4 个 + 向 4 个新建 session 各发一条消息（共 12 次访问扰动）
3. 切回目标 session 计时 + 查 runtime 日志 get_entries 活动

**实测数据**：
- 冷加载（含 spawn pi + switch_session + 全量 get_entries）：**2253ms**（日志 09:04:32.101 spawn → 32.615 switch → 34.174 get_entries）
- 切回（两轮）：**81ms / 115ms**——但 runtime 日志**无新 get_entries**，即走了「LRU 窗口内 isHydrated 命中零请求」路径（与 00-overview 口径勘误一致：该路径本就零请求、不参与计时评价）
- 「被驱逐重进」：两轮构造均未触发驱逐（切回仍零请求）。推断 `evictIfNeeded` 的调用时机在 hydrate 路径而非 touch 路径，新建 session 的轻量 touch 不足以把目标挤出窗口——**未实证，如实记录**
- W20 since 增量机制运行证据（日志）：15:20:57 / 15:21:15（前段会话 V5 期间）：
  ```
  [session-service] getHistory cache fresh (empty delta) for 019ffbea…, returning 41 cached messages
  ```
  即 runtime 侧 history-rebuild-cache 命中 + `getEntries(since=lastLeafId)` 空增量=缓存新鲜的判定链路真实运行过
- renderer reload 重进（16:53 自然实验）：reload → 0.7s 重连 → 重选 session 走全量 get_entries（09:04 系列）——重进路径的完整 hydrate 正常

**结论**：切回速度百毫秒级（81-115ms）达成且远优于「秒级→百毫秒级」目标，但由零请求守卫达成而非驱逐重进路径；驱逐路径 + 「几百轮」口径留待具备条件时补测（确定性覆盖见 W09/W20 测试）。

**证据**：runtime 日志 09:04:32-34（冷加载三连）、09:05:09（切回仅 set_thinking_level）；`cache fresh (empty delta)` 两行。

## V8 断线重连 — 通过（两轮实证）

**受控测试（本轮）**：
1. 基线记录：V5 会话打开态 / 消息特征 2 条 / `v5-perf-test` 文本可见
2. `kill 91190`（SIGTERM，17:00:40.253）
3. 轮询 3310 LISTEN 至新 runtime 就绪（17:02:10，pid 9843）
4. 验证 renderer 重连与 state 恢复

**时序（runtime 日志 + 系统时钟对照）**：
```
17:00:40.274  [runtime] received SIGTERM, shutting down…（3 个 pi 子进程 exit code 143）
17:02:07.850  [runtime] listening on port 3310（supervisor 重启间隔 ~90s）
17:02:08.226  [runtime] client connected (total: 1)   ← ready 后 0.4s renderer 自动重连
重连后检查：msgCount=2（与 kill 前一致）、会话保持打开、v5-perf-test 文本完整、
            无断线横幅、无重复消息
```

**自然实验佐证（前段会话 16:40-16:43）**：同样 SIGTERM 路径（83s 重启 → 重连），16:43 截图显示会话内容/文件树展开/无错误提示完整恢复。

**renderer reload 重连（16:52）**：`location.reload()` → 0.73s client re-connected → session 列表与会话内容完整恢复。

**未覆盖项**（如实声明）：streaming 进行中断线的「stream 按 seq 回放 / delta 不回放但后续继续」——需在模型流式中精确断网，本轮未构造；seq 语义由 W09 确定性测试覆盖（04 文档）。

**证据**：截图 `v8-after-reconnect.png`（本轮重连后 state 完整）；runtime 日志 09:00:40 / 09:02:07-08 段。

---

## 遗留问题清单（记录不修，本任务范围外）

1. **[V2 关联] runtime 重启后文件树目录点击无响应**：expand 在途请求悬挂（WS 断线期间 promise 不 settle）→ `loading`/inFlight 残留拦截后续点击且无 UI 反馈；刷新 renderer 恢复。建议：WS 重连事件清理 fileTree nodeState/inFlight。
2. **[V6 根因] dev（tsx）模式 sandbox 插件 Worker 无法启动**：fork 引用编译产物 `plugin-bootstrap.js`，源码模式不存在该文件。V6 验收需在打包产物环境补测（插件已就位）。
3. **[V7 口径] 「几百轮 session 被驱逐重进」未实证**：dev 环境无长 session + 驱逐构造未成功；W20 机制有 `cache fresh (empty delta)` 运行证据与确定性测试背书。
4. **[V4] 冷启动 TTI 对比缺失**：无优化前基线版本可对照。

## 测试残留说明

- 仓库根 `v5-perf-test-a/b.md`、`v5b-perf-test-a/b.md`：V5 验收文件产物，保留作证据
- `~/.xyz-agent-dev/plugins/v6-hook-test/`：V6 验收插件（enabled:false 未激活），保留供打包环境复测
- dev session 列表新增的测试 session（V1 流式 / v7 测试消息系列）：验收过程产物
