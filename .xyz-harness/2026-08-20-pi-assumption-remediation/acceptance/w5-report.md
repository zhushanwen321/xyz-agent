# W5 验收报告：core images 双修 + R1 createWriteStream 缺口

- **结论：PASS**（全部验收条款 C1-C4 通过；2 项已知边界登记，不阻塞）
- 验收对象：builder 交付的工作区未提交改动（基线 commit `899157062` 之后）
- 验收基线：`w5-acceptance.md`（同目录）
- 验收人：verifier subagent（对抗式），2026-08-20

## 1. 防篡改 + 越界扫描 — PASS

工作区改动 15 M + 2 untracked，逐一归属核对：

| 文件 | 归属 | 核对结果 |
|------|------|---------|
| `packages/core/src/domain/chat/apply-entry.ts`（+51/-7） | **W5** | images 提取 / user image part / PiContentPart data+mimeType / computeToolCallFill+applyEntry 透传，全部对应基线条款 1、2；文件头分叉注释登记「images 差异已消除」 |
| `packages/core/src/domain/chat/__tests__/apply-entry.test.ts`（+88） | **W5** | 4 个新用例（user image / user 无 image / toolResult image / toolResult 纯 text）+ readImagesField 窄化 helper |
| `.githooks/check_pi_direct_write.py`（+16/-3） | **W5** | WRITE_CALL_PATTERNS + TARGET_ARG_RE 补 createWriteStream；docstring 两段更新 |
| `extensions/subagent-workflow/src/execution/types.ts`（2 注释行） | **W5** | 版本标签 0.84.0→0.84.2 + 锚点行号 :106-113→:108-111，与自报一致 |
| AGENTS.md / docs/adr/0063 / docs/troubleshooting.md / pi-protocol.ts / rpc-client.ts | W6 豁免 | diff 全为 pi 语义权威源规则 / 观察项登记 / A-10、A-11 探针注释，无 W5 语义混入 |
| subagent-workflow interface/orchestration 5 文件 + 新测试 | W4b 豁免 | diff 全为 throw 语义（pi 只对 execute throw 置 isError），无 W5 语义混入 |
| `chat-app/`（untracked） | 豁免 | 未跟踪目录，不在验收面 |

无越界、无基线外文件触碰、无 allowlist 篡改（`ALLOWLIST: set[str] = set()` 维持空）。

## 2. 命令套件 — PASS（C3/C4）

| 命令 | 结果 |
|------|------|
| `cd packages/core && pnpm test` | 80 文件 / **1028 passed** + 6 todo，0 failed |
| `cd packages/runtime && pnpm typecheck` | tsc --noEmit 零输出（通过） |
| `pnpm extensions:typecheck` | tsc --noEmit 零输出（通过，含 types.ts 改动包） |
| `python3 .githooks/check_pi_direct_write.py` | exit 0，扫描 240 文件，allowlist 命中 0 |

## 3. images 双修行为级验证 — PASS（核心）

### 3.1 双实现逐行为对照（探针 A，tsx 实跑，21 断言全 PASS）

core 版 `normalizePiToolResult`（apply-entry.ts:170）与 runtime 版（normalize-tool-result.ts:45，W1 深模块 = 权威语义）对以下形态在 output/outputRaw/images 三字段 deepEqual 全等：

- text-only / image-only / 混合（image 不混入文本 join）/ 双空块过滤（`data:"" mimeType:""` 丢弃、单非空保留）
- 非法组合：`{type:'image'}` 无字段（String 归一后双空 → 过滤）；`data:123, mimeType:null`（→ `{data:'123', mimeType:''}` 保留）；`data:'', mimeType:'x'`（保留）
- 三态回归：string（ANSI 剥离 + outputRaw）/ 无 content 对象（JSON.stringify）/ null / undefined

语义断言（runtime 版为期望源）8 条全 PASS。剩余分叉仅 details 字段（core 版由 computeToolCallFill 独立处理，文件头注释已登记）——不在基线对齐面，合规。

### 3.2 readImagesField 恒真陷阱排除 — PASS

测试 helper 非恒真，探针实证四种坏形态全部使断言变红：无字段 → undefined（实现丢 images 时 `toEqual([...])` 红）；非数组形态（字符串）→ undefined（拒绝）；空块未过滤产物 / 错值产物 → ≠ 期望值（toEqual 红）。红性验证（§5）进一步实证了这一条。

### 3.3 类型面 + 可达性（pi 实装核对，node_modules 权威源）

- pi-ai 0.82.1 实装 `types.d.ts`：`ImageContent = { type:"image", data:string, mimeType:string }`（:239）；`UserMessage.content: string | (TextContent | ImageContent)[]`（:276）；`ToolResultMessage.content: (TextContent | ImageContent)[]`（:297）。PiContentPart 补 `data?/mimeType?` 与实装形态一致。
- user 通道可达性：pi-coding-agent `agent-session.js:1021/:1037` `content.push(...images)`——prompt/steer/followUp 带 images 时 UserMessage.content 数组含 base64 ImageContent，session JSONL 落盘即此形态。builder 注释「extension sendMessage images 通道可达」成立。
- toolResult 通道形态：`utils/tool-result-images.js` 归一化后 `normalized.push({ type:"image", data:<base64>, mimeType })` 原样进 history——core 提取形态精确对应。

## 4. live≡replay 恢复断言 — PASS（C1，设计 V6 的 CI 半边）

探针 B（tsx 实跑 replayEntries 全链：applyEntry → toolResult 分支 → computeToolCallFill → normalizePiToolResult），输入为 pi 真实 wire 形态（PiMessageEntry 镜像：ISO timestamp / parentId 链 / uuid 风格 id）：

- user → assistant(toolCall) → toolResult(text+image) 三 entry 重放：产出 user + assistant 宿主 2 条消息（toolResult 不另立），toolCall `status:'completed'`、`output:'screenshot attached'`（image 不混入）、**`images:[{data:'aVdpbmFUNw==', mimeType:'image/png'}]` 存活**。
- user image part 链：text part 照常转 Segment，`images:[{data:'dXNlcg==', mimeType:'image/jpeg'}]` 字段存活。
- live 半边等价性由 §3.1 双实现 deepEqual 保证（event-adapter 与 reducer 消费同语义归一）。

（探针首轮曾误报 2 条消息为异常，诊断为探针自身断言错误——reducer 语义本就是 user/assistant 各自成消息、toolResult 回填 assistant 宿主；实现无 bug。）

## 5. R1 createWriteStream 独立探针 — PASS（C2，4 用例 + 2 攻击变体）

importlib 直调 `check_file`（模拟仓库根隔离运行，未触碰真实工作区）：

| 用例 | 输入形态 | 结果 |
|------|---------|------|
| P1 | `createWriteStream(getSessionsDir() + '/sess.jsonl')` | **ERROR 检出**（拦截成立） |
| P2 | 同文件含 sessions 痕迹（进条件 A 圈）+ `createWriteStream(getLogsDir()+...)` | 豁免（B② 同语句） |
| P3 | `const p = join(getLogsDir(), file); createWriteStream(p)` | 豁免（B② 单跳赋值链） |
| P4 | 真实 `packages/runtime/src/infra/logger.ts`（:311/:465 两处 `createWriteStream(file, {flags:'a'})`） | 无 ERROR（不误报——文件内 sessions token 仅在注释，条件 A 剥离后不命中） |
| A1 攻击 | `import { createWriteStream as w }` + `w(sessions路径)` | **绕过成立**（详见 §7 边界 1） |
| A2 攻击 | `fs.createWriteStream(sessions路径)` 成员调用 | **ERROR 检出**（`\b` 词边界在 `.` 后成立，不绕过） |

## 6. 红性验证 — PASS（改完即还原）

1. **删 images 提取分支**（`if (false) images = imageBlocks`）→ C1 用例 `message/toolResult：content 含 image 块 → 回填 images` 变红（1 failed / 24 passed，红性聚焦精确）。补测：删 convertMessageBody 的 user image 分支 → user 用例变红（同 1 failed / 24 passed）。
2. **删 createWriteStream pattern**（正则替换为 NEVER_MATCH）→ P1 探针漏报（无 ERROR）+ 全仓 exit 0 无告警——pattern 是拦截的必要条件。
3. 还原核验：`grep VERIFIER-RED-PROBE` 零残留；apply-entry.test.ts 25/25 绿；R1 全仓 exit 0；`git diff --stat` 恢复为 15 files / +345/-97（与验收开始时逐字节一致）。

## 7. 已知边界登记（不阻塞）

1. **A1 别名 import 绕过**：`import { createWriteStream as w }` + `w(path)` 可完全绕过 WRITE_CALL_PATTERNS（`w(` 不匹配 `\bcreateWriteStream\s*\(`；import 行的 API 名后随 ` as` 也不匹配）。这是**整个 pattern 家族的既有边界**——appendFile/writeFile/atomicWrite 同样可被别名 import 绕过，非 W5 新引入的回退。脚本 docstring「检出边界」段声明了 fd 型续写 / `.write(chunk)` 方法调用 / 单跳可见性 / 字符串与正则字面量盲区，**但未声明 import 别名形态**——建议后续 wave 在 docstring 补一句声明（诚实性完善，非功能缺口；真要堵需做 import-别名解析，超出本 wave 边界）。
2. **脚本自测不存在**：基线条款 3 为条件性（「脚本自测（若 node --test 形态）补用例」），仓库无该脚本的伴随自测文件，builder 未新增亦未伪造——本报告 §5 探针（P1-P4 + A1/A2）已提供同等覆盖面的独立验证。

## 8. types.ts 版本标签核对（基线条款 4）

root 实装 `node_modules/@earendil-works/pi-agent-core` = **0.84.2**（`package.json` version 直读），`dist/agent-loop.js` 行号精确核对：**:108-111** = `if (stopReason error/aborted) → emit turn_end → emit agent_end → return`；**:131** = 正常路径 `emit turn_end`。标签自洽。旁证：subagent-workflow 本地 node_modules 的 0.82.1 同文件 ：109-110/:131 时序语义一致，无版本错位风险。（pi-coding-agent 0.84.1 与其依赖 pi-agent-core 0.84.2 版本号不同步是 pi-mono 内部包各自发版所致，标签指 agent-core 包，正确。）

## 9. 结论

W5 交付物全部通过对抗式验收：images 双修行为级对齐（21 断言）+ live≡replay 全链存活 + R1 四用例两攻击 + 三组红性实证 + 防篡改越界干净。2 项已知边界按验收基线登记不阻塞。**PASS**。
