# Codex

Transport: MCP streamable HTTP (recommended) or stdio via `brain-mcp`. Common steps — [README.md](README.md).
Check the config keys against the installed Codex version (its MCP docs) during manual acceptance.

## HTTP

`~/.codex/config.toml`, with `BRAIN_TOKEN=brn_…` in the environment Codex starts from:

```toml
[mcp_servers.brain]
url = "https://brain.example.com/mcp/v1"
bearer_token_env_var = "BRAIN_TOKEN"
```

The Connect-agent bundle fills the token in instead (`http_headers = { "Authorization" = "Bearer brn_…" }`): keep that
file out of git.

## stdio

```toml
[mcp_servers.brain]
command = "brain-mcp"
env = { "BRAIN_URL" = "https://brain.example.com", "BRAIN_TOKEN" = "brn_…" }
```

## Extra headers

If your network requires extra headers on every request to Brain, add them to `http_headers` (HTTP) or put them in
`BRAIN_HEADERS` in `env` (stdio; see [README.md](README.md#extra-headers)).

## Check

1. `codex mcp list` shows `brain`; inside a session the tools `start_here`, `read`, `write`, … are listed.
2. Ask: “call start_here in brain” — the agent’s name, `trust`, spaces with roles, rules and next steps.
3. The scenario from [acceptance.md](acceptance.md).
