---
"@zhushanwen/pi-file-lock": patch
"@zhushanwen/pi-llm-shared": patch
"@zhushanwen/pi-quota-providers": patch
"@zhushanwen/pi-session-reader": patch
---

Cross-process write governance and cache correctness (integrity hardening)

- file-lock: shared cross-process lock module (withFileLockSync) used by runtime and extensions; field-scope merge on concurrent config writes
- llm-shared: config saves under file lock; unique tmp file names (pid + random suffix) eliminate concurrent same-name tmp collisions between processes
- quota-providers: disk cache prunes removed/disabled provider entries on providers.json mtime change instead of waiting for TTL expiry; value domains aligned to pi 0.84.1 via SSOT derivation
- session-reader: main session file resolved by sessionId (not getSessionFile), passed by value into initSession; entry-only orphan recovery after spawn-window deaths
