/**
 * 从主进程 argv 解析可镜像给子进程的 flag。
 *
 * 独立模块：argv 解析是独立职责，从 session-runner.ts 拆出避免该文件超行数上限。
 */

/**
 * 镜像 flag 集合：从主进程 argv 解析出的可透传给子进程的 flag。
 * 面向 buildSpawnArgs 的入参形态（解析后）。undefined 字段语义与解析为空一致。
 */
export interface MirrorFlags {
  noExtensions: boolean;
  approve: boolean;
  extensionPaths: string[];
  noContextFiles: boolean;
}

/**
 * 有值 flag 的解析规则表：成员是「后跟一个值」的 flag 名（含长短形式）。
 * 用于 mirrorMainProcessFlags 跳过其他 flag 的值时不误吃。
 */
const VALUED_FLAGS = new Set<string>([
  "--extension", "-e",
  "--skill",
  "--model", "--system-prompt", "--append-system-prompt",
  "--tools", "-t", "--exclude-tools", "-xt",
  "--fork", "--session-dir", "--mode",
  "--thinking", "--models",
]);

/** argv 中 flag 的起始索引：argv[0]=runtime, argv[1]=binary 路径。 */
const ARGV_FLAG_START = 2;

/**
 * 从主进程 argv 解析可镜像的 flag（--no-extensions/--approve/--extension/--no-context-files）。
 *
 * 数据源是主 pi 进程的 process.argv：子进程 spawn 的父就是主进程，
 * 主进程 argv 完整保留启动时收到的全部 flag（已运行时验证）。这让子进程
 * extension/approve 加载行为与主进程一致，且对任意 pi 宿主通用（不止 xyz-agent）。
 *
 * 解析规则：
 * - --no-extensions / -ne、--approve / -a：布尔 flag
 * - --no-context-files / -nc：布尔 flag（镜像理由：--extension 镜像会把
 *   xyz-system-prompt-extension.js 带进每个 subagent，该扩展靠子进程自己的
 *   argv 检测此 flag 决定是否注入全局 AGENTS.md——不镜像则用户 opt-out
 *   在 subagent 路径失效）
 * - --extension / -e：支持 `--extension <path>`（空格）与 `--extension=<path>`（等号）
 * - 其他 flag（在 VALUED_FLAGS 中）的值不被误当 extension 路径
 * - positional 参数被忽略
 * - argv[0]/argv[1] 是 bun/pi binary 路径，从 argv[2:] 开始扫
 */
// [perf] 进程内 process.argv 引用恒定（唯一调用点 session-runner 每次 spawn 传同一引用），
// 解析结果按 argv 引用相等 memo——每次 spawn 免重复扫描/正则。测试传新数组引用不命中。
let memoArgv: readonly string[] | undefined;
let memoResult: MirrorFlags | undefined;

export function mirrorMainProcessFlags(argv: readonly string[]): MirrorFlags {
  if (memoResult !== undefined && memoArgv === argv) return memoResult;
  let hasNoExtensions = false;
  let hasApprove = false;
  let hasNoContextFiles = false;
  const extensionPaths: string[] = [];

  // argv[0]=runtime(bun), argv[1]=pi binary 路径；flag 从 argv[2] 起
  const flagArgs = argv.length > ARGV_FLAG_START ? argv.slice(ARGV_FLAG_START) : [];

  for (let i = 0; i < flagArgs.length; i++) {
    const tok = flagArgs[i];
    if (tok === "--no-extensions" || tok === "-ne") {
      hasNoExtensions = true;
      continue;
    }
    if (tok === "--approve" || tok === "-a") {
      hasApprove = true;
      continue;
    }
    if (tok === "--no-context-files" || tok === "-nc") {
      hasNoContextFiles = true;
      continue;
    }
    // 等号形式 --extension=path / -e=path
    const eqMatch = /^(--extension|-e)=(.*)$/.exec(tok);
    if (eqMatch) {
      const val = eqMatch[2];
      if (val) extensionPaths.push(val);
      continue;
    }
    // 空格形式 --extension <path> / -e <path>：值在下一个 token
    if (tok === "--extension" || tok === "-e") {
      const next = flagArgs[i + 1];
      if (next !== undefined && !next.startsWith("-") && next.length > 0) {
        extensionPaths.push(next);
        i++; // 跳过值
      }
      continue;
    }
    // 其他有值 flag：跳过其值，避免误吃（如 --skill /a 的 /a）
    if (VALUED_FLAGS.has(tok)) {
      i++;
      continue;
    }
    // 其他情况（未知 flag、--flag=val 形式、positional）忽略
  }

  const result = { noExtensions: hasNoExtensions, approve: hasApprove, extensionPaths, noContextFiles: hasNoContextFiles };
  memoArgv = argv;
  memoResult = result;
  return result;
}
