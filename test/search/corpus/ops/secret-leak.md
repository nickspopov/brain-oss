---
title: Runbook: secret leak
tags: [ops, security]
---
# Runbook: secret leak

If an API key or token was committed or pasted into a document:

1. Revoke the key at the provider immediately.
2. Purge the revision with admin_purge.
3. Issue a new key and store it only in the password manager.
