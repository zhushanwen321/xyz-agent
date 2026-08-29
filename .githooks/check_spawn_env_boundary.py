#!/usr/bin/env python3
"""
runtime 子进程 env 出站契约静态守卫（约束 C-proc-09）

扫描 packages/runtime/src 与 apps/electron/main 的 *.ts 中所有 child-process 进程创建
调用点（spawn / execFile / execFileSync / fork / pty.spawn / new Worker /
utilityProcess.fork），要求所在文件经过出站契约构建器（buildOutboundChildEnv /
composeChildEnvBase）组装子进程 env；未经构建器的文件按调用点逐一报错并给出修复指引，
豁免名单在本脚本 EXEMPT_CALLSITES 内逐条注明理由。

设计依据与背景：docs/design/env-propagation-boundary.md
（§3.5 D2/D3 deny 清单最小起步 · §3.6 R1-R5 红线 · §5 U7 · AC8 演练场景）
约束登记：docs/constraints.json C-proc-09；与入站白名单（C-proc-07）正交共存——
入站白名单管「外部环境哪些准许进来」，本契约管「自身变量哪些允许跟随 spawn 出去」。

判定模型（折中：文件级白名单 + 调用点邻近证据，避免逐调用点窗口匹配的易碎性）：
1. 文件内容出现 buildOutboundChildEnv / composeChildEnvBase（任一形态的 import 或
   调用）即整文件通过——构建器只在 child env 组装处使用，其存在即是该文件子进程
   env 组装收敛于 SSOT 的充分信号；
2. 否则启用 API 调用点检测：仅在文件确实 import 了对应符号时才激活对应模式
   （node:child_process 的 spawn/execFile/execFileSync/fork、node-pty 命名空间的
   .spawn()、node:worker_threads 的 new Worker()、electron 的 utilityProcess.fork），
   外加显式 port 注入形态 deps.spawn()/deps.execFile()——规避 `ctx.xxx.spawn(...)`
   这类业务方法调用的误报；
3. 命中调用点后查 EXEMPT_CALLSITES（file 后缀 + 行内稳定子串指纹）：命中则放行并计入
   豁免统计。用行内容子串而非行号做指纹，代码平移不会让豁免静默漂移到新位置；
   豁免失效时宁可重新报警人工复核，不允许静默放行。

退出码：0=通过；2=存在违规；1=脚本自身异常。
豁免/范围调整须同步 docs/design/env-propagation-boundary.md §3.6 R5 并过评审。
"""

import os
import re
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ---------------------------------------------------------------------------
# 扫描范围
# ---------------------------------------------------------------------------
SCAN_ROOTS = [
    "packages/runtime/src",
    "apps/electron/main",
]

# 目录名成分或文件名后缀排除（测试文件不代表生产进程拓扑）
EXCLUDED_DIR_PARTS = {"__tests__", "test"}
EXCLUDED_FILE_SUFFIXES = (".test.ts", ".spec.ts", ".d.ts")

# 文件级白名单符号：任一出现即整文件通过（含 import 与调用两种形态）
CONTRACT_BUILDERS = ("buildOutboundChildEnv", "composeChildEnvBase")

# ---------------------------------------------------------------------------
# API 调用点模式
# ---------------------------------------------------------------------------
# 阶段 A：import 侧提取「本文件启用的 API」。只有真 import 了对应符号才启用对应
# 调用点模式，从而天然排除注释提及与方法式误报（ctx.terminalService.spawn 等）。
IMPORT_CHILD_PROCESS_RE = re.compile(
    r"import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+[\"'](?:node:)?child_process[\"']",
    re.DOTALL,
)
CHILD_PROCESS_APIS = ("spawn", "execFile", "execFileSync", "fork")
IMPORT_NODE_PTY_RE = re.compile(
    r"import\s+(?:\*\s+as\s+(\w+)|(\w+))\s+from\s+[\"']node-pty[\"']"
)
IMPORT_WORKER_THREADS_RE = re.compile(
    r"import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+[\"'](?:node:)?worker_threads[\"']",
    re.DOTALL,
)
IMPORT_ELECTRON_RE = re.compile(
    r"import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+[\"']electron[\"']", re.DOTALL
)

# 阶段 B：调用点模式（在非注释行上逐行匹配）。
# 裸标识符调用：(?<![\w.$]) 排除属性访问（obj.spawn(）与非词前缀；
# deps.spawn/deps.execFile 是 runtime 手动 DI 的 port 注入惯例——此类文件自身不
# import child_process（如 shell-runner.ts），若仅在解析到 import 时才启用会成盲区，
# 故无条件兜底（业务代码几乎无 .deps.spawn 命名，误报率天然低）。
CALL_PATTERNS = {
    "spawn": re.compile(r"(?<![\w.$])spawn\s*\("),
    "execFile": re.compile(r"(?<![\w.$])execFile\s*\("),
    "execFileSync": re.compile(r"(?<![\w.$])execFileSync\s*\("),
    "fork": re.compile(r"(?<![\w.$])fork\s*\("),
}
DEPS_PATTERNS = [
    ("deps.spawn", re.compile(r"deps\.spawn\s*\(")),
    ("deps.execFile", re.compile(r"deps\.execFile\s*\(")),
]
PTY_SPAWN_TMPL = r"\b{ns}\.spawn\s*\("
WORKER_RE = re.compile(r"\bnew\s+Worker\s*\(")
UTILITY_FORK_RE = re.compile(r"\butilityProcess\.fork\s*\(")

# 注释行剥离：行首空白后以 // 、 * 、 /* 开头的行不参与调用点匹配
COMMENT_LINE_RE = re.compile(r"^\s*(?://|/\*|\*)")

# ---------------------------------------------------------------------------
# 豁免名单（file_suffix, line_snippet, reason）
# file_suffix 以路径后缀唯一定位文件；line_snippet 必须是违规行的真实子串。
# ---------------------------------------------------------------------------

EXEMPT_CALLSITES = [
    # --- packages/runtime/src ---
    (
        "infra/relay/relay-env.ts",
        "spawn(execPath",
        "relay 可用性探针：手工构造的最小 env（PATH 指向候选执行体目录）探测 pi "
        "可执行性，非父 env 继承型调用，不存在产品变量外泄面（设计文档 §3.6 R5 点名）",
    ),
    (
        "services/reap-orphan-pi.ts",
        "execFile(",
        "孤儿 pi 进程回收前的 ps 只读探测：数组参数不经 shell、显式 timeout，"
        "仅读系统进程表，不向下游传递任何数据（设计文档 §3.6 R5 点名）",
    ),
    (
        "services/plugin-service/plugin-host.ts",
        "new Worker(bootstrapPath",
        "node:worker_threads 的 Worker 是同进程线程而非 OS 子进程，不存在 env 出站边界；"
        "trusted 插件域真正跨进程出站统一收敛于 plugin-host-process.ts 的 fork 接线点"
        "（该文件经 buildOutboundChildEnv 组装）",
    ),
    # --- apps/electron/main ---
    (
        "supervisor/process-control.ts",
        "spawn(cmd",
        "B2 main->runtime 注入点本体：child env 由 supervisor/safe-env.ts "
        "buildSafeEnv（composeChildEnvBase 白名单基座）构建；B2 是产品内部边界，"
        "出站 deny 兜底由下游 runtime 出站接线承担（safe-env.ts 头注释「为何走 "
        "composeChildEnvBase 而非 buildOutboundChildEnv」：直调含 deny 的完整构建器会在"
        "打包态剥掉 runtime 自身合法消费的 XYZ_AGENT_PACKAGED，瘫痪 isPackaged() 六处判定）",
    ),
    (
        "supervisor/process-control.ts",
        "pgrep",
        "子孙 pid 探测 pgrep 只读（clearProcessTree 语义，无 env 传播意图）",
    ),
    (
        "gateway/sound-handlers.ts",
        "afplay",
        "macOS 音效播放 detached + stdio ignore，面向 OS 工具无数据回流通路",
    ),
    (
        "gateway/sound-handlers.ts",
        "spawn(cmd",
        "跨平台音效 open/xdg-open 打开媒体文件，同上无 env 传播意图",
    ),
    (
        "update/platform-updater.ts",
        "UPDATER_SCRIPT_PATH",
        "自更新拉起 bash 更新脚本（mac/linux 两条路径共用 snippet 匹配）detached + "
        "stdio ignore；main 进程域 env 在应用启动时已受入站白名单管辖",
    ),
    (
        "update/orchestrator.ts",
        "ref.installerPath",
        "更新包安装器执行 detached + stdio ignore，同 platform-updater 裁决",
    ),
    (
        "supervisor/port-discoverer.ts",
        "execFileSync(",
        "lsof/netstat 端口探测只读三处，同步等待直接返回输出，无 env 传播意图",
    ),
    (
        "supervisor/windows-process.ts",
        "taskkill.exe",
        "Windows 终止进程树的 kill 操作，数组参数不经 shell，无 env 传播意图",
    ),
]


def iter_ts_files():
    for root in SCAN_ROOTS:
        base = os.path.join(REPO_ROOT, root)
        if not os.path.isdir(base):
            print(f"[WARN] 扫描根不存在: {root}", file=sys.stderr)
            continue
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [d for d in dirnames if d not in EXCLUDED_DIR_PARTS]
            for name in filenames:
                if not name.endswith(".ts"):
                    continue
                if name.endswith(EXCLUDED_FILE_SUFFIXES):
                    continue
                yield os.path.join(dirpath, name)


def _extract_brace_names(group):
    """从 import {...} 花括号内容提取符号名（剥离内联 type 修饰）。不用
    lstrip("type ")——它是字符集语义会把 execFile 的首字母 e 当作可剥字符剥掉
    （实际踩过：execFile→xecFile 漏检）。"""
    names = set()
    for item in group.split(","):
        name = item.strip()
        if name.startswith("type "):
            name = name[len("type "):].strip()
        if name:
            names.add(name)
    return names


def active_call_patterns(source):
    """根据本文件的 import 提取启用的调用点检测器列表 [(label, compiled_re)]。
    只有真 import 了对应符号才激活对应模式，天然排除注释提及与方法式误报
    （ctx.terminalService.spawn 等）；deps.* 兕底模式无条件启用。"""
    patterns = []
    for m in IMPORT_CHILD_PROCESS_RE.finditer(source):
        names = _extract_brace_names(m.group(1))
        for api in CHILD_PROCESS_APIS:
            if api in names:
                patterns.append((api, CALL_PATTERNS[api]))
    patterns.extend(DEPS_PATTERNS)
    m = IMPORT_NODE_PTY_RE.search(source)
    if m:
        ns = m.group(1) or m.group(2) or "pty"
        patterns.append(("pty.spawn", re.compile(PTY_SPAWN_TMPL.format(ns=ns))))
    if any(
        "Worker" in n.strip()
        for m in IMPORT_WORKER_THREADS_RE.finditer(source)
        for n in m.group(1).split(",")
    ):
        patterns.append(("new Worker", WORKER_RE))
    if any(
        "utilityProcess" in n.strip()
        for m in IMPORT_ELECTRON_RE.finditer(source)
        for n in m.group(1).split(",")
    ):
        patterns.append(("utilityProcess.fork", UTILITY_FORK_RE))
    return patterns


def exempted(rel_path, line_text):
    for suffix, snippet, _reason in EXEMPT_CALLSITES:
        if rel_path.endswith(suffix) and snippet in line_text:
            return True
    return False


def reason_for(rel_path, line_text):
    for suffix, snippet, reason in EXEMPT_CALLSITES:
        if rel_path.endswith(suffix) and snippet in line_text:
            return reason
    return ""


FIX_HINT = """[fix] 子进程 env 须经出站契约构建器组装（deny 清单剥 XYZ_AGENT_PACKAGED / XYZ_RUNTIME_TOKEN）:
      runtime 包内:   import { buildOutboundChildEnv } from '<相对路径>/infra/spawn-env.js'
      跨包直连 SSOT:  import { buildOutboundChildEnv } from '@xyz-agent/shared'
      设计依据: docs/design/env-propagation-boundary.md (§3.5 D2/D3 · §3.6 R1-R5 · §5 U1/U7)
      豁免申请: .githooks/check_spawn_env_boundary.py EXEMPT_CALLSITES 注明理由后过评审"""


def main():
    violations = []       # (rel_path, lineno, api_label, line)
    scanned_with_calls = set()   # 发现调用点的文件
    passed_by_builder = set()    # 文件级白名单通过且确有调用点
    exempt_hits = []             # (rel_path, lineno)

    files = sorted(iter_ts_files())
    for path in files:
        rel_path = os.path.relpath(path, REPO_ROOT)
        try:
            with open(path, encoding="utf-8") as f:
                source = f.read()
        except OSError as e:
            print(f"[ERROR] 无法读取 {rel_path}: {e}", file=sys.stderr)
            return 1

        patterns = active_call_patterns(source)
        if not patterns:
            continue

        has_builder = any(b in source for b in CONTRACT_BUILDERS)
        call_lines = []
        for idx, line in enumerate(source.splitlines(), start=1):
            if COMMENT_LINE_RE.match(line):
                continue
            hits = [label for label, pat in patterns if pat.search(line)]
            if hits:
                call_lines.append((idx, hits[0], line))

        if not call_lines:
            continue

        scanned_with_calls.add(rel_path)
        if has_builder:
            # 模式 1：文件内已使用出站契约构建器 → 整文件通过（不做逐调用点窗口匹配，
            # 折中取舍见文件头「判定模型」）
            passed_by_builder.add(rel_path)
            continue

        for lineno, label, line in call_lines:
            if exempted(rel_path, line):
                exempt_hits.append((rel_path, lineno))
            else:
                violations.append((rel_path, lineno, label, line))

    # ---------------- 输出 ----------------
    stats = (
        f"[spawn-env-boundary] 扫描 ts 文件 {len(files)} | "
        f"含进程创建调用点 {len(scanned_with_calls)} 个文件 "
        f"(经构建器通过 {len(passed_by_builder)} / 调用点豁免 {len(exempt_hits)} 处) | "
        f"违规 {len(violations)}"
    )
    print(stats)

    if violations:
        print("")
        print("[FAIL] 以下进程创建调用点未经出站契约构建器组装 env:")
        by_file = {}
        for rel_path, lineno, label, line in violations:
            by_file.setdefault(rel_path, []).append((lineno, label, line))
        for rel_path in sorted(by_file):
            for lineno, label, line in by_file[rel_path]:
                print(f"  {rel_path}:{lineno} [{label}]")
                print(f"    > {line.strip()[:120]}")
        print("")
        print(FIX_HINT)
        return 2
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001 守卫自身崩溃不能静默放行
        print(f"[ERROR] 守卫脚本异常: {exc}", file=sys.stderr)
        sys.exit(1)
