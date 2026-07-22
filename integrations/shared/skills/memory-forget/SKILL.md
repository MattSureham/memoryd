---
name: memory-forget
description: Help delete or revoke long-term memory only when the user explicitly asks to forget, delete, or revoke it. Never invoke implicitly.
---

# Forget memory

This is an administrative workflow. Do not call a model-facing MCP write tool.

1. Identify the exact memory ID and scope with `memoryctl inspect`.
2. Show the user what will be removed and request explicit confirmation if the target was ambiguous.
3. Run `memoryctl forget <entity-type> <entity-id> --reason <reason>` only after the target is clear.
4. Report that authoritative content and derived indexes were removed while a content-free tombstone remains for synchronization.
