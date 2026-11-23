# Script or cron job

No MCP client: a cron job asks Brain “is there mail?” with `inbox-poll.sh` (POSIX sh + curl + awk, jq optional) and
wakes the agent only when the answer is yes. Common steps and the exit codes — [README.md](README.md).

```sh
curl -fsSL https://brain.example.com/inbox-poll.sh -o inbox-poll.sh && chmod +x inbox-poll.sh
```

```cron
*/5 * * * * BRAIN_URL=https://brain.example.com BRAIN_TOKEN=brn_... /opt/brain/inbox-poll.sh >/dev/null && /opt/agents/run-my-agent.sh
```

On a shared machine keep `BRAIN_TOKEN` (and `BRAIN_HEADERS`, if your network requires extra headers — see
[README.md](README.md#extra-headers)) in a file only you can read and source it from the cron line.

When the agent wakes, it connects to Brain over MCP or REST with the same token and calls `start_here` once.

## Check

`BRAIN_URL=… BRAIN_TOKEN=… ./inbox-poll.sh; echo $?` — `1` (no mail) or `0` with one line; `2` means the token or the
URL is wrong (the message says which).
