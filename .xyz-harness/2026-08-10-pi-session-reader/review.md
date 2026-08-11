# pi-session-reader 设计文档对抗式审查报告

## Summary

**3 must-fix, 4 suggestions, 2 questions。**

最致命的三处（结论先行）：

1. **D-7 workflow-state 物理位置描述错误 + 双位置查询逻辑漏查真实落点**（P0-11/P0-12）。设计说 workflow-state 在 `~/.pi/agent` 顶层、要「双位置查 getAgentDir() 与 ~/.pi/agent」；实测 workflow-state 真实落在 `~/.pi/agent/sessions/<cwdSlug>/workflow-state/`，设计的两个查询位置**都不是**真实落点。更糟的是，主 session 的 `workflow-state-link` entry 的 `data.path` 字段**直接就是绝对路径**，根本不需要猜位置——D-7 把一个「读 link 字段」的简单问题，错设计成「双位置扫描」的复杂问题。
2. **38e029 session 体积/turn 数与设计声称严重不符，V2/V3 验收基线失效**（P0-14）。设计 §3.1 示例与 V2/V3 验收反复声称 `38e029` = 3.0MB / 26 turn / 1204 entry；实测 `38e029` = **452KB / 4 turn / 74 entry**。差距不是「快照漂移」能解释的（该 session compaction=0，未被压缩）。V2「26 行齐全」「≤2K token」、V3「token < read 一次的 5%」全部建立在这个不成立的前提上。
3. **V4 验收未覆盖 workflow 家族这条腿**（P0-13）。V4 标称「目标 2 家族追溯」，但只测了 family 的 fork + subagent 两条腿，D-7 重点设计的第三条腿（workflow-state-link → workflow-state → calls[].sessionFile）**没有任何验收场景**。

对 task prompt 第 4 点的明确回答：**D-7「硬编码 ~/.pi/agent」的前提成立，但 task prompt 的质疑方向有误**——详见 Finding 4。

---

## Findings

| 优先级 | 位置 | 维度 | 描述 | 修复方向 |
|--------|------|------|------|----------|
| MUST_FIX | §3.3 D-7 / 附录 P-workflow-dual | P0-11 事实 + P0-12 遗漏 | workflow-state 真实落点是 `~/.pi/agent/sessions/<cwdSlug>/workflow-state/`（实测 workflow-state-link.data.path 指向此处），不是 D-7 说的 `~/.pi/agent` 顶层；设计的「双位置查 getAgentDir() + ~/.pi/agent」**两位置都查不到真实文件**。且 workflow-state-link.data.path 已是绝对路径，无需猜位置 | family 算法优先读主 session 的 workflow-state-link entry → 拿 data.path 绝对路径直读；fallback 扫描才扫 `~/.pi/agent/sessions/<cwdSlug>/workflow-state/` + `~/.pi/agent/workflow-state/`（两可能位置，取决于 sessions/<slug> 当时是否存在） |
| MUST_FIX | §3.1 示例 / §4 V2 / §4 V3 / §2 噪音表 | P0-14 验收 | `38e029` 实测 452KB/4turn/74entry，与设计反复声称的 3.0MB/26turn/1204entry 严重不符；V2「26 行齐全」「≤2K token」、V3「对照组 read 一次 50KB」均建立在此假基线上，不可复现 | 选一个**稳定的、非活跃写入的**真实大 session 作为 V2/V3 固定样本（如 `019e6c96`，实测 5.4MB/1204entry），在验收表写死文件名+体积+turn 数快照；禁止用「正在审查本文档的 session」当样本 |
| MUST_FIX | §4 V4 | P0-13 验收覆盖 | V4 标称验证「目标 2 家族追溯」，只覆盖 fork 对 + subagent session，**未覆盖 D-7 重点设计的 workflow 家族链路**（workflow-state-link → workflow-state/<runId>.jsonl → calls[].sessionFile） | 新增 V4b：对本机真实跑过 workflow 的 session（如 `019fdcda`，实测含 workflow-state-link）跑 family，验证 workflow run 列出 + calls[].sessionFile 子代理 session 可达 |
| SUGGESTION | §3.3 D-4 / §2 | P0-11 事实（轻微） | D-4 称「read 工具用 `stripAtPrefix` 剥 @（path-utils.ts:41）」。实测 `stripAtPrefix` 是 `normalizePath` 的**选项**（`{stripAtPrefix: true}`），不是独立函数；:41 是 `resolveToCwd` 函数定义处。语义对（@ 前缀确实被 strip），但把选项名当函数名 + 行号指错 | 改为「normalizePath 在 stripAtPrefix:true 时剥 @ 前缀（path-utils.js:36）」；D-4 结论（# 跟随 @ 先例）不受影响 |
| SUGGESTION | §2 现状 | P0-11 事实（轻微） | 称「截断规则 core/tools/read.js:16-20」。实测 read.js:16-20 是 import 区，截断常量定义在 truncate.js（DEFAULT_MAX_LINES=2000 / DEFAULT_MAX_BYTES=50KB，truncate.js:10-11 精确属实）；read.js 只是 import 使用 | 截断规则引用只留 truncate.js:10-11，删 read.js:16-20 |
| SUGGESTION | §4 V5 | P0-13 通过标准模糊 | V5 通过标准「功能与 TUI 模式一致」无法证伪——「一致」缺可检查的等价点 | 改为可证伪标准：V5 下 agent 同样完成 find→outline→detail 三步且 outline 行数/turn 覆盖与 V2 同 session 一致 |
| SUGGESTION | §3.3 D-2 / P-leaf-view | P0-16 探针 | leafId 重置为最后 entry 的语义已实测属实（session-manager.js `_buildIndex()` :671-680 遍历设 leafId=entry.id），P-leaf-view 可从 ⛔ 升级为半验证 | 标注「_buildIndex 语义已验证（js:680），仅剩与 TUI /resume 肉眼比对待 M1」 |
| QUESTION | §3.3 D-7 | P0-12 边界 | D-7 称 subagent 用「尾行 identity + manifest 双源」。实测 subagent session 尾行 `subagent-identity` 的 `rootSessionId` 指向**直接父 session**（019fe635→019fe632），但 019fe632 是 fork 子代（其 parentSession→019fe620）。family 从主 session 019fe620 出发，如何关联到隔代的 subagent 019fe635？ | 明确 family 的 subagent 关联是按「rootSessionId 精确匹配本 session id」还是「rootSessionId 在本 session 的 fork 链上」；前者会漏隔代 subagent |
| QUESTION | §1 系统是什么 | P0-12 边界 | subagent session 文件有 `.jsonl` 和 `.jsonl.finalized` 两种后缀（实测 019fe635 目录下两种并存）。设计的发现层（M2 subagents.ts）是否区分？读 `.finalized` 文件会怎样？ | 明确 subagents.ts 的 glob 模式是否含 `.finalized`，及对该后缀的处理 |

---

## P0 逐项判定

### 结构与可读性

| # | 判定 | 依据 |
|---|------|------|
| P0-1 五段骨架 | **通过** | §1背景/§2现状/§3方案/§4验收/§5拆分 五段齐全 |
| P0-2 delta 链 | **通过** | 无 vN/Rxx/参见上版，自包含 |
| P0-3 结论先行 | **通过** | 开篇一句话结论；§2/§3.2/§3.3/D-1~D-8 首句均先给结论 |

### 内容主线

| # | 判定 | 依据 |
|---|------|------|
| P0-4 现状触根因 | **通过** | §2 不止说「体验差」，给出 4 个失败模式 + 噪音分布实测，根因落在「通用 read + 高噪音格式错配」 |
| P0-5 重实现轻体验 | **通过** | §3.1 先讲使用者 TUI 成功/失败路径，再讲方案对比；§2 有物理数据流图 |
| P0-6 术语有定义 | **通过** | entry/turn/leaf 路径/家族 四个核心术语在§2末尾集中定义并绑例子 |

### 方案对比

| # | 判定 | 依据 |
|---|------|------|
| P0-7 ≥2 方案 | **通过** | §3.2 列 A/B/C/D/E 五方案 |
| P0-8 长期+短期评估 | **通过** | 每方案「长期架构/短期成本/风险」三维度齐全 |
| P0-9 明确推荐 | **通过** | 明确选 D，被否方案有吸收/否决理由；C 还补了「若采用会怎样」的反例 |

### 对抗式核心三问

| # | 判定 | 依据 |
|---|------|------|
| P0-10 解决根因 | **通过** | D 方案的 7 action + # 通道正对 §2 四个失败模式（定位/噪音/翻页/家族）；D-5/D-6 是减法不是堆机制 |
| P0-11 关键事实正确 | **不通过** | D-7 workflow-state 位置错误（见 Finding 1）；D-4 stripAtPrefix、§2 read.js:16-20 表述瑕疵（见 Suggestion） |
| P0-12 副作用/遗漏 | **不通过** | D-7 双位置查询漏查真实落点 + 忽略 link.data.path 简案（见 Finding 1）；family 隔代 subagent 关联、.finalized 后缀未明（见 Question） |

### 验收（重点）

| # | 判定 | 依据 |
|---|------|------|
| P0-13 验收 testable | **不通过** | V4 未覆盖 workflow 家族（见 Finding 3）；V5「一致」标准不可证伪（见 Suggestion）。V1/V2/V6 本身 testable |
| P0-14 验收=单测/mock/假数据 | **不通过** | V2/V3 基线 session 38e029 的体积/turn 数与实测严重不符，验收建立在假基线上（见 Finding 2）。注：设计明确「单元测试不计入验收」「无需 mock」，方向正确，问题在样本数据失真 |
| P0-15 验收投入匹配 | **通过** | 6 个验收场景 + 对照组（V3），与「新 extension + 7 action + TUI 通道」的改动量匹配 |

### 层敏感

| # | 判定 | 依据 |
|---|------|------|
| P0-16 运行时断言有探针 | **通过** | 附录 A 9 个探针，✅/⛔ 标注清晰；⛔ 项有降级方案（如 P-hash-trigger 失败降级 /session 命令）。P-leaf-view 可半升级（见 Suggestion） |
| P0-17 物理数据流图 | **通过** | §2 有完整磁盘布局图 + 三条读取路径 |
| P0-18 错误有恢复指引 | **通过** | F1-F4 每个配 👉 具体恢复动作（换片段/加过滤/看存活成员/重看范围），不是「请检查」 |

---

## 关键事实核实记录（task prompt 要求 ≥5 项）

| # | 设计声明 | 核实结果 | 证据 |
|---|----------|----------|------|
| 1 | truncate.js:10-11 = 2000行/50KB | ✅ **精确属实** | `truncate.js:10 export const DEFAULT_MAX_LINES = 2000; :11 DEFAULT_MAX_BYTES = 50*1024` |
| 2 | session-manager buildSessionInfo 读全文（D-5） | ✅ **属实** | `session-manager.js:440 buildSessionInfo` 用 `for await (const line of rl)` 遍历整个文件提取 name/firstMessage/allMessages。支撑 D-5「不用 listAll() 建索引」 |
| 3 | leafId 重置为最后 entry（D-2，称 ts:894-897） | ⚠️ **行号偏移但语义属实** | `.js` 编译版 `_buildIndex()` 在 :671，:680 `this.leafId = entry.id`（循环内，最终=最后 entry）。ts:894-891 无法直接核对（只有 dist js），但「重置为最后 entry」语义验证通过 |
| 4 | subagent-identity 尾行含 rootSessionId（P-identity） | ✅ **完全属实** | tail 真实文件 `019fe635...jsonl`：`{"type":"custom","customType":"subagent-identity","data":{...,"rootSessionId":"019fe632-..."}}` |
| 5 | fork 对 019fe632→019fe620 真实存在（V4） | ✅ **属实，且跨 cwd 目录** | 019fe632.jsonl 首行 parentSession 指向 fix-cw-tool-wroktree 目录的 019fe620.jsonl。印证 fork 可跨 cwd 编码目录，family 全量首行扫描能覆盖 |
| 6 | 噪音分布 toolResult 75.3%（P-noise） | ⚠️ **量级属实，精确值因样本而异** | 实测另一个 5.4MB session：toolResult:text 72.2%，user:text+assistant:text 合计 <5%。方向与量级（toolResult 70%+，对话个位数）与设计一致；75.3% 是特定 3MB 样本值 |
| 7 | **D-7: workflow-state 硬编码 ~/.pi/agent（index.ts:168-173）** | ⚠️ **「硬编码」成立但「位置」描述错** | 见 Finding 4 详述 |
| 8 | read.js:16-20 是截断规则 | ❌ **不实** | read.js:16-20 是 import 区；截断规则在 truncate.js |
| 9 | stripAtPrefix 是 path-utils.ts:41 的剥 @ 函数 | ❌ **不实** | stripAtPrefix 是 normalizePath 的选项名（path-utils.js:36 `{stripAtPrefix:true}`），非独立函数；:41 是 resolveToCwd |

---

## Finding 4 详述：D-7 硬编码前提核实（回答 task prompt 第 4 点）

**结论：D-7「workflow-state 受硬编码影响，xyz-agent 下不在 xyz-agent 数据目录」的前提成立；但 task prompt 的质疑方向（「216 行 getAgentDir 动态推导，168-173 对不上」）把 subagents 域误当成 workflow 域，质疑不成立。同时，设计自身对 workflow-state 的「位置」和「查询方式」描述都是错的。**

### 前提成立的部分

subagent-workflow `index.ts` 确有两个不同的目录推导路径：

- **subagents 域**（:216）`const agentDir = getAgentDir();` —— 动态推导。xyz-agent 下 `getAgentDir()` 返回 `~/.xyz-agent/pi/agent`，subagent session 落到 `~/.xyz-agent/pi/agent/subagents/`。
- **workflow 域**（:168-173 `resolveSessionDir()` + :303 调用）—— 硬编码：
  ```ts
  function resolveSessionDir(): string {
    const defaultDir = path.join(os.homedir(), ".pi", "agent");           // :169 硬编码
    const sessionSlug = `--${process.cwd()...}--`;
    const sessionScopedDir = path.join(os.homedir(), ".pi", "agent", "sessions", sessionSlug);  // :171 硬编码
    return fs.existsSync(sessionScopedDir) ? sessionScopedDir : defaultDir;
  }
  ```
  `JsonlRunStore` 的 stateDir = `<resolveSessionDir()>/workflow-state/`（`jsonl-run-store.ts:224`）。

因为主 session 标准布局就在 `~/.pi/agent/sessions/<slug>/` 下，`sessionScopedDir` 几乎总是 exists，所以 resolveSessionDir 几乎总返回 `~/.pi/agent/sessions/<slug>`，**workflow-state 实际落在 `~/.pi/agent/sessions/<cwdSlug>/workflow-state/`**。xyz-agent 进程内跑 workflow 时，由于 resolveSessionDir 硬编码 `~/.pi/agent`（不读 getAgentDir），workflow-state 仍然落到 `~/.pi/agent/...` 而非 `~/.xyz-agent/...`。

**实测铁证**：主 session 的 `workflow-state-link` entry 的 `data.path` 字段直接写着：
```
/Users/zhushanwen/.pi/agent/sessions/--Users-zhushanwen-Code-coding-workflow-workspace-fix-cw-cli-guidance-cw-tool--/workflow-state/wf-1786121304924-r7vgov.jsonl
```
即 `~/.pi/agent/sessions/<slug>/workflow-state/`，**不是** `~/.pi/agent/workflow-state/`（顶层）。

### 设计错在哪里（P0-11 + P0-12）

1. **位置描述错**：D-7 说「workflow-state 目录硬编码 ~/.pi/agent」——读者会理解为 `~/.pi/agent/workflow-state/`（顶层）。实测真实落点是 `~/.pi/agent/sessions/<cwdSlug>/workflow-state/`（子目录）。
2. **双位置查询逻辑漏查**：D-7/P-workflow-dual 说「双位置查 getAgentDir() 与 ~/.pi/agent」。但：
   - `getAgentDir()/workflow-state/`（= `~/.xyz-agent/pi/agent/workflow-state/`）—— 实测 NOT FOUND
   - `~/.pi/agent/workflow-state/`（顶层）—— 实测 EXISTS，但那是 fallback 情况（sessions/<slug> 不存在时）的产物
   - **真实常态落点 `~/.pi/agent/sessions/<cwdSlug>/workflow-state/`——设计的「双位置」完全没覆盖**
3. **忽略了现成的简案**（最严重）：workflow-state-link entry 的 `data.path` **已经是绝对路径**。family 算法只需读主 session 的这个 entry → 拿 path 直读，根本不需要 resolveSessionDir、不需要双位置猜、不需要 P-workflow-dual 这个检查点。D-7 把「读一个字段」错设计成「扫描多个候选目录」。

### task prompt 质疑为何不成立

task prompt 称「`src/index.ts:216` 用 `getAgentDir()` 动态推导，且行号 168-173 对不上」。核实：
- :216 的 `getAgentDir()` 属于 **subagents 域**（SubagentService/ModelConfigService/WorktreeManager 用），**不影响** workflow-state 位置。
- :168-173 的 `resolveSessionDir()` 确实存在且**确实硬编码** `~/.pi/agent`，直接决定 workflow-state 落点。
- 所以「168-173 对不上」不成立——行号对得上，硬编码也真实存在。

**但 task prompt 的质疑启发了更深层的核实**，从而发现设计「双位置」描述本身的错误。对抗式审查的价值正在于此：即便质疑方向有误，逼着去读源码也会逼出真问题。

---

## 「方案看起来成立但实施会翻车」的三个具体风险点

### 风险 1：family 的 workflow 关联用「双位置扫描」会查空（Finding 1 后果）
实施 M2 `subagents.ts` 按 D-7 写双位置扫描（getAgentDir + ~/.pi/agent），xyz-agent 下两个位置都查不到真实 workflow-state 文件（真实在 `~/.pi/agent/sessions/<slug>/workflow-state/`）。结果：family 对 workflow run 永远返回空，D-7 的整条 workflow 家族链路静默失效。**修复**：优先读 workflow-state-link.data.path。

### 风险 2：find/family 首行扫描遇上超大首行或损坏文件
D-5「只读每个 .jsonl 第 1 行建索引」假设首行一定是 session header 且体积可控。反例：(a) 历史上 EEXIST 坏 session（AGENTS.md 规则 6 记载）首行可能不是合法 JSON；(b) 若某文件首行异常巨大（理论 header 不该大，但损坏文件无保证）。设计的 `parser.ts`「坏行跳过计数」只针对全文解析，**首行扫描层（family.ts）的容错未提**。**修复**：首行扫描同样加 try/catch + 体积上限，损坏首行不阻塞整个索引构建。

### 风险 3：P-open-active（活跃 session 读取）未验证就依赖它做「快照语义」
§1 In/Out Scope 写「读取是快照语义」，D-6「不做缓存每次重读」。但 pi 的 SessionManager 对活跃 session 是 append-only 写入，读取方用 `createReadStream` 并发读时，若 pi 正好在 flush 大量 entry，可能读到**半行 JSON**（write 非 atomic）。P-open-active 标 ⛔ M3 前验证，但设计在 §1 已经把「快照语义」当既定前提用了。若 P-open-active 失败（读到半行），parser 的「坏行跳过」会静默丢 turn，outline 凭空少几轮，agent 浑然不觉。**修复**：parser 对「最后一行解析失败」要特殊标注（`[最后 1 行可能正在写入，已跳过]`），不能与中间坏行同等静默跳过。

---

*审查依据：rubric-design-doc.md（P0-1~18 / P1-1~7）。所有源码事实核实自 `node_modules/@earendil-works/pi-coding-agent/dist/`（编译产物 .js/.d.ts）与 `~/.pi/agent/npm/node_modules/@zhushanwen/pi-subagent-workflow/src/`（.ts 原文），以及 `~/.pi/agent/sessions/` + `~/.pi/agent/subagents/` 真实 session 文件实测。*
