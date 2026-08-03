// P0 coexistence spike：新壳最小占位脚本，仅证明构建产物加载（无任何业务功能）。
// globalThis.__NEW_ARCH__ 在构建期被 vite define 替换为字面 boolean（C2 契约），
// 骨架消费它作为「构建期 flag 烘焙」的物证：产物 JS 中出现 `(flag=true)` / `(flag=false)`。
const NEW_ARCH_BAKED = globalThis.__NEW_ARCH__
const shell = document.querySelector<HTMLDivElement>('#new-arch-shell')
if (shell) shell.textContent += ` (flag=${String(NEW_ARCH_BAKED)})`
console.log('[new-arch] skeleton loaded, newArch=', NEW_ARCH_BAKED)
