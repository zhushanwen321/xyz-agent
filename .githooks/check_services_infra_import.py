#!/usr/bin/env python3
"""
services 层 infra 直接 import 检查（C-comm-03）——落实 runtime 三层设计「services 层 IO 一律经 port」。

规则（规格 SSOT：docs/architecture/runtime-three-layer-design.md 第二部分「跨切面例外」）：
  扫描 packages/runtime/src/services/ 的 .ts 源码（排除 *.test.ts 与 __tests__/），
  value import（排除 import type）中 from 路径含 /infra/ 且目标模块不在白名单 → 违规。
  import type 豁免（与 check_no_service_cycle.py 同理：接口依赖不造成运行时耦合）。

白名单（受控例外）：
  文档登记四类：logger / pi-paths / git-status-parser / ignore-parser
  现状基线（2026-08-22 首次接入时登记）：session-file-utils / session-entry-mapper /
    pi-provider-store / session-attach-assert / message-converter / file-change-reconciler
  ——基线模块待专项收编（经 port 或明确豁免理由后更新本清单），新增 infra value import 直接拦。
  session-binding-fields（2026-08-26 登记）：绑定字段注册表 SSOT（sidecar-binding-sync 设计），
    纯声明数据 + 纯函数，自 session-file-utils 抽出（同族受控例外，随 R3 一并收编）。

退出码: 0 通过 / 2 违规
"""

import re
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SERVICES_ROOT = PROJECT_ROOT / "packages/runtime/src/services"

# 受控例外：文档登记四类 + 现状基线（见 docstring）
ALLOWED_MODULES = {
    # 文档登记（runtime-three-layer-design「跨切面例外」）
    "logger",
    "pi-paths",
    "git-status-parser",
    "ignore-parser",
    # 现状基线（2026-08-22，待专项治理收编或正式豁免）
    "session-file-utils",
    "session-entry-mapper",
    "pi-provider-store",
    "session-attach-assert",
    "message-converter",
    "file-change-reconciler",
    # sidecar-binding-sync 注册表 SSOT（2026-08-26）：纯声明+纯函数，同 session-file-utils 族随 R3 收编
    "session-binding-fields",
    # 外部会话扫描域（import-session 2026-09-02）：scanExternalSessions + 缓存 + 批常量，
    # 纯函数（fs/promises 全注入路径参数，无模块级服务状态副作用），自 session-file-utils 抽出
    # （Gate A lint max-lines 拆分），同族受控例外随 R3 收编
    "session-file-external-scan",
    # spawn-env 出站契约构建器（2026-08-27）：纯函数（env 全 DI 不触 process.env），
    # terminal-service / plugin-host-process 消费 buildOutboundChildEnv 组装子进程 env
    # （env-propagation-boundary 设计 C-proc-09），同族随 R3 收编
    "spawn-env",
}

# value import 行（import { X } from '...infra/...'；import type 豁免）
IMPORT_RE = re.compile(r"""^\s*import\s+\{[^}]*\}\s+from\s+['"]([^'"]*infra/[^'"]+)['"]""", re.MULTILINE)


def main() -> int:
    violations = []
    for f in sorted(SERVICES_ROOT.rglob("*.ts")):
        if f.name.endswith(".test.ts") or "__tests__" in f.parts:
            continue
        rel = f.relative_to(PROJECT_ROOT).as_posix()
        for m in IMPORT_RE.finditer(f.read_text(encoding="utf-8", errors="replace")):
            module = Path(m.group(1)).stem
            if module not in ALLOWED_MODULES:
                violations.append(f"{rel}: value import infra/{module}（services 层 IO 须经 port 接口）")

    if violations:
        print("[check_services_infra_import] services 层存在白名单外的 infra value import（三层设计「跨切面例外」）：")
        for v in violations:
            print(f"  - {v}")
        print("修复方向：在 services/ports 定义接口，infra 层实现后经构造注入；纯函数例外归 kernel 类并登记白名单。")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
