---
'@zhushanwen/pi-system-prompt': patch
---

Fix the data-directory fallback to match pi's current layout: `PI_CODING_AGENT_DIR` points at `<dataDir>/agent`, so the fallback walks up one level instead of two.

Previously, a run without `XYZ_AGENT_DATA_DIR` set resolved the data directory to the parent of the real one, so the AGENTS.md / CLAUDE.md candidate lookup (and any other path derived from it) pointed at the wrong directory.
