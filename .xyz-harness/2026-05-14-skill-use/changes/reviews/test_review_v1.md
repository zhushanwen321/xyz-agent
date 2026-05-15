# 测试评审 v1

## 评审记录
- 评审时间：2026-05-14 23:56
- 评审类型：测试评审（Stage 13）
- 评审对象：17 个自动化单元测试 + 15 个手动 E2E 用例
- 评审轮次：第 1 轮

---

### Spec 验收标准覆盖矩阵

| AC | 场景 | 覆盖状态 | 测试位置 |
|----|------|---------|----------|
| AC1 | pi 进程启动时传递所有 enabled skill 的 `--skill` 路径参数 | ✅ | `skill-paths.test.ts` L115-145（RpcClient 传 --skill）、L147-176（getSkillPaths 过滤 disabled/不存在路径）、L253-291（restoreSession 传路径） |
| AC2 | SlashMenu 中 skill 命令展示名称、描述和参数提示 | ⚠️ | 单元测试无覆盖。E2E-05 手动验证 SlashMenu UI 渲染。`useSlashCommands.ts` 的 `mergeSkillCommands()` 有隐式覆盖（单元测试未测此函数） |
| AC3 | `parseSkillMd()` 从 SKILL.md frontmatter 提取 `argument-hint` 字段 | ✅ | `skill-scanner.test.ts` L8-20（正常提取）、L22-31（字段缺失返回 undefined）、L34-42（空值边界）、L44-62（多字段 frontmatter）、L53-62（无 frontmatter）、L64-73（引号包裹值）、L75-85（首行提取） |
| AC4 | `ScannedSkillInfo` 和 `SkillInfo` 接口包含 `argumentHint?: string` | ✅ | 类型定义验证：`shared/provider.ts` L30（`ScannedSkillInfo.argumentHint?: string`）、L49（`SkillInfo.argumentHint?: string`）。测试通过 `parseSkillMd` 返回值间接验证 |
| AC5 | `importSkills()` 透传 argumentHint | ⚠️ | 无直接单元测试。代码验证：`stores/provider.ts` L63 确实透传 `item.argumentHint`，但无自动化测试覆盖此映射 |
| AC6 | `mergeSkillCommands()` 中 argumentHint 从 `SkillInfo.argumentHint` 读取 | ⚠️ | 无直接单元测试。代码验证：`useSlashCommands.ts` L66 确实使用 `s.argumentHint`，但无自动化测试覆盖此映射 |
| AC7 | 选择 skill 后输入框预填 argumentHint 文本 | ⚠️ | 无单元测试。E2E-08（有 argumentHint 预填）、E2E-09（无 argumentHint 不预填）手动验证 |
| AC8 | 发送 `/skill:name text` 后 pi 正确展开 skill 内容 | ⚠️ | 无自动化测试。E2E-11（带文本）、E2E-12（不带文本）手动验证，依赖 pi 进程实际运行 |
| AC9 | Settings 变更 skill 列表后，新 session 使用更新后的列表 | ⚠️ | 无自动化测试。E2E-14（禁用后新 session）、E2E-15（旧 session 不受影响）手动验证 |
| AC10 | 无 enabled skill 时，SlashMenu 仅展示内置命令，不报错 | ⚠️ | 部分覆盖：`skill-paths.test.ts` L196-211 验证空 skill 时无 --skill 参数。E2E-06 手动验证 SlashMenu UI |

### 覆盖矩阵总结

- **✅ 完整覆盖**：3/10（AC1, AC3, AC4）
- **⚠️ 部分覆盖**：7/10（AC2, AC5, AC6, AC7, AC8, AC9, AC10）
- **❌ 未覆盖**：0/10

⚠️ 的 7 项中，AC5/AC6 是数据映射层，逻辑简单（单行赋值），风险低。AC2/AC7/AC8/AC9/AC10 涉及 UI 渲染和 Electron+pi 全链路，只能手动 E2E 覆盖，E2E 用例已设计。

---

### 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | LOW | `src-electron/renderer/src/composables/useSlashCommands.ts` | `mergeSkillCommands()` 无单元测试。此函数负责将 SkillInfo[] 映射为 SlashCommand[]，含 filter(enabled)、去重、排序逻辑。虽然是纯函数易于测试，但实际映射逻辑只有 3 行，风险很低 | 可考虑为 mergeSkillCommands 补充 2-3 个用例：正常映射、空列表、同名去重。不阻塞 |
| 2 | LOW | `src-electron/renderer/src/stores/provider.ts` L56-68 | `importSkills()` 映射层无单元测试。实际只有字段透传（包括 argumentHint），逻辑极简单，且前端代码在 Vitest 环境中 setup 成本较高 | 风险极低，不阻塞 |
| 3 | LOW | `skill-scanner.test.ts` | parseSkillMd 的 argument-hint 测试未覆盖「值含引号对但引号不匹配」的边界情况（如 `argument-hint: "[filename'`）。当前 regex `["']?(.+?)['"]?` 在引号不匹配时会贪婪匹配到末尾，但实际 SKILL.md 文件中这种输入极不可能出现 | 可加一条边界用例验证，但不阻塞 |
| 4 | LOW | E2E 测试报告 | E2E 测试报告中 15/15 用例状态全部为 ⬜（未执行），但 spec 声明"已全部实现"。这与 spec 的实现状态总览一致——spec 标记 E2E 为"未执行"，E2E 报告也如实记录为未执行 | E2E 手动测试需人工执行后更新状态，不阻塞自动化测试评审 |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程。测试评审中仅用于逻辑缺陷
> - **LOW**：建议修复，但不阻塞
> - **INFO**：观察记录，无需操作

---

### 断言质量评估

#### skill-paths.test.ts（7 个用例）

**优点：**
- 每个用例验证了具体的 spawn 参数值（不是"不崩溃"类弱断言）
- 覆盖了关键边界：空数组、undefined、disabled skill 过滤、不存在路径过滤、空 sourcePath
- restoreSession 路径有独立用例覆盖（与 create 路径分离）
- Mock 策略合理：mock 了 spawn/loadSkills/existsSync，隔离了外部依赖

**不足（LOW）：**
- `extractSkillArgs` 辅助函数只提取 `--skill` 值，未验证参数顺序（如 `--skill` 是否出现在正确位置）。实际上 spawn 参数顺序不影响功能，顺序验证意义不大
- 测试依赖 mock 的副作用（spawnArgsCapture），而非直接调用 getSkillPaths()。这是因为 getSkillPaths 是 private 方法，通过 create() 间接测试是合理的设计选择

#### skill-scanner.test.ts（10 个用例）

**优点：**
- argumentHint 提取覆盖了 7 种场景：正常提取、字段缺失、空值、多字段 frontmatter、无 frontmatter、引号包裹、首行位置
- description 和 triggers 提取有 3 个额外用例
- 每个断言验证了具体的返回值（`toBe`、`toBeUndefined`、`toContain`、`toEqual`）
- 测试数据构造贴近真实 SKILL.md 格式

**不足（LOW）：**
- 未覆盖 argument-hint 值包含冒号的情况（如 `argument-hint: "key: value"`），但 regex `^argument-hint:\s*["']?(.+?)['"]?\s*$` 中 `.+?` 非贪婪匹配会在行尾停住，实际能正确处理
- triggers 测试中使用了 Unicode 引号（`\u201C`/`\u201D`），这是正确的，与源码 regex 一致

---

### E2E 测试评估

#### 用例设计合理性

15 个 E2E 用例按 5 个 Group 组织，依赖关系清晰：

| Group | 用例数 | 评估 |
|-------|--------|------|
| A: Skill 路径传递 | 4 | 设计合理，覆盖 create/restore 路径、空列表、异常路径 |
| B: SlashMenu 交互 | 3 | 覆盖展示、空列表、键盘导航 |
| C: 输入框预填 | 3 | 覆盖有/无 hint、取消恢复 |
| D: 端到端发送 | 3 | 覆盖带/不带文本、消息气泡 |
| E: Settings 变更 | 2 | 覆盖新旧 session 隔离 |

执行顺序有明确的恢复步骤（特别是 E2E-03 破坏性测试），设计周到。

#### 哪些 E2E 用例已被单元测试间接覆盖

| E2E 用例 | 单元测试间接覆盖程度 |
|----------|---------------------|
| E2E-01（enabled skill 传 --skill） | 高 — `skill-paths.test.ts` L147-176 直接覆盖相同逻辑 |
| E2E-02（无 enabled skill 不传 --skill） | 高 — `skill-paths.test.ts` L196-211 直接覆盖 |
| E2E-03（sourcePath 不存在跳过） | 高 — `skill-paths.test.ts` L147-176 中的 nonexistent 路径过滤 |
| E2E-04（restoreSession 传 skill） | 高 — `skill-paths.test.ts` L253-291 直接覆盖 |
| E2E-05~E2E-13 | 低/无 — 这些是 UI 交互和全链路测试，单元测试无法替代 |
| E2E-14~E2E-15 | 低/无 — 需要实际 Settings UI 操作和多 session 状态验证 |

#### 哪些 E2E 用例真正需要手动验证

**Group B/C/D/E（E2E-05 ~ E2E-15，共 11 个）** 是真正需要手动验证的：
- UI 渲染和交互（SlashMenu 弹出、键盘导航、标签显示、预填文本）
- 全链路（Electron → Sidecar → pi 进程 → LLM 回复）
- Settings UI 操作后的 session 状态隔离

**Group A（E2E-01 ~ E2E-04）** 虽然已被单元测试高度覆盖，但仍建议执行一次，确认集成环境下 spawn 行为与 mock 测试一致。

---

### 未覆盖缺口分析

| 变更接口 | 单元测试 | E2E 测试 | 缺口严重度 |
|---------|---------|---------|-----------|
| `parseSkillMd()` argumentHint 提取 | ✅ 7 用例 | — | 无缺口 |
| `RpcClient` --skill 参数传递 | ✅ 3 用例 | E2E-01, E2E-02 | 无缺口 |
| `SessionPool.getSkillPaths()` | ✅ 4 用例 | E2E-01, E2E-03, E2E-04 | 无缺口 |
| `mergeSkillCommands()` | ❌ | E2E-05, E2E-06 | LOW（纯函数 3 行逻辑） |
| `importSkills()` argumentHint 透传 | ❌ | — | LOW（单行赋值） |
| ChatInput argumentHint 预填 | ❌ | E2E-08, E2E-09 | LOW（UI 组件，无法单元测试） |
| SlashMenu argumentHint 渲染 | ❌ | E2E-05 | LOW（UI 组件） |
| pi _expandSkillCommand 端到端 | ❌ | E2E-11, E2E-12 | LOW（外部系统，只能 E2E） |

所有缺口的严重度均为 LOW。核心链路（skillPaths 传递 + argumentHint 提取）有充分的单元测试覆盖。UI 层和全链路依赖手动 E2E 验证，这是 Electron 桌面应用的正常测试策略。

---

### 类型签名正确性抽查

抽查 3 个关键签名：

| 标识符 | Spec 描述 | 代码库实际 | 一致性 |
|--------|---------|-----------|--------|
| `parseSkillMd()` 返回值 | `{ description: string; triggers: string[]; argumentHint?: string }` | `skill-scanner.ts` 返回 `{ description, triggers, argumentHint }` | ✅ 一致 |
| `SkillInfo.argumentHint` | `argumentHint?: string` | `shared/provider.ts` L49: `argumentHint?: string` | ✅ 一致 |
| `SlashCommand.argumentHint` | `argumentHint?: string` | `useSlashCommands.ts` L22: `argumentHint?: string` | ✅ 一致 |

---

### 结论

通过

### Summary

测试评审完成，第1轮，0条MUST FIX，通过。
