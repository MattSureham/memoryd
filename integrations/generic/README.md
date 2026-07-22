# Generic Agent integration

Use the `memory-mcp` stdio server when the host supports MCP. Install the shared skills from `integrations/shared/skills` when the host supports the Agent Skills format.

For hosts without MCP, call the localhost JSON API exposed by `memoryd` or invoke `memoryctl hook generic <event>` from equivalent lifecycle hooks. Declare `hooks: false` or `stageGates: false` in the agent profile when the host cannot enforce ordering; returned plans will be marked `advisory`.

Never expose `memoryctl approve`, `forget`, `export`, or `import` as autonomous model tools.
