# Retrospect: markdown-redos-fix

## 执行过程回顾

单 Wave 任务，流程顺畅：clarify（3 条记录）→ spec_review（禁读重建发现 4 个 should-fix，补 AC-7/8/9）→ plan（单 Wave）→ tdd_plan（18 用例红灯 8 fail）→ dev（重写正则 + 段含字母前瞻）→ review（无 issue）→ test（9/9 一次通过）。

零返工：dev/test/review 均首次通过，无 replan、无 review_fix、无 test_fix。

## 关键决策与发现

### 1. 病态结构溯源（不是手滑，是需求逼出来的）
W2（commit 5668fd29）为支持「路径段含空格」（如 docs/My Document.md）把单层量词 `[chars]+` 改成双层嵌套 `(?:[chars]+(?: [chars]+)*)+`——这正是 ReDoS 元凶。这印证了分析阶段的判断：用复杂正则在自由文本里做语义识别，每堵一个误报就加一层量词，离灾难性回溯就近一步。正则的复杂度是需求逼出来的。

### 2. TDD 红灯抓到 spec 未预见的真 bug
spec 的 AC-5 只列了 `glm-5.2`（当前已 pass）。但红灯跑出来 `node/18.0`、`pi/3.14`、`src/123` 三个误识别用例全 fail——这是「扩展名可选」（为支持 src/Makefile）导致正则退化为纯段匹配的副作用，spec 阶段没预见到。TDD 红灯比静态分析更早暴露了真实现有 bug。

### 3. 段含字母前瞻（开发中涌现的设计）
为修复上述误识别，最初想「要求扩展名必填」，但这会让 src/Makefile（无扩展名）不识别（违反 AC-4）。解法是「每段必须含字母」——用前瞻 `(?=[chars]*[a-zA-Z])` 要求段内至少一字母。这挡掉纯数字段（版本号/小数的数字段），同时不影响 Makefile 等含字母的真实路径段，且前瞻不消费字符、不引入嵌套量词，保持线性。这是开发中涌现的、spec 阶段没想到的设计点。

## knownRisks

1. **取消空格路径支持的体验影响未实测**（unverified）：docs/My Document.md 这类带空格路径不再识别为整条。虽然判定罕见，但真实用户场景中是否高频出现未做数据验证。缓解：反引号内仍走 code_inline renderer，且未来可加「选中文字搜索直达」交互兜底（本次 outOfScope）。

2. **段含字母前瞻可能误挡合法全数字目录名**（unverified）：如 `data/2024/notes.md` 中的 `2024` 是合法目录名，但因纯数字段被挡，整条不识别。这类路径形态的频率未统计。判定罕见（AI 输出路径极少全数字目录），但属已知取舍。

## processIssues

1. **AC-5 误识别用例覆盖不足（spec 阶段盲区）**：spec 只列了 glm-5.2 一个误识别用例，红灯暴露 node/18.0、pi/3.14、src/123 三个未预见的误识别。spec_review 的禁读重建建议了「边界用例补充」但没具体列出这三个。教训：误识别防御的 AC 应主动枚举「含 / 但非路径」的形态（版本号、小数、纯数字段），而非只列一个代表。

2. **untracked 测试文件来源需澄清**：markdown-filepath.test.ts 是上个 CW topic 的遗留产物，tdd_plan 阶段需判断是复用还是重写。好在 clarify 阶段已记录来源并获用户确认重写，但流程上应有个机制标记「认知外的 untracked 文件」——否则每次都要 git log 考据。

## 全绿质量自检结论

测试套件有实质防线：删掉段含字母前瞻 → U7 三个误识别 case 变红；加回嵌套量词 → U1/U2 性能 + U3 静态结构全红。不是覆盖率填充。
