# W3 独立验证报告：attach 护栏报警器 + tmp-migrate 残留清理

> Verifier 独立复核，2026-08-20 00:20–00:40。基线：`w3-acceptance.md`（CP1–CP7）。

## 结论：PASS（0 major）

全部检查点独立复核通过。两条重要观察（非 major，见「异常与观察」）：① 首跑全量出现 8 红，已定位为**验证期间外部并发改动**（认知外文件被同时修改），非 W3 改动引入，复跑全绿；② 「差 7」归属已查清，为前一 commit 3ded0d5fc 的 7 条新增用例。

## 各检查点结果

### V-CP0 防篡改 — PASS

- 验证起点 `git status`：仅 4 个 W3 领地文件（3 modified + 1 untracked 新测试文件），与基线领地一致。
- `w3-acceptance.md` 未被修改（无 diff）。
- **差 7 归属**：builder 自报基线 3185 + 新增 6 = 预期 3191，实测 3198，差 7。查证：`git log` 显示 W3 前最近一个 commit `3ded0d5fc`（gap review S6，tmp-migrate rename rollback）新增 7 条测试（`session-file-utils-migrate-cleanup.test.ts` 4 条 + `session-lifecycle-attach.test.ts` 3 条，grep `^\+\s*(it|test)(` 计数 = 7），该 commit message 自报 3192/3192。3192 + 6 = 3198，**数字闭合**。3185 是 3ded0d5fc 之前的旧口径，builder 引用了过期基线数字（minor 口径错误，非伪造）。

### V-CP1 契约用例 — PASS

- 读用例源码：断言为 `typeof sessionFile === 'string'` + `length > 0` + `resolve()` 归一等于附着目标——非 truthy 宽断言，强度达标。
- `git diff attach-lifecycle.test.ts`：仅文件末尾追加 1 个用例，既有 3 用例零改动。
- 独立实跑（真实 pi）：`vitest run src/__tests__/equivalence/attach-lifecycle.test.ts` → **4/4 passed**（含「I1 契约报警器」1.1s 绿）。

### V-CP2/CP3 清理函数与用例 — PASS

实现逐点核对：

- mtime 过滤方向正确：`statSync(filePath).mtimeMs < cutoff`（cutoff = now − maxAgeMs），早于阈值才删。
- 两层枚举：根目录 + 一级子目录（`statSync(entryPath).isDirectory()` 收集），与 scanPiSessionsFromDisk 同构。
- 单文件失败 `console.warn` 不中断；根目录不可读返回 0；目录不存在 `existsSync` 前置返回 0。
- 默认阈值 `3_600_000`（1h ≥ 基线要求的 1 小时）。
- 新测试文件 5 用例：四态（过期删含子目录两层 / 新鲜保留 / 目录不存在 no-op / 非匹配零触碰）+ 端到端。端到端走 `scanPiSessions()` 全链路（含目录缓存 invalidate + 重扫一致性），非仅调 `isScannableSessionFile`。实跑 5/5 绿。

### V-CP4 红性验证 — PASS

注入前备份，逐个注入 → 定向红 → 字节还原（`cmp` 与备份比对通过后删除备份）：

| 注入 | 结果 |
|------|------|
| a) 去掉 mtime 过滤（匹配即删） | 「新鲜残留保留」用例红（1 failed | 4 passed）✓ |
| b) 去掉子目录层枚举 | 「过期删两层」+「端到端」两用例红（2 failed）✓ |
| c) 契约断言放宽为 `Boolean(state?.data?.sessionFile)` | 用例仍绿（对照证明宽断言不设防，原强断言必要）✓ |

注：c) 首次注入写错字段路径（`state?.sessionFile`）导致误红，修正路径后按预期仍绿。还原后 `cmp` 两文件与注入前备份字节一致。

### V-CP5 独立全量 — PASS（附异常说明）

- `pnpm exec vitest run`：
  - 第 1 次：3198 collected，8 failed（全部集中在 `sanitize-invalid-providers.test.ts`，且该文件仅收集到 18 条 vs 单独跑 24 条）。
  - 排查：该文件未被 W3 触碰；单独跑 24/24 绿；与 W3 新测试同跑 29/29 绿。
  - `git status` 复查发现验证期间出现**认知外并发改动**（见下），provider 域 4 文件正在被另一进程修改——8 红为与并发改动竞态所致，非 W3 引入。
  - 第 2 次（外部改动收敛后）：**3204/3204 passed (286 files)**。3204 = 3198 + 6（外部对 sanitize 测试新增 6 条），数字闭合。
- `tsc --noEmit` exit 0。

### V-CP6 R1 — PASS

`python3 .githooks/check_pi_direct_write.py` → `[OK] 扫描 240 文件`，exit 0。

### V-CP7 接线点 — PASS

- `startup-background-init.ts` diff：步骤 ⑧ 位于既有后台序列末尾（`runStartupBackgroundInit` 在 listen 后执行，不阻塞启动路径）；`try/catch` 包裹，失败仅 `console.warn` 不上抛；`removed > 0` 才 log。
- 既有步骤零行为改动（diff 仅新增 import 2 行 + 步骤 ⑧ 块）。

## 异常与观察（0 major）

1. **认知外并发改动（规则 0）**：验证期间 `git status` 新增非 W3 文件改动：`packages/runtime/src/infra/pi/pi-provider-store.ts` / `pi-provider-repair.ts` / `__tests__/sanitize-invalid-providers.test.ts` / `extensions/model-switch/src/index.ts`（+189/−67）、untracked `chat-app/`、`extensions/model-switch/tests/switch-model.test.ts`。verifier 未触碰、未还原，仅记录。首跑 8 红与该并发修改（sanitize 域）直接相关，复跑全绿证实非 W3 问题。
2. **builder 基线数字过期（minor）**：自报 3185 基线是 3ded0d5fc 之前口径，正确基线 3192；最终数字仍闭合，不影响判定。
3. **attach-lifecycle「fork 路径」用例在 c) 注入期间出现一次 125s 超时红**：注入 c) 后整文件跑时 fork 用例超时（宽断言注入不影响该用例逻辑），判断为真实 pi 环境偶发超时；还原后同文件已 4/4 绿（见 V-CP1）+ 全量绿，不构成缺陷。

## 判定

0 major → **PASS**。
