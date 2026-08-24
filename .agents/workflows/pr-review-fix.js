'use strict';

/**
 * pr-review-fix — pr-cr-fix skill 阶段 2 的 zcode workflow 实现（对标 pi 内置
 * review-fix-loop 的 batch1 模式：8 维 review agent .md 驱动）。
 *
 * 为什么不用 zflow 内置 review-fix-loop：内置版审查者是「焦点名」模型（prompt
 * 模板自带 JSON-only 输出契约），承载不了本仓 8 个 review agent 定义的专属
 * checklist 与 [HISTORICAL] 教训，输出契约也互相冲突。本脚本把 agent .md
 * 原文内嵌进各 review 阶段 prompt（无头 session 不自动加载 agent .md，内嵌
 * 是唯一确定性途径），各维输出保持 agent 定义原样：报告文件（YAML
 * frontmatter + Findings 表）+ 最终回复末尾 JSON 围栏计数。
 *
 * 循环语义（对齐内置版已验证的熔断，不重造）：
 * - clean 维度下轮跳过；fix 发生后全部重置（修复可能引入新问题）
 * - must_fix 总数连续 2 轮不降 → stuck（人工接管）
 * - 全部审查者执行/解析失败 → review-failed（零成功 ≠ clean）
 * - 修复阶段失败 → fix-failed；轮数耗尽且最后一步是修复 → fixed-unverified
 *
 * 参数（zflow run 透传，MCP schema 内字段；autoCommit/skipCleanAgents 固定
 * 开启，与 pi 路径 1 调用对齐，不做成开关）：
 *   reviewers         string[] review agent .md 路径（绝对或相对 workdir）；
 *                     缺省扫描 <workdir>/.agents/skills/pr-cr-fix/agents/review-*.md
 *   maxRounds         number   默认 10（上限 10）
 *   reviewTarget      string   base ref，默认 'main'；启动时锁 hash 防 ref 漂移
 *   maxConcurrent     number   review 阶段并发，默认 3（上限 5）
 *   timeoutMsPerPhase number   单阶段预算，默认 600000（大 diff 建议 1200000+）
 *
 * 产物：.review/review-<维度>.md（各维报告）+ .review/aggregated.md（每轮更新
 * 的聚合索引，含 `- Must-fix: N` 核对行）；fix commit 由 fix 阶段落盘。
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const DEFAULT_AGENTS_DIR = ['.agents', 'skills', 'pr-cr-fix', 'agents'];

function git(workdir, args) {
  return execFileSync('git', ['-C', workdir, ...args], { encoding: 'utf8' }).trim();
}

/** 并发限流执行，结果与输入同序（对齐内置版 runWithLimit 语义）。 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    },
  );
  await Promise.all(workers);
  return out;
}

/**
 * 从审查者最终回复提取计数。主路：最后一个含 must_fix 的 ```json 围栏；
 * 兜底：关键字正则（模型偶发漏围栏不让整轮作废）；再兜底：报告文件
 * frontmatter（agent 定义强制写 `must_fix: N`）。三路皆空 → null（parseFail）。
 */
function extractCounts(text, reportPath) {
  const fences = [...String(text || '').matchAll(/```json\s*([\s\S]*?)```/g)];
  for (let i = fences.length - 1; i >= 0; i--) {
    try {
      const o = JSON.parse(fences[i][1]);
      if (o && typeof o === 'object' && Number.isFinite(+o.must_fix)) {
        return { mustFix: +o.must_fix, suggestion: +o.suggestion || 0, info: +o.info || 0 };
      }
    } catch { /* 尝试下一个围栏 */ }
  }
  const num = (re) => {
    const m = String(text || '').match(re);
    return m ? +m[1] : NaN;
  };
  const mf = num(/"must_fix"\s*:\s*(\d+)/);
  if (Number.isFinite(mf)) {
    return {
      mustFix: mf,
      suggestion: num(/"suggestion"\s*:\s*(\d+)/) || 0,
      info: num(/"info"\s*:\s*(\d+)/) || 0,
    };
  }
  try {
    const md = fs.readFileSync(reportPath, 'utf8');
    const fm = md.match(/^---\n([\s\S]*?)\n---/);
    const pick = (k) => {
      const m = fm && fm[1].match(new RegExp(`^${k}:\\s*(\\d+)`, 'm'));
      return m ? +m[1] : NaN;
    };
    const m2 = pick('must_fix');
    if (Number.isFinite(m2)) {
      return { mustFix: m2, suggestion: pick('suggestion') || 0, info: pick('info') || 0 };
    }
  } catch { /* 报告文件不存在 → parseFail */ }
  return null;
}

function reviewPrompt(def, env) {
  return [
    '你是 pr-cr-fix skill 阶段 2 的 review agent（zcode 无头 session）。',
    '以下是你所属维度的完整 agent 定义，逐条遵循（其审查流程、输出格式、约束均有效）：',
    '',
    `----- agent 定义原文（${def.file}）-----`,
    def.content,
    '----- 原文结束 -----',
    '',
    '## 运行环境补充（只覆盖环境差异，不改变定义要求）',
    `- 工作目录：${env.workdir}（所有命令在此执行）`,
    `- 审查范围：\`git diff ${env.baseHash}...HEAD\`（base 已锁 hash 防 ref 漂移，含未提交工作区改动）。`,
    '  diff 较大时先 `--stat` 总览再按文件分批取 diff，禁止一次性输出全量 diff。',
    `- output 路径（报告写入处，绝对路径）：${def.reportPath}`,
    `- 阶段 2 前置产物 ${env.constraintsPath} 存在时必须消费（定义中的约定不变）。`,
    '- 本环境没有 structured-output 工具：定义要求的「structured-output 返回 JSON」改为——',
    '  最终回复末尾输出一个 json 围栏块，字段不变：',
    '  ```json',
    `  {"report_file": "${def.reportPath}", "must_fix": 0, "suggestion": 0, "info": 0}`,
    '  ```',
    env.task ? `\n## 任务背景\n${env.task}` : '',
  ].filter((x) => x !== '').join('\n');
}

function fixPrompt(round, mustDims, env, totalMust) {
  const lines = [
    `你是 pr-cr-fix review-fix 循环第 ${round} 轮的修复者（zcode 无头 session）。工作目录：${env.workdir}。`,
    '',
    `## 待消费审查报告（本轮 must_fix 合计 ${totalMust}）`,
    ...mustDims.map((d) => `- ${d.dim}（must_fix=${d.counts.mustFix}）：Read ${d.reportPath}${d.reportMissing ? '（报告文件缺失，明细见文末内嵌摘要）' : ''}`),
    '',
    '## 职责',
    '1. 逐份 Read 报告全文。对每条 MUST_FIX 先读代码验证真实性——不成立的在结果中标注',
    '   「已验证不成立 + 证据（file:line + 逻辑）」，不盲改（沿数据流核实，符号名 grep 不构成证据）。',
    '2. 成立的全部修复；SUGGESTION 顺手修（低成本项），INFO 忽略。测试类问题（缺测试/弱断言）',
    '   补真实测试：bug 类修复要求「修前红修后绿」的回归测试。',
    '3. 修复后按涉及区域跑 typecheck 确保通过（可多区域都跑）：extensions/ →',
    '   `pnpm extensions:typecheck`；packages/runtime → `cd packages/runtime && pnpm run typecheck`；',
    '   packages/renderer → `cd packages/renderer && pnpm run typecheck`。',
    `4. 全部完成后：\`git add -A && git commit -m "fix: review round ${round} — ${totalMust} must-fix"\``,
    '   （.review/ 已被 gitignore 不会误提交；禁止 push）。',
  ];
  for (const d of mustDims) {
    if (d.reportMissing && d.entry && d.entry.response) {
      lines.push('', `## ${d.dim} 报告文件缺失——审查者回复内嵌（第 ${round} 轮）`,
        String(d.entry.response).slice(0, 3000));
    }
  }
  lines.push('', '## 输出格式', '以「## 修复结果」开头，逐条：问题（file:line）→ 已修复（怎么修）/ 不成立（证据）。不超过 500 字。');
  return lines.join('\n');
}

module.exports = {
  name: 'pr-review-fix',
  description: 'pr-cr-fix 阶段 2：8 维 review agent .md 驱动的 review→fix→重审循环（reviewers=agent .md 路径，reviewTarget=base ref）',
  run: async (ctx) => {
    const workdir = ctx.cwd;
    const params = ctx.params || {};
    const log = ctx.log || (() => {});
    const signal = ctx.signal;

    const maxRounds = Math.max(1, Math.min(+params.maxRounds || 10, 10));
    const maxConcurrent = Math.max(1, Math.min(+params.maxConcurrent || 3, 5));
    const perPhaseMs = +params.timeoutMsPerPhase || 600000;
    const base = String(params.reviewTarget || 'main');

    // base 启动时锁 hash：长循环中 ref 漂移会让各轮 review 口径不一致（对齐 pi 语义）
    let baseHash;
    try {
      baseHash = git(workdir, ['rev-parse', '--verify', `${base}^{commit}`]);
    } catch (e) {
      throw new Error(`reviewTarget "${base}" 无法解析为 commit（${String((e && e.message) || e).slice(0, 120)}）。恢复指引：传入存在的 base ref（如 main）。`);
    }

    // reviewers 缺省 = 本仓 8 维全集（文件名排序，确定性）
    let reviewerFiles = Array.isArray(params.reviewers) && params.reviewers.length
      ? params.reviewers.map(String)
      : fs.readdirSync(path.join(workdir, ...DEFAULT_AGENTS_DIR))
        .filter((f) => /^review-.*\.md$/.test(f))
        .sort()
        .map((f) => path.join(workdir, ...DEFAULT_AGENTS_DIR, f));
    if (!reviewerFiles.length) {
      throw new Error('reviewers 为空且默认目录无 review-*.md。恢复指引：显式传 reviewers 数组（review agent .md 路径）。');
    }

    // agent .md 缺失/不可读直接抛 → run error（fail fast，不带着残缺维度进循环）
    const defs = reviewerFiles.map((file) => {
      const abs = path.isAbsolute(file) ? file : path.join(workdir, file);
      const content = fs.readFileSync(abs, 'utf8');
      const dim = path.basename(abs, '.md').replace(/^review-/, '');
      return { file: abs, content, dim, reportPath: path.join(workdir, '.review', `review-${dim}.md`) };
    });

    const reviewDir = path.join(workdir, '.review');
    fs.mkdirSync(reviewDir, { recursive: true });
    const aggregatedPath = path.join(reviewDir, 'aggregated.md');
    const env = {
      workdir,
      baseHash,
      constraintsPath: path.join(reviewDir, 'constraints.md'),
      task: ctx.task,
    };

    log(`base=${base}@${baseHash.slice(0, 10)} dims=[${defs.map((d) => d.dim).join(', ')}] maxRounds=${maxRounds} concurrent=${maxConcurrent}`);

    const roundSummaries = [];
    const cleanDims = new Set();
    let terminated = 'max-rounds';
    let lastAction = null;
    let prevMust = null;
    let stagnant = 0;
    let remaining = [];
    let lastFixResponse = null;

    const writeAggregated = (round, perDim) => {
      const totalMust = perDim.reduce((s, d) => s + (d.counts ? d.counts.mustFix : 0), 0);
      const totalSug = perDim.reduce((s, d) => s + (d.counts ? d.counts.suggestion : 0), 0);
      const rows = perDim.map((d) => `| ${d.dim} | ${d.runFail ? '执行失败' : d.parseFail ? '解析失败' : d.counts.mustFix === 0 ? 'clean' : 'fail'} | ${d.counts ? d.counts.mustFix : '-'} | ${d.counts ? d.counts.suggestion : '-'} | ${d.reportMissing ? '缺失' : 'ok'} | ${d.reportPath} |`);
      fs.writeFileSync(aggregatedPath, [
        `# PR review 聚合（zflow pr-review-fix，更新至第 ${round} 轮）`,
        '',
        '## Summary',
        `- Must-fix: ${totalMust}`,
        `- Suggestions: ${totalSug}`,
        '',
        '| 维度 | verdict | must_fix | suggestion | 报告 | 路径 |',
        '|------|---------|----------|------------|------|------|',
        ...rows,
        '',
        ...roundSummaries.map((s) => `- 第 ${s.round} 轮: ${s.detail} → must-fix ${s.totalMust}`),
        '',
      ].join('\n') + '\n');
      return totalMust;
    };

    for (let round = 1; round <= maxRounds; round++) {
      if (signal && signal.aborted) { terminated = 'aborted'; break; }

      const active = defs.filter((d) => !cleanDims.has(d.dim));
      if (!active.length) { terminated = 'clean'; break; }

      log(`round ${round}: review [${active.map((d) => d.dim).join(', ')}]`);
      const entries = await mapLimit(active, maxConcurrent, (d) =>
        ctx.runAgent({ prompt: reviewPrompt(d, env), cwd: workdir, timeoutMs: perPhaseMs }));
      if (signal && signal.aborted) { terminated = 'aborted'; break; }

      // 记账三态分开：执行失败 / 解析失败 / 正常——零成功 ≠ clean（对齐内置版）
      const perDim = active.map((d, i) => {
        const entry = entries[i];
        const base0 = { ...d, entry };
        if (!entry.ok) return { ...base0, runFail: true, counts: null };
        const reportMissing = !fs.existsSync(d.reportPath);
        const counts = extractCounts(entry.response, d.reportPath);
        if (!counts) return { ...base0, reportMissing, parseFail: true, counts: null };
        return { ...base0, reportMissing, counts };
      });
      for (const d of perDim) {
        if (d.counts && d.counts.mustFix === 0) cleanDims.add(d.dim);
      }

      const totalMust = writeAggregated(round, perDim);
      const detail = perDim.map((d) =>
        `${d.dim}: ${d.runFail ? '执行失败' : d.parseFail ? '解析失败' : d.counts.mustFix === 0 ? 'clean' : `${d.counts.mustFix} must-fix`}`).join('；');
      roundSummaries.push({ round, detail, totalMust });
      log(`round ${round}: ${detail} → must-fix ${totalMust}`);

      const fails = perDim.filter((d) => d.runFail || d.parseFail);
      if (totalMust === 0) {
        if (fails.length === perDim.length) {
          terminated = 'review-failed'; lastAction = 'review'; remaining = [];
        } else {
          terminated = 'clean'; lastAction = 'review'; remaining = [];
        }
        break;
      }

      if (prevMust !== null && totalMust >= prevMust) {
        stagnant++;
        if (stagnant >= 2) {
          terminated = 'stuck';
          remaining = perDim.filter((d) => d.counts && d.counts.mustFix > 0);
          break;
        }
      } else stagnant = 0;
      prevMust = totalMust;

      if (signal && signal.aborted) { terminated = 'aborted'; break; }

      const mustDims = perDim.filter((d) => d.counts && d.counts.mustFix > 0);
      log(`round ${round}: fix ${totalMust} must-fix across [${mustDims.map((d) => d.dim).join(', ')}]`);
      const fix = await ctx.runAgent({ prompt: fixPrompt(round, mustDims, env, totalMust), cwd: workdir, timeoutMs: perPhaseMs });
      if (signal && signal.aborted) { terminated = 'aborted'; break; }
      if (!fix.ok) { terminated = 'fix-failed'; remaining = mustDims; break; }
      lastFixResponse = fix.response;
      lastAction = 'fix';
      cleanDims.clear(); // 修复后全部重审（修复可能引入新问题）
    }

    if (terminated === 'max-rounds' && lastAction === 'fix') terminated = 'fixed-unverified';

    const statusWord = {
      clean: '审查通过',
      stuck: '修复停滞，人工接管',
      'fixed-unverified': '已修复，待复核',
      'max-rounds': '达到最大轮数',
      'review-failed': '审查阶段失败',
      'fix-failed': '修复阶段失败',
      aborted: '已中止',
    };
    const markdown = [
      `## ${statusWord[terminated] || terminated}`,
      '',
      `- terminated: **${terminated}**`,
      `- 轮次: ${roundSummaries.length} / ${maxRounds}`,
      `- base: ${base}@${baseHash.slice(0, 10)}`,
      `- 聚合报告: ${aggregatedPath}`,
      '',
      '### 轮次摘要',
      ...(roundSummaries.length
        ? roundSummaries.map((s) => `- 第 ${s.round} 轮: ${s.detail} → must-fix ${s.totalMust}`)
        : ['- (未产生轮次)']),
      ...(lastFixResponse
        ? ['', '### 最后一轮修复说明', '', String(lastFixResponse).slice(0, 2500)]
        : []),
      ...(remaining.length
        ? ['', '### 未解决（must_fix > 0 的维度）',
          ...remaining.map((d) => `- ${d.dim}: ${d.counts ? d.counts.mustFix : '?'} → ${d.reportPath}`)]
        : []),
      '',
      '处置指引（pr-cr-fix Gate-2 映射）：clean → 进阶段 3；fixed-unverified → 读 aggregated.md 与最后一轮修复说明',
      '人工确认后进阶段 3；stuck/max-rounds → 读 aggregated.md 判定误报（ack 后进 3）或真问题（派 worker 修复，',
      '残留上报用户）；review-failed/fix-failed → 调大 timeoutMsPerPhase 重跑一次，再败上报用户。',
    ].join('\n');

    return {
      markdown,
      json: {
        terminated,
        rounds: roundSummaries.length,
        aggregated_file: aggregatedPath,
        base,
        baseHash,
        dimensions: defs.map((d) => d.dim),
        mustFixRemaining: remaining.length,
      },
    };
  },
};
