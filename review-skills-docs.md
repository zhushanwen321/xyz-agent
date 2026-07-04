# Skills + 主进程 + 文档 审查报告

审查范围：code-link skill、merge/prerelease-test/pull-request skills、zcommit symlink、runtime-manager.ts、dev-cleanup.mjs 删除、CLAUDE.md、设计文档

---

## BLOCKER

### 1. zcommit symlink 指向外部绝对路径

`[BLOCKER] .agents/skills/zcommit:L1 — .agents/skills/zcommit 是指向 /Users/zhushanwen/.agents/skills/zcommit 的绝对路径 symlink`

**问题**：项目 CLAUDE.md 的目录规范明确禁止 symlink 指向外部绝对路径（pre-commit hook 自动检查，只允许 `../` 相对路径指向同 workspace 内的兄弟 worktree）。外部绝对路径在另一台机器上不存在，且 `code-link` 的 `walk_source_files` 遍历时 `os.path.exists()` 会对 dangling symlink 返回 False，影响 skill 可发现性。

**建议**：改为相对路径 symlink：`ln -sf ../../../.agents/skills/zcommit .agents/skills/zcommit`（假设 `~/.agents/skills/zcommit` 是 skill 安装规范目录）。或者将 zcommit skill 直接复制到项目内（如果是项目特有 skill）。

### 2. `@abstractmethod` 重复装饰器

`[BLOCKER] .agents/skills/code-link/scripts/entry_resolvers/base.py:L60-61 — EntryResolver.discover_all 方法上使用了两个 @abstractmethod 装饰器`

```python
@abstractmethod
@abstractmethod
def discover_all(self, project: str) -> list[EntryPoint]:
```

**问题**：重复的 `@abstractmethod` 装饰器是明显的 copy-paste 错误。虽然 Python 运行时不会报错（第二个 `@abstractmethod` 只是覆盖了第一个的元数据），但这是代码质量问题，且如果 abc 实现细节变化可能导致意外行为。

**建议**：删除一个 `@abstractmethod` 行。

### 3. `walk_frontend_files` 硬编码目录不覆盖 xyz-agent 的前端

`[BLOCKER] .agents/skills/code-link/scripts/bridge.py:L53-56 — walk_frontend_files 的 frontend_dirs 硬编码为 ["frontend/src", "src", "src-renderer"]，不包含 "packages/renderer/src"`

**问题**：xyz-agent 项目的前端代码在 `packages/renderer/src/`，不在 `bridge.py` 硬编码的三个目录中。这意味着 code-link 的 bridge 功能（后端→前端串联）在 xyz-agent 上完全不工作——`walk_frontend_files` 永远找不到前端文件，`frontend_files` 始终为空。

**建议**：增加 `packages/renderer/src` 到 `frontend_dirs` 列表。更长期地，应支持通过项目配置文件或自动探测来确定前端目录。

---

## WARNING

### 4. SKIP_DIRS 未包含 `.code-review-graph`

`[WARNING] .agents/skills/code-link/scripts/entry_resolvers/base.py:L13-22 — SKIP_DIRS 未包含 ".code-review-graph" 目录`

**问题**：`code-review-graph build` 会在项目内创建 `.code-review-graph/` 目录（含 `graph.db`）。`walk_source_files` 遍历源文件时会进入该目录。虽然 `graph.db` 不是文本文件不会被 `read_text` 读取（会被 `UnicodeDecodeError` 捕获），但 `os.walk` 仍会遍历该目录树，浪费时间。更重要的是，如果 `.code-review-graph/` 下有 `.py` 或 `.ts` 文件（如 watch 日志生成的临时文件），会被误扫描。

**建议**：在 `SKIP_DIRS` 中添加 `".code-review-graph"`。

### 5. `_match_score` 函数在 fastapi.py 和 fastify.py 中重复

`[WARNING] .agents/skills/code-link/scripts/entry_resolvers/fastapi.py:L103-121 + fastify.py:L240-260 — _match_score 函数在两个 resolver 中各有一份几乎相同的实现`

**问题**：两个 `_match_score` 函数逻辑几乎完全相同（精确匹配 → 参数化匹配 → 前缀匹配），仅 FastAPI 版本多了 `{param:type}` 格式处理。这是 DRY 违反，未来修复匹配逻辑时容易只改一处忘记另一处。

**建议**：提取到 `base.py` 作为公共工具函数，FastAPI 版本扩展参数格式支持。

### 6. `classify_query` 中 IPC 通道名检测不完整

`[WARNING] .agents/skills/code-link/scripts/entry_resolvers/auto_detect.py:L64-65 — IPC 通道分类只检查横线分隔符，不检查冒号分隔符`

**问题**：xyz-agent 的实际 IPC 通道名是 `open-settings-window`（横线分隔），当前 `classify_query` 通过 `-` 判断 IPC。但如果其他项目的 Electron IPC 使用冒号（如 `channel:window/api`、`dialog:show`），这些查询会被错误分类为 `direct`。虽然当前 IPCResolver 的 `discover_all` 只匹配横线格式的通道名，但 `classify_query` 和 `IPCResolver` 之间的契约不够清晰。

**建议**：在 `classify_query` 中增加冒号模式的检测（`:` in query 且不含空格），或在 `IPCResolver` 中增加冒号通道的 regex 匹配，并在文档中明确支持的通道命名格式。

### 7. `execSync('sleep 0.2')` 在 Windows 上不工作（已有 TODO 但未解决）

`[WARNING] apps/electron/main/runtime-manager.ts:L346 — execSync(\`sleep ${...}\`) 使用 Unix sleep 命令`

**问题**：runtime-manager.ts 的 graceful shutdown 使用 `execSync('sleep 0.2')` 等待 SIGTERM 生效。Windows 没有 `sleep` 命令（只有 `timeout`），会直接抛异常被 catch 静默吞掉，导致跳过等待直接发 SIGKILL。虽然 catch 处理了异常，但意味着 Windows 上 graceful shutdown 退化为立即 SIGKILL。

**建议**：已有 TODO 注释（L386-393），明确了 Windows 替代方案。短期可接受（macOS 优先），但注释中的 `TBD-windows-support` 应跟踪为 issue。

### 8. prerelease-test.sh 降低产物验证标准

`[WARNING] scripts/prerelease-test.sh:L144 + L161-163 — 产物验证从要求 3 个（dmg+exe+AppImage）降为 2 个（dmg+AppImage），跳过 .exe 检查`

**问题**：如果 CI 同时构建 dmg + AppImage 但 .exe 构建失败，这个改动会让 prerelease 测试通过，但实际用户无法获得 Windows 产物。如果是有意为之（Windows build 已禁用），应在 SKILL.md 中同步更新"验证产物完整性"的描述。

**建议**：确认 Windows build 是否确实已禁用。如果已禁用，在 prerelease-test SKILL.md 中明确标注"当前仅验证 macOS + Linux 产物"。

### 9. code-link 的 `ensure_watch_running` 后台进程可能泄漏

`[WARNING] .agents/skills/code-link/scripts/code_link.py:L86-104 — ensure_watch_running 使用 start_new_session=True 启动后台 watch 进程，但无清理机制`

**问题**：`code-review-graph watch` 后台进程通过 `start_new_session=True` 脱离父进程。如果 Python 脚本被 kill（如 Ctrl+C），watch 进程不会自动终止。虽然 PID 文件用于后续检测（"已在运行则跳过"），但在开发过程中可能积累多个 watch 进程（PID 文件过期/损坏时）。

**建议**：使用 `atexit` 注册清理函数，或使用临时文件锁（`fcntl.flock`）确保单实例。至少在 SKILL.md 中文档化 watch 进程的生命周期和清理方式。

---

## SUGGESTION

### 10. `walk_frontend_files` 的 `src/` 匹配过于宽泛

`[SUGGESTION] .agents/skills/code-link/scripts/bridge.py:L54 — frontend_dirs 包含 project + "/src"`

**问题**：许多项目的 `src/` 目录混合了前后端代码（如 xyz-agent 的 `src-electron/` 下有 `main/`、`runtime/`、`renderer/src/`）。将 `src` 作为前端目录可能导致扫描到非前端文件（如 `runtime/src/` 的 Node.js 代码），bridge 匹配时产生误报。

**建议**：优先匹配更具体的目录（`frontend/src`、`packages/renderer/src`），`src/` 作为最后 fallback。

### 11. CLAUDE.md 测试规范新增内容

`[SUGGESTION] CLAUDE.md:L246-257 — 新增"测试规范 [HISTORICAL]"章节`

**评价**：内容准确，覆盖了 vitest vs node:test 的混淆问题、正确的运行命令、超时处理、subagent prompt 规范。标记为 `[HISTORICAL]` 合理。与项目实际配置一致（`vitest.config.ts` 存在于 `packages/runtime/`）。

**建议**：无问题，内容可合并。

### 12. merge/pull-request SKILL.md 新增 `[HISTORICAL]` 规则

`[SUGGESTION] .agents/skills/merge/SKILL.md:L176-182 + pull-request/SKILL.md:L73-79 — 新增"禁止跳过检查"规则`

**评价**：内容正确且重要——跳过检查多次导致事故。同时新增了 `[HISTORICAL]` 标记说明，与全局 CLAUDE.md 的标记规范一致。但两个 skill 的规则措辞完全相同，未来如果规则更新需要同步两处。

**建议**：可合并。

### 13. prerelease-test SKILL.md 版本命名更新

`[SUGGESTION] .agents/skills/prerelease-test/SKILL.md:L14-24 — 从 -beta.N 递增改为固定 -beta 后缀`

**评价**：与 `scripts/prerelease-test.sh` 的实际改动一致。固定 `-beta` 后缀 + 自动清理旧 release 简化了流程，避免了序号递增的复杂性。

**建议**：可合并。

### 14. `dev-cleanup.mjs` 删除

`[SUGGESTION] apps/electron/scripts/dev-cleanup.mjs — 完整删除（47 行）`

**验证**：在 `package.json`、`src-electron/` 内的 TS/JS 文件中搜索 `dev-cleanup` 无残留引用。仅在 `.xyz-harness/` 的历史文档中有一行目录列表引用（不影响运行时）。删除安全。

**建议**：可合并。

### 15. `panel-drag-region-demo.html` 设计文档

`[SUGGESTION] docs/page-design/panel-drag-region-demo.html — 新增 653 行的 PanelBar drag region 交互式 demo`

**评价**：HTML demo 质量高，提供了当前状态 vs 修复后的可视化对比、sidebar collapsed 场景、图例说明、代码参考。放在 `docs/page-design/` 符合项目目录规范。

**建议**：可合并。

### 16. `.xyz-harness/` 文档

`[SUGGESTION] .xyz-harness/2026-06-10-model-lifecycle-fixes/{plan,review}.md + pi-call-chains.md — 新增设计文档`

**评价**：
- `plan.md`：详细描述了模型生命周期修复的 6 个 Task，设计清晰
- `review.md`：对 plan 的完整审查意见，发现了 P0 级问题（errorMessage 字段名未验证）
- `pi-call-chains.md`：21 条完整调用链追踪，由 code-link AST tracer + 手动补齐生成，是宝贵的架构文档

内容准确，与代码结构一致。特别是 `pi-call-chains.md` 中的行号引用与实际代码对齐。

**建议**：可合并。

---

## 总结

| 严重程度 | 数量 | 关键发现 |
|---------|------|---------|
| BLOCKER | 3 | zcommit 外部绝对路径 symlink（违反项目目录规范）、`@abstractmethod` 重复、bridge.py 前端目录不覆盖 xyz-agent |
| WARNING | 6 | SKIP_DIRS 遗漏、_match_score 重复、IPC 分类不完整、Windows sleep 兼容、产物验证降级、watch 进程泄漏 |
| SUGGESTION | 7 | walk_frontend_files 过于宽泛、文档内容准确性确认（全部通过） |

**建议处理顺序**：
1. 修复 BLOCKER #1（zcommit symlink）— 简单改动
2. 修复 BLOCKER #2（重复 @abstractmethod）— 删除一行
3. 修复 BLOCKER #3（bridge.py frontend_dirs）— 加一个目录路径
4. 修复 WARNING #4（SKIP_DIRS 加 .code-review-graph）— 加一个字符串
5. 其余 WARNING 和 SUGGESTION 可后续迭代
