# 非功能约束（NFR）

> 工程级不变式，分 7 维度。每条约束带「验证」字段（grep AC / 事故来源 / 规则编号），破坏即 bug。设计新功能时对照本文件评估副作用。

## 1. 安全

| 约束 | 要求 | 验证/来源 |
|------|------|----------|
| 路径白名单动态化 | 禁硬编码 `~/.xyz-agent`/`~/.pi`，所有路径从 `getConfigDir()`/`getPiAgentDir()` 推导 | pre-commit `check_path_whitelist.py`；CLAUDE.md 安全约束#2 |
| ENV 白名单 SSOT 单一性 | `ENV_WHITELIST_PREFIXES` 仅定义在 `shared/src/constants.ts`，main/runtime 只能 import | `check_env_whitelist_sync.py`；CLAUDE.md 安全约束#3 |
| 数据目录隔离 | `~/.xyz-agent/` 与 `~/.pi/agent/` 完全隔离，互不读写 | CLAUDE.md 安全约束#1；ADR-0009 |
| dev/prod 实例隔离 | `XYZ_AGENT_DATA_DIR` 唯一心智锚点，dev 自动 `~/.xyz-agent-dev/`，端口偏移 +100，零侵入 prod | `2026-06-07-instance-isolation/spec.md` |
| DOMPurify 必须保留 | 聊天 markdown 容器 `.msg__body` 经 v-html 渲染，须净化 | `docs/standards.md §7.2` |
| Plugin Worker Thread 隔离 | 每个插件独立 Worker，崩溃不影响主进程；sandbox 插件受 PermissionChecker 约束，trusted(built-in) 不受限 | `2026-05-27-clarify-plugin-phase1/spec.md` FR-3 |
| Tool Approval / Human Confirm | 危险操作三选一(Allow/Deny/Always)；UI 弹窗 60s 超时自动关闭，用户可取消 | context.md「Tool Approval」 |
| findFiles 范围限定 | 限定 `process.cwd()`，自动忽略 `.git`/`node_modules`，插件不能搜项目外 | `2026-05-29-plugin-remaining-phases` NFR §5 |
| 文件树/git 路径越界守门 | 所有接收 path 的文件树/git 操作入口必须调 `isUnderOrEqual(cwd, resolvedPath)`，越界抛 `FileError('out_of_cwd')`/`GitError('path_not_allowed')`；防 `../../etc/passwd` 穿越。词法判定不解析 symlink（接受理由：用户对 cwd 内容负责） | `runtime/services/file-service.ts` + `git-service.ts` getFileDiff；`[from: 2026-06-28-sidebar-project-file-tree §S-1/S-5]` |
| git 命令防注入 | git CLI 必须经 `IGitExecutor.exec(cwd, cmd, args[])` port，`execFileSync('git',[cmd,...args])` 数组形式，禁函数体直接 exec/execSync 字符串拼接 | `runtime/infra/git-executor.ts`；`[from: 2026-06-28-sidebar-project-file-tree §S-3]` |
| 文件预览禁 v-html | 渲染用户可控的文件内容/diff 禁 v-html，用 `{{ }}`/`<pre>` 文本插值；高亮复用 shiki 单例，禁引第二套高亮库 | `renderer/components/panel/DetailPane.vue` grep 无 v-html；`[from: 2026-06-28-sidebar-project-file-tree §S-4]` |

## 2. 数据

- **Session 隔离（核心）**：所有 runtime→前端消息若涉及特定 session，payload 必带 `sessionId`；缺失则忽略（防广播到所有 panel）。三层机制：ChatStore `Map<sessionId>` 分区 → useChat 全局路由 → PaneSessionView 组件过滤。Runtime 侧 `server.ts sendError` 也必须带 sessionId。验证：CLAUDE.md 规则#7（「违反必出 bug」）
- **延迟写入**：pi 的 `_persist()` 在首个 assistant 消息前不写 session 文件；读取 `get_state` 返回的 sessionFile 路径时文件可能不存在，必须处理 not-exist（返回空树/空消息）。验证：CLAUDE.md 规则#6
- **.jsonl 持久化**：扁平结构，不按 cwd 子目录组织；entry 每行一个 JSON。验证：`docs/standards.md §4.2`
- **文件是 SoT，内存是缓存**：启动加载 → 写后刷新 → 防竞争（异步队列串行化）。验证：`docs/standards.md §5`
- **PluginStorage 原子写**：write-to-temp + rename；500ms debounce 批量写；每插件 10MB 上限，单 value 1MB。验证：plugin-phase1 spec FR-6
- **sessionData**：通过 Pi Bridge 走 `pi.appendEntry()` 持久化在 pi session JSONL，天然跟随 session 生灭（区别于独立 JSON 的 PluginStorage）

## 3. 性能

- **流式渲染轻量**：流式阶段用 `renderLightweight`（markdown-it 无 Shiki）；完整阶段用 `renderFull`。MergeBlock 折叠时不挂载 ThinkingBlock/ToolCallCard（v-if）。验证：`docs/standards.md §7.2.6`
- **重型组件懒加载**：Mermaid 仅在页面有 mermaid 块时加载；shiki 语言包按需
- **状态反映 <100ms**：streaming setInterval(1000) 仅在 streaming 状态存在，complete 后清除，同时最多 1 个 timer
- **findFiles**：fast-glob（Rust 实现），>10k 文件项目 <500ms，1000 条结果截断
- **Hook 执行**：串行，单 handler 5s 超时，典型 1-2 handler 增加 <100ms。验证：CLAUDE.md 规则#11

## 4. 并发

- **session 单写者**：SessionService 持有 sessions Map，组合 lifecycle/dispatcher/scanner 三子模块经 `ISessionServiceInternal` 接口访问 Facade（非半构造）
- **subagent 并发限制**：TaskNode 递归嵌套 `max_depth=20`；底层复用 pi SubAgent extension
- **Worker Thread 分组**：trusted 插件共享 1 Worker（默认 max 10 插件），untrusted 插件每独占一 Worker（崩溃隔离）
- **多插件并发写互不阻塞**：每 pluginId 独立锁 + ReadWriteLock
- **独立数据源并行用 `Promise.allSettled` 不用 `all`**（CLAUDE.md 前端编码规则#7）

## 5. 稳定性

- **runtime 崩溃恢复**：Worker crash → 5s 冷却 + 3 次重建上限防 crash loop；trusted Worker 自动重建重载，untrusted 等下次激活。Hook 调用 try-catch 包裹，异常/超时视为放行，消息流不中断。验证：CLAUDE.md 规则#11
- **WS 重连**：退避上限后报错，不自动重试到死循环；重连成功后对所有 `isGenerating=true` 的 session 调 `markSessionError('连接已重置')` 收尾（不续传中断的 streaming，pi 上下文已丢失）
- **错误不变量集中**：`chatStore.markSessionError(sid, err)` 单一入口重置 isGenerating + streamingMessage（防 UI 卡「思考中」）。验证：CLAUDE.md 规则#3
- **命令超时善后**：默认 30s，超时 reject + 删 pending Map + 迟到响应静默丢弃
- **文件操作超时**：FileService listDir/stat/readFile 共用 `READ_TIMEOUT_MS=10_000`（10s），超时抛 `FileError('timeout')`；withTimeout 用单 Promise 构造器 + 手动 settle 避免 unhandledRejection。验证：`runtime/services/file-service.ts`。`[from: 2026-06-28-sidebar-project-file-tree §K-2]`
- **展开请求幂等去重**：同 path expand 在途时不重发（inFlight Map），loaded 复用缓存。验证：`renderer/composables/features/useFileTree.ts`。`[from: 2026-06-28-sidebar-project-file-tree §AC-3.8]`

## 6. 兼容性

- **向后兼容 env var**：`XYZ_AGENT_DATA_DIR` 未设时行为完全不变（prod 默认）；`XYZ_AGENT_PORT_OFFSET` 未设默认 0。验证：instance-isolation spec §5、§9
- **pi fork 版本锁定**：必须用 `xyz-pi`（fork，含 `leafId` 字段），不能用原版 `@mariozechner/pi`，否则 session tree 失效
- **旧消息兼容**：不含 contentBlocks 的历史消息走 `groupByLegacyFields`，渲染不变
- **plugin manifest 向后兼容**：semver 兼容性检查（`engines.xyz-agent`），不兼容跳过扫描
- **shared 层禁 node 内置模块**：`src-electron/shared/src/` 是浏览器/runtime 共享层，禁 import `node:` 内置（node:path/fs/crypto），浏览器环境 vite externalize 成空代理访问即崩。验证：`grep -rn "from 'node:" src-electron/shared/src/` 返回空。事故来源：W1a 误迁 isUnderOrEqual 到 shared 导致 dev 崩溃（E2E mock 掩盖 8 Wave）。`[from: 2026-06-28-sidebar-project-file-tree §3.1]`（教训固化为 2026-06-30-e2e-retrospect）
- **跨 store 编排在 composable 层**：stores 间禁互相 import，跨 store 编排（如 fileTreeStore 监听 chatStore）在 composable 层 watch + 派发 store action。验证：`useFileTree.ts` setupInvalidation。`[from: 2026-06-28-sidebar-project-file-tree §K-9]`

## 7. 可观测性

- **三级通知层级**：plugin `notify` → info/warning/error 三级；`plugin:notification` WS 事件广播到前端
- **Statusline 三区**：Input Toolbar（per-panel 输入框内）/ Session Strip（per-panel 输入框下）/ Global Statusbar（窗口底部全局）。数据来自 pi extension `setStatus()` + plugin `updateStatusBarItem()` 两通道
- **Hook 可审计**：`blocked` 和 `transformedContent` 变更在 session 历史可见
- **错误内联**：错误作为 assistant 消息插入聊天流，不用顶部 banner。验证：CLAUDE.md 规则#3
- **SystemNotification 过渡态**：v3 重构后聊天流内联系统通知暂未重新落地，错误/提示走 overlay/toast 层，待 v3 内容层深化时重新接入（见 context.md「SystemNotification」）
