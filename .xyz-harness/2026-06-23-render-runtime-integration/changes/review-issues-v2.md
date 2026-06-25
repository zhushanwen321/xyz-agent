---
verdict: CHANGES_REQUESTED
reviewer: fresh-context-issue-reviewer-v2
date: 2026-06-25
scope: issues.md 最终版（post 06-25 反哺 + tracing-align + DESIGN-IT-TWICE + 9 处修订）
---

# 独立 Issue 审查报告 v2 — issues.md 最终版

## Verdict: CHANGES_REQUESTED

6 维中有 2 项阻塞缺陷（均集中在 #1），需修订后方可 APPROVED。红队有 2 个攻击落地（refocus 覆盖盲区、AC-3 范围溢出）。上一轮 3 个扣分点全部解决。

---

## 六维评分

| 维度 | 分 | 扣分点 |
|------|----|--------|
| 1 完整性 | 9/10 | F1-F12 + C1-C15 全映射；C12-C15 新验收项齐全。扣：#1 问题描述 line 48 仍写「execFileSync 实现」与方案 A 矛盾；#8(P1) 软依赖 #12(P2) 表中标「无」 |
| 2 方案质量 | 8/10 | P0/P1 全 ≥2 方案 + 取舍。扣：#1 问题描述/方案 A 内部 execFileSync↔async 不自洽；async 决策未反哺到 code-arch §4.1/§4.2 |
| 3 优先级一致性 | 9/10 | P0 不依赖 P2/P3；blocked_by 与表一致。扣：#8↔#12 软依赖表标记与正文不一致（沿袭上轮，未修） |
| 4 迷雾处理 | 10/10 | #13 去 ?、章节改「P1 续·冲突裁决」、[SURFACED] P1 定位三者一致；无残留迷雾 |
| 5 可执行性 | 7/10 | AC 多可 grep。扣：#1 AC-3「全目录无字符串形式」范围溢出 fix scope（trash.ts/process-manager.ts 漏网）—— AC 按字面不可达 |
| 6 红队 | 6/10 | 2 攻击落地（refocus 盲区 / AC-3 范围），3 攻击被驳（共享进程阻塞成立 / [STALE] 覆盖足 / 双路径不混淆） |

---

## 发现的问题

### P1-1 [阻塞] — #1 AC-3 grep 范围溢出 fix scope，AC 按字面不可达

**位置**：issues.md #1 验收 line 120「附带修复 reconciler 漏洞：…AC-3 grep 范围扩到整个 `infra/`，**全目录无字符串形式 shell 调用**」。

**问题**：实际代码核查（`grep -rn "execSync|spawnSync" src-electron/runtime/src/infra/`）发现 `infra/` 下有 **3 处**字符串形式 `execSync`：
- `infra/pi/file-change-reconciler.ts:75` — `execSync('git status --porcelain', {cwd})`（常量串，在 fix scope 内 ✅）
- `infra/system/trash.ts:13` — ``execSync(`trash "${filePath}" ...`)`` **（`filePath` 插值，真实注入面，不在 fix scope ❌）**
- `infra/pi/process-manager.ts:45` — `execSync(whichCmd)`（常量串 'which pi'，不在 fix scope ❌）

AC 字面「全目录无字符串形式」要求三者全灭，但 #1 fix 只承诺 reconciler。implementer 按字面执行：要么只修 reconciler → AC 失败；要么连带修 trash.ts → scope 越界（trash 非 git 职责）。**AC 与 fix scope 必须对齐**。

**修复建议**（二选一）：
- 收窄 AC 措辞：「`infra/` 下 **git 相关** shell out 无字符串形式（reconciler + git-executor）」—— 匹配 #1 实际职责；
- 或：将 trash.ts 纳入 #1 fix scope（它是 `filePath` 插值的真实注入面，比 reconciler 常量串更危险，修掉收益更高）。

推荐后者（trash.ts 才是高危项），但需显式声明扩 scope。

### P1-2 [阻塞] — #1 问题描述与方案 A 内部矛盾（execFileSync vs async execFile）

**位置**：issues.md #1 问题描述 line 48「`infra/git-executor.ts`（**execFileSync 实现**）」vs 方案 A line 59-73「async `execFile`」+ 验收 line 117「无 `execFileSync`」。

**问题**：问题描述是 implementer 首读段，写「execFileSync 实现」直接否定下方方案 A 的 async 决策与验收。DESIGN-IT-TWICE 反哺时只改了方案 A/验收/取舍，漏改问题描述。

**修复**：line 48 改「`infra/git-executor.ts`（**async execFile 实现**）」。

### P2-1 [非阻塞] — async execFile 决策未反哺到 code-architecture / system-architecture

**位置**：code-architecture.md §4.1(line 391)/§4.2(line 456)/§6.4(line 1147)/§1.2(line 109) + system-architecture.md §11 AC-3(line 427)。

**问题**：三方向对抗（Q1=a）决策写入 issues.md #1 与 design-it-twice.md，但下游 code-arch 仍全量描述 `execFileSync`（时序图、grep 清单、目录注释），system-arch §11 AC-3 仍是旧的 `grep -v execFileSync` 形态。tool_call_pending 的 [STALE] 反哺做到了，async-execFile 的反哺没做到。implementer 读 code-arch §4.1 会写出 execFileSync，与 issues.md #1 验收冲突。

**修复**：code-arch §4.1/§4.2 时序图 `execFileSync` → `execFile`（async）；§6.4 grep 清单对齐 issues.md #1 验收；system-arch §11 AC-3 更新。注：issues.md 本身正确，属下游同步，不卡 issues.md APPROVED，但卡计划整体一致性。

### P2-2 [非阻塞] — C14 refocus 用 visibilitychange 存在覆盖盲区

**位置**：issues.md #3 验收 line「窗口 refocus（visibilitychange）触发刷新」+ design-it-twice 方向 C「解决终端 commit 后回来不刷新」。

**问题**：visibilitychange 仅在 `document.visibilityState` hidden↔visible 切换时触发（最小化/恢复、切 tab）。Electron 多窗口下，**外部终端仅遮挡（occlude）xyz 窗口而非最小化时，xyz 的 visibilityState 仍为 visible，visibilitychange 不触发**。即 design-it-twice 声称要解决的「终端 commit 后回来」场景，若用户未最小化 xyz（终端仅浮在上层），refocus 触发**不生效**。

**修复**：#3 验收补「refocus 触发 = `visibilitychange`（visible 态）+ `window:focus` 事件双触发」，或在 design-it-twice 注明覆盖范围（仅最小化/恢复场景）。前者更完整。

### P3-1 [非阻塞] — #1 框架为「新建」但代码已落地（Wave 1, 2026-06-24）

**位置**：issues.md #1 问题描述「需要新建」+ mermaid `#1:::resolved`。

**问题**：`git-executor.ts`/`git-service.ts`/`git-message-handler.ts` 已在 commit `9ff5d8b6`（2026-06-24，Wave 1）落地，当前实现是 `async exec(){...execFileSync...}`（async 壳包 sync 调用，事件循环实阻塞）。DESIGN-IT-TWICE（2026-06-25）次日才定 async。故 #1 实际是**重构已落地代码**（拔掉 execFileSync 换真 async execFile），非「新建」。框架误导。

**修复**：#1 问题描述改「重构已落地 execFileSync → async execFile + 补 reconciler/trash 修复」。不阻塞（方案 A/验收正确），但影响 implementer 对工作量的判断。

### P3-2 [非阻塞] — [STALE] 顶部声明足够，但内联标注更稳

spec-w11.md In-scope#2/Acceptance、requirements F2/G1 路径 仍以顶部 [STALE] 声明覆盖，未内联标注。顶部声明已无歧义，达标；若想防 implementer 只读局部段落漏看声明，可在 F2/G1-path 加内联 `[STALE]`。改进项，不阻塞。

---

## 红队发现（adversarial）

### R1 — 攻击 #1 async execFile「共享进程阻塞」论断 → **被驳（论断成立）**

**攻击向量**：runtime 真的是单进程多 session 共享？execFileSync 真阻塞其他 session 的 pi 流式？

**核验**（`src-electron/runtime/src/transport/server.ts`）：
- line 159 `this.wss = new WebSocketServer({ server: this.httpServer })` —— **单 WebSocketServer 实例**
- line 180 `this.wss.on('connection', (ws) => this.handleConnection(ws))` —— 所有连接同进程
- rpc-client.ts:118 `spawn(piCmd, args)` —— pi 子进程异步推 token，经 stdout 异步事件到达 Node 事件循环

**结论**：execFileSync 是真同步，阻塞期间事件循环冻结，session B 的 pi token 在 OS pipe buffer 排队。**「阻塞其他 session」论断技术上成立**，async 决策方向正确。

**但严重度被高估**：`git status --porcelain` 典型 <50ms（只读 index+工作树），design-it-twice 说的「1-2s 卡顿」偏悲观；buffer 不会溢出，是「延迟尖峰」非「永久冻结」。方向对，措辞偏重。不构成问题（决策仍正确）。

### R2 — 攻击 C14 refocus visibilitychange 覆盖 → **部分落地（见 P2-2）**

多窗口 occlude 场景不触发 visibilitychange，「终端 commit」核心场景可能miss。已在 P2-2 详述。

### R3 — 攻击 reconciler AC-3 范围 → **硬落地（见 P1-1）**

`infra/system/trash.ts:13` 字符串 `execSync` 带 `filePath` 插值是真实注入面，AC-3「全目录无字符串形式」会扫到它，但 fix scope 只含 reconciler。AC 不可达。已在 P1-1 详述。

### R4 — 攻击 [STALE] 同步彻底性 → **被驳（覆盖足）**

**核验**：spec-w11.md 顶部 [STALE] 声明显式列举覆盖范围（Background §1 / In-scope#2 / FR-2 / G-001/G-002 / Acceptance）；requirements.md 顶部声明覆盖 F2 / G1 路径，并明确区分「queue pending 不失效」。无遗漏的 pending 残留（queue_update pending 正确排除）。

**结论**：顶部声明式 [STALE] 已无歧义收敛。改进项见 P3-2，非缺陷。

### R5 — 攻击 C12/C15 双路径 UI 打架 → **被驳（语义独立，不打架）**

**攻击向量**：git.status（hasConflict+files[].status=unmerged）与 file_changes（FileChangeStatus=unmerged）双数据源，用户同时手改 + AI 同时改时两个 UI 会不会打架？

**核验**：
- git-zone 走 git.status（工作目录全量：用户手改 + AI 改 + IDE 改）
- FileView/ChangeSetCard 走 file_changes（AI per-turn，跨回合聚合）
- 二者**消费区域不同**（Panel zone⑤ vs Sidebar），**数据语义不同**（实时全量 vs AI 历史回合）

**结论**：不会数据冲突（两路独立、各管各的）。存在两个边缘观察：
1. **UX 计数差异**：git-zone 显 2 文件、FileView 显 1 文件时，naive 用户可能困惑。但 C12/D-1 已显式声明语义区分，属 UI 标注问题非数据问题。
2. **FileView 聚合陈旧**：用户回合间解决冲突后，旧回合的 file_changes 仍标 unmerged（聚合的是历史）。这是「跨回合聚合」的固有特性，FileView 本就反映 AI 改动历史而非当前态，不构成错误。

不构成阻塞问题。建议（非必须）：FileView 在冲突文件旁加「(historical)」微标注降低困惑。

---

## 与上一轮 review-issues.md 对比

| 上轮扣分点 | 状态 | 证据 |
|-----------|------|------|
| W4 跳号（W1/W2/W3/W5 缺 W4） | ✅ 解决 | 依赖表现 W1/W2/W3，无跳号；#13 从 W5 移至 W2 |
| #13 既占 Wave 又迷雾 | ✅ 解决 | #13 升 P1 + [SURFACED]、标题去 ?、章节改「P1 续·冲突裁决」、W2 排期 |
| #8/#12 枚举补全未交叉引用 | ✅ 解决 | #8 正文加「依赖 #12…可字符串占位」；#12 加「支撑下游 #8/#10」双向引用 |

上轮 3 项扣分全部解决。本轮新发现集中在 #1 的 async execFile 反哺不彻底（P1-1/P1-2/P2-1）—— 这是 06-25 DESIGN-IT-TWICE 新决策引入的、上轮（06-24）尚不存在的问题域。

---

## 总体结论

issues.md 主体质量高：13 个 issue 结构完整、P0/P1 方案对比充分、依赖一致、迷雾处理干净、C12-C15 新验收项下沉到位、上轮扣分全清。**问题域集中在 #1 的 async execFile 决策反哺不彻底**：
- **阻塞**（P1-1/P1-2，需修 issues.md 自身）：AC-3 范围与 fix scope 溢出（trash.ts 真实注入面漏网）、#1 问题描述与方案 A 的 execFileSync↔async 内部矛盾。
- **非阻塞**（P2，下游同步）：code-arch/system-arch 的 execFileSync 残留、refocus 覆盖盲区。

**建议**：修 P1-1（收窄 AC 或扩 scope 含 trash.ts）+ P1-2（line 48 改 async）后即可 APPROVED。P2 项可与 code-arch 修订同批处理，不卡 issues.md 收敛。红队 R3（trash.ts）是本轮最有价值的发现 —— 它揭示了 AC 措辞过宽暴露了一个比 reconciler 更危险的、原本不在任何 issue 视野内的注入面。
