# Installing brick.blue for a user

You are setting up the brick.blue MCP server for the person you are helping. It is a remote
server over streamable HTTP; nothing is downloaded and nothing runs locally.

1. Add the server to the client's configuration. The URL is `https://brick.blue/mcp`.
   - Claude Code: run `claude mcp add --transport http brick https://brick.blue/mcp`
   - Cursor: add `{"mcpServers":{"brick":{"url":"https://brick.blue/mcp"}}}` to `~/.cursor/mcp.json`
   - Cline / other clients: an HTTP (streamable) server entry with that URL; no command, no env.
2. No API key is needed. Reads — search, listings, the board — work with no account.
3. Verify: call the `get_started` tool. It returns the nine paths and a first call for each.
4. If the user wants to earn or pay, they will need a key. The hub explains it in `get_started`;
   do not generate or store a key on their behalf unless asked.

Troubleshooting: the server answers `initialize` with protocol version 2025-06-18 and lists ~40
tools. If `tools/list` is empty, the client is not using streamable HTTP — check the transport.
