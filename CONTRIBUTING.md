# Contributing to Brain

Thanks for your interest! Bug reports, fixes and focused improvements are welcome. For larger changes (new
operations, schema changes, new permissions behaviour), please open an issue first so we can agree on the
approach before you write the code.

Security issues: please do **not** open a public issue — see [SECURITY.md](SECURITY.md).

## Development setup

Requirements: Node.js ≥ 22.12 (see `.nvmrc`), npm, and a C toolchain only if no prebuilt `better-sqlite3`
binary matches your platform. The browser smoke test needs Playwright's Chromium: install the web
dependencies first, so the pinned Playwright version is used (`npm run web:install`, then
`npx --prefix web playwright install chromium`).

```sh
npm ci                                       # server dependencies (the web UI installs on demand)
export BRAIN_DEV=1                           # required locally: allows the default http:// origin
npm run brain -- admin create --name alice   # create ./data and a superadmin
npm run dev                                  # server with reload on http://127.0.0.1:7460
npm run dev:web                              # in a second terminal: web UI with hot reload (Vite, port 5173)
```

Settings are `BRAIN_*` environment variables (no `.env` file is loaded in development); see
[deploy/.env.example](deploy/.env.example) for the full list with defaults.

Useful scripts:

| Script | What |
| --- | --- |
| `npm run ci` | everything CI runs: typecheck, lint, server tests, contract check, web typecheck/lint/tests/build and the browser smoke test |
| `npm test` | server tests (Vitest) |
| `npm run typecheck`, `npm run lint` | TypeScript and ESLint for the server |
| `npm run contract-check` | compares the MCP/REST contract with `test/contract/v1.snapshot.json` |
| `npm run test:perf` | memory and large-diff checks (slow, not part of `ci`) |
| `npm run screenshots` | regenerates UI screenshots from a demo seed into `artifacts/screenshots/` |
| `npm --prefix web run ci` | the web part of CI on its own |

## Code layout

```
src/
  adapters/   transports: http (REST, UI sessions, files, discovery), mcp (streamable HTTP), stdio (brain-mcp proxy)
  ops/        operations (agent and admin): input schemas, descriptions, one registry shared by MCP and REST
  core/       domain logic: access checks, documents and revisions, proposals, messages, search, export/import …
  store/      SQLite queries; only core/ may import store/
  db/         connection and migrations runner (SQL files in migrations/)
web/          React + Vite UI (its own package.json), unit tests in web/test, browser smoke in web/smoke
test/         server tests: unit, server (HTTP/MCP end to end), acceptance, contract, search quality, cli
deploy/       Dockerfile, compose example, backup and smoke scripts
```

Layer boundaries (adapters → ops → core → store → db) are enforced by ESLint rules in `eslint.config.js`.

## Tests policy

- `npm run ci` must pass before a change is merged.
- Every behaviour change comes with a test; every bug fix comes with a test that fails without the fix.
- Anything that touches access control must include a negative test: the caller without the grant gets the same
  answer as for something that does not exist, and nothing hidden leaks into search, changes, messages,
  suggestions or errors (see `test/acceptance/a01-isolation.test.ts` and the canary helpers in `test/helpers`).
- Changes to an operation's input or output update the contract snapshot deliberately
  (`npm run contract-check` shows the diff). Breaking changes to `/mcp/v1` and `/api/v1` need a strong reason.
- Database changes are new, forward-only migration files in `migrations/`; never edit a released migration.
- Product text (server messages, UI strings, docs) is English. Code comments are English.

## Pull requests

- Keep each pull request focused on one change, with a clear description of the why.
- Match the existing style (`.js` suffixes in relative imports, no new runtime dependencies without discussion); `npm run lint` must pass.
- By contributing you agree that your contribution is licensed under the project's license, AGPL-3.0-only.
