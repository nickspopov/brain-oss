# connectome (connectome-host)

[connectome-host](https://www.npmjs.com/package/@animalabs/connectome-host) is an agent host published on npm. It starts the MCP
servers listed in an agent's recipe as processes (stdio: `command`, `args`, `env`). Brain is connected the same way,
through the `brain-mcp` stdio proxy. Common steps — [README.md](README.md).

## MCP server entry

Install `brain-mcp` on the machine that runs the host ([README.md](README.md#installing-brain-mcp)) and find its
absolute path (`which brain-mcp`): use an absolute path in the recipe.

Add a `brain` entry to `mcpServers` in the agent's recipe:

```json
{
  "mcpServers": {
    "brain": {
      "command": "/usr/local/bin/brain-mcp",
      "env": {
        "BRAIN_URL": "https://brain.example.com",
        "BRAIN_TOKEN": "${BRAIN_TOKEN}"
      }
    }
  }
}
```

## Environment

| Variable | Value |
|---|---|
| `BRAIN_URL` | the Brain origin, e.g. `https://brain.example.com` |
| `BRAIN_TOKEN` | the agent's token (`brn_…`), issued once in the UI or with `admin_token_issue` |
| `BRAIN_HEADERS` | optional: a JSON object of extra headers your network requires ([README.md](README.md#extra-headers)) |

Keep the token out of the recipe: set `BRAIN_TOKEN=brn_…` in the host's environment (or its `.env`) and reference it
as `${BRAIN_TOKEN}`. A stdio server sees only the variables listed in its `env` (plus a small system list), so list
every `BRAIN_*` variable you need explicitly; `inheritEnv: true` is not needed and not recommended (it passes every
host secret to the process).

If `brain-mcp` is not on the PATH, run it through Node: `"command": "/usr/bin/node",
"args": ["<path to the Brain checkout>/dist/src/adapters/stdio/bin.js"]`.

The model sees the tools with the host's tool prefix, by default `mcpl--brain--<operation>` (change it with the
`toolPrefix` field).

## Check

1. The host log shows the `brain` server up; the process stderr shows `brain-mcp: connected to https://brain.example.com`.
2. The agent calls `start_here`: its name, `trust`, spaces, rules and next steps.
3. The scenario from [acceptance.md](acceptance.md).

There are no push events: the agent learns about new things by calling `changes` (with a saved cursor) or via a webhook.
