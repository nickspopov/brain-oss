# Hermes Agent

Transport: MCP streamable HTTP (recommended) or stdio via `brain-mcp`. Common steps — [README.md](README.md).
Check the config format against the installed Hermes version (the MCP section of its docs) during manual acceptance.

## HTTP

`~/.hermes/config.yaml`:

```yaml
mcp_servers:
  brain:
    url: "https://brain.example.com/mcp/v1"
    headers:
      Authorization: "Bearer ${BRAIN_TOKEN}"
```

`BRAIN_TOKEN=brn_…` goes in `~/.hermes/.env` (not in config.yaml itself). Restart Hermes.

## stdio

```yaml
mcp_servers:
  brain:
    command: "brain-mcp"
    env:
      BRAIN_URL: "https://brain.example.com"
      BRAIN_TOKEN: "${BRAIN_TOKEN}"
```

## Extra headers

If your network requires extra headers on every request to Brain, put them in `BRAIN_HEADERS` (a JSON object,
see [README.md](README.md#extra-headers)) for brain-mcp, or add them next to `Authorization` in the HTTP config.

## Check

1. On startup Hermes lists the tools of the `brain` server.
2. “Call start_here in brain” — the agent’s name, `trust`, spaces, rules and next steps.
3. The scenario from [acceptance.md](acceptance.md).
