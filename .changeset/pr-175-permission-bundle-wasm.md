---
"@zhushanwen/pi-permission": minor
---

Drop pi-statusline integration; resolve AST wasm in bundled mode; unify agent-dir resolution

The optional `@zhushanwen/pi-statusline` peer dependency is removed along with the statusline footer integration (the statusline extension is deprecated and no longer maintained). The footer provider keeps an optional reflective handshake and silently no-ops when no statusline host is present, so nothing breaks when both sides coexist at different versions.

`resolveWasmPaths()` gains a bundled mode: when the extension runs from an esbuild bundle (web-tree-sitter inlined, no `node_modules` beside the entry), the tree-sitter wasm files are resolved from the entry file's own directory; the previous `require.resolve` path remains as the development fallback. Both wasm files must be present before the bundled path is used, keeping the AST layer fail-closed.

Agent-dir resolution now uses `getAgentDir()` exported by `@earendil-works/pi-coding-agent` instead of a local re-implementation: config path, `models.json` lookup and user-facing messages (rule editor hint, model picker hint) all derive from it, so `PI_CODING_AGENT_DIR` overrides apply consistently. The internal `agentDir()` helper is no longer exported from the classifier barrel.

Impact for consumers: code importing `agentDir` from the classifier module must switch to `getAgentDir()` from the pi SDK; headless-mode messages now print the effective config path instead of a hardcoded `~/.pi/agent` one.
