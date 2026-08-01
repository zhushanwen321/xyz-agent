---
"@zhushanwen/pi-structured-output": patch
"@zhushanwen/pi-subagent-workflow": patch
"@zhushanwen/pi-ask-user": patch
---

Fix silent schema-bypass in workflow mode: structured-output now validates data against the authoritative schema from PI_WORKFLOW_SCHEMA env instead of the LLM-supplied schema parameter. Workflow-mode prompts updated to guide LLM to pass only data.

Workflow-mode structured-output prompt sync (subagent-workflow): the system-prompt instruction written by `resolveAgentOpts` for the `agent({schema})` override and the `formatSchemaInstruction` helper now instruct the LLM to pass ONLY the `data` parameter and do NOT pass a `schema` parameter, because the schema is enforced by the system.
