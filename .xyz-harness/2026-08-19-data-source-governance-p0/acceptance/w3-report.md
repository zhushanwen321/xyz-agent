# W3 验收报告：R1 pi 文件直写 pre-commit 检查（verifier 独立验收）

> 验收时间：2026-08-19 · 验收基线 commit：2dc3c443c · 工作分支：fix-chat-flow-order
> 验收权威：w3-acceptance.md + docs/architecture/data-source-governance-plan.md §2 W3 节（L145-170，r4/r5/r6 冻结）
> 方式：对抗式独立实跑（builder 自报逐项复核 + 探针实测，全部探针用后即删）

## 总结论：PASS

## 0. 防篡改与越界

| 项 | 结果 |
|----|------|
| `git diff 2dc3c443c -- .xyz-harness/.../w3-acceptance.md` | 空（未篡改） |
| `git diff 2dc3c443c -- docs/architecture/data-source-governance-plan.md` | 空（未篡改） |
| w3-acceptance.md sha256 | `4bc53ece8f5c029d55fce335e8c1660ecea6d42509f2201bf834fa0d0e340ebe` |
| data-source-governance-plan.md sha256 | `f76097ed3055fd88b6d29e6bdbcc0c5216d78e0dc14e105519ca6795cc1f06c4` |
| check_pi_direct_write.py sha256 | `fc65ac71d504da7e43e6da544130559935e715341244921c9f19887eb032d901` |
| install-hooks.sh sha256 | `d0561e37cef5f9c535886f64b18b7540cccdbcad6a71211f440554f4b72c1918` |
| `git status -uall` 越界扫描 | 无越界。工作区 = W3 两交付文件 + ledger.md（主 agent 豁免）+ taste-lint/*（W4 领地豁免）+ w4-report.md（并行 W4 verifier 产物，验收期间出现，非本验收改动） |

## 1. 通过命令实跑（验收「通过命令」4 条）

### 1.1 检出力 — PASS
- 探针：`packages/runtime/src/services/session/__w3_probe_detect.ts`（appendFileSync(join(getSessionsDir(), 'x.jsonl'), '')）
- 结果：exit 2，输出 `[ERROR] .../__w3_probe_detect.ts:5: 检出对 pi session JSONL 本体的直写候选（appendFile(Sync)）...` + 恢复动作「改经 pi RPC 或扩展 appendEntry；若为登记例外，先在 docs/architecture/data-source-registry.md 补条目 + 本脚本 ALLOWLIST 登记」
- 文件路径 ✓ registry 指引 ✓ 恢复动作 ✓；删除探针后 exit 0 ✓

### 1.2 回归 — PASS
- `grep -c "CHECKER=" "$(git rev-parse --git-common-dir)/hooks/pre-commit"` = **17**（改前 16，+1）✓
- `bash -n .githooks/install-hooks.sh` 通过 ✓；生成体 pre-commit `bash -n` 通过 ✓
- R1 段 heredoc 与生成体逐字一致（精确段 diff：IDENTICAL）✓
- 幂等性：重跑 `bash .githooks/install-hooks.sh` 后生成体 sha256 不变、CHECKER= 仍 17 ✓

### 1.3 allowlist — PASS
- 当前 HEAD：exit 0，扫描 239 文件，allowlist 生效 3 处：`session-file-utils.ts:430 / :467 / :543` — builder 自报与实测完全一致
- grep 实测（`grep -rn "persistSessionName\|persistHandedOff\|patchSessionCwd" packages/runtime/src --include="*.ts"`，排除注释/测试/interface 声明/import/re-export 转发）代码命中 = 3 实现本体 + 3 调用点（session-lifecycle.ts:331 非活跃 rename / :434 restoreSession / session-service.ts:1076 handoff）
- 对照规格预期清单 4 条链路写点（persistSessionName 本体 + 非活跃调用点 + persistHandedOff 本体 + patchSessionCwd 本体）：ALLOWLIST 4 条一一对应，**无多登无漏登**；行号逐处核实为真实写调用/调用点行：
  - :430 `openSync(filePath, 'a')` ✓（:417 persistSessionName 本体内）
  - :467 `openSync(filePath, 'a')` ✓（:455 persistHandedOff 本体内）
  - :543 `atomicWrite(filePath, ...)` ✓（:521 patchSessionCwd 本体内）
  - :331 `this.sessionStore.persistSessionName(target.filePath, ...)` ✓（非活跃 rename 调用点）
- allowlist 4 条均带 `# 移除期限: W11` 注释 ✓；:434/:1076 调用点与 ports interface / session-store 转发层不属写点，不需登记（非写调用形态）✓

### 1.4 生成体 R1 段结构 — PASS
- :573 注释头（`# R1 pi session JSONL 直写检查（data-source-governance P0.3）`）✓
- :579 变量（`PI_DIRECT_WRITE_CHECKER=".githooks/check_pi_direct_write.py"`）✓
- :588 python3 调用 ✓
- exit 映射：checker exit 2 → pre-commit `exit 1`（`-eq 2` 精确匹配，与既有 PATH_WHITELIST/TOOL_SCHEMA 段同款模式）✓
- 失败报错含 `docs/architecture/data-source-registry.md` 路径 ✓

## 2. 真实性抽查（对照 plan W3 冻结规格）

| 条款 | 探针/实况 | 结果 |
|------|-----------|------|
| 条件 A 注释剥离 | 探针：sessions 痕迹仅在 `//`/`/* */` 注释 + 普通字符串文案（"see sessions dir"），真实 writeFileSync('/tmp/...') | 不命中 ✓（剥离真实存在；扫描数 239→243 差值吻合：5 探针中 4 进扫描、.test.ts 排除不计） |
| B① sidecar 内联形态 | 探针 `writeFileSync(filePath + '.meta.json', '{}')` + getSessionsDir 语境 | 豁免 ✓ |
| B① sidecar helper 形态 | 探针 `writeFileSync(projectSidecarPath(filePath), '{}')` + getSessionsDir 语境 | 豁免 ✓ |
| B② tmpdir 单跳链 | 探针 `const tmpFile = join(tmpdir(), ...)` → `writeFileSync(tmpFile, '')` + getSessionsDir 语境 | 豁免 ✓ |
| B② 防线（含 sessions 痕迹的豁免语句不放过） | 探针 `const p = join(tmpdir(), 'sessions')` → `writeFileSync(p, '')` | **命中报错** ✓（「语句含 sessions 痕迹则不豁免」守卫实测生效） |
| 测试排除 | 探针 `__w3_probe_exclusion.test.ts`（真实直写 + getSessionsDir） | 不进扫描 ✓；`__tests__/` 目录 10 个实测存在被排除；`*.spec.*` 当前零文件（分支防御性） |
| session-lifecycle 两 tmpdir 写 | 实况 :463→:464、:622→:623（plan 写作时 :435/:594，行号漂移机制不变），单跳 tmpdir 链 | B② 豁免 ✓ |
| session-service 附件/配置写 | 实况 :1415/:1497（plan 写 :1436/:1518 漂移）；文件 sessions token 全部为注释 / `sessions` Map 标识符 / `'config.sessions'` 消息文案（无引号独立 token、无路径构造语境） | 条件 A 不命中，不进候选 ✓ |
| 检出边界声明（session-fork.ts） | 实况：全文件 `getSessionsDir`/`'sessions'`/`'sessions/'` 零匹配（:63 裸 token 在 JSDoc，非引号非路径段）；:175 writeFile 形参间接 | docstring 声明与实况一致 ✓ |
| docstring 差异声明 | 与参照 check_path_whitelist.py 全文 re.search 的差异有「有意设计」声明；main 结构/docstring 体例对齐参照（PROJECT_ROOT/import/退出码格式） | 在位 ✓ |

## 3. 行为对抗抽查（4 条，探针均用后删）

| 绕过尝试 | 结果 |
|----------|------|
| `appendFile(...)`（无 Sync 后缀，回调形态） | 命中 ✓ |
| `writeFileSync(...)` | 命中 ✓ |
| `atomicWrite(...)` | 命中 ✓ |
| 模板字符串形态 `` `${root}sessions/x.jsonl` `` | 命中 ✓（TRACE_PATTERNS backtick 分支） |
| `join(tmpdir(), 'sessions')` 借 tmpdir 通道 | 命中 ✓（见上 B② 防线） |

误报边界复核：scripts/ 下未被排除的 4 个含写文件（generate-manifest.sh / bundle-extensions.mjs / apply-version.sh / visual-capture.mjs）sessions 痕迹计数 0，条件 A 不命中——排除规则未掩盖它们。其余 atomicWrite 调用文件（agent-crud / session-data-store / plugin-storage / json-store）剥离注释后 sessions 代码语境为 0，同因不进候选。auth-storage.ts:93 `openSync(tmpPath, 'w')` 文件零 sessions 痕迹，不进候选。

## 4. 三项裁决

### 裁决 1：scripts/ verify-* / *-e2e.* 排除延伸 — 认可（政策性排除，长期方案）
实况：verify-scheduler-e2e.cjs:127 `sessionDir: path.join(root, 'sessions')`（root = mkdtempSync(tmpdir())，真实代码语境痕迹）+ :864 `writeFileSync(legacyPath, ...)`，legacyPath 经 `getLegacyStorePath(cwd)` 推导 = `~/.pi/agent/scheduler/<segments>/`（legacy scheduler store 迁移测试的**预置数据**，非 pi session JSONL 本体，非 xyz 自有目录推导函数）。
三选一分析：
- B② 枚举 getLegacyStorePath：把 e2e 脚本局部函数塞进全局 NON_SESSIONS_DERIVATIONS（语义 = xyz 自有目录推导），污染枚举语义，且 `~/.pi/agent/scheduler/` 并非 xyz 自有目录——不可取；
- allowlist 登记：allowlist 语义 = 三条 legacy 直写链路 + W11 期限（W11 清空），混入测试 harness 写点稀释语义且 W11 清空语义错位——次优；
- 政策性排除（builder 选择）：与规格 r5「测试构造数据的写点非生产写路径，排除是政策性正确」同一政策在 scripts/ 侧的延伸。该脚本本就是 spawn 真实 pi CLI 的端到端 harness，写点全在 tmpdir 临时工作区或 legacy store 预置。
影响面实测：9 个被排除 verify/e2e 文件中 8 个 sessions 痕迹为 0（排除冗余无害），排除的必要面 = 仅 verify-scheduler-e2e.cjs——与 builder docstring 声明一致。docstring 已声明 + builder 已上报主 agent，处置正确。
残余风险（记录不判 FAIL）：未来 scripts/ 下新增 `verify-*` 前缀的生产写路径会被排除；以本仓 verify- 前缀语义（验证 harness）衡量风险低，W11 收口时可复核。

### 裁决 2：atomicWriteAsync 同族变体收口 — 认可（防御性收口）
实测：`atomicWriteAsync` 全仓（packages/ + scripts/ + extensions/）仅 1 处 = fs-utils.ts:28 定义本体，零调用方。WRITE_CALL_PATTERNS 纳入该变体无掩盖风险（不豁免任何现存代码），防未来 async 上下文绕过——正确的前瞻防御，非投机功能。

### 裁决 3：install-hooks.sh 100644 无执行位 — 接受（既存事实，无功能影响）
实测 `-rw-r--r--`。本仓调用方式均为解释器显式调用（pre-commit 内 `python3`、验收用 `bash .githooks/install-hooks.sh`），执行位非功能必要；且为 W3 之前的既存状态（非本 wave 引入），不在 W3 改动范围（规格禁改清单限定只改 R1 段）。留待单独 chore 处理。

## 5. 观察项（不构成 FAIL，供后续 wave 参考）

1. **allowlist :331 结构性死条目**：调用点行（`this.sessionStore.persistSessionName(...)`）不是写调用形态，永不匹配 WRITE_CALL_PATTERNS，故该条目永不被消费（生效仅 3 处）。此为规格验收 4 预期清单自身要求（4 条含调用点），builder 按规格登记且自报如实（「生效 3 处」）。脚本对「未消费 allowlist 条目」无告警——若未来行号漂移，漂移写点会以误报（exit 2）显形，故无静默通道；建议 W11 清空 allowlist 时顺带评估是否保留调用点登记形态。
2. **openSync flag 变体不在检出范围**：`'a+'`/`'ax'`/`'w+'` 等不命中（探针实测 'a+' 不报）。规格冻结清单仅 `openSync('a'/'w')`，当前扫描范围内真实用法仅 'r'/'a'/'w'（实测清点），无现实穿透。规格级边界，如实记录。
3. **checker 异常退出静默通过**：python 语法错误等 exit 1（非 2）在 pre-commit 段走「通过」分支。与既有 PATH_WHITELIST/TOOL_SCHEMA 段完全同款模式（`-eq 2` 精确匹配），非 W3 引入偏差，全体系一致行为，如需收紧应整批处理。
4. plan 引用行号漂移（session-lifecycle :435→:464、:594→:623；session-service :1436→:1415、:1518→:1497；allowlist 注释「行号为 W1 后实测」已在脚本内保持当前准确值）——机制判定不受影响，plan 行号按其性质为写作时快照。

## 6. 探针清理与状态恢复

全部 10 个探针文件（检出力 1 + 对抗组 4 + 豁免组 5）用后即删；`git status -uall` 终态与开始一致（差异仅 w4-report.md，系并行 W4 verifier 产物）。verifier 未修改任何被跟踪文件、无 git 写操作（install-hooks.sh 重跑一次为规格允许的幂等性验证）。验收期间 HEAD = e411a010fcd4ab2c4be8d01ac08e71f9deef4139。
