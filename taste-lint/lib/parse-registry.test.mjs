/**
 * parse-registry 用例（data-source-governance W24：许可表来自登记表）。
 *
 * 覆盖三面：markdown 表格解析纯函数（§1 主表收 / §3§4 不误收）、真实登记表文件加载
 * （条目集含 #1 与 P1）、许可表条目失真检测（findStaleEntries 纯函数）。
 * 运行：node --test taste-lint/lib/*.test.mjs（node 24 目录形式不发现用例，须 glob）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRegistryEntries,
  loadRegistryEntries,
  findStaleEntries,
  REGISTRY_PATH,
} from './parse-registry.mjs';

const SAMPLE_MARKDOWN = [
  '# 登记表',
  '## 1. 主表',
  '| 编号 | GUI 数据 | 权威源 |',
  '|---|---|---|',
  '| #1 | session 标签 | pi |',
  '| #2 | session 列表 | pi |',
  '| P1 | plugin sessionData | runtime |',
  '## 3. 写点表（行首非 #N 形态，不得误收）',
  '| 写点 | 位置 |',
  '|---|---|',
  '| 1. 活跃 rename | session-lifecycle.ts |',
  '## 4. 例外表（行首非 #N 形态，不得误收）',
  '| 项 | 登记内容 |',
  '|---|---|',
  '| ① 非活跃 rename | persistSessionName |',
].join('\n');

test('parse: §1 主表行首 #N / PN 收入，§3 §4 其他行式不误收', () => {
  const entries = parseRegistryEntries(SAMPLE_MARKDOWN);
  assert.deepEqual([...entries].sort(), ['#1', '#2', 'P1']);
});

test('parse: 空表格 / 无主表内容 → 空集（loadRegistryEntries 会 fail loud）', () => {
  assert.equal(parseRegistryEntries('# 无表格文档\n正文').size, 0);
  assert.equal(parseRegistryEntries('').size, 0);
});

test('load: 真实登记表文件解析（条目集 ≥ 13 且含 #1/#12/P1）', () => {
  const entries = loadRegistryEntries();
  assert.ok(entries.size >= 13, `登记表条目数 ${entries.size} < 13`);
  for (const expected of ['#1', '#12', 'P1']) {
    assert.ok(entries.has(expected), `登记表缺条目 ${expected}`);
  }
});

test('load: REGISTRY_PATH 指向仓库内登记表真实路径', () => {
  assert.ok(
    REGISTRY_PATH.endsWith('docs/architecture/data-source-registry.md'),
    `路径异常：${REGISTRY_PATH}`,
  );
});

test('findStaleEntries: 许可表条目全部在登记表内 → 空（通过）', () => {
  const registry = new Set(['#1', '#2']);
  const permitted = [
    { suffix: 'a.ts', entries: ['#1'] },
    { suffix: 'b.ts', entries: ['#1', '#2'] },
  ];
  assert.deepEqual(findStaleEntries(permitted, registry), []);
});

test('findStaleEntries: 条目失效（登记表删条目/改号后）→ 检出失效引用', () => {
  const registry = new Set(['#1']);
  const permitted = [
    { suffix: 'a.ts', entries: ['#1'] },
    { suffix: 'b.ts', entries: ['#9'] },
  ];
  const stale = findStaleEntries(permitted, registry);
  assert.equal(stale.length, 1);
  assert.equal(stale[0].entry, '#9');
  assert.equal(stale[0].suffix, 'b.ts');
});
