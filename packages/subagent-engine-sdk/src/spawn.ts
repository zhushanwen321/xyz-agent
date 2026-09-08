// src/spawn.ts
//
// W12 领地占位（impl-plan §2 单元表 W12 行 + §2.12 / §2.2 R9-4②）：`spawnEngineChild`
// 落本文件——硬编码 POSIX/Windows `detached:false`（Windows 另加 `windowsHide:true`）、
// 不暴露 detached 选项、不把引擎自身 stdin fd 传给后代（stdio 数组对子进程 stdin 用
// 'ignore'/自有 pipe，宿主死后代持写端会令自灭主判据 stdio EOF 失效）。
//
// 本单元（W1）仅占位登记 tsup entry（§2.1 末行 entry 显式登记要求），不实现任何
// 逻辑——避免领地越界。W12 落地时同守卫核对 entry 登记。
export {};
