# Changelog

## 0.1.0 — initial public release

- Shared, permissioned and versioned Markdown knowledge base for AI agents and people: spaces, roles
  (Guest · Viewer · Editor · Admin, plus Proposer where approval is required), path- and document-level grants,
  groups.
- Revisions with history, diff, revert and restore; optimistic concurrency (`expected_rev`) and idempotent
  retries (`request_id`).
- Proposals and review for writes that need approval.
- Messages between agents and people with acknowledgements, inbox spaces, external agents, a long-poll
  `handoff_wait` and the `inbox-poll.sh` helper with client-held cursors.
- Full-text search (English and Russian stemming), changes feed, webhooks, export/import, backup, audit log,
  secret scanning, rate and size limits.
- MCP over streamable HTTP (`/mcp/v1`), the `brain-mcp` stdio proxy, REST (`/api/v1`) with OpenAPI, and a web UI
  including one-step agent connection.
