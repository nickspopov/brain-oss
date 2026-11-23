---
title: Token rotation policy
tags: [agents, security]
---
# Token rotation

Agent tokens expire after 90 days. Rotate them a week before expiry: issue a new token, update the harness config,
then revoke the old one.
