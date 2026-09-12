---
'@zhushanwen/pi-file-lock': minor
---

Drop the unused async locking face and converge on the synchronous API.

The async lock acquisition path had no remaining callers. It is removed along with its stale references, leaving the synchronous file-lock API as the single surface; the lock contract documentation comment was corrected to match the surviving behavior.
