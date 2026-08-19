# W3 验收基线：attach 护栏报警器 + tmp-migrate 残留清理（restore-fork-attach-fix 审查遗留）

> 防篡改验收基线，builder/verifier 禁止修改。创建：2026-08-19 23:50（主 agent）。
> 背景：主 agent 对 restore-fork-attach-fix（668273adb + ec38e546f）的第三视角审查（会话 2026-08-19 23:40，用户裁决「剩余问题都修复，再跑一轮测试」）确认修复合理，两项遗留：

## 问题定义

1. **I1 护栏的静默失效面**：`packages/runtime/src/infra/pi/session-attach-assert.ts` 跳过分支 2——pi `get_state` 无 `sessionFile` 字段时 `console.warn` 后跳过断言。护栏有效性完全依赖 pi 持续提供该字段；若未来 pi 升级改字段名/形态，断言**永远静默跳过**（恢复到修复前「分裂无人察觉」状态），护栏失效本身无报警器。
2. **`.tmp-migrate-*.jsonl` 崩溃残留无清理**：`normalizeSessionFileInPlace` 在 writeFileSync(临时名) 后、renameSync 前崩溃会残留临时文件；`isScannableSessionFile` 已排除（不错位附着），但残留永久留在 sessions 目录积累（磁盘垃圾 + 排查困惑源）。

## 目标

1. **护栏报警器（问题 1）**：`packages/runtime/src/__tests__/equivalence/attach-lifecycle.test.ts` 的 REAL_PI_READY describe 内新增用例——真实 pi 附着成功后 `get_state()` 返回的 `sessionFile` **必为非空 string**（断言 typeof === 'string' && length > 0）。pi 升级改变字段形态时该用例先红，跳过分支 2 的前提在契约层被拦截。
2. **残留清理（问题 2）**：`session-file-utils.ts` 新增 `cleanupTmpMigrateResidue(sessionsDir, maxAgeMs)`——删除 sessions 目录下 mtime 早于 maxAgeMs 的 `.tmp-migrate-*.jsonl`；**新鲜残留（< maxAgeMs）不删**（防并发误删：正在进行的归一化临时文件必然秒级新鲜，S3 交错窗口不扩大）。接线点 = runtime 启动链（builder 探索：migration gate / sessionStore 初始化 / 首次 scan 前三者选最贴合既有结构的一处，报告说明选择理由）。默认阈值 ≥ 1 小时。
3. **端到端残留用例（问题 2 配套）**：fixture 目录构造「同 id 正式文件 + `.tmp-migrate-` 残留」→ `scanPiSessions` 不收录残留（不只 isScannableSessionFile 单元，走全链路枚举）→ 清理函数删除过期残留、保留新鲜残留。vitest 单测（不需要真实 pi）。

## 领地（越界即 rejected）

- `packages/runtime/src/infra/pi/session-file-utils.ts`（清理函数；禁改既有函数行为）
- 接线点 1 处（builder 探索确定，限 runtime 启动/初始化域）
- `packages/runtime/src/__tests__/equivalence/attach-lifecycle.test.ts`（追加用例）
- 新增或追加测试文件（`packages/runtime/test/` 或 `src/**/__tests__/`，沿既有放置约定）

## 验收检查点（全部可证伪）

- CP1: 新契约用例存在且通过（本地真实 pi 可跑时实跑；REAL_PI_READY=false 环境显示 skip 理由）；断言强度 = 非空 string（非 truthy 宽断言）。
- CP2: 清理函数：过期残留删除 / 新鲜残留保留 / 无残留目录 no-op 安全 / 非 sessions 目录内容零触碰——四态测试全过。
- CP3: 端到端用例：残留不进 scanPiSessions 结果 + 正式文件条目正常。
- CP4: `cd packages/runtime && pnpm exec vitest run` 全绿（基线 3185 + 新增）；`tsc --noEmit` exit 0。
- CP5: `python3 .githooks/check_pi_direct_write.py` exit 0（清理函数是 unlink 不是写，不应触发；若触发按 R1 规约处理）。
- CP6: 防篡改：`.xyz-harness/**` 零改动；`git status` 范围与领地一致。
- CP7: 接线点选择理由 + 对既有启动链的影响（同步阻塞 or fire-and-forget）在交付报告说明；清理失败（权限等）不得阻断启动。

## 禁止事项

- 禁 git 写；禁动 restoreSession/forkSession/renameSession/normalizeSessionFileInPlace 既有行为；禁 `--no-verify`/`SKIP_*`；禁推测性功能（不做「残留文件抢救数据」——登记表已裁决孤儿不抢救，清理就是删除）。
