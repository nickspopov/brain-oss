# Security policy

Brain stores knowledge and credentials-adjacent data for people and agents, so we take security reports
seriously.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues, discussions or pull requests.**

Report them privately through GitHub's private vulnerability reporting: open the repository's **Security** tab
and click **Report a vulnerability**. Include as much as you can:

- the affected version or commit;
- the kind of issue (e.g. access-control bypass, information leak across spaces, injection, token handling);
- steps to reproduce, or a proof of concept;
- the impact as you understand it.

You should get an acknowledgement within a few days. We will keep you informed while we work on a fix and will
credit you in the release notes unless you prefer otherwise. Please give us reasonable time to release a fix
before any public disclosure.

## Scope

In scope: the server (`src/`), the web UI (`web/`), the stdio proxy `brain-mcp`, `scripts/inbox-poll.sh` and the
example deployment in `deploy/`.

Especially interesting: any way for a principal to learn about documents, spaces, names or messages it has no
grant for (including through search, the changes feed, suggestions, error messages or timing that is easy to
exploit), privilege escalation, token or session handling, and secret scanning bypasses that store a credential
in clear text.

## Supported versions

Brain is pre-1.0; only the latest release on the default branch receives security fixes.
