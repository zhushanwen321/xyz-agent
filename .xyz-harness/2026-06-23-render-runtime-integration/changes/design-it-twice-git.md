---
verdict: pass
topic: #1 git 全栈 DESIGN-IT-TWICE 对抗记录
date: 2026-06-25
decision: 用户确认 Q1/Q2/Q3 = a/a/a（async execFile + 纳入 reconciler 修复 + 补 refocus）
---

# DESIGN-IT-TWICE · #1 git 全栈三方向对抗

> 触发：#1 是跨前后端新建协议 + 新建 4 runtime 模块的根本性 issue，按 design-issues skill Step 1 要求做 DESIGN-IT-TWICE（3 并行 subagent 发散）。三方向独立、可叠加，各管一个维度。

## 最终决策（用户 2026-06-25 确认）

| 维度 | Q | 选定 | 理由摘要 |
|------|---|------|---------|
| 执行模型 | Q1=a | **async `execFile`**（推翻 execFileSync） | 不阻塞多 session 事件循环；port 契约本就 `Promise<>`；切换成本 ~15 行 |
| 访问层漏洞 | Q2=a | **纳入 reconciler 修复** | `file-change-reconciler.ts:75` 字符串 execSync 是真实注入面，AC-3 grep 漏扫 |
| API 范式 | Q3=a | **单次 RPC + 补 refocus 触发** | 维持 C14 镜子语义；淘汰长事务流（破坏镜子）；淘汰 fs.watch（技术债） |

---

## 方向 A：执行模型（async execFile vs execFileSync vs Worker）

**结论：async `execFile`，推翻 execFileSync。**

核心论点：
1. **runtime 是多 session 共享进程，同步阻塞会串扰。** A session 的 pi 流式推 token，B session 点 git.status，execFileSync 冻结事件循环 1–2s → pi 的 token / file_changes / session.list 推送全部排队。NFR #1 只算了「单次 status 延迟」，漏算「阻塞期间其他 session 停顿」。
2. **readGitInfo 不是 execFileSync 的先例（D-8 论证被误用）。** readGitInfo 用 execSync 靠 5min TTL 缓存兜底，实际 spawn 频率极低；IGitExecutor 是 D-9 明确的「每次实时执行、无缓存」，调用频率差一个数量级。拿 readGitInfo 当同步先例是偷换概念。
3. **port 抽象让切换成本趋近零。** IGitExecutor.exec 签名是 `Promise<>`，async 天然契合。`infra/git-executor.ts` 用 `util.promisify(execFile)`（带 `timeout` 选项自动 kill）是单文件 ~15 行改动，service/handler/protocol 零改动。

切换阈值：status P95 > 500ms 或收到流式卡顿投诉 → 必须已切到 async。
真实风险：① error/close 合并判断（git 失败常 exitCode≠0 但不触发 error，需检查 close code）；② timeout 后僵尸进程（Windows git 偶发不响应 SIGTERM，需 SIGKILL 兜底）。

---

## 方向 B：git 访问层（shell out vs nodegit vs isomorphic-git）

**结论：维持 shell out to git CLI。换库净负债。**

决定性理由：**git CLI 已是 runtime 的硬依赖，不可消除。** 现存三处 shell out（`file-change-reconciler.ts`、`npm-git-installer.ts`、pi 引擎本体）。nodegit/isomorphic-git 不会移除 git CLI 依赖，只会再加第二套 git 实现——更多代码、更多发散源、更大攻击面。机器没装 git，xyz-agent 这条产品线根本跑不起来。

| 维度 | shell out | nodegit (C) | isomorphic-git (纯JS) |
|------|-----------|-------------|----------------------|
| 跨平台一致性 | 依赖 git，但 `--porcelain` 自 2008 稳定 | libgit2 ≠ git CLI，worktree 残缺 | 真一致 |
| 打包 | 0 | electron-rebuild + per-platform（违反 CLAUDE.md §12），且停维 | ~1MB，tsup noExternal 登记 |
| CWD 一致性 | `execFileSync({cwd})` 1:1 契合 port | `Repository.open(dir)` | `{dir, fs}` |
| 功能覆盖 | status/stage/unstage/commit 全原生 | 缺 worktree（本项目自残） | 支持但 xyCode/unmerged 要自合成 |
| port 契合 | `exec(cwd,cmd,args)` 就是 CLI 形状 | 离散 API，泄漏抽象 | 同左 |

**附带发现（本轮纳入修复，Q2=a）**：`infra/pi/file-change-reconciler.ts:75` 有字符串 `execSync('git status --porcelain')`（走 shell，注入面）。system-architecture §11 AC-3 的防注入 grep 只扫 `git-executor.ts`，漏了这处真实注入面。修复：迁移为 execFile 数组参数 + AC-3 grep 范围扩到整个 `infra/`。

---

## 方向 C：前端↔runtime git 状态交互范式（单次 RPC vs 长事务流 vs reactive 订阅）

**结论：维持单次 RPC + 手动刷新（C14），补「窗口 refocus」触发。淘汰长事务流和 fs.watch。**

三方向对抗：
- **方向 1（单次 RPC + 手动刷新，当前 C14）**：C14 契合完美，但「残缺的镜子」——用户终端 commit / IDE 外手改 / 另一窗口 stage 后，本窗口不更新。C14 把这个缺陷合法化了。
- **方向 2（长事务流 stage→commit）**：**过度设计，淘汰。** 引入 staging→staged→committing 状态机，违反 §5.4「git-zone 是镜子非控制器，无状态机」。git stage/commit 是两个独立动作，没有事务结构可套。
- **方向 3（reactive fs.watch 订阅）**：是最纯粹的镜子，但 **fs.watch 技术债不值得**——`.git` 目录高频写（index.lock/objects 临时文件）误触发、跨平台行为差异、大仓库 watch 成本。

**正面对抗：方案 3 违反 C14，该改 C14 还是放弃方案 3？**
放弃方案 3 的理由不是 C14 神圣，而是 fs.watch 技术事实。但方向 1 的 UX 缺陷也是事实。**修订 C14（Q3=a）**：刷新时机 = 进入 session + agent_end + 操作后 + **窗口 refocus（visibilitychange）**。refocus 是 5 行代码（`document.addEventListener('visibilitychange', ...)`），解决「终端 commit 后回来不刷新」真实场景，零 fs.watch 成本。把方向 1 的残缺镜子补到「用户能接受」的程度。

**一句话**：方向 3 是更好的镜子，但 fs.watch 代价不值得；方向 1 + refocus 触发是「镜子纯度 vs 实现成本」的正确取舍点。C14「无 fs.watch」立场保留，「三时刻」扩到「四时刻」。

---

## 反哺

- **issues.md #1**：方案 A 标题/改动/优缺点/取舍/验收 全部更新为 async execFile + reconciler 修复 + C12 独立数据源。
- **issues.md #3**：方案 A 流程行 + 验收补 C14 四时刻（含 refocus）+ C13 commit message 输入框 + 空 message 禁用按钮。
- **system-architecture.md §11 AC-3**：grep 范围从 `git-executor.ts` 扩到整个 `infra/`（reconciler 漏洞修复要求，执行期落地）。
- **requirements.md C14**：执行期由 plan/code-arch 同步扩为四时刻（refocus 触发）。
