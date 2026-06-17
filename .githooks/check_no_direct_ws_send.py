#!/usr/bin/env python3
"""
禁止 renderer 直调 ws-client 的 send —— 落实 D3 统一门面（phase-5 guardrails 5.3）。

背景：Phase 1 已把 send 直调收口到 api client。本脚本把「send 只许经 transport 封装层」
固化为 pre-commit 检查，防止 store/composable/组件回退到直调 ws-client.send。

白名单（合法 send/直调点）：
  - api/transport.ts             传输封装层（send 的唯一真实消费者）
  - api/singleton.ts             单例装配（当前只 re-export getState；防御性放行 send）
  - composables/useConnection.ts 传输层（connect/disconnect/getState；防御性放行 send）

检测目标：任意 .ts/.vue 中 `import { ... send ... } from '.../ws-client'`（含 `send as 别名`）。

退出码：0 通过 / 2 违规
"""

import re
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SCAN_ROOT = PROJECT_ROOT / "src-electron" / "renderer" / "src"

WHITELIST = {
    "api/transport.ts",
    "api/singleton.ts",
    "composables/useConnection.ts",
}

# 命名导入块 + from '.../ws-client'（type-only import 同样拦，防止 import type 规避）
WS_CLIENT_IMPORT = re.compile(
    r"import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['\"][^'\"]*ws-client['\"]"
)


def scan() -> list[str]:
    errors: list[str] = []
    for f in sorted(SCAN_ROOT.rglob("*")):
        if f.suffix not in (".ts", ".vue"):
            continue
        rel = f.relative_to(SCAN_ROOT).as_posix()
        text = f.read_text(encoding="utf-8")
        for ln_no, line in enumerate(text.splitlines(), 1):
            stripped = line.strip()
            # 跳过整行注释（行内注释不影响 import 主体匹配）
            if stripped.startswith("//"):
                continue
            m = WS_CLIENT_IMPORT.search(line)
            if not m:
                continue
            named = m.group(1)
            # 命名导入里出现裸 send（含 `send as foo`）；不误伤 resend / sendX 等
            if re.search(r"(^|,\s*|\s+)send(\s+as\s+|\s*,|\s*$)", named):
                if rel in WHITELIST:
                    continue
                errors.append(f"  {rel}:{ln_no}: {stripped}")
    return errors


def main() -> int:
    errors = scan()
    if errors:
        print("[ERROR] renderer 禁止直调 ws-client.send，统一走 api client（D3 统一门面）")
        print("        合法封装层（白名单）：" + ", ".join(sorted(WHITELIST)))
        print("\n".join(errors))
        print("\n[INFO] 设置 SKIP_WS_SEND_CHECK=1 跳过检查")
        return 2
    print("[OK] ws-client send 直调检查通过（仅白名单文件合法）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
