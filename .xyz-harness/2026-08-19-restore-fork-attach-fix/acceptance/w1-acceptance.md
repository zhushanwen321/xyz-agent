# W1 验收基线：restore/fork 附着路径修复（F1+F2+F3 + R1 豁免）

> 防篡改声明：本文件是 W1 的验收 SSOT，builder/verifier 禁止修改。设计依据 = `docs/architecture/restore-fork-attach-fix.md` §3.2/§3.3/§3.5（对抗式审查修订版）。

## pi 语义锚点（主 agent 已一手核实，直接采信，禁网络搜索）

- `switch_session` 永久重绑读写目标：`setSessionFile` 把传入路径存为永久 `sessionFile`（pi-mono `core/session-manager.ts:815-816`），此后 `_persist` 每轮 `appendFileSync(this.sessionFile)`（`:934-960`）——附着临时文件+unlink = 数据丢失根因。
- 无 id 的 session_end 行污染 pi 树索引：`_buildIndex`（`:879-886`）对所有非 session entry 无差别 `byId.set(entry.id); leafId = entry.id`——legacy session_end 行（`ac27942fb` 写入，无 id/parentId）使 leafId=undefined → 新 entry parentId 断链 → 历史不进 LLM 上下文。**strip 必须保留**。
- header cwd 死路径 → `MissingSessionCwdError` 直接 throw（`core/session-cwd.ts:14-33`）；fallback 参数只进错误文案不降级；RPC `switch_session` 只有 sessionPath 无 cwdOverride（`modes/rpc/rpc-types.ts:59`）。**cwd fallback 必须保留**。
- 附着前文件必须为正式会话文件：`setSessionFile` 对空文件会 newSession + 全量重写，对不可解析文件 throw（`:818-841`）。

## 交付物

1. `packages/runtime/src/services/session/session-lifecycle.ts` forkSession：**删除整段 tmp 块**（`writeFileSync(tmpdir …)` / `switchSession(tmpFile)` / finally `unlinkSync`），改为直接 `await client.switchSession(forkedFilePath)`。
2. `packages/runtime/src/services/session/session-fork.ts` createForkedSessionFile：newHeader 生成时对继承的 `cwd` 做存活检查兜底（`existsSync(header.cwd)` 为假 → `homedir()`）——fork 文件是创建型新文件（登记表 §4 ⑥），写自己的 header 无合规问题。
3. `packages/runtime/src/services/session/session-lifecycle.ts` restoreSession：tmp 管线删除，按以下分流——
   - **判定**：`needsNormalize = 原文含 session_end 行（与 stripSessionEndEntries 同款正则检测） || !existsSync(target.cwd)`。禁止用 `stripSessionEndEntries(原文) === 原文` 字符串全等判定（strip 有末尾换行规范化副作用）。
   - **F2 直附着**（!needsNormalize）：`await client.switchSession(target.filePath)`，零拷贝零改写。
   - **F3 归一化**（needsNormalize）：`cleaned = stripSessionEndEntries(原文)`；若 cwd 死再 `applyHeaderCwdFallback(cleaned, homedir())`；然后经 session-file-utils 的归一化 helper：写 `join(dirname(orig), basename(orig) + '.tmp-migrate-' + Date.now() + '.jsonl')` → `renameSync` 原子覆盖原文件 → `await client.switchSession(target.filePath)`。
4. `packages/runtime/src/infra/pi/session-file-utils.ts`：归一化 helper 收口于此（单一 util；含 R1 豁免所需的路径构造形态）。
5. R1 豁免（MF3，随代码同 wave 否则 commit 被 R1 拦）：`.githooks/check_pi_direct_write.py` 豁免模式扩展 `.tmp-migrate-` 后缀形态（参照 `SIDECAR_SUFFIX_RE` 先例，注释注明登记表条目号）+ `docs/architecture/data-source-registry.md` §4 新增合法形态条目（restore-time 归一化：inactive-only + 同目录临时名 + rename 原子替换 + 变换仅限 strip session_end / header cwd fallback，每文件最多一次）+ §4 例外③更新（W11「header 永久保持旧 cwd」声明被本设计取代）。
6. 注释清理（S2）：session-lifecycle.ts 的 B7「保守隔离」注释块（:504-508/:669-673）、W11「源文件 header 永久保持旧 cwd」注释（:473-477）、「pi 已读入内存」（:521）、session-file-utils.ts 引用 strip tmp 管线的注释（:499 附近）——全部按新语义重写；`cwdFellBack` 语义注释同步。
7. 测试（vitest，禁 node:test；位置遵循 packages/runtime 现有布局，先查 vitest.config.ts 的 include 目录）。

## 验收条款（每条可证伪）

| # | 条款 | 证伪点 |
|---|------|--------|
| C1 | fork 直附着：源码无 `tmpdir`/`xyz-fork` 痕迹（fork 路径）；测试断言 client.switchSession 收到的路径 === forkedFilePath | grep + mock client 调用记录 |
| C2 | F2 直附着零改写：cwd 活 + 无 session_end 的文件 restore → switchSession 收到 target.filePath，且文件内容与 mtime 均不变（不读不改） | 文件 hash 前后比对 |
| C3 | F3 归一化（session_end，cwd 活）：strip 后落回**同一路径**（非新文件），目录无 `.tmp-migrate-*` 残留，header cwd 不动，其余行原样逐字节保留 | 目录清单 + 行级 diff |
| C4 | F3 归一化（cwd 死，无 session_end）：仅 header 首行 cwd 变为 homedir()，其余行原样 | 行级 diff |
| C5 | 双条件（session_end + cwd 死）：两种变换都发生 | 行级 diff |
| C6 | 幂等收敛：归一化产物再次 restore → 走 F2 直附着（文件零写、无第二次归一化） | hash + 调用记录 |
| C7 | fork cwd 兜底：源 header cwd 死路径 → fork 产物 header cwd 为存活路径（homedir） | 产物 header 断言 |
| C8 | 语义保留：restoreSession 的 W2-4 sidecar unlink 顺序（switchSession 成功后才 unlink `.meta.json`）、catch 分支 safeDestroy、cwdFellBack 时 spawn cwd 仍为 homedir——三者在测试或源码结构中可指认 | 源码结构 + 用例 |
| C9 | R1：`python3 .githooks/check_pi_direct_write.py` exit 0；豁免模式与登记表条目一一对应（条目含 `.tmp-migrate-` 字样与 wave 引用） | 实跑 + 条目对照 |
| C10 | 回归：`cd packages/runtime && pnpm typecheck && pnpm exec vitest run` 全绿；`pnpm run lint` 零 error。既有测试若断言了 tmp 管线旧行为（如 strip 测试的调用位置、fork/restore 的 tmpdir mock），按新行为更新并在测试注释标注「W1 语义变更：直附着正式文件」 | 命令实跑 |

## 验收命令

```bash
cd /Users/zhushanwen/Code/xyz-agent-workspace/fix-chat-flow-order
cd packages/runtime && pnpm typecheck && pnpm exec vitest run
cd .. && cd .. && python3 .githooks/check_pi_direct_write.py
pnpm run lint
```

## 边界（违反 = 越界）

- 只许新建/修改：`packages/runtime/src/services/session/session-lifecycle.ts`、`packages/runtime/src/services/session/session-fork.ts`、`packages/runtime/src/infra/pi/session-file-utils.ts`、`.githooks/check_pi_direct_write.py`、`docs/architecture/data-source-registry.md`、packages/runtime 测试文件（新增 + 既有 tmp 断言更新）。
- 禁止修改：本验收文档、`docs/architecture/restore-fork-attach-fix.md`、其他 ADR、extensions/、packages/core、packages/renderer、`packages/runtime/src/__tests__/equivalence/`（W2 领地）。
- 禁止 git 写操作；禁止 mock 框架替换真实文件系统断言（文件操作必须真实执行于测试 tmp 目录）；禁止 `any`（断言须有运行时 guard）。
- ADR-0062 §2 修订 / ADR-0063 / attach 断言 / 生命周期等价测试 = W2 领地，本 wave 不碰。
