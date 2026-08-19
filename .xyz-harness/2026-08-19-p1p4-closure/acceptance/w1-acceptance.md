# W1 验收基线：renameSession 非活跃分支健壮性（D3 + findings #4）

> 本文档是防篡改验收基线，builder/verifier 禁止修改。创建时间：2026-08-19 22:35（主 agent）。

## 背景

三个独立来源指向同一代码块（`packages/runtime/src/services/session/session-lifecycle.ts` `renameSession` 非活跃分支，:385-397）：

1. **对抗循环遗留 D3**（round2/round3 报告 deferred 项）：`if (target)` 无 else——`findScannedSession` 未命中时静默 return，无 throw 无日志。阻塞原因「用户 session-lifecycle.ts 在途」已解除（ec38e546f 已提交）。
2. **findings-confirmation #4 判定成立**（p1p4 review/findings-confirmation-report.md §4）：cwd 死路径的非活跃 session 改名静默失败——`withEphemeralPi(target.filePath, ...)` 直接传原文件，pi 0.84.1 `AgentSessionRuntime.switchSession` 内 `assertSessionCwdExists`（binary strings 实证）硬拒绝；RPC 无 cwdOverride 透传，runtime 无法绕过。调用方（renameSession）未做降级。
3. **W11 verifier 观察项**：「renameSession 非活跃分支目标不存在静默 no-op（旧行为）」——同 1。

既有可复用形态（restore-fork-attach-fix W1 建立，restoreSession :539-554）：F2/F3 分流——`containsSessionEndLine(raw) || cwdFellBack` → `stripSessionEndEntries` + `applyHeaderCwdFallback` → `normalizeSessionFileInPlace`（同目录临时名 rename-over，ADR-0062 §2 第三类合法形态）→ 直附着。`withEphemeralPi` 已内建 `assertPiSessionFile` 断言（W2 接线）。

## 目标

1. **else throw（D3）**：`findScannedSession` 未命中 → throw，错误信息含 sessionId 与可操作恢复指引（错误信息必须可操作，全局规则 16）。上层 toast 路径既有。
2. **死 cwd 降级（findings #4）**：附着前检测 header cwd 死路径 → 按 F3 同形态归一化（cwd fallback 落回原文件）→ 直附着原文件。判定与变换复用/抽共享自 restoreSession（`containsSessionEndLine` + `stripSessionEndEntries` + `applyHeaderCwdFallback` + `normalizeSessionFileInPlace`），禁止字符串全等判定（设计文档 §3.2 F2 判定细节）。
3. **正常文件零变换**：cwd 活且无 session_end 的非活跃文件——不读不改不拷贝，`withEphemeralPi` 直附着（既有行为保持，探针 ~600ms 预期不变）。
4. **过时注释清理**：`process-manager.ts` withEphemeralPi docstring「目标 session 自身的 cwd 死路径场景由调用方处理（restore tmp 管线），与本入口无关」——tmp 管线已删，注释指向已死路径，更新为指向本降级。

## 领地（越界即 rejected）

- `packages/runtime/src/services/session/session-lifecycle.ts`（renameSession 非活跃分支 + 如需抽共享判定函数）
- `packages/runtime/src/infra/pi/process-manager.ts`（仅注释，如触及）
- `packages/runtime/src/infra/pi/session-file-utils.ts`（如需把 F3 判定/变换抽成共享 export，允许；禁止改动既有函数行为）
- 测试：新增或追加（`packages/runtime/src/**/__tests__/` 下）

## 验收检查点（全部可证伪）

- CP1: `grep -n "if (target)" session-lifecycle.ts` — renameSession 域不再存在无 else 形态；构造未命中场景（mock/fixture findScannedSession 返回 undefined）→ renameSession reject，错误信息含 sessionId 字面值与恢复动作文案。
- CP2: 死 cwd fixture（header cwd 指向不存在目录）→ rename 成功：set_session_name 落盘（附着 pi 的 append 写原文件，断言文件出现改名 entry 或 mock 链路等价断言）；header cwd 被归一化为 homedir（读文件首行断言）；路径不变（无新文件产生）。
- CP3: 正常 cwd fixture（cwd 存活、无 session_end 行）→ 零变换：附着前文件字节与 mtime 不变（测试断言 readFile 前后相等）。
- CP4: pi 源码锚点纪律（ADR-0063 I4）：改动中新写的 pi 行为断言注释必须带 pi-mono 源码位置（如 assertSessionCwdExists 的 binary/pi-mono 依据——沿 findings §4.1 既有锚点或补强）。
- CP5: `cd packages/runtime && pnpm exec vitest run` 全绿，基线 **3182 passed**（2026-08-19 22:29 主 agent 实测）+ 新增用例 ≥ 3（未命中 throw / 死 cwd 降级归一化 / 正常零变换）。
- CP6: `python3 .githooks/check_pi_direct_write.py` exit 0（复用 normalizeSessionFileInPlace 不新增写点；若新增任何 pi JSONL 写调用形态必须按 R1 规约双登记，否则不允许）。
- CP7: 防篡改——本验收文档 + `.xyz-harness/**` 零改动；`git status` 范围与领地一致。

## 禁止事项

- 禁 git 写（不 add/commit/push/stash）
- 禁改 `.xyz-harness/` 任何文件
- 禁动 restoreSession/forkSession 本体（归一化逻辑只复用/抽共享，不改其行为）
- 禁 `--no-verify` / `SKIP_*`
- 禁推测性功能（不做「bash live 流式渲染」等相邻增强——明确 out of scope）
