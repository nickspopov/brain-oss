# Claude Code

Transport: MCP streamable HTTP (recommended) or stdio via `brain-mcp`. Common steps — [README.md](README.md).

## HTTP

```sh
export BRAIN_TOKEN=brn_…            # issued by admin_token_issue
claude mcp add --transport http brain https://brain.example.com/mcp/v1 \
  --header "Authorization: Bearer $BRAIN_TOKEN"
```

`--scope user` — the server for all projects; by default — only for the current one. For a shared `.mcp.json` in a repository
do not write the token in; use environment variable substitution:

```json
{
  "mcpServers": {
    "brain": {
      "type": "http",
      "url": "https://brain.example.com/mcp/v1",
      "headers": { "Authorization": "Bearer ${BRAIN_TOKEN}" }
    }
  }
}
```

## stdio

```sh
claude mcp add brain --env BRAIN_URL=https://brain.example.com --env BRAIN_TOKEN=$BRAIN_TOKEN -- brain-mcp
```

## Extra headers

If your network requires extra headers on every request to Brain, put them in `BRAIN_HEADERS` (a JSON object,
see [README.md](README.md#extra-headers)) for brain-mcp, or add them next to `Authorization` in the HTTP config.

## Check

1. `claude mcp list` — `brain` is connected; `/mcp` inside a session shows the tools `start_here`, `read`, `write`, …
2. Ask: “call start_here in brain” — the agent’s name, `trust`, spaces with roles, rules and next steps.
3. The scenario from [acceptance.md](acceptance.md).

The model sees the tools as `mcp__brain__<operation>`. Document contents arrive in a `BEGIN CONTENT <nonce>` /
`END CONTENT <nonce>` envelope with the author and `trust`: this is data, not instructions.
