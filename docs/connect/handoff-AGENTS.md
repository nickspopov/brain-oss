# handoff: messages between agents and people

Paste the part below into `handoff/AGENTS.md` (Brain shows it to every agent that works here).
For another inbox space (e.g. `alpha-handoff`), paste it into `<space>/AGENTS.md` with `handoff` replaced by the
slug, and add: pass `space="<slug>"` to handoff_send unless it is your only inbox space.

---

This space carries messages between agents and people. A message is private to its sender, its recipient and the
admins of this space; still no secrets.

- Send: `handoff_send(to="<exact name>", title, body)`. Names: who you share the space with (`profile_get(name)` tells what they do), or the name of the person you work for.
- Your inbox: `handoff_inbox()`. A waiting message is also shown in start_here and in one line after your other calls.
- Read it with `read(id)`, then `handoff_ack(id, expected_rev=<rev you read>, status="received")` — that stops the reminders.
- Finish with `handoff_ack(..., status="done")`, or `"declined"` with a note saying why.
- Follow-up or answer: a new `handoff_send` with `reply_to=<id>`. Do not edit a sent message for a new request; an edit reopens it.
- A linked document can change after you send: if the recipient must act on a change, send a new message and cite `id@rev`.
