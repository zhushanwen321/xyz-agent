/**
 * 路径纯函数（R2 logic 层）。
 *
 * 零 IO、纯字符串处理——便于单测。当前仅 dirNameOf，供 sidebar 组标题 / SessionItem /
 * Landing dirLabel 共用，避免三处各写一遍 `cwd.split('/').filter(Boolean).pop()`。
 *
 * 注意：lib/utils.ts 的 cwdBasename 是 private helper（仅 recentWorkspaces 内部用），
 * 因 utils.ts 属独立聚合（NewTaskFlow 派生），暂不强制收敛到此；此处只统一组件层重复。
 */

/**
 * 取目录显示名：cwd 末段（basename），长路径只显末段防溢出。
 *
 * - '/Users/foo/bar' → 'bar'
 * - '/' 或 '' → ''（filter(Boolean) 后无段，?? 兜底返回原 cwd 即 ''）
 * - 'foo'（相对路径无分隔符） → 'foo'
 *
 * 按分隔符 '/' 拆段并过滤空段（兼容尾斜杠 / 连续斜杠），取末段；无段时回退原串。
 */
export function dirNameOf(cwd: string): string {
  return cwd.split('/').filter(Boolean).pop() ?? cwd
}

/** 存在上级段所需的最小段数（含自身）：cwd 至少两段才有上级可取 */
const MIN_SEGS_FOR_PARENT = 2

/**
 * 取目录上级段名（用于同名目录消歧，如多个 chat_project → chat_project(Code)）。
 *
 * - '/Code/chat_project' → 'Code'
 * - '/chat_project' → ''（无上级段，单层路径无法消歧）
 * - '/a/b/c' → 'b'（取倒数第二段，只够与同类区分）
 *
 * 与 dirNameOf 同样按 '/' 拆段；段数 < 2 时返回空串，调用方据此决定是否追加。
 */
export function parentDirNameOf(cwd: string): string {
  const segs = cwd.split('/').filter(Boolean)
  if (segs.length < MIN_SEGS_FOR_PARENT) return ''
  // 上级段即倒数第二段，索引偏移与 MIN_SEGS_FOR_PARENT 同值
  return segs[segs.length - MIN_SEGS_FOR_PARENT]
}
