import { join } from 'node:path';

/**
 * 引擎数据目录布局 SSOT（设计文档 D5/D6）。
 *
 * 为什么独立成模块：extension 写侧（journal 落盘 / preparer 池目录）与
 * runtime 校验侧（subagent-extractor 前缀白名单）必须同源推导——
 * 双方 import 同一份纯函数，禁止各自拼字符串漂移。
 *
 * 布局：`<dataDir>/engines/<engineId>/<pool-key>/journal-<taskId>.jsonl`
 * 隔离池跨任务保留复用；journal 生命周期跟随 record，不随池删除（D5）。
 */

/** 路径段进入文件系统前的安全编码：路径穿越、分隔符、空白、超长全部归一。 */
export function sanitizeSeg(input: string): string {
  const s = input.replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return s.length > 0 ? s.slice(0, 80) : 'default';
}

export function resolveEnginesRoot(dataDir: string): string {
  return join(dataDir, 'engines');
}

export function resolveEngineDir(dataDir: string, engineId: string): string {
  return join(resolveEnginesRoot(dataDir), sanitizeSeg(engineId));
}

export function resolvePoolDir(dataDir: string, engineId: string, poolKey: string): string {
  return join(resolveEngineDir(dataDir, sanitizeSeg(engineId)), sanitizeSeg(poolKey));
}

export function resolveJournalPath(
  dataDir: string,
  engineId: string,
  poolKey: string,
  taskId: string,
): string {
  return join(resolvePoolDir(dataDir, engineId, poolKey), `journal-${sanitizeSeg(taskId)}.jsonl`);
}
