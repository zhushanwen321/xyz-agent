---
issue: "#3 recents composable — 方案 A localStorage 持久化"
perspective: "正向追踪（副作用覆盖性 + 缓解可行性）"
converged: false
tracers_checked: ["nfr-dimensions.md", "non-functional-design.md #3", "issues.md #3 AC-3.1~3.6", "decisions.md D-007/D-015", "sidebar.ts SIDEBAR_TAB_KEY", "settings.ts SYSTEM_KEY", "i18n/index.ts"]
---

# 正向追踪 — Issue #3 recents composable（方案 A localStorage）

> 独立正向追踪，上下文与主 agent 隔离。聚焦 #3 localStorage 持久化的 7 维度副作用覆盖性 + 缓解方案可行性。
> 决策账本纪律：D-007（recents localStorage 持久化，confirmed）、D-015（搭便车项）为已拍板结论，不当 gap 重报。

## 视角1 副作用覆盖性

### 7 维度逐轴核对（NFR 矩阵 #3 行：安全⚠️ 数据⚠️ 性能✅ 并发✅ 稳定性✅ 兼容性⚠️ 可观测✅）

| 维度 | 矩阵标 | 覆盖判定 | 备注 |
|------|--------|---------|------|
| 安全 | ⚠️ | ✅ 已评 | 桌面应用无 XSS 注入面论证成立；RecentEntry.key 规则引用 AC-3.5 |
| 数据一致性 | ⚠️ | ✅ 已评 | 事务边界/迁移/回滚四字段齐全 |
| 性能 | ✅ | ✅ 合理 | <20 项小数据，一行理由充分 |
| 并发 | ✅ | ⚠️ **见 G-3.1** | 矩阵标✅但 AC-3.6 timestamp 兜底实为并发维度，矩阵漏标 |
| 稳定性 | ✅ | ⚠️ **见 G-3.2** | 矩阵标✅但正文「其余维度」行自述「配额满/隐私模式须 catch」是稳定性风险，标✅与自述矛盾 |
| 兼容性 | ⚠️ | ✅ 已评 | try/catch JSON.parse 降级、版本升级兼容已述 |
| 可观测性 | ✅ | ✅ 合理 | 偏好数据无审计/指标需求，理由充分 |

**核心判定**：7 维度全部「评了」（无遗漏维度），⚠️ 三维度的风险描述准确、缓解方向正确。但有 2 处**矩阵标注与正文自述不一致**（性能/稳定性边界划分模糊）——非覆盖缺口，是标注一致性问题，见 G-3.1/G-3.2。

### Electron localStorage 行为假设核查

NFR #3 多处依赖「xyz-agent 是 Electron 桌面应用」论证安全性/稳定性。源码核查：
- `sidebar.ts`/`settings.ts`/`i18n/index.ts` 三处现有 localStorage 用法均**无配额检查、无隐私模式检测**——印证桌面应用假设（Electron 渲染进程非沙箱浏览器，localStorage 配额按磁盘而非 5MB 浏览器上限，无隐私模式）。**假设成立，无 gap。**

## 视角2 缓解可行性

### MR-3.1 localStorage try/catch 降级 — ✅ 可落地

- **可落地性**：现成先例 `settings.ts:41-46`（getSystem 的 try/catch JSON.parse 失败降级空对象）+ `i18n/index.ts:16-25`（readInitialLocale try/catch 降级默认 locale）已是项目既有模式，MR-3.1 复用同模式零摩擦。
- **read() try/catch JSON.parse**：✅ 必须且充分——RecentEntry 未来加字段时旧版 localStorage 是脏数据，JSON.parse 抛错会崩浮层。MR-3.1 降级空数组正确。
- **write() 配额满 catch**：✅ 可行——但须注意 write() 失败后是否回滚内存态（见 G-3.3）。

### MR-3.2 key 命名空间隔离 — ⚠️ 命名不一致风险（见 G-3.4）

- **冲突核查**：源码实测现有 key 仅 3 个：
  - `xyz-agent-sidebar`（sidebar.ts:13，连字符裸字符串）
  - `xyz-agent:system-settings`（settings.ts:20 + i18n/index.ts:12，冒号 JSON）
  - `xyz-agent-locale`（i18n/index.ts:13，legacy）
- **MR-3.2 提议 `xyz-search-recents`**：**与现有 3 个 key 前缀 `xyz-agent-*` 不一致**——现有 key 全部以 `xyz-agent-` 开头，提议的 `xyz-search-recents` 是 `xyz-search-` 前缀，违反既有命名空间约定。冲突不会发生（字面不同），但命名空间隔离的「对齐现有约定」承诺落空。见 G-3.4。
- **是否真冲突**：❌ 不冲突（字面不同），但 MR-3.2 的「对齐现有 SIDEBAR_TAB_KEY/SYSTEM_KEY 约定」描述不准确——现有约定本身就不统一（sidebar 用连字符，settings 用冒号），recents 应明确归哪一脉。见 G-3.4。

### 残余风险可接受性

- **配额满**：✅ 可接受——recents 是偏好数据非业务数据（NFR 残余风险登记表已记），catch 降级保证不崩溃。桌面应用 localStorage 配额远超浏览器 5MB（按磁盘），recents <20 项 KB 级，配额满近乎不可达，接受合理。
- **JSON.parse 失败**：✅ 可接受——read() try/catch 降级空数组，最坏情况 recents 清空重建，非致命。

### FIFO + timestamp 计数器兜底（AC-3.6）并发正确性

AC-3.6 `Math.max(stored)+1` 兜底避免同毫秒连续 write 的 FIFO 排序不确定——逻辑正确（单调递增计数器保证排序确定性）。但有两个未覆盖细节：
- **跨 reload 计数器连续性**：timestamp 存在 localStorage entry 内，reload 后读 max(stored) 续算，✅ 连续。
- **同 key 重复确认更新 timestamp**（AC-3.5）与淘汰的交互：见 G-3.5。

## Gap 清单

### G-3.1 [D-标注一致性] 并发维度矩阵标✅与 AC-3.6 实质并发约束不符

**描述**：NFR 矩阵 #3 并发列标 ✅（无风险），但 AC-3.6（timestamp 用 `Math.max(stored)+1` 计数器兜底而非裸 Date.now()，避免同毫秒连续 write 的 FIFO 排序不确定）本质是**并发维度的竞态缓解**。矩阵标✅等于声称并发无风险，却又在 issues AC 里加了并发兜底——标注与实质矛盾。维度4模板（竞态场景/幂等策略）未被触发，但 AC-3.6 的竞态分析（check-then-act: read max→write）未在 NFR 显式展开。

**建议**：将 #3 并发列从 ✅ 改 ⚠️，或在「其余维度」行补一句「并发✅——AC-3.6 已用计数器兜底覆盖同毫秒连续 write 的 FIFO 排序竞态，单实例无跨进程并发」，使矩阵标注与 AC-3.6 自洽。属标注修正非新风险。

---

### G-3.2 [D-标注一致性] 稳定性维度矩阵标✅与正文「配额满须 catch」自述矛盾

**描述**：NFR 矩阵 #3 稳定性列标 ✅，但正文「其余维度」行（:80）自述「localStorage 失败（配额满/隐私模式）须 catch 降级（见缓解项 MR-3.1）」——这本身是稳定性风险描述（依赖不可用须降级），且 MR-3.1 落到⑤test-matrix。标✅与「须 catch 降级」自相矛盾。稳定性维度本应触发维度5模板（故障场景/降级方案）。

**建议**：将 #3 稳定性列从 ✅ 改 ⚠️，与 MR-3.1 回灌登记对齐；或在「其余维度」行明确「稳定性✅——MR-3.1 catch 降级已覆盖，残余风险（配额满）记入残余风险登记表，可接受」。属标注修正非新风险。

---

### G-3.3 [K-缓解落地细节] write() 配额满 catch 后内存态与持久化态不一致未定义

**描述**：MR-3.1 规定 write() 配额满→catch 降级（不崩溃），但未定义 catch 后 useRecents 内存态行为：① 内存 ref 是否仍 push 新 entry（内存有 6 项但 localStorage 只存 5 项旧值）？② 下次 read() 从 localStorage 读回，内存与磁盘不一致。这会导致本次会话内 recents 看起来写入成功，reload 后消失——用户困惑（「我刚确认的为什么没了」）。

**影响**：低概率（桌面应用配额满近乎不可达），但行为未定义是正确性缺口。

**建议**：MR-3.1 补一句——write() catch 后内存态回滚（不 push），或保持内存态但标记「未持久化」。或在 AC-3.1/3.2 补「write 失败时 recents UI 本次会话仍显示但 reload 后丢失」的预期行为说明。推荐前者（内存回滚，与持久化态一致）。

---

### G-3.4 [K-缓解准确性] MR-3.2 key 命名 `xyz-search-recents` 违反现有 `xyz-agent-*` 命名空间

**描述**：MR-3.2 缓解项描述「recents key 用项目命名空间（如 `xyz-search-recents`，对齐现有 SIDEBAR_TAB_KEY/SYSTEM_KEY 约定）」，但源码实测现有 3 个 key **全部以 `xyz-agent-` 开头**：
- `xyz-agent-sidebar`（sidebar.ts:13）
- `xyz-agent:system-settings`（settings.ts:20, i18n/index.ts:12）
- `xyz-agent-locale`（i18n/index.ts:13, legacy）

提议的 `xyz-search-recents` 用 `xyz-search-` 前缀，**与现有命名空间不一致**。MR-3.2 声称「对齐现有约定」但实际未对齐。

**次要问题**：现有约定本身双轨——sidebar 用连字符（`xyz-agent-sidebar`），settings 用冒号（`xyz-agent:system-settings`）。recents 应明确归哪一脉，而非用第三种 `xyz-search-` 前缀制造第三种风格。

**建议**：MR-3.2 key 命名改为 `xyz-agent:search-recents`（与 settings JSON 脉一致，因 recents 也是 JSON.stringify 存储）或 `xyz-agent-search-recents`（与 sidebar 裸字符串脉一致）。推荐 `xyz-agent:search-recents`（JSON 存储 + 冒号命名空间与 settings.ts 同构，未来可统一 `xyz-agent:*` 命名空间）。骨架约束须明确写死 key 名，避免实现期再分叉。

---

### G-3.5 [K-AC 覆盖缺口] AC-3.5 同 key 更新 timestamp + AC-3.2 FIFO 淘汰的交互未明确

**描述**：AC-3.5「同 key 重复确认时更新 timestamp 而非新增条目」+ AC-3.2「每类超 5 项淘汰最旧」+ AC-3.6「Math.max(stored)+1 兜底」三者交互存在边界未定义：
- 场景：某类已有 5 项，timestamp=[1,2,3,4,5]。用户确认第 6 个**新** key（非重复）→ 应淘汰 timestamp=1 的最旧项。但若此时先 read() 拿到 stored，计算淘汰，再 write——若淘汰逻辑误用「更新已存在项」路径而非「新增+淘汰」路径，可能保留新项但漏删旧项（变 6 项超限）。
- AC-3.2 只说「超 5 项淘汰最旧」，未规定淘汰在 write 的哪个阶段执行（push 后 slice 还是 push 前判断）。

**影响**：低（实现时正常会 push→sort→slice），但 AC 未明确淘汰时机是正确性约束缺口，⑤test-matrix 须覆盖「类已满 + 新 key」场景。

**建议**：AC-3.2 补充淘汰时机——「write(entry) 时：若 key 已存在则更新 timestamp（AC-3.5），否则 push；push 后若该类超 5 项则按 timestamp 升序淘汰至 5 项」。⑤test-matrix 增加「类满 5 项 + 确认新 key」用例验证不超限。

---

## 无新 gap 维度

- **安全**：桌面应用无 XSS 注入面论证成立（渲染进程加载本地 bundle），D-007 已拍板 recents localStorage，无新风险。
- **数据一致性事务边界**：单 key 整体 setItem 原子写论证正确，无跨 key 事务。
- **兼容性向后兼容**：try/catch JSON.parse 降级已覆盖 RecentEntry 结构变更（MR-3.1），版本升级/回滚 key 残留无害已述。
- **可观测性**：偏好数据无审计/指标需求，理由充分。

## 结论

#3 方案 A（localStorage）7 维度**全覆盖**，⚠️ 三维度风险描述准确、缓解方向正确。发现 **5 条 gap**：
- 2 条 D 类（标注一致性，G-3.1/G-3.2，矩阵标✅与 AC/正文自述矛盾，建议改⚠️或补一句理由）
- 3 条 K 类（缓解落地/准确性，G-3.3 write catch 内存态未定义 / G-3.4 key 命名违反现有 `xyz-agent-*` 命名空间 / G-3.5 淘汰时机 AC 未明确）

无 F 类（事实性错误）——源码核查后 NFR 对现有 localStorage key 命名约定的引用基本正确（SIDEBAR_TAB_KEY/SYSTEM_KEY 确实存在），只是 MR-3.2 提议值未对齐。无推翻 D-007/D-015 的新证据。
