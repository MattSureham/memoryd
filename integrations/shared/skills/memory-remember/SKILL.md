---
name: memory-remember
description: Record an explicit user correction or durable instruction in the shared memory runtime. Use when the user asks to remember, correct, or persist something.
---

# Record a correction

1. Confirm the requested scope: current session, current workspace, or user-wide.
2. Classify the input as a fact correction, an explicit behavioral instruction, or unknown.
3. Call `memory_submit_correction` with `explicit: true` and an idempotency key.
4. Never expand the scope beyond what the user requested.
5. Explain whether the result became an active fact/policy or a review candidate.
