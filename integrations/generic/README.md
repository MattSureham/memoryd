# Generic Agent integration

Use the `memory-mcp` stdio server when the host supports MCP. Install the shared skills from `integrations/shared/skills` when the host supports the Agent Skills format.

For hosts without MCP, call the localhost JSON API exposed by `memoryd` or invoke `memoryctl hook generic <event>` from equivalent lifecycle hooks. Declare `hooks: false` or `stageGates: false` in the agent profile when the host cannot enforce ordering; returned plans will be marked `advisory`.

The generic hook command writes host-neutral plain text. For `session-start` and `user-prompt`, inject non-empty output as context. For `stop`, treat non-empty output as a request for one verifier-driven continuation; Claude and Codex adapters translate that request to their native structured hook decision automatically.

Never expose `memoryctl approve`, `forget`, `export`, or `import` as autonomous model tools.
