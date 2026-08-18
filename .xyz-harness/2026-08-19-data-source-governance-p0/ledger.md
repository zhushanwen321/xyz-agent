# data-source-governance P0 状态账本

> 协调机制：cw-orchestrator（验收基线先行 + builder/verifier 三方制衡，主 agent 只协调不执行编码）。
> 规格 SSOT = `docs/architecture/data-source-governance-plan.md` §2（W1-W5 节，行号以基线 commit 为准）；父文档 = `docs/architecture/data-source-governance.md`。
> 本账本只覆盖 P0（W1-W5 + P0 gate）；P1+ 波次不在本账本范围。
> 状态机：pending → building → built → verifying → verified → committed；失败 → rejected（附失败报告，打回原 builder 修复后走针对性复审）。
> S1 语义层（review-data-governance agent）已在 pr-cr-fix 8 维上线（plan §0 备注），无 wave，不在此表。

## P0 wave 表

| wave | 名称 | 状态 | 验收基线 commit | 备注 |
|------|------|------|----------------|------|
| W1 | 活跃 session label 直写全量切 set_session_name RPC（含 tryPersistLabel 扩围删除） | committed | 337a7c79d | verifier PASS（sha256 09bd117a…，报告 w1-report.md：防篡改越界 0 / 3104 全绿 / 四 grep 全过 / 真实性 5 点 / 对抗 6 条含 throw guard→toast 链路、派生 label 永不进 RPC、非活跃 else 字节级原样 / 三裁决全接受）。打回修复一轮：grep#3 残留 2 处过时注释（session-file-utils，验收条款互斥）→ 主 agent 授权仅注释修正 → 闭环。清单外机械适配 12（6×fixture 单行删 + 5×注释清理 + 1×授权注释）逐文件 diff 核对零行为夹带。观察：persistExplicitLabel await 致 create/fork 最坏 10s 尾延迟（有界，合规「不阻断≠不等待」，W7 实例化时复评） |
| W2 | 数据登记表初版（12 条 + 空值语义 + legacy 例外） | committed | 118e6169e | verifier PASS（报告 w2-report.md：防篡改 3/3、命令 3/3、真实性逐行源码核实、**反向写点扫描零未登记**（SSOT 完备性）、裁决 2 项全过）。打回修复一轮：registry.md:23 命令名前缀 session.steer→message.steer / follow_up（verifier minor，源码 protocol.ts:61 依据），主 agent 核对后收口。观察：#10 FileChanges / #11 活跃态父文档无专门 wave，登记表如实标注「无专门 wave + 原则性约束」——计划层缺口，待用户裁决是否补 wave；行号与 plan 基线偏差已在表头声明记录（:302→:331 等） |
| W3 | R1：pi 文件直写 pre-commit 检查 | committed | 2dc3c443c | verifier PASS（报告 w3-report.md：防篡改/命令 4 条/allowlist 4 条一一对应/对抗 10 探针含 B② 防线 join(tmpdir(),'sessions') 不豁免实测/三裁决全认可）。主 agent 补做 pre-commit 实际拦截验证：探针 commit 被拦（报错含 :行号 + 恢复动作 + registry 指引）、HEAD 未动、清理闭环。观察 4 条不阻断：allowlist :331 结构性死条目（规格预期）/ openSync 'a+' 变体不在检出面（零用法）/ checker 异常 exit 1 当通过（体系同款）/ plan 行号漂移 |
| W4 | R2 骨架 + R3：taste-lint 两条规则 | committed | 2dc3c443c | verifier PASS（报告 w4-report.md：防篡改 blob hash 逐一相等/命令 4 exit 0/探针 7 组全命中含 export 包裹形态也拦 + 隔行冒充注解不生效 + 全仓 lint exit 1 阻断链路/三裁决全成立）。存量补注解实测 0（stores/ 全在函数作用域，机制性而非规则失效——探针反证活性）。R3 首版范围 = stores/（verifier 裁决合理：全仓 stores 外 17 处模块级缓存，扩围留 W24）。边界留 W24：useChat/use-session 的形参注入直呼不在拦截面（docstring 诚实声明） |
| W5 | 等价性测试骨架（pi fixture + live≡reload 雏形） | committed | 337a7c79d | verifier PASS（sha256 3968d16c…，报告 w5-report.md：真实 spawn 5.49s、deep equal + parentId 链断言、对抗 4 条全过含断言红绿闭环/pi 缺席 skip/零残留/冷启动 1ms 边界）。401 行超 M 档 5%（清理/诊断逻辑，裁决接受）。观察：①pnpm exec 恒注入 node_modules/.bin（内有 pi），仓内 skip 分支实际难触发，仅未 install 环境触发；②live 侧等价源 = message_end 事件流（pi 0.84 常规 entry 不发 entry_appended——父文档 D5 探针⛔ 已由实测收口，依据 pi-mono 源码三处核实写进 fixture 头「协议事实」节）；③本雏形不触发工具流（bash 消息不经 message_end），带工具流等价性留后续 wave 同目录扩展 |

## P0 gate

| gate | 内容 | 状态 |
|------|------|------|
| P0 gate | 父文档场景 1 前半（真实环境手动命名不被覆盖）+ 场景 4（预防拦截三违规） | PASS |

## 事件

- 2026-08-19 协调启动（定时任务触发）：read 治理文档三件（父文档/plan/review r2-r6 已核）+ plan §2 P0 详规；核实 W1-W5 产物均不存在（registry / check_pi_direct_write.py / taste-lint 两规则 / equivalence 目录 / rpc-client set_session_name 均无）→ 全量待执行，无既有 wave 进度可接续。首波 W1 + W5 并行（领地不相交：W1 = runtime services/infra + test/，W5 = runtime src/__tests__/equivalence/）。账本 + W1/W5 验收基线入 git。
- 2026-08-19 首波派发：W1 builder（worker）+ W5 builder（worker）后台并行。流水线重叠：W2 acceptance 预写 + 基线先行 commit（W2 派发仍等 W1 committed 解锁）。
- 2026-08-19 W5 built→committed 一轮过：builder 交付 pi-fixture.ts + live-reload.test.ts（401 行，真实 spawn 跑通 + 断言非空转自验闭环 + 全量 4 failed 归因 W1 中途态）；verifier PASS（防篡改/typecheck/真实性 5 点/对抗 4 条；3105 全绿复核）；主 agent 核对 diff 空 + sha256 一致后流转。W3/W4 acceptance 预写随本 commit 入（派发等 W2）。
- 2026-08-19 W1 打回修复一轮：首验前 builder 自报 grep#3 残留 2 处（session-file-utils docstring 提及已删机制，验收条款互斥）→ 主 agent 裁决授权仅注释修正 → 修复后 grep=0、四条 grep 全过、注释 diff 干净。W1 verifier 派发中。
- 2026-08-19 W1 committed（verifier PASS 全链）：唯一已证实 bug（手动命名被 auto-rename 覆盖）的活跃链路止血完成。verifier 独立核实 pi 上游 rpc-mode.ts:632 命令存在性与参数一致。W2 解锁派发。
- 2026-08-19 W2 committed（verifier PASS + 1 打回修复）：登记表 29 表行落地，反向写点扫描零未登记（SSOT 完备性实证）；registry:23 命令名前缀 session.steer→message.steer 修正。W3+W4 并行派发（.githooks/ vs taste-lint/ 领地不相交）。
- 2026-08-19 W3+W4 committed（双 PASS）：P0 五 wave 全部 committed（W1 9dcffa736 / W2 e411a010f / W3 c3faee469 / W4 3a56faf96 / W5 2dc3c443c）。双层护栏机器层全量上线（R1 pre-commit + R2/R3 taste-lint error 级）。W3 流转前主 agent 亲测 pre-commit 活拦截（探针 commit 被拒、HEAD 未动、清理闭环）。R1 在自身 commit 上即生效自证。进入 P0 gate。
- 2026-08-19 P0 gate **PASS**（双执行者）：场景 1 前半 pi 层端到端（报告 p0-gate-scenario1-report.md）——真实 pi 0.84.1 + rename-session 本地源码 + mimo LLM，竞态实验直击本质（set_session_name 落在 rename LLM 1.83s 窗口内 → 守卫 `skip: name exists` 真实出现、renamed to 零新增、JSONL 有且仅有手动名）；主实验严格流程 + 对照组 auto-rename 不误伤。**新认知**：`skip: name exists` 只在 rename LLM 调用窗口内可能出现（扩展 count!==1 前置守卫使后续轮 skip: count=N）——plan 验收 2 的字面预期按扩展代码不可能出现，验收语义以「名字保持 + 零覆盖 entry」为准（报告 §1 偏差说明）。场景 4（报告 p0-gate-scenario4-report.md）——①②机器拦截证据 = 主 agent 亲测 R1 pre-commit 活拦截 + W4 verifier R2/R3 探针；③ S1 语义层：违规样本（queue_update 回调直写 label，机器层漏拦逐一核实）被 review-data-governance checklist 判 MUST_FIX × 3 + 修复方向对齐 W7；合规样本（markDirty 正解）0 MUST_FIX 零误拦。**P0 全部完成（五 wave + gate），双层护栏上线，止血 bug 修复验证。**
- 2026-08-19 W2 上报处置：#10 FileChanges / #11 活跃态父文档 19 单元无对应 wave——登记表如实标注「无专门 wave」，属计划层缺口待用户裁决（P0 范围外，最终汇报披露）。
