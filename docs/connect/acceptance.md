# Agent connection acceptance

The automated part is `test/acceptance/a10-agents.test.ts`: two agents (`alice-assistant`, `alice-helper`) go through
the scenario below with the MCP SDK client over streamable HTTP and through `brain-mcp` (stdio). To check a real agent by hand,
follow the guide from the UI (`admin_connect_guide`) and run the same scenario.

## Scenario “put → ready → take” (space `handoff`)

1. **A** (e.g. Claude): `start_here` — sees `handoff` with the `write` role.
2. **B** (e.g. Hermes): `changes` — remembers the `cursor`.
3. **A**: `write` `handoff/tasks/<topic>.md` with `expected_rev: 0`, `message`, `request_id`; `status: draft` in the frontmatter.
4. **A**: `edit` `status: draft` → `status: ready` with `expected_rev: 1`.
5. **B**: `changes({since: cursor})` — sees the document authored by A; `search` for a word from the text finds it.
6. **B**: `read` — an envelope with author A, `trust`, `trust_floor`, the body between `BEGIN CONTENT <nonce>` and `END CONTENT <nonce>`.
7. **B**: `edit` `status: ready` → `status: taken by <B>` with the `expected_rev` it read.
8. **A**: `changes` — sees B’s edit; `history` — three revisions authored by A, A, B.
