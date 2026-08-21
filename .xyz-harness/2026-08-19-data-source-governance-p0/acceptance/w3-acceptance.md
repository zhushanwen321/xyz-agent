# W3 验收标准：R1 pi 文件直写 pre-commit 检查

> **防篡改声明**：本文档与 `docs/architecture/data-source-governance-plan.md` §2 W3 节（L145-170，基线 commit 见 ledger）是 W3 的验收权威。builder 与 verifier 禁止修改两者。
> 规格 SSOT = plan W3 节全文（条件 A/B 匹配粒度、allowlist 机制、接入机制已逐字冻结，r4/r5/r6 三轮审查修订成果全部在位）；本文档只做锁定提炼。两者冲突时以 plan 为准并上报主 agent。
> **前置依赖**：W2 已 committed（allowlist 内容以登记表 legacy 例外为据）。

## 目标（一句话）

`git commit` 时机器拦截「runtime/scripts 代码对 session JSONL pi 本体的写操作」，报错指向 `docs/architecture/data-source-registry.md` 条目。

## 交付物

1. `.githooks/check_pi_direct_write.py` [新增]
2. `.githooks/install-hooks.sh`（修改：heredoc 生成的 pre-commit 里追加 R1 段，对齐 PATH_WHITELIST_CHECKER 段结构）

## 核心规格锁定（plan W3 步骤 1-4，逐条可查）

1. **扫描范围**：`packages/runtime/src/` + 仓库根 `scripts/`；排除测试文件（`__tests__/` 目录、`*.test.ts`、`test/` 目录）。
2. **匹配粒度两必要条件（r5 落文件级定义）**：
   - 条件 A（圈定候选）：写调用（`openSync('a'/'w')` / `appendFile(Sync)` / `writeFile(Sync)` / `atomicWrite`）所在文件含 sessions 路径推导痕迹——`getSessionsDir` import/调用或 `sessions` 出现在路径构造语境（`join(…, 'sessions', …)`、`'sessions/'`）；注释与普通标识符不计入；匹配前剥离注释行（对齐 W11 验收 1 的注释感知 grep 语义；与参照实现 check_path_whitelist.py 全文 re.search 的差异为有意设计，docstring 写明）。
   - 条件 B（内置豁免，写目标路径层级判定）：① sidecar 家族四后缀（`.meta.json`/`.preset.json`/`.project.json`/`.handoff.json`）——内联形态（`filePath + '.meta.json'`）与 helper 形态（`projectSidecarPath()`/`presetSidecarPath()` 间接形态）都必须覆盖；② 非 sessions 目标——写目标表达式可见地经 `tmpdir()` 或 xyz 自有目录推导函数（getAttachmentsDir/getConfigDir 等，脚本内枚举清单）构造则豁免。
3. **allowlist**：脚本内置 `ALLOWLIST` 数组，初始条目 = 执行时三条 legacy 直写链路的全部真实写点（persistSessionName 实现本体 + 非活跃调用点 / persistHandedOff 本体 / patchSessionCwd 本体），以 `grep -rn "persistSessionName\|persistHandedOff\|patchSessionCwd" packages/runtime/src --include="*.ts"` 排除注释与测试的命中为准逐一登记，严格相等（多登 = 掩盖未登记写方，漏登 = 误报，都算验收失败）；每条带 `# 移除期限: W11` 注释（新约定写进 docstring）。
4. **install-hooks.sh 接入**：heredoc 追加 R1 段（print_section → python3 调用 → 非 0 退出报错指向 registry）；改完必须重跑 `cd .githooks && ./install-hooks.sh`。
5. **报错文案可操作**：违规文件:行号 + 恢复动作（「改经 pi RPC 或扩展 appendEntry；若为登记例外，先在 data-source-registry.md 补条目 + 本脚本 allowlist 登记」）。
6. **docstring**：检出边界诚实声明（目标路径经形参间接且整个文件无代码语境 sessions 痕迹的写点不命中——session-fork.ts:175 即此形态，守卫 = 登记表创建型声明 + S1 语义层）；main 结构与 docstring 体例对齐 check_path_whitelist.py。

## 通过命令（builder 自验 + verifier 实跑）

1. 检出力：临时在 `packages/runtime/src/services/session/` 新建含 `appendFileSync(join(getSessionsDir(), 'x.jsonl'), '')` 的文件 → `python3 .githooks/check_pi_direct_write.py` exit 非 0 且输出含文件路径与 registry 指引；删除后 exit 0。
2. 行为级（场景 4② R1 部分）：测试分支新增直写并 `git add` → `git commit` 被 pre-commit 拦截（输出含 check_pi_direct_write 段）；revert 后 commit 通过。
3. 回归：`install-hooks.sh` 重跑后 `grep -c "CHECKER=" "$(git rev-parse --git-common-dir)/hooks/pre-commit"` 比改前多 1；`bash -n` 通过（heredoc 与生成体一致且可执行）。
4. allowlist 验证：当前 HEAD 下 `python3 .githooks/check_pi_direct_write.py` exit 0，且 allowlist 条目与上述 grep 代码命中一一对应（plan W3 验收 4 全套可达性论证：条件 A 命中集 = session-file-utils 三 legacy 写点由 allowlist 覆盖；同文件三 sidecar 写点经四后缀豁免；session-lifecycle 两 tmpdir 写经非 sessions 目标豁免；session-service 附件/配置写所在文件零代码语境痕迹不进候选；测试不进扫描——无「必命中且无豁免」残留）。

## 禁改清单（越界 = 验收失败）

- 两个验收权威文档（w3-acceptance.md / data-source-governance-plan.md）
- 任何 packages/ 下代码（W3 是纯护栏 wave，生产代码零改动；发现需要改生产代码 = 规格冲突，停下上报）
- `.githooks/` 既有 checker 文件（只新增 check_pi_direct_write.py + 修改 install-hooks.sh）
- 禁止 git add/commit/push（install-hooks.sh 重跑生成到 git-dir hooks/ 不算 git 写操作，允许）

## 备注

- 派发前置：W2 committed（registry 存在，allowlist 条目与登记表例外一致）。
- 完成后 W4 可并行（领地：.githooks/ vs taste-lint/）。
