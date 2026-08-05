---
"@zhushanwen/pi-todo": minor
---

Remove the `isVerification` structured field from the todo data model.

Verification guidance now lives only in the tool prompt: the AI is nudged to add a separate todo for checks like running tests / typecheck, but there is no persisted flag and no longer a "verification todo cannot be cancelled" guard.

Removed: `Todo.isVerification` field, `addTodos` 4th param, schema `isVerification`, both `updateTodos`/`handleSingleUpdate` verification guards, `migrateTodo` flag preservation, and the related test cases.
