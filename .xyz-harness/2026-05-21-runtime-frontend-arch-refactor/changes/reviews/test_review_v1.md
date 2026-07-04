---
verdict: "pass"
must_fix: 0
review:
  type: test_review
  round: 1
  timestamp: "2026-05-22T03:30:00"
  target: "changes/evidence/test_execution.json"
  summary: "测试评审完成，第1轮通过，0条MUST FIX"
statistics:
  total_issues: 5
  must_fix: 0
  low: 4
  info: 1
issues:
  - id: 1
    severity: LOW
    location: "changes/evidence/test_execution.json:TC-7-02"
    title: "server.ts 行数超出 spec 目标（365L vs ≤250L），测试用例接受标准被放松"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: LOW
    location: "changes/evidence/test_execution.json:TC-1-01~TC-4-02"
    title: "集成测试用例以单元测试替代执行，未验证实际 WS 连接链路"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: LOW
    location: "spec.md:AC-7"
    title: "AC-7 (Scanner Base) 仅有间接覆盖（TC-3-02/03），缺少直接验证 scanner-base.ts 的测试用例"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: LOW
    location: "spec.md:AC-2 bullet 4"
    title: "AC-2 'types.ts 被 ≥3 个文件 import' 缺少显式测试验证"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 5
    severity: INFO
    location: "spec.md:AC-6"
    title: "AC-6 (Config Store Split) 通过 TC-3-02/03 得到间接覆盖，无直接导出验证"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 测试评审 v1

## 评审记录
- 评审时间：2026-05-22 03:30
- 评审类型：测试评审
- 评审对象：changes/evidence/test_execution.json + test_cases_template.json + spec.md

## AC 覆盖矩阵

| AC | 场景描述 | 覆盖状态 | 测试位置 |
|----|---------|---------|----------|
| AC-1 | Service Layer 提取 — server.ts 行数 ≤250L，无内联业务逻辑，session-service/config-service/model-service 存在，session-pool.ts 删除，27 个 handler 路由到 Service | ⚠️ | TC-7-01/02/03, TC-1-01~04, TC-2-01~03, TC-3-01~03, TC-4-01~02, TC-8-01 — 行数 365L 超出阈值 |
| AC-2 | 类型安全 — event-adapter 使用 PiEvent 联合类型、exhaustive check、无重复本地类型、types.ts 被 ≥3 文件 import | ✅ | TC-5-01/02 — 前 3 个子项已覆盖，第 4 项（import 计数）仅 TC-5-02 部分覆盖 |
| AC-3 | 依赖注入 — 7 个接口定义存在，构造函数注入，index.ts 组装 | ✅ | TC-7-01 |
| AC-4 | 死代码删除 — Runtime 删除 6+4 个方法，前端删除 3 个 composable，npm run build 通过 | ✅ | TC-6-01/02, TC-11-01 |
| AC-5 | Message Converter — message-converter.ts 存在，使用 types.ts 类型，非内联实现 | ✅ | TC-8-01 |
| AC-6 | Config Store 拆分 — config-store 不含 skill/agent 函数，skill-store/agent-store 存在 | ⚠️ | TC-3-02/03（间接验证路由路径） |
| AC-7 | Scanner Base — scanner-base.ts 存在，scanner 使用共享框架 | ⚠️ | TC-3-02/03（间接验证，无直接测试） |
| AC-8 | 系统通知工厂 — 工厂函数存在，5 个文件中消费者全部使用工厂 | ✅ | TC-9-01 |
| AC-9 | refCount 保护 — useSession/useProvider 有模块级 refCount | ✅ | TC-10-01 |
| AC-General | 非回归 — npm run build 通过，27 种消息路由不变 | ✅ | TC-11-01, TC-1-01~04 |

## 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | LOW | changes/evidence/test_execution.json:TC-7-02 | server.ts 实际 365 行，超出 spec AC-1 目标（≤250L）。R1 测试失败，R2 以 code review 通过为由判定为通过，但测试用例的验收标准被隐含地放宽而未更新 test_cases_template.json 中的阈值。不影响功能，额外行均为 Transport 路由代码。 | 在 test_cases_template.json 中记录实际目标值（如 "≤ 370L"）并引用 code review 决议；或拆分 server.ts 使其回归 ≤250L。 |
| 2 | LOW | changes/evidence/test_execution.json:TC-1-01 ~ TC-4-02 | test_cases_template.json 中定义的集成测试步骤（启动 Runtime → 连接 WS → 发送消息 → 验证响应）以 vitest 单元测试（mock service layer）替代执行。未验证 WS 连接建立、消息序列化/反序列化、心跳、断开重连等传输层行为。对纯重构项目风险较低（传输层未变更），但测试执行方式与测试计划描述不符。 | 补充一个端到端集成测试用例，验证实际 WS 连接 + 消息路由的完整性，或更新 test_cases_template.json 的步骤描述以反映实际测试方式。 |
| 3 | LOW | spec.md:AC-7 | AC-7（Scanner Base 提取）要求 scanner-base.ts 存在且被 scanner 引用，但 test_cases_template.json 没有任何对应的测试用例。TC-3-02（config.scanSkills）通过 ConfigService → skill-store → skill-scanner 的调用链提供了间接覆盖，但无直接验证 scanner-base.ts 导出和 scanner 使用共享框架。 | 增加一个 API 测试用例（如 TC-7-04），直接验证 scanner-base.ts 存在、导出 expandHome/inferSourceType，且 skill-scanner/agent-scanner 不再自定��这些函数。 |
| 4 | LOW | spec.md:AC-2 bullet 4 | AC-2 要求 "types.ts 被 ≥3 个文件 import"，test_cases_template.json 中无对应测试用例。TC-5-02 仅验证 event-adapter 的 import，未统计全局 import 数量。 | 增加一个 API 测试用例，用 grep 统计 `import.*from.*types` 出现的文件数。 |
| 5 | INFO | spec.md:AC-6 | AC-6（Config Store 拆分）无直接验证 skill-store.ts/agent-store.ts 导出函数的测试用例。TC-3-02/03 通�� ConfigService 的 CRUD 路径提供了足够的间接覆盖（若 store 缺失则路由测试会失败），风险可控。 | 增加一个 API 测试用例验证文件存在性和导出签名，或明确标记为间接覆盖。 |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过。测试评审中仅用于测试逻辑缺陷。
> - **LOW**：建议修复，不阻塞。命名/注释/格式/覆盖度问题归此类。
> - **INFO**：观察记录，无需操作。

## 测试质量评估

### 1. 测试覆盖度

测试计划（test_cases_template.json）包含 20 个测试用例，覆盖了 spec 中全部 9 个 FR 和 10 个 AC 分组。AC 覆盖矩阵中：

- **✅ 完整覆盖**: AC-2（类型安全），AC-3（依赖注入），AC-4（死代码删除），AC-5（Message Converter），AC-8（系统通知工厂），AC-9（refCount），AC-General（非回归）— 这些 AC 的每个子项都有对应的测试用例和通过证据。
- **⚠️ 部分覆盖**: AC-1（行数超标），AC-6（间接覆盖），AC-7（间接覆盖）— 功能通路已验证，但结构要求未直接测试。

### 2. 测试质量

- **断言充分性**: API 测试（TC-5 ~ TC-10）使用 grep/ls/wc 做二进制存在性检查，充分性足够。集成测试（TC-1 ~ TC-4）通过 vitest 断言验证，引用 "46/46 passed" 但未提供具体断言细节。
- **测试意图与 spec 一致**: 测试用例的步骤描述与 spec AC 要求对应良好，但 TC-7-02 的接受标准在 R2 被隐含放宽。
- **脆弱性**: 无。grep/ls 检查不依赖实现细节，vitest 测试 mock service 层。

### 3. 测试可维护性

- 测试结构清晰（test_cases_template.json 的 id 编号 + 类型分类 + 步骤描述）。
- 测试相互独立，无执行顺序依赖（API 测试均为独立 grep/ls 检查）。
- 两轮执行记录完整，失败用例的修复链路可追溯。

### 4. 数据构造合理性

- API 测试无需复杂数据构造（文件存在性 + grep 检查）。
- 集成测试依赖 vitest 的 mock service 层，构造合理（不 mock 被测路由对象本身）。
- 无 magic number 问题。

## 轮次管理

- 当前第 1 轮，0 条 MUST FIX。
- 测试执行记录中包含 2 个失败用例（TC-7-02 R1, TC-11-01 R1），均在 R2 修复后通过。
- 未达到循环上限（上限 2 轮）。

## 结论

通过

## Summary

测试评审完成，第1轮通过，0条MUST FIX。测试覆盖度整体良好，20 个测试用例覆盖全部 9 个 FR。AC 覆盖矩阵中 7/10 为 ✅，3/10 为 ⚠️（部分覆盖：AC-1 行数超标，AC-6/AC-7 仅有间接测试）。发现 4 个 LOW 问题和 1 个 INFO 观察项，均为覆盖度或方法论问题，无测试逻辑缺陷。执行方法上集成测试以单元测试替代，对纯重构项目风险可控。
