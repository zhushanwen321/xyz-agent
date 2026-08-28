---
'@zhushanwen/pi-structured-output': minor
---

**structured-output: single-param workflow tool + bounded-failure loop gate**

- Workflow mode (`PI_WORKFLOW_SCHEMA` present) now exposes a single-param tool: the authoritative schema is the tool parameters themselves (object roots get `additionalProperties: false`; non-object roots wrapped as `{value}` and unwrapped on execute). The dual-param self-reported form is preserved byte-for-byte for daily mode
- Workflow branch execution is pass-through — the pi-ai param layer is the single validation authority; the redundant client-side ajv review was removed (it previously caused silent fix-loss)
- New bounded-failure loop gate: 3 consecutive same-signature tool failures (signature change or success resets the count) terminates the session with a dual-channel log (stderr + session JSONL custom entry `structured-output:gate` including recovery guidance), preventing infinite retry loops
- Failure surfacing, timer overflow, and opt-in edge-case fixes from adversarial audit rounds
